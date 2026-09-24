import {
  EVENT_KINDS,
  isValidSignedPublicNostrEvent,
  parseProductEvent,
  type CommerceProductRecord,
  type ProductFamilyInventorySummary,
  type SignedPublicNostrEvent,
} from "@conduit/core"

export const LOW_STOCK_THRESHOLD = 5

const STOCK_DECISION_STORAGE_PREFIX =
  "conduit:merchant:order-stock-decisions:v1"
const STOCK_DELIVERY_STORAGE_PREFIX =
  "conduit:merchant:pending-stock-deliveries:v1"
const MAX_STORED_STOCK_DECISIONS = 500
const MAX_STORED_STOCK_DELIVERIES = 100

export type ProductStockDecisionKind = "applied" | "declined" | "unpublished"

export interface ProductStockDecision {
  kind: ProductStockDecisionKind
  decidedAt: number
  /** Latest unresolved order-relative state, preserved across listing refetches. */
  adjustment?: OrderStockAdjustment
  /** Exact locally applied revision that received no relay ACK. */
  localEventId?: string
}

interface StoredProductStockDecisions {
  version: 1
  decisions: Record<string, ProductStockDecision>
}

export interface PendingProductStockDelivery {
  orderId: string
  adjustment: OrderStockAdjustment
  signedEvent: SignedPublicNostrEvent
  savedAt: number
}

interface StoredProductStockDeliveries {
  version: 1
  deliveries: Record<string, PendingProductStockDelivery>
}

export interface OrderStockItem {
  productId: string
  quantity: number
}

export interface OrderStockAdjustment {
  key: string
  addressId: string
  sourceEventId: string
  title: string
  quantity: number
  currentStock: number
  nextStock: number
  shortfall: number
  /** Custom targets are final merchant assertions and do not carry a residual decrement. */
  targetMode?: "custom"
}

export type OrderStockTargetMode = "calculated" | "custom"

export interface ProductStockDisplay {
  label: string
  variant: "success" | "warning" | "error" | "neutral"
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function normalizeLookupId(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function getDecisionStorageKey(merchantPubkey: string): string | null {
  const normalized = merchantPubkey.trim()
  return normalized
    ? `${STOCK_DECISION_STORAGE_PREFIX}:${encodeURIComponent(normalized)}`
    : null
}

function getDeliveryStorageKey(merchantPubkey: string): string | null {
  const normalized = merchantPubkey.trim()
  return normalized
    ? `${STOCK_DELIVERY_STORAGE_PREFIX}:${encodeURIComponent(normalized)}`
    : null
}

/** All tabs must serialize stock checkpoint and decision map writes. */
export type MerchantStockLockRequest = <T>(
  name: string,
  task: () => Promise<T>
) => Promise<T>

export async function withMerchantStockLock<T>(
  merchantPubkey: string,
  task: () => T | Promise<T>,
  requestLock?: MerchantStockLockRequest | null
): Promise<T> {
  const normalizedMerchant = merchantPubkey.trim()
  if (!normalizedMerchant) {
    throw new Error("A merchant account is required for stock recovery")
  }
  const browserRequestLock: MerchantStockLockRequest | null =
    typeof navigator !== "undefined" && navigator.locks
      ? (name, lockedTask) =>
          navigator.locks.request(name, async (lock) => {
            if (!lock) throw new Error("Stock recovery lock was not acquired")
            return lockedTask()
          })
      : null
  const acquire = requestLock === undefined ? browserRequestLock : requestLock
  if (!acquire) {
    throw new Error(
      "This browser cannot coordinate stock updates across tabs. No product change was staged."
    )
  }
  return acquire(`conduit:merchant:order-stock:v1:${normalizedMerchant}`, () =>
    Promise.resolve().then(task)
  )
}

function getDecisionProductAddressId(decisionKey: string): string | null {
  const separatorIndex = decisionKey.indexOf(":")
  if (
    separatorIndex <= 0 ||
    separatorIndex === decisionKey.length - 1 ||
    decisionKey.indexOf(":", separatorIndex + 1) !== -1
  ) {
    return null
  }

  try {
    const orderId = decodeURIComponent(decisionKey.slice(0, separatorIndex))
    const productAddressId = decodeURIComponent(
      decisionKey.slice(separatorIndex + 1)
    )
    if (!orderId.trim() || !productAddressId.trim()) return null
    return getOrderStockDecisionKey(orderId, productAddressId) === decisionKey
      ? productAddressId
      : null
  } catch {
    return null
  }
}

function isDecisionBoundToProduct(
  decision: ProductStockDecision,
  decisionKey: string,
  productAddressId: string
): boolean {
  return (
    !decision.adjustment ||
    (decision.adjustment.key === decisionKey &&
      decision.adjustment.addressId === productAddressId)
  )
}

function parseStoredDecisions(raw: string | null): StoredProductStockDecisions {
  if (!raw) return { version: 1, decisions: {} }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, decisions: {} }
    }

    const candidate = parsed as {
      version?: unknown
      decisions?: unknown
    }
    if (
      candidate.version !== 1 ||
      !candidate.decisions ||
      typeof candidate.decisions !== "object"
    ) {
      return { version: 1, decisions: {} }
    }

