import Dexie, { liveQuery, type EntityTable, type Table } from "dexie"
import { config } from "../config"
import type { ProductZapMessagePolicy } from "../schemas"
import type { SignedPublicNostrEvent } from "../protocol/signed-event"
import type { ProductSpecification } from "../types"
import type { WalletDescriptor, WalletProviderId } from "../wallets"

export interface StoredOrder {
  id: string
  buyerPubkey: string
  merchantPubkey: string
  items: Array<{
    productId: string
    familyProductId?: string
    selectedSpecifications?: ProductSpecification[]
    format?: "physical" | "digital"
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
  /** Typed provenance retained only for a validated pending order companion. */
  orderCompanion?: {
    orderId: string
    orderRumorId: string
  }
  kind: number
  createdAt: number
  read: 0 | 1
}

export interface CachedProduct {
  id: string
  pubkey: string
  dTag?: string
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
  type?: "simple" | "variable" | "variation"
  parentProductId?: string
  specifications?: Array<{ key: string; value: string }>
  format?: "physical" | "digital"
  shippingCostSats?: number
  sourceShippingCost?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
  shippingOptionId?: string
  shippingOptionDTag?: string
  /** Parsed evidence that the signed product used a launch-unsupported reference shape. */
  shippingOptionLaunchUnsupported?: boolean
  shippingCountries?: string[]
  shippingCountryRules?: Array<{
    code: string
    name: string
    restrictTo: string[]
    exclude: string[]
  }>
  visibility?: "public" | "private"
  stock?: number
  images: Array<{ url: string; alt?: string }>
  tags: string[]
  publicZapEnabled?: boolean
  zapMessagePolicy?: ProductZapMessagePolicy
  publicZapPolicyKnown?: boolean
  location?: string
  eventId?: string
  eventCreatedAt?: number
  createdAt?: number
  updatedAt?: number
  sourceRelayUrls?: string[]
  cachedAt: number
}

export interface CachedProductTombstone {
  id: string
  pubkey: string
  addressId?: string
  eventId?: string
  deletedAt: number
  deletionEventId: string
  signedEvent?: SignedPublicNostrEvent
  sourceRelayUrls?: string[]
  observedLocally?: boolean
  cachedAt: number
}

/**
 * Strongest validated kind-30406 revision(s) observed for one coordinate.
 * Equal-timestamp conflicts remain together so relay omission cannot turn an
 * ambiguous frontier into an older or arbitrarily selected payable option.
 */
export interface CachedShippingOptionFrontier {
  coordinate: string
  pubkey: string
  dTag: string
  strongestCreatedAt: number
  signedEvents: SignedPublicNostrEvent[]
  cachedAt: number
}

export type ProductDeletionRelayRole = "author_write" | "source" | "conduit"

export type ProductDeletionRelayDeliveryStatus =
  "pending" | "acked" | "rejected" | "timed_out"

export type ProductDeletionDeliveryState = "pending" | "partial" | "delivered"

export interface ProductDeletionRelayTarget {
  relayUrl: string
  roles: ProductDeletionRelayRole[]
}

export interface ProductDeletionRelayDelivery {
  relayUrl: string
  status: ProductDeletionRelayDeliveryStatus
  attemptCount: number
  lastAttemptAt?: number
  acknowledgedAt?: number
  rejectedAt?: number
  timedOutAt?: number
}

/**
 * Durable delivery state for one exact, already-signed NIP-09 deletion event.
 *
 * `relayPlan` is immutable after creation. Delivery attempts update only the
 * corresponding `relayDelivery` entry, allowing startup/background workers to
 * retry the same event without asking the signer to sign again.
 */
export interface ProductDeletionDeliveryJob {
  /** The signed deletion event id. */
  id: string
  signedEvent: SignedPublicNostrEvent
  relayPlan: ProductDeletionRelayTarget[]
  relayDelivery: ProductDeletionRelayDelivery[]
  state: ProductDeletionDeliveryState
  deliveryAttemptCount: number
  retryCount: number
  lastAttemptAt?: number
  nextRetryAt?: number
  /** Opaque local worker claim used to avoid duplicate cross-tab delivery. */
  deliveryLeaseOwner?: string
  /** Millisecond deadline after which another worker may recover the job. */
  deliveryLeaseExpiresAt?: number
  createdAt: number
  updatedAt: number
}

export interface CachedProfile {
  pubkey: string
  /** Exact newest observed kind-0 content, retained only for safe republish. */
  rawContent?: string
  eventId?: string
  eventCreatedAt?: number
  name?: string
  displayName?: string
  about?: string
  picture?: string
  banner?: string
  nip05?: string
  lud16?: string
  website?: string
  sourceRelayUrls?: string[]
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
  /** Event id used to resolve equal-timestamp replaceable events per NIP-01. */
  eventId?: string
  /** Relays the kind-10002 event was observed on, if known. */
  sourceRelayUrls?: string[]
  /** Local cache time in milliseconds. */
  cachedAt: number
}

/** A validated, lowercase 32-byte Nostr public key. */
declare const normalizedInboxDeclarationPubkeyBrand: unique symbol
export type NormalizedInboxDeclarationPubkey = string & {
  readonly [normalizedInboxDeclarationPubkeyBrand]: true
}

export type InboxDeclarationEvidenceState =
  "declared" | "signed_empty" | "malformed"

export type InboxDeclarationLookupCoverage =
  "complete" | "partial" | "unavailable"

/**
 * Most recent bounded declaration lookup for this account. This is stored
 * independently from the signed frontier so an incomplete or conflicting
 * observation cannot disappear after a process restart.
 */
export interface InboxDeclarationLookupEvidence {
  observedAt: number
  coverage: InboxDeclarationLookupCoverage
  /** True when the lookup returned an event, including unusable evidence. */
  hadEvent: boolean
  /** Valid signed event selected by that lookup, when one was available. */
  eventId?: string
}

interface InboxDeclarationEventEvidenceBase {
  state: InboxDeclarationEvidenceState
  /** Exact, signature-validated kind-10050 event observed from the network. */
  signedEvent: SignedPublicNostrEvent
  /** Secure normalized relay tags, preserving their signed event order. */
  secureRelayUrls: string[]
  /** Secure normalized relays on which this exact event was observed. */
  sourceRelayUrls: string[]
  /**
   * Shared discovery relays that returned this exact event. Optional for
   * records written before shared-source confirmation was persisted.
   */
  sharedSourceRelayUrls?: string[]
  /** Most recent local observation time in milliseconds. */
  observedAt: number
  /**
   * Most recent time a bounded discovery plan completed while this exact
   * event was the winning observed frontier. Partial reads never advance it.
   */
  completeObservedAt?: number
}

export interface DeclaredInboxDeclarationEventEvidence extends InboxDeclarationEventEvidenceBase {
  state: "declared"
}

export interface SignedEmptyInboxDeclarationEventEvidence extends InboxDeclarationEventEvidenceBase {
  state: "signed_empty"
  secureRelayUrls: []
}

export interface MalformedInboxDeclarationEventEvidence extends InboxDeclarationEventEvidenceBase {
  state: "malformed"
  secureRelayUrls: []
}

export type InboxDeclarationEventEvidence =
  | DeclaredInboxDeclarationEventEvidence
  | SignedEmptyInboxDeclarationEventEvidence
  | MalformedInboxDeclarationEventEvidence

/**
 * Exact signed declaration staged durably before its first network attempt.
 * The immutable publish plan lets a later process retry the same bytes without
 * asking the signer to create a second replaceable event.
 */
export interface PendingInboxDeclarationDistribution {
  signedEvent: SignedPublicNostrEvent
  publishRelayUrls: string[]
  stagedAt: number
}

/**
 * Account-scoped, monotonic NIP-17 inbox-declaration evidence.
 *
 * `current` follows the NIP-01 replaceable-event frontier. `lastUsable` keeps
 * the latest validated declaration when a newer signed empty or malformed
 * replacement becomes current, so reads can remain recoverable without
 * misrepresenting the current write route.
 */
export interface InboxDeclarationEvidenceRecord {
  pubkey: NormalizedInboxDeclarationPubkey
  current: InboxDeclarationEventEvidence
  lastUsable?: DeclaredInboxDeclarationEventEvidence
  pendingDistribution?: PendingInboxDeclarationDistribution
  latestLookup?: InboxDeclarationLookupEvidence
  cachedAt: number
}

/**
 * Strongest verified kind-3 snapshot observed for the authenticated owner.
 *
 * This public event is retained across relay-plan changes and restarts so a
 * later incomplete/omitting read cannot authorize an older replacement.
 * `pending` means the exact signed event may have reached a relay but no ACK
 * was observed; callers may retry that event but must not replace it.
 */
export interface CachedOwnContactListSnapshot {
  pubkey: string
  event: SignedPublicNostrEvent
  sourceRelayUrls: string[]
  state: "observed" | "pending"
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

export interface CachedNip05Verification {
  /** Stable cache key for this pubkey + normalized NIP-05 identifier. */
  id: string
  pubkey: string
  nip05: string
  normalizedIdentifier: string
  status: "valid" | "invalid" | "unknown"
  reason?: string
  checkedAt: number
  expiresAt: number
  cachedAt: number
}

export type CachedShopperTrustSignalState =
  "available" | "partial" | "stale" | "unavailable"

export interface CachedShopperTrustCoverage {
  attemptedRelays: number
  responsiveRelays: number
  transportComplete: boolean
  completeForPlan: boolean
  truncated: boolean
}

export interface CachedShopperTrustSignal<T> {
  state: CachedShopperTrustSignalState
  value: T | null
  observedAt?: number
  coverage: CachedShopperTrustCoverage
}

/**
 * Aggregate public evidence for one merchant/shopper pair.
 *
 * Raw follow graphs, report content, zap comments, invoices, descriptions,
 * and other event payloads must never be stored in this projection.
 */
export interface CachedShopperTrustSnapshot {
  id: string
  merchantPubkey: string
  shopperPubkey: string
  oldestEvent: CachedShopperTrustSignal<{ timestamp: number | null }>
  followersObserved: CachedShopperTrustSignal<{ count: number }>
  followsInCommon: CachedShopperTrustSignal<{ count: number }>
  zapsSent: CachedShopperTrustSignal<{ count: number }>
  zapsReceived: CachedShopperTrustSignal<{ count: number }>
  reportsFromNetwork: CachedShopperTrustSignal<{
    count: number
    reporterCount: number
  }>
  degraded: boolean
  cachedAt: number
}

export interface StoredPaymentAttempt {
  id: string
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
  amountMsats: number
  currency: "SATS"
  invoice?: string
  paymentHash?: string
  preimage?: string
  feeMsats?: number
  zapRequestId?: string
  zapReceiptId?: string
  proofDeliveryStatus: "pending" | "sent" | "retry_needed"
  createdAt: number
  updatedAt: number
}

export interface StoredWalletCredential {
  walletId: string
  providerId: WalletProviderId
  credential: string
  createdAt: number
  updatedAt: number
}

/** How the buyer initiated payment for this order. */
export type OrderCheckoutMode =
  | "anonymous_public_zap"
  | "public_zap_as_shopper"
  | "public_zap"
  | "private_checkout"
  | "pay_later"
  | "external_wallet"

export type OrderPublicZapSigner = "anon" | "shopper"

export type OrderBuyerIdentityKind = "signed_in" | "guest_ephemeral"

export interface OrderGuestContact {
  email: string
  phone: string
}

/**
 * Buyer-input address validity (CND-127). Distinct from
 * {@link OrderLifecycle.shippingZoneEligibility}, which is the merchant
 * fulfillment-coverage check.
 */
export type OrderAddressValidity =
  "not_required" | "valid" | "missing" | "inconsistent" | "unknown"

/** Merchant shipping-zone coverage for the destination. */
export type OrderShippingZoneEligibility =
  "not_required" | "eligible" | "ineligible" | "unknown"

export type OrderDeliveryStatus = "not_started" | "pending" | "sent" | "failed"

/**
 * Which write lane delivered the kind-16 order message (CND-208):
 * the recipient's declared NIP-17 inbox, or the temporary bounded
 * compatibility route used only while no usable declaration exists.
 */
export type OrderDeliveryRoute = "declared_inbox" | "compatibility_order"

export type OrderRelayDeliveryStatus =
  "pending" | "acked" | "rejected" | "timed_out"

export interface OrderRelayDelivery {
  relayUrl: string
  source: "declared" | "recipient_nip65" | "compatibility_registry"
  status: OrderRelayDeliveryStatus
  attemptCount: number
  lastAttemptAt?: number
  acknowledgedAt?: number
  rejectedAt?: number
  timedOutAt?: number
}

/**
 * Content-safe retry state for the exact signed recipient gift wrap. The
 * encrypted wrap may be replayed to failed targets without retaining rumor
 * plaintext, signer material, or relay failure strings.
 */
export interface OrderRelayDeliveryRecord {
  signedRecipientWrap: SignedPublicNostrEvent
  route: OrderDeliveryRoute
  relayDelivery: OrderRelayDelivery[]
  deliveryAttemptCount: number
  retryCount: number
  nextRetryAt?: number
  deliveryLeaseOwner?: string
  deliveryLeaseExpiresAt?: number
  createdAt: number
  updatedAt: number
  expiresAt: number
}

export type OrderInvoiceStatus =
  "not_requested" | "requesting" | "received" | "manual_required" | "failed"

export type OrderPaymentStatus =
  "not_started" | "paying" | "paid" | "manual_required" | "failed" | "ambiguous"

export type OrderProofDeliveryStatus =
  "not_started" | "pending" | "sent" | "retry_needed" | "failed"

export type OrderZapReceiptStatus =
  | "not_applicable"
  | "waiting"
  | "observed"
  | "receipt_not_observed"
  | "timed_out"

/** Coarse bucket used for Orders list filtering (All/Pending/In progress/...). */
export type OrderLifecyclePhase =
  "pending" | "in_progress" | "completed" | "failed" | "cancelled"

/**
 * The buyer-selected local payment target for this order.
 *
 * This is an opaque device-local routing choice. It MUST NOT be included in the
 * merchant order, payment proof, logs, or telemetry.
 */
export type OrderPaymentTarget =
  | {
      type: "wallet"
      walletId: string
      providerId: WalletProviderId
    }
  | { type: "webln" }
  | { type: "manual" }

export interface OrderLifecycleItem {
  productId: string
  familyProductId?: string
  selectedSpecifications?: ProductSpecification[]
  /** Local product-title snapshot for buyer order display. Public listing data. */
  title?: string
  /** Fulfillment type at purchase time. Missing legacy values require shipping. */
  format?: "physical" | "digital"
  quantity: number
  priceAtPurchase: number
  currency: string
  shippingCostSats?: number
  shippingOptionId?: string
  shippingOptionDTag?: string
  /** Signed listing shipping-rule snapshot used to guard payment retries. */
  shippingCountryRules?: Array<{
    code: string
    restrictTo: string[]
    exclude: string[]
  }>
  sourcePrice?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
}

/**
 * Durable buyer-side order lifecycle record (CND-122).
 *
 * Created at checkout *before* long async work so the Orders page can render an
 * active order immediately — before relay readback, before automatic payment
 * succeeds, and during manual/external-wallet payment. Relay-observed messages
 * enrich this record but are not required to display the order.
 *
 * Privacy: sensitive fields (invoice, preimage, shipping address, contact note)
 * stay local and MUST NOT be forwarded to telemetry.
 */
export interface OrderLifecycle {
  orderId: string
  buyerPubkey: string
  buyerIdentityKind?: OrderBuyerIdentityKind
  merchantPubkey: string
  checkoutMode: OrderCheckoutMode
  publicZapSigner?: OrderPublicZapSigner
  /** A public anon-zap attempt failed before invoice issuance and continued privately. */
  publicZapFallback?: boolean
  merchantLightningAddress?: string
  /** Local-only payment routing selection. Never forwarded off device. */
  paymentTarget?: OrderPaymentTarget
  /**
   * Stable opaque token for retries against the selected saved-wallet provider.
   *
   * This value is generated independently of `orderId`, stays device-local
   * except when passed to the selected provider as its idempotency key, and is
   * cleared when the buyer explicitly changes payment targets.
   */
  walletPaymentAttemptId?: string

