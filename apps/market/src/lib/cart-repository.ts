import {
  compareReplaceableEventFrontiers,
  db,
  isFiatCurrencyCode,
  normalizePublicMediaUrl,
  subscribeToShoppingCartChanges,
  type StoredShoppingCart,
} from "@conduit/core"
import {
  getCartCommerceFingerprint,
  getCartItemKey,
  getCartLineFulfillmentId,
  groupCartPurchases,
  isSameCartLineFulfillment,
  parsePersistedCart,
  type CartItem,
  type CartItemIdentity,
  type CartItemInput,
  type CartItemStockEvidence,
} from "./cart-model"

export const LEGACY_CART_STORAGE_KEY = "conduit:cart"
export const CART_RECORD_ID = "market"
export const CART_RECORD_VERSION = 1
export const LEGACY_CART_CUTOVER_VERSION = 3

type CartQuantityBatch = {
  id: string
  quantity: number
}

type CartLine = {
  id: string
  item: CartItem
  batches: CartQuantityBatch[]
}

type CanonicalCartRecord = Omit<StoredShoppingCart, "lines"> & {
  id: typeof CART_RECORD_ID
  version: typeof CART_RECORD_VERSION
  lines: CartLine[]
}

export type CartPersistenceMode = "persistent" | "memory"

export type CartRepositorySnapshot = {
  items: CartItem[]
  hydrated: boolean
  persistenceMode: CartPersistenceMode
  revision: number
  mutationSequence: number
}

export type CartPurchaseClaim = {
  purchaseId: string
  reviewFingerprint: string
  allocations: Array<{
    lineId: string
    batches: CartQuantityBatch[]
  }>
}

export class CartChangedDuringCheckoutError extends Error {
  constructor() {
    super(
      "Your cart changed in another tab. Review this purchase again before ordering."
    )
    this.name = "CartChangedDuringCheckoutError"
  }
}

type CartMutationResult = {
  before: CartItem[]
  after: CartItem[]
  changed: boolean
}

type RecordMutation = (record: CanonicalCartRecord) => boolean

type LegacyCartRead =
  | { status: "readable"; items: CartItem[] }
  | { status: "cutover"; items: [] }
  | { status: "unsupported"; items: [] }

const listeners = new Set<() => void>()
let snapshot: CartRepositorySnapshot = {
  items: [],
  hydrated: false,
  persistenceMode: "persistent",
  revision: 0,
  mutationSequence: 0,
}
let initialization: Promise<void> | null = null
let unsubscribeFromCanonical: (() => void) | null = null
let resumeListenersInstalled = false
let memoryRecord: CanonicalCartRecord | null = null
let publishedRecord: CanonicalCartRecord | null = null
let operationQueue: Promise<void> = Promise.resolve()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeCartItemImage(item: CartItem): CartItem {
  const image = normalizePublicMediaUrl(item.image)
  return { ...item, image: image ?? undefined }
}

function hasStrictlyNewerProductRevision(
  current: Pick<CartItem, "productUpdatedAt" | "productEventId">,
  candidate: Pick<CartItem, "productUpdatedAt" | "productEventId">
): boolean {
  return (
    compareReplaceableEventFrontiers(
      {
        createdAt: candidate.productUpdatedAt,
        eventId: candidate.productEventId,
      },
      {
        createdAt: current.productUpdatedAt,
        eventId: current.productEventId,
      }
    ) > 0
  )
}

function hasStrictlyOlderProductRevision(
  current: Pick<CartItem, "productUpdatedAt" | "productEventId">,
  candidate: Pick<CartItem, "productUpdatedAt" | "productEventId">
): boolean {
  return (
    compareReplaceableEventFrontiers(
      {
        createdAt: candidate.productUpdatedAt,
        eventId: candidate.productEventId,
      },
      {
        createdAt: current.productUpdatedAt,
        eventId: current.productEventId,
      }
    ) < 0
  )
}

type SourceAmount = {
  amount: number
  currency: string
  normalizedCurrency: string
}