    const decisions: Record<string, ProductStockDecision> = {}
    for (const [key, value] of Object.entries(candidate.decisions)) {
      if (!value || typeof value !== "object") continue
      const decision = value as {
        kind?: unknown
        decidedAt?: unknown
        adjustment?: unknown
        localEventId?: unknown
      }
      if (
        (decision.kind !== "applied" &&
          decision.kind !== "declined" &&
          decision.kind !== "unpublished") ||
        typeof decision.decidedAt !== "number" ||
        !Number.isFinite(decision.decidedAt)
      ) {
        continue
      }
      const adjustment =
        decision.adjustment === undefined
          ? undefined
          : parseOrderStockAdjustment(decision.adjustment)
      const productAddressId = getDecisionProductAddressId(key)
      if (
        decision.adjustment !== undefined &&
        (!adjustment ||
          adjustment.key !== key ||
          adjustment.addressId !== productAddressId)
      ) {
        continue
      }
      if (
        decision.kind === "unpublished" &&
        (!adjustment ||
          typeof decision.localEventId !== "string" ||
          !/^[0-9a-f]{64}$/.test(decision.localEventId))
      ) {
        continue
      }
      decisions[key] = {
        kind: decision.kind,
        decidedAt: decision.decidedAt,
        ...(adjustment ? { adjustment } : {}),
        ...(decision.kind === "unpublished"
          ? { localEventId: decision.localEventId as string }
          : {}),
      }
    }

    return { version: 1, decisions }
  } catch {
    return { version: 1, decisions: {} }
  }
}

function parseStoredDecisionsStrict(
  raw: string | null
): StoredProductStockDecisions {
  if (raw === null) return { version: 1, decisions: {} }
  let candidate: unknown
  try {
    candidate = JSON.parse(raw)
  } catch {
    throw new Error("Stored stock decisions are unreadable")
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (candidate as { version?: unknown }).version !== 1 ||
    !(candidate as { decisions?: unknown }).decisions ||
    typeof (candidate as { decisions?: unknown }).decisions !== "object" ||
    Array.isArray((candidate as { decisions?: unknown }).decisions)
  ) {
    throw new Error("Stored stock decisions are unreadable")
  }
  const stored = parseStoredDecisions(raw)
  if (
    Object.keys(stored.decisions).length !==
    Object.keys((candidate as StoredProductStockDecisions).decisions).length
  ) {
    throw new Error("Stored stock decisions contain invalid order evidence")
  }
  return stored
}

function parseOrderStockAdjustment(
  value: unknown
): OrderStockAdjustment | null {
  if (!value || typeof value !== "object") return null
  const {
    key,
    addressId,
    sourceEventId,
    title,
    quantity,
    currentStock,
    nextStock: storedNextStock,
    shortfall: storedShortfall,
    targetMode,
  } = value as Record<string, unknown>
  if (
    typeof key !== "string" ||
    typeof addressId !== "string" ||
    typeof sourceEventId !== "string" ||
    typeof title !== "string" ||
    typeof quantity !== "number" ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    typeof currentStock !== "number" ||
    !Number.isSafeInteger(currentStock) ||
    currentStock < 0 ||
    typeof storedNextStock !== "number" ||
    !Number.isSafeInteger(storedNextStock) ||
    storedNextStock < 0 ||
    typeof storedShortfall !== "number" ||
    !Number.isSafeInteger(storedShortfall) ||
    storedShortfall < 0 ||
    (targetMode !== undefined && targetMode !== "custom")
  ) {
    return null
  }

  const nextStock = Math.max(0, currentStock - quantity)
  const shortfall = Math.max(0, quantity - currentStock)
  if (
    (targetMode !== "custom" && storedNextStock !== nextStock) ||
    storedShortfall !== shortfall
  )
    return null

  return {
    key,
    addressId,
    sourceEventId,
    title,
    quantity,
    currentStock,
    nextStock: storedNextStock,
    shortfall,
    ...(targetMode === "custom" ? { targetMode } : {}),
  }
}

function getSignedProductAddressId(
  event: SignedPublicNostrEvent
): string | null {
  if (event.kind !== EVENT_KINDS.PRODUCT) return null
  const dTag = event.tags.find(
    (tag) => tag[0] === "d" && typeof tag[1] === "string" && tag[1].length > 0
  )?.[1]
  return dTag ? `${event.kind}:${event.pubkey}:${dTag}` : null
}

function parsePendingProductStockDelivery(
  value: unknown,
  merchantPubkey: string,
  storedDeliveryKey?: string
): PendingProductStockDelivery | null {
  if (!value || typeof value !== "object") return null
  const delivery = value as Partial<PendingProductStockDelivery>
  const adjustment = parseOrderStockAdjustment(delivery.adjustment)
  if (
    typeof delivery.orderId !== "string" ||
    !delivery.orderId.trim() ||
    !adjustment ||
    !delivery.signedEvent ||
    !isValidSignedPublicNostrEvent(delivery.signedEvent) ||
    delivery.signedEvent.pubkey !== merchantPubkey ||
    getSignedProductAddressId(delivery.signedEvent) !== adjustment.addressId ||
    typeof delivery.savedAt !== "number" ||
    !Number.isFinite(delivery.savedAt)
  ) {
    return null
  }

  const orderId = delivery.orderId.trim()
  const canonicalKey = getOrderStockDecisionKey(orderId, adjustment.addressId)
  if (
    adjustment.key !== canonicalKey ||
    (storedDeliveryKey !== undefined && storedDeliveryKey !== canonicalKey)
  ) {
    return null
  }

  try {
    const signedProduct = parseProductEvent(delivery.signedEvent)
    if (
      signedProduct.id !== adjustment.addressId ||
      signedProduct.stock !== adjustment.nextStock
    ) {
      return null
    }
  } catch {
    return null
  }

  return {
    orderId,
    adjustment,
    signedEvent: delivery.signedEvent,
    savedAt: delivery.savedAt,
  }
}

