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
  priceSats?: number
  sourcePrice?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
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
  sourcePrice?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
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
