import {
  getPublicFeedReadPlan,
  type PublicReadScope,
} from "./public-feed-read-scope"
import {
  BROAD_AUTHOR_HINT_LIMIT,
  planCommerceReadRelayPlan,
  __setCommerceRelayPlanningTestOverrides,
  __resetCommerceRelayPlanningTestOverrides,
  type CommerceReadRelayPlan,
} from "./commerce-read-relay-plan"
export { planLegacyDirectMessageRead } from "./commerce-read-relay-plan"
import {
  buildBuyerConversationSummaries,
  buildMerchantConversationSummaries,
  buildDirectConversationSummaries,
  counterpartyOf,
} from "./commerce-conversation-projections"
import { getProfiles as readProfiles } from "./commerce-profile-reads"
import {
  getMerchantStorefront as readMerchantStorefront,
  getProductDetail as readProductDetail,
  getCachedProductDetail as readCachedProductDetail,
  getCachedProductsByIds as readCachedProductsByIds,
  type ProductDetailReadDependencies,
  getCachedMerchantStorefront as readCachedMerchantStorefront,
  type StorefrontReadDependencies,
  getMarketplaceProducts as readMarketplaceProducts,
  getMarketplaceProductsProgressive as readMarketplaceProductsProgressive,
  getCachedMarketplaceProducts as readCachedMarketplaceProducts,
  type MarketplaceReadDependencies,
} from "./commerce-product-reads"
import { groupOrderConversationMessages } from "./order-conversation"
import {
  cachedDirectMessageRow,
  parseCachedDirectMessage,
} from "./cached-direct-message"
import type { Filter } from "nostr-tools"
import {
  getCommerceInbox as getDefaultCommerceInbox,
  type CommerceInbox,
  type CommerceInboxSnapshot,
} from "./commerce-inbox"
import type { NostrKeySigner } from "./nostr-event-signer"
import { getAccountSigner } from "./session-signer"
import type { CachedOrderMessage, CachedProfile, StoredMessage } from "../db"
import { config } from "../config"
import {
  configuredRelayTargets,
  filterEligibleAccountRelayTargets,
} from "./account-network-local-state"
import {
  mergeRelayTargets,
  relayTargetsFromUrls,
  type RelayTarget,
} from "./relay-authority"
import type { Profile } from "../types"
import {
  filterExactProductRecordsForRead as selectExactProductRecordsForRead,
  reconcileProductRecordsWithRevisions as reconcileSelectedProductRevisions,
  reconcileProductRecordsWithDeletions as reconcileSelectedProductDeletions,
  withProductFamilyReadEvidence,
  mergeProductRecordSources,
  getVariationParentAddress,
  selectLatestProductRecordsByAddress,
  hasCompleteLiveVariationGroupCoverage,
  parseAddress,
  getProductLookupIds,
  type CommerceProductRecord,
} from "./commerce-product-selection"
export { hasMarketProductImage } from "./commerce-product-selection"
import {
  __setProductCacheTestOverrides,
  __resetProductCacheTestOverrides,
  getCachedExactProductRecords,
  getLocalProductDeletionTimestamps,
  getLocalProductDeletionSnapshot,
  cacheProductRecords,
  dedupeProductEvents,
  filterDeletedProductRecords,
  isRecordDeletedByNip09,
  mergeDeletionTimestamps,
  retainObservedProductDeletions,
  type CachedProductReadOptions,
  type DeletionTimestamps,
  type ProductCacheTestOverrides,
} from "./commerce-product-cache"
export {
  cacheSignedProductListingEvent,
  cacheSignedProductDeletionEvent,
  projectSignedProductListingForLocalCommit,
  projectSignedProductDeletionForLocalCommit,
  subscribeLocalProductRevisionChanges,
  subscribeLocalProductDeletionChanges,
  getLocalProductDeletionSnapshot,
} from "./commerce-product-cache"
import {
  inspectCheckoutSparkRecoveryWrap,
  openCheckoutSparkRecoveryWrap,
  type CheckoutSparkRecoveryPayload,
  type CheckoutSparkSettledRecoveryPayload,
  type CheckoutSparkSettledRecoveryProgressPayload,
} from "./checkout-spark-recovery"
import {
  openCheckoutSparkMerchantProgressWrap,
  type CheckoutSparkMerchantProgressPayload,
} from "./checkout-spark-merchant-progress"
import {
  selectCheckoutSparkMerchantProgress,
  type CheckoutSparkMerchantProgressSelectionEntry,
} from "./checkout-spark-merchant-progress-selection"
import { openCheckoutSparkOrganizerExecutionProgress } from "./checkout-spark-organizer-progress"
import {
  selectCheckoutSparkOrganizerProgressForMerchant,
  type CheckoutSparkRecoveryActorProgress,
} from "./checkout-spark-recovery-actor-progress"
import { EVENT_KINDS } from "./kinds"
import {
  createCheckoutSparkMerchantOrderWitness,
  type CheckoutSparkMerchantOrderEvidence,
  type CheckoutSparkMerchantOrderWitness,
} from "./checkout-spark-merchant-order-witness"
import type {
  CheckoutSparkSettledPlan,
  CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import {
  canonicalizeCheckoutSparkPlanSourceEvents,
  getCheckoutSparkPlanSourceReferences,
  validateCheckoutSparkPlanSources,
} from "./checkout-spark-plan-sources"
import { DexieCheckoutSparkSettledRepository } from "./checkout-spark-settled-router-repository"
import { NostrSignerError } from "./nostr-event-signer"
import {
  extractFollowPubkeys,
  isPlausibleFollowListEventTimestamp,
  readLatestFollowLists,
  type FollowListAuthorRead,
  type FollowListCoverageState,
} from "./follows"
import {
  verifySignedEventBatches,
  fetchPublicEvents,
  fetchSignedEventsFanoutDetailed,
  fetchPublicEventsProgressive,
  fetchPublicEventsWithDiagnostics,
  getEventSourceRelayUrls,
  mergeEventSourceRelayUrls,
} from "./relay-reader"
import type { OwnerRelayListEvidenceRepository } from "./owner-relay-list-evidence"
import {
  planInboxReadRelays,
  resolveInboxDeclaration,
  type InboxDeclarationResolution,
  type InboxDeclarationState,
  type InboxReadCoverage,
  type InboxReadSource,
} from "./private-message-routing"
import {
  parseOrderMessageRumorEvent,
  type ParsedEventMarketPrivateMessage,
  type ParsedOrderMessage,
} from "./orders"
import {
  __resetInboxRelayCache,
  type PrivateMessageEvent,
  type DecryptFailure,
  type LegacyDmDecryptFailure,
  type ParsedDirectMessage,
} from "./messaging"
import { MAX_PRODUCT_RELAY_HINTS } from "./product-reference"
import {
  parseProfileEvent,
  __setProfileCacheTestOverrides,
  __resetProfileCacheTestOverrides,
  type ProfileFrontierState,
  type SelectedProfileContext,
} from "./profile-cache"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { type VerifiedNostrEvent } from "./verified-public-event"
import type { ProductDeletionEvidence } from "./product-deletion"
import {
  normalizeOwnerSelectedRelayUrls,
  normalizePublicOrIsolatedE2eRelayHints,
  normalizePublicRelayHints,
  normalizeUntrustedRelayHintsForContext,
} from "./relay-settings"
import {
  getRelayLists,
  getRelayListsDetailed,
  type RelayList,
} from "./relay-list"
import { DEFAULT_READ_FANOUT } from "./relay-planner"
import {
  readProtectedInbox,
  type ProtectedInboxAuthSummary,
  type ReadProtectedInboxOptions,
} from "./protected-inbox-read"
import {
  visitProtectedInboxHistoryPage,
  type ProtectedInboxHistoryCursor,
  type ProtectedInboxHistoryPageStatus,
} from "./protected-inbox-history"
import {
  getProtectedReadAuthorization,
  hasProtectedReadAuthority,
  type ProtectedReadAuthorization,
} from "./protected-read-authorization"

// Keep author-scoped product filters small enough for public relays that
// reject or truncate very large authors arrays. This is a transport batch
// size, not a product truth cap.
const PRODUCT_AUTHOR_CHUNK_SIZE = 64
// Exact cart and event-catalog reads keep only this many author plans in flight.
// Same-author items share one plan, while every requested author is eventually
// scheduled so a healthy multi-merchant catalog is not silently truncated.
const PRODUCT_AUTHOR_CHUNK_CONCURRENCY = 2

const PRODUCT_VARIATION_EVENT_LIMIT = 200
const CHECKOUT_SPARK_RECOVERY_INSPECTION_LIMIT = 50
const CHECKOUT_SPARK_RECOVERY_INSPECTION_BUDGET_MS = 15_000
const CHECKOUT_SPARK_RECOVERY_UNWRAP_TIMEOUT_MS = 4_000
const CHECKOUT_SPARK_RECOVERY_RECENT_WRAP_LIMIT = 1_024
// Process-local retention only. A cap terminates this session without
// discarding already observed authority; explicit refresh creates a new one.
const CHECKOUT_SPARK_RECOVERY_RETAINED_EVIDENCE_LIMIT = 512
const CHECKOUT_SPARK_RECOVERY_RETAINED_CHAR_LIMIT = 8 * 1024 * 1024
const CHECKOUT_SPARK_RECOVERY_FAILURE_ID_LIMIT = 512
const CHECKOUT_SPARK_RECOVERY_SESSION_LIFETIME_MS = 30 * 60_000
const CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT = Symbol(
  "checkout_spark_recovery_inspection_timeout"
)

export type CommerceReadSource = "commerce" | "public" | "local_cache"
export type CommerceSortMode =
  "newest" | "price_asc" | "price_desc" | "updated_at_desc"
export type CommerceReadPlanName =
  | "marketplace_products"
  | "merchant_storefront"
  | "product_detail"
  | "profile_batch"
  | "protected_conversation_list"
  | "conversation_detail"

export interface CommerceCapabilities {
  sortModes: CommerceSortMode[]
  textSearch: boolean
  protectedSummaries: boolean
  canonicalFreshness: boolean
  cursorPagination: boolean
}

/**
 * Content-free status of the principal's NIP-17 inbox for one read (CND-208).
 * Distinguishes "no declaration exists" from "the lookup or read degraded" so
 * surfaces never render a false "not declared" or a false empty inbox.
 */
export interface PrivateInboxReadStatus {
  declarationState: InboxDeclarationState
  coverage: InboxReadCoverage
  readSource: InboxReadSource
  /** Current-session relay-auth evidence; never persisted with messages. */
  authentication?: ProtectedInboxAuthSummary
}

export interface CommerceQueryMeta {
  source: CommerceReadSource
  degraded: boolean
  stale: boolean
  /** True when a transport/result limit may have truncated the evidence set. */
  capped?: boolean
  capabilities: CommerceCapabilities
  fetchedAt: number
  /** Bounded product transport observation; independent of retained rows. */
  productReadCoverage?: "complete" | "partial" | "unavailable"
  /** One ranked product-index response; coverage never implies corpus completeness. */
  productSearch?: {
    coverage: "complete" | "partial" | "unavailable"
    relayUrls: string[]
    /** Live Congee has not demonstrated tag filtering before the result cap. */
    tagScopeVerified: boolean
  }
  nextCursor?: string
  /** Present on private-message reads (order/DM surfaces). */
  inbox?: PrivateInboxReadStatus
  /**
   * Gift wraps that could not be turned into messages this read (id + coarse
   * reason only, never content). Surfaced so UIs render a retryable degraded
   * state instead of silently dropping messages.
   */
  decryptFailures?: DecryptFailure[]
  /** Deprecated kind-4 failures, kept distinct from NIP-17 gift wraps. */
  legacyDecryptFailures?: LegacyDmDecryptFailure[]
  /**
   * Profile-batch only: provenance of the selected kind-0 frontier. Retained
   * evidence can veto obsolete payment authority without authorizing a fresh
   * destination. `not_observed` means no identifiable frontier is available.
   */
  profileFrontierStates?: Record<string, ProfileFrontierState>
}

export type { ProfileFrontierState } from "./profile-cache"

export interface ProfileBatchResult extends CommerceResult<
  Record<string, Profile>
> {
  profileContexts: Record<string, SelectedProfileContext>
}

export type CommerceFreshnessMeta = Pick<
  CommerceQueryMeta,
  "stale" | "degraded" | "capped"
>

export function isCommerceReadIncomplete(
  meta: CommerceFreshnessMeta | null | undefined
): boolean {
  return !!(meta?.stale || meta?.degraded || meta?.capped)
}

export interface CommerceResult<T> {
  data: T
  meta: CommerceQueryMeta
}

export interface FollowListQueryMeta extends CommerceQueryMeta {
  /**
   * True when a verified signed kind-3 snapshot is available. This
   * distinguishes an intentional empty contact list from a bounded read that
   * found no event; `snapshotState` identifies retained evidence.
   */
  eventObserved: boolean
  /** NIP-01 replaceable-event ordering evidence for the selected kind-3. */
  eventCreatedAt?: number
  eventId?: string
  coverage: FollowListCoverageState
  snapshotState: FollowListAuthorRead["snapshotState"]
}

export interface FollowListResult extends CommerceResult<string[]> {
  meta: FollowListQueryMeta
  /** The verified signed kind-3 selected for this result, when observed. */
  event?: SignedPublicNostrEvent
}

export type { CommerceProductRecord } from "./commerce-product-selection"

export interface MarketplaceProductsQuery {
  readScope?: PublicReadScope
  merchantPubkey?: string
  authorPubkeys?: string[]
  authenticatedPubkey?: string | null
  /** Final-I/O account exclusions without changing generic discovery scope. */
  accountPubkey?: string | null
  /** Live account session authority for relay admission after policy awaits. */
  shouldContinue?: () => boolean
  textQuery?: string
  /** Query one NIP-50 product index and preserve its relevance order. */
  signal?: AbortSignal
  searchIndex?: boolean
  /** Browse snapshots before and during lazy exact-coordinate refresh. */
  onProgress?: (result: CommerceResult<CommerceProductRecord[]>) => void
  tags?: string[]
  sort?: CommerceSortMode
  limit?: number
  cursor?: string
  readPolicy?: CommerceReadPolicy
}

export interface MerchantStorefrontQuery {
  readScope?: PublicReadScope
  merchantPubkey: string
  authenticatedPubkey?: string | null
  /** Final-I/O account exclusions without changing merchant-hint authority. */
  accountPubkey?: string | null
  /** Live account session authority for relay admission after policy awaits. */
  shouldContinue?: () => boolean
  textQuery?: string
  tag?: string
  sort?: CommerceSortMode
  limit?: number
  cursor?: string
  includeMarketHidden?: boolean
  readPolicy?: CommerceReadPolicy
  deletionReadPolicy?: CommerceReadPolicy
  deletionFallbackWhenEmpty?: boolean
}

export interface ProductDetailQuery {
  readScope?: PublicReadScope
  productId: string
  revalidateCanonical?: boolean
  includeMarketHidden?: boolean
  /** Final-I/O account exclusions for this generic exact product read. */
  authenticatedPubkey?: string | null
  /** Live account session authority for relay admission after policy awaits. */
  shouldContinue?: () => boolean
}

export interface ProductsByIdsOptions {
  readScope?: PublicReadScope
  /**
   * One initial locally reconciled snapshot, including an empty cache, before
   * relay discovery. Success-only: an initial cache failure or cancellation
   * before this stage finishes emits no callback; observe the returned promise
   * for those outcomes. Cache readiness does not grant product authority or
   * change the existing onProgress publication sequence.
   */
  onCacheReady?: (result: ProductsByIdsResult) => void
  /**
   * Cumulative exact-coordinate browse snapshots as author batches settle.
   * Queued and unfinished authors stay stale/partial; completed authors carry
   * final per-coordinate diagnostics before other authors finish.
   * The last callback is the final family/deletion-reconciled return value.
   */
  onProgress?: (result: ProductsByIdsResult) => void
  /** Merchant management only: bypass every Market availability filter. */
  includeMarketHidden?: boolean
  /**
   * Buyer-scoped exception for exact event-pickup coordinates. Only listings
   * hidden solely by the merchant visibility signal are admitted; missing
   * images and unsupported product structures remain filtered.
   */
  includeMerchantHiddenProductIds?: readonly string[]
  /**
   * Coordinate-scoped routing hints supplied by a signed reference. Hints only
   * extend bounded relay discovery; listing, author, and deletion checks remain
   * authoritative.
   */
  relayHintsByAddressId?: Readonly<
    Record<string, readonly string[] | undefined>
  >
  /**
   * Signed-in account whose durable whole-relay exclusions apply at final I/O.
   * Its explicit Network choices may join this generic product lookup without
   * displacing the bounded public commerce discovery set.
   */
  accountPubkey?: string | null
  /** Live signer identity available for relay authentication. */
  authenticatedPubkey?: string | null
  /** Cancels queued and in-flight exact product hydration. */
  signal?: AbortSignal
  /** Live account session authority for relay admission after policy awaits. */
  shouldContinue?: () => boolean
}

export interface ProfileBatchQuery {
  readScope?: PublicReadScope
  pubkeys: string[]
  authenticatedPubkey?: string | null
  /** Final-I/O account exclusions without changing profile hint authority. */
  accountPubkey?: string | null
  /** Cancels queued or in-flight profile I/O when the caller's session changes. */
  signal?: AbortSignal
  /** Live account session authority for non-signal account reads. */
  shouldContinue?: () => boolean
  skipCache?: boolean
  /** Require relay-coverage diagnostics before absence is treated as current. */
  requireCompleteEvidence?: boolean
  /** Field-comparison scope; full_profile alone does not require complete reads. */
  evidenceScope?: "full_profile" | "payment" | "profile_edit"
  /** Opt into author-relay coverage for the settled-router payment preflight. */
  authorRelayPaymentPolicy?: boolean
  priority?: "visible" | "background"
  readPolicy?: CommerceReadPolicy
  relayHintsByPubkey?: Record<string, string[] | undefined>
  onProgress?: (result: ProfileBatchResult) => void
}

export interface FollowListQuery {
  readScope?: PublicReadScope
  pubkey: string
  accountPubkey?: string | null
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
}

export interface ConversationListQuery {
  principalPubkey: string
  limit?: number
  textQuery?: string
  counterpartyPubkey?: string
}

export interface ConversationDetailQuery {
  principalPubkey: string
  counterpartyPubkey?: string
  orderId: string
  role: "buyer" | "merchant"
}

interface ConversationSummaryBase {
  /** Opaque local participant-bound identity; never use as the wire order ID. */
  id: string
  orderId: string
  latestAt: number
  latestType: ParsedOrderMessage["type"]
  status: string | null
  totalSummary: string | null
  preview: string
  messageCount: number
  messages?: ParsedOrderMessage[]
  context: "complete" | "missing_order"
}

export type {
  CachedProductReadOptions,
  LocalProductRevisionSnapshot,
  LocalProductDeletionSnapshot,
} from "./commerce-product-cache"

export interface CommerceReadPolicy {
  maxRelays?: number
  connectTimeoutMs?: number
  fetchTimeoutMs?: number
}

export interface BuyerConversationSummary extends ConversationSummaryBase {
  merchantPubkey: string
}

export interface MerchantConversationSummary extends ConversationSummaryBase {
  buyerPubkey: string
  merchantPubkey: string
}

export type ConversationSummary =
  BuyerConversationSummary | MerchantConversationSummary

export interface ConversationDetail {
  orderId: string
  messages: ParsedOrderMessage[]
}

export interface CommerceReadPlan {
  name: CommerceReadPlanName
  sources: CommerceReadSource[]
}

type RawMessageFetchResult = {
  messages: ParsedOrderMessage[]
  source: CommerceReadSource
  stale: boolean
  decryptFailures: DecryptFailure[]
  inbox?: PrivateInboxReadStatus
}

type RawDirectMessageFetchResult = {
  messages: ParsedDirectMessage[]
  unreadMessageIds: Set<string>
  source: CommerceReadSource
  stale: boolean
  decryptFailures: DecryptFailure[]
  legacyDecryptFailures: LegacyDmDecryptFailure[]
  inbox?: PrivateInboxReadStatus
}

function getCommerceInbox(principalPubkey: string): CommerceInbox {
  return (testOverrides.getCommerceInbox ?? getDefaultCommerceInbox)(
    principalPubkey
  )
}

// Test transport seams deliberately accept raw signed envelopes. Production
// reader results stay proof-typed; every public use of these seams is admitted
// by the same owning adapter, including malformed/forged ingress regressions.
type RawTestReadResult<T> = Omit<T, "events"> & {
  events: SignedPublicNostrEvent[]
}
type RawTestProgress = Omit<
  Parameters<Parameters<typeof fetchPublicEventsProgressive>[2]>[0],
  "events" | "mergedEvents"
> & {
  events: SignedPublicNostrEvent[]
  mergedEvents: SignedPublicNostrEvent[]
}

type CommerceTestOverrides = ProductCacheTestOverrides & {
  checkoutSparkSettledRepository?: DexieCheckoutSparkSettledRepository
  /** Transport-only seam; returned signed sources still undergo validation. */
  readCheckoutSparkPlanSourceEvents?: (
    plan: CheckoutSparkSettledPlan
  ) => Promise<{
    events: SignedPublicNostrEvent[]
    coverage: InboxReadCoverage
  }>
  getCommerceInbox?: (principalPubkey: string) => CommerceInbox
  allowMissingProtectedReadAuthorization?: boolean
  getRelayLists?: typeof getRelayLists
  getRelayListsDetailed?: typeof getRelayListsDetailed
  fetchPublicEvents?: (
    ...args: Parameters<typeof fetchPublicEvents>
  ) => Promise<SignedPublicNostrEvent[]>
  fetchPublicEventsWithDiagnostics?: (
    ...args: Parameters<typeof fetchPublicEventsWithDiagnostics>
  ) => Promise<
    RawTestReadResult<
      Awaited<ReturnType<typeof fetchPublicEventsWithDiagnostics>>
    >
  >
  fetchSignedEventsFanoutDetailed?: (
    ...args: Parameters<typeof fetchSignedEventsFanoutDetailed>
  ) => Promise<
    RawTestReadResult<
      Awaited<ReturnType<typeof fetchSignedEventsFanoutDetailed>>
    >
  >
  fetchPublicEventsProgressive?: (
    filter: Parameters<typeof fetchPublicEventsProgressive>[0],
    options: Parameters<typeof fetchPublicEventsProgressive>[1],
    onProgress: (progress: RawTestProgress) => void | Promise<void>
  ) => Promise<SignedPublicNostrEvent[]>
  readLatestFollowLists?: typeof readLatestFollowLists
  getAccountSigner?: () => NostrKeySigner | undefined
  readProtectedInbox?: (
    options: ReadProtectedInboxOptions
  ) => ReturnType<typeof readProtectedInbox>
  accountNetworkLocalStateRepository?: ReadProtectedInboxOptions["accountNetworkLocalStateRepository"]
  ownerRelayListEvidenceRepository?: OwnerRelayListEvidenceRepository
  giftUnwrap?: (
    event: PrivateMessageEvent,
    signer: NostrKeySigner
  ) => Promise<PrivateMessageEvent | null>
  getCachedProfiles?: (
    pubkeys: string[]
  ) => Promise<Array<CachedProfile | undefined>>
  putCachedProfiles?: (rows: CachedProfile[]) => Promise<void>
  getCachedOrderMessages?: (
    principalPubkey: string
  ) => Promise<CachedOrderMessage[]>
  putCachedOrderMessages?: (rows: CachedOrderMessage[]) => Promise<void>
  getCachedDirectMessages?: (
    principalPubkey: string
  ) => Promise<StoredMessage[]>
  putCachedDirectMessages?: (rows: StoredMessage[]) => Promise<void>
  deleteCachedDirectMessages?: (ids: string[]) => Promise<void>
  persistProtectedInboxMessages?: (
    orderRows: CachedOrderMessage[],
    directRows: StoredMessage[],
    assertAuthority: () => void
  ) => Promise<void>
  persistLegacyDirectMessages?: (
    rows: StoredMessage[],
    assertAuthority: () => void
  ) => Promise<void>
  resolveInboxRelayUrls?: (principalPubkey: string) => Promise<string[]>
  markDirectMessagesRead?: (
    principalPubkey: string,
    counterpartyPubkey: string,
    transport?: ParsedDirectMessage["transport"]
  ) => Promise<number>
}

const PRODUCT_CAPABILITIES: CommerceCapabilities = {
  sortModes: ["newest", "price_asc", "price_desc", "updated_at_desc"],
  textSearch: true,
  protectedSummaries: false,
  canonicalFreshness: false,
  cursorPagination: false,
}

const CONVERSATION_CAPABILITIES: CommerceCapabilities = {
  sortModes: ["updated_at_desc"],
  textSearch: true,
  protectedSummaries: true,
  canonicalFreshness: false,
  cursorPagination: false,
}

const PROFILE_CAPABILITIES: CommerceCapabilities = {
  sortModes: [],
  textSearch: false,
  protectedSummaries: false,
  canonicalFreshness: false,
  cursorPagination: false,
}

const READ_PLANS: Record<CommerceReadPlanName, CommerceReadSource[]> = {
  marketplace_products: ["public", "local_cache"],
  merchant_storefront: ["commerce", "public", "local_cache"],
  product_detail: ["commerce", "public", "local_cache"],
  profile_batch: ["public", "local_cache"],
  protected_conversation_list: ["commerce", "public", "local_cache"],
  conversation_detail: ["commerce", "public", "local_cache"],
}

let testOverrides: CommerceTestOverrides = {}
class ProtectedInboxAuthorityChangedError extends Error {
  constructor() {
    super("Protected-read authority changed during inbox synchronization")
    this.name = "ProtectedInboxAuthorityChangedError"
  }
}

function assertInboxSyncAuthority(
  authorization: ProtectedReadAuthorization | null
): void {
  if (authorization && !hasProtectedReadAuthority(authorization)) {
    throw new ProtectedInboxAuthorityChangedError()
  }
}

function resolveInboxSyncAuthorization(
  principalPubkey: string
): ProtectedReadAuthorization | null {
  const authorization = getProtectedReadAuthorization(principalPubkey)
  if (authorization) return authorization
  if (testOverrides.allowMissingProtectedReadAuthorization === true) return null
  throw new ProtectedInboxAuthorityChangedError()
}

function now(): number {
  return testOverrides.now?.() ?? Date.now()
}

async function admitObservedPublicEvents(
  events: readonly SignedPublicNostrEvent[],
  signal?: AbortSignal
): Promise<VerifiedNostrEvent[]> {
  return verifySignedEventBatches(events, { signal })
}

async function runFetchEventsFanout(
  filter: Filter,
  options?: Parameters<typeof fetchPublicEvents>[1]
): Promise<VerifiedNostrEvent[]> {
  return admitObservedPublicEvents(
    await runRawFetchEventsFanout(filter, options),
    options?.signal
  )
}

async function runRawFetchEventsFanout(
  filter: Filter,
  options?: Parameters<typeof fetchPublicEvents>[1]
): Promise<SignedPublicNostrEvent[]> {
  if (testOverrides.fetchPublicEvents) {
    return (await testOverrides.fetchPublicEvents(
      filter,
      options
    )) as SignedPublicNostrEvent[]
  }
  if (testOverrides.fetchPublicEventsWithDiagnostics) {
    return (
      await testOverrides.fetchPublicEventsWithDiagnostics(filter, options)
    ).events
  }
  // A progressive-only test override owns the complete relay boundary. Its
  // fixture can pair an events-only override when deletion events are needed;
  // otherwise deletion discovery is deterministically empty instead of
  // escaping to the network during a unit test.
  if (testOverrides.fetchPublicEventsProgressive) return []
  return (await fetchPublicEvents(filter, options)) as SignedPublicNostrEvent[]
}

/**
 * Diagnostics-aware fanout honoring the events-only test override. An
 * events-only override cannot report per-relay failure, so its result counts
 * as complete coverage.
 */
async function runFetchEventsFanoutWithDiagnostics(
  filter: Filter,
  options?: Parameters<typeof fetchPublicEventsWithDiagnostics>[1]
): Promise<Awaited<ReturnType<typeof fetchPublicEventsWithDiagnostics>>> {
  const result = await runRawFetchEventsFanoutWithDiagnostics(filter, options)
  return {
    ...result,
    events: await admitObservedPublicEvents(result.events, options?.signal),
  }
}

async function runRawFetchEventsFanoutWithDiagnostics(
  filter: Filter,
  options?: Parameters<typeof fetchPublicEventsWithDiagnostics>[1]
): Promise<
  Omit<
    Awaited<ReturnType<typeof fetchPublicEventsWithDiagnostics>>,
    "events"
  > & { events: SignedPublicNostrEvent[] }
> {
  if (testOverrides.fetchPublicEventsWithDiagnostics) {
    return await testOverrides.fetchPublicEventsWithDiagnostics(filter, options)
  }
  if (testOverrides.fetchPublicEvents) {
    const events = await testOverrides.fetchPublicEvents(filter, options)
    const relayUrls = [...(options?.relayUrls ?? [])]
    const limit = filter.limit
    return {
      events,
      attemptedRelayUrls: relayUrls,
      successfulRelayUrls: relayUrls,
      failedRelayUrls: [],
      cappedRelayUrls:
        typeof limit === "number" && events.length >= limit ? relayUrls : [],
    }
  }
  return await fetchPublicEventsWithDiagnostics(filter, options)
}

/**
 * Detect saturation before event deduplication. Multiple revisions can fill an
 * individual relay response even when the merged event set stays below the
 * limit, so callers must not certify that bounded read as complete or fresh.
 */
function isBoundedFanoutSaturated(
  filter: Filter,
  events: readonly SignedPublicNostrEvent[],
  relayEventCounts: readonly number[] = []
): boolean {
  const limit = filter.limit
  return (
    typeof limit === "number" &&
    limit > 0 &&
    (events.length >= limit ||
      relayEventCounts.some((eventCount) => eventCount >= limit))
  )
}

async function runFetchEventsFanoutDetailed(
  filter: Filter,
  options?: Parameters<typeof fetchSignedEventsFanoutDetailed>[1]
) {
  const result = await runRawFetchEventsFanoutDetailed(filter, options)
  const events = await admitObservedPublicEvents(result.events, options?.signal)
  const rejected = events.length !== result.events.length
  return {
    ...result,
    events,
    degraded: result.degraded || rejected,
    coverage: rejected ? ("partial" as const) : result.coverage,
  }
}

async function runRawFetchEventsFanoutDetailed(
  filter: Filter,
  options?: Parameters<typeof fetchSignedEventsFanoutDetailed>[1]
): Promise<{
  events: SignedPublicNostrEvent[]
  degraded: boolean
  capped: boolean
  completedRelayUrls: string[]
  coverage: "complete" | "partial" | "unavailable"
}> {
  if (testOverrides.fetchSignedEventsFanoutDetailed) {
    const result = await testOverrides.fetchSignedEventsFanoutDetailed(
      filter,
      options
    )
    return {
      events: result.events,
      completedRelayUrls: result.relays
        .filter((relay) => relay.status === "success")
        .map((relay) => relay.relayUrl),
      coverage:
        result.relays.length === 0 ||
        result.relays.every((relay) => relay.status === "failed")
          ? "unavailable"
          : result.relays.every((relay) => relay.status === "success")
            ? "complete"
            : "partial",
      degraded:
        result.relays.length === 0 ||
        result.relays.some((relay) => relay.status !== "success"),
      capped: isBoundedFanoutSaturated(
        filter,
        result.events,
        result.relays.map(
          (relay) => relay.eventCount + (relay.rejectedEventCount ?? 0)
        )
      ),
    }
  }

  if (testOverrides.fetchPublicEventsWithDiagnostics) {
    const result = await testOverrides.fetchPublicEventsWithDiagnostics(
      filter,
      options
    )
    return {
      events: result.events,
      completedRelayUrls: result.successfulRelayUrls.filter(
        (relayUrl) => !result.failedRelayUrls.includes(relayUrl)
      ),
      coverage:
        result.successfulRelayUrls.length === 0
          ? "unavailable"
          : result.failedRelayUrls.length
            ? "partial"
            : "complete",
      degraded:
        result.successfulRelayUrls.length === 0 ||
        result.failedRelayUrls.length > 0,
      capped: isBoundedFanoutSaturated(filter, result.events),
    }
  }

  // Most gateway tests replace the older event-only seam. Preserve that
  // deterministic contract while production reads use per-relay completion.
  if (testOverrides.fetchPublicEvents) {
    const events = await admitObservedPublicEvents(
      await testOverrides.fetchPublicEvents(filter, options),
      options?.signal
    )
    const relayUrls = [...(options?.relayUrls ?? [])]
    return {
      events,
      completedRelayUrls: relayUrls,
      coverage: "complete",
      degraded: false,
      capped: isBoundedFanoutSaturated(filter, events),
    }
  }

  const result = await fetchSignedEventsFanoutDetailed(filter, options)
  return {
    events: result.events,
    completedRelayUrls: result.relays
      .filter((relay) => relay.status === "success")
      .map((relay) => relay.relayUrl),
    coverage:
      result.relays.length === 0 ||
      result.relays.every((relay) => relay.status === "failed")
        ? "unavailable"
        : result.relays.every((relay) => relay.status === "success")
          ? "complete"
          : "partial",
    degraded:
      result.relays.length === 0 ||
      result.relays.some((relay) => relay.status !== "success"),
    capped: isBoundedFanoutSaturated(
      filter,
      result.events,
      result.relays.map(
        (relay) => relay.eventCount + (relay.rejectedEventCount ?? 0)
      )
    ),
  }
}

/**
 * Account key authority is independent of relay client lifetime.
 */
async function resolveEnvelopeSigner(): Promise<NostrKeySigner | undefined> {
  return (testOverrides.getAccountSigner ?? getAccountSigner)()
}

function unavailableInboxStatus(
  failure: ProtectedInboxAuthSummary["failure"] = "signer_unavailable"
): PrivateInboxReadStatus {
  return {
    declarationState: "lookup_unavailable",
    coverage: "unavailable",
    readSource: "cache",
    authentication: {
      state: "unavailable",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      failure,
    },
  }
}

export function resolveReadPlan(name: CommerceReadPlanName): CommerceReadPlan {
  return {
    name,
    sources: [...READ_PLANS[name]],
  }
}

export function __setCommerceTestOverrides(
  overrides: Partial<CommerceTestOverrides>
): void {
  testOverrides = { ...testOverrides, ...overrides }
  __setCommerceRelayPlanningTestOverrides({
    getRelayLists: testOverrides.getRelayLists,
    getRelayListsDetailed: testOverrides.getRelayListsDetailed,
    ownerRelayListEvidenceRepository:
      testOverrides.ownerRelayListEvidenceRepository,
    accountNetworkLocalStateRepository:
      testOverrides.accountNetworkLocalStateRepository,
    hasFetchOverride: !!(
      testOverrides.fetchPublicEvents ||
      testOverrides.fetchPublicEventsWithDiagnostics ||
      testOverrides.fetchSignedEventsFanoutDetailed ||
      testOverrides.fetchPublicEventsProgressive
    ),
  })
  __setProfileCacheTestOverrides({
    getCachedProfiles: testOverrides.getCachedProfiles,
    putCachedProfiles: testOverrides.putCachedProfiles,
  })
  __setProductCacheTestOverrides({
    now: testOverrides.now,
    getCachedProducts: testOverrides.getCachedProducts,
    putCachedProducts: testOverrides.putCachedProducts,
    getCachedProductTombstones: testOverrides.getCachedProductTombstones,
    putCachedProductTombstones: testOverrides.putCachedProductTombstones,
  })
}

export function __resetCommerceTestOverrides(): void {
  testOverrides = {}
  __resetCommerceRelayPlanningTestOverrides()
  __resetProfileCacheTestOverrides()
  __resetProductCacheTestOverrides()
  __resetInboxRelayCache()
}

function createMeta(
  planName: CommerceReadPlanName,
  source: CommerceReadSource,
  capabilities: CommerceCapabilities,
  options: {
    stale?: boolean
    degraded?: boolean
    capped?: boolean
    nextCursor?: string
    decryptFailures?: DecryptFailure[]
    legacyDecryptFailures?: LegacyDmDecryptFailure[]
    inbox?: PrivateInboxReadStatus
  } = {}
): CommerceQueryMeta {
  const plan = resolveReadPlan(planName)
  const decryptFailures =
    options.decryptFailures && options.decryptFailures.length > 0
      ? options.decryptFailures
      : undefined
  const legacyDecryptFailures =
    options.legacyDecryptFailures && options.legacyDecryptFailures.length > 0
      ? options.legacyDecryptFailures
      : undefined
  return {
    source,
    stale: options.stale ?? source === "local_cache",
    capped: options.capped ?? false,
    degraded:
      options.degraded ??
      (options.stale === true ||
        options.capped === true ||
        source !== plan.sources[0] ||
        decryptFailures !== undefined ||
        legacyDecryptFailures !== undefined ||
        // Declaration setup state is reported separately via meta.inbox;
        // only incomplete read coverage degrades the data itself.
        (options.inbox !== undefined && options.inbox.coverage !== "complete")),
    capabilities,
    fetchedAt: now(),
    nextCursor: options.nextCursor,
    decryptFailures,
    legacyDecryptFailures,
    inbox: options.inbox,
  }
}

function getTagValue(
  tags: readonly (readonly string[])[] | undefined,
  name: string
): string | null {
  if (!tags) return null
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1]
  }
  return null
}