function parseStoredDeliveries(
  raw: string | null,
  merchantPubkey: string
): StoredProductStockDeliveries {
  if (!raw) return { version: 1, deliveries: {} }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, deliveries: {} }
    }
    const candidate = parsed as { version?: unknown; deliveries?: unknown }
    if (
      candidate.version !== 1 ||
      !candidate.deliveries ||
      typeof candidate.deliveries !== "object"
    ) {
      return { version: 1, deliveries: {} }
    }

    const deliveries: Record<string, PendingProductStockDelivery> = {}
    for (const [key, value] of Object.entries(candidate.deliveries)) {
      const delivery = parsePendingProductStockDelivery(
        value,
        merchantPubkey,
        key
      )
      if (delivery) deliveries[key] = delivery
    }
    return { version: 1, deliveries }
  } catch {
    return { version: 1, deliveries: {} }
  }
}

function parseStoredDeliveriesStrict(
  raw: string | null,
  merchantPubkey: string
): StoredProductStockDeliveries {
  if (raw === null) return { version: 1, deliveries: {} }
  let candidate: unknown
  try {
    candidate = JSON.parse(raw)
  } catch {
    throw new Error("Stored stock checkpoints are unreadable")
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (candidate as { version?: unknown }).version !== 1 ||
    !(candidate as { deliveries?: unknown }).deliveries ||
    typeof (candidate as { deliveries?: unknown }).deliveries !== "object" ||
    Array.isArray((candidate as { deliveries?: unknown }).deliveries)
  ) {
    throw new Error("Stored stock checkpoints are unreadable")
  }
  const stored = parseStoredDeliveries(raw, merchantPubkey)
  if (
    Object.keys(stored.deliveries).length !==
    Object.keys((candidate as StoredProductStockDeliveries).deliveries).length
  ) {
    throw new Error("Stored stock checkpoints contain invalid order evidence")
  }
  return stored
}

export function isPlainStockInput(value: string): boolean {
  return /^\d*$/.test(value)
}

export function getProductStockInputError(value: string): string | null {
  const normalized = value.trim()
  if (!normalized) return null
  if (!/^\d+$/.test(normalized)) {
    return "Stock must be a whole number or left blank."
  }

  const stock = Number(normalized)
  if (!Number.isSafeInteger(stock) || stock < 0) {
    return "Stock must be a non-negative safe integer."
  }
  return null
}

export function parseProductStockInput(value: string): number | undefined {
  const normalized = value.trim()
  if (!normalized) return undefined

  const error = getProductStockInputError(normalized)
  if (error) throw new Error(error)
  return Number(normalized)
}

export function getProductStockDisplay(
  stock: number | undefined
): ProductStockDisplay {
  if (typeof stock !== "number") {
    return { label: "Stock not tracked", variant: "neutral" }
  }
  if (stock === 0) return { label: "Sold out", variant: "error" }
  if (stock <= LOW_STOCK_THRESHOLD) {
    return { label: `${stock} left`, variant: "warning" }
  }
  return { label: `${stock} in stock`, variant: "success" }
}

export function getProductFamilyStockDisplay(
  summary: ProductFamilyInventorySummary
): ProductStockDisplay {
  if (summary.availability === "unavailable") {
    return { label: "No purchasable variants", variant: "error" }
  }
  if (summary.tracking === "untracked") {
    return { label: "Stock not tracked", variant: "neutral" }
  }
  if (summary.tracking === "partial") {
    return summary.availability === "sold_out"
      ? { label: "Sold out", variant: "error" }
      : { label: "Partially tracked", variant: "warning" }
  }
  return getProductStockDisplay(summary.totalStock)
}

export function getOrderStockDecisionKey(
  orderId: string,
  productAddressId: string
): string {
  return `${encodeURIComponent(orderId.trim())}:${encodeURIComponent(
    productAddressId.trim()
  )}`
}

export function applyOrderStockTarget(
  adjustment: OrderStockAdjustment,
  stock: number,
  targetMode: OrderStockTargetMode
): OrderStockAdjustment {
  if (!Number.isSafeInteger(stock) || stock < 0) {
    throw new Error("Stock must be a non-negative safe integer.")
  }

  if (targetMode === "calculated") {
    if (stock !== adjustment.nextStock) {
      throw new Error("Calculated stock must match the order adjustment.")
    }
    return adjustment
  }
  return {
    ...adjustment,
    nextStock: stock,
    targetMode: "custom",
  }
}