  items: OrderLifecycleItem[]
  itemSubtotalSats: number
  shippingCostSats: number
  totalSats: number
  totalMsats: number
  currency: "SATS"
  pricingQuote?: {
    rate: number
    fetchedAt: number
    source: string
    fiatSource?: string
  }

  /**
   * Zap-request comment captured at checkout, replayed verbatim when a
   * route-independent payment retry re-requests the invoice (CND-122). Public
   * zap metadata, not PII; stays local and is not forwarded to telemetry.
   */
  zapContent?: string

  /** Local-only address + contact snapshot. Never sent to telemetry. */
  shippingAddress?: {
    name: string
    street: string
    city: string
    state?: string
    postalCode: string
    country: string
  }
  contactNote?: string
  guestContact?: OrderGuestContact

  addressValidity: OrderAddressValidity
  shippingZoneEligibility: OrderShippingZoneEligibility

  orderDeliveryStatus: OrderDeliveryStatus
  /** Write-lane provenance for the delivered order message (CND-208). */
  orderDeliveryRoute?: OrderDeliveryRoute
  /** Exact encrypted wrap + per-relay ACK state for bounded retry. */
  orderRelayDelivery?: OrderRelayDeliveryRecord
  /**
   * Opaque owner token for the currently claimed payment flow. The token fences
   * pre-wallet lifecycle writes so a resumed stale flow cannot cross the wallet
   * handoff after another document has recovered the order.
   */
  paymentClaimId?: string
  /** Wall-clock start for bounded stale-claim and legacy recovery. */
  paymentClaimedAt?: number
  /** Renewed while the owning document is alive; stale claims may recover. */
  paymentClaimLeaseExpiresAt?: number
  /** Opaque owner token for the current payment-proof publication attempt. */
  proofDeliveryClaimId?: string
  /** Wall-clock start for bounded stale proof-delivery recovery. */
  proofDeliveryClaimedAt?: number
  /** Renewed while proof publication is active; stale claims may recover. */
  proofDeliveryClaimLeaseExpiresAt?: number
  invoiceStatus: OrderInvoiceStatus
  paymentStatus: OrderPaymentStatus
  proofDeliveryStatus: OrderProofDeliveryStatus
  zapReceiptStatus: OrderZapReceiptStatus