function uniqueStrings(
  values: readonly (string | undefined | null)[]
): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])
  )
}

function chunkStrings(values: readonly string[], size: number): string[][] {
  if (values.length === 0) return []
  const chunks: string[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return []

  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), values.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await worker(values[index], index)
      }
    })
  )
  return results
}

function rethrowProductReadAuthorityChange(
  error: unknown,
  shouldContinue: (() => boolean) | undefined
): void {
  if (
    error instanceof ProtectedInboxAuthorityChangedError ||
    (error instanceof NostrSignerError && error.code === "authority_changed")
  ) {
    throw error
  }
  if (shouldContinue?.() === false) {
    throw new NostrSignerError("authority_changed")
  }
}

async function preloadExactProductRelayLists(
  authors: readonly string[],
  options: ProductsByIdsOptions
): Promise<{
  relayLists: Map<string, RelayList>
  unavailableAuthors: Set<string>
}> {
  type RelayListChunkResult = {
    authors: string[]
    relayLists: ReadonlyMap<string, RelayList>
    unavailable: boolean
  }
  const resolveAuthorChunk = async (
    authorChunk: string[]
  ): Promise<RelayListChunkResult[]> => {
    try {
      const relayPlan = await planCommerceReadRelayPlan({
        readScope: options.readScope,
        intent: "author_products",
        authors: authorChunk,
        authenticatedPubkey: options.authenticatedPubkey,
        accountPubkey: options.accountPubkey ?? options.authenticatedPubkey,
        shouldContinue: options.shouldContinue,
        signal: options.signal,
        relayHintMode: "force",
        maxRelays: DEFAULT_READ_FANOUT,
      })
      return [
        {
          authors: authorChunk,
          relayLists: relayPlan.relayLists,
          unavailable: false,
        },
      ]
    } catch (error) {
      rethrowProductReadAuthorityChange(error, options.shouldContinue)
      if (authorChunk.length > 1) {
        const midpoint = Math.ceil(authorChunk.length / 2)
        return [
          ...(await resolveAuthorChunk(authorChunk.slice(0, midpoint))),
          ...(await resolveAuthorChunk(authorChunk.slice(midpoint))),
        ]
      }
      return [
        {
          authors: authorChunk,
          relayLists: new Map<string, RelayList>(),
          unavailable: true,
        },
      ]
    }
  }
  const chunkResultGroups = await mapWithConcurrency(
    chunkStrings(authors, PRODUCT_AUTHOR_CHUNK_SIZE),
    PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
    resolveAuthorChunk
  )
  const chunkResults = chunkResultGroups.flat()
  const relayLists = new Map<string, RelayList>()
  const unavailableAuthors = new Set<string>()
  for (const chunkResult of chunkResults) {
    if (chunkResult.unavailable) {
      for (const author of chunkResult.authors) unavailableAuthors.add(author)
      continue
    }
    for (const [pubkey, relayList] of chunkResult.relayLists) {
      relayLists.set(pubkey, relayList)
    }
  }
  return { relayLists, unavailableAuthors }
}

function putMergedEvent(
  merged: Map<string, SignedPublicNostrEvent>,
  event: SignedPublicNostrEvent
): void {
  const fallbackId = `${event.pubkey}:${event.kind}:${event.created_at ?? 0}`
  const key = event.id || fallbackId
  const existing = merged.get(key)
  if (existing) {
    mergeEventSourceRelayUrls(existing, event)
    return
  }
  merged.set(key, event)
}

async function streamProductRecordChunks(input: {
  readScope?: PublicReadScope
  baseFilter: Filter
  authorChunks: Array<string[] | undefined>
  relayUrls: string[]
  relayTargets: RelayTarget[]
  maxRelayAttempts?: number
  authenticatedPubkey?: string | null
  accountPubkey?: string | null
  signal?: AbortSignal
  shouldContinue?: () => boolean
  readPolicy?: CommerceReadPolicy
  merged: Map<string, SignedPublicNostrEvent>
  recordsByEventId: Map<string, CommerceProductRecord>
  deletionTimestamps?: DeletionTimestamps
  retainRevisions?: boolean
  onRecords: (
    records: CommerceProductRecord[],
    relayUrl: string
  ) => void | Promise<void>
  onTransportStatus?: (degraded: boolean, capped: boolean) => void
}): Promise<void> {
  input.signal?.throwIfAborted()
  if (input.relayUrls.length === 0) {
    input.onTransportStatus?.(true, false)
    return
  }

  let nextChunkIndex = 0
  const workerCount = Math.min(
    PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
    input.authorChunks.length
  )
  const fetchFeedProgressive: typeof fetchPublicEventsProgressive = async (
    filter,
    options,
    onProgress
  ) => {
    const result = await runFetchEventsFanoutDetailed(filter, {
      ...options,
      onRelayProgress: onProgress,
    })
    // Progress callbacks cover attempted sources only. A health/policy
    // omission must not turn a fixed-feed partial read into completion.
    input.onTransportStatus?.(
      result.degraded ||
        input.relayUrls.some((url) => !result.completedRelayUrls.includes(url)),
      result.capped
    )
    return result.events
  }
  const fetchProgressive =
    testOverrides.fetchPublicEventsProgressive ??
    (input.readScope === "public_feed"
      ? fetchFeedProgressive
      : fetchPublicEventsProgressive)
  const yieldCatalogTask = async (): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    input.signal?.throwIfAborted()
    if (input.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
  }
  const pendingEvents = new Map<string, SignedPublicNostrEvent>()
  let pendingProgress: Promise<void> | undefined
  const progressAdmissions: Promise<void>[] = []
  let pendingRefresh = false
  let pendingRelayUrl = ""
  const scheduleProgress = async (
    events: SignedPublicNostrEvent[],
    relayUrl: string
  ): Promise<void> => {
    events = await admitObservedPublicEvents(events, input.signal)
    input.signal?.throwIfAborted()
    if (input.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
    // Admit only this relay's delta. The fanout's mergedEvents is cumulative,
    // and parsing it on every callback makes a broad catalog quadratic.
    let taskStartedAt = performance.now()
    for (const event of events) {
      if (performance.now() - taskStartedAt >= 8) {
        await yieldCatalogTask()
        taskStartedAt = performance.now()
      }
      putMergedEvent(input.merged, event)
      const key =
        event.id || `${event.pubkey}:${event.kind}:${event.created_at ?? 0}`
      pendingEvents.set(key, input.merged.get(key)!)
    }
    pendingRelayUrl = relayUrl
    pendingRefresh = true
    if (!pendingProgress) {
      // Coalesce concurrent relay/chunk callbacks before parsing, cache I/O,
      // deletion reads, and family projection. The awaited flush preserves
      // early durability and callback errors/cancellation.
      pendingProgress = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          void (async () => {
            try {
              while (pendingRefresh) {
                input.signal?.throwIfAborted()
                if (input.shouldContinue?.() === false)
                  throw new NostrSignerError("authority_changed")
                pendingRefresh = false
                const changedEvents = Array.from(pendingEvents.values())
                pendingEvents.clear()
                const currentRelayUrl = pendingRelayUrl
                const changedRecords: CommerceProductRecord[] = []
                let parseTaskStartedAt = performance.now()
                for (const event of changedEvents) {
                  if (performance.now() - parseTaskStartedAt >= 8) {
                    await yieldCatalogTask()
                    parseTaskStartedAt = performance.now()
                  }
                  const record = dedupeProductEvents(
                    [event],
                    input.deletionTimestamps,
                    input.retainRevisions
                  )[0]
                  if (!record) continue
                  const recordKey = input.retainRevisions
                    ? record.eventId ||
                      `${event.pubkey}:${event.kind}:${event.created_at ?? 0}`
                    : record.addressId
                  const previous = input.recordsByEventId.get(recordKey)
                  const next = previous
                    ? mergeProductRecordSources(previous, record)
                    : record
                  if (
                    previous &&
                    next.eventId === previous.eventId &&
                    (next.sourceRelayUrls?.length ?? 0) ===
                      (previous.sourceRelayUrls?.length ?? 0)
                  ) {
                    continue
                  }
                  input.recordsByEventId.set(recordKey, next)
                  changedRecords.push(next)
                }
                // Empty progress still refreshes newly observed tombstones.
                await input.onRecords(changedRecords, currentRelayUrl)
              }
            } finally {
              // Release ownership in the same turn as the last queue check.
              // A batch arriving in the promise-completion microtask must
              // start its own drain, not attach to this finished one.
              pendingProgress = undefined
            }
          })().then(resolve, reject)
        }, 32)
      })
    }
    return pendingProgress
  }

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextChunkIndex < input.authorChunks.length) {
        input.signal?.throwIfAborted()
        const authors = input.authorChunks[nextChunkIndex]
        nextChunkIndex += 1

        const chunkFilter: Filter = {
          ...input.baseFilter,
          ...(authors ? { authors } : {}),
        }
        const events = await fetchProgressive(
          chunkFilter,
          {
            relayUrls: input.relayUrls,
            relayTargets: input.relayTargets,
            maxRelayAttempts: input.maxRelayAttempts,
            accountPubkey: input.accountPubkey ?? input.authenticatedPubkey,
            authenticatedPubkey: input.authenticatedPubkey,
            accountNetworkLocalStateRepository:
              testOverrides.accountNetworkLocalStateRepository,
            shouldContinue: input.shouldContinue,
            signal: input.signal,
            connectTimeoutMs: input.readPolicy?.connectTimeoutMs ?? 4_000,
            fetchTimeoutMs: input.readPolicy?.fetchTimeoutMs ?? 8_000,
          },
          async ({ events, relayUrl, status }) => {
            input.signal?.throwIfAborted()
            if (status) {
              input.onTransportStatus?.(
                status !== "success",
                isBoundedFanoutSaturated(chunkFilter, events)
              )
            }
            const progress = scheduleProgress(events, relayUrl)
            progressAdmissions.push(progress)
            await progress
          }
        )
        input.signal?.throwIfAborted()
        let mergeTaskStartedAt = performance.now()
        for (const event of await admitObservedPublicEvents(
          events,
          input.signal
        )) {
          if (performance.now() - mergeTaskStartedAt >= 8) {
            await yieldCatalogTask()
            mergeTaskStartedAt = performance.now()
          }
          putMergedEvent(input.merged, event)
        }
        input.onTransportStatus?.(
          false,
          isBoundedFanoutSaturated(chunkFilter, events)
        )
      }
    })
  )
  // A transport override may return without awaiting its callback. The final
  // deletion frontier must still follow every scheduled progressive batch.
  await Promise.all(progressAdmissions)
  await pendingProgress
}

function filterExactProductRecordsForRead(
  records: CommerceProductRecord[],
  wanted: ReadonlySet<string>,
  options: ProductsByIdsOptions = {}
): CommerceProductRecord[] {
  return selectExactProductRecordsForRead(records, wanted, options, now)
}

type ContextualRelayHints = {
  publicRelayUrls: string[]
  authenticatedAuthorRelayUrls: string[]
}

function contextualRelayHints(
  entries: readonly { pubkey: string; relayUrls: readonly string[] }[],
  authenticatedPubkey: string | null | undefined
): ContextualRelayHints {
  const normalizedOwner = authenticatedPubkey?.trim().toLowerCase() ?? ""
  const publicRelayUrls: string[] = []
  const authenticatedAuthorRelayUrls: string[] = []

  for (const entry of entries) {
    const isAuthenticatedOwner =
      !!normalizedOwner && entry.pubkey.trim().toLowerCase() === normalizedOwner
    for (const relayUrl of entry.relayUrls) {
      const [publicRelayUrl] = normalizePublicRelayHints([relayUrl])
      if (publicRelayUrl) publicRelayUrls.push(publicRelayUrl)
      else if (isAuthenticatedOwner) {
        authenticatedAuthorRelayUrls.push(relayUrl)
      }
    }
  }

  return {
    publicRelayUrls: uniqueStrings(publicRelayUrls),
    authenticatedAuthorRelayUrls: uniqueStrings(authenticatedAuthorRelayUrls),
  }
}

/** Re-project only existing targets after merging stronger local dependencies. */
export function reconcileProductRecordsWithRevisions(
  records: CommerceProductRecord[],
  revisions: readonly CommerceProductRecord[]
): CommerceProductRecord[] {
  return reconcileSelectedProductRevisions(records, revisions, now)
}

/** Remove only records contradicted by observed NIP-09 evidence. */
export function reconcileProductRecordsWithDeletions(
  records: CommerceProductRecord[],
  evidence: readonly ProductDeletionEvidence[]
): CommerceProductRecord[] {
  return reconcileSelectedProductDeletions(records, evidence, now)
}

async function loadCachedOrderMessages(
  principalPubkey: string
): Promise<CachedOrderMessage[]> {
  if (testOverrides.getCachedOrderMessages) {
    return await testOverrides.getCachedOrderMessages(principalPubkey)
  }

  const owner = getCommerceInbox(principalPubkey)
  await owner.initialize()
  return owner.getSnapshot().orderMessages.map(cachedOrderMessageRow)
}

async function storeCachedOrderMessages(
  rows: CachedOrderMessage[],
  accountOwner: CommerceInbox
): Promise<void> {
  if (rows.length === 0) return

  // An account send must retain the owner captured before publication. Looking
  // up the ambient signer after the relay ACK could write A's order under B.
  accountOwner.assertCurrent()
  if (rows.some((row) => row.senderPubkey !== accountOwner.store.principal))
    throw new Error("Order message does not belong to the active account")

  if (testOverrides.putCachedOrderMessages) {
    await testOverrides.putCachedOrderMessages(rows)
    accountOwner.assertCurrent()
    return
  }

  const owner = accountOwner
  await owner.initialize()
  for (const row of rows)
    await owner.store.putProjection(
      {
        kind: "order",
        message: JSON.parse(row.rawContent) as ParsedOrderMessage,
      },
      1
    )
  await owner.refresh()
  accountOwner.assertCurrent()
}

function cachedOrderMessageRow(
  message: ParsedOrderMessage
): CachedOrderMessage {
  return {
    id: message.id,
    orderId: message.orderId,
    type: message.type,
    senderPubkey: message.senderPubkey,
    recipientPubkey: message.recipientPubkey,
    createdAt: message.createdAt,
    rawContent: JSON.stringify(message),
    cachedAt: now(),
  }
}

export async function cacheParsedOrderMessage(
  message: ParsedOrderMessage,
  accountOwner: CommerceInbox
): Promise<void> {
  await storeCachedOrderMessages([cachedOrderMessageRow(message)], accountOwner)
}

/** Normalize authenticated local sends through the shared commerce boundary. */
export async function cacheOrderMessageRumor(
  rumor: PrivateMessageEvent,
  accountOwner: CommerceInbox
): Promise<void> {
  await storeCachedOrderMessages(
    [cachedOrderMessageRow(parseOrderMessageRumorEvent(rumor))],
    accountOwner
  )
}

type ProductDeletionCandidate = {
  pubkey: string
  eventId?: string
  addressId?: string
  sourceRelayUrls?: readonly string[]
}

function deletionCandidateFromEvent(
  event: SignedPublicNostrEvent
): ProductDeletionCandidate {
  const dTag = getTagValue(event.tags ?? [], "d")
  return {
    pubkey: event.pubkey,
    eventId: event.id || undefined,
    addressId: dTag
      ? `${EVENT_KINDS.PRODUCT}:${event.pubkey}:${dTag}`
      : undefined,
    sourceRelayUrls: getEventSourceRelayUrls(event),
  }
}

function deletionCandidateFromRecord(
  record: CommerceProductRecord
): ProductDeletionCandidate {
  return {
    pubkey: record.product.pubkey,
    eventId: record.eventId || undefined,
    // Only new cache rows retain the signed d tag. Legacy rows are resolved by
    // exact event id and never by a coordinate reconstructed from product.id.
    addressId: record.dTag ? record.addressId : undefined,
    sourceRelayUrls: record.sourceRelayUrls,
  }
}