function hasSameQuoteDerivedSource(
  current: SourceAmount | undefined,
  candidate: SourceAmount | undefined
): boolean {
  return (
    current !== undefined &&
    candidate !== undefined &&
    current.amount > 0 &&
    isFiatCurrencyCode(current.normalizedCurrency) &&
    current.amount === candidate.amount &&
    current.currency === candidate.currency &&
    current.normalizedCurrency === candidate.normalizedCurrency
  )
}

function refreshQuoteDerivedFields(
  current: CartItem,
  candidate: CartItem
): CartItem {
  let next = current
  if (
    candidate.priceSats !== undefined &&
    hasSameQuoteDerivedSource(current.sourcePrice, candidate.sourcePrice)
  ) {
    next = { ...next, priceSats: candidate.priceSats }
  }
  if (
    candidate.shippingCostSats !== undefined &&
    hasSameQuoteDerivedSource(
      current.sourceShippingCost,
      candidate.sourceShippingCost
    )
  ) {
    next = { ...next, shippingCostSats: candidate.shippingCostSats }
  }
  if (
    current.fulfillment?.type === "pickup" &&
    candidate.fulfillment?.type === "pickup" &&
    hasSameQuoteDerivedSource(
      current.fulfillment.sourceCost,
      candidate.fulfillment.sourceCost
    )
  ) {
    next = {
      ...next,
      fulfillment: {
        ...current.fulfillment,
        costSats: candidate.fulfillment.costSats,
      },
    }
  }
  return next
}

function selectCartItemSnapshot(
  current: CartItem,
  candidate: CartItem
): CartItem {
  if (hasStrictlyNewerProductRevision(current, candidate)) {
    return {
      ...current,
      ...candidate,
      merchantAddedAt: current.merchantAddedAt,
    }
  }
  if (hasStrictlyOlderProductRevision(current, candidate)) return current
  return refreshQuoteDerivedFields(current, candidate)
}

function materializeLines(lines: readonly CartLine[]): CartItem[] {
  return lines.map((line) => ({
    ...line.item,
    cartLineId: line.id,
    quantity: line.batches.reduce((sum, batch) => sum + batch.quantity, 0),
  }))
}

function createEmptyRecord(migratedAt = Date.now()): CanonicalCartRecord {
  return {
    id: CART_RECORD_ID,
    version: CART_RECORD_VERSION,
    revision: 0,
    nextSequence: 1,
    lines: [],
    migratedAt,
    updatedAt: migratedAt,
  }
}

function takeId(record: CanonicalCartRecord, prefix: "line" | "batch"): string {
  const id = `${prefix}:${record.nextSequence}`
  record.nextSequence += 1
  return id
}

function createRecordFromLegacy(items: CartItem[]): CanonicalCartRecord {
  const record = createEmptyRecord()
  for (const legacyItem of items) {
    const quantity = Math.max(1, Math.floor(legacyItem.quantity))
    const lineId = takeId(record, "line")
    const batchId = takeId(record, "batch")
    const item = { ...sanitizeCartItemImage(legacyItem) }
    delete item.cartLineId
    record.lines.push({
      id: lineId,
      item: { ...item, quantity },
      batches: [{ id: batchId, quantity }],
    })
  }
  return record
}

function createMemoryRecordFromSnapshot(
  items: CartItem[]
): CanonicalCartRecord {
  const record = createEmptyRecord()
  record.revision = snapshot.revision
  record.nextSequence = Math.max(1, Date.now())
  for (const current of items) {
    const quantity = Math.max(1, Math.floor(current.quantity))
    const { cartLineId, ...item } = current
    const lineId = cartLineId ?? takeId(record, "line")
    record.lines.push({
      id: lineId,
      item: { ...item, quantity },
      batches: [{ id: `memory:${takeId(record, "batch")}`, quantity }],
    })
  }
  return record
}