export function doesOrderStockDecisionCoverAdjustment(input: {
  adjustment: OrderStockAdjustment
  persistedDecision: ProductStockDecision | null
}): boolean {
  const persistedAdjustment = input.persistedDecision?.adjustment
  if (!input.persistedDecision) return false
  if (!persistedAdjustment) return true
  if (
    persistedAdjustment.key !== input.adjustment.key ||
    persistedAdjustment.addressId !== input.adjustment.addressId
  ) {
    return false
  }
  if (input.persistedDecision.kind !== "applied") return true
  return getOrderStockDecisionFollowUpAdjustment(input) === null
}

/** Re-sign only the exact locally applied stock revision, never the order decrement. */
export function getUnpublishedOrderStockRepublishAdjustment(input: {
  adjustment: OrderStockAdjustment
  persistedDecision: ProductStockDecision | null
  record: CommerceProductRecord
}): OrderStockAdjustment {
  const decision = input.persistedDecision
  const applied = decision?.adjustment
  if (
    decision?.kind !== "unpublished" ||
    !applied ||
    applied.key !== input.adjustment.key ||
    applied.addressId !== input.adjustment.addressId ||
    input.record.addressId !== applied.addressId ||
    input.record.product.id !== applied.addressId ||
    input.record.eventId !== decision.localEventId ||
    input.record.product.stock !== applied.nextStock
  ) {
    throw new Error(
      "The rejected local stock revision is no longer current. Review the listing before publishing again."
    )
  }
  return applied
}

export function getOrderStockDecisionFollowUpAdjustment(input: {
  adjustment: OrderStockAdjustment
  persistedDecision: ProductStockDecision | null
}): OrderStockAdjustment | null {
  const persistedAdjustment = input.persistedDecision?.adjustment
  if (
    input.persistedDecision?.kind !== "applied" ||
    !persistedAdjustment ||
    persistedAdjustment.key !== input.adjustment.key ||
    persistedAdjustment.addressId !== input.adjustment.addressId ||
    persistedAdjustment.targetMode === "custom" ||
    persistedAdjustment.shortfall <= 0 ||
    input.adjustment.sourceEventId === persistedAdjustment.sourceEventId ||
    input.adjustment.currentStock <= persistedAdjustment.nextStock
  ) {
    return null
  }

  const quantity = persistedAdjustment.shortfall
  const currentStock = input.adjustment.currentStock
  const nextStock = Math.max(0, currentStock - quantity)
  const shortfall = Math.max(0, quantity - currentStock)
  return {
    ...input.adjustment,
    quantity,
    currentStock,
    nextStock,
    shortfall,
  }
}

export function isOrderStockAdjustmentMutationDisabled(input: {
  adjustment: OrderStockAdjustment
  persistedDecision: ProductStockDecision | null
  hasPendingDelivery: boolean
  hasSessionDecision: boolean
}): boolean {
  return (
    input.hasPendingDelivery ||
    input.hasSessionDecision ||
    doesOrderStockDecisionCoverAdjustment(input)
  )
}

export function shouldShowOrderStockAdjustment(input: {
  adjustment: OrderStockAdjustment
  orderStatus: string | null | undefined
  hasSessionDecision: boolean
  persistedDecision: ProductStockDecision | null
}): boolean {
  if (input.persistedDecision?.kind === "unpublished") return true
  if (
    input.orderStatus === "cancelled" ||
    input.orderStatus === "complete" ||
    input.orderStatus === "delivered" ||
    input.orderStatus === "refund_requested"
  ) {
    return false
  }
  if (
    input.persistedDecision &&
    doesOrderStockDecisionCoverAdjustment({
      adjustment: input.adjustment,
      persistedDecision: input.persistedDecision,
    })
  ) {
    return (
      input.persistedDecision.kind === "applied" &&
      input.persistedDecision.adjustment?.targetMode !== "custom" &&
      (input.persistedDecision.adjustment?.shortfall ?? 0) > 0
    )
  }
  return !input.hasSessionDecision
}

export function getOrderStockAdjustmentForDisplay(input: {
  adjustment: OrderStockAdjustment
  persistedDecision: ProductStockDecision | null
}): OrderStockAdjustment {
  const followUpAdjustment = getOrderStockDecisionFollowUpAdjustment(input)
  if (followUpAdjustment) return followUpAdjustment
  const persistedAdjustment = input.persistedDecision?.adjustment
  if (input.persistedDecision?.kind === "unpublished" && persistedAdjustment) {
    return persistedAdjustment
  }
  if (
    input.persistedDecision?.kind === "applied" &&
    persistedAdjustment &&
    persistedAdjustment.targetMode !== "custom" &&
    persistedAdjustment.shortfall > 0 &&
    doesOrderStockDecisionCoverAdjustment(input)
  ) {
    return persistedAdjustment
  }
  return input.adjustment
}