async function fetchProductDeletionTimestamps(
  candidates: readonly ProductDeletionCandidate[],
  options: {
    readScope?: PublicReadScope
    readPolicy?: CommerceReadPolicy
    fallbackWhenEmpty?: boolean
    authenticatedPubkey?: string | null
    /** Final-I/O exclusions without changing generic relay planning authority. */
    accountPubkey?: string | null
    signal?: AbortSignal
    shouldContinue?: () => boolean
    fetchEvents?: typeof runFetchEventsFanout
    onSkippedRelayUrls?: (relayUrls: readonly string[]) => void
    onReadCoverage?: (coverage: "complete" | "partial" | "unavailable") => void
  } = {}
): Promise<DeletionTimestamps> {
  const authors = uniqueStrings(candidates.map((candidate) => candidate.pubkey))
  if (authors.length === 0) {
    return await getLocalProductDeletionTimestamps()
  }
  const authorChunks = chunkStrings(authors, PRODUCT_AUTHOR_CHUNK_SIZE)
  const deletionEventBatches = await mapWithConcurrency(
    authorChunks,
    PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
    async (authorChunk) => {
      const authorSet = new Set(authorChunk)
      const chunkCandidates = candidates.filter((candidate) =>
        authorSet.has(candidate.pubkey)
      )
      const productEventIds = uniqueStrings(
        chunkCandidates.map((candidate) => candidate.eventId)
      )
      const productAddresses = uniqueStrings(
        chunkCandidates.map((candidate) => candidate.addressId)
      )
      const sourceRelayHints = contextualRelayHints(
        chunkCandidates.map((candidate) => ({
          pubkey: candidate.pubkey,
          relayUrls: candidate.sourceRelayUrls ?? [],
        })),
        options.authenticatedPubkey
      )
      const filters: Filter[] = [
        ...chunkStrings(productEventIds, 200).map((eventIdChunk) => ({
          kinds: [EVENT_KINDS.DELETION],
          authors: authorChunk,
          "#e": eventIdChunk,
          limit: 300,
        })),
        ...chunkStrings(productAddresses, 200).map((addressChunk) => ({
          kinds: [EVENT_KINDS.DELETION],
          authors: authorChunk,
          "#a": addressChunk,
          limit: 300,
        })),
      ]

      const deletionRelayPlan = await planCommerceReadRelayPlan({
        readScope: options.readScope,
        intent: "author_products",
        authors: authorChunk,
        authenticatedPubkey: options.authenticatedPubkey,
        accountPubkey: options.accountPubkey,
        maxRelays: options.readPolicy?.maxRelays,
        shouldContinue: options.shouldContinue,
        signal: options.signal,
      })
      const authenticatedOwnerSourceRelayUrls =
        normalizeUntrustedRelayHintsForContext({
          relayUrls: sourceRelayHints.authenticatedAuthorRelayUrls,
          approvedRelayUrls: deletionRelayPlan.relayUrls,
          allowApprovedPrivate: !!options.authenticatedPubkey,
        })
      const sourceRelayUrls = uniqueStrings([
        ...sourceRelayHints.publicRelayUrls,
        ...authenticatedOwnerSourceRelayUrls,
      ])
      const preferredDeletionRelayUrls =
        options.readScope === "public_feed"
          ? deletionRelayPlan.candidateRelayUrls
          : uniqueStrings([
              ...sourceRelayUrls,
              ...config.appBackplaneRelayUrls,
              ...deletionRelayPlan.relayUrls,
            ])
      const deletionRelayTargets =
        options.readScope === "public_feed"
          ? deletionRelayPlan.relayTargets
          : mergeRelayTargets(
              deletionRelayPlan.relayTargets,
              relayTargetsFromUrls(sourceRelayHints.publicRelayUrls, {
                kind: "public_hint",
                operation: "read",
              }),
              configuredRelayTargets(
                {
                  kind: "public_fallback",
                  operation: "read",
                  bucket: "commerce_discovery",
                },
                preferredDeletionRelayUrls
              ),
              configuredRelayTargets(
                {
                  kind: "public_fallback",
                  operation: "read",
                  bucket: "core_public",
                },
                preferredDeletionRelayUrls
              )
            )
      options.onSkippedRelayUrls?.(
        deletionRelayPlan.parkedRelayUrls.filter(
          (relayUrl) => !preferredDeletionRelayUrls.includes(relayUrl)
        )
      )
      const configuredRelayBatchSize = options.readPolicy?.maxRelays
      const relayBatchSize =
        configuredRelayBatchSize && configuredRelayBatchSize > 0
          ? configuredRelayBatchSize
          : Math.max(preferredDeletionRelayUrls.length, 1)
      const deletionRelayBatches = chunkStrings(
        preferredDeletionRelayUrls,
        relayBatchSize
      )
      if (
        options.readScope === "public_feed" &&
        preferredDeletionRelayUrls.length === 0
      )
        options.onReadCoverage?.("unavailable")
      const fetchDeletionFilter = async (
        filter: Filter
      ): Promise<SignedPublicNostrEvent[]> =>
        (
          await mapWithConcurrency(
            deletionRelayBatches,
            PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
            async (relayUrls) => {
              const fetchOptions = {
                relayUrls,
                relayTargets: deletionRelayTargets.filter((target) =>
                  relayUrls.includes(target.url)
                ),
                accountPubkey:
                  options.accountPubkey ?? options.authenticatedPubkey,
                authenticatedPubkey: options.authenticatedPubkey,
                accountNetworkLocalStateRepository:
                  testOverrides.accountNetworkLocalStateRepository,
                shouldContinue: options.shouldContinue,
                signal: options.signal,
                connectTimeoutMs: options.readPolicy?.connectTimeoutMs ?? 4_000,
                fetchTimeoutMs: options.readPolicy?.fetchTimeoutMs ?? 10_000,
              }
              if (options.readScope === "public_feed" && !options.fetchEvents) {
                const result = await runFetchEventsFanoutDetailed(
                  filter,
                  fetchOptions
                )
                const coverage =
                  result.completedRelayUrls.length === 0
                    ? "unavailable"
                    : result.degraded ||
                        result.capped ||
                        relayUrls.some(
                          (url) => !result.completedRelayUrls.includes(url)
                        )
                      ? "partial"
                      : "complete"
                options.onReadCoverage?.(coverage)
                return result.events
              }
              return await (options.fetchEvents ?? runFetchEventsFanout)(
                filter,
                fetchOptions
              )
            }
          )
        ).flat()
      const filterBatches = await mapWithConcurrency(
        filters,
        PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
        fetchDeletionFilter
      )
      const chunkEvents = filterBatches.flat()

      if (chunkEvents.length > 0 || options.fallbackWhenEmpty !== true) {
        return chunkEvents
      }
      return await fetchDeletionFilter({
        kinds: [EVENT_KINDS.DELETION],
        authors: authorChunk,
        limit: 300,
      })
    }
  )
  const deletionEventsById = new Map<string, SignedPublicNostrEvent>()
  for (const deletionEvent of deletionEventBatches.flat()) {
    putMergedEvent(deletionEventsById, deletionEvent)
  }
  const deletionEvents = Array.from(deletionEventsById.values())

  return await retainObservedProductDeletions(deletionEvents, authors)
}

async function fetchDeletionTimestampsForProductRecords(
  records: readonly CommerceProductRecord[],
  authorPubkeys: readonly string[] = uniqueStrings(
    records.map((record) => record.product.pubkey)
  ),
  accountPubkey?: string | null,
  authenticatedPubkey?: string | null,
  shouldContinue?: () => boolean,
  readScope?: PublicReadScope,
  onReadCoverage?: (coverage: "complete" | "partial" | "unavailable") => void
): Promise<DeletionTimestamps> {
  const recordCandidates = records.map(deletionCandidateFromRecord)
  const candidateAuthors = new Set(
    recordCandidates.map((candidate) => candidate.pubkey)
  )
  return await fetchProductDeletionTimestamps(
    [
      ...recordCandidates,
      ...uniqueStrings(authorPubkeys)
        .filter((authorPubkey) => !candidateAuthors.has(authorPubkey))
        .map((pubkey) => ({ pubkey })),
    ],
    {
      readScope,
      onReadCoverage,
      fallbackWhenEmpty: true,
      accountPubkey,
      authenticatedPubkey,
      shouldContinue,
    }
  )
}

function mergeCachedAndLiveProductRecords(input: {
  cached: CommerceProductRecord[]
  live: CommerceProductRecord[]
  deletionTimestamps: DeletionTimestamps
}): CommerceProductRecord[] {
  const byAddress = new Map<string, CommerceProductRecord>()

  // Resolve both frontiers before choosing a coordinate winner, so an exact
  // deletion of the newer revision cannot discard the surviving older one.
  const candidates = reconcileProductRecordsWithDeletions(
    [...input.cached, ...input.live].filter(
      (record) => !isRecordDeletedByNip09(record, input.deletionTimestamps)
    ),
    getLocalProductDeletionSnapshot().evidence
  )
  for (const record of candidates) {
    const existing = byAddress.get(record.addressId)
    byAddress.set(
      record.addressId,
      existing ? mergeProductRecordSources(existing, record) : record
    )
  }
  return Array.from(byAddress.values())
}

async function fetchPublicProductRecords(query: {
  readScope?: PublicReadScope
  retainRevisions?: boolean
  authors?: string[]
  ids?: string[]
  dTags?: string[]
  deletionCandidates?: CommerceProductRecord[]
  deletionReadPolicy?: CommerceReadPolicy
  deletionFallbackWhenEmpty?: boolean
  parentAddresses?: string[]
  authenticatedPubkey?: string | null
  /** Final-I/O exclusions without changing generic relay planning authority. */
  accountPubkey?: string | null
  signal?: AbortSignal
  shouldContinue?: () => boolean
  extraRelayUrls?: readonly string[]
  searchText?: string
  limit?: number
  readPolicy?: CommerceReadPolicy
  onTransportStatus?: (degraded: boolean, capped: boolean) => void
  onReadCoverage?: (coverage: "complete" | "partial" | "unavailable") => void
  /** Ranked discovery paints from signed hits and known local evidence first. */
  localDeletionEvidenceOnly?: boolean
}): Promise<CommerceProductRecord[]> {
  const filter: Filter = {
    kinds: [EVENT_KINDS.PRODUCT],
  }

  if (query.limit !== undefined) filter.limit = query.limit
  if (query.authors) filter.authors = query.authors
  if (query.ids) filter.ids = query.ids
  if (query.dTags) filter["#d"] = query.dTags
  if (query.parentAddresses) filter["#a"] = query.parentAddresses
  if (query.searchText) filter.search = query.searchText

  const feedPlan =
    query.readScope === "public_feed"
      ? getPublicFeedReadPlan(query.readPolicy?.maxRelays)
      : undefined
  const productSearchRelayUrls =
    feedPlan?.relayUrls.slice(0, 1) ?? config.searchIndexRelayUrls.slice(0, 1)
  const relayPlan =
    query.readScope === "public_feed"
      ? {
          ...feedPlan!,
          candidateRelayUrls: query.searchText
            ? productSearchRelayUrls
            : feedPlan!.candidateRelayUrls,
          relayTargets: query.searchText
            ? feedPlan!.relayTargets.slice(0, 1)
            : feedPlan!.relayTargets,
        }
      : query.searchText
        ? {
            candidateRelayUrls: productSearchRelayUrls,
            relayTargets: configuredRelayTargets(
              {
                kind: "app",
                operation: "read",
                bucket: "search_index",
              },
              productSearchRelayUrls
            ),
            maxRelayAttempts: productSearchRelayUrls.length,
            ownerSelectedRelayUrls: [],
            appRelayUrls: productSearchRelayUrls,
            personalRelayUrls: [],
            independentRelayUrls: [],
          }
        : await planCommerceReadRelayPlan({
            readScope: query.readScope,
            intent:
              query.authors && query.authors.length > 0
                ? "author_products"
                : "commerce_products",
            authors: query.authors,
            authenticatedPubkey: query.authenticatedPubkey,
            accountPubkey: query.accountPubkey,
            maxRelays: query.extraRelayUrls?.length
              ? Math.min(
                  query.readPolicy?.maxRelays ?? DEFAULT_READ_FANOUT,
                  DEFAULT_READ_FANOUT
                )
              : query.readPolicy?.maxRelays,
            shouldContinue: query.shouldContinue,
            signal: query.signal,
            extraRelayUrls: query.extraRelayUrls,
          })

  const result = await runFetchEventsFanoutDetailed(filter, {
    relayUrls: relayPlan.candidateRelayUrls,
    relayTargets: relayPlan.relayTargets,
    maxRelayAttempts: relayPlan.maxRelayAttempts,
    accountPubkey: query.accountPubkey ?? query.authenticatedPubkey,
    authenticatedPubkey: query.authenticatedPubkey,
    accountNetworkLocalStateRepository:
      testOverrides.accountNetworkLocalStateRepository,
    shouldContinue: query.shouldContinue,
    signal: query.signal,
    preserveEventOrder: !!query.searchText,
    connectTimeoutMs: query.readPolicy?.connectTimeoutMs ?? 4_000,
    fetchTimeoutMs: query.readPolicy?.fetchTimeoutMs ?? 8_000,
  })
  query.onTransportStatus?.(result.degraded, result.capped)
  query.onReadCoverage?.(result.coverage)

  const deletionTimestamps = query.localDeletionEvidenceOnly
    ? await getLocalProductDeletionTimestamps(
        undefined,
        uniqueStrings(result.events.map((event) => event.pubkey))
      )
    : await fetchProductDeletionTimestamps(
        [
          ...result.events.map(deletionCandidateFromEvent),
          ...(query.deletionCandidates ?? []).map(deletionCandidateFromRecord),
        ],
        {
          readScope: query.readScope,
          onReadCoverage: (coverage) =>
            query.onTransportStatus?.(coverage !== "complete", false),
          readPolicy: query.deletionReadPolicy ?? query.readPolicy,
          fallbackWhenEmpty: query.deletionFallbackWhenEmpty,
          authenticatedPubkey: query.authenticatedPubkey,
          accountPubkey: query.accountPubkey,
          shouldContinue: query.shouldContinue,
          signal: query.signal,
        }
      )
  return dedupeProductEvents(
    result.events,
    deletionTimestamps,
    query.retainRevisions
  )
}

async function fetchPublicProductRecordsProgressive(
  query: {
    readScope?: PublicReadScope
    retainRevisions?: boolean
    authors?: string[]
    ids?: string[]
    dTags?: string[]
    deletionCandidates?: CommerceProductRecord[]
    parentAddresses?: string[]
    authenticatedPubkey?: string | null
    accountPubkey?: string | null
    signal?: AbortSignal
    shouldContinue?: () => boolean
    limit?: number
    readPolicy?: CommerceReadPolicy
    onTransportStatus?: (degraded: boolean, capped: boolean) => void
  },
  onRecords: (
    records: CommerceProductRecord[],
    relayUrl: string
  ) => void | Promise<void>
): Promise<CommerceProductRecord[]> {
  if (testOverrides.fetchPublicEvents) {
    const records = await fetchPublicProductRecords(query)
    query.signal?.throwIfAborted()
    await onRecords(records, "test")
    return records
  }

  const filter: Filter = {
    kinds: [EVENT_KINDS.PRODUCT],
  }

  if (query.limit !== undefined) filter.limit = query.limit
  if (query.ids) filter.ids = query.ids
  if (query.dTags) filter["#d"] = query.dTags
  if (query.parentAddresses) filter["#a"] = query.parentAddresses

  const authorChunks =
    query.authors && query.authors.length > 0
      ? chunkStrings(uniqueStrings(query.authors), PRODUCT_AUTHOR_CHUNK_SIZE)
      : [undefined]
  const relayPlan = await planCommerceReadRelayPlan({
    readScope: query.readScope,
    intent:
      query.authors && query.authors.length > 0
        ? "author_products"
        : "commerce_products",
    authors: query.authors,
    authenticatedPubkey: query.authenticatedPubkey,
    accountPubkey: query.accountPubkey,
    maxRelays: query.readPolicy?.maxRelays,
    relayHintMode: "skip",
    shouldContinue: query.shouldContinue,
    signal: query.signal,
  })
  const merged = new Map<string, SignedPublicNostrEvent>()
  const recordsByEventId = new Map<string, CommerceProductRecord>()
  const initialDeletionTimestamps = await getLocalProductDeletionTimestamps(
    undefined,
    query.authors
  )
  const shouldExpandRelayHints =
    query.authors && query.authors.length > BROAD_AUTHOR_HINT_LIMIT
  const expandedRelayPlanPromise = shouldExpandRelayHints
    ? planCommerceReadRelayPlan({
        readScope: query.readScope,
        intent: "author_products",
        authors: query.authors,
        authenticatedPubkey: query.authenticatedPubkey,
        accountPubkey: query.accountPubkey,
        maxRelays: query.readPolicy?.maxRelays,
        relayHintMode: "force",
        shouldContinue: query.shouldContinue,
        signal: query.signal,
      })
    : Promise.resolve(relayPlan)
  void expandedRelayPlanPromise.catch(() => undefined)

  await streamProductRecordChunks({
    readScope: query.readScope,
    baseFilter: filter,
    authorChunks,
    relayUrls: relayPlan.candidateRelayUrls,
    relayTargets: relayPlan.relayTargets,
    maxRelayAttempts: relayPlan.maxRelayAttempts,
    authenticatedPubkey: query.authenticatedPubkey,
    accountPubkey: query.accountPubkey,
    shouldContinue: query.shouldContinue,
    signal: query.signal,
    readPolicy: query.readPolicy,
    merged,
    recordsByEventId,
    deletionTimestamps: initialDeletionTimestamps,
    retainRevisions: query.retainRevisions,
    onRecords,
    onTransportStatus: query.onTransportStatus,
  })

  const expandedRelayPlan = await expandedRelayPlanPromise
  const initialRelayUrlSet = new Set(relayPlan.candidateRelayUrls)
  const expansionRelayUrls = expandedRelayPlan.candidateRelayUrls.filter(
    (relayUrl) => !initialRelayUrlSet.has(relayUrl)
  )
  if (expansionRelayUrls.length > 0) {
    const expansionRelayUrlSet = new Set(expansionRelayUrls)
    await streamProductRecordChunks({
      readScope: query.readScope,
      baseFilter: filter,
      authorChunks,
      relayUrls: expansionRelayUrls,
      relayTargets: expandedRelayPlan.relayTargets.filter((target) =>
        expansionRelayUrlSet.has(target.url)
      ),
      maxRelayAttempts: expandedRelayPlan.maxRelayAttempts,
      authenticatedPubkey: query.authenticatedPubkey,
      accountPubkey: query.accountPubkey,
      shouldContinue: query.shouldContinue,
      signal: query.signal,
      readPolicy: query.readPolicy,
      merged,
      recordsByEventId,
      deletionTimestamps: initialDeletionTimestamps,
      retainRevisions: query.retainRevisions,
      onRecords,
      onTransportStatus: query.onTransportStatus,
    })
  }

  const mergedEvents = Array.from(merged.values())
  const deletionTimestamps = await fetchProductDeletionTimestamps(
    [
      ...mergedEvents.map(deletionCandidateFromEvent),
      ...(query.deletionCandidates ?? []).map(deletionCandidateFromRecord),
    ],
    {
      readScope: query.readScope,
      onReadCoverage: (coverage) =>
        query.onTransportStatus?.(coverage !== "complete", false),
      readPolicy: query.readPolicy,
      authenticatedPubkey: query.authenticatedPubkey,
      accountPubkey: query.accountPubkey,
      shouldContinue: query.shouldContinue,
      signal: query.signal,
    }
  )
  const resolved = dedupeProductEvents(
    mergedEvents,
    deletionTimestamps,
    query.retainRevisions
  )
  return resolved
}

export async function getFollowPubkeys(
  query: FollowListQuery
): Promise<FollowListResult> {
  const pubkey = query.pubkey.trim()
  if (!pubkey) {
    return {
      data: [],
      meta: {
        ...createMeta("profile_batch", "public", PROFILE_CAPABILITIES, {
          stale: true,
          degraded: true,
        }),
        eventObserved: false,
        coverage: "unavailable",
        snapshotState: "none",
      },
    }
  }

  const readFollowLists =
    testOverrides.readLatestFollowLists ?? readLatestFollowLists
  const result = await readFollowLists(
    {
      pubkeys: [pubkey],
      accountPubkey: query.accountPubkey,
      authenticatedPubkey: query.authenticatedPubkey,
    },
    {
      readScope: query.readScope,
      now: testOverrides.now,
      accountNetworkLocalStateRepository:
        testOverrides.accountNetworkLocalStateRepository,
      shouldContinue: query.shouldContinue,
    }
  )
  const author = result.authors[0]
  const selectedEvent = author?.event
  const eventTimestampPlausible = isPlausibleFollowListEventTimestamp(
    selectedEvent,
    testOverrides.now
  )
  const latestEvent = eventTimestampPlausible ? selectedEvent : undefined
  const hiddenFutureSnapshot = selectedEvent !== undefined && !latestEvent
  const incomplete = author?.coverage !== "complete" || hiddenFutureSnapshot
  const coverage = hiddenFutureSnapshot
    ? "limited"
    : (author?.coverage ?? "unavailable")
  const retainedSnapshot =
    author?.snapshotState === "observed" || author?.snapshotState === "pending"

  return {
    data: extractFollowPubkeys(latestEvent?.tags),
    event: latestEvent,
    meta: {
      ...createMeta(
        "profile_batch",
        retainedSnapshot ? "local_cache" : "public",
        PROFILE_CAPABILITIES,
        {
          stale: incomplete,
          degraded: incomplete,
          capped: !!author?.capped,
        }
      ),
      eventObserved: latestEvent !== undefined,
      eventCreatedAt: latestEvent?.created_at,
      eventId: latestEvent?.id,
      coverage,
      snapshotState: author?.snapshotState ?? "none",
    },
  }
}

function marketplaceReadDependencies(): MarketplaceReadDependencies {
  return {
    fetchPublicProductRecords,
    fetchPublicProductRecordsProgressive,
    mergeCachedAndLiveProductRecords,
    readProductsByIds,
    rethrowProductReadAuthorityChange,
    now,
    getSearchRelayUrls: () => getPublicFeedReadPlan().relayUrls.slice(0, 1),
    createMeta: (source, options, sortModes) =>
      createMeta(
        "marketplace_products",
        source,
        sortModes
          ? { ...PRODUCT_CAPABILITIES, sortModes }
          : PRODUCT_CAPABILITIES,
        options
      ),
  }
}
export async function getMarketplaceProducts(
  query: MarketplaceProductsQuery = {}
): Promise<CommerceResult<CommerceProductRecord[]>> {
  return readMarketplaceProducts(
    { ...query, readScope: "public_feed" },
    marketplaceReadDependencies()
  )
}
export async function getMarketplaceProductsProgressive(
  query: MarketplaceProductsQuery = {},
  onProgress: (
    result: CommerceResult<CommerceProductRecord[]>,
    relayUrl: string
  ) => void
): Promise<CommerceResult<CommerceProductRecord[]>> {
  return readMarketplaceProductsProgressive(
    { ...query, readScope: "public_feed" },
    onProgress,
    marketplaceReadDependencies()
  )
}
export async function getCachedMarketplaceProducts(
  query: MarketplaceProductsQuery = {},
  options: CachedProductReadOptions = { includeStale: true }
): Promise<CommerceResult<CommerceProductRecord[]>> {
  return readCachedMarketplaceProducts(
    query,
    options,
    marketplaceReadDependencies()
  )
}

function storefrontReadDependencies(): StorefrontReadDependencies {
  return {
    fetchPublicProductRecords,
    mergeCachedAndLiveProductRecords,
    createMeta: (source, options) =>
      createMeta("merchant_storefront", source, PRODUCT_CAPABILITIES, options),
    now,
  }
}

export async function getMerchantStorefront(
  query: MerchantStorefrontQuery
): Promise<CommerceResult<CommerceProductRecord[]>> {
  return readMerchantStorefront(query, storefrontReadDependencies())
}

export async function getCachedMerchantStorefront(
  query: MerchantStorefrontQuery,
  options: CachedProductReadOptions = { includeStale: true }
): Promise<CommerceResult<CommerceProductRecord[]>> {
  return readCachedMerchantStorefront(
    query,
    options,
    storefrontReadDependencies()
  )
}

async function fetchVariationGroupRecords(
  target: CommerceProductRecord,
  accountPubkey?: string | null,
  authenticatedPubkey?: string | null,
  shouldContinue?: () => boolean,
  relayHints: readonly string[] = [],
  readScope?: PublicReadScope
): Promise<{
  records: CommerceProductRecord[]
  degraded: boolean
  capped: boolean
}> {
  if (target.product.type === "simple") {
    return { records: [], degraded: false, capped: false }
  }

  const parentAddress =
    target.product.type === "variable"
      ? target.addressId
      : target.product.parentProductId
  const parsedParent = parentAddress ? parseAddress(parentAddress) : null
  if (
    !parentAddress ||
    !parsedParent ||
    parsedParent.kind !== EVENT_KINDS.PRODUCT ||
    parsedParent.pubkey !== target.product.pubkey
  ) {
    return { records: [], degraded: true, capped: false }
  }

  let transportDegraded = false
  let readCapped = false
  const extraRelayUrls = normalizePublicOrIsolatedE2eRelayHints(
    uniqueStrings([...relayHints, ...(target.sourceRelayUrls ?? [])])
  ).slice(0, MAX_PRODUCT_RELAY_HINTS)
  const [parents, variations] = await Promise.all([
    target.product.type === "variation"
      ? fetchPublicProductRecords({
          readScope,
          authors: [parsedParent.pubkey],
          dTags: [parsedParent.d],
          accountPubkey,
          authenticatedPubkey,
          shouldContinue,
          extraRelayUrls,
          limit: 10,
          onTransportStatus: (degraded, capped) => {
            transportDegraded ||= degraded
            readCapped ||= capped
          },
        })
      : Promise.resolve([]),
    fetchPublicProductRecords({
      readScope,
      authors: [parsedParent.pubkey],
      parentAddresses: [parentAddress],
      accountPubkey,
      authenticatedPubkey,
      shouldContinue,
      extraRelayUrls,
      limit: PRODUCT_VARIATION_EVENT_LIMIT,
      onTransportStatus: (degraded, capped) => {
        transportDegraded ||= degraded
        readCapped ||= capped
      },
    }),
  ])
  const capped =
    readCapped || variations.length >= PRODUCT_VARIATION_EVENT_LIMIT
  return {
    records: [...parents, ...variations],
    degraded: transportDegraded || capped,
    capped,
  }
}

