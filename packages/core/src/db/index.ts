import Dexie, { type EntityTable } from "dexie"
import { config } from "../config"

export interface StoredOrder {
  id: string
  buyerPubkey: string
  merchantPubkey: string
  items: Array<{
    productId: string
    quantity: number
    priceAtPurchase: number
    currency: string
  }>
  status: string
  shippingAddress?: {
    name: string
    street: string
    city: string
    state?: string
    postalCode: string
    country: string
  }
  invoice?: string
  paidAt?: number
  createdAt: number
  updatedAt: number
}

export interface StoredMessage {
  id: string
  senderPubkey: string
  recipientPubkey: string
  content: string
  decrypted?: string
  kind: number
  createdAt: number
  read: 0 | 1
}

export interface CachedProduct {
  id: string
  pubkey: string
  title: string
  summary?: string
  price: number
  currency: string
  type?: "simple" | "variable"
  visibility?: "public" | "private"
  stock?: number
  images: Array<{ url: string; alt?: string }>
  tags: string[]
  location?: string
  createdAt?: number
  updatedAt?: number
  cachedAt: number
}

export interface CachedProfile {
  pubkey: string
  name?: string
  displayName?: string
  about?: string
  picture?: string
  banner?: string
  nip05?: string
  lud16?: string
  website?: string
  cachedAt: number
}

export interface CachedOrderMessage {
  id: string
  orderId: string
  type: string
  senderPubkey: string
  recipientPubkey: string
  createdAt: number
  rawContent: string
  cachedAt: number
}

/**
 * NIP-65 relay list cache entry for an arbitrary pubkey.
 *
 * Used by the relay planner to route reads at an author's write relays
 * and writes at a recipient's read/inbox relays. Distinct from the
 * local user's relay-settings preferences (`RelaySettingsState`), which
 * describe what the user has configured rather than what is observed
 * for other pubkeys.
 */
export interface CachedRelayList {
  pubkey: string
  /** Relays the pubkey reads from (NIP-65 marker `read` or unmarked). */
  readRelayUrls: string[]
  /** Relays the pubkey writes to (NIP-65 marker `write` or unmarked). */
  writeRelayUrls: string[]
  /** `created_at` of the kind-10002 event in seconds. */
  eventCreatedAt: number
  /** Relays the kind-10002 event was observed on, if known. */
  sourceRelayUrls?: string[]
  /** Local cache time in milliseconds. */
  cachedAt: number
}

/**
 * Aggregate social signals for a product, keyed by the product's
 * coordinate (NIP-33 `kind:pubkey:d-tag`) or event id when available.
 *
 * This is a scaffold cache: counters are filled in by the social
 * hydrator over time and consumed by product card surfaces. UI must
 * treat any field as optional/stale until `cachedAt` is recent.
 */
export interface CachedProductSocialSummary {
  /** `kind:pubkey:d-tag` coordinate or event id. */
  key: string
  /** Number of distinct reaction (kind 7) events seen. */
  reactionCount?: number
  /** Number of distinct zap receipts (kind 9735) seen. */
  zapCount?: number
  /** Sum of zap receipts in millisats, when payable. */
  zapAmountMsats?: number
  /** Number of distinct comment (kind 1111) events seen. */
  commentCount?: number
  /** Number of distinct reviews (NIP-25 / merchant feedback) seen. */
  reviewCount?: number
  /** Local cache time in ms. */
  cachedAt: number
  /** Last verified-fresh timestamp in ms. */
  verifiedAt?: number
}

class ConduitDB extends Dexie {
  orders!: EntityTable<StoredOrder, "id">
  messages!: EntityTable<StoredMessage, "id">
  products!: EntityTable<CachedProduct, "id">
  profiles!: EntityTable<CachedProfile, "pubkey">
  orderMessages!: EntityTable<CachedOrderMessage, "id">
  relayLists!: EntityTable<CachedRelayList, "pubkey">
  productSocialSummaries!: EntityTable<CachedProductSocialSummary, "key">

  constructor() {
    super("conduit")

    this.version(1).stores({
      orders: "id, buyerPubkey, merchantPubkey, status, createdAt",
      messages: "id, senderPubkey, recipientPubkey, kind, createdAt, read",
      products: "id, pubkey, *tags, cachedAt",
      profiles: "pubkey, cachedAt",
    })

    this.version(2).stores({
      orders: "id, buyerPubkey, merchantPubkey, status, createdAt",
      messages: "id, senderPubkey, recipientPubkey, kind, createdAt, read",
      products: "id, pubkey, *tags, cachedAt",
      profiles: "pubkey, cachedAt",
      orderMessages:
        "id, orderId, type, senderPubkey, recipientPubkey, createdAt",
    })

    this.version(3).stores({
      orders: "id, buyerPubkey, merchantPubkey, status, createdAt",
      messages: "id, senderPubkey, recipientPubkey, kind, createdAt, read",
      products: "id, pubkey, *tags, cachedAt",
      profiles: "pubkey, cachedAt",
      orderMessages:
        "id, orderId, type, senderPubkey, recipientPubkey, createdAt",
      relayLists: "pubkey, cachedAt",
    })

    this.version(4).stores({
      orders: "id, buyerPubkey, merchantPubkey, status, createdAt",
      messages: "id, senderPubkey, recipientPubkey, kind, createdAt, read",
      products: "id, pubkey, *tags, cachedAt",
      profiles: "pubkey, cachedAt",
      orderMessages:
        "id, orderId, type, senderPubkey, recipientPubkey, createdAt",
      relayLists: "pubkey, cachedAt",
      productSocialSummaries: "key, cachedAt",
    })
  }
}

export const db = new ConduitDB()

const CACHE_SCOPE_KEY = "conduit:commerce-cache-scope:v1"

function getCommerceCacheScope(): string {
  return JSON.stringify({
    lightningNetwork: config.lightningNetwork,
    relayUrl: config.relayUrl,
    defaultRelays: config.defaultRelays,
    commerceRelayUrls: config.commerceRelayUrls,
    publicRelayUrls: config.publicRelayUrls,
  })
}

export async function ensureCommerceCacheScope(): Promise<void> {
  if (typeof window === "undefined") return

  const nextScope = getCommerceCacheScope()
  const currentScope = window.localStorage.getItem(CACHE_SCOPE_KEY)

  if (currentScope === nextScope) return

  await Promise.all([
    db.products.clear(),
    db.profiles.clear(),
    db.orderMessages.clear(),
    db.relayLists.clear(),
    db.productSocialSummaries.clear(),
  ])

  window.localStorage.setItem(CACHE_SCOPE_KEY, nextScope)
}
