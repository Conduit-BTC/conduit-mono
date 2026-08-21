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

export type ProductStockDecisionKind = "applied" | "declined"

export interface ProductStockDecision {
  kind: ProductStockDecisionKind
  decidedAt: number
  /** Latest unresolved order-relative state, preserved across listing refetches. */
  adjustment?: OrderStockAdjustment
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

export type OrderStockAdjustmentState =
  "stock_update_available" | "restocking_required"

export interface OrderStockAdjustment {
  key: string
  addressId: string
  sourceEventId: string
  title: string
  state: OrderStockAdjustmentState
  quantity: number
  currentStock: number
  nextStock: number
  shortfall: number
}

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
      }
      if (
        (decision.kind !== "applied" && decision.kind !== "declined") ||
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
      decisions[key] = {
        kind: decision.kind,
        decidedAt: decision.decidedAt,
        ...(adjustment ? { adjustment } : {}),
      }
    }

    return { version: 1, decisions }
  } catch {
    return { version: 1, decisions: {} }
  }
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
    state: storedState,
    quantity,
    currentStock,
    nextStock: storedNextStock,
    shortfall: storedShortfall,
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
    storedShortfall < 0
  ) {
    return null
  }

  const nextStock = Math.max(0, currentStock - quantity)
  const shortfall = Math.max(0, quantity - currentStock)
  if (storedNextStock !== nextStock || storedShortfall !== shortfall)
    return null

  const state: OrderStockAdjustmentState =
    shortfall > 0 ? "restocking_required" : "stock_update_available"
  if (storedState !== undefined && storedState !== state) return null

  return {
    key,
    addressId,
    sourceEventId,
    title,
    state,
    quantity,
    currentStock,
    nextStock,
    shortfall,
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

export function getOrderStockDecisionFollowUpAdjustment(input: {
  adjustment: OrderStockAdjustment
  persistedDecision: ProductStockDecision | null
}): OrderStockAdjustment | null {
  const persistedAdjustment = input.persistedDecision?.adjustment
  if (
    input.persistedDecision?.kind !== "applied" ||
    !persistedAdjustment ||
    persistedAdjustment.state !== "restocking_required" ||
    persistedAdjustment.key !== input.adjustment.key ||
    persistedAdjustment.addressId !== input.adjustment.addressId ||
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
    state: shortfall > 0 ? "restocking_required" : "stock_update_available",
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
      input.persistedDecision.adjustment?.state === "restocking_required"
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
  return input.persistedDecision?.kind === "applied" &&
    input.persistedDecision.adjustment?.state === "restocking_required" &&
    doesOrderStockDecisionCoverAdjustment(input)
    ? input.persistedDecision.adjustment
    : input.adjustment
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
    const state: OrderStockAdjustmentState =
      shortfall > 0 ? "restocking_required" : "stock_update_available"
    if (state !== "restocking_required" && currentStock === nextStock) continue

    adjustments.push({
      key: getOrderStockDecisionKey(input.orderId, record.addressId),
      addressId: record.addressId,
      sourceEventId: record.eventId,
      title: record.product.title,
      state,
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
    const memoryDecision = this.memoryDecisions.get(memoryKey)
    if (
      memoryDecision &&
      isDecisionBoundToProduct(
        memoryDecision,
        decisionKey,
        normalizedProductAddressId
      )
    ) {
      return memoryDecision
    }
    if (memoryDecision) this.memoryDecisions.delete(memoryKey)

    const storageKey = getDecisionStorageKey(merchantPubkey)
    if (!storageKey || !this.storage) return null
    try {
      const stored = parseStoredDecisions(this.storage.getItem(storageKey))
      const decision = stored.decisions[decisionKey] ?? null
      if (
        decision &&
        !isDecisionBoundToProduct(
          decision,
          decisionKey,
          normalizedProductAddressId
        )
      ) {
        return null
      }
      if (decision) this.memoryDecisions.set(memoryKey, decision)
      return decision
    } catch {
      return null
    }
  }

  set(
    merchantPubkey: string,
    orderId: string,
    productAddressId: string,
    kind: ProductStockDecisionKind,
    adjustment?: OrderStockAdjustment
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
    const decision: ProductStockDecision = {
      kind,
      decidedAt: Date.now(),
      ...(adjustment ? { adjustment: { ...adjustment } } : {}),
    }
    this.memoryDecisions.set(`${merchantPubkey}:${decisionKey}`, decision)

    const storageKey = getDecisionStorageKey(merchantPubkey)
    if (!storageKey || !this.storage) return false
    try {
      const stored = parseStoredDecisions(this.storage.getItem(storageKey))
      stored.decisions[decisionKey] = decision
      const entries = Object.entries(stored.decisions).sort(
        ([, left], [, right]) => right.decidedAt - left.decidedAt
      )
      stored.decisions = Object.fromEntries(
        entries.slice(0, MAX_STORED_STOCK_DECISIONS)
      )
      this.storage.setItem(storageKey, JSON.stringify(stored))
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

  set(
    merchantPubkey: string,
    delivery: Omit<PendingProductStockDelivery, "savedAt">
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
    this.memoryDeliveries.set(
      `${normalizedMerchant}:${deliveryKey}`,
      normalizedPending
    )

    const storageKey = getDeliveryStorageKey(normalizedMerchant)
    if (!storageKey || !this.storage) return false
    try {
      const stored = parseStoredDeliveries(
        this.storage.getItem(storageKey),
        normalizedMerchant
      )
      stored.deliveries[deliveryKey] = normalizedPending
      const entries = Object.entries(stored.deliveries).sort(
        ([, left], [, right]) => right.savedAt - left.savedAt
      )
      stored.deliveries = Object.fromEntries(
        entries.slice(0, MAX_STORED_STOCK_DELIVERIES)
      )
      this.storage.setItem(storageKey, JSON.stringify(stored))
      return true
    } catch {
      return false
    }
  }

  delete(
    merchantPubkey: string,
    orderId: string,
    productAddressId: string
  ): boolean {
    const normalizedMerchant = merchantPubkey.trim()
    const deliveryKey = getOrderStockDecisionKey(orderId, productAddressId)
    this.memoryDeliveries.delete(`${normalizedMerchant}:${deliveryKey}`)

    const storageKey = getDeliveryStorageKey(normalizedMerchant)
    if (!storageKey || !this.storage) return false
    try {
      const stored = parseStoredDeliveries(
        this.storage.getItem(storageKey),
        normalizedMerchant
      )
      delete stored.deliveries[deliveryKey]
      this.storage.setItem(storageKey, JSON.stringify(stored))
      return true
    } catch {
      return false
    }
  }
}