async function fetchVariationGroupRecordBatch(
  targets: readonly CommerceProductRecord[],
  relayHintsByParent: ReadonlyMap<string, readonly string[]>,
  options: ProductsByIdsOptions = {},
  preparedRelayLists: Awaited<ReturnType<typeof preloadExactProductRelayLists>>
): Promise<{
  records: CommerceProductRecord[]
  capped: boolean
  invalidTargetAddressIds: ReadonlySet<string>
  degradedParentAddresses: ReadonlySet<string>
}> {
  if (targets.length === 0) {
    return {
      records: [],
      capped: false,
      invalidTargetAddressIds: new Set(),
      degradedParentAddresses: new Set(),
    }
  }

  const validTargets: Array<{
    target: CommerceProductRecord
    author: string
    parentAddress: string
    parentDTag: string
    relayHints: string[]
    plannedRelayHints: string[]
  }> = []
  const invalidTargetAddressIds = new Set<string>()
  for (const target of targets) {
    const parentAddress = getVariationParentAddress(target)
    const parsedParent = parentAddress ? parseAddress(parentAddress) : null
    if (
      !parentAddress ||
      !parsedParent ||
      parsedParent.kind !== EVENT_KINDS.PRODUCT ||
      parsedParent.pubkey !== target.product.pubkey
    ) {
      invalidTargetAddressIds.add(target.addressId)
      continue
    }
    const relayHints = normalizePublicOrIsolatedE2eRelayHints(
      uniqueStrings([
        ...(relayHintsByParent.get(parentAddress) ?? []),
        ...(target.sourceRelayUrls ?? []),
      ])
    )
    validTargets.push({
      target,
      author: parsedParent.pubkey,
      parentAddress,
      parentDTag: parsedParent.d,
      relayHints,
      plannedRelayHints: relayHints.slice(0, MAX_PRODUCT_RELAY_HINTS),
    })
  }

  if (validTargets.length === 0) {
    return {
      records: [],
      capped: false,
      invalidTargetAddressIds,
      degradedParentAddresses: new Set(),
    }
  }

  // Reuse the prepared NIP-65 relay lists across narrow family plans.
  const {
    relayLists: sharedRelayLists,
    unavailableAuthors: relayListUnavailableAuthors,
  } = preparedRelayLists
  const targetsByFamilyPlan = new Map<string, typeof validTargets>()
  for (const target of validTargets) {
    const key = JSON.stringify([target.author, target.plannedRelayHints])
    const familyTargets = targetsByFamilyPlan.get(key) ?? []
    familyTargets.push(target)
    targetsByFamilyPlan.set(key, familyTargets)
  }
  const plannedFamilies = await mapWithConcurrency(
    Array.from(targetsByFamilyPlan.values()),
    PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
    async (familyTargets) => {
      if (relayListUnavailableAuthors.has(familyTargets[0]!.author)) {
        return { targets: familyTargets, relayPlan: null }
      }
      try {
        return {
          targets: familyTargets,
          relayPlan: await planCommerceReadRelayPlan({
            readScope: options.readScope,
            intent: "author_products",
            authors: [familyTargets[0]!.author],
            authenticatedPubkey: options.authenticatedPubkey,
            accountPubkey: options.accountPubkey ?? options.authenticatedPubkey,
            shouldContinue: options.shouldContinue,
            signal: options.signal,
            extraRelayUrls: familyTargets[0]!.plannedRelayHints,
            relayHintMode: "force",
            maxRelays: DEFAULT_READ_FANOUT,
            relayLists: sharedRelayLists,
          }),
        }
      } catch (error) {
        rethrowProductReadAuthorityChange(error, options.shouldContinue)
        return { targets: familyTargets, relayPlan: null }
      }
    }
  )
  type FamilyReadBatch = {
    targets: typeof validTargets
    relayPlan: CommerceReadRelayPlan
  }
  // Only families with the same complete executable and parked plans share a
  // transport read. Distinct author/source perspectives remain independent.
  const compatibleFamilyBatches = new Map<string, FamilyReadBatch>()
  const planningDegradedParentAddresses = new Set<string>()
  for (const plannedFamily of plannedFamilies) {
    const relayPlan = plannedFamily.relayPlan
    if (!relayPlan) {
      for (const target of plannedFamily.targets) {
        planningDegradedParentAddresses.add(target.parentAddress)
      }
      continue
    }
    const key = JSON.stringify([
      relayPlan.relayUrls,
      relayPlan.parkedRelayUrls,
      relayPlan.hintRelayUrls,
      relayPlan.ownerSelectedRelayUrls,
    ])
    const existing = compatibleFamilyBatches.get(key)
    if (existing) existing.targets.push(...plannedFamily.targets)
    else {
      compatibleFamilyBatches.set(key, {
        targets: plannedFamily.targets,
        relayPlan,
      })
    }
  }
  const familyReadBatches = Array.from(
    compatibleFamilyBatches.values()
  ).flatMap((batch) =>
    chunkStrings(
      uniqueStrings(batch.targets.map((target) => target.author)),
      PRODUCT_AUTHOR_CHUNK_SIZE
    ).map((authors) => {
      const authorSet = new Set(authors)
      return {
        relayPlan: batch.relayPlan,
        targets: batch.targets.filter((target) => authorSet.has(target.author)),
      }
    })
  )
  type FamilyRead = {
    records: CommerceProductRecord[]
    degradedParentAddresses: Set<string>
    cappedParentAddresses: Set<string>
  }
  const readTargets = async (batch: FamilyReadBatch): Promise<FamilyRead> => {
    const { targets: chunkTargets, relayPlan } = batch
    const authors = uniqueStrings(chunkTargets.map((target) => target.author))
    const parentAddresses = uniqueStrings(
      chunkTargets.map((target) => target.parentAddress)
    )
    const parentDTags = uniqueStrings(
      chunkTargets.flatMap((target) =>
        target.target.product.type === "variation" ? [target.parentDTag] : []
      )
    )
    const degradedParentAddresses = new Set<string>()
    const cappedParentAddresses = new Set<string>()

    try {
      // Each transport-safe chunk starts with at most two family reads.
      // Saturated results split below without increasing concurrency.
      const fetchOptions = {
        relayUrls: relayPlan.candidateRelayUrls,
        relayTargets: relayPlan.relayTargets,
        maxRelayAttempts: relayPlan.maxRelayAttempts,
        accountPubkey: options.accountPubkey ?? options.authenticatedPubkey,
        authenticatedPubkey: options.authenticatedPubkey,
        accountNetworkLocalStateRepository:
          testOverrides.accountNetworkLocalStateRepository,
        shouldContinue: options.shouldContinue,
        signal: options.signal,
        connectTimeoutMs: 4_000,
        fetchTimeoutMs: 8_000,
      }
      const [parentRead, variationRead] = await Promise.all([
        parentDTags.length > 0
          ? runFetchEventsFanoutWithDiagnostics(
              {
                kinds: [EVENT_KINDS.PRODUCT],
                authors,
                "#d": parentDTags,
                limit: PRODUCT_VARIATION_EVENT_LIMIT,
              },
              fetchOptions
            ).catch(() => null)
          : Promise.resolve(null),
        runFetchEventsFanoutWithDiagnostics(
          {
            kinds: [EVENT_KINDS.PRODUCT],
            authors,
            "#a": parentAddresses,
            limit: PRODUCT_VARIATION_EVENT_LIMIT,
          },
          fetchOptions
        ).catch(() => null),
      ])
      const consideredRelayUrls = uniqueStrings([
        ...relayPlan.relayUrls,
        ...relayPlan.parkedRelayUrls,
      ])
      const consideredRelayUrlSet = new Set(consideredRelayUrls)
      const parentReadCapped =
        (parentRead?.cappedRelayUrls?.length ?? 0) > 0 ||
        (parentRead?.events.length ?? 0) >= PRODUCT_VARIATION_EVENT_LIMIT
      const variationReadCapped =
        (variationRead?.cappedRelayUrls?.length ?? 0) > 0 ||
        (variationRead?.events.length ?? 0) >= PRODUCT_VARIATION_EVENT_LIMIT

      // A shared response limit says nothing about any individual family.
      // Split saturated reads until each family's coverage is independent.
      // Sequential subdivision keeps the outer chunk concurrency bound.
      if (
        (parentReadCapped || variationReadCapped) &&
        parentAddresses.length > 1
      ) {
        const midpoint = Math.ceil(parentAddresses.length / 2)
        const firstAddresses = new Set(parentAddresses.slice(0, midpoint))
        const first = await readTargets({
          relayPlan,
          targets: chunkTargets.filter((target) =>
            firstAddresses.has(target.parentAddress)
          ),
        })
        const second = await readTargets({
          relayPlan,
          targets: chunkTargets.filter(
            (target) => !firstAddresses.has(target.parentAddress)
          ),
        })
        return {
          records: Array.from(
            selectLatestProductRecordsByAddress([
              ...dedupeProductEvents([
                ...(parentRead?.events ?? []),
                ...(variationRead?.events ?? []),
              ]),
              ...first.records,
              ...second.records,
            ]).values()
          ),
          degradedParentAddresses: new Set([
            ...first.degradedParentAddresses,
            ...second.degradedParentAddresses,
          ]),
          cappedParentAddresses: new Set([
            ...first.cappedParentAddresses,
            ...second.cappedParentAddresses,
          ]),
        }
      }

      for (const target of chunkTargets) {
        const relevantRelayHints = uniqueStrings([
          ...target.relayHints,
          ...relayPlan.hintRelayUrls,
        ])
        const expectedRelayUrls = uniqueStrings([
          ...consideredRelayUrls,
          ...relevantRelayHints,
        ])
        const variationCoverage = variationRead
          ? productAvailabilityCoverageFromFanout(
              variationRead,
              expectedRelayUrls
            )
          : "unavailable"
        const parentCoverage =
          target.target.product.type === "variable"
            ? "complete"
            : parentRead
              ? productAvailabilityCoverageFromFanout(
                  parentRead,
                  expectedRelayUrls
                )
              : "unavailable"
        const capped =
          relevantRelayHints.some(
            (relayUrl) => !consideredRelayUrlSet.has(relayUrl)
          ) ||
          parentReadCapped ||
          variationReadCapped
        if (capped) cappedParentAddresses.add(target.parentAddress)
        if (
          capped ||
          mergeProductAvailabilityCoverage(
            parentCoverage,
            variationCoverage
          ) !== "complete"
        ) {
          degradedParentAddresses.add(target.parentAddress)
        }
      }

      return {
        records: (() => {
          try {
            return dedupeProductEvents([
              ...(parentRead?.events ?? []),
              ...(variationRead?.events ?? []),
            ])
          } catch {
            return []
          }
        })(),
        degradedParentAddresses,
        cappedParentAddresses,
      }
    } catch {
      return {
        records: [] as CommerceProductRecord[],
        degradedParentAddresses: new Set(parentAddresses),
        cappedParentAddresses,
      }
    }
  }
  const chunkReads = await mapWithConcurrency(
    familyReadBatches,
    PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
    readTargets
  )
  const degradedParentAddresses = new Set(planningDegradedParentAddresses)
  const cappedParentAddresses = new Set<string>()
  for (const chunkRead of chunkReads) {
    for (const address of chunkRead.degradedParentAddresses) {
      degradedParentAddresses.add(address)
    }
    for (const address of chunkRead.cappedParentAddresses) {
      cappedParentAddresses.add(address)
    }
  }
  const records = chunkReads.flatMap((chunkRead) => chunkRead.records)
  return {
    records,
    capped: cappedParentAddresses.size > 0,
    invalidTargetAddressIds,
    degradedParentAddresses,
  }
}

function productDetailReadDependencies(): ProductDetailReadDependencies {
  return {
    fetchPublicProductRecords,
    fetchVariationGroupRecords,
    fetchDeletionTimestampsForProductRecords,
    mergeCachedAndLiveProductRecords,
    hasCompleteLiveVariationGroupCoverage,
    getMerchantStorefront,
    createMeta: (source, options) =>
      createMeta("product_detail", source, PRODUCT_CAPABILITIES, options),
    now,
  }
}

export async function getProductDetail(
  query: ProductDetailQuery
): Promise<CommerceResult<CommerceProductRecord | null>> {
  return readProductDetail(query, productDetailReadDependencies())
}

/** Typed reason a requested product coordinate is not authoritatively live. */
export type ProductAvailabilityIssue =
  | "invalid_product_reference"
  | "lookup_unavailable"
  | "lookup_partial"
  | "product_missing"
  | "listing_filtered"
  | "cached_only"
  | "pending"

export interface ProductAvailabilityDiagnostic {
  /** The productId exactly as requested by the caller. */
  productId: string
  addressId: string | null
  /** Null only when a selected version has adequate positive live evidence. */
  issue: ProductAvailabilityIssue | null
  /** Relay coverage is evidence, not a claim of global Nostr completeness. */
  coverage?: {
    listing: ProductAvailabilityCoverage
    deletion: ProductAvailabilityCoverage
  }
}

export interface ProductsByIdsResult extends CommerceResult<
  CommerceProductRecord[]
> {
  diagnostics: ProductAvailabilityDiagnostic[]
}

export type ProductAvailabilityCoverage = "complete" | "partial" | "unavailable"

/**
 * Positive live evidence for one exact listing coordinate. This does not claim
 * complete relay coverage, global freshness, or an inventory reservation.
 */
export function hasExactLiveProductAvailabilityEvidence(
  diagnostic: ProductAvailabilityDiagnostic | undefined,
  expectedAddressId: string
): boolean {
  return (
    expectedAddressId.length > 0 &&
    diagnostic?.addressId === expectedAddressId &&
    diagnostic.issue === null &&
    diagnostic.coverage !== undefined &&
    diagnostic.coverage.listing !== "unavailable"
  )
}

function productAvailabilityCoverageFromFanout(
  result: Awaited<ReturnType<typeof fetchPublicEventsWithDiagnostics>>,
  expectedRelayUrls: readonly string[] = []
): ProductAvailabilityCoverage {
  if (result.successfulRelayUrls.length === 0) return "unavailable"
  const attempted = new Set(result.attemptedRelayUrls)
  if (
    result.failedRelayUrls.length > 0 ||
    expectedRelayUrls.some((relayUrl) => !attempted.has(relayUrl))
  ) {
    return "partial"
  }
  return "complete"
}

function mergeProductAvailabilityCoverage(
  current: ProductAvailabilityCoverage,
  next: ProductAvailabilityCoverage
): ProductAvailabilityCoverage {
  if (current === "unavailable" || next === "unavailable") {
    return "unavailable"
  }
  if (current === "partial" || next === "partial") return "partial"
  return "complete"
}

function aggregateProductAvailabilityCoverage(
  coverages: readonly ProductAvailabilityCoverage[]
): ProductAvailabilityCoverage {
  if (
    coverages.length === 0 ||
    coverages.every((value) => value === "unavailable")
  ) {
    return "unavailable"
  }
  return coverages.every((value) => value === "complete")
    ? "complete"
    : "partial"
}

// Resolve many product listings by addressId in a single relay fanout (instead
// of one read per id). Used to hydrate order-item name/image without hammering
// relays with N separate reads. Every requested coordinate gets a typed
// diagnostic so checkout can distinguish unreachable relays, partial reads,
// cache-only confirmation, filtered listings, malformed references, and truly
// missing listings instead of one generic failure.
// Ranked search may provide already verified records when persistence failed.
async function readProductsByIds(
  productIds: string[],
  options: ProductsByIdsOptions,
  verifiedRecords: readonly CommerceProductRecord[] = []
): Promise<ProductsByIdsResult> {
  const callerShouldContinue = options.shouldContinue
  const signal = options.signal
  signal?.throwIfAborted()
  if (signal) {
    options = {
      ...options,
      shouldContinue: () =>
        !signal.aborted && callerShouldContinue?.() !== false,
    }
  }

  const lookups = productIds.map((productId) => {
    const { address, addressId } = getProductLookupIds(productId)
    const valid = !!address && address.kind === EVENT_KINDS.PRODUCT
    return {
      productId,
      address: valid
        ? {
            ...address,
            relayHints: [
              ...address.relayHints,
              ...(addressId
                ? (options.relayHintsByAddressId?.[addressId] ?? [])
                : []),
            ],
          }
        : null,
      addressId: valid ? addressId : null,
    }
  })
  const addresses = lookups
    .map((lookup) => lookup.address)
    .filter(
      (
        address
      ): address is {
        kind: number
        pubkey: string
        d: string
        relayHints: string[]
      } => address !== null
    )

  if (addresses.length === 0) {
    const result: ProductsByIdsResult = {
      data: [],
      meta: createMeta("product_detail", "commerce", PRODUCT_CAPABILITIES, {
        degraded: lookups.length > 0,
      }),
      diagnostics: lookups.map((lookup) => ({
        productId: lookup.productId,
        addressId: null,
        issue: "invalid_product_reference",
      })),
    }
    if (options.shouldContinue?.() !== false) options.onProgress?.(result)
    if (options.onCacheReady && options.shouldContinue?.() !== false)
      options.onCacheReady(result)
    return result
  }

  const authors = uniqueStrings(addresses.map((address) => address.pubkey))
  const wanted = new Set(lookups.flatMap((lookup) => lookup.addressId ?? []))
  const persisted = await getCachedExactProductRecords(
    [...wanted],
    verifiedRecords
  )
  const initialDeletions = await getLocalProductDeletionTimestamps(
    undefined,
    authors
  )
  const initialCached = mergeCachedAndLiveProductRecords({
    cached: persisted,
    live: [...verifiedRecords],
    deletionTimestamps: initialDeletions,
  })
  const context: ExactProductReadContext = {
    cached: initialCached,
    deletions: initialDeletions,
    relayLists: { relayLists: new Map(), unavailableAuthors: new Set() },
    completed: new Map(),
    async refreshCache(knownRecords = []) {
      // Retain validated live evidence for the whole invocation even when its
      // cache write failed. Its identities must remain lookup targets after a
      // sibling's newer revision changes parent or type.
      context.cached = mergeCachedAndLiveProductRecords({
        cached: context.cached,
        live: [...knownRecords],
        deletionTimestamps: context.deletions,
      })
      // Re-read retained family identities across authors so a later publication
      // can retract an earlier author's changed terms. This I/O runs independently
      // for each author; merge against current shared evidence after it settles.
      const persisted = await getCachedExactProductRecords(
        [...wanted],
        context.cached
      )
      context.cached = mergeCachedAndLiveProductRecords({
        cached: context.cached,
        live: persisted,
        deletionTimestamps: context.deletions,
      })
    },
    async refreshDeletions() {
      const persisted = await getLocalProductDeletionTimestamps(
        undefined,
        authors
      )
      context.deletions = mergeDeletionTimestamps(context.deletions, persisted)
      return context.deletions
    },
  }
  const snapshots = new Map<string, ProductsByIdsResult>()
  let latestPublished: ProductsByIdsResult | undefined
  const aggregate = (): ProductsByIdsResult => {
    const results = authors.map((author) => {
      const completed = context.completed.get(author)
      if (completed) return completed()
      const snapshot = snapshots.get(author)
      const authorWanted = new Set(
        lookups.flatMap((lookup) =>
          lookup.address?.pubkey === author && lookup.addressId
            ? [lookup.addressId]
            : []
        )
      )
      const records = mergeCachedAndLiveProductRecords({
        cached: context.cached.filter(
          (record) => record.product.pubkey === author
        ),
        live:
          snapshot?.data.flatMap((record) => [
            { ...record, family: undefined },
            ...(record.family?.children ?? []),
          ]) ?? [],
        deletionTimestamps: context.deletions,
      })
      const meta =
        snapshot?.meta ??
        createMeta("product_detail", "local_cache", PRODUCT_CAPABILITIES, {
          stale: true,
          degraded: true,
        })
      const selected = filterExactProductRecordsForRead(
        records,
        authorWanted,
        options
      )
      const selectedIds = new Set(selected.map((record) => record.addressId))
      return {
        data: withProductFamilyReadEvidence(selected, meta),
        meta,
        diagnostics:
          snapshot?.diagnostics ??
          lookups
            .filter((lookup) => lookup.address?.pubkey === author)
            .map((lookup) => ({
              productId: lookup.productId,
              addressId: lookup.addressId,
              issue: selectedIds.has(lookup.addressId!)
                ? ("cached_only" as const)
                : ("pending" as const),
              coverage: {
                listing: "unavailable" as const,
                deletion: "unavailable" as const,
              },
            })),
      }
    })
    const diagnosticsByProduct = new Map(
      results.flatMap((result) =>
        result.diagnostics.map((row) => [row.productId, row] as const)
      )
    )
    const pending = context.completed.size !== authors.length
    return {
      data: results.flatMap((result) => result.data),
      meta: {
        ...createMeta(
          "product_detail",
          results.some((result) => result.meta.source === "local_cache")
            ? "local_cache"
            : "commerce",
          PRODUCT_CAPABILITIES,
          {
            stale: pending || results.some((result) => result.meta.stale),
            degraded:
              pending ||
              lookups.some((lookup) => !lookup.addressId) ||
              results.some((result) => result.meta.degraded),
            capped: results.some((result) => result.meta.capped),
          }
        ),
        fetchedAt: Math.min(...results.map((result) => result.meta.fetchedAt)),
      },
      diagnostics: lookups.map(
        (lookup) =>
          diagnosticsByProduct.get(lookup.productId) ?? {
            productId: lookup.productId,
            addressId: null,
            issue: "invalid_product_reference",
          }
      ),
    }
  }
  const publish = () => {
    latestPublished = aggregate()
    options.onProgress?.(latestPublished)
  }
  // Cached families are available before relay-list discovery or queued authors.
  if (options.shouldContinue?.() === false)
    throw new NostrSignerError("authority_changed")
  if (initialCached.some((record) => wanted.has(record.addressId))) publish()
  if (options.onCacheReady && options.shouldContinue?.() !== false)
    options.onCacheReady(latestPublished ?? aggregate())
  context.relayLists = await preloadExactProductRelayLists(authors, options)
  // Non-observing callers retain cross-author family batching. Progressive
  // callers need independent author completion and share the same prepared stages.
  if (!options.onProgress)
    return readPreparedProductTargets(lookups, undefined, context, options)
  await mapWithConcurrency(
    authors,
    PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
    async (author) => {
      if (options.shouldContinue?.() === false)
        throw new NostrSignerError("authority_changed")
      await readPreparedProductTargets(
        lookups.filter((lookup) => lookup.address?.pubkey === author),
        author,
        context,
        {
          ...options,
          onProgress: (snapshot) => {
            if (options.shouldContinue?.() === false) return
            snapshots.set(author, snapshot)
            publish()
          },
        }
      )
    }
  )
  if (options.shouldContinue?.() === false)
    throw new NostrSignerError("authority_changed")
  return latestPublished ?? aggregate()
}

export async function getProductsByIds(
  productIds: string[],
  options: ProductsByIdsOptions = {}
): Promise<ProductsByIdsResult> {
  return readProductsByIds(productIds, options)
}

/** Shared preparation and publication state for one exact read invocation. */
type ExactProductLookup = {
  productId: string
  addressId: string | null
  address: {
    kind: number
    pubkey: string
    d: string
    relayHints: string[]
  } | null
}
type ExactProductReadContext = {
  cached: CommerceProductRecord[]
  deletions: DeletionTimestamps
  relayLists: Awaited<ReturnType<typeof preloadExactProductRelayLists>>
  completed: Map<string, () => ProductsByIdsResult>
  refreshCache(knownRecords?: readonly CommerceProductRecord[]): Promise<void>
  refreshDeletions(): Promise<DeletionTimestamps>
}

