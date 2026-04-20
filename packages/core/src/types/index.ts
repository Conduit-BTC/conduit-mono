// Nostr primitives
export type Pubkey = string
export type EventId = string
export type Signature = string

// Product types
export interface Product {
  id: string
  pubkey: Pubkey
  title: string
  summary?: string
  price: number
  currency: string
  type: "simple" | "variable"
  visibility: "public" | "private"
  stock?: number
  images: ProductImage[]
  tags: string[]
  location?: string
  createdAt: number
  updatedAt: number
}

export interface ProductImage {
  url: string
  alt?: string
}

// Profile types
export interface Profile {
  pubkey: Pubkey
  name?: string
  displayName?: string
  about?: string
  picture?: string
  banner?: string
  nip05?: string
  lud16?: string
  website?: string
}

// Order types
export type OrderStatus =
  | "pending"
  | "paid"
  | "accepted"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refund_requested"

export interface Order {
  id: string
  buyerPubkey: Pubkey
  merchantPubkey: Pubkey
  items: OrderItem[]
  status: OrderStatus
  shippingAddress?: ShippingAddress
  invoice?: string
  paidAt?: number
  createdAt: number
  updatedAt: number
}

export interface OrderItem {
  productId: string
  quantity: number
  priceAtPurchase: number
  currency: string
}

export interface ShippingAddress {
  name: string
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

// Relay types

/**
 * Relay role within the Conduit commerce architecture.
 *
 * - `merchant`: merchant-controlled source-of-truth relay (Scope 1)
 * - `commerce`: de-commerce relay for acceleration and routing (Scope 2 / L2)
 * - `general`: broader Nostr network relays for reach and fallback
 */
export type RelayRole = "merchant" | "commerce" | "general"

export type RelaySource = "app" | "signer" | "custom"

export type RelayPurpose = "out" | "in" | "find" | "dm"

/**
 * A single relay entry with its URL, role, and read/write capabilities.
 */
export interface RelayEntry {
  url: string
  role: RelayRole
  source: RelaySource
  out: boolean
  in: boolean
  find: boolean
  dm: boolean
}

/**
 * Relay entries grouped by role for display in settings UX.
 *
 * - Merchant clients see all three groups.
 * - Market / shopper clients see `commerce` and `general` only.
 */
export interface RelayGroups {
  merchant: RelayEntry[]
  commerce: RelayEntry[]
  general: RelayEntry[]
}

export interface RelayOverrideState {
  out?: boolean
  in?: boolean
  find?: boolean
  dm?: boolean
  hidden?: boolean
}

export interface RelayOverrides {
  custom: RelayGroups
  states: Record<RelayRole, Record<string, RelayOverrideState>>
}

/**
 * Actor type that determines which relay groups are visible in settings.
 */
export type RelayActor = "merchant" | "shopper"

/** @deprecated Use RelayEntry instead */
export interface RelayConfig {
  url: string
  read: boolean
  write: boolean
}

// Shipping types
export interface ShippingOption {
  id: string
  name: string
  price: number
  currency: string
  estimatedDays?: string
  regions: string[]
}