function parseStoredLine(value: unknown): CartLine | null {
  if (!isRecord(value) || typeof value.id !== "string") return null
  if (!Array.isArray(value.batches) || value.batches.length === 0) return null

  const batchIds = new Set<string>()
  const batches: CartQuantityBatch[] = []
  for (const candidate of value.batches) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !candidate.id ||
      typeof candidate.quantity !== "number" ||
      !Number.isSafeInteger(candidate.quantity) ||
      candidate.quantity <= 0 ||
      batchIds.has(candidate.id)
    ) {
      return null
    }
    batchIds.add(candidate.id)
    batches.push({ id: candidate.id, quantity: candidate.quantity })
  }

  const quantity = batches.reduce((sum, batch) => sum + batch.quantity, 0)
  const parsed = parsePersistedCart({
    version: 2,
    items: [{ ...(isRecord(value.item) ? value.item : {}), quantity }],
  }).state.items
  if (parsed.length !== 1) return null

  return {
    id: value.id,
    item: sanitizeCartItemImage(parsed[0]!),
    batches,
  }
}

function parseStoredRecord(value: StoredShoppingCart): CanonicalCartRecord {
  if (
    value.id !== CART_RECORD_ID ||
    value.version !== CART_RECORD_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.nextSequence) ||
    value.nextSequence < 1 ||
    !Array.isArray(value.lines)
  ) {
    throw new Error("Unsupported or malformed canonical cart record")
  }

  const lineIds = new Set<string>()
  const lineKeys = new Set<string>()
  const lines: CartLine[] = []
  for (const candidate of value.lines) {
    const line = parseStoredLine(candidate)
    if (!line || lineIds.has(line.id)) {
      throw new Error("Malformed canonical cart line")
    }
    const lineKey = JSON.stringify([
      getCartItemKey(line.item),
      getCartLineFulfillmentId(line.item),
    ])
    if (lineKeys.has(lineKey)) {
      throw new Error("Duplicate canonical cart line")
    }
    lineIds.add(line.id)
    lineKeys.add(lineKey)
    lines.push(line)
  }

  return { ...value, id: CART_RECORD_ID, version: CART_RECORD_VERSION, lines }
}

function cloneRecord(record: CanonicalCartRecord): CanonicalCartRecord {
  return {
    ...record,
    lines: record.lines.map((line) => ({
      id: line.id,
      item: { ...line.item },
      batches: line.batches.map((batch) => ({ ...batch })),
    })),
  }
}

function notify(): void {
  for (const listener of listeners) listener()
}

function publishRecord(
  record: CanonicalCartRecord,
  persistenceMode: CartPersistenceMode
): void {
  const items = materializeLines(record.lines)
  const mutationSequence =
    snapshot.hydrated &&
    (snapshot.revision !== record.revision ||
      getCartReviewFingerprint(snapshot.items) !==
        getCartReviewFingerprint(items))
      ? snapshot.mutationSequence + 1
      : snapshot.mutationSequence
  publishedRecord = cloneRecord(record)
  const next: CartRepositorySnapshot = {
    items,
    hydrated: true,
    persistenceMode,
    revision: record.revision,
    mutationSequence,
  }
  const changed =
    !snapshot.hydrated ||
    snapshot.persistenceMode !== next.persistenceMode ||
    snapshot.revision !== next.revision ||
    getCartReviewFingerprint(snapshot.items) !==
      getCartReviewFingerprint(next.items)
  snapshot = next
  if (changed) notify()
}

function isLegacyCutoverMarker(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return (
    keys.length === 3 &&
    keys.every((key) =>
      ["version", "migratedTo", "migratedAt"].includes(key)
    ) &&
    value.version === LEGACY_CART_CUTOVER_VERSION &&
    value.migratedTo === "indexeddb" &&
    typeof value.migratedAt === "number" &&
    Number.isSafeInteger(value.migratedAt) &&
    value.migratedAt >= 0
  )
}

function readLegacyCart(): LegacyCartRead {
  if (typeof window === "undefined") return { status: "readable", items: [] }
  try {
    const raw = window.localStorage.getItem(LEGACY_CART_STORAGE_KEY)
    if (!raw) return { status: "readable", items: [] }
    const value: unknown = JSON.parse(raw)
    if (isLegacyCutoverMarker(value)) return { status: "cutover", items: [] }
    const parsed = parsePersistedCart(value)
    if (!parsed.writable) return { status: "unsupported", items: [] }
    return {
      status: "readable",
      items: parsed.state.items.map(sanitizeCartItemImage),
    }
  } catch {
    return { status: "readable", items: [] }
  }
}