/** Complete exact listing, family and deletion stages for prepared targets. */
async function readPreparedProductTargets(
  lookups: ExactProductLookup[],
  author: string | undefined,
  context: ExactProductReadContext,
  options: ProductsByIdsOptions
): Promise<ProductsByIdsResult> {
  const addresses = lookups.flatMap((lookup) => lookup.address ?? [])
  const wanted = new Set(lookups.flatMap((lookup) => lookup.addressId ?? []))
  let cachedByAuthors = context.cached.filter(
    (record) => !author || record.product.pubkey === author
  )
  let cached = cachedByAuthors.filter((record) => wanted.has(record.addressId))
  // Checkout needs positive live evidence for the selected listing version.
  // Deletion reads preserve monotonic known evidence, but incomplete deletion
  // discovery alone is not a global absence proof and must not veto checkout.
  let listingCoverage: ProductAvailabilityCoverage = "unavailable"
  let deletionCoverage: ProductAvailabilityCoverage = "complete"
  let deletionTimestamps = context.deletions
  const routeRelayHintsByAddress = new Map<string, string[]>()
  const directReadTargetByAddress = new Map<
    string,
    {
      addressId: string
      author: string
      dTag: string
      relayHints: string[]
    }
  >()
  for (const address of addresses) {
    const addressId = `${address.kind}:${address.pubkey}:${address.d}`
    routeRelayHintsByAddress.set(
      addressId,
      normalizePublicOrIsolatedE2eRelayHints(
        uniqueStrings([
          ...(routeRelayHintsByAddress.get(addressId) ?? []),
          ...address.relayHints,
        ])
      ).slice(0, MAX_PRODUCT_RELAY_HINTS)
    )
    if (!directReadTargetByAddress.has(addressId)) {
      directReadTargetByAddress.set(addressId, {
        addressId,
        author: address.pubkey,
        dTag: address.d,
        relayHints: [],
      })
    }
  }
  // Shared pages persist the relay that supplied the exact listing. Checkout
  // later revalidates the canonical raw coordinate, so carry only the cached
  // provenance for each requested coordinate into its bounded read plan.
  for (const target of directReadTargetByAddress.values()) {
    const cachedRelayUrls = cached.flatMap((record) =>
      record.addressId === target.addressId
        ? (record.sourceRelayUrls ?? [])
        : []
    )
    target.relayHints = normalizePublicOrIsolatedE2eRelayHints(
      uniqueStrings([
        ...(routeRelayHintsByAddress.get(target.addressId) ?? []),
        ...cachedRelayUrls,
      ])
    ).slice(0, MAX_PRODUCT_RELAY_HINTS)
  }
  const directReadTargets = Array.from(directReadTargetByAddress.values())
  const listingCoverageByAddress = new Map<string, ProductAvailabilityCoverage>(
    Array.from(wanted, (addressId) => [addressId, "unavailable"] as const)
  )
  const {
    relayLists: directRelayLists,
    unavailableAuthors: relayListUnavailableAuthors,
  } = context.relayLists
  type DirectTargetGroup = {
    targets: typeof directReadTargets
    relayHints: string[]
  }
  const directTargetGroupsByAuthor = new Map<string, DirectTargetGroup[]>()
  for (const target of directReadTargets) {
    const authorGroups = directTargetGroupsByAuthor.get(target.author) ?? []
    const compatibleGroup = authorGroups.find(
      (group) =>
        (target.relayHints.length === 0
          ? group.relayHints.length === 0
          : group.relayHints.length > 0) &&
        uniqueStrings([...group.relayHints, ...target.relayHints]).length <=
          MAX_PRODUCT_RELAY_HINTS
    )
    if (compatibleGroup) {
      compatibleGroup.targets.push(target)
      compatibleGroup.relayHints = uniqueStrings([
        ...compatibleGroup.relayHints,
        ...target.relayHints,
      ])
    } else {
      authorGroups.push({ targets: [target], relayHints: target.relayHints })
    }
    directTargetGroupsByAuthor.set(target.author, authorGroups)
  }
  const directTargetGroups = Array.from(
    directTargetGroupsByAuthor.values()
  ).flat()
  const plannedDirectTargetGroups = await mapWithConcurrency(
    directTargetGroups,
    PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
    async (group) => {
      const author = group.targets[0]!.author
      if (relayListUnavailableAuthors.has(author)) {
        return { targets: group.targets, relayPlan: null }
      }
      try {
        return {
          targets: group.targets,
          relayPlan: await planCommerceReadRelayPlan({
            readScope: options.readScope,
            intent: "author_products",
            authors: [author],
            authenticatedPubkey: options.authenticatedPubkey,
            accountPubkey: options.accountPubkey ?? options.authenticatedPubkey,
            shouldContinue: options.shouldContinue,
            signal: options.signal,
            extraRelayUrls: group.relayHints,
            relayHintMode: "force",
            maxRelays: DEFAULT_READ_FANOUT,
            relayLists: directRelayLists,
          }),
        }
      } catch (error) {
        rethrowProductReadAuthorityChange(error, options.shouldContinue)
        return { targets: group.targets, relayPlan: null }
      }
    }
  )
  type DirectReadBatch = {
    targets: typeof directReadTargets
    relayPlan: CommerceReadRelayPlan
  }
  const compatibleDirectReadBatches = new Map<string, DirectReadBatch>()
  for (const plannedGroup of plannedDirectTargetGroups) {
    const relayPlan = plannedGroup.relayPlan
    if (!relayPlan) continue
    const key = JSON.stringify([
      plannedGroup.targets[0]!.author,
      relayPlan.relayUrls,
      relayPlan.parkedRelayUrls,
      relayPlan.hintRelayUrls,
      relayPlan.ownerSelectedRelayUrls,
    ])
    const existing = compatibleDirectReadBatches.get(key)
    if (existing) existing.targets.push(...plannedGroup.targets)
    else {
      compatibleDirectReadBatches.set(key, {
        targets: plannedGroup.targets,
        relayPlan,
      })
    }
  }
  const directReadEntries = Array.from(compatibleDirectReadBatches.values())
  let directReadCapped = false
  const progressiveEvents: SignedPublicNostrEvent[] = []
  let progressiveKnownRecords: CommerceProductRecord[] = []
  let progressPublication = Promise.resolve()
  const emitDirectProgress = (events: SignedPublicNostrEvent[]) => {
    if (!options.onProgress) return Promise.resolve()
    // Order one author's snapshots without making other authors await its
    // persistence. Shared signed evidence is merged synchronously after I/O.
    progressPublication = progressPublication.then(async () => {
      if (options.shouldContinue?.() === false) return
      progressiveEvents.push(...events)
      const observed = dedupeProductEvents(progressiveEvents)
      const currentDeletionTimestamps = await context.refreshDeletions()
      if (options.shouldContinue?.() === false) return
      try {
        // Publish shared cache evidence before notifying consumers that may
        // re-read it. This uses the same monotonic writer as the final result.
        await cacheProductRecords(
          filterDeletedProductRecords(observed, currentDeletionTimestamps)
        )
      } catch {
        // Storage failure must not discard a valid network browse snapshot.
      }
      if (options.shouldContinue?.() === false) return
      await context.refreshCache(observed)
      const currentFrontier = await context.refreshDeletions()
      if (options.shouldContinue?.() === false) return
      const merged = mergeCachedAndLiveProductRecords({
        cached: context.cached.filter(
          (record) => !author || record.product.pubkey === author
        ),
        live: [...progressiveKnownRecords, ...observed],
        deletionTimestamps: currentFrontier,
      })
      progressiveKnownRecords = merged
      const meta = createMeta(
        "product_detail",
        "commerce",
        PRODUCT_CAPABILITIES,
        {
          stale: true,
          degraded: true,
          capped: directReadCapped,
        }
      )
      const selected = filterExactProductRecordsForRead(merged, wanted, options)
      const selectedIds = new Set(selected.map((record) => record.addressId))
      options.onProgress?.({
        data: withProductFamilyReadEvidence(selected, meta),
        meta,
        diagnostics: lookups.map((lookup) => ({
          productId: lookup.productId,
          addressId: lookup.addressId,
          issue: !lookup.addressId
            ? "invalid_product_reference"
            : selectedIds.has(lookup.addressId)
              ? "lookup_partial"
              : "pending",
          ...(lookup.addressId
            ? {
                coverage: {
                  listing: "partial" as const,
                  deletion: "partial" as const,
                },
              }
            : {}),
        })),
      })
    })
    return progressPublication
  }
  const directReads = await mapWithConcurrency(
    directReadEntries,
    PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
    async ({ targets, relayPlan }) => {
      const directRead = await (async () => {
        try {
          const author = targets[0]!.author
          // Same-author coordinates only share a read when their complete relay
          // plans are compatible. Distinct source perspectives remain isolated
          // so one six-relay cap cannot discard another coordinate's only hint.
          const knownRelayHints = normalizePublicOrIsolatedE2eRelayHints(
            uniqueStrings(targets.flatMap((target) => target.relayHints))
          )
          const result = await runFetchEventsFanoutWithDiagnostics(
            {
              kinds: [EVENT_KINDS.PRODUCT],
              authors: [author],
              "#d": uniqueStrings(targets.map((target) => target.dTag)),
            },
            {
              relayUrls: relayPlan.candidateRelayUrls,
              relayTargets: relayPlan.relayTargets,
              maxRelayAttempts: relayPlan.maxRelayAttempts,
              accountPubkey:
                options.accountPubkey ?? options.authenticatedPubkey,
              authenticatedPubkey: options.authenticatedPubkey,
              accountNetworkLocalStateRepository:
                testOverrides.accountNetworkLocalStateRepository,
              shouldContinue: options.shouldContinue,
              signal: options.signal,
              connectTimeoutMs: 4_000,
              fetchTimeoutMs: 8_000,
            }
          )
          const consideredRelayUrls = uniqueStrings([
            ...relayPlan.relayUrls,
            ...relayPlan.parkedRelayUrls,
          ])
          const consideredRelayUrlSet = new Set(consideredRelayUrls)
          const completeRelayHints = uniqueStrings([
            ...knownRelayHints,
            ...relayPlan.hintRelayUrls,
          ])
          return {
            targets,
            events: result.events,
            capped:
              (result.cappedRelayUrls?.length ?? 0) > 0 ||
              completeRelayHints.some(
                (relayUrl) => !consideredRelayUrlSet.has(relayUrl)
              ),
            coverageByAddress: new Map(
              targets.map((target) => [
                target.addressId,
                productAvailabilityCoverageFromFanout(
                  result,
                  uniqueStrings([
                    ...consideredRelayUrls,
                    ...target.relayHints,
                    ...relayPlan.hintRelayUrls,
                  ])
                ),
              ])
            ),
          }
        } catch {
          return {
            targets,
            events: [],
            capped: false,
            coverageByAddress: new Map<string, ProductAvailabilityCoverage>(),
          }
        }
      })()
      directReadCapped ||= directRead.capped
      await emitDirectProgress(directRead.events)
      return directRead
    }
  )
  if (options.shouldContinue?.() === false)
    throw new NostrSignerError("authority_changed")
  const productEvents = directReads.flatMap((result) => result.events)
  for (const result of directReads) {
    directReadCapped ||= result.capped
    for (const target of result.targets) {
      listingCoverageByAddress.set(
        target.addressId,
        result.coverageByAddress.get(target.addressId) ?? "unavailable"
      )
    }
  }
  listingCoverage = aggregateProductAvailabilityCoverage(
    Array.from(listingCoverageByAddress.values())
  )

  const directRecords = (() => {
    try {
      return dedupeProductEvents(productEvents)
    } catch {
      return []
    }
  })()
  const knownFamilies = new Set(
    cached.flatMap((record) => getVariationParentAddress(record) ?? [])
  )
  if (
    directRecords.some((record) => {
      const parent = getVariationParentAddress(record)
      return (
        wanted.has(record.addressId) && parent && !knownFamilies.has(parent)
      )
    })
  ) {
    // Live topology may reveal a cached family after an absent or older simple
    // target. Load its context even without observation or a successful write.
    const familyCache = await getCachedExactProductRecords(
      [...wanted],
      directRecords
    )
    if (options.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
    cachedByAuthors = mergeCachedAndLiveProductRecords({
      cached: cachedByAuthors,
      live: familyCache,
      deletionTimestamps,
    })
    cached = cachedByAuthors.filter((record) => wanted.has(record.addressId))
  }
  const locallyVisibleDirectRecords = filterDeletedProductRecords(
    directRecords,
    deletionTimestamps
  )
  const directTargetCandidates = mergeCachedAndLiveProductRecords({
    cached,
    live: locallyVisibleDirectRecords,
    deletionTimestamps,
  }).filter((record) => wanted.has(record.addressId))
  const groupTargetsByParent = new Map<string, CommerceProductRecord>()
  const groupRequestedAddressesByParent = new Map<string, Set<string>>()
  const groupRelayHintsByParent = new Map<string, string[]>()
  for (const target of directTargetCandidates) {
    if (target.product.type === "simple") continue
    const parentAddress = getVariationParentAddress(target)
    if (parentAddress) {
      const requestedAddresses =
        groupRequestedAddressesByParent.get(parentAddress) ?? new Set<string>()
      requestedAddresses.add(target.addressId)
      groupRequestedAddressesByParent.set(parentAddress, requestedAddresses)
      groupRelayHintsByParent.set(
        parentAddress,
        normalizePublicOrIsolatedE2eRelayHints(
          uniqueStrings([
            ...(groupRelayHintsByParent.get(parentAddress) ?? []),
            ...(routeRelayHintsByAddress.get(target.addressId) ?? []),
            ...(target.sourceRelayUrls ?? []),
          ])
        )
      )
      if (!groupTargetsByParent.has(parentAddress)) {
        groupTargetsByParent.set(parentAddress, target)
      }
    }
  }
  const groupTargets = Array.from(groupTargetsByParent.values())
  const groupRead = await fetchVariationGroupRecordBatch(
    groupTargets,
    groupRelayHintsByParent,
    options,
    context.relayLists
  )
  if (options.shouldContinue?.() === false)
    throw new NostrSignerError("authority_changed")
  const groupRecords = groupRead.records

  if (
    productEvents.length > 0 ||
    groupRecords.length > 0 ||
    cachedByAuthors.length > 0
  ) {
    let deletionReadAttempted = false
    let deletionPlanSkippedRelay = false
    const fetchDeletionEventsWithCoverage: typeof runFetchEventsFanout = async (
      filter,
      fetchOptions
    ) => {
      const result = await runFetchEventsFanoutWithDiagnostics(filter, {
        ...fetchOptions,
        signal: options.signal,
      })
      const nextCoverage = productAvailabilityCoverageFromFanout(
        result,
        fetchOptions?.relayUrls
      )
      deletionCoverage = deletionReadAttempted
        ? mergeProductAvailabilityCoverage(deletionCoverage, nextCoverage)
        : nextCoverage
      deletionReadAttempted = true
      return result.events
    }
    try {
      deletionTimestamps = mergeDeletionTimestamps(
        deletionTimestamps,
        await fetchProductDeletionTimestamps(
          [
            ...productEvents.map(deletionCandidateFromEvent),
            ...groupRecords.map(deletionCandidateFromRecord),
            ...cachedByAuthors.map(deletionCandidateFromRecord),
          ],
          {
            accountPubkey: options.accountPubkey ?? options.authenticatedPubkey,
            shouldContinue: options.shouldContinue,
            signal: options.signal,
            readScope: options.readScope,
            fetchEvents: fetchDeletionEventsWithCoverage,
            onSkippedRelayUrls: (relayUrls) => {
              deletionPlanSkippedRelay ||= relayUrls.length > 0
            },
          }
        )
      )
      if (!deletionReadAttempted) deletionCoverage = "unavailable"
      else if (deletionPlanSkippedRelay) {
        deletionCoverage = mergeProductAvailabilityCoverage(
          deletionCoverage,
          "partial"
        )
      }
    } catch (error) {
      if (options.shouldContinue?.() === false) throw error
      deletionCoverage = "unavailable"
    }
  }

  const liveDirectRecords = filterDeletedProductRecords(
    directRecords,
    deletionTimestamps
  )
  const liveDirectAddressIds = new Set(
    liveDirectRecords.map((record) => record.addressId)
  )
  const hasCompleteLiveDirectCoverage = Array.from(wanted).every((addressId) =>
    liveDirectAddressIds.has(addressId)
  )
  const directTargets = mergeCachedAndLiveProductRecords({
    cached,
    live: liveDirectRecords,
    deletionTimestamps,
  }).filter((record) => wanted.has(record.addressId))
  const visibleGroupRecords = filterDeletedProductRecords(
    groupRecords,
    deletionTimestamps
  )
  const knownRecords = filterDeletedProductRecords(
    [...cachedByAuthors, ...directTargets],
    deletionTimestamps
  )
  const completeVariationCoverageByGroup = groupTargets.map((target) => {
    const parentAddress = getVariationParentAddress(target)
    return hasCompleteLiveVariationGroupCoverage({
      target,
      groupRead: {
        degraded:
          !parentAddress ||
          groupRead.degradedParentAddresses.has(parentAddress) ||
          groupRead.invalidTargetAddressIds.has(target.addressId),
        records: filterDeletedProductRecords(
          groupRead.records,
          deletionTimestamps
        ),
      },
      knownRecords,
      directRecords: liveDirectRecords,
    })
  })
  const hasCompleteLiveVariationCoverage =
    completeVariationCoverageByGroup.every(Boolean)
  for (
    let index = 0;
    index < completeVariationCoverageByGroup.length;
    index++
  ) {
    if (completeVariationCoverageByGroup[index]) continue
    const parentAddress = getVariationParentAddress(groupTargets[index]!)
    if (!parentAddress) continue
    for (const addressId of groupRequestedAddressesByParent.get(
      parentAddress
    ) ?? []) {
      listingCoverageByAddress.set(
        addressId,
        mergeProductAvailabilityCoverage(
          listingCoverageByAddress.get(addressId) ?? "unavailable",
          "partial"
        )
      )
    }
  }
  listingCoverage = aggregateProductAvailabilityCoverage(
    Array.from(listingCoverageByAddress.values())
  )
  const groupReadCapped = groupRead.capped
  const neededParentAddresses = new Set(groupTargetsByParent.keys())
  const cachedContext = cachedByAuthors.filter(
    (record) =>
      wanted.has(record.addressId) ||
      neededParentAddresses.has(record.addressId) ||
      (record.product.parentProductId
        ? neededParentAddresses.has(record.product.parentProductId)
        : false)
  )
  const liveContext = [...liveDirectRecords, ...visibleGroupRecords]
  const merged = mergeCachedAndLiveProductRecords({
    cached: cachedContext,
    live: liveContext,
    deletionTimestamps,
  })
  try {
    await cacheProductRecords(liveContext)
  } catch {
    // A cache write failure must not break the availability read itself.
  }
  const filtered = filterExactProductRecordsForRead(merged, wanted, options)

  const liveByAddress = new Map(
    liveDirectRecords.map((record) => [record.addressId, record] as const)
  )
  const filteredByAddress = new Map(
    filtered.map((record) => [record.addressId, record] as const)
  )
  const mergedAddressIds = new Set(merged.map((record) => record.addressId))
  const diagnostics: ProductAvailabilityDiagnostic[] = lookups.map((lookup) => {
    const lookupListingCoverage = lookup.addressId
      ? (listingCoverageByAddress.get(lookup.addressId) ?? "unavailable")
      : listingCoverage
    return {
      productId: lookup.productId,
      addressId: lookup.addressId,
      issue: resolveProductAvailabilityIssue({
        addressId: lookup.addressId,
        listingCoverage: lookupListingCoverage,
        liveByAddress,
        filteredByAddress,
        mergedAddressIds,
      }),
      ...(lookup.addressId
        ? {
            coverage: {
              listing: lookupListingCoverage,
              deletion: deletionCoverage,
            },
          }
        : {}),
    }
  })
  const degraded =
    listingCoverage !== "complete" ||
    deletionCoverage !== "complete" ||
    diagnostics.some((diagnostic) => diagnostic.issue !== null) ||
    !hasCompleteLiveDirectCoverage ||
    !hasCompleteLiveVariationCoverage
  const hasCacheOnlySelection = filtered.some(
    (record) => liveByAddress.get(record.addressId)?.eventId !== record.eventId
  )
  const source =
    listingCoverage === "unavailable" || hasCacheOnlySelection
      ? "local_cache"
      : "commerce"
  const completeLiveRead =
    hasCompleteLiveDirectCoverage &&
    hasCompleteLiveVariationCoverage &&
    listingCoverage === "complete" &&
    !hasCacheOnlySelection
  const meta = createMeta("product_detail", source, PRODUCT_CAPABILITIES, {
    stale: !completeLiveRead,
    degraded,
    capped: directReadCapped || groupReadCapped,
  })

  if (!options.onProgress) {
    return {
      data: withProductFamilyReadEvidence(filtered, meta),
      meta,
      diagnostics,
    }
  }
  const reconcile = (): ProductsByIdsResult => {
    const result = {
      data: withProductFamilyReadEvidence(filtered, meta),
      meta,
      diagnostics,
    }
    // Another read may learn a newer signed revision or deletion during this
    // batch. Never return older terms than a progressive snapshot already saw.
    const currentCached = context.cached.filter(
      (record) => record.product.pubkey === author
    )
    const currentFrontier = mergeDeletionTimestamps(
      deletionTimestamps,
      context.deletions
    )
    if (options.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
    const currentMerged = mergeCachedAndLiveProductRecords({
      cached: [],
      live: [...merged, ...progressiveKnownRecords, ...currentCached],
      deletionTimestamps: currentFrontier,
    })
    // A completed target can gain variants or change parent while another
    // author is pending. Select family context from the current signed winners.
    const currentParentAddresses = new Set(
      currentMerged.flatMap((record) => {
        if (!wanted.has(record.addressId)) return []
        const parentAddress = getVariationParentAddress(record)
        return parentAddress ? [parentAddress] : []
      })
    )
    const currentRecords = currentMerged.filter(
      (record) =>
        wanted.has(record.addressId) ||
        currentParentAddresses.has(record.addressId) ||
        (!!record.product.parentProductId &&
          currentParentAddresses.has(record.product.parentProductId))
    )
    const previousByAddress = new Map(
      merged.map((record) => [record.addressId, record])
    )
    if (
      currentRecords.length !== merged.length ||
      currentRecords.some(
        (record) =>
          previousByAddress.get(record.addressId)?.eventId !== record.eventId
      )
    ) {
      // Rebuild families from surviving current records as well as top-level
      // cards, so child withdrawals and deletions cannot remain in choices.
      const currentFiltered = filterExactProductRecordsForRead(
        currentRecords,
        wanted,
        options
      )
      const currentByAddress = new Map(
        currentFiltered.map((record) => [record.addressId, record])
      )
      const currentAddresses = new Set(
        currentRecords.map((record) => record.addressId)
      )
      const currentLiveByAddress = new Map(
        filterDeletedProductRecords(liveDirectRecords, currentFrontier).map(
          (record) => [record.addressId, record]
        )
      )
      result.diagnostics = result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        issue: resolveProductAvailabilityIssue({
          addressId: diagnostic.addressId,
          listingCoverage: diagnostic.coverage?.listing ?? "unavailable",
          liveByAddress: currentLiveByAddress,
          filteredByAddress: currentByAddress,
          mergedAddressIds: currentAddresses,
        }),
      }))
      const liveContextByAddress = new Map(
        liveContext.map((record) => [record.addressId, record])
      )
      const hasNewCacheOnlyTerms = currentFiltered.some(
        (record) =>
          currentLiveByAddress.get(record.addressId)?.eventId !==
            record.eventId ||
          record.family?.children.some(
            (child) =>
              liveContextByAddress.get(child.addressId)?.eventId !==
              child.eventId
          )
      )
      result.meta = {
        ...result.meta,
        source: hasNewCacheOnlyTerms ? "local_cache" : result.meta.source,
        stale: result.meta.stale || hasNewCacheOnlyTerms,
        degraded: true,
      }
      result.data = withProductFamilyReadEvidence(currentFiltered, result.meta)
    }
    return result
  }
  await context.refreshCache(liveContext)
  await context.refreshDeletions()
  if (options.shouldContinue?.() === false)
    throw new NostrSignerError("authority_changed")
  if (author) context.completed.set(author, reconcile)
  const result = reconcile()
  options.onProgress?.(result)
  return result
}

function resolveProductAvailabilityIssue(input: {
  addressId: string | null
  listingCoverage: ProductAvailabilityCoverage
  liveByAddress: ReadonlyMap<string, CommerceProductRecord>
  filteredByAddress: ReadonlyMap<string, CommerceProductRecord>
  mergedAddressIds: ReadonlySet<string>
}): ProductAvailabilityIssue | null {
  if (!input.addressId) return "invalid_product_reference"
  const selected = input.filteredByAddress.get(input.addressId)
  if (selected) {
    const live = input.liveByAddress.get(input.addressId)
    if (
      input.listingCoverage !== "unavailable" &&
      live?.eventId === selected.eventId
    ) {
      return null
    }
    if (input.listingCoverage === "unavailable") return "lookup_unavailable"
    if (input.listingCoverage === "partial") return "lookup_partial"
    return "cached_only"
  }
  if (input.listingCoverage === "unavailable") return "lookup_unavailable"
  if (input.listingCoverage === "partial") return "lookup_partial"
  if (input.mergedAddressIds.has(input.addressId)) return "listing_filtered"
  return "product_missing"
}

export async function getCachedProductDetail(
  query: ProductDetailQuery,
  options: CachedProductReadOptions = { includeStale: true }
): Promise<CommerceResult<CommerceProductRecord | null>> {
  return readCachedProductDetail(
    query,
    options,
    productDetailReadDependencies()
  )
}

/** Read one cached catalog batch for exact coordinates without relay I/O.
 * Retained records carry stale evidence; callers must not authorize purchases
 * from this projection. The same deletion and family availability checks as cached
 * product detail apply, with a single author-scoped storage read.
 */
export async function getCachedProductsByIds(
  productIds: readonly string[],
  options: CachedProductReadOptions = { includeStale: true }
): Promise<CommerceResult<CommerceProductRecord[]>> {
  return readCachedProductsByIds(
    productIds,
    options,
    productDetailReadDependencies()
  )
}

export async function getProfiles(
  query: ProfileBatchQuery
): Promise<ProfileBatchResult> {
  return readProfiles(query, {
    parseProfileEvent,
    planProfileReadRelays: planCommerceReadRelayPlan,
    fetchEvents: runFetchEventsFanout,
    fetchEventsDetailed: runFetchEventsFanoutDetailed,
    contextualRelayHints,
    getAccountNetworkLocalStateRepository: () =>
      testOverrides.accountNetworkLocalStateRepository,
    hasFetchPublicEventsOverride: () => !!testOverrides.fetchPublicEvents,
    createMeta: (source, options) =>
      createMeta("profile_batch", source, PROFILE_CAPABILITIES, options),
    now,
  })
}

function ownerInboxStatus(
  snapshot: CommerceInboxSnapshot
): PrivateInboxReadStatus {
  return {
    declarationState: snapshot.declaration?.state ?? "lookup_unavailable",
    coverage: snapshot.diagnostics.coverage,
    readSource:
      snapshot.declaration?.state === "declared" ? "declared" : "compatibility",
    authentication:
      snapshot.diagnostics.authentication ??
      unavailableInboxStatus().authentication,
  }
}

async function refreshOwnedInbox(
  principalPubkey: string
): Promise<CommerceInboxSnapshot> {
  const owner = getCommerceInbox(principalPubkey)
  await owner.initialize()
  try {
    const declaration = await resolvePrincipalInboxDeclaration(
      principalPubkey,
      owner.authorization
    )
    return await owner.syncRecent({
      declaration,
      read: testOverrides.readProtectedInbox,
    })
  } catch (error) {
    owner.assertCurrent()
    if (owner.getSnapshot().diagnostics.storageUnavailable) throw error
    return owner.getSnapshot()
  }
}

async function fetchParsedOrderMessages(
  principalPubkey: string
): Promise<RawMessageFetchResult> {
  const snapshot = await refreshOwnedInbox(principalPubkey)
  return {
    messages: snapshot.orderMessages,
    source:
      snapshot.diagnostics.coverage === "unavailable"
        ? "local_cache"
        : "commerce",
    stale: inboxSnapshotIncomplete(snapshot),
    decryptFailures: snapshot.decryptFailures,
    inbox: ownerInboxStatus(snapshot),
  }
}

/** Dedicated handoff projection shares ciphertext retention and paging only. */
async function fetchEventMarketPrivateMessagesStrict(
  principalPubkey: string
): Promise<EventMarketPrivateMessageListResult> {
  const owner = getCommerceInbox(principalPubkey)
  await owner.initialize()
  const declaration = await resolvePrincipalInboxDeclaration(
    principalPubkey,
    owner.authorization
  )
  const relayUrls = normalizeOwnerSelectedRelayUrls(
    declaration.state === "declared" ? declaration.relayUrls : []
  )
  if (!relayUrls.length)
    return {
      messages: [],
      stale: true,
      decryptFailures: [],
      inbox: {
        declarationState: declaration.state,
        coverage: "unavailable",
        readSource: "declared",
      },
    }
  // One bounded page per source per invocation; durable cursors resume after
  // interruption and include equal-second boundary evidence.
  await owner.loadOlder({
    includeLegacy: false,
    declaration,
    relayUrls,
    read: testOverrides.readProtectedInbox,
  })
  const currentDeclaration = await resolvePrincipalInboxDeclaration(
    principalPubkey,
    owner.authorization
  )
  owner.assertCurrent()
  if (
    currentDeclaration.state !== declaration.state ||
    JSON.stringify(
      normalizeOwnerSelectedRelayUrls(currentDeclaration.relayUrls).sort()
    ) !== JSON.stringify([...relayUrls].sort())
  )
    throw new Error("Inbox relay plan changed during recovery read")
  const ranges = await owner.store.database.commerceInboxRanges
    .where("accountPubkey")
    .equals(principalPubkey)
    .toArray()
  const inboxRanges = ranges.filter(
    (range) => range.id === owner.store.key(`${range.relayUrl}:nip17`)
  )
  const unavailable = relayUrls.every((url) =>
    inboxRanges.some(
      (range) => range.relayUrl === url && range.status === "unavailable"
    )
  )
  const evidence = await owner.recoveryEvidence(relayUrls)
  const coverage = unavailable
    ? "unavailable"
    : relayUrls.every((url) =>
          inboxRanges.some(
            (range) =>
              range.relayUrl === url &&
              range.status === "source_eose" &&
              range.pageCount === 1
          )
        ) && !evidence.unresolved
      ? "complete"
      : "partial"
  return {
    messages: evidence.messages,
    authenticatedWraps: evidence.authenticatedWraps,
    // A partial declaration lookup does not invalidate the retained signed
    // current inbox or a complete read of its selected relay history.
    stale: unavailable || evidence.unresolved,
    decryptFailures: evidence.decryptFailures,
    inbox: {
      declarationState: declaration.state,
      coverage,
      readSource: "declared",
    },
  }
}

/**
 * Resolve the principal's kind-10050 declaration with typed outcomes.
 * A missing declaration never blocks reading the principal's own gift wraps;
 * it only changes the read plan and the surfaced readiness state.
 */
async function resolvePrincipalInboxDeclaration(
  principalPubkey: string,
  authorization: ProtectedReadAuthorization | null
): Promise<InboxDeclarationResolution> {
  if (testOverrides.resolveInboxRelayUrls) {
    try {
      const relays = await testOverrides.resolveInboxRelayUrls(principalPubkey)
      assertInboxSyncAuthority(authorization)
      const secure = normalizeOwnerSelectedRelayUrls(relays)
      return {
        pubkey: principalPubkey,
        state: secure.length > 0 ? "declared" : "not_observed",
        relayUrls: secure,
        stale: false,
        fetchedAt: now(),
      }
    } catch {
      return {
        pubkey: principalPubkey,
        state: "lookup_unavailable",
        relayUrls: [],
        stale: false,
        fetchedAt: now(),
      }
    }
  }
  return await resolveInboxDeclaration(principalPubkey, {
    fetchEventsWithDiagnostics: runFetchEventsFanoutWithDiagnostics,
    allowLocalRelayUrlsForPubkey: principalPubkey,
    requestingAccountPubkey: principalPubkey,
    authenticatedPubkey: principalPubkey,
    accountNetworkLocalStateRepository:
      testOverrides.accountNetworkLocalStateRepository,
    ownerRelayListEvidenceRepository:
      testOverrides.ownerRelayListEvidenceRepository,
    shouldContinue: () => {
      assertInboxSyncAuthority(authorization)
      return true
    },
  })
}

async function loadCachedDirectMessages(
  principalPubkey: string
): Promise<StoredMessage[]> {
  if (testOverrides.getCachedDirectMessages)
    return await testOverrides.getCachedDirectMessages(principalPubkey)
  const owner = getCommerceInbox(principalPubkey)
  await owner.initialize()
  const snapshot = owner.getSnapshot()
  return snapshot.directMessages.map((message) =>
    cachedDirectMessageRow(message, snapshot.unreadIds.has(message.id) ? 0 : 1)
  )
}

async function storeCachedDirectMessages(rows: StoredMessage[]): Promise<void> {
  if (testOverrides.putCachedDirectMessages)
    return await testOverrides.putCachedDirectMessages(rows)
  const signer = getAccountSigner()
  if (!signer) return
  const owner = getCommerceInbox(signer.pubkey)
  await owner.initialize()
  for (const row of rows)
    await owner.store.putProjection(
      { kind: "direct", message: parseCachedDirectMessage(row) },
      row.read
    )
  await owner.refresh()
}

async function fetchParsedDirectMessages(
  principalPubkey: string
): Promise<RawDirectMessageFetchResult> {
  const snapshot = await refreshOwnedInbox(principalPubkey)
  return {
    messages: snapshot.directMessages,
    unreadMessageIds: new Set(snapshot.unreadIds),
    source:
      snapshot.diagnostics.coverage === "unavailable"
        ? "local_cache"
        : "commerce",
    stale: inboxSnapshotIncomplete(snapshot),
    decryptFailures: snapshot.decryptFailures,
    legacyDecryptFailures: snapshot.legacyDecryptFailures,
    inbox: ownerInboxStatus(snapshot),
  }
}