export function buildOrderStockAdjustments(input: {
  orderId: string
  merchantPubkey: string
  items: OrderStockItem[]
  productRecords: CommerceProductRecord[]
}): OrderStockAdjustment[] {
  const merchantPubkey = input.merchantPubkey.trim()
  if (!merchantPubkey || !input.orderId.trim()) return []

  const recordsByLookupId = new Map<string, CommerceProductRecord>()
  for (const record of input.productRecords) {
    if (record.product.pubkey !== merchantPubkey) continue
    if (
      record.product.type !== "simple" &&
      record.product.type !== "variation"
    ) {
      continue
    }
    if (!record.dTag) continue
    if (
      typeof record.product.stock !== "number" ||
      !Number.isSafeInteger(record.product.stock) ||
      record.product.stock < 0
    ) {
      continue
    }

    for (const id of [record.addressId, record.product.id, record.eventId]) {
      recordsByLookupId.set(normalizeLookupId(id), record)
    }
  }

  const quantitiesByAddress = new Map<
    string,
    { record: CommerceProductRecord; quantity: number }
  >()
  const unsafeQuantityAddresses = new Set<string>()
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) continue
    const record = recordsByLookupId.get(normalizeLookupId(item.productId))
    if (!record) continue
    if (unsafeQuantityAddresses.has(record.addressId)) continue

    const current = quantitiesByAddress.get(record.addressId)
    const quantity = (current?.quantity ?? 0) + item.quantity
    if (!Number.isSafeInteger(quantity)) {
      quantitiesByAddress.delete(record.addressId)
      unsafeQuantityAddresses.add(record.addressId)
      continue
    }
    quantitiesByAddress.set(record.addressId, {
      record,
      quantity,
    })
  }

  const adjustments: OrderStockAdjustment[] = []
  for (const { record, quantity } of quantitiesByAddress.values()) {
    const currentStock = record.product.stock!
    const nextStock = Math.max(0, currentStock - quantity)
    const shortfall = Math.max(0, quantity - currentStock)

    adjustments.push({
      key: getOrderStockDecisionKey(input.orderId, record.addressId),
      addressId: record.addressId,
      sourceEventId: record.eventId,
      title: record.product.title,
      quantity,
      currentStock,
      nextStock,
      shortfall,
    })
  }

  return adjustments.sort((left, right) =>
    left.title.localeCompare(right.title)
  )
}

export class ProductStockDecisionStore {
  private readonly memoryDecisions = new Map<string, ProductStockDecision>()

  constructor(private readonly storage: Storage | null = getBrowserStorage()) {}

  get(
    merchantPubkey: string,
    orderId: string,
    productAddressId: string
  ): ProductStockDecision | null {
    const normalizedProductAddressId = productAddressId.trim()
    const decisionKey = getOrderStockDecisionKey(
      orderId,
      normalizedProductAddressId
    )
    const memoryKey = `${merchantPubkey}:${decisionKey}`
    const storageKey = getDecisionStorageKey(merchantPubkey)
    if (storageKey && this.storage) {
      try {
        const decision = this.getPersisted(
          merchantPubkey,
          orderId,
          normalizedProductAddressId
        )
        if (decision) this.memoryDecisions.set(memoryKey, decision)
        else this.memoryDecisions.delete(memoryKey)
        return decision
      } catch {
        // Keep the current-session fallback when browser storage is down.
      }
    }
    const memoryDecision = this.memoryDecisions.get(memoryKey)
    return memoryDecision &&
      isDecisionBoundToProduct(
        memoryDecision,
        decisionKey,
        normalizedProductAddressId
      )
      ? memoryDecision
      : null
  }

  /** Read current cross-tab authority; never substitute cached session state. */
  getPersisted(
    merchantPubkey: string,
    orderId: string,
    productAddressId: string
  ): ProductStockDecision | null {
    const normalizedProductAddressId = productAddressId.trim()
    const decisionKey = getOrderStockDecisionKey(
      orderId,
      normalizedProductAddressId
    )
    const storageKey = getDecisionStorageKey(merchantPubkey)
    if (!storageKey || !this.storage) {
      throw new Error("Browser storage is unavailable for stock decisions")
    }
    const decision =
      parseStoredDecisionsStrict(this.storage.getItem(storageKey)).decisions[
        decisionKey
      ] ?? null
    if (
      decision &&
      !isDecisionBoundToProduct(
        decision,
        decisionKey,
        normalizedProductAddressId
      )
    ) {
      throw new Error("Stored stock decision belongs to another product")
    }
    return decision
  }

  /** Read every durable order decision for same-product revision fencing. */
  getPersistedForMerchant(merchantPubkey: string): ProductStockDecision[] {
    const storageKey = getDecisionStorageKey(merchantPubkey)
    if (!storageKey || !this.storage) {
      throw new Error("Browser storage is unavailable for stock decisions")
    }
    return Object.values(
      parseStoredDecisionsStrict(this.storage.getItem(storageKey)).decisions
    )
  }