  invoice?: string
  paymentHash?: string
  preimage?: string
  feeMsats?: number
  zapRequestId?: string
  zapRequestCreatedAt?: number
  zapReceiptId?: string
  zapReceiptRelayUrls?: string[]
  zapLnurl?: string
  zapReceiptPubkey?: string
  invoiceExpiresAt?: number
  zapReceiptObservationDeadline?: number

  /** Coarse bucket derived from the status fields above for list filtering. */
  phase: OrderLifecyclePhase
  lastError?: string
  deliveryNotice?: string

  createdAt: number
  updatedAt: number
  completedAt?: number
}

class ConduitDB extends Dexie {
  orders!: EntityTable<StoredOrder, "id">
  messages!: EntityTable<StoredMessage, "id">
  products!: EntityTable<CachedProduct, "id">
  productTombstones!: EntityTable<CachedProductTombstone, "id">
  shippingOptionFrontiers!: EntityTable<
    CachedShippingOptionFrontier,
    "coordinate"
  >
  profiles!: EntityTable<CachedProfile, "pubkey">
  orderMessages!: EntityTable<CachedOrderMessage, "id">
  relayLists!: EntityTable<CachedRelayList, "pubkey">
  productSocialSummaries!: EntityTable<CachedProductSocialSummary, "key">
  nip05Verifications!: EntityTable<CachedNip05Verification, "id">
  shopperTrustSnapshots!: EntityTable<CachedShopperTrustSnapshot, "id">
  paymentAttempts!: EntityTable<StoredPaymentAttempt, "id">
  orderLifecycles!: EntityTable<OrderLifecycle, "orderId">
  productDeletionOutbox!: EntityTable<ProductDeletionDeliveryJob, "id">
  inboxDeclarationEvidence!: EntityTable<
    InboxDeclarationEvidenceRecord,
    "pubkey"
  >
  ownContactListSnapshots!: EntityTable<CachedOwnContactListSnapshot, "pubkey">
  wallets!: EntityTable<WalletDescriptor, "id">
  walletCredentials!: EntityTable<StoredWalletCredential, "walletId">

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