export async function getBuyerConversationList(
  query: ConversationListQuery
): Promise<CommerceResult<BuyerConversationSummary[]>> {
  const result = await fetchParsedOrderMessages(query.principalPubkey)
  return {
    data: buildBuyerConversationSummaries(
      result.messages,
      query.principalPubkey
    )
      .filter(
        (conversation) =>
          !query.counterpartyPubkey ||
          conversation.merchantPubkey === query.counterpartyPubkey
      )
      .slice(0, query.limit),
    meta: createMeta(
      "protected_conversation_list",
      result.source,
      CONVERSATION_CAPABILITIES,
      {
        stale: result.stale,
        decryptFailures: result.decryptFailures,
        inbox: result.inbox,
      }
    ),
  }
}

export async function getCachedBuyerConversationList(
  query: ConversationListQuery
): Promise<CommerceResult<BuyerConversationSummary[]>> {
  const cached = await loadCachedOrderMessages(query.principalPubkey)
  const messages = cached
    .flatMap((row) => {
      try {
        return [JSON.parse(row.rawContent) as ParsedOrderMessage]
      } catch {
        return []
      }
    })
    .sort((a, b) => a.createdAt - b.createdAt)
  const conversations = buildBuyerConversationSummaries(
    messages,
    query.principalPubkey
  )
    .filter(
      (conversation) =>
        !query.counterpartyPubkey ||
        conversation.merchantPubkey === query.counterpartyPubkey
    )
    .slice(0, query.limit)

  return {
    data: conversations,
    meta: createMeta(
      "protected_conversation_list",
      "local_cache",
      CONVERSATION_CAPABILITIES,
      { stale: true, degraded: conversations.length > 0 }
    ),
  }
}

export async function getMerchantConversationList(
  query: ConversationListQuery
): Promise<CommerceResult<MerchantConversationSummary[]>> {
  const result = await fetchParsedOrderMessages(query.principalPubkey)
  return {
    data: buildMerchantConversationSummaries(
      result.messages,
      query.principalPubkey
    )
      .filter(
        (conversation) =>
          !query.counterpartyPubkey ||
          conversation.buyerPubkey === query.counterpartyPubkey
      )
      .slice(0, query.limit),
    meta: createMeta(
      "protected_conversation_list",
      result.source,
      CONVERSATION_CAPABILITIES,
      {
        stale: result.stale,
        decryptFailures: result.decryptFailures,
        inbox: result.inbox,
      }
    ),
  }
}

export async function getCachedMerchantConversationList(
  query: ConversationListQuery
): Promise<CommerceResult<MerchantConversationSummary[]>> {
  const cached = await loadCachedOrderMessages(query.principalPubkey)
  const messages = cached
    .flatMap((row) => {
      try {
        return [JSON.parse(row.rawContent) as ParsedOrderMessage]
      } catch {
        return []
      }
    })
    .sort((a, b) => a.createdAt - b.createdAt)
  const conversations = buildMerchantConversationSummaries(
    messages,
    query.principalPubkey
  )
    .filter(
      (conversation) =>
        !query.counterpartyPubkey ||
        conversation.buyerPubkey === query.counterpartyPubkey
    )
    .slice(0, query.limit)

  return {
    data: conversations,
    meta: createMeta(
      "protected_conversation_list",
      "local_cache",
      CONVERSATION_CAPABILITIES,
      { stale: true, degraded: conversations.length > 0 }
    ),
  }
}

export async function getConversationDetail(
  query: ConversationDetailQuery
): Promise<CommerceResult<ConversationDetail | null>> {
  const result = await fetchParsedOrderMessages(query.principalPubkey)
  const orderGroups = groupOrderConversationMessages(
    result.messages,
    query.principalPubkey
  ).filter((group) => group.orderId === query.orderId)
  const groups = orderGroups.filter(
    (group) =>
      (query.role === "buyer" ? group.buyerPubkey : group.merchantPubkey) ===
        query.principalPubkey &&
      (!query.counterpartyPubkey ||
        (query.role === "buyer" ? group.merchantPubkey : group.buyerPubkey) ===
          query.counterpartyPubkey)
  )
  // An explicit participant can inspect plain replies before the original
  // order arrives. A role-conflicting order never falls back to these notes.
  const messages =
    groups.length === 1
      ? groups[0]!.messages
      : orderGroups.length === 0 &&
          query.counterpartyPubkey &&
          !result.messages.some(
            (message) =>
              message.orderId === query.orderId &&
              message.type !== "message" &&
              ((message.senderPubkey === query.principalPubkey &&
                message.recipientPubkey === query.counterpartyPubkey) ||
                (message.recipientPubkey === query.principalPubkey &&
                  message.senderPubkey === query.counterpartyPubkey))
          )
        ? result.messages.filter(
            (message) =>
              message.orderId === query.orderId &&
              message.type === "message" &&
              ((message.senderPubkey === query.principalPubkey &&
                message.recipientPubkey === query.counterpartyPubkey) ||
                (message.recipientPubkey === query.principalPubkey &&
                  message.senderPubkey === query.counterpartyPubkey))
          )
        : []
  return {
    data: messages.length > 0 ? { orderId: query.orderId, messages } : null,
    meta: createMeta(
      "conversation_detail",
      result.source,
      CONVERSATION_CAPABILITIES,
      {
        stale: result.stale,
        decryptFailures: result.decryptFailures,
        inbox: result.inbox,
      }
    ),
  }
}

export interface EventMarketPrivateMessageListResult {
  /** Verified principal-addressed wraps for authenticated parsed messages; never diagnostics. */
  authenticatedWraps?: Record<string, SignedPublicNostrEvent>
  messages: ParsedEventMarketPrivateMessage[]
  stale: boolean
  decryptFailures: DecryptFailure[]
  inbox?: PrivateInboxReadStatus
}

/**
 * Read the account-scoped private event-handoff stream without projecting it
 * into an ordinary buyer/merchant order conversation.
 */
export async function getEventMarketPrivateMessageList(
  principalPubkey: string
): Promise<EventMarketPrivateMessageListResult> {
  return await fetchEventMarketPrivateMessagesStrict(principalPubkey)
}

export interface MerchantCheckoutSparkRecoveryCandidate {
  wrapId: string
  schemaVersion: CheckoutSparkRecoveryPayload["schemaVersion"]
  checkoutId: string
  orderId: string
  planDigest: string
  takeoverAt: number
  preparedAt: number
  /** Present only when a later state-only wrap is paired with its wallet wrap. */
  initialWrapId?: string
  initialHandoffId?: string
  /** Opaque pointer to separately authenticated Merchant-authored progress. */
  merchantProgress?: {
    wrapId: string
    snapshotId: string
    recordedAt: number
  }
}

export interface MerchantCheckoutSparkRecoveryListResult {
  candidates: MerchantCheckoutSparkRecoveryCandidate[]
  coverage: InboxReadCoverage
  declarationState: InboxDeclarationState
  malformedCount: number
  decryptFailureCount: number
  conflictCount: number
}

export interface MerchantCheckoutSparkRecoveryDiscoveryResult extends MerchantCheckoutSparkRecoveryListResult {
  /** Private order bindings that could not be saved; discovery may continue. */
  orderBindingFailureCount?: number
  history: {
    /** More bounded work is available in this process-local session. */
    hasMore: boolean
    /** The status of this call's single declared-relay page. */
    pageStatus: ProtectedInboxHistoryPageStatus
    /** Private retention bound reached; only a new explicit session can scan. */
    retentionLimitReached: boolean
  }
}

export interface MerchantCheckoutSparkRecoveryDiscovery {
  nextPage(): Promise<MerchantCheckoutSparkRecoveryDiscoveryResult>
  /** Start another bounded sweep without forgetting observed private evidence. */
  restartScan(): void
  dispose(): void
}

export interface MerchantCheckoutSparkRecoveryDiscoveryOptions {
  signal?: AbortSignal
  /** Private local persistence only. No wallet/provider or message-cache work. */
  onOrderRecovery?(input: {
    state: CheckoutSparkSettledReconciliation
    witness: CheckoutSparkMerchantOrderWitness
    sourceEvents: readonly SignedPublicNostrEvent[]
    assertCurrent(): void
  }): Promise<void>
}

/**
 * Resolve original public terms by exact event ID, never a current frontier.
 * This reads no wallet, invoice or private recovery data from public relays.
 */
export async function readMerchantCheckoutSparkPlanSources(
  principalPubkey: string,
  plan: CheckoutSparkSettledPlan,
  assertCurrent: () => void,
  signal?: AbortSignal,
  initialSourceEvents?: readonly SignedPublicNostrEvent[]
): Promise<{
  status: "verified" | "unresolved"
  events: SignedPublicNostrEvent[]
  coverage: InboxReadCoverage
}> {
  assertCurrent()
  // An authenticated initial handoff can carry the original signed public
  // revisions. Validate the complete bundle directly: a pruned public relay
  // or unavailable optional local cache must not veto this positive evidence.
  // A present but unusable bundle is not permission to substitute newer data.
  if (initialSourceEvents !== undefined) {
    try {
      const exact = canonicalizeCheckoutSparkPlanSourceEvents(
        plan,
        initialSourceEvents
      )
      return { status: "verified", events: exact, coverage: "complete" }
    } catch {
      return { status: "unresolved", events: [], coverage: "partial" }
    }
  }
  const references = getCheckoutSparkPlanSourceReferences(plan)
  const wanted = new Map(
    references.map((reference) => [reference.eventId, reference])
  )
  const events = new Map<string, SignedPublicNostrEvent>()
  const retain = (candidates: readonly SignedPublicNostrEvent[]) => {
    for (const event of candidates) {
      const reference = wanted.get(event.id)
      if (
        reference &&
        event.kind === reference.kind &&
        event.pubkey === reference.pubkey &&
        isValidSignedPublicNostrEvent(event)
      ) {
        events.set(event.id, {
          id: event.id,
          pubkey: event.pubkey,
          created_at: event.created_at,
          kind: event.kind,
          tags: event.tags.map((tag) => [...tag]),
          content: event.content,
          sig: event.sig,
        })
      }
    }
  }
  const repository =
    testOverrides.checkoutSparkSettledRepository ??
    new DexieCheckoutSparkSettledRepository()
  try {
    retain(
      await repository.loadMerchantPlanSourceEvents(
        plan.checkoutId,
        plan.planDigest
      )
    )
  } catch {
    // A missing/unavailable optional cache is not negative signed evidence.
  }
  assertCurrent()
  let coverage: InboxReadCoverage = "complete"
  const missing = references.filter(
    (reference) => !events.has(reference.eventId)
  )
  if (missing.length > 0) {
    if (testOverrides.readCheckoutSparkPlanSourceEvents) {
      const read = await testOverrides.readCheckoutSparkPlanSourceEvents(plan)
      assertCurrent()
      retain(read.events)
      coverage = read.coverage
    } else {
      let completed = false
      let degraded = false
      const missingKinds = [
        ...new Set(missing.map((reference) => reference.kind)),
      ].sort((left, right) => left - right)
      for (const kind of missingKinds) {
        const targets = missing.filter((reference) => reference.kind === kind)
        for (let offset = 0; offset < targets.length; offset += 32) {
          assertCurrent()
          const batch = targets.slice(offset, offset + 32)
          const shouldContinue = () => {
            try {
              assertCurrent()
              return !signal?.aborted
            } catch {
              return false
            }
          }
          try {
            const relayPlan = await planCommerceReadRelayPlan({
              intent: kind === 0 ? "profiles" : "author_products",
              authors: [...new Set(batch.map((reference) => reference.pubkey))],
              authenticatedPubkey: principalPubkey,
              accountPubkey: principalPubkey,
              maxRelays: 8,
              shouldContinue,
              signal,
            })
            assertCurrent()
            const read = await runFetchEventsFanoutDetailed(
              {
                ids: batch.map((reference) => reference.eventId),
                kinds: [kind],
                authors: [
                  ...new Set(batch.map((reference) => reference.pubkey)),
                ],
                limit: batch.length + 1,
              },
              {
                relayUrls: relayPlan.candidateRelayUrls,
                relayTargets: relayPlan.relayTargets,
                maxRelayAttempts: relayPlan.maxRelayAttempts,
                accountPubkey: principalPubkey,
                authenticatedPubkey: principalPubkey,
                accountNetworkLocalStateRepository:
                  testOverrides.accountNetworkLocalStateRepository,
                shouldContinue,
                signal,
                connectTimeoutMs: 3_000,
                fetchTimeoutMs: 6_000,
              }
            )
            assertCurrent()
            retain(read.events)
            completed ||= read.completedRelayUrls.length > 0
            degraded ||= read.degraded || read.capped
          } catch {
            assertCurrent()
            degraded = true
          }
        }
      }
      coverage = !completed ? "unavailable" : degraded ? "partial" : "complete"
    }
  }
  assertCurrent()
  try {
    const exact = [...events.values()]
    validateCheckoutSparkPlanSources(plan, exact)
    return { status: "verified", events: exact, coverage }
  } catch {
    return { status: "unresolved", events: [], coverage }
  }
}

async function retainMerchantCheckoutSparkPlanSources(
  plan: CheckoutSparkSettledPlan,
  events: readonly SignedPublicNostrEvent[],
  assertCurrent: () => void
): Promise<void> {
  const repository =
    testOverrides.checkoutSparkSettledRepository ??
    new DexieCheckoutSparkSettledRepository()
  const snapshot = await repository.load(plan.checkoutId, plan.planDigest)
  assertCurrent()
  // Discovery/explicit import may not have stored this plan yet. Retired
  // records keep their earlier local validation, never reopen the wallet.
  if (snapshot?.status === "active") {
    await repository.recordMerchantPlanSources(plan, events, assertCurrent)
    assertCurrent()
  }
}

/**
 * Signed v3 recovery updates are append-only. A later wrap may add an exact
 * credit or advance a leg, but may never replace the wallet, allocation,
 * invoice intent, or a settled result. Keep this comparison in memory only;
 * the discovery result must not expose private state.
 */
function settledRecoverySnapshotAdvances(
  earlier:
    | CheckoutSparkSettledRecoveryPayload
    | CheckoutSparkSettledRecoveryProgressPayload,
  later:
    | CheckoutSparkSettledRecoveryPayload
    | CheckoutSparkSettledRecoveryProgressPayload
): boolean {
  if (
    earlier.preparedAt > later.preparedAt ||
    earlier.state.updatedAt > later.state.updatedAt ||
    earlier.plan.planDigest !== later.plan.planDigest ||
    JSON.stringify(earlier.plan) !== JSON.stringify(later.plan)
  ) {
    return false
  }
  const oldCredit = earlier.state.credit
  const newCredit = later.state.credit
  if (oldCredit && JSON.stringify(oldCredit) !== JSON.stringify(newCredit)) {
    return false
  }
  if (
    !oldCredit &&
    !newCredit &&
    earlier.state.legs.some((leg) => leg.intent)
  ) {
    return false
  }
  const uncertain = new Set([
    "ambiguous",
    "lookup_unavailable",
    "conflicting_evidence",
  ])
  return earlier.state.legs.every((oldLeg, index) => {
    const newLeg = later.state.legs[index]
    if (
      !newLeg ||
      oldLeg.legId !== newLeg.legId ||
      (oldLeg.allocationSats !== null &&
        oldLeg.allocationSats !== newLeg.allocationSats) ||
      (oldLeg.intent &&
        JSON.stringify(oldLeg.intent) !== JSON.stringify(newLeg.intent)) ||
      (oldLeg.observedAt !== null &&
        (newLeg.observedAt === null || newLeg.observedAt < oldLeg.observedAt))
    ) {
      return false
    }
    if (oldLeg.status === "paid") {
      return (
        newLeg.status === "paid" &&
        oldLeg.finalFeeSats === newLeg.finalFeeSats &&
        oldLeg.finalDebitSats === newLeg.finalDebitSats
      )
    }
    if (oldLeg.status === "terminal_failure") {
      return newLeg.status === "terminal_failure" || newLeg.status === "paid"
    }
    if (oldLeg.status === "unprepared") return true
    if (oldLeg.status === "prepared") return newLeg.status !== "unprepared"
    if (oldLeg.status === "submitted") {
      return newLeg.status !== "unprepared" && newLeg.status !== "prepared"
    }
    if (uncertain.has(oldLeg.status)) {
      return (
        newLeg.status === "paid" ||
        newLeg.status === "terminal_failure" ||
        uncertain.has(newLeg.status)
      )
    }
    return false
  })
}

/** Resolve the shared read policy without relabeling compatibility as owner authority. */
async function merchantCheckoutSparkRecoveryReadPlan(
  principal: string,
  declaration: InboxDeclarationResolution,
  authorization: ProtectedReadAuthorization | null
) {
  assertInboxSyncAuthority(authorization)
  const plan = planInboxReadRelays({
    declaration,
    authenticatedPubkey: principal,
  })
  const relayTargets = await filterEligibleAccountRelayTargets({
    accountPubkey: principal,
    authenticatedPubkey: authorization?.expectedPubkey,
    targets: plan.relayTargets,
    operation: "read",
    repository: testOverrides.accountNetworkLocalStateRepository,
    ownerRelayListEvidenceRepository:
      testOverrides.ownerRelayListEvidenceRepository,
  })
  assertInboxSyncAuthority(authorization)
  const relayUrls = relayTargets.map((target) => target.url)
  const eligibleUrls = new Set(relayUrls)
  return {
    relayTargets,
    relayUrls,
    ownerSelectedRelayUrls: plan.ownerSelectedRelayUrls.filter((url) =>
      eligibleUrls.has(url)
    ),
  }
}

/**
 * A bounded, process-local scan of the merchant's permitted inbox read plan. The
 * caller owns scheduling: each call reads at most one relay page, and no
 * wallet material or decrypted wrap escapes in the result. A later EOSE on a
 * stitched history is not proof of global absence (backdated wraps can land).
 */