  set(
    merchantPubkey: string,
    orderId: string,
    productAddressId: string,
    kind: ProductStockDecisionKind,
    adjustment?: OrderStockAdjustment,
    localEventId?: string,
    options: { requireDurable?: boolean } = {}
  ): boolean {
    const normalizedProductAddressId = productAddressId.trim()
    const decisionKey = getOrderStockDecisionKey(
      orderId,
      normalizedProductAddressId
    )
    if (
      adjustment &&
      (adjustment.key !== decisionKey ||
        adjustment.addressId !== normalizedProductAddressId)
    ) {
      throw new Error(
        "Stock decision adjustment does not match the order product"
      )
    }
    if (
      kind === "unpublished" &&
      (!adjustment || !localEventId || !/^[0-9a-f]{64}$/.test(localEventId))
    ) {
      throw new Error(
        "An unpublished stock decision requires its exact local revision"
      )
    }
    const decision: ProductStockDecision = {
      kind,
      decidedAt: Date.now(),
      ...(adjustment ? { adjustment: { ...adjustment } } : {}),
      ...(kind === "unpublished" ? { localEventId } : {}),
    }
    const memoryKey = `${merchantPubkey}:${decisionKey}`
    if (!options.requireDurable) {
      this.memoryDecisions.set(memoryKey, decision)
    }

    const storageKey = getDecisionStorageKey(merchantPubkey)
    if (!storageKey || !this.storage) return false
    try {
      const stored = options.requireDurable
        ? parseStoredDecisionsStrict(this.storage.getItem(storageKey))
        : parseStoredDecisions(this.storage.getItem(storageKey))
      if (
        options.requireDurable &&
        !stored.decisions[decisionKey] &&
        Object.keys(stored.decisions).length >= MAX_STORED_STOCK_DECISIONS
      ) {
        // The matching pending delivery must remain available after reload.
        // Do not evict another order's decision to complete this one.
        return false
      }
      stored.decisions[decisionKey] = decision
      const entries = Object.entries(stored.decisions).sort(
        ([leftKey, left], [rightKey, right]) =>
          right.decidedAt - left.decidedAt ||
          (leftKey === decisionKey ? -1 : rightKey === decisionKey ? 1 : 0)
      )
      stored.decisions = Object.fromEntries(
        entries.slice(0, MAX_STORED_STOCK_DECISIONS)
      )
      this.storage.setItem(storageKey, JSON.stringify(stored))
      if (options.requireDurable) {
        const persisted = parseStoredDecisionsStrict(
          this.storage.getItem(storageKey)
        ).decisions[decisionKey]
        if (
          !persisted ||
          JSON.stringify(persisted) !== JSON.stringify(decision)
        ) {
          return false
        }
        this.memoryDecisions.set(memoryKey, decision)
      }
      return true
    } catch {
      return false
    }
  }
}

export class PendingProductStockDeliveryStore {
  private readonly memoryDeliveries = new Map<
    string,
    PendingProductStockDelivery
  >()

  constructor(private readonly storage: Storage | null = getBrowserStorage()) {}

  getForOrder(
    merchantPubkey: string,
    orderId: string
  ): PendingProductStockDelivery[] {
    const normalizedMerchant = merchantPubkey.trim()
    const normalizedOrder = orderId.trim()
    if (!normalizedMerchant || !normalizedOrder) return []

    const storageKey = getDeliveryStorageKey(normalizedMerchant)
    if (storageKey && this.storage) {
      try {
        const stored = parseStoredDeliveries(
          this.storage.getItem(storageKey),
          normalizedMerchant
        )
        // A successful storage read supersedes another tab's deleted entries.
        for (const key of this.memoryDeliveries.keys()) {
          if (key.startsWith(`${normalizedMerchant}:`)) {
            this.memoryDeliveries.delete(key)
          }
        }
        for (const [key, delivery] of Object.entries(stored.deliveries)) {
          this.memoryDeliveries.set(`${normalizedMerchant}:${key}`, delivery)
        }
      } catch {
        // Keep any in-memory retry state when browser storage is unavailable.
      }
    }

    const deliveries: PendingProductStockDelivery[] = []
    for (const [key, delivery] of this.memoryDeliveries.entries()) {
      if (
        key.startsWith(`${normalizedMerchant}:`) &&
        delivery.orderId === normalizedOrder
      ) {
        deliveries.push(delivery)
      }
    }
    return deliveries.sort((left, right) => right.savedAt - left.savedAt)
  }

  /** Read current cross-tab authority, including other orders for a product. */
  getPersistedForMerchant(
    merchantPubkey: string
  ): PendingProductStockDelivery[] {
    const normalizedMerchant = merchantPubkey.trim()
    const storageKey = getDeliveryStorageKey(normalizedMerchant)
    if (!storageKey || !this.storage) {
      throw new Error("Browser storage is unavailable for stock recovery")
    }
    return Object.values(
      parseStoredDeliveriesStrict(
        this.storage.getItem(storageKey),
        normalizedMerchant
      ).deliveries
    )
  }

