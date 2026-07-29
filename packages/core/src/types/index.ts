import type { KnownOrderStatus, ProductZapMessagePolicy } from "../schemas"

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
  type: "simple" | "variable" | "variation"
  /** Whether the product requires physical shipping. Defaults to "physical". */
  format: "physical" | "digital"
  /** Per-item shipping cost in sats. Omitted means shipping is coordinated manually. */
  shippingCostSats?: number
  sourceShippingCost?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
  /** Selected/read-compatible kind-30406 reference. */
  shippingOptionId?: string
  shippingOptionDTag?: string
  /** All addressable kind-30406 options referenced by the product listing. */
  shippingOptionIds?: string[]
  shippingOptionDTags?: string[]
  /** True when the product reference uses a launch-unsupported Gamma shape. */
  shippingOptionLaunchUnsupported?: boolean
  /** Read-side shipping details. Canonical checkout requires explicit resolution. */
  shippingCountries?: string[]
  shippingCountryRules?: Array<{
    code: string
    name: string
    restrictTo: string[]
    exclude: string[]
  }>
  /** Resolved read-side zone options before a buyer destination is selected. */
  shippingZones?: Array<{
    shippingOptionId: string
    shippingOptionDTag: string
    amount: number
    currency: string
    countries: string[]
  }>
  /** True only after exact kind-30406 resolution prepared this product. */
  canonicalShippingResolved?: boolean
  /** Timestamp of the exact resolved kind-30406 revision. */
  shippingOptionCreatedAt?: number
  visibility: "public" | "private"
  stock?: number
  images: ProductImage[]
  tags: string[]
  publicZapEnabled: boolean
  zapMessagePolicy: ProductZapMessagePolicy
  publicZapPolicyKnown: boolean
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
export type OrderStatus = KnownOrderStatus

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
  format: "physical" | "digital"
  quantity: number
  priceAtPurchase: number
  currency: string
  shippingCostSats?: number
  sourceShippingCost?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
  shippingOptionId?: string
  shippingOptionDTag?: string
  shippingCountries?: string[]
  shippingCountryRules?: Array<{
    code: string
    name: string
    restrictTo: string[]
    exclude: string[]
  }>
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
