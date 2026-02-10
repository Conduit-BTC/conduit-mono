import Dexie, { type EntityTable } from "dexie"

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
  images: Array<{ url: string; alt?: string }>
  tags: string[]
  cachedAt: number
}

export interface CachedProfile {
  pubkey: string
  name?: string
  displayName?: string
  about?: string
  picture?: string
  nip05?: string
  lud16?: string
  cachedAt: number
}

class ConduitDB extends Dexie {
  orders!: EntityTable<StoredOrder, "id">
  messages!: EntityTable<StoredMessage, "id">
  products!: EntityTable<CachedProduct, "id">
  profiles!: EntityTable<CachedProfile, "pubkey">

  constructor() {
    super("conduit")

    this.version(1).stores({
      orders: "id, buyerPubkey, merchantPubkey, status, createdAt",
      messages: "id, senderPubkey, recipientPubkey, kind, createdAt, read",
      products: "id, pubkey, *tags, cachedAt",
      profiles: "pubkey, cachedAt",
    })
  }
}

export const db = new ConduitDB()