    this.version(5).stores({
      orders: "id, buyerPubkey, merchantPubkey, status, createdAt",
      messages: "id, senderPubkey, recipientPubkey, kind, createdAt, read",
      products: "id, pubkey, *tags, cachedAt",
      profiles: "pubkey, cachedAt",
      orderMessages:
        "id, orderId, type, senderPubkey, recipientPubkey, createdAt",
      relayLists: "pubkey, cachedAt",
      productSocialSummaries: "key, cachedAt",
      paymentAttempts:
        "id, orderId, buyerPubkey, merchantPubkey, proofDeliveryStatus, createdAt",
    })

    this.version(6).stores({
      orders: "id, buyerPubkey, merchantPubkey, status, createdAt",
      messages: "id, senderPubkey, recipientPubkey, kind, createdAt, read",
      products: "id, pubkey, *tags, cachedAt",
      profiles: "pubkey, cachedAt",
      orderMessages:
        "id, orderId, type, senderPubkey, recipientPubkey, createdAt",
      relayLists: "pubkey, cachedAt",
      productSocialSummaries: "key, cachedAt",
      nip05Verifications:
        "id, pubkey, normalizedIdentifier, status, expiresAt, cachedAt",
      paymentAttempts:
        "id, orderId, buyerPubkey, merchantPubkey, proofDeliveryStatus, createdAt",
    })