  set(
    merchantPubkey: string,
    delivery: Omit<PendingProductStockDelivery, "savedAt">,
    options: { requireDurable?: boolean } = {}
  ): boolean {
    const normalizedMerchant = merchantPubkey.trim()
    const pending: PendingProductStockDelivery = {
      ...delivery,
      orderId: delivery.orderId.trim(),
      savedAt: Date.now(),
    }
    const normalizedPending = parsePendingProductStockDelivery(
      pending,
      normalizedMerchant
    )
    if (!normalizedPending) {
      throw new Error("Expected a valid signed product stock delivery")
    }

    const deliveryKey = getOrderStockDecisionKey(
      normalizedPending.orderId,
      normalizedPending.adjustment.addressId
    )
    if (!options.requireDurable) {
      this.memoryDeliveries.set(
        `${normalizedMerchant}:${deliveryKey}`,
        normalizedPending
      )
    }

    const storageKey = getDeliveryStorageKey(normalizedMerchant)
    if (!storageKey || !this.storage) return false
    try {
      const stored = options.requireDurable
        ? parseStoredDeliveriesStrict(
            this.storage.getItem(storageKey),
            normalizedMerchant
          )
        : parseStoredDeliveries(
            this.storage.getItem(storageKey),
            normalizedMerchant
          )
      if (
        options.requireDurable &&
        !stored.deliveries[deliveryKey] &&
        Object.keys(stored.deliveries).length >= MAX_STORED_STOCK_DELIVERIES
      ) {
        // Do not discard another order's only pending checkpoint to start
        // a new stock write. The caller must fail before staging its listing.
        return false
      }
      stored.deliveries[deliveryKey] = normalizedPending
      const entries = Object.entries(stored.deliveries).sort(
        ([leftKey, left], [rightKey, right]) =>
          right.savedAt - left.savedAt ||
          (leftKey === deliveryKey ? -1 : rightKey === deliveryKey ? 1 : 0)
      )
      stored.deliveries = Object.fromEntries(
        entries.slice(0, MAX_STORED_STOCK_DELIVERIES)
      )
      this.storage.setItem(storageKey, JSON.stringify(stored))
      if (options.requireDurable) {
        const persisted = parseStoredDeliveriesStrict(
          this.storage.getItem(storageKey),
          normalizedMerchant
        ).deliveries[deliveryKey]
        if (
          !persisted ||
          JSON.stringify(persisted) !== JSON.stringify(normalizedPending)
        ) {
          return false
        }
        this.memoryDeliveries.set(
          `${normalizedMerchant}:${deliveryKey}`,
          normalizedPending
        )
      }
      return true
    } catch {
      return false
    }
  }

  delete(
    merchantPubkey: string,
    orderId: string,
    productAddressId: string,
    options: { requireDurable?: boolean } = {}
  ): boolean {
    const normalizedMerchant = merchantPubkey.trim()
    const deliveryKey = getOrderStockDecisionKey(orderId, productAddressId)
    const memoryKey = `${normalizedMerchant}:${deliveryKey}`
    if (!options.requireDurable) this.memoryDeliveries.delete(memoryKey)

    const storageKey = getDeliveryStorageKey(normalizedMerchant)
    if (!storageKey || !this.storage) return false
    try {
      const stored = options.requireDurable
        ? parseStoredDeliveriesStrict(
            this.storage.getItem(storageKey),
            normalizedMerchant
          )
        : parseStoredDeliveries(
            this.storage.getItem(storageKey),
            normalizedMerchant
          )
      delete stored.deliveries[deliveryKey]
      this.storage.setItem(storageKey, JSON.stringify(stored))
      if (options.requireDurable) {
        const persisted = parseStoredDeliveriesStrict(
          this.storage.getItem(storageKey),
          normalizedMerchant
        ).deliveries[deliveryKey]
        if (persisted) return false
        this.memoryDeliveries.delete(memoryKey)
      }
      return true
    } catch {
      return false
    }
  }
}

type SignedOrderStockCheckpointInput = {
  merchantPubkey: string
  orderId: string
  adjustment: OrderStockAdjustment
  signedEvent: SignedPublicNostrEvent
  expectedUnpublishedEventId: string | null
  assertCurrentWriteBaseline: () => Promise<void>
  decisionStore: ProductStockDecisionStore
  pendingStore: PendingProductStockDeliveryStore
  requestLock?: MerchantStockLockRequest | null
}

/** Reserve an exact signed stock revision before the generic listing outbox runs. */
export async function checkpointSignedOrderStockDelivery(
  input: SignedOrderStockCheckpointInput
): Promise<true> {
  return withMerchantStockLock(
    input.merchantPubkey,
    () => checkpointSignedOrderStockDeliveryWithHeldLock(input),
    input.requestLock
  )
}

