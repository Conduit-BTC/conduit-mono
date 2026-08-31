import type {
  KnownOrderStatus,
  OrderItemFulfillmentSchema,
  ProductShippingOptionReference,
  ProductZapMessagePolicy,
} from "../schemas"

// Nostr primitives
export type Pubkey = string
export type EventId = string
export type Signature = string

// Product types
export interface ProductSpecification {
  key: string
  value: string
}

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
  /** Signed kind-30402 price-tag evidence was missing or malformed. */
  priceEvidenceMalformed?: true
  type: "simple" | "variable" | "variation"
  /** Full kind-30402 coordinate of this variation's variable parent. */
  parentProductId?: string
  /** Open Markets `spec` tags preserved in signed-event order. */
  specifications: ProductSpecification[]
  /** Whether the product requires physical shipping. Defaults to "physical". */
  format: "physical" | "digital"
  /** Per-item shipping cost in sats. Omitted means shipping is coordinated manually. */
  shippingCostSats?: number
  sourceShippingCost?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
  /** Selected/read-compatible kind-30406 shipping option reference. */
  shippingOptionId?: string
  shippingOptionDTag?: string
  /** All exact kind-30406 options referenced by the product. */
  shippingOptionIds?: string[]
  shippingOptionDTags?: string[]
  /** True when the product reference uses a launch-unsupported Gamma shape. */
  shippingOptionLaunchUnsupported?: boolean
  /** Repeated Gamma shipping_option references in signed tag order. */
  shippingOptionRefs?: ProductShippingOptionReference[]
  /** Repeated kind-30405 collection references in signed tag order. */
  collectionRefs?: string[]
  /** Read-side shipping details. Canonical checkout requires explicit resolution. */
  shippingCountries?: string[]
  shippingCountryRules?: Array<{
    code: string
    name: string
    restrictTo: string[]
    exclude: string[]
    includeCountry?: boolean
    includeSubdivisions?: string[]
    excludeSubdivisions?: string[]
    excludeCountry?: boolean
  }>
  /** Resolved option policies before a buyer destination selects one rate. */
  shippingZones?: Array<{
    shippingOptionId: string
    shippingOptionDTag: string
    amount: number
    currency: string
    countries: string[]
    countryRules: NonNullable<Product["shippingCountryRules"]>
    destinationSchema?: string
    /** Preserves the original single-option coordinate during edit round trips. */
    usesProductFallback?: boolean
    /** Relays that returned or acknowledged this exact option coordinate. */
    sourceRelayUrls?: string[]
  }>
  /** True only after exact kind-30406 resolution prepared this product. */
  canonicalShippingResolved?: boolean
  /** Timestamp of the newest exact resolved kind-30406 revision. */
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
  familyProductId?: string
  selectedSpecifications?: ProductSpecification[]
  format: "physical" | "digital"
  fulfillment?: OrderItemFulfillmentSchema
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
    includeCountry?: boolean
    includeSubdivisions?: string[]
    excludeSubdivisions?: string[]
    excludeCountry?: boolean
  }>
  shippingDestinationSchema?: string
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