    this.version(7).stores({
      orders: "id, buyerPubkey, merchantPubkey, status, createdAt",
      messages: "id, senderPubkey, recipientPubkey, kind, createdAt, read",
      products: "id, pubkey, *tags, cachedAt",
      profiles: "pubkey, cachedAt",
      orderMessages:
        "id, orderId, type, senderPubkey, recipientPubkey, createdAt",
      relayLists: "pubkey, cachedAt",
      productSocialSummaries: "key, cachedAt",
      nip05Verifications:
        "id, pubkey, normalizedIdentifier, status, expiresAt, cachedAt",
      paymentAttempts:
        "id, orderId, buyerPubkey, merchantPubkey, proofDeliveryStatus, createdAt",
      orderLifecycles:
        "orderId, buyerPubkey, merchantPubkey, phase, updatedAt, createdAt",
    })

    this.version(8).stores({
      orders: "id, buyerPubkey, merchantPubkey, status, createdAt",
      messages: "id, senderPubkey, recipientPubkey, kind, createdAt, read",
      products: "id, pubkey, *tags, cachedAt",
      productTombstones: "id, pubkey, addressId, eventId, deletedAt, cachedAt",
      profiles: "pubkey, cachedAt",
      orderMessages:
        "id, orderId, type, senderPubkey, recipientPubkey, createdAt",
      relayLists: "pubkey, cachedAt",
      productSocialSummaries: "key, cachedAt",
      nip05Verifications:
        "id, pubkey, normalizedIdentifier, status, expiresAt, cachedAt",
      paymentAttempts:
        "id, orderId, buyerPubkey, merchantPubkey, proofDeliveryStatus, createdAt",
      orderLifecycles:
        "orderId, buyerPubkey, merchantPubkey, phase, updatedAt, createdAt",
    })

