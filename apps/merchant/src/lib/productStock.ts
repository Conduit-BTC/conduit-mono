import {
  EVENT_KINDS,
  isValidSignedPublicNostrEvent,
  type CommerceProductRecord,
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
      const decision = value as { kind?: unknown; decidedAt?: unknown }
      if (
        (decision.kind !== "applied" && decision.kind !== "declined") ||
        typeof decision.decidedAt !== "number" ||
        !Number.isFinite(decision.decidedAt)
      ) {
        continue
      }
      decisions[key] = {
        kind: decision.kind,
        decidedAt: decision.decidedAt,
      }
    }

    return { version: 1, decisions }
  } catch {
    return { version: 1, decisions: {} }
  }
}

function isOrderStockAdjustment(value: unknown): value is OrderStockAdjustment {
  if (!value || typeof value !== "object") return false
  const adjustment = value as Partial<OrderStockAdjustment>
  return (
    typeof adjustment.key === "string" &&
    typeof adjustment.addressId === "string" &&
    typeof adjustment.sourceEventId === "string" &&
    typeof adjustment.title === "string" &&
    typeof adjustment.quantity === "number" &&
    Number.isSafeInteger(adjustment.quantity) &&
    adjustment.quantity > 0 &&
    typeof adjustment.currentStock === "number" &&
    Number.isSafeInteger(adjustment.currentStock) &&
    adjustment.currentStock >= 0 &&
    typeof adjustment.nextStock === "number" &&
    Number.isSafeInteger(adjustment.nextStock) &&
    adjustment.nextStock >= 0 &&
    typeof adjustment.shortfall === "number" &&
    Number.isSafeInteger(adjustment.shortfall) &&
    adjustment.shortfall >= 0
  )
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

function isPendingProductStockDelivery(
  value: unknown,
  merchantPubkey: string
): value is PendingProductStockDelivery {
  if (!value || typeof value !== "object") return false
  const delivery = value as Partial<PendingProductStockDelivery>
  if (
    typeof delivery.orderId !== "string" ||
    !delivery.orderId.trim() ||
    !isOrderStockAdjustment(delivery.adjustment) ||
    !delivery.signedEvent ||
    !isValidSignedPublicNostrEvent(delivery.signedEvent) ||
    delivery.signedEvent.pubkey !== merchantPubkey ||
    getSignedProductAddressId(delivery.signedEvent) !==
      delivery.adjustment.addressId ||
    typeof delivery.savedAt !== "number" ||
    !Number.isFinite(delivery.savedAt)
  ) {
    return false
  }
  return true
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
      if (isPendingProductStockDelivery(value, merchantPubkey)) {
        deliveries[key] = value
      }
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

export function getOrderStockDecisionKey(
  orderId: string,
  productAddressId: string
): string {
  return `${encodeURIComponent(orderId.trim())}:${encodeURIComponent(
    productAddressId.trim()
  )}`
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
    if (record.product.type !== "simple") continue
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
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) continue
    const record = recordsByLookupId.get(normalizeLookupId(item.productId))
    if (!record) continue

    const current = quantitiesByAddress.get(record.addressId)
    quantitiesByAddress.set(record.addressId, {
      record,
      quantity: (current?.quantity ?? 0) + item.quantity,
    })
  }

  return Array.from(quantitiesByAddress.values())
    .map(({ record, quantity }) => {
      const currentStock = record.product.stock!
      const nextStock = Math.max(0, currentStock - quantity)
      return {
        key: getOrderStockDecisionKey(input.orderId, record.addressId),
        addressId: record.addressId,
        sourceEventId: record.eventId,
        title: record.product.title,
        quantity,
        currentStock,
        nextStock,
        shortfall: Math.max(0, quantity - currentStock),
      }
    })
    .filter((adjustment) => adjustment.currentStock !== adjustment.nextStock)
    .sort((left, right) => left.title.localeCompare(right.title))
}

export class ProductStockDecisionStore {
  private readonly memoryDecisions = new Map<string, ProductStockDecision>()

  constructor(private readonly storage: Storage | null = getBrowserStorage()) {}

  get(
    merchantPubkey: string,
    orderId: string,
    productAddressId: string
  ): ProductStockDecision | null {
    const decisionKey = getOrderStockDecisionKey(orderId, productAddressId)
    const memoryKey = `${merchantPubkey}:${decisionKey}`
    const memoryDecision = this.memoryDecisions.get(memoryKey)
    if (memoryDecision) return memoryDecision

    const storageKey = getDecisionStorageKey(merchantPubkey)
    if (!storageKey || !this.storage) return null
    try {
      const stored = parseStoredDecisions(this.storage.getItem(storageKey))
      const decision = stored.decisions[decisionKey] ?? null
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
    kind: ProductStockDecisionKind
  ): boolean {
    const decisionKey = getOrderStockDecisionKey(orderId, productAddressId)
    const decision: ProductStockDecision = { kind, decidedAt: Date.now() }
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

    return Array.from(this.memoryDeliveries.entries())
      .filter(
        ([key, delivery]) =>
          key.startsWith(`${normalizedMerchant}:`) &&
          delivery.orderId === normalizedOrder
      )
      .map(([, delivery]) => delivery)
      .sort((left, right) => right.savedAt - left.savedAt)
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
    if (!isPendingProductStockDelivery(pending, normalizedMerchant)) {
      throw new Error("Expected a valid signed product stock delivery")
    }

    const deliveryKey = getOrderStockDecisionKey(
      pending.orderId,
      pending.adjustment.addressId
    )
    this.memoryDeliveries.set(`${normalizedMerchant}:${deliveryKey}`, pending)

    const storageKey = getDeliveryStorageKey(normalizedMerchant)
    if (!storageKey || !this.storage) return false
    try {
      const stored = parseStoredDeliveries(
        this.storage.getItem(storageKey),
        normalizedMerchant
      )
      stored.deliveries[deliveryKey] = pending
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