function markLegacyCutover(migratedAt: number): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      LEGACY_CART_STORAGE_KEY,
      JSON.stringify({
        version: LEGACY_CART_CUTOVER_VERSION,
        migratedTo: "indexeddb",
        migratedAt,
      })
    )
  } catch {
    // IndexedDB remains canonical even when the legacy marker cannot be saved.
  }
}

async function loadCanonicalRecord(): Promise<CanonicalCartRecord> {
  const stored = await db.shoppingCarts.get(CART_RECORD_ID)
  if (!stored) throw new Error("Canonical cart record is missing")
  return parseStoredRecord(stored)
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = operationQueue.then(operation, operation)
  operationQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function refreshCanonical(): Promise<void> {
  if (!snapshot.hydrated || snapshot.persistenceMode !== "persistent") return
  try {
    publishRecord(await loadCanonicalRecord(), "persistent")
  } catch {
    // A transient read failure must not replace a usable last snapshot.
  }
}

function installResumeListeners(): void {
  if (resumeListenersInstalled || typeof window === "undefined") return
  resumeListenersInstalled = true
  const resume = () => void enqueue(refreshCanonical)
  const resumeVisible = () => {
    if (document.visibilityState === "visible") resume()
  }
  window.addEventListener("focus", resume)
  window.addEventListener("pageshow", resume)
  document.addEventListener("visibilitychange", resumeVisible)
}

async function initialize(): Promise<void> {
  const legacy = readLegacyCart()
  if (typeof window === "undefined") {
    memoryRecord = createRecordFromLegacy(legacy.items)
    publishRecord(memoryRecord, "memory")
    return
  }

  try {
    const record = await db.transaction(
      "rw",
      db.shoppingCarts,
      async (): Promise<CanonicalCartRecord | null> => {
        const stored = await db.shoppingCarts.get(CART_RECORD_ID)
        if (stored) return parseStoredRecord(stored)
        if (legacy.status === "unsupported") return null
        const migrated = createRecordFromLegacy(legacy.items)
        await db.shoppingCarts.put(migrated)
        return migrated
      }
    )
    if (!record) {
      memoryRecord = createRecordFromLegacy([])
      publishRecord(memoryRecord, "memory")
      return
    }
    publishRecord(record, "persistent")
    if (legacy.status !== "unsupported") {
      markLegacyCutover(record.migratedAt)
    }
    unsubscribeFromCanonical ??= subscribeToShoppingCartChanges({
      onChange: () => void enqueue(refreshCanonical),
      onError: () => {
        // Focus/pageshow reconciliation remains available after observer error.
      },
    })
    installResumeListeners()
  } catch {
    memoryRecord = createRecordFromLegacy(legacy.items)
    publishRecord(memoryRecord, "memory")
  }
}

export function initializeCartRepository(): Promise<void> {
  initialization ??= initialize()
  return initialization
}

export function getCartRepositorySnapshot(): CartRepositorySnapshot {
  void initializeCartRepository()
  return snapshot
}

export function subscribeToCartRepository(listener: () => void): () => void {
  listeners.add(listener)
  void initializeCartRepository()
  return () => listeners.delete(listener)
}

async function mutateCartWithFactory(
  createMutation: () => RecordMutation
): Promise<CartMutationResult> {
  await initializeCartRepository()
  return enqueue(async () => {
    const mutation = createMutation()
    if (snapshot.persistenceMode === "memory") {
      const record = cloneRecord(memoryRecord ?? createEmptyRecord())
      const before = materializeLines(record.lines)
      const changed = mutation(record)
      if (changed) {
        record.revision += 1
        record.updatedAt = Date.now()
        memoryRecord = record
        publishRecord(record, "memory")
      }
      return { before, after: materializeLines(record.lines), changed }
    }

    let before: CartItem[] = []
    let after: CartItem[] = []
    let changed = false
    try {
      const committed = await db.transaction(
        "rw",
        db.shoppingCarts,
        async (): Promise<CanonicalCartRecord> => {
          const stored = await db.shoppingCarts.get(CART_RECORD_ID)
          if (!stored) throw new Error("Canonical cart record is missing")
          const record = parseStoredRecord(stored)
          before = materializeLines(record.lines)
          changed = mutation(record)
          if (changed) {
            record.revision += 1
            record.updatedAt = Date.now()
            await db.shoppingCarts.put(record)
          }
          after = materializeLines(record.lines)
          return record
        }
      )
      publishRecord(committed, "persistent")
      return { before, after, changed }
    } catch {
      // Keep the cart usable in this tab without representing the fallback as
      // durable or cross-tab safe.
      unsubscribeFromCanonical?.()
      unsubscribeFromCanonical = null
      const record = cloneRecord(
        publishedRecord ??
          memoryRecord ??
          createMemoryRecordFromSnapshot(snapshot.items)
      )
      before = materializeLines(record.lines)
      changed = mutation(record)
      if (changed) {
        record.revision += 1
        record.updatedAt = Date.now()
      }
      memoryRecord = record
      after = materializeLines(record.lines)
      publishRecord(record, "memory")
      return { before, after, changed }
    }
  })
}

function mutateCart(mutation: RecordMutation): Promise<CartMutationResult> {
  return mutateCartWithFactory(() => mutation)
}

function mutateObservedCart(
  createMutation: (observed: CanonicalCartRecord) => RecordMutation
): Promise<CartMutationResult> {
  const observed = cloneRecord(
    publishedRecord ??
      memoryRecord ??
      createMemoryRecordFromSnapshot(snapshot.items)
  )
  return mutateCartWithFactory(() => createMutation(observed))
}

function findLineIndex(
  record: CanonicalCartRecord,
  identity: CartItemIdentity
): number {
  if (identity.cartLineId) {
    return record.lines.findIndex(
      (line) =>
        line.id === identity.cartLineId &&
        line.item.merchantPubkey === identity.merchantPubkey &&
        line.item.productId === identity.productId
    )
  }
  const matches = record.lines.flatMap((line, index) =>
    line.item.merchantPubkey === identity.merchantPubkey &&
    line.item.productId === identity.productId
      ? [index]
      : []
  )
  return matches.length === 1 ? matches[0]! : -1
}

function getMerchantAddedAt(
  record: CanonicalCartRecord,
  merchantPubkey: string
): number | undefined {
  return record.lines.find(
    (line) => line.item.merchantPubkey === merchantPubkey
  )?.item.merchantAddedAt
}

function appendBatch(
  record: CanonicalCartRecord,
  line: CartLine,
  quantity: number
): void {
  line.batches.push({ id: takeId(record, "batch"), quantity })
}

function removeAllocatedBatches(
  record: CanonicalCartRecord,
  allocations: CartPurchaseClaim["allocations"]
): boolean {
  let changed = false
  for (const allocation of allocations) {
    const lineIndex = record.lines.findIndex(
      (line) => line.id === allocation.lineId
    )
    if (lineIndex < 0) continue
    const line = record.lines[lineIndex]!
    const quantityByBatch = new Map(
      allocation.batches.map((batch) => [batch.id, batch.quantity])
    )
    line.batches = line.batches.flatMap((batch) => {
      const consumed = quantityByBatch.get(batch.id) ?? 0
      if (consumed <= 0) return [batch]
      changed = true
      const remaining = batch.quantity - consumed
      return remaining > 0 ? [{ ...batch, quantity: remaining }] : []
    })
    if (line.batches.length === 0) record.lines.splice(lineIndex, 1)
  }
  return changed
}

export function addCartRepositoryItem(
  input: CartItemInput & { merchantAddedAt?: number },
  quantity = 1
): Promise<CartMutationResult> {
  return mutateCart((record) => {
    const requested = Math.max(1, Math.floor(quantity))
    const sanitized = sanitizeCartItemImage({ ...input, quantity: requested })
    const index = record.lines.findIndex(
      (line) =>
        line.item.merchantPubkey === input.merchantPubkey &&
        line.item.productId === input.productId &&
        isSameCartLineFulfillment(line.item, sanitized)
    )
    if (index >= 0) {
      const line = record.lines[index]!
      const current = line.batches.reduce(
        (sum, batch) => sum + batch.quantity,
        0
      )
      const nextItem = selectCartItemSnapshot(line.item, sanitized)
      if (
        nextItem.stock === 0 ||
        (typeof nextItem.stock === "number" &&
          current + requested > nextItem.stock)
      ) {
        return false
      }
      line.item = nextItem
      appendBatch(record, line, requested)
      return true
    }

    if (
      sanitized.stock === 0 ||
      (typeof sanitized.stock === "number" && requested > sanitized.stock)
    ) {
      return false
    }
    const lineId = takeId(record, "line")
    const merchantAddedAt =
      getMerchantAddedAt(record, input.merchantPubkey) ??
      input.merchantAddedAt ??
      Date.now()
    const line: CartLine = {
      id: lineId,
      item: { ...sanitized, merchantAddedAt },
      batches: [],
    }
    appendBatch(record, line, requested)
    record.lines.push(line)
    return true
  })
}

export function incrementCartRepositoryItem(
  identity: CartItemIdentity,
  quantity = 1,
  currentStockEvidence?: CartItemStockEvidence
): Promise<CartMutationResult> {
  return mutateCart((record) => {
    const index = findLineIndex(record, identity)
    if (index < 0) return false
    const line = record.lines[index]!
    const current = line.batches.reduce((sum, batch) => sum + batch.quantity, 0)
    const requested = Math.max(1, Math.floor(quantity))
    const stock =
      currentStockEvidence === undefined
        ? line.item.stock
        : line.item.stock === undefined ||
            hasStrictlyNewerProductRevision(line.item, currentStockEvidence)
          ? currentStockEvidence.stock
          : currentStockEvidence.stock === undefined
            ? line.item.stock
            : Math.min(line.item.stock, currentStockEvidence.stock)
    if (typeof stock === "number" && current + requested > stock) {
      return false
    }
    appendBatch(record, line, requested)
    return true
  })
}

/**
 * Refresh a rendered line from current product evidence and increment it in one
 * transaction. The exact line incarnation is mandatory so a delayed product
 * action cannot recreate a line that another tab removed.
 */
export function refreshAndIncrementCartRepositoryItem(
  identity: CartItemIdentity,
  input: CartItemInput,
  quantity = 1
): Promise<CartMutationResult> {
  return mutateCart((record) => {
    if (!identity.cartLineId) return false
    const index = findLineIndex(record, identity)
    if (index < 0) return false

    const line = record.lines[index]!
    const requested = Math.max(1, Math.floor(quantity))
    const current = line.batches.reduce((sum, batch) => sum + batch.quantity, 0)
    const sanitized = sanitizeCartItemImage({
      ...input,
      quantity: current,
    })
    if (
      sanitized.merchantPubkey !== line.item.merchantPubkey ||
      sanitized.productId !== line.item.productId ||
      !isSameCartLineFulfillment(line.item, sanitized)
    ) {
      return false
    }

    const nextItem = selectCartItemSnapshot(line.item, sanitized)
    if (
      nextItem.stock === 0 ||
      (typeof nextItem.stock === "number" &&
        current + requested > nextItem.stock)
    ) {
      return false
    }

    line.item = nextItem
    appendBatch(record, line, requested)
    return true
  })
}

export function decrementCartRepositoryItem(
  identity: CartItemIdentity
): Promise<CartMutationResult> {
  return mutateObservedCart((observed) => {
    const observedIndex = findLineIndex(observed, identity)
    const observedLine = observed.lines[observedIndex]
    const observedBatchIds =
      observedLine?.batches.map((batch) => batch.id).reverse() ?? []
    return (record) => {
      if (!observedLine || observedBatchIds.length === 0) return false
      const index = record.lines.findIndex(
        (line) => line.id === observedLine.id
      )
      if (index < 0) return false
      const line = record.lines[index]!
      const batchIndex = observedBatchIds.reduce(
        (match, batchId) =>
          match >= 0
            ? match
            : line.batches.findIndex((batch) => batch.id === batchId),
        -1
      )
      if (batchIndex < 0) return false
      const batch = line.batches[batchIndex]!
      if (batch.quantity > 1) batch.quantity -= 1
      else line.batches.splice(batchIndex, 1)
      if (line.batches.length === 0) record.lines.splice(index, 1)
      return true
    }
  })
}

export function removeCartRepositoryItem(
  identity: CartItemIdentity
): Promise<CartMutationResult> {
  return mutateObservedCart((observed) => {
    const observedIndex = findLineIndex(observed, identity)
    const observedLine = observed.lines[observedIndex]
    const allocations = observedLine
      ? [
          {
            lineId: observedLine.id,
            batches: observedLine.batches.map((batch) => ({ ...batch })),
          },
        ]
      : []
    return (record) => removeAllocatedBatches(record, allocations)
  })
}

export function clearCartRepository(): Promise<CartMutationResult> {
  return mutateObservedCart((observed) => {
    const allocations = observed.lines.map((line) => ({
      lineId: line.id,
      batches: line.batches.map((batch) => ({ ...batch })),
    }))
    return (record) => removeAllocatedBatches(record, allocations)
  })
}

export function clearCartRepositoryPurchase(
  purchaseId: string
): Promise<CartMutationResult> {
  return mutateObservedCart((observed) => {
    const purchase = groupCartPurchases(materializeLines(observed.lines)).find(
      (group) => group.id === purchaseId
    )
    const lineIds = new Set(
      (purchase?.items ?? []).flatMap((item) =>
        item.cartLineId ? [item.cartLineId] : []
      )
    )
    const allocations = observed.lines
      .filter((line) => lineIds.has(line.id))
      .map((line) => ({
        lineId: line.id,
        batches: line.batches.map((batch) => ({ ...batch })),
      }))
    return (record) => removeAllocatedBatches(record, allocations)
  })
}

export function getCartReviewFingerprint(items: readonly CartItem[]): string {
  return JSON.stringify([
    getCartCommerceFingerprint(items),
    items
      .map((item) => [item.cartLineId ?? null, item.quantity])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ])
}

async function readCurrentRecord(): Promise<CanonicalCartRecord> {
  await initializeCartRepository()
  if (snapshot.persistenceMode === "memory") {
    return cloneRecord(memoryRecord ?? createEmptyRecord())
  }
  try {
    return await loadCanonicalRecord()
  } catch {
    unsubscribeFromCanonical?.()
    unsubscribeFromCanonical = null
    memoryRecord = createMemoryRecordFromSnapshot(snapshot.items)
    publishRecord(memoryRecord, "memory")
    return cloneRecord(memoryRecord)
  }
}

export async function captureCartPurchase(
  purchaseId: string,
  reviewedItems: readonly CartItem[]
): Promise<CartPurchaseClaim> {
  return enqueue(async () => {
    const record = await readCurrentRecord()
    if (snapshot.persistenceMode === "persistent") {
      // Capture may observe a newer commit before this tab's live-query
      // notification arrives. Retain that exact batch identity so a later
      // persistence failure can consume the reviewed purchase in memory.
      publishRecord(record, "persistent")
    }
    const purchase = groupCartPurchases(materializeLines(record.lines)).find(
      (group) => group.id === purchaseId
    )
    const reviewFingerprint = getCartReviewFingerprint(reviewedItems)
    if (
      !purchase ||
      getCartReviewFingerprint(purchase.items) !== reviewFingerprint
    ) {
      throw new CartChangedDuringCheckoutError()
    }
    const lineIds = new Set(
      purchase.items.flatMap((item) =>
        item.cartLineId ? [item.cartLineId] : []
      )
    )
    return {
      purchaseId,
      reviewFingerprint,
      allocations: record.lines
        .filter((line) => lineIds.has(line.id))
        .map((line) => ({
          lineId: line.id,
          batches: line.batches.map((batch) => ({ ...batch })),
        })),
    }
  })
}

export function consumeCartPurchase(
  claim: CartPurchaseClaim
): Promise<CartMutationResult> {
  return mutateCart((record) =>
    removeAllocatedBatches(record, claim.allocations)
  )
}