export async function createMerchantCheckoutSparkRecoveryDiscovery(
  principalPubkey: string,
  options: MerchantCheckoutSparkRecoveryDiscoveryOptions = {}
): Promise<MerchantCheckoutSparkRecoveryDiscovery> {
  const authorization = resolveInboxSyncAuthorization(principalPubkey)
  const signal = options.signal
  const assertSetup = () => {
    if (signal?.aborted) {
      throw new Error("Recovery discovery session was cancelled.")
    }
    assertInboxSyncAuthority(authorization)
  }
  assertSetup()
  if (!authorization) throw new ProtectedInboxAuthorityChangedError()
  let signer: NostrKeySigner | undefined = await resolveEnvelopeSigner()
  assertSetup()
  if (!signer) {
    throw new Error("Connect your Nostr signer to view checkout recoveries.")
  }
  const principal = principalPubkey.trim().toLowerCase()
  const signerPubkey = await signer.getPublicKey()
  assertSetup()
  if (signerPubkey.trim().toLowerCase() !== principal) {
    throw new ProtectedInboxAuthorityChangedError()
  }
  assertSetup()
  const declaration = await resolvePrincipalInboxDeclaration(
    principal,
    authorization
  )
  assertSetup()
  const readPlan = await merchantCheckoutSparkRecoveryReadPlan(
    principal,
    declaration,
    authorization
  )
  assertSetup()
  const relayUrls = readPlan.relayUrls
  type SeenRecovery = {
    wrapId: string
    payload: CheckoutSparkRecoveryPayload
  }
  const initialByCheckout = new Map<string, SeenRecovery[]>()
  const progressByCheckout = new Map<string, SeenRecovery[]>()
  const merchantProgressByCheckout = new Map<
    string,
    CheckoutSparkMerchantProgressSelectionEntry[]
  >()
  const ordersById = new Map<string, CheckoutSparkMerchantOrderEvidence[]>()
  const deliveredOrders = new Map<string, string>()
  const visitedWrapIds = new Set<string>()
  const malformedWrapIds = new Set<string>()
  const decryptFailedWrapIds = new Set<string>()
  const sources = relayUrls.map((relayUrl) => ({
    relayUrl,
    cursor: undefined as ProtectedInboxHistoryCursor | undefined,
    terminal: false,
    cleanEose: false,
    attempts: 0,
    pages: 0,
  }))
  let disposed = false
  let reading = false
  let nextSource = 0
  let stitched = false
  let retainedAcrossSweeps = false
  let successfulRead = false
  let retainedEvidenceCount = 0
  let retainedPayloadChars = 0
  let retentionLimitReached = false
  let lastPageStatus: ProtectedInboxHistoryPageStatus = "unavailable"
  const expiresAt = Date.now() + CHECKOUT_SPARK_RECOVERY_SESSION_LIFETIME_MS
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined

  const dispose = () => {
    signal?.removeEventListener("abort", dispose)
    if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer)
    lifetimeTimer = undefined
    disposed = true
    signer = undefined
    initialByCheckout.clear()
    progressByCheckout.clear()
    merchantProgressByCheckout.clear()
    ordersById.clear()
    deliveredOrders.clear()
    visitedWrapIds.clear()
    malformedWrapIds.clear()
    decryptFailedWrapIds.clear()
    sources.length = 0
  }
  const assertCurrent = () => {
    if (disposed) throw new ProtectedInboxAuthorityChangedError()
    if (signal?.aborted) {
      dispose()
      throw new Error("Recovery discovery session was cancelled.")
    }
    if (Date.now() >= expiresAt) {
      dispose()
      throw new Error("Recovery discovery session expired. Refresh to retry.")
    }
    try {
      assertInboxSyncAuthority(authorization)
    } catch (error) {
      dispose()
      throw error
    }
  }
  signal?.addEventListener("abort", dispose, { once: true })
  if (signal?.aborted) {
    dispose()
    throw new Error("Recovery discovery session was cancelled.")
  }
  lifetimeTimer = setTimeout(
    () => dispose(),
    CHECKOUT_SPARK_RECOVERY_SESSION_LIFETIME_MS
  )
  const unrefTimer = lifetimeTimer as unknown as { unref?: () => void }
  unrefTimer.unref?.()
  const candidateOf = (
    entry: SeenRecovery
  ): MerchantCheckoutSparkRecoveryCandidate => ({
    wrapId: entry.wrapId,
    schemaVersion: entry.payload.schemaVersion,
    checkoutId: entry.payload.plan.checkoutId,
    orderId: entry.payload.plan.orderId,
    planDigest: entry.payload.plan.planDigest,
    takeoverAt: entry.payload.plan.takeoverAt,
    preparedAt: entry.payload.preparedAt,
  })
  type PendingOrderBinding = {
    state: CheckoutSparkSettledReconciliation
    orderEvidence: CheckoutSparkMerchantOrderEvidence
    recoverySenderPubkey: string
    initialSourceEvents?: readonly SignedPublicNostrEvent[]
    version: string
  }
  const project = (
    matchedOrders?: PendingOrderBinding[]
  ): MerchantCheckoutSparkRecoveryDiscoveryResult => {
    const candidates: MerchantCheckoutSparkRecoveryCandidate[] = []
    let conflictCount = 0
    let orphanProgressCount = 0
    for (const [checkoutId, snapshots] of initialByCheckout) {
      const ordered = [...snapshots].sort(
        (left, right) =>
          left.payload.preparedAt - right.payload.preparedAt ||
          left.wrapId.localeCompare(right.wrapId)
      )
      const first = ordered[0]
      if (!first || first.payload.schemaVersion === 3) continue
      let latest = first
      let conflict = false
      for (const entry of ordered.slice(1)) {
        if (entry.payload.schemaVersion === 3) {
          conflict = true
          break
        }
        const original = first.payload
        const subsequent = entry.payload
        if (
          original.schemaVersion !== subsequent.schemaVersion ||
          original.plan.planDigest !== subsequent.plan.planDigest ||
          original.senderPubkey !== subsequent.senderPubkey ||
          original.wallet.mnemonic !== subsequent.wallet.mnemonic ||
          original.wallet.accountNumber !== subsequent.wallet.accountNumber
        ) {
          conflict = true
          break
        }
        if (original.schemaVersion === 2 && subsequent.schemaVersion === 2) {
          if (
            latest.payload.schemaVersion !== 2 ||
            !settledRecoverySnapshotAdvances(latest.payload, subsequent) ||
            (latest.payload.preparedAt === subsequent.preparedAt &&
              JSON.stringify(latest.payload.state) !==
                JSON.stringify(subsequent.state))
          ) {
            conflict = true
            break
          }
          latest = entry
        } else if (original.handoffId !== subsequent.handoffId) {
          conflict = true
          break
        }
      }
      const progress = progressByCheckout.get(checkoutId) ?? []
      if (progress.length > 0 && first.payload.schemaVersion !== 2) {
        conflict = true
      }
      let latestCandidate = candidateOf(latest)
      let latestState:
        | CheckoutSparkSettledRecoveryPayload
        | CheckoutSparkSettledRecoveryProgressPayload
        | undefined =
        latest.payload.schemaVersion === 2 ? latest.payload : undefined
      const settledInitial =
        latest.payload.schemaVersion === 2 ? latest.payload : undefined
      for (const entry of [...progress].sort(
        (left, right) =>
          left.payload.preparedAt - right.payload.preparedAt ||
          left.wrapId.localeCompare(right.wrapId)
      )) {
        const update = entry.payload
        if (
          conflict ||
          update.schemaVersion !== 3 ||
          !settledInitial ||
          !latestState ||
          update.initialHandoffId !== settledInitial.handoffId ||
          update.senderPubkey !== settledInitial.senderPubkey ||
          update.merchantPubkey !== settledInitial.merchantPubkey ||
          update.plan.planDigest !== settledInitial.plan.planDigest ||
          update.preparedAt <= latestState.preparedAt ||
          !settledRecoverySnapshotAdvances(latestState, update)
        ) {
          conflict = true
          break
        }
        latestState = update
        latestCandidate = {
          ...candidateOf(entry),
          initialWrapId: latest.wrapId,
          initialHandoffId: settledInitial.handoffId,
        }
      }
      let effectiveState = latestState?.state
      const merchantProgress = merchantProgressByCheckout.get(checkoutId) ?? []
      if (merchantProgress.length > 0 && !conflict) {
        const selection =
          settledInitial && latestState
            ? selectCheckoutSparkMerchantProgress({
                initial: settledInitial,
                latestBuyerState: latestState.state,
                entries: merchantProgress,
              })
            : { status: "conflict" as const }
        if (selection.status === "conflict") conflict = true
        if (selection.status === "selected") {
          const { wrapId, payload } = selection.entry
          latestCandidate.merchantProgress = {
            wrapId,
            snapshotId: payload.snapshotId,
            recordedAt: payload.recordedAt,
          }
          effectiveState = payload.state
        }
      }
      if (conflict) conflictCount += 1
      else {
        candidates.push(latestCandidate)
        if (matchedOrders && settledInitial && latestState && effectiveState) {
          const orders = ordersById.get(latestState.plan.orderId) ?? []
          // A repeated outer wrap of the same rumor is deduplicated on read.
          // Different signed orders reusing an identity are not interchangeable.
          const buyerOrders = orders.filter(
            (order) => order.buyerPubkey === settledInitial.senderPubkey
          )
          if (buyerOrders.length === 1) {
            const orderEvidence = buyerOrders[0]!
            matchedOrders.push({
              state: effectiveState,
              orderEvidence,
              recoverySenderPubkey: settledInitial.senderPubkey,
              initialSourceEvents: settledInitial.sourceEvents,
              version: `${orderEvidence.rumorId}:${latestCandidate.wrapId}:${latestCandidate.merchantProgress?.snapshotId ?? ""}:${latestCandidate.merchantProgress?.wrapId ?? ""}`,
            })
          }
        }
      }
    }
    for (const checkoutId of progressByCheckout.keys()) {
      if (!initialByCheckout.has(checkoutId)) orphanProgressCount += 1
    }
    for (const checkoutId of merchantProgressByCheckout.keys()) {
      if (!initialByCheckout.has(checkoutId)) orphanProgressCount += 1
    }
    const hasMore =
      !retentionLimitReached && sources.some((source) => !source.terminal)
    const clean =
      sources.length > 0 &&
      sources.every((source) => source.cleanEose) &&
      !stitched &&
      !retainedAcrossSweeps &&
      !retentionLimitReached &&
      !declaration.stale &&
      malformedWrapIds.size === 0 &&
      decryptFailedWrapIds.size === 0 &&
      conflictCount === 0 &&
      orphanProgressCount === 0
    const coverage: InboxReadCoverage = clean
      ? "complete"
      : !successfulRead && !hasMore
        ? "unavailable"
        : "partial"
    return {
      candidates: candidates.sort(
        (left, right) =>
          left.takeoverAt - right.takeoverAt ||
          left.checkoutId.localeCompare(right.checkoutId)
      ),
      coverage,
      declarationState: declaration.state,
      malformedCount: malformedWrapIds.size,
      decryptFailureCount: decryptFailedWrapIds.size,
      conflictCount,
      history: {
        hasMore,
        pageStatus: lastPageStatus,
        retentionLimitReached,
      },
    }
  }

  const projectAndPersist = async () => {
    const matched: PendingOrderBinding[] = []
    const result = project(options.onOrderRecovery ? matched : undefined)
    let failures = 0
    for (const order of matched) {
      assertCurrent()
      const key = order.state.plan.checkoutId
      if (deliveredOrders.get(key) === order.version) continue
      try {
        const sources = await readMerchantCheckoutSparkPlanSources(
          principal,
          order.state.plan,
          assertCurrent,
          signal,
          order.initialSourceEvents
        )
        assertCurrent()
        if (sources.status !== "verified") {
          failures += 1
          continue
        }
        // Physical fulfillment needs exact historical public revisions. An
        // older handoff may not embed them, so resolve retained/fallback sources
        // before constructing the witness; never substitute current terms.
        const witness = createCheckoutSparkMerchantOrderWitness(
          order.state.plan,
          order.orderEvidence,
          order.recoverySenderPubkey,
          sources.events
        )
        if (!witness) {
          failures += 1
          continue
        }
        await options.onOrderRecovery!({
          state: order.state,
          witness,
          sourceEvents: sources.events,
          assertCurrent,
        })
        assertCurrent()
        deliveredOrders.set(key, order.version)
      } catch {
        assertCurrent()
        // One local/conflicting order cannot veto discovery for other orders.
        // Do not mark the failed binding delivered; a later page can retry it.
        failures += 1
      }
    }
    if (failures > 0) result.orderBindingFailureCount = failures
    return result
  }

  return {
    dispose,
    restartScan() {
      assertCurrent()
      if (retentionLimitReached) {
        throw new Error(
          "Recovery discovery retention limit reached. Refresh to retry."
        )
      }
      if (reading || sources.some((source) => !source.terminal)) {
        throw new Error("Finish the current recovery discovery sweep first.")
      }
      if (
        retainedEvidenceCount > 0 ||
        malformedWrapIds.size > 0 ||
        decryptFailedWrapIds.size > 0
      ) {
        retainedAcrossSweeps = true
      }
      for (const source of sources) {
        source.cursor = undefined
        source.terminal = false
        source.cleanEose = false
        source.attempts = 0
        source.pages = 0
      }
      nextSource = 0
      stitched = false
      successfulRead = false
      lastPageStatus = "unavailable"
    },
    async nextPage() {
      assertCurrent()
      if (reading)
        throw new Error("Recovery discovery page already in progress.")
      const offset = sources.findIndex(
        (_, index) => !sources[(nextSource + index) % sources.length]?.terminal
      )
      if (offset < 0) return projectAndPersist()
      const index = (nextSource + offset) % sources.length
      const source = sources[index]!
      nextSource = (index + 1) % sources.length
      reading = true
      try {
        let page:
          Awaited<ReturnType<typeof visitProtectedInboxHistoryPage>> | undefined
        try {
          page = await visitProtectedInboxHistoryPage({
            principalPubkey: principal,
            relayUrl: source.relayUrl,
            authorizedRelayUrls: relayUrls,
            declaredRelayUrls: readPlan.ownerSelectedRelayUrls,
            relayTargets: readPlan.relayTargets.filter(
              (target) => target.url === source.relayUrl
            ),
            authorization,
            ...(signal ? { signal } : {}),
            ...(source.cursor ? { cursor: source.cursor } : {}),
            accountNetworkLocalStateRepository:
              testOverrides.accountNetworkLocalStateRepository,
            ...(testOverrides.readProtectedInbox
              ? { read: testOverrides.readProtectedInbox }
              : {}),
            visit: async (event, assertVisitCurrent) => {
              assertCurrent()
              assertVisitCurrent()
              // A visit is only reached after this relay returned a clean,
              // authenticated signed-wrap page. If a later unwrap times out,
              // preserve partial (not unavailable) coverage and any positives.
              successfulRead = true
              if (visitedWrapIds.has(event.id)) return
              const currentSigner = signer
              if (!currentSigner)
                throw new ProtectedInboxAuthorityChangedError()
              let timer: ReturnType<typeof setTimeout> | undefined
              const opened = await Promise.race([
                inspectCheckoutSparkRecoveryWrap({
                  signedRecipientWrap: event,
                  signer: currentSigner,
                  ...(testOverrides.giftUnwrap
                    ? { giftUnwrap: testOverrides.giftUnwrap }
                    : {}),
                }),
                new Promise<typeof CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT>(
                  (resolve) => {
                    timer = setTimeout(
                      () => resolve(CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT),
                      CHECKOUT_SPARK_RECOVERY_UNWRAP_TIMEOUT_MS
                    )
                  }
                ),
              ]).finally(() => {
                if (timer !== undefined) clearTimeout(timer)
              })
              assertCurrent()
              assertVisitCurrent()
              if (opened === CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT) {
                throw new Error("Recovery inspection timed out.")
              }
              if (opened.status === "decrypt_failed") {
                // A temporary signer/relay decrypt problem must be retryable
                // on the next sweep of this same process-local session.
                if (
                  !decryptFailedWrapIds.has(event.id) &&
                  decryptFailedWrapIds.size >=
                    CHECKOUT_SPARK_RECOVERY_FAILURE_ID_LIMIT
                ) {
                  retentionLimitReached = true
                  throw new Error(
                    "Recovery discovery failure-ID limit reached."
                  )
                }
                decryptFailedWrapIds.add(event.id)
                return
              }
              decryptFailedWrapIds.delete(event.id)
              visitedWrapIds.add(event.id)
              if (
                visitedWrapIds.size > CHECKOUT_SPARK_RECOVERY_RECENT_WRAP_LIMIT
              ) {
                const oldest = visitedWrapIds.values().next().value
                if (oldest) visitedWrapIds.delete(oldest)
              }
              if (opened.status === "malformed") {
                if (
                  !malformedWrapIds.has(event.id) &&
                  malformedWrapIds.size >=
                    CHECKOUT_SPARK_RECOVERY_FAILURE_ID_LIMIT
                ) {
                  retentionLimitReached = true
                  throw new Error(
                    "Recovery discovery failure-ID limit reached."
                  )
                }
                malformedWrapIds.add(event.id)
              } else if (
                opened.status === "ignored" &&
                opened.orderEvidence &&
                options.onOrderRecovery
              ) {
                const evidence = opened.orderEvidence
                const seen = ordersById.get(evidence.orderId) ?? []
                if (!seen.some((prior) => prior.rumorId === evidence.rumorId)) {
                  const payloadChars = JSON.stringify(evidence).length
                  if (
                    retainedEvidenceCount >=
                      CHECKOUT_SPARK_RECOVERY_RETAINED_EVIDENCE_LIMIT ||
                    retainedPayloadChars + payloadChars >
                      CHECKOUT_SPARK_RECOVERY_RETAINED_CHAR_LIMIT
                  ) {
                    retentionLimitReached = true
                    throw new Error(
                      "Recovery discovery evidence limit reached."
                    )
                  }
                  seen.push(evidence)
                  ordersById.set(evidence.orderId, seen)
                  retainedEvidenceCount += 1
                  retainedPayloadChars += payloadChars
                }
              } else if (opened.status === "merchant_progress") {
                const checkoutId = opened.payload.state.plan.checkoutId
                const seen = merchantProgressByCheckout.get(checkoutId) ?? []
                if (!seen.some((prior) => prior.wrapId === opened.wrapId)) {
                  const payloadChars = JSON.stringify(opened.payload).length
                  if (
                    retainedEvidenceCount >=
                      CHECKOUT_SPARK_RECOVERY_RETAINED_EVIDENCE_LIMIT ||
                    retainedPayloadChars + payloadChars >
                      CHECKOUT_SPARK_RECOVERY_RETAINED_CHAR_LIMIT
                  ) {
                    retentionLimitReached = true
                    throw new Error(
                      "Recovery discovery evidence limit reached."
                    )
                  }
                  seen.push({ wrapId: opened.wrapId, payload: opened.payload })
                  merchantProgressByCheckout.set(checkoutId, seen)
                  retainedEvidenceCount += 1
                  retainedPayloadChars += payloadChars
                }
              } else if (opened.status === "ok") {
                const entry: SeenRecovery = {
                  wrapId: opened.wrapId,
                  payload: opened.payload,
                }
                const destination =
                  opened.payload.schemaVersion === 3
                    ? progressByCheckout
                    : initialByCheckout
                const checkoutId = opened.payload.plan.checkoutId
                const seen = destination.get(checkoutId) ?? []
                // A remote sibling may replay an old wrap after the bounded
                // recent-ID window rolls forward. Never duplicate its private
                // recovery state or manufacture a same-time conflict.
                if (!seen.some((prior) => prior.wrapId === entry.wrapId)) {
                  const payloadChars = JSON.stringify(entry.payload).length
                  if (
                    retainedEvidenceCount >=
                      CHECKOUT_SPARK_RECOVERY_RETAINED_EVIDENCE_LIMIT ||
                    retainedPayloadChars + payloadChars >
                      CHECKOUT_SPARK_RECOVERY_RETAINED_CHAR_LIMIT
                  ) {
                    retentionLimitReached = true
                    throw new Error(
                      "Recovery discovery evidence limit reached."
                    )
                  }
                  seen.push(entry)
                  destination.set(checkoutId, seen)
                  retainedEvidenceCount += 1
                  retainedPayloadChars += payloadChars
                }
              }
            },
          })
          assertCurrent()
        } catch (error) {
          assertCurrent()
          // A signer/read timeout cannot advance the cursor. Give a sibling
          // relay a chance on the next call; retries are finite per session.
          if (error instanceof ProtectedInboxAuthorityChangedError) throw error
          page = {
            status: retentionLimitReached ? "capped" : "partial",
            visitedCount: 0,
            nextCursor: source.cursor ?? null,
            range: {
              relayUrl: source.relayUrl,
              since: null,
              until: source.cursor?.until ?? null,
              eose: false,
              saturated: false,
              observedCount: 0,
            },
          }
          if (retentionLimitReached) {
            for (const remaining of sources) remaining.terminal = true
          }
        }
        lastPageStatus = page.status
        if (page.status === "advanced") {
          successfulRead = true
          stitched = true
          source.pages += 1
          source.attempts = 0
          source.cursor = page.nextCursor ?? undefined
          if (!source.cursor) source.terminal = true
        } else if (page.status === "source_eose") {
          successfulRead = true
          source.cleanEose = source.pages === 0
          source.terminal = true
        } else {
          source.attempts += 1
          if (page.status === "capped" || source.attempts >= 3) {
            source.terminal = true
          }
        }
        assertCurrent()
        return await projectAndPersist()
      } finally {
        reading = false
      }
    },
  }
}

/**
 * Discover merchant recovery authority without projecting wallet material into
 * a conversation cache or a UI query result. This resumes one durable page per source from
 * the shared owner inbox read plan. A capped, failed, or malformed read is
 * never presented as proof that no recovery package exists. Call only from an
 * explicit foreground recovery action, never a background polling interval.
 */
export async function getMerchantCheckoutSparkRecoveryList(
  principalPubkey: string
): Promise<MerchantCheckoutSparkRecoveryListResult> {
  return (await inspectMerchantCheckoutSparkRecoveries(principalPubkey)).result
}

interface MerchantCheckoutSparkRecoveryAuthority {
  candidate: MerchantCheckoutSparkRecoveryCandidate
  handoffId: string
  senderPubkey: string
  mnemonic: string
  accountNumber: number
  payload: Exclude<CheckoutSparkRecoveryPayload, { schemaVersion: 3 }>
  latestPayload?:
    | CheckoutSparkSettledRecoveryPayload
    | CheckoutSparkSettledRecoveryProgressPayload
  latestMerchantProgress?: CheckoutSparkMerchantProgressPayload
}