    this.version(9).stores({
      orders: "id, buyerPubkey, merchantPubkey, status, createdAt",
      messages: "id, senderPubkey, recipientPubkey, kind, createdAt, read",
      products: "id, pubkey, *tags, cachedAt",
      productTombstones: "id, pubkey, addressId, eventId, deletedAt, cachedAt",
      profiles: "pubkey, cachedAt",
      orderMessages:
        "id, orderId, type, senderPubkey, recipientPubkey, createdAt",
      relayLists: "pubkey, cachedAt",
      productSocialSummaries: "key, cachedAt",
      nip05Verifications:
        "id, pubkey, normalizedIdentifier, status, expiresAt, cachedAt",
      paymentAttempts:
        "id, orderId, buyerPubkey, merchantPubkey, proofDeliveryStatus, createdAt",
      orderLifecycles:
        "orderId, buyerPubkey, merchantPubkey, phase, updatedAt, createdAt",
      // Version 9 shipped independently on main and the shopper-trust preview.
      // Keep the union here so Dexie does not delete either lineage's store
      // before version 10 converges both schemas.
      shopperTrustSnapshots: "id, merchantPubkey, shopperPubkey, cachedAt",
      productDeletionOutbox:
        "id, state, nextRetryAt, deliveryLeaseExpiresAt, updatedAt, createdAt",
    })