/** Only call while the merchant stock Web Lock is already held. */
export async function checkpointSignedOrderStockDeliveryWithHeldLock(
  input: Omit<SignedOrderStockCheckpointInput, "requestLock">
): Promise<true> {
  // Another tab may have projected a newer stock revision while this tab
  // was signing or waiting for the lock.
  await input.assertCurrentWriteBaseline()
  const decision = input.decisionStore.getPersisted(
    input.merchantPubkey,
    input.orderId,
    input.adjustment.addressId
  )
  if (input.expectedUnpublishedEventId === null) {
    if (decision) {
      throw new Error("This order's stock was already handled")
    }
  } else if (
    decision?.kind !== "unpublished" ||
    decision.localEventId !== input.expectedUnpublishedEventId
  ) {
    throw new Error("This order's stock recovery changed in another tab")
  }

  const decisions = input.decisionStore.getPersistedForMerchant(
    input.merchantPubkey
  )
  if (
    decisions.some(
      (candidate) =>
        candidate.kind !== "declined" &&
        candidate.adjustment?.key !== input.adjustment.key &&
        candidate.adjustment?.addressId === input.adjustment.addressId &&
        candidate.adjustment.sourceEventId === input.adjustment.sourceEventId
    )
  ) {
    throw new Error(
      "Another order already updated this product revision. Refresh the listing before continuing."
    )
  }

  const allPending = input.pendingStore.getPersistedForMerchant(
    input.merchantPubkey
  )
  // Keep a final-decision slot for every outstanding signed checkpoint.
  // Otherwise a published stock update could never be finalized after
  // the bounded decision journal fills.
  const undecidedPendingKeys = new Set(
    allPending
      .filter(
        (pending) =>
          !input.decisionStore.getPersisted(
            input.merchantPubkey,
            pending.orderId,
            pending.adjustment.addressId
          )
      )
      .map((pending) => pending.adjustment.key)
  )
  const reservedDecisionSlots =
    decisions.length +
    undecidedPendingKeys.size +
    (decision || undecidedPendingKeys.has(input.adjustment.key) ? 0 : 1)
  if (reservedDecisionSlots > MAX_STORED_STOCK_DECISIONS) {
    throw new Error(
      "Stock decision storage is full. No product change was staged."
    )
  }

  const pendingForProduct = allPending.filter(
    (pending) => pending.adjustment.addressId === input.adjustment.addressId
  )
  for (const pending of pendingForProduct) {
    const pendingDecision = input.decisionStore.getPersisted(
      input.merchantPubkey,
      pending.orderId,
      pending.adjustment.addressId
    )
    if (
      pendingDecision?.kind === "applied" ||
      (pendingDecision?.kind === "unpublished" &&
        pendingDecision.localEventId === pending.signedEvent.id)
    ) {
      // The decision was committed first; a failed cleanup may leave an
      // old checkpoint in storage. Its final decision supersedes it even
      // when another cleanup attempt also fails.
      input.pendingStore.delete(
        input.merchantPubkey,
        pending.orderId,
        pending.adjustment.addressId,
        { requireDurable: true }
      )
      continue
    }
    if (
      pending.adjustment.key !== input.adjustment.key ||
      pending.signedEvent.id !== input.signedEvent.id ||
      JSON.stringify(pending.adjustment) !== JSON.stringify(input.adjustment)
    ) {
      throw new Error(
        "Another signed stock update for this product is awaiting delivery"
      )
    }
  }
  if (
    !input.pendingStore.set(
      input.merchantPubkey,
      {
        orderId: input.orderId,
        adjustment: input.adjustment,
        signedEvent: input.signedEvent,
      },
      { requireDurable: true }
    )
  ) {
    throw new Error(
      "Could not save the signed stock update for recovery. No product change was staged."
    )
  }
  return true as const
}

/** Retry only bytes already reserved for this order, never a stale tab's copy. */
export async function confirmExactPendingStockDelivery(input: {
  merchantPubkey: string
  orderId: string
  adjustment: OrderStockAdjustment
  signedEventId: string
  pendingStore: PendingProductStockDeliveryStore
  decisionStore: ProductStockDecisionStore
  requestLock?: MerchantStockLockRequest | null
}): Promise<true> {
  return withMerchantStockLock(
    input.merchantPubkey,
    () => {
      const pending = input.pendingStore
        .getPersistedForMerchant(input.merchantPubkey)
        .find((candidate) => candidate.adjustment.key === input.adjustment.key)
      const decision = input.decisionStore.getPersisted(
        input.merchantPubkey,
        input.orderId,
        input.adjustment.addressId
      )
      if (
        !pending ||
        pending.signedEvent.id !== input.signedEventId ||
        JSON.stringify(pending.adjustment) !==
          JSON.stringify(input.adjustment) ||
        decision?.kind === "applied" ||
        decision?.kind === "declined" ||
        (decision?.kind === "unpublished" &&
          decision.localEventId === input.signedEventId)
      ) {
        throw new Error(
          "This exact stock update is no longer awaiting delivery. Refresh orders before retrying."
        )
      }
      return true as const
    },
    input.requestLock
  )
}

/** Commit the order decision before retiring its exact pending checkpoint. */
export async function settleSignedOrderStockDelivery(input: {
  merchantPubkey: string
  orderId: string
  adjustment: OrderStockAdjustment
  signedEventId: string
  kind: "applied" | "unpublished"
  decisionStore: ProductStockDecisionStore
  pendingStore: PendingProductStockDeliveryStore
  requestLock?: MerchantStockLockRequest | null
}): Promise<"saved" | "retry" | "stale"> {
  return withMerchantStockLock(
    input.merchantPubkey,
    () => {
      const pending = input.pendingStore
        .getPersistedForMerchant(input.merchantPubkey)
        .find((candidate) => candidate.adjustment.key === input.adjustment.key)
      if (
        !pending ||
        pending.signedEvent.id !== input.signedEventId ||
        JSON.stringify(pending.adjustment) !== JSON.stringify(input.adjustment)
      ) {
        return "stale"
      }
      const decision = input.decisionStore.getPersisted(
        input.merchantPubkey,
        input.orderId,
        input.adjustment.addressId
      )
      if (decision?.kind === "applied" || decision?.kind === "declined") {
        return "stale"
      }
      if (
        !input.decisionStore.set(
          input.merchantPubkey,
          input.orderId,
          input.adjustment.addressId,
          input.kind,
          input.adjustment,
          input.kind === "unpublished" ? input.signedEventId : undefined,
          { requireDurable: true }
        )
      ) {
        return "retry"
      }
      // A failed delete leaves a redundant pending record, but the durable
      // decision remains authoritative and prevents a second decrement.
      input.pendingStore.delete(
        input.merchantPubkey,
        input.orderId,
        input.adjustment.addressId,
        { requireDurable: true }
      )
      return "saved"
    },
    input.requestLock
  )
}