/** Wallet authority remains private to this foreground call. */
async function inspectMerchantCheckoutSparkRecoveries(
  principalPubkey: string
): Promise<{
  result: MerchantCheckoutSparkRecoveryListResult
  authorities: Map<string, MerchantCheckoutSparkRecoveryAuthority>
  conflictingCheckouts: Set<string>
}> {
  const authorization = resolveInboxSyncAuthorization(principalPubkey)
  assertInboxSyncAuthority(authorization)
  const principal = principalPubkey.trim().toLowerCase()
  const declaration = await resolvePrincipalInboxDeclaration(
    principal,
    authorization
  )
  assertInboxSyncAuthority(authorization)
  const readPlan = await merchantCheckoutSparkRecoveryReadPlan(
    principal,
    declaration,
    authorization
  )
  const relayUrls = readPlan.relayUrls
  const byCheckout = new Map<string, MerchantCheckoutSparkRecoveryAuthority>()
  const conflictingCheckouts = new Set<string>()
  if (!relayUrls.length)
    return {
      result: {
        candidates: [],
        coverage: "unavailable",
        declarationState: declaration.state,
        malformedCount: 0,
        decryptFailureCount: 0,
        conflictCount: 0,
      },
      authorities: byCheckout,
      conflictingCheckouts,
    }
  const signer = await resolveEnvelopeSigner()
  assertInboxSyncAuthority(authorization)
  if (
    !signer ||
    (await signer.getPublicKey()).trim().toLowerCase() !== principal
  )
    throw new ProtectedInboxAuthorityChangedError()
  assertInboxSyncAuthority(authorization)
  const owner = getCommerceInbox(principal)
  // Each explicit discovery resumes one durable page per permitted read source.
  // General inbox history uses the same cursor and original encrypted wrappers.
  await owner.loadOlder({
    includeLegacy: false,
    declaration,
    relayUrls,
    read: testOverrides.readProtectedInbox,
  })
  assertInboxSyncAuthority(authorization)
  const descriptors = await owner.checkoutRecoveryDescriptors(relayUrls)
  const machineWrapIds = new Set(descriptors.map((row) => row.wrapId))
  const wrappers = (await owner.store.wrappers()).filter((row) =>
    row.sources.some((url) => relayUrls.includes(url))
  )
  const machineWraps = wrappers.filter((row) =>
    machineWrapIds.has(row.event.id)
  )
  const inspectionCapped =
    machineWraps.length > CHECKOUT_SPARK_RECOVERY_INSPECTION_LIMIT
  const distinctWraps = machineWraps
    .map((row) => row.event)
    .sort(
      (left, right) =>
        right.created_at - left.created_at || left.id.localeCompare(right.id)
    )
    .slice(0, CHECKOUT_SPARK_RECOVERY_INSPECTION_LIMIT)
  const progressByCheckout = new Map<
    string,
    Array<{
      candidate: MerchantCheckoutSparkRecoveryCandidate
      payload: CheckoutSparkSettledRecoveryProgressPayload
    }>
  >()
  const merchantProgressByCheckout = new Map<
    string,
    CheckoutSparkMerchantProgressSelectionEntry[]
  >()
  let orphanProgressCount = 0
  let malformedCount = wrappers.filter(
    (row) => row.state === "malformed" || row.state === "invalid_envelope"
  ).length
  let decryptFailureCount = wrappers.filter((row) =>
    [
      "permission_declined",
      "provider_unavailable",
      "retryable_failure",
    ].includes(row.state)
  ).length
  let inspectionTimedOut = false
  const inspectionDeadline =
    Date.now() + CHECKOUT_SPARK_RECOVERY_INSPECTION_BUDGET_MS
  for (const event of distinctWraps) {
    assertInboxSyncAuthority(authorization)
    const remainingMs = inspectionDeadline - Date.now()
    if (remainingMs <= 0) {
      inspectionTimedOut = true
      break
    }
    const recipients = event.tags.filter((tag) => tag[0] === "p")
    if (
      recipients.length !== 1 ||
      recipients[0]?.[1]?.toLowerCase() !== principal
    ) {
      malformedCount += 1
      continue
    }
    const inspection = inspectCheckoutSparkRecoveryWrap({
      signedRecipientWrap: event,
      signer,
      ...(testOverrides.giftUnwrap
        ? { giftUnwrap: testOverrides.giftUnwrap }
        : {}),
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const opened = await Promise.race([
      inspection,
      new Promise<typeof CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT>(
        (resolve) => {
          timer = setTimeout(
            () => resolve(CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT),
            Math.min(CHECKOUT_SPARK_RECOVERY_UNWRAP_TIMEOUT_MS, remainingMs)
          )
        }
      ),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
    assertInboxSyncAuthority(authorization)
    if (opened === CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT) {
      inspectionTimedOut = true
      break
    }
    if (opened.status === "ignored") continue
    if (opened.status === "malformed") {
      malformedCount += 1
      continue
    }
    if (opened.status === "decrypt_failed") {
      decryptFailureCount += 1
      continue
    }
    if (opened.status === "merchant_progress") {
      const checkoutId = opened.payload.state.plan.checkoutId
      const entries = merchantProgressByCheckout.get(checkoutId) ?? []
      entries.push({ wrapId: opened.wrapId, payload: opened.payload })
      merchantProgressByCheckout.set(checkoutId, entries)
      continue
    }
    const payload = opened.payload
    const candidate: MerchantCheckoutSparkRecoveryCandidate = {
      wrapId: opened.wrapId,
      schemaVersion: payload.schemaVersion,
      checkoutId: payload.plan.checkoutId,
      orderId: payload.plan.orderId,
      planDigest: payload.plan.planDigest,
      takeoverAt: payload.plan.takeoverAt,
      preparedAt: payload.preparedAt,
    }
    if (payload.schemaVersion === 3) {
      const progress = progressByCheckout.get(candidate.checkoutId) ?? []
      progress.push({ candidate, payload })
      progressByCheckout.set(candidate.checkoutId, progress)
      continue
    }
    const previous = byCheckout.get(candidate.checkoutId)
    if (previous) {
      const inconsistentAuthority =
        previous.candidate.planDigest !== candidate.planDigest ||
        previous.senderPubkey !== payload.senderPubkey ||
        previous.mnemonic !== payload.wallet.mnemonic ||
        previous.accountNumber !== payload.wallet.accountNumber ||
        previous.payload.schemaVersion !== payload.schemaVersion
      if (inconsistentAuthority) {
        conflictingCheckouts.add(candidate.checkoutId)
        continue
      }
      if (previous.payload.schemaVersion === 2 && payload.schemaVersion === 2) {
        const earlier =
          previous.payload.preparedAt <= payload.preparedAt
            ? previous.payload
            : payload
        const later = earlier === previous.payload ? payload : previous.payload
        if (!settledRecoverySnapshotAdvances(earlier, later)) {
          conflictingCheckouts.add(candidate.checkoutId)
          continue
        }
        if (payload.preparedAt > previous.payload.preparedAt) {
          byCheckout.set(candidate.checkoutId, {
            candidate,
            handoffId: payload.handoffId,
            senderPubkey: payload.senderPubkey,
            mnemonic: payload.wallet.mnemonic,
            accountNumber: payload.wallet.accountNumber,
            payload,
            latestPayload: payload,
          })
        } else if (
          payload.preparedAt === previous.payload.preparedAt &&
          (payload.handoffId !== previous.handoffId ||
            JSON.stringify(payload.state) !==
              JSON.stringify(previous.payload.state))
        ) {
          conflictingCheckouts.add(candidate.checkoutId)
        }
        continue
      }
      if (previous.handoffId !== payload.handoffId) {
        conflictingCheckouts.add(candidate.checkoutId)
      }
      continue
    }
    byCheckout.set(candidate.checkoutId, {
      candidate,
      handoffId: payload.handoffId,
      senderPubkey: payload.senderPubkey,
      mnemonic: payload.wallet.mnemonic,
      accountNumber: payload.wallet.accountNumber,
      payload,
      ...(payload.schemaVersion === 2 ? { latestPayload: payload } : {}),
    })
  }
  for (const [checkoutId, progress] of progressByCheckout) {
    const initial = byCheckout.get(checkoutId)
    if (!initial) {
      orphanProgressCount += 1
      continue
    }
    if (initial.payload.schemaVersion !== 2) {
      conflictingCheckouts.add(checkoutId)
      continue
    }
    const initialWrapId = initial.candidate.wrapId
    let latest:
      | CheckoutSparkSettledRecoveryPayload
      | CheckoutSparkSettledRecoveryProgressPayload = initial.payload
    const ordered = progress.sort(
      (left, right) =>
        left.payload.preparedAt - right.payload.preparedAt ||
        left.candidate.wrapId.localeCompare(right.candidate.wrapId)
    )
    for (const update of ordered) {
      if (
        update.payload.initialHandoffId !== initial.handoffId ||
        update.payload.senderPubkey !== initial.senderPubkey ||
        update.payload.merchantPubkey !== initial.payload.merchantPubkey ||
        update.payload.plan.planDigest !== initial.candidate.planDigest ||
        update.payload.preparedAt <= latest.preparedAt ||
        !settledRecoverySnapshotAdvances(latest, update.payload)
      ) {
        conflictingCheckouts.add(checkoutId)
        break
      }
      latest = update.payload
      initial.latestPayload = update.payload
      initial.candidate = {
        ...update.candidate,
        initialWrapId,
        initialHandoffId: initial.handoffId,
      }
    }
  }
  for (const [checkoutId, entries] of merchantProgressByCheckout) {
    const authority = byCheckout.get(checkoutId)
    if (!authority) {
      orphanProgressCount += 1
      continue
    }
    if (authority.payload.schemaVersion !== 2 || !authority.latestPayload) {
      conflictingCheckouts.add(checkoutId)
      continue
    }
    const selection = selectCheckoutSparkMerchantProgress({
      initial: authority.payload,
      latestBuyerState: authority.latestPayload.state,
      entries,
    })
    if (selection.status === "conflict") conflictingCheckouts.add(checkoutId)
    if (selection.status === "selected") {
      authority.latestMerchantProgress = selection.entry.payload
      authority.candidate.merchantProgress = {
        wrapId: selection.entry.wrapId,
        snapshotId: selection.entry.payload.snapshotId,
        recordedAt: selection.entry.payload.recordedAt,
      }
    }
  }
  const ranges = await owner.store.database.commerceInboxRanges
    .where("accountPubkey")
    .equals(principal)
    .toArray()
  const completeHistory =
    relayUrls.every((url) =>
      ranges.some(
        (row) =>
          row.id === owner.store.key(`${url}:nip17`) &&
          row.status === "source_eose" &&
          row.pageCount === 1
      )
    ) &&
    !malformedCount &&
    !decryptFailureCount &&
    !conflictingCheckouts.size &&
    !inspectionCapped &&
    !inspectionTimedOut &&
    orphanProgressCount === 0
  const allSourcesUnavailable = relayUrls.every((url) =>
    ranges.some(
      (row) =>
        row.id === owner.store.key(`${url}:nip17`) &&
        row.status === "unavailable"
    )
  )
  const coverage: InboxReadCoverage = completeHistory
    ? "complete"
    : allSourcesUnavailable && wrappers.length === 0
      ? "unavailable"
      : "partial"
  assertInboxSyncAuthority(authorization)
  return {
    result: {
      candidates: [...byCheckout.entries()]
        .filter(([id]) => !conflictingCheckouts.has(id))
        .map(([, row]) => row.candidate)
        .sort((a, b) => a.takeoverAt - b.takeoverAt),
      coverage,
      declarationState: declaration.state,
      malformedCount,
      decryptFailureCount,
      conflictCount: conflictingCheckouts.size,
    },
    authorities: byCheckout,
    conflictingCheckouts,
  }
}

export interface MerchantCheckoutSparkRecoveryHandoffResult {
  status: "consumed" | "missing" | "incomplete"
  /** Coverage of the exact-ID read, independent of bounded discovery. */
  coverage: InboxReadCoverage
  discoveryCoverage: InboxReadCoverage
  declarationState: InboxDeclarationState
  candidate: MerchantCheckoutSparkRecoveryCandidate | null
}

/**
 * A private, non-rendering adapter. It must keep the decrypted wallet material
 * in memory only, never return it, and recheck authority around each await.
 * This seam does not authorize payment or invoke a provider send.
 */
export interface MerchantCheckoutSparkRecoveryPrivateAdapter {
  consume(
    payload: CheckoutSparkRecoveryPayload,
    assertCurrent: () => void
  ): Promise<void>
  /** Both envelopes stay private and in-memory. This is inspection only. */
  consumeSettled?(
    initial: CheckoutSparkSettledRecoveryPayload,
    latest: CheckoutSparkSettledRecoveryProgressPayload,
    assertCurrent: () => void
  ): Promise<void>
  /**
   * Historical callback name denotes the receiving Merchant, not the author.
   * Exact Merchant/Organizer type and attribution remain intact. Neither
   * snapshot replaces the original Buyer order/wallet authority or provider proof.
   */
  consumeMerchantProgress?(
    initial: CheckoutSparkSettledRecoveryPayload,
    latestBuyer:
      | CheckoutSparkSettledRecoveryPayload
      | CheckoutSparkSettledRecoveryProgressPayload,
    progress: CheckoutSparkRecoveryActorProgress,
    assertCurrent: () => void
  ): Promise<void>
}

/**
 * An exact signed event is positive evidence from a permitted inbox. A timeout
 * at a sibling inbox cannot revoke it. Keep malformed/conflicting observations
 * separate, and never use partial emptiness as evidence that a wrap is absent.
 */
function hasExactMerchantRecoveryWrap(
  read: Awaited<ReturnType<typeof readProtectedInbox>>,
  wrapId: string,
  relayCount: number
): boolean {
  const event = read.events[0]
  return (
    read.coverage !== "unavailable" &&
    read.relayResult.attemptedCount === relayCount &&
    read.relayResult.relays.length === relayCount &&
    read.relayResult.completedCount > 0 &&
    read.relayResult.relays.some(
      (relay) => relay.status === "success" && relay.eventCount === 1
    ) &&
    read.relayResult.relays.every(
      (relay) =>
        relay.eventCount < 2 &&
        relay.malformedCount === 0 &&
        relay.unusableCount === 0
    ) &&
    read.events.length === 1 &&
    event?.id === wrapId &&
    event.kind === EVENT_KINDS.GIFT_WRAP &&
    isValidSignedPublicNostrEvent(event)
  )
}

/**
 * Re-fetch one selected, signed recovery wrap by its full ID from the current
 * merchant's permitted inbox read plan. Bounded discovery retains observed conflicts;
 * strict exact-wrap validation authorizes opening the selected material.
 * Nothing decrypted is returned to UI/query state or ordinary order caches.
 * Consuming this package is not a merchant application ACK or a funding gate.
 */
export async function withMerchantCheckoutSparkRecovery(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  privateAdapter: MerchantCheckoutSparkRecoveryPrivateAdapter
): Promise<MerchantCheckoutSparkRecoveryHandoffResult> {
  const wrapId = selected.wrapId?.trim().toLowerCase()
  if (!wrapId || !/^[0-9a-f]{64}$/.test(wrapId)) {
    throw new Error("Merchant checkout recovery selection is invalid.")
  }
  const initialWrapId = selected.initialWrapId?.trim().toLowerCase()
  const initialHandoffId = selected.initialHandoffId?.trim().toLowerCase()
  const merchantProgress = selected.merchantProgress
    ? { ...selected.merchantProgress }
    : undefined
  if (
    ![1, 2, 3].includes(selected.schemaVersion) ||
    (merchantProgress !== undefined &&
      (selected.schemaVersion === 1 ||
        Object.keys(merchantProgress).length !== 3 ||
        !/^[0-9a-f]{64}$/.test(merchantProgress.wrapId) ||
        !/^[0-9a-f]{64}$/.test(merchantProgress.snapshotId) ||
        !Number.isSafeInteger(merchantProgress.recordedAt) ||
        merchantProgress.recordedAt <= 0)) ||
    (selected.schemaVersion === 3
      ? !initialWrapId ||
        !/^[0-9a-f]{64}$/.test(initialWrapId) ||
        !initialHandoffId ||
        !/^[0-9a-f]{64}$/.test(initialHandoffId)
      : initialWrapId !== undefined || initialHandoffId !== undefined)
  ) {
    throw new Error("Merchant checkout recovery selection is invalid.")
  }
  // Pin the opaque selection before any signer or network await.
  const candidate: MerchantCheckoutSparkRecoveryCandidate = {
    wrapId,
    schemaVersion: selected.schemaVersion,
    checkoutId: selected.checkoutId,
    orderId: selected.orderId,
    planDigest: selected.planDigest,
    takeoverAt: selected.takeoverAt,
    preparedAt: selected.preparedAt,
    ...(initialWrapId ? { initialWrapId } : {}),
    ...(initialHandoffId ? { initialHandoffId } : {}),
    ...(merchantProgress ? { merchantProgress } : {}),
  }
  const authorization = resolveInboxSyncAuthorization(principalPubkey)
  assertInboxSyncAuthority(authorization)
  const signer = await resolveEnvelopeSigner()
  assertInboxSyncAuthority(authorization)
  const principal = principalPubkey.trim().toLowerCase()
  if (
    !signer ||
    (await signer.getPublicKey()).trim().toLowerCase() !== principal
  ) {
    throw new ProtectedInboxAuthorityChangedError()
  }
  assertInboxSyncAuthority(authorization)

  const inspection = await inspectMerchantCheckoutSparkRecoveries(principal)
  const discovery = inspection.result
  assertInboxSyncAuthority(authorization)
  if (inspection.conflictingCheckouts.has(candidate.checkoutId)) {
    return {
      status: "incomplete",
      coverage: "partial",
      discoveryCoverage: discovery.coverage,
      declarationState: discovery.declarationState,
      candidate: null,
    }
  }
  const declaration = await resolvePrincipalInboxDeclaration(
    principal,
    authorization
  )
  assertInboxSyncAuthority(authorization)
  const readPlan = await merchantCheckoutSparkRecoveryReadPlan(
    principal,
    declaration,
    authorization
  )
  const relayUrls = readPlan.relayUrls
  if (relayUrls.length === 0) {
    return {
      status: "incomplete",
      coverage: "unavailable",
      discoveryCoverage: discovery.coverage,
      declarationState: declaration.state,
      candidate: null,
    }
  }
  const read = await (testOverrides.readProtectedInbox ?? readProtectedInbox)({
    principalPubkey: principal,
    relayUrls,
    relayTargets: readPlan.relayTargets,
    eventId: wrapId,
    limit: 2,
    authorization,
    accountNetworkLocalStateRepository:
      testOverrides.accountNetworkLocalStateRepository,
    connectTimeoutMs: 4_000,
    queryTimeoutMs: 12_000,
  })
  assertInboxSyncAuthority(authorization)
  const relayComplete =
    read.coverage === "complete" &&
    read.relayResult.attemptedCount === relayUrls.length &&
    read.relayResult.completedCount === relayUrls.length &&
    read.relayResult.failedCount === 0 &&
    read.relayResult.relays.length === relayUrls.length &&
    read.relayResult.relays.every(
      (relay) =>
        relay.status === "success" &&
        relay.eventCount < 2 &&
        relay.malformedCount === 0 &&
        relay.unusableCount === 0
    )
  const incomplete = (
    coverage: InboxReadCoverage
  ): MerchantCheckoutSparkRecoveryHandoffResult => ({
    status: "incomplete",
    coverage,
    discoveryCoverage: discovery.coverage,
    declarationState: declaration.state,
    candidate: null,
  })
  if (read.coverage === "unavailable") return incomplete("unavailable")
  if (read.events.length === 0) {
    if (!relayComplete) return incomplete("partial")
    return {
      status: "missing",
      coverage: "complete",
      discoveryCoverage: discovery.coverage,
      declarationState: declaration.state,
      candidate: null,
    }
  }
  if (!hasExactMerchantRecoveryWrap(read, wrapId, relayUrls.length)) {
    return incomplete("partial")
  }
  let exactCoverage: InboxReadCoverage = relayComplete ? "complete" : "partial"
  const wrap = read.events[0] as SignedPublicNostrEvent
  if (
    wrap.id !== wrapId ||
    wrap.kind !== EVENT_KINDS.GIFT_WRAP ||
    !isValidSignedPublicNostrEvent(wrap)
  ) {
    return incomplete("partial")
  }
  let opened: Awaited<ReturnType<typeof openCheckoutSparkRecoveryWrap>>
  let openingTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const opening = openCheckoutSparkRecoveryWrap({
      signedRecipientWrap: wrap,
      signer,
      ...(testOverrides.giftUnwrap
        ? { giftUnwrap: testOverrides.giftUnwrap }
        : {}),
    })
    const exact = await Promise.race([
      opening,
      new Promise<typeof CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT>(
        (resolve) => {
          openingTimer = setTimeout(
            () => resolve(CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT),
            CHECKOUT_SPARK_RECOVERY_UNWRAP_TIMEOUT_MS
          )
        }
      ),
    ])
    assertInboxSyncAuthority(authorization)
    if (exact === CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT)
      return incomplete("partial")
    opened = exact
  } catch {
    assertInboxSyncAuthority(authorization)
    return incomplete("partial")
  } finally {
    if (openingTimer !== undefined) clearTimeout(openingTimer)
  }
  assertInboxSyncAuthority(authorization)
  const payload = opened.payload
  if (
    opened.wrapId !== candidate.wrapId ||
    payload.schemaVersion !== candidate.schemaVersion ||
    payload.plan.checkoutId !== candidate.checkoutId ||
    payload.plan.orderId !== candidate.orderId ||
    payload.plan.planDigest !== candidate.planDigest ||
    payload.plan.takeoverAt !== candidate.takeoverAt ||
    payload.preparedAt !== candidate.preparedAt ||
    payload.merchantPubkey !== principal
  ) {
    return incomplete("partial")
  }
  const observed = inspection.authorities.get(candidate.checkoutId)
  if (
    observed &&
    (observed.candidate.planDigest !== payload.plan.planDigest ||
      observed.senderPubkey !== payload.senderPubkey ||
      (payload.schemaVersion === 3
        ? observed.payload.schemaVersion !== 2 ||
          observed.handoffId !== payload.initialHandoffId
        : observed.payload.schemaVersion !== payload.schemaVersion ||
          observed.handoffId !== payload.handoffId ||
          observed.mnemonic !== payload.wallet.mnemonic ||
          observed.accountNumber !== payload.wallet.accountNumber))
  ) {
    return incomplete("partial")
  }
  if (
    observed?.latestPayload &&
    payload.schemaVersion !== 1 &&
    (!settledRecoverySnapshotAdvances(observed.latestPayload, payload) ||
      (observed.latestPayload.preparedAt === payload.preparedAt &&
        observed.latestPayload.handoffId !== payload.handoffId))
  ) {
    return incomplete("partial")
  }
  const assertCurrent = () => assertInboxSyncAuthority(authorization)
  const consumeActorState = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    latestBuyer:
      | CheckoutSparkSettledRecoveryPayload
      | CheckoutSparkSettledRecoveryProgressPayload,
    merchantSnapshot?: CheckoutSparkMerchantProgressPayload
  ) => {
    let progress: CheckoutSparkRecoveryActorProgress | undefined =
      merchantSnapshot
    if (
      initial.plan.schemaVersion === 5 &&
      initial.plan.eventMarket?.mode === "organizer_handoff"
    ) {
      const owner = getCommerceInbox(principal)
      await owner.initialize()
      await owner.waitForDecode()
      assertCurrent()
      const descriptors = (
        await owner.checkoutRecoveryDescriptors(relayUrls)
      ).filter(
        (row) =>
          row.checkoutId === initial.plan.checkoutId &&
          row.organizerMessage === "execution" &&
          row.recipientRole !== "organizer"
      )
      assertCurrent()
      if (descriptors.length > CHECKOUT_SPARK_RECOVERY_INSPECTION_LIMIT)
        throw new Error("Organizer recovery evidence requires reconciliation.")
      if (descriptors.length) {
        const wrappers = new Map(
          (await owner.store.wrappers()).map((row) => [row.event.id, row.event])
        )
        assertCurrent()
        const repository = new DexieCheckoutSparkSettledRepository(
          owner.store.database
        )
        const witness = await repository.loadMerchantOrderWitness(
          principal,
          initial.plan.checkoutId,
          initial.plan.planDigest
        )
        assertCurrent()
        // The organizer's order hashes never create or replace this original
        // seal-authenticated Buyer-to-Merchant witness.
        if (
          witness?.schemaVersion !== 2 ||
          !witness.organizerOrderBinding ||
          witness.buyerPubkey !== initial.senderPubkey
        )
          throw new Error(
            "Organizer progress requires its original Buyer order."
          )
        const entries = []
        const deadline =
          Date.now() + CHECKOUT_SPARK_RECOVERY_INSPECTION_BUDGET_MS
        let bytes = 0
        for (const descriptor of descriptors) {
          const exact = wrappers.get(descriptor.wrapId)
          if (!exact) throw new Error("Organizer recovery wrap is unavailable.")
          bytes += JSON.stringify(exact).length
          if (
            bytes > CHECKOUT_SPARK_RECOVERY_RETAINED_CHAR_LIMIT ||
            Date.now() >= deadline
          )
            throw new Error("Organizer recovery inspection requires retry.")
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const opened = await Promise.race([
              openCheckoutSparkOrganizerExecutionProgress({
                signedRecipientWrap: exact,
                signer,
                shouldContinue: () => {
                  assertCurrent()
                  return true
                },
              }),
              new Promise<typeof CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT>(
                (resolve) => {
                  timer = setTimeout(
                    () => resolve(CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT),
                    Math.min(
                      CHECKOUT_SPARK_RECOVERY_UNWRAP_TIMEOUT_MS,
                      deadline - Date.now()
                    )
                  )
                }
              ),
            ])
            assertCurrent()
            if (
              opened === CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT ||
              opened.snapshotId !== descriptor.payloadDigest ||
              opened.state.plan.checkoutId !== descriptor.checkoutId
            )
              throw new Error("Organizer recovery evidence changed.")
            entries.push(opened)
          } finally {
            if (timer !== undefined) clearTimeout(timer)
          }
        }
        const selection = selectCheckoutSparkOrganizerProgressForMerchant({
          initial,
          latestState: merchantSnapshot?.state ?? latestBuyer.state,
          orderBinding: witness.organizerOrderBinding,
          entries,
        })
        if (selection.status === "conflict")
          throw new Error(
            "Organizer recovery progress conflicts with this order."
          )
        if (selection.status === "selected") {
          // Preserve every exact potentially submitted intent before the app
          // opens a provider. Existing CAS/progression rejects forks or rollback;
          // paid labels remain untrusted until provider/recipient re-verification.
          await repository.importMerchantOrderRecovery(
            selection.progress.state,
            witness,
            assertCurrent
          )
          assertCurrent()
          progress = selection.progress
        }
      }
    }
    assertCurrent()
    if (progress) {
      if (!privateAdapter.consumeMerchantProgress)
        throw new Error(
          "Authenticated actor progress requires its recovery owner."
        )
      await privateAdapter.consumeMerchantProgress(
        initial,
        latestBuyer,
        progress,
        assertCurrent
      )
    } else if (latestBuyer.schemaVersion === 3) {
      if (!privateAdapter.consumeSettled)
        throw new Error("Buyer progress requires its recovery owner.")
      await privateAdapter.consumeSettled(initial, latestBuyer, assertCurrent)
    } else await privateAdapter.consume(initial, assertCurrent)
  }
  // A Merchant progress pointer never changes the original buyer authority.
  // Reopen its exact authenticated self-wrap separately and require all known
  // snapshots to advance monotonically before passing either to a private app.
  const openSelectedMerchantProgress = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    latestBuyer:
      | CheckoutSparkSettledRecoveryPayload
      | CheckoutSparkSettledRecoveryProgressPayload
  ): Promise<CheckoutSparkMerchantProgressPayload | null> => {
    if (!merchantProgress || !privateAdapter.consumeMerchantProgress)
      return null
    const progressRead = await (
      testOverrides.readProtectedInbox ?? readProtectedInbox
    )({
      principalPubkey: principal,
      relayUrls,
      relayTargets: readPlan.relayTargets,
      eventId: merchantProgress.wrapId,
      limit: 2,
      authorization,
      accountNetworkLocalStateRepository:
        testOverrides.accountNetworkLocalStateRepository,
      connectTimeoutMs: 4_000,
      queryTimeoutMs: 12_000,
    })
    assertCurrent()
    if (
      !hasExactMerchantRecoveryWrap(
        progressRead,
        merchantProgress.wrapId,
        relayUrls.length
      )
    )
      return null
    if (
      progressRead.coverage !== "complete" ||
      progressRead.relayResult.completedCount !== relayUrls.length ||
      progressRead.relayResult.failedCount !== 0
    )
      exactCoverage = "partial"
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const progressOpened = await Promise.race([
        openCheckoutSparkMerchantProgressWrap({
          signedRecipientWrap: progressRead.events[0],
          signer,
          ...(testOverrides.giftUnwrap
            ? { giftUnwrap: testOverrides.giftUnwrap }
            : {}),
        }),
        new Promise<typeof CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT),
              CHECKOUT_SPARK_RECOVERY_UNWRAP_TIMEOUT_MS
            )
          }
        ),
      ])
      assertCurrent()
      if (
        progressOpened === CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT ||
        progressOpened.wrapId !== merchantProgress.wrapId ||
        progressOpened.payload.snapshotId !== merchantProgress.snapshotId ||
        progressOpened.payload.recordedAt !== merchantProgress.recordedAt
      )
        return null
      const entries: CheckoutSparkMerchantProgressSelectionEntry[] = [
        { wrapId: progressOpened.wrapId, payload: progressOpened.payload },
      ]
      if (
        observed?.latestMerchantProgress &&
        observed.candidate.merchantProgress
      ) {
        entries.push({
          wrapId: observed.candidate.merchantProgress.wrapId,
          payload: observed.latestMerchantProgress,
        })
      }
      const selection = selectCheckoutSparkMerchantProgress({
        initial,
        latestBuyerState: latestBuyer.state,
        entries,
      })
      return selection.status === "selected" &&
        selection.entry.payload.snapshotId === merchantProgress.snapshotId
        ? progressOpened.payload
        : null
    } catch {
      assertCurrent()
      return null
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  if (!merchantProgress && observed?.latestMerchantProgress) {
    return incomplete("partial")
  }
  assertCurrent()
  try {
    let sources: Awaited<
      ReturnType<typeof readMerchantCheckoutSparkPlanSources>
    > | null = null
    const verifyInitialSources = async (
      initial: CheckoutSparkSettledRecoveryPayload
    ) => {
      const verified = await readMerchantCheckoutSparkPlanSources(
        principal,
        initial.plan,
        assertCurrent,
        undefined,
        initial.sourceEvents
      )
      assertCurrent()
      if (verified.status === "verified") {
        await retainMerchantCheckoutSparkPlanSources(
          initial.plan,
          verified.events,
          assertCurrent
        )
        assertCurrent()
      }
      return verified
    }
    if (payload.schemaVersion === 3) {
      const initialWrapId = candidate.initialWrapId
      if (
        !initialWrapId ||
        !candidate.initialHandoffId ||
        payload.initialHandoffId !== candidate.initialHandoffId ||
        (!merchantProgress && !privateAdapter.consumeSettled)
      ) {
        return incomplete("partial")
      }
      const initialRead = await (
        testOverrides.readProtectedInbox ?? readProtectedInbox
      )({
        principalPubkey: principal,
        relayUrls,
        relayTargets: readPlan.relayTargets,
        eventId: initialWrapId,
        limit: 2,
        authorization,
        accountNetworkLocalStateRepository:
          testOverrides.accountNetworkLocalStateRepository,
        connectTimeoutMs: 4_000,
        queryTimeoutMs: 12_000,
      })
      assertCurrent()
      if (
        !hasExactMerchantRecoveryWrap(
          initialRead,
          initialWrapId,
          relayUrls.length
        )
      ) {
        return incomplete("partial")
      }
      if (
        initialRead.coverage !== "complete" ||
        initialRead.relayResult.completedCount !== relayUrls.length ||
        initialRead.relayResult.failedCount !== 0
      )
        exactCoverage = "partial"
      const initialOpening = openCheckoutSparkRecoveryWrap({
        signedRecipientWrap: initialRead.events[0],
        signer,
        ...(testOverrides.giftUnwrap
          ? { giftUnwrap: testOverrides.giftUnwrap }
          : {}),
      })
      let initialTimer: ReturnType<typeof setTimeout> | undefined
      const initialOpened = await Promise.race([
        initialOpening,
        new Promise<typeof CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT>(
          (resolve) => {
            initialTimer = setTimeout(
              () => resolve(CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT),
              CHECKOUT_SPARK_RECOVERY_UNWRAP_TIMEOUT_MS
            )
          }
        ),
      ]).finally(() => {
        if (initialTimer !== undefined) clearTimeout(initialTimer)
      })
      assertCurrent()
      if (
        initialOpened === CHECKOUT_SPARK_RECOVERY_INSPECTION_TIMEOUT ||
        initialOpened.payload.schemaVersion !== 2 ||
        initialOpened.payload.handoffId !== payload.initialHandoffId ||
        initialOpened.payload.plan.planDigest !== payload.plan.planDigest ||
        initialOpened.payload.senderPubkey !== payload.senderPubkey ||
        initialOpened.payload.merchantPubkey !== principal ||
        !settledRecoverySnapshotAdvances(initialOpened.payload, payload)
      ) {
        return incomplete("partial")
      }
      if (
        observed &&
        (observed.mnemonic !== initialOpened.payload.wallet.mnemonic ||
          observed.accountNumber !== initialOpened.payload.wallet.accountNumber)
      ) {
        return incomplete("partial")
      }
      // Progress intentionally omits the original signed sources. Open and
      // authenticate its exact initial handoff before checking those sources.
      sources = await verifyInitialSources(initialOpened.payload)
      if (sources.status === "unresolved") return incomplete(sources.coverage)
      if (merchantProgress) {
        const progress = await openSelectedMerchantProgress(
          initialOpened.payload,
          payload
        )
        assertCurrent()
        if (!progress || !privateAdapter.consumeMerchantProgress)
          return incomplete("partial")
        await consumeActorState(initialOpened.payload, payload, progress)
      } else {
        await consumeActorState(initialOpened.payload, payload)
      }
    } else if (merchantProgress) {
      if (payload.schemaVersion !== 2) return incomplete("partial")
      sources = await verifyInitialSources(payload)
      if (sources.status === "unresolved") return incomplete(sources.coverage)
      const progress = await openSelectedMerchantProgress(payload, payload)
      assertCurrent()
      if (!progress || !privateAdapter.consumeMerchantProgress)
        return incomplete("partial")
      await consumeActorState(payload, payload, progress)
    } else {
      if (payload.schemaVersion === 2) {
        sources = await verifyInitialSources(payload)
        if (sources.status === "unresolved") return incomplete(sources.coverage)
      }
      if (payload.schemaVersion === 2) await consumeActorState(payload, payload)
      else await privateAdapter.consume(payload, assertCurrent)
    }
    if (sources && payload.schemaVersion !== 1) {
      // Explicit import can create the binding inside the private callback.
      await retainMerchantCheckoutSparkPlanSources(
        payload.plan,
        sources.events,
        assertCurrent
      )
      assertCurrent()
    }
  } catch {
    assertCurrent()
    throw new Error("Merchant checkout recovery adapter failed.")
  }
  assertCurrent()
  return {
    status: "consumed",
    coverage: exactCoverage,
    discoveryCoverage: discovery.coverage,
    declarationState: declaration.state,
    candidate,
  }
}

// --- General direct messages (kind 14), threaded by counterparty pubkey ---

export interface DirectConversationSummary {
  /** Transport-qualified thread id. */
  id: string
  transport: ParsedDirectMessage["transport"]
  counterpartyPubkey: string
  participants?: string[]
  latestAt: number
  preview: string
  messageCount: number
  unreadFromCounterparty: number
  messages?: ParsedDirectMessage[]
}

export interface DirectMessageThreadQuery {
  principalPubkey: string
  counterpartyPubkey: string
  transport: ParsedDirectMessage["transport"]
  limit?: number
}

export interface DirectMessageThread {
  counterpartyPubkey: string
  transport: ParsedDirectMessage["transport"]
  messages: ParsedDirectMessage[]
}

export async function getDirectMessageConversationList(
  query: ConversationListQuery
): Promise<CommerceResult<DirectConversationSummary[]>> {
  const result = await fetchParsedDirectMessages(query.principalPubkey)
  return {
    data: buildDirectConversationSummaries(
      result.messages,
      query.principalPubkey,
      result.unreadMessageIds
    ),
    meta: createMeta(
      "protected_conversation_list",
      result.source,
      CONVERSATION_CAPABILITIES,
      {
        stale: result.stale,
        decryptFailures: result.decryptFailures,
        legacyDecryptFailures: result.legacyDecryptFailures,
        inbox: result.inbox,
      }
    ),
  }
}

export async function getCachedDirectMessageConversationList(
  query: ConversationListQuery
): Promise<CommerceResult<DirectConversationSummary[]>> {
  const cached = await loadCachedDirectMessages(query.principalPubkey)
  const messages = cached
    .map(parseCachedDirectMessage)
    .sort((a, b) => a.createdAt - b.createdAt)
  const unreadMessageIds = new Set(
    cached.filter((row) => row.read === 0).map((row) => row.id)
  )
  const limited =
    query.limit && query.limit > 0 ? messages.slice(-query.limit) : messages
  return {
    data: buildDirectConversationSummaries(
      limited,
      query.principalPubkey,
      unreadMessageIds
    ),
    meta: createMeta(
      "protected_conversation_list",
      "local_cache",
      CONVERSATION_CAPABILITIES,
      { stale: true, degraded: limited.length > 0 }
    ),
  }
}

export async function getDirectMessageThread(
  query: DirectMessageThreadQuery
): Promise<CommerceResult<DirectMessageThread | null>> {
  const result = await fetchParsedDirectMessages(query.principalPubkey)
  const messages = result.messages.filter(
    (message) =>
      counterpartyOf(message, query.principalPubkey) ===
        query.counterpartyPubkey && message.transport === query.transport
  )
  return {
    data:
      messages.length > 0
        ? {
            counterpartyPubkey: query.counterpartyPubkey,
            transport: query.transport,
            messages,
          }
        : null,
    meta: createMeta(
      "conversation_detail",
      result.source,
      CONVERSATION_CAPABILITIES,
      {
        stale: result.stale,
        decryptFailures: result.decryptFailures,
        legacyDecryptFailures: result.legacyDecryptFailures,
        inbox: result.inbox,
      }
    ),
  }
}

/** Cache a sent/echoed general direct message locally (used by the send path). */
export async function cacheParsedDirectMessage(
  message: ParsedDirectMessage
): Promise<void> {
  await storeCachedDirectMessages([cachedDirectMessageRow(message)])
}

export async function markDirectMessageConversationRead(input: {
  principalPubkey: string
  counterpartyPubkey: string
  transport?: ParsedDirectMessage["transport"]
  conversationId?: string
}): Promise<number> {
  if (testOverrides.markDirectMessagesRead) {
    return await testOverrides.markDirectMessagesRead(
      input.principalPubkey,
      input.counterpartyPubkey,
      input.transport
    )
  }

  const owner = getCommerceInbox(input.principalPubkey)
  await owner.initialize()
  const ids = owner
    .getSnapshot()
    .directMessages.filter(
      (message) =>
        message.senderPubkey !== input.principalPubkey &&
        message.recipientPubkey === input.principalPubkey &&
        message.senderPubkey === input.counterpartyPubkey &&
        (!input.conversationId ||
          `${message.transport}:${input.counterpartyPubkey}` ===
            input.conversationId) &&
        (!input.transport || message.transport === input.transport)
    )
    .map((message) => message.id)
  const count = await owner.store.markRead(ids)
  await owner.refresh()
  return count
}

function inboxSnapshotIncomplete(snapshot: CommerceInboxSnapshot): boolean {
  return (
    snapshot.diagnostics.coverage !== "complete" ||
    snapshot.diagnostics.historyRanges.some(
      (range) =>
        range.admissionRejected ||
        range.status === "capped" ||
        range.status === "unavailable" ||
        (range.historyAttempted !== false && range.status === "partial")
    ) ||
    snapshot.diagnostics.storageUnavailable ||
    snapshot.decryptFailures.length > 0 ||
    snapshot.legacyDecryptFailures.length > 0 ||
    (snapshot.diagnostics.states.queued ?? 0) > 0 ||
    (snapshot.diagnostics.states.waiting_for_signer ?? 0) > 0 ||
    (snapshot.diagnostics.states.opening ?? 0) > 0
  )
}

/** Pure views of the same committed owner snapshot; no network/cache pipeline. */
export function projectCommerceInbox(
  snapshot: CommerceInboxSnapshot,
  principalPubkey: string
) {
  const meta = createMeta(
    "protected_conversation_list",
    "commerce",
    CONVERSATION_CAPABILITIES,
    {
      stale: inboxSnapshotIncomplete(snapshot),
      decryptFailures: snapshot.decryptFailures,
      legacyDecryptFailures: snapshot.legacyDecryptFailures,
      inbox: ownerInboxStatus(snapshot),
    }
  )
  return {
    buyer: {
      data: buildBuyerConversationSummaries(
        snapshot.orderMessages,
        principalPubkey
      ),
      meta,
    },
    merchant: {
      data: buildMerchantConversationSummaries(
        snapshot.orderMessages,
        principalPubkey
      ),
      meta,
    },
    direct: {
      data: buildDirectConversationSummaries(
        snapshot.directMessages,
        principalPubkey,
        snapshot.unreadIds
      ),
      meta,
    },
  }
}