    this.version(10).stores({
      shopperTrustSnapshots: "id, merchantPubkey, shopperPubkey, cachedAt",
      productDeletionOutbox:
        "id, state, nextRetryAt, deliveryLeaseExpiresAt, updatedAt, createdAt",
    })

    this.version(11).stores({
      // Public signed declaration evidence is monotonic protocol state. It is
      // intentionally excluded from relay-scope clearing and cache pruning.
      inboxDeclarationEvidence: "pubkey, cachedAt",
    })

    this.version(12).stores({
      ownContactListSnapshots: "pubkey, state, cachedAt",
    })

    this.version(13).stores({
      wallets: "id",
      walletCredentials: "walletId",
    })

    this.version(14).stores({
      // Signed positive protocol evidence is retained independently from the
      // relay-scoped product cache and monotonic deletion tombstones.
      shippingOptionFrontiers:
        "coordinate, pubkey, dTag, strongestCreatedAt, cachedAt",
    })
  }
}

export const db = new ConduitDB()

/**
 * Observe committed wallet descriptor mutations in this document and other
 * browser contexts. The listener reloads the complete wallet state so runtime
 * provider state remains owned by the Market wallet hook.
 */
export function subscribeToWalletDescriptorChanges(observer: {
  onChange(): void
  onError(error: unknown): void
}): () => void {
  const subscription = liveQuery(() => db.wallets.toArray()).subscribe({
    next: () => observer.onChange(),
    error: (error) => observer.onError(error),
  })
  return () => subscription.unsubscribe()
}

const CACHE_SCOPE_KEY = "conduit:commerce-cache-scope:v1"
const FALLBACK_CACHE_PRUNE_HIGH_WATER_BYTES = 35 * 1024 * 1024
const FALLBACK_CACHE_PRUNE_TARGET_BYTES = 24 * 1024 * 1024
const CACHE_PRUNE_FRESH_MS = 24 * 60 * 60 * 1_000
const STORAGE_PRESSURE_HIGH_WATER_RATIO = 0.7
export const SHOPPER_TRUST_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
export const SHOPPER_TRUST_SNAPSHOT_MAX_ROWS = 500

function getCommerceCacheScope(): string {
  return JSON.stringify({
    lightningNetwork: config.lightningNetwork,
    relayUrl: config.relayUrl,
    defaultRelays: config.defaultRelays,
    commerceRelayUrls: config.commerceRelayUrls,
    publicRelayUrls: config.publicRelayUrls,
    corePublicFallbackRelayUrls: config.corePublicFallbackRelayUrls,
    commerceDiscoveryRelayUrls: config.commerceDiscoveryRelayUrls,
    searchIndexRelayUrls: config.searchIndexRelayUrls,
    dmDeclarationDiscoveryRelayUrls: config.dmDeclarationDiscoveryRelayUrls,
    commerceDmFallbackRelayUrls: config.commerceDmFallbackRelayUrls,
    dmInboxDefaultRelayUrls: config.dmInboxDefaultRelayUrls,
    dmCompatibilityOrderRelayUrls: config.dmCompatibilityOrderRelayUrls,
    zapRelayUrls: config.zapRelayUrls,
  })
}

export async function ensureCommerceCacheScope(): Promise<void> {
  if (typeof window === "undefined") return

  const nextScope = getCommerceCacheScope()
  const currentScope = window.localStorage.getItem(CACHE_SCOPE_KEY)

  if (currentScope === nextScope) return

  await Promise.all([
    db.products.clear(),
    // Signed tombstones are monotonic protocol evidence, not a relay-scoped
    // cache. Keep them across relay/config scope changes so a later omission
    // cannot resurrect a product that was already observed as deleted.
    // Shipping option frontiers are likewise intentionally absent here: a
    // relay/config change cannot erase a previously observed stronger price.
    db.profiles.clear(),
    db.orderMessages.clear(),
    db.relayLists.clear(),
    db.productSocialSummaries.clear(),
    db.nip05Verifications.clear(),
    db.shopperTrustSnapshots.clear(),
  ])

  window.localStorage.setItem(CACHE_SCOPE_KEY, nextScope)
}

async function pruneTableByCachedAt(
  table: Table,
  options: {
    estimatedRowBytes: number
    highWaterBytes: number
    targetBytes: number
    freshMs: number
  }
): Promise<void> {
  const count = await table.count()
  const estimatedBytes = count * options.estimatedRowBytes
  if (estimatedBytes <= options.highWaterBytes) return

  const targetRowCount = Math.ceil(
    options.targetBytes / options.estimatedRowBytes
  )
  const deleteCount = Math.max(0, count - targetRowCount)
  if (deleteCount === 0) return

  const staleBefore = Date.now() - options.freshMs
  const staleRows = await table
    .orderBy("cachedAt")
    .filter((row) => {
      const cachedAt = (row as { cachedAt?: unknown }).cachedAt
      return typeof cachedAt === "number" && cachedAt < staleBefore
    })
    .limit(deleteCount)
    .primaryKeys()
  if (staleRows.length === 0) return
  await table.bulkDelete(staleRows)
}

export function shopperTrustSnapshotIsExpired(
  cachedAt: number,
  now = Date.now()
): boolean {
  return now - cachedAt > SHOPPER_TRUST_SNAPSHOT_RETENTION_MS
}

/**
 * Pairwise trust projections are privacy-sensitive convenience data. Enforce
 * a hard age and count bound independently of browser storage pressure.
 */
export async function pruneShopperTrustSnapshots(
  now = Date.now()
): Promise<void> {
  if (typeof window === "undefined") return

  const staleBefore = now - SHOPPER_TRUST_SNAPSHOT_RETENTION_MS
  await db.shopperTrustSnapshots.where("cachedAt").below(staleBefore).delete()

  const count = await db.shopperTrustSnapshots.count()
  const overflow = count - SHOPPER_TRUST_SNAPSHOT_MAX_ROWS
  if (overflow <= 0) return
  const oldestKeys = await db.shopperTrustSnapshots
    .orderBy("cachedAt")
    .limit(overflow)
    .primaryKeys()
  await db.shopperTrustSnapshots.bulkDelete(oldestKeys)
}

export async function pruneCommerceCaches(): Promise<void> {
  if (typeof window === "undefined") return

  await pruneShopperTrustSnapshots()

  const storageEstimate =
    typeof navigator !== "undefined" && navigator.storage?.estimate
      ? await navigator.storage.estimate()
      : undefined
  const storageUsage = storageEstimate?.usage
  const storageQuota = storageEstimate?.quota

  // Product cache pruning should protect the browser, not define catalog truth.
  // When the browser exposes quota telemetry, only prune under real storage
  // pressure; otherwise fall back to a conservative per-table byte estimate.
  if (
    typeof storageUsage === "number" &&
    typeof storageQuota === "number" &&
    storageQuota > 0 &&
    storageUsage / storageQuota < STORAGE_PRESSURE_HIGH_WATER_RATIO
  ) {
    return
  }

  await Promise.all([
    pruneTableByCachedAt(db.products, {
      estimatedRowBytes: 2_500,
      highWaterBytes: FALLBACK_CACHE_PRUNE_HIGH_WATER_BYTES,
      targetBytes: FALLBACK_CACHE_PRUNE_TARGET_BYTES,
      freshMs: CACHE_PRUNE_FRESH_MS,
    }),
    pruneTableByCachedAt(db.relayLists, {
      estimatedRowBytes: 900,
      highWaterBytes: FALLBACK_CACHE_PRUNE_HIGH_WATER_BYTES,
      targetBytes: FALLBACK_CACHE_PRUNE_TARGET_BYTES,
      freshMs: CACHE_PRUNE_FRESH_MS,
    }),
    pruneTableByCachedAt(db.productSocialSummaries, {
      estimatedRowBytes: 500,
      highWaterBytes: FALLBACK_CACHE_PRUNE_HIGH_WATER_BYTES,
      targetBytes: FALLBACK_CACHE_PRUNE_TARGET_BYTES,
      freshMs: CACHE_PRUNE_FRESH_MS,
    }),
    pruneTableByCachedAt(db.nip05Verifications, {
      estimatedRowBytes: 300,
      highWaterBytes: FALLBACK_CACHE_PRUNE_HIGH_WATER_BYTES,
      targetBytes: FALLBACK_CACHE_PRUNE_TARGET_BYTES,
      freshMs: CACHE_PRUNE_FRESH_MS,
    }),
  ])
}
