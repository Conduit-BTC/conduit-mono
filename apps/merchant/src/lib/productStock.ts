import type { CommerceProductRecord } from "@conduit/core"

export const LOW_STOCK_THRESHOLD = 5

const STOCK_DECISION_STORAGE_PREFIX =
  "conduit:merchant:order-stock-decisions:v1"
const MAX_STORED_STOCK_DECISIONS = 500

export type ProductStockDecisionKind = "applied" | "declined"

export interface ProductStockDecision {
  kind: ProductStockDecisionKind
  decidedAt: number
}

interface StoredProductStockDecisions {
  version: 1
  decisions: Record<string, ProductStockDecision>
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
