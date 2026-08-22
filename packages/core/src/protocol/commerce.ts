import {
  NDKEvent,
  giftUnwrap,
  type NDKFilter,
  type NDKSigner,
  nip19,
} from "@nostr-dev-kit/ndk"
import {
  db,
  type CachedOrderMessage,
  type CachedProduct,
  type CachedProductTombstone,
  type CachedProfile,
  type StoredMessage,
} from "../db"
import { CANONICAL_APP_BACKPLANE_RELAYS, config } from "../config"
import { compareCommercePrices } from "../pricing"
import type { Product, Profile } from "../types"
import { normalizePublicMediaUrl } from "../network-target-safety"
import { EVENT_KINDS } from "./kinds"
import {
  extractFollowPubkeys,
  isPlausibleFollowListEventTimestamp,
  readLatestFollowLists,
  type FollowListAuthorRead,
  type FollowListCoverageState,
} from "./follows"
import {
  fetchEventsFanout,
  fetchEventsFanoutDetailed,
  fetchEventsFanoutProgressive,
  fetchEventsFanoutWithDiagnostics,
  getEventSourceRelayUrls,
  getNdk,
  mergeEventSourceRelayUrls,
} from "./ndk"
import {
  deriveInboxReadCoverage,
  planInboxReadRelays,
  resolveInboxDeclaration,
  type InboxDeclarationResolution,
  type InboxDeclarationState,
  type InboxReadCoverage,
  type InboxReadSource,
} from "./private-message-routing"
import { extractOrderSummary } from "./order-summary"
import { parseOrderMessageRumorEvent, type ParsedOrderMessage } from "./orders"
import {
  __resetInboxRelayCache,
  createNdkLegacyDmDecrypt,
  decryptLegacyDirectMessage,
  parseDirectMessageRumor,
  unwrapGiftWraps,
  type DecryptFailure,
  type LegacyDmDecryptFailure,
  type ParsedDirectMessage,
  type UnwrapGiftWrapOptions,
} from "./messaging"
import {
  evaluateListingSafety,
  isListingMarketVisible,
  type ListingSafetyEvaluation,
} from "./listing-safety"
import {
  prepareProductCatalog,
  type PreparedProductFamily,
  type ProductFamilyReadEvidence,
} from "./product-family"
import {
  canonicalizeProductTags,
  getProductProtocolImages,
  normalizeProductSummaryForDisplay,
  parseProductEvent,
} from "./products"
import {
  areProfileProjectionsEqual,
  mergeRicherProfile,
  projectCachedProfile,
  reduceCachedProfileRows,
  retainStrongestCachedProfiles,
  type CachedProfileRetentionResult,
} from "./profile-cache"
import { parseProfileEvent } from "./profiles"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import {
  isProductDeletedByNip09,
  parseProductAddressCoordinate,
  productDeletionAddressKey,
  productDeletionEventKey as scopedProductDeletionEventKey,
  validateProductDeletionEvent,
  type ProductDeletionEvidence,
} from "./product-deletion"
import {
  getCommerceReadRelayUrls,
  getGeneralReadRelayUrls,
  normalizePublicRelayHints,
  normalizeUntrustedRelayHintsForContext,
} from "./relay-settings"
import {
  getRelayLists,
  getRelayListsDetailed,
  isInsecureRelayUrl,
} from "./relay-list"
import { planRelayReads, type RelayReadIntent } from "./relay-planner"
import {
  readProtectedInbox,
  type ProtectedInboxAuthSummary,
  type ReadProtectedInboxOptions,
} from "./protected-inbox-read"
import {
  getProtectedReadAuthorization,
  hasProtectedReadAuthority,
  type ProtectedReadAuthorization,
} from "./protected-read-authorization"

const PRODUCT_CACHE_TTL_MS = 24 * 60 * 60_000
const BROAD_AUTHOR_HINT_LIMIT = 16
const DM_INBOX_READ_FANOUT = 24
// Keep author-scoped product filters small enough for public relays that
// reject or truncate very large authors arrays. This is a transport batch
// size, not a product truth cap.
const PRODUCT_AUTHOR_CHUNK_SIZE = 64
const PRODUCT_AUTHOR_CHUNK_CONCURRENCY = 2
const PRODUCT_RAW_EVENT_LIMIT_DEFAULT = 600
const PRODUCT_RAW_EVENT_LIMIT_FLOOR = 100
const PRODUCT_RAW_EVENT_LIMIT_MAX = 1_200
const PRODUCT_RAW_EVENT_OVERFETCH_FACTOR = 6
const PRODUCT_VARIATION_EVENT_LIMIT = 200
const PRODUCT_CANONICAL_READ_MAX_RELAYS = 12
const PROFILE_CACHE_TTL_MS = 5 * 60_000

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
  /** True when the bounded inbox result may have omitted more gift wraps. */
  capped?: boolean
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

export interface CommerceProductRecord {
  product: Product
  safety?: ListingSafetyEvaluation
  family?: PreparedProductFamily<CommerceProductRecord>
  eventId: string
  addressId: string
  dTag: string | null
  eventCreatedAt: number
  sourceRelayUrls?: string[]
}

export interface MarketplaceProductsQuery {
  merchantPubkey?: string
  authorPubkeys?: string[]
  authenticatedPubkey?: string | null
  textQuery?: string
  tags?: string[]
  sort?: CommerceSortMode
  limit?: number
  cursor?: string
  readPolicy?: CommerceReadPolicy
}

export interface MerchantStorefrontQuery {
  merchantPubkey: string
  authenticatedPubkey?: string | null
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
  productId: string
  /** Force current, complete NIP-65 author-hint discovery before the read. */
  revalidateCanonical?: boolean
  includeMarketHidden?: boolean
}

export interface ProfileBatchQuery {
  pubkeys: string[]
  authenticatedPubkey?: string | null
  skipCache?: boolean
  priority?: "visible" | "background"
  readPolicy?: CommerceReadPolicy
  relayHintsByPubkey?: Record<string, string[] | undefined>
  onProgress?: (result: CommerceResult<Record<string, Profile>>) => void
}

export interface FollowListQuery {
  pubkey: string
  authenticatedPubkey?: string | null
}

export interface ConversationListQuery {
  principalPubkey: string
  limit?: number
  textQuery?: string
  counterpartyPubkey?: string
}

export interface ConversationDetailQuery {
  principalPubkey: string
  orderId: string
  role: "buyer" | "merchant"
}

interface ConversationSummaryBase {
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

export interface CachedProductReadOptions {
  includeStale?: boolean
  includeMarketHidden?: boolean
}

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

type PrivateInboxSyncResult = {
  orderMessages: ParsedOrderMessage[]
  directMessages: ParsedDirectMessage[]
  decryptFailures: DecryptFailure[]
  inbox: PrivateInboxReadStatus
}

type LegacyDmSyncResult = {
  directMessages: ParsedDirectMessage[]
  decryptFailures: LegacyDmDecryptFailure[]
}

type CommerceTestOverrides = {
  allowMissingProtectedReadAuthorization?: boolean
  fetchEventsFanout?: typeof fetchEventsFanout
  fetchEventsFanoutWithDiagnostics?: typeof fetchEventsFanoutWithDiagnostics
  fetchEventsFanoutDetailed?: typeof fetchEventsFanoutDetailed
  fetchEventsFanoutProgressive?: typeof fetchEventsFanoutProgressive
  readLatestFollowLists?: typeof readLatestFollowLists
  getNdk?: () => ReturnType<typeof getNdk> | Promise<ReturnType<typeof getNdk>>
  readProtectedInbox?: (
    options: ReadProtectedInboxOptions
  ) => ReturnType<typeof readProtectedInbox>
  giftUnwrap?: (
    event: NDKEvent,
    signer: NDKSigner
  ) => Promise<Awaited<ReturnType<typeof giftUnwrap>> | null>
  now?: () => number
  getCachedProducts?: (
    merchantPubkey?: string,
    authorPubkeys?: readonly string[]
  ) => Promise<CachedProduct[]>
  putCachedProducts?: (rows: CachedProduct[]) => Promise<void>
  getCachedProductTombstones?: (
    merchantPubkey?: string,
    authorPubkeys?: readonly string[]
  ) => Promise<CachedProductTombstone[]>
  putCachedProductTombstones?: (rows: CachedProductTombstone[]) => Promise<void>
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
let testProfileCacheWriteLock: Promise<void> = Promise.resolve()
const volatileProductTombstones = new Map<string, CachedProductTombstone>()
const successfulWrapIdsByPrincipal = new Map<string, Set<string>>()
const retryWrapsByPrincipal = new Map<
  string,
  Map<string, { event: NDKEvent; failure?: DecryptFailure }>
>()
const inboxSyncPromises = new Map<string, Promise<PrivateInboxSyncResult>>()
const successfulLegacyDmIdsByPrincipal = new Map<string, Set<string>>()
const MAX_LEGACY_DM_DECRYPT_ATTEMPTS = 2
const retryLegacyDmsByPrincipal = new Map<
  string,
  Map<
    string,
    { event: NDKEvent; attempts: number; failure?: LegacyDmDecryptFailure }
  >
>()
const legacyDmSyncPromises = new Map<string, Promise<LegacyDmSyncResult>>()

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

function publicReadRelayUrls(): string[] {
  return getGeneralReadRelayUrls({
    fallbackRelayUrls:
      config.corePublicFallbackRelayUrls.length > 0
        ? config.corePublicFallbackRelayUrls
        : undefined,
  })
}

function commerceReadRelayUrls(): string[] {
  return getCommerceReadRelayUrls({
    fallbackRelayUrls: config.defaultRelays,
  })
}

function hasCommerceFetchTestOverride(): boolean {
  return !!(
    testOverrides.fetchEventsFanout ||
    testOverrides.fetchEventsFanoutWithDiagnostics ||
    testOverrides.fetchEventsFanoutDetailed ||
    testOverrides.fetchEventsFanoutProgressive
  )
}

/**
 * Resolve a planner-driven relay URL list for a commerce read intent.
 * Pulls cached NIP-65 relay lists for any author/recipient hints so
 * fanout includes the author's write/read relays alongside user settings.
 * Falls back to the legacy URL accessors if planning yields nothing.
 */
type CommerceReadRelayPlan = {
  relayUrls: string[]
  parkedRelayUrls: string[]
  relayHintsComplete: boolean
}

async function planCommerceReadRelayPlan(input: {
  intent: RelayReadIntent
  authors?: readonly string[]
  recipients?: readonly string[]
  authenticatedPubkey?: string | null
  maxRelays?: number
  relayHintMode?: "auto" | "skip" | "force"
  strictRelayHints?: boolean
  /** Untrusted hints that must independently resolve to public WSS targets. */
  extraRelayUrls?: readonly string[]
  /** Hints belonging to the exact authenticated author. */
  authenticatedAuthorRelayUrls?: readonly string[]
}): Promise<CommerceReadRelayPlan> {
  const hintPubkeys = Array.from(
    new Set(
      [...(input.authors ?? []), ...(input.recipients ?? [])]
        .map((p) => p.trim())
        .filter(Boolean)
    )
  )

  const shouldFetchRelayHints =
    hintPubkeys.length > 0 &&
    (input.strictRelayHints === true ||
      input.relayHintMode === "force" ||
      (input.relayHintMode !== "skip" &&
        hintPubkeys.length <= BROAD_AUTHOR_HINT_LIMIT))
  let relayLists: Awaited<ReturnType<typeof getRelayLists>> | undefined
  let relayListResolutionComplete = true
  if (shouldFetchRelayHints && input.strictRelayHints) {
    const result = await getRelayListsDetailed(hintPubkeys, {
      cacheOnly: false,
      skipCache: true,
      allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
    })
    relayLists = result.relayLists
    relayListResolutionComplete = hintPubkeys.every((pubkey) => {
      const state = result.resolutionStates.get(pubkey)
      return state === "network" || state === "missing"
    })
  } else if (shouldFetchRelayHints) {
    relayLists = await getRelayLists(
      hintPubkeys,
      hasCommerceFetchTestOverride()
        ? {
            cacheOnly: true,
            allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
          }
        : {
            allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
          }
    )
  }

  const maxRelays =
    input.maxRelays ??
    (input.strictRelayHints === true
      ? PRODUCT_CANONICAL_READ_MAX_RELAYS
      : undefined)

  const plan = planRelayReads({
    intent: input.intent,
    authors: input.authors,
    recipients: input.recipients,
    relayLists,
    authenticatedPubkey: input.authenticatedPubkey,
    maxRelays,
    skipHealthFilter: input.strictRelayHints === true,
  })

  const fallbackRelayUrls = (() => {
    switch (input.intent) {
      case "commerce_products":
      case "author_products":
        return config.defaultRelays
      default:
        return config.corePublicFallbackRelayUrls.length > 0
          ? config.corePublicFallbackRelayUrls
          : config.defaultRelays
    }
  })()
  const preferFallbackFirst =
    input.strictRelayHints !== true &&
    input.relayHintMode !== "force" &&
    (input.intent === "commerce_products" ||
      (input.intent === "author_products" && (input.authors?.length ?? 0) > 1))
  const publicExternalRelayHints = normalizePublicRelayHints(
    input.extraRelayUrls ?? []
  )
  const authenticatedAuthorRelayHints = normalizeUntrustedRelayHintsForContext({
    relayUrls: input.authenticatedAuthorRelayUrls ?? [],
    approvedRelayUrls: plan.relayUrls,
    allowApprovedPrivate: !!input.authenticatedPubkey,
  })
  const externalRelayHints = uniqueStrings([
    ...publicExternalRelayHints,
    ...authenticatedAuthorRelayHints,
  ])
  const plannedRelayUrls = preferFallbackFirst
    ? uniqueStrings([
        ...fallbackRelayUrls,
        ...externalRelayHints,
        ...plan.relayUrls,
      ])
    : uniqueStrings([
        ...externalRelayHints,
        ...plan.relayUrls,
        ...fallbackRelayUrls,
      ])
  const expandedRelayUrls =
    maxRelays === undefined
      ? plannedRelayUrls
      : plannedRelayUrls.slice(0, maxRelays)
  const relayHintsComplete =
    input.strictRelayHints !== true ||
    (relayListResolutionComplete &&
      plan.parkedRelayUrls.length === 0 &&
      plan.hintRelayUrls.every((relayUrl) =>
        expandedRelayUrls.includes(relayUrl)
      ))

  if (expandedRelayUrls.length > 0) {
    return {
      relayUrls: expandedRelayUrls,
      parkedRelayUrls: plan.parkedRelayUrls.filter(
        (relayUrl) => !expandedRelayUrls.includes(relayUrl)
      ),
      relayHintsComplete,
    }
  }

  // Defensive fallback: legacy resolution paths.
  switch (input.intent) {
    case "commerce_products":
    case "author_products":
      return {
        relayUrls: commerceReadRelayUrls(),
        parkedRelayUrls: [],
        relayHintsComplete,
      }
    default:
      return {
        relayUrls: publicReadRelayUrls(),
        parkedRelayUrls: [],
        relayHintsComplete,
      }
  }
}

async function planCommerceReadRelays(
  input: Parameters<typeof planCommerceReadRelayPlan>[0]
): Promise<string[]> {
  return (await planCommerceReadRelayPlan(input)).relayUrls
}

async function runFetchEventsFanout(
  filter: NDKFilter,
  options?: Parameters<typeof fetchEventsFanout>[1]
): Promise<NDKEvent[]> {
  if (testOverrides.fetchEventsFanout) {
    return (await testOverrides.fetchEventsFanout(
      filter,
      options
    )) as NDKEvent[]
  }
  if (testOverrides.fetchEventsFanoutWithDiagnostics) {
    return (
      await testOverrides.fetchEventsFanoutWithDiagnostics(filter, options)
    ).events
  }
  // A progressive-only test override owns the complete relay boundary. Its
  // fixture can pair an events-only override when deletion events are needed;
  // otherwise deletion discovery is deterministically empty instead of
  // escaping to the network during a unit test.
  if (testOverrides.fetchEventsFanoutProgressive) return []
  return (await fetchEventsFanout(filter, options)) as NDKEvent[]
}

/**
 * Diagnostics-aware fanout honoring the events-only test override. An
 * events-only override cannot report per-relay failure, so its result counts
 * as complete coverage.
 */
async function runFetchEventsFanoutWithDiagnostics(
  filter: NDKFilter,
  options?: Parameters<typeof fetchEventsFanoutWithDiagnostics>[1]
): Promise<Awaited<ReturnType<typeof fetchEventsFanoutWithDiagnostics>>> {
  if (testOverrides.fetchEventsFanoutWithDiagnostics) {
    return await testOverrides.fetchEventsFanoutWithDiagnostics(filter, options)
  }
  if (testOverrides.fetchEventsFanout) {
    const events = (await testOverrides.fetchEventsFanout(
      filter,
      options
    )) as NDKEvent[]
    const relayUrls = [...(options?.relayUrls ?? [])]
    return {
      events,
      attemptedRelayUrls: relayUrls,
      successfulRelayUrls: relayUrls,
      failedRelayUrls: [],
    }
  }
  return await fetchEventsFanoutWithDiagnostics(filter, options)
}

/**
 * Detect saturation before event deduplication. Multiple revisions can fill an
 * individual relay response even when the merged event set stays below the
 * limit, so callers must not certify that bounded read as complete or fresh.
 */
function isBoundedFanoutSaturated(
  filter: NDKFilter,
  events: readonly NDKEvent[],
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
  filter: NDKFilter,
  options?: Parameters<typeof fetchEventsFanoutDetailed>[1]
): Promise<{
  events: NDKEvent[]
  degraded: boolean
  capped: boolean
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
}> {
  if (testOverrides.fetchEventsFanoutDetailed) {
    const result = await testOverrides.fetchEventsFanoutDetailed(
      filter,
      options
    )
    const attemptedRelayUrls = result.relays.map(({ relayUrl }) => relayUrl)
    const successfulRelayUrls = result.relays
      .filter(({ status }) => status !== "failed")
      .map(({ relayUrl }) => relayUrl)
    const failedRelayUrls = result.relays
      .filter(({ status }) => status !== "success")
      .map(({ relayUrl }) => relayUrl)
    return {
      events: result.events,
      degraded: successfulRelayUrls.length === 0 || failedRelayUrls.length > 0,
      capped: isBoundedFanoutSaturated(
        filter,
        result.events,
        result.relays.map((relay) => relay.eventCount)
      ),
      attemptedRelayUrls,
      successfulRelayUrls,
      failedRelayUrls,
    }
  }

  if (testOverrides.fetchEventsFanoutWithDiagnostics) {
    const result = await testOverrides.fetchEventsFanoutWithDiagnostics(
      filter,
      options
    )
    return {
      events: result.events,
      degraded:
        result.successfulRelayUrls.length === 0 ||
        result.failedRelayUrls.length > 0,
      capped: isBoundedFanoutSaturated(filter, result.events),
      attemptedRelayUrls: result.attemptedRelayUrls,
      successfulRelayUrls: result.successfulRelayUrls,
      failedRelayUrls: result.failedRelayUrls,
    }
  }

  // Most gateway tests replace the older event-only seam. Preserve that
  // deterministic contract while production reads use per-relay completion.
  if (testOverrides.fetchEventsFanout) {
    const events = (await testOverrides.fetchEventsFanout(
      filter,
      options
    )) as NDKEvent[]
    const relayUrls = [...(options?.relayUrls ?? [])]
    return {
      events,
      degraded: false,
      capped: isBoundedFanoutSaturated(filter, events),
      attemptedRelayUrls: relayUrls,
      successfulRelayUrls: relayUrls,
      failedRelayUrls: [],
    }
  }

  const result = await fetchEventsFanoutDetailed(filter, options)
  const attemptedRelayUrls = result.relays.map(({ relayUrl }) => relayUrl)
  const successfulRelayUrls = result.relays
    .filter(({ status }) => status !== "failed")
    .map(({ relayUrl }) => relayUrl)
  const failedRelayUrls = result.relays
    .filter(({ status }) => status !== "success")
    .map(({ relayUrl }) => relayUrl)
  return {
    events: result.events,
    degraded: successfulRelayUrls.length === 0 || failedRelayUrls.length > 0,
    capped: isBoundedFanoutSaturated(
      filter,
      result.events,
      result.relays.map((relay) => relay.eventCount)
    ),
    attemptedRelayUrls,
    successfulRelayUrls,
    failedRelayUrls,
  }
}

async function runGetNdk(): Promise<ReturnType<typeof getNdk>> {
  const impl = testOverrides.getNdk ?? getNdk
  return await impl()
}

/**
 * NDK remains an envelope/signer edge, but protected reads must not connect
 * its relay pool merely to reach the active signer.
 */
async function resolveEnvelopeSigner(): Promise<NDKSigner | undefined> {
  return (await runGetNdk()).signer
}

function unavailableInboxStatus(
  failure: ProtectedInboxAuthSummary["failure"] = "signer_unavailable"
): PrivateInboxReadStatus {
  return {
    declarationState: "lookup_unavailable",
    coverage: "unavailable",
    capped: false,
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
}

export function __resetCommerceTestOverrides(): void {
  testOverrides = {}
  testProfileCacheWriteLock = Promise.resolve()
  volatileProductTombstones.clear()
  successfulWrapIdsByPrincipal.clear()
  retryWrapsByPrincipal.clear()
  inboxSyncPromises.clear()
  __resetInboxRelayCache()
  successfulLegacyDmIdsByPrincipal.clear()
  retryLegacyDmsByPrincipal.clear()
  legacyDmSyncPromises.clear()
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
  const capped = options.capped ?? options.inbox?.capped ?? false
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
    capped,
    degraded:
      capped ||
      (options.degraded ??
        (options.stale === true ||
          source !== plan.sources[0] ||
          decryptFailures !== undefined ||
          legacyDecryptFailures !== undefined ||
          // Declaration setup state is reported separately via meta.inbox;
          // only incomplete read coverage degrades the data itself.
          (options.inbox !== undefined &&
            options.inbox.coverage !== "complete"))),
    capabilities,
    fetchedAt: now(),
    nextCursor: options.nextCursor,
    decryptFailures,
    legacyDecryptFailures,
    inbox: options.inbox,
  }
}

function getTagValue(
  tags: string[][] | undefined,
  name: string
): string | null {
  if (!tags) return null
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1]
  }
  return null
}

function toEventCreatedAtSeconds(event: Pick<NDKEvent, "created_at">): number {
  return event.created_at ?? 0
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase()
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

function putMergedEvent(merged: Map<string, NDKEvent>, event: NDKEvent): void {
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
  baseFilter: NDKFilter
  authorChunks: Array<string[] | undefined>
  relayUrls: string[]
  readPolicy?: CommerceReadPolicy
  merged: Map<string, NDKEvent>
  deletionTimestamps?: DeletionTimestamps
  onRecords: (records: CommerceProductRecord[], relayUrl: string) => void
  onTransportStatus?: (degraded: boolean, capped: boolean) => void
}): Promise<void> {
  if (input.relayUrls.length === 0) {
    input.onTransportStatus?.(true, false)
    return
  }

  let nextChunkIndex = 0
  const workerCount = Math.min(
    PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
    input.authorChunks.length
  )
  const fetchProgressive =
    testOverrides.fetchEventsFanoutProgressive ?? fetchEventsFanoutProgressive

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextChunkIndex < input.authorChunks.length) {
        const authors = input.authorChunks[nextChunkIndex]
        nextChunkIndex += 1

        const chunkFilter: NDKFilter = {
          ...input.baseFilter,
          ...(authors ? { authors } : {}),
        }
        const events = await fetchProgressive(
          chunkFilter,
          {
            relayUrls: input.relayUrls,
            connectTimeoutMs: input.readPolicy?.connectTimeoutMs ?? 4_000,
            fetchTimeoutMs: input.readPolicy?.fetchTimeoutMs ?? 8_000,
          },
          ({ events, mergedEvents, relayUrl, status }) => {
            if (status) {
              input.onTransportStatus?.(
                status !== "success",
                isBoundedFanoutSaturated(chunkFilter, events)
              )
            }
            for (const event of mergedEvents) {
              putMergedEvent(input.merged, event)
            }
            input.onRecords(
              dedupeProductEvents(
                Array.from(input.merged.values()),
                input.deletionTimestamps
              ),
              relayUrl
            )
          }
        )
        for (const event of events) {
          putMergedEvent(input.merged, event)
        }
        input.onTransportStatus?.(
          false,
          isBoundedFanoutSaturated(chunkFilter, events)
        )
      }
    })
  )
}

function productMatchesQuery(
  record: CommerceProductRecord,
  query: MarketplaceProductsQuery
): boolean {
  const { product } = record
  const textQuery = normalizeText(query.textQuery)
  if (
    query.authorPubkeys &&
    query.authorPubkeys.length > 0 &&
    !new Set(query.authorPubkeys).has(product.pubkey)
  ) {
    return false
  }
  if (query.merchantPubkey && product.pubkey !== query.merchantPubkey)
    return false
  if (
    query.authorPubkeys &&
    query.authorPubkeys.length > 0 &&
    !query.authorPubkeys.includes(product.pubkey)
  ) {
    return false
  }
  if (textQuery) {
    const haystack = `${product.title}\n${product.summary ?? ""}`.toLowerCase()
    if (!haystack.includes(textQuery)) return false
  }

  if (query.tags && query.tags.length > 0) {
    const tagSet = new Set(canonicalizeProductTags(query.tags))
    if (!canonicalizeProductTags(product.tags).some((tag) => tagSet.has(tag))) {
      return false
    }
  }

  return true
}

function sortProducts(
  records: CommerceProductRecord[],
  sort: CommerceSortMode | undefined
): CommerceProductRecord[] {
  const items = [...records]
  const familySummaryPrice = (record: CommerceProductRecord): Product =>
    record.family?.priceSummary.minimum?.product ?? record.product
  switch (sort) {
    case "price_asc":
      return items.sort(
        (a, b) =>
          compareCommercePrices(
            familySummaryPrice(a),
            familySummaryPrice(b),
            null,
            "asc"
          ) || b.product.updatedAt - a.product.updatedAt
      )
    case "price_desc":
      return items.sort(
        (a, b) =>
          compareCommercePrices(
            familySummaryPrice(a),
            familySummaryPrice(b),
            null,
            "desc"
          ) || b.product.updatedAt - a.product.updatedAt
      )
    case "updated_at_desc":
      return items.sort(
        (a, b) =>
          b.product.updatedAt - a.product.updatedAt ||
          b.eventCreatedAt - a.eventCreatedAt
      )
    case "newest":
    default:
      return items.sort(
        (a, b) =>
          b.eventCreatedAt - a.eventCreatedAt ||
          b.product.updatedAt - a.product.updatedAt
      )
  }
}

function isValidProductImageUrl(url: string | undefined): boolean {
  return normalizePublicMediaUrl(url) !== null
}

export function hasMarketProductImage(
  product: Pick<Product, "images">
): boolean {
  return product.images.some((image) => isValidProductImageUrl(image.url))
}

function withListingSafety(
  record: Omit<CommerceProductRecord, "safety"> & {
    safety?: ListingSafetyEvaluation
  }
): CommerceProductRecord {
  return {
    ...record,
    safety: record.safety ?? evaluateListingSafety(record.product),
  }
}

function isMarketRenderableRecord(record: CommerceProductRecord): boolean {
  if (record.product.type === "variable" && record.family?.state !== "ready") {
    return false
  }
  return isListingMarketVisible(
    record.safety ?? evaluateListingSafety(record.product)
  )
}

function prepareVariationGroups(
  records: CommerceProductRecord[],
  readEvidence: ProductFamilyReadEvidence = {
    source: records.some((record) => (record.sourceRelayUrls?.length ?? 0) > 0)
      ? "commerce"
      : "local_cache",
    fetchedAt: now(),
    stale: false,
    degraded: false,
    capped: false,
  }
): CommerceProductRecord[] {
  const catalog = prepareProductCatalog(records, readEvidence)

  return catalog.items.flatMap((item) => {
    if (item.kind === "simple") return [item.record]

    const { parent } = item.family
    const eligibleVariationRecords = item.family.children.filter((variation) =>
      isListingMarketVisible(
        evaluateListingSafety(variation.product, undefined, {
          variationGroupRole: "variation",
          hasGroupImage: true,
        })
      )
    )
    const hasGroupImage =
      hasMarketProductImage(parent.product) ||
      eligibleVariationRecords.some((variation) =>
        hasMarketProductImage(variation.product)
      )
    const variations = eligibleVariationRecords
      .filter((variation) =>
        isListingMarketVisible(
          evaluateListingSafety(variation.product, undefined, {
            variationGroupRole: "variation",
            hasGroupImage,
          })
        )
      )
      .sort(
        (left, right) =>
          left.eventCreatedAt - right.eventCreatedAt ||
          left.addressId.localeCompare(right.addressId)
      )
    if (variations.length === 0) {
      return [
        {
          ...parent,
          family: item.family,
          safety: evaluateListingSafety(parent.product, undefined, {
            variationGroupRole: "parent",
            hasGroupImage,
          }),
        },
      ]
    }

    const prepared = prepareProductCatalog(
      [parent, ...variations],
      readEvidence
    ).items[0]
    if (prepared?.kind !== "family") return []

    return [
      {
        ...parent,
        family: prepared.family,
        safety: evaluateListingSafety(parent.product, undefined, {
          variationGroupRole: "parent",
          hasGroupImage,
        }),
      },
    ]
  })
}

function withProductFamilyReadEvidence(
  records: CommerceProductRecord[],
  meta: CommerceQueryMeta
): CommerceProductRecord[] {
  const readEvidence: ProductFamilyReadEvidence = {
    source: meta.source,
    fetchedAt: meta.fetchedAt,
    stale: meta.stale,
    degraded: meta.degraded,
    capped: meta.capped ?? false,
  }
  return records.map((record) =>
    record.family
      ? {
          ...record,
          family: { ...record.family, readEvidence },
        }
      : record
  )
}

function withProductFamilyRecordReadEvidence(
  record: CommerceProductRecord | null,
  meta: CommerceQueryMeta
): CommerceProductRecord | null {
  return record
    ? (withProductFamilyReadEvidence([record], meta)[0] ?? null)
    : null
}

function filterProductRecordsForRead(
  records: CommerceProductRecord[],
  options: {
    includeMarketHidden?: boolean
    groupVariations?: boolean
  } = {}
): CommerceProductRecord[] {
  if (options.includeMarketHidden && options.groupVariations !== true) {
    return records
  }

  const prepared =
    options.groupVariations === false
      ? records
      : prepareVariationGroups(records)
  return options.includeMarketHidden
    ? prepared
    : prepared.filter(isMarketRenderableRecord)
}

function filterExactProductRecordsForRead(
  records: CommerceProductRecord[],
  wanted: ReadonlySet<string>,
  includeMarketHidden?: boolean
): CommerceProductRecord[] {
  const targets = records.filter((record) => wanted.has(record.addressId))
  if (includeMarketHidden) return targets

  const preparedByAddress = new Map(
    prepareVariationGroups(records).map((record) => [record.addressId, record])
  )

  return targets.flatMap((target) => {
    if (target.product.type === "simple") {
      return isMarketRenderableRecord(target) ? [target] : []
    }
    if (target.product.type === "variable") {
      const prepared = preparedByAddress.get(target.addressId)
      return prepared && isMarketRenderableRecord(prepared) ? [prepared] : []
    }

    const parent = target.product.parentProductId
      ? preparedByAddress.get(target.product.parentProductId)
      : undefined
    const variation = parent?.family?.children.find(
      (candidate) => candidate.product.id === target.product.id
    )
    if (!parent || !isMarketRenderableRecord(parent) || !variation) return []

    return [
      {
        ...target,
        safety: evaluateListingSafety(variation.product, undefined, {
          variationGroupRole: "variation",
          hasGroupImage: true,
        }),
      },
    ]
  })
}

function toCachedProduct(record: CommerceProductRecord) {
  const { product } = record
  return {
    id: product.id,
    pubkey: product.pubkey,
    title: product.title,
    summary: product.summary,
    price: product.price,
    currency: product.currency,
    priceSats: product.priceSats,
    sourcePrice: product.sourcePrice,
    type: product.type,
    parentProductId: product.parentProductId,
    specifications: product.specifications,
    format: product.format,
    shippingCostSats: product.shippingCostSats,
    sourceShippingCost: product.sourceShippingCost,
    shippingOptionId: product.shippingOptionId,
    shippingOptionDTag: product.shippingOptionDTag,
    shippingCountries: product.shippingCountries,
    shippingCountryRules: product.shippingCountryRules,
    visibility: product.visibility,
    stock: product.stock,
    images: getProductProtocolImages(product),
    tags: canonicalizeProductTags(product.tags),
    publicZapEnabled: product.publicZapEnabled,
    zapMessagePolicy: product.zapMessagePolicy,
    publicZapPolicyKnown: product.publicZapPolicyKnown,
    location: product.location,
    eventId: record.eventId,
    eventCreatedAt: record.eventCreatedAt,
    dTag: record.dTag ?? undefined,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    sourceRelayUrls: record.sourceRelayUrls,
    cachedAt: now(),
  }
}

function fromCachedProduct(row: CachedProduct): CommerceProductRecord {
  const zapMessagePolicy =
    row.zapMessagePolicy === "custom" ? row.zapMessagePolicy : "generic_only"
  const tags = canonicalizeProductTags(row.tags)
  const summary = normalizeProductSummaryForDisplay(row.summary, {
    title: row.title,
    priceInfo: {
      price: row.sourcePrice?.amount ?? row.price,
      currency: row.sourcePrice?.currency ?? row.currency,
    },
    tags,
  })
  const product: Product = {
    id: row.id,
    pubkey: row.pubkey,
    title: row.title,
    summary,
    price: row.price,
    currency: row.currency,
    priceSats: row.priceSats,
    sourcePrice: row.sourcePrice,
    type: row.type ?? "simple",
    parentProductId: row.parentProductId,
    specifications: row.specifications ?? [],
    format: row.format ?? "physical",
    shippingCostSats: row.shippingCostSats,
    sourceShippingCost: row.sourceShippingCost,
    shippingOptionId: row.shippingOptionId,
    shippingOptionDTag: row.shippingOptionDTag,
    shippingCountries: row.shippingCountries,
    shippingCountryRules: row.shippingCountryRules,
    visibility: row.visibility ?? "public",
    stock: row.stock,
    images: getProductProtocolImages({ images: row.images ?? [] }),
    tags,
    publicZapEnabled: row.publicZapEnabled ?? true,
    zapMessagePolicy,
    publicZapPolicyKnown: row.publicZapPolicyKnown ?? false,
    location: row.location,
    createdAt: row.createdAt ?? row.cachedAt,
    updatedAt: row.updatedAt ?? row.cachedAt,
  }

  // Cache rows written before the signed d-tag was stored are intentionally
  // treated as exact-event-only legacy records. Reconstructing a coordinate
  // from a display/cache id could broaden a deletion beyond signed metadata.
  const cachedAddress = parseProductAddressCoordinate(row.id)
  const dTag =
    typeof row.dTag === "string" &&
    cachedAddress?.authorPubkey === row.pubkey.toLowerCase() &&
    cachedAddress.dTag === row.dTag
      ? row.dTag
      : null
  return withListingSafety({
    product,
    eventId: row.eventId ?? product.id,
    addressId: product.id,
    dTag,
    eventCreatedAt: row.eventCreatedAt ?? Math.floor(product.createdAt / 1000),
    sourceRelayUrls: row.sourceRelayUrls,
  })
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

function mergeContextualRelayHints(
  ...hints: readonly ContextualRelayHints[]
): ContextualRelayHints {
  return {
    publicRelayUrls: uniqueStrings(
      hints.flatMap((hint) => hint.publicRelayUrls)
    ),
    authenticatedAuthorRelayUrls: uniqueStrings(
      hints.flatMap((hint) => hint.authenticatedAuthorRelayUrls)
    ),
  }
}

async function loadProductSourceRelayHints(
  pubkeys: readonly string[],
  authenticatedPubkey?: string | null
): Promise<ContextualRelayHints> {
  const uniquePubkeys = uniqueStrings(pubkeys)
  if (uniquePubkeys.length === 0) {
    return { publicRelayUrls: [], authenticatedAuthorRelayUrls: [] }
  }

  const rowsByPubkey = await Promise.all(
    uniquePubkeys.map(async (pubkey) => ({
      pubkey,
      rows: await loadCachedProducts(pubkey),
    }))
  )

  return contextualRelayHints(
    rowsByPubkey.map(({ pubkey, rows }) => ({
      pubkey,
      relayUrls: rows.flatMap((row) => row.sourceRelayUrls ?? []),
    })),
    authenticatedPubkey
  )
}

function getProfileQueryRelayHints(
  query: ProfileBatchQuery
): ContextualRelayHints {
  return contextualRelayHints(
    query.pubkeys.map((pubkey) => ({
      pubkey,
      relayUrls: query.relayHintsByPubkey?.[pubkey] ?? [],
    })),
    query.authenticatedPubkey
  )
}

async function loadCachedProducts(
  merchantPubkey?: string,
  authorPubkeys?: readonly string[]
): Promise<CachedProduct[]> {
  if (testOverrides.getCachedProducts) {
    return await testOverrides.getCachedProducts(merchantPubkey, authorPubkeys)
  }

  if (merchantPubkey) {
    return await db.products.where("pubkey").equals(merchantPubkey).toArray()
  }

  // Perspective catalog reads scope to a known author set; hit the `pubkey`
  // index instead of scanning + filtering the whole products table in JS.
  if (authorPubkeys && authorPubkeys.length > 0) {
    return await db.products
      .where("pubkey")
      .anyOf(authorPubkeys as string[])
      .toArray()
  }

  return await db.products.toArray()
}

function cachedProductEventCreatedAt(row: CachedProduct): number {
  return (
    row.eventCreatedAt ??
    Math.floor((row.updatedAt ?? row.createdAt ?? 0) / 1000)
  )
}

function shouldReplaceCachedProduct(
  existing: CachedProduct,
  candidate: CachedProduct
): boolean {
  const existingCreatedAt = cachedProductEventCreatedAt(existing)
  const candidateCreatedAt = cachedProductEventCreatedAt(candidate)
  if (candidateCreatedAt !== existingCreatedAt) {
    return candidateCreatedAt > existingCreatedAt
  }

  if (candidate.eventId && existing.eventId) {
    return candidate.eventId <= existing.eventId
  }
  if (candidate.eventId) return true
  if (existing.eventId) return false
  return candidate.cachedAt >= existing.cachedAt
}

function selectCachedProductUpdates(
  rows: CachedProduct[],
  existingRows: CachedProduct[]
): CachedProduct[] {
  const ids = Array.from(new Set(rows.map((row) => row.id)))
  const selected = new Map(
    existingRows
      .filter((row) => ids.includes(row.id))
      .map((row) => [row.id, row])
  )
  const changed = new Map<string, CachedProduct>()

  for (const row of rows) {
    const existing = selected.get(row.id)
    if (!existing) {
      selected.set(row.id, row)
      changed.set(row.id, row)
      continue
    }
    const candidateWins = shouldReplaceCachedProduct(existing, row)
    const winner = candidateWins ? row : existing
    const sourceRelayUrls = uniqueStrings([
      ...(existing.sourceRelayUrls ?? []),
      ...(row.sourceRelayUrls ?? []),
    ])
    const merged = {
      ...winner,
      sourceRelayUrls,
      dTag: winner.dTag ?? existing.dTag ?? row.dTag,
      cachedAt: Math.max(existing.cachedAt, row.cachedAt),
    }
    if (
      candidateWins ||
      sourceRelayUrls.length !== (existing.sourceRelayUrls?.length ?? 0) ||
      merged.dTag !== existing.dTag ||
      merged.cachedAt !== existing.cachedAt
    ) {
      selected.set(row.id, merged)
      changed.set(row.id, merged)
    }
  }

  return Array.from(changed.values())
}

async function storeCachedProducts(rows: CachedProduct[]): Promise<void> {
  if (rows.length === 0) return

  if (testOverrides.putCachedProducts) {
    const existingRows = testOverrides.getCachedProducts
      ? await testOverrides.getCachedProducts()
      : []
    const rowsToStore = selectCachedProductUpdates(rows, existingRows)
    if (rowsToStore.length === 0) return
    await testOverrides.putCachedProducts(rowsToStore)
    return
  }

  const ids = Array.from(new Set(rows.map((row) => row.id)))
  await db.transaction("rw", db.products, async () => {
    const existingRows = (await db.products.bulkGet(ids)).filter(
      (row): row is CachedProduct => row !== undefined
    )
    const rowsToStore = selectCachedProductUpdates(rows, existingRows)
    if (rowsToStore.length > 0) {
      await db.products.bulkPut(rowsToStore)
    }
  })
}

function productTombstoneIdForAddress(addressId: string): string {
  return `a:${addressId}`
}

function productTombstoneIdForEvent(pubkey: string, eventId: string): string {
  return `e:${pubkey}:${eventId}`
}

function tombstonesFromDeletionEvent(
  event: NDKEvent,
  options: { observedLocally: boolean }
): CachedProductTombstone[] {
  if (!event.pubkey) throw new Error("Deletion event pubkey is required")
  if (!event.id) throw new Error("Deletion event id is required")

  const deletedAt = toEventCreatedAtSeconds(event)
  const rows = new Map<string, CachedProductTombstone>()
  const cachedAt = now()
  const sourceRelayUrls = getEventSourceRelayUrls(event)
  const validated = validateProductDeletionEvent(
    event.rawEvent() as SignedPublicNostrEvent
  )
  if (!validated) {
    throw new Error("Expected a valid signed product deletion event")
  }
  const { evidence, signedEvent } = validated

  for (const item of evidence) {
    const id =
      item.target === "event"
        ? productTombstoneIdForEvent(item.authorPubkey, item.eventId)
        : productTombstoneIdForAddress(item.addressId)
    rows.set(id, {
      id,
      pubkey: item.authorPubkey,
      ...(item.target === "event"
        ? { eventId: item.eventId }
        : { addressId: item.addressId }),
      deletedAt,
      deletionEventId: event.id,
      signedEvent,
      sourceRelayUrls,
      observedLocally: options.observedLocally,
      cachedAt,
    })
  }

  return Array.from(rows.values())
}

async function loadCachedProductTombstones(
  merchantPubkey?: string,
  authorPubkeys?: readonly string[]
): Promise<CachedProductTombstone[]> {
  if (testOverrides.getCachedProductTombstones) {
    return await testOverrides.getCachedProductTombstones(
      merchantPubkey,
      authorPubkeys
    )
  }

  if (merchantPubkey) {
    return await db.productTombstones
      .where("pubkey")
      .equals(merchantPubkey)
      .toArray()
  }

  if (authorPubkeys && authorPubkeys.length > 0) {
    return await db.productTombstones
      .where("pubkey")
      .anyOf(authorPubkeys as string[])
      .toArray()
  }

  return await db.productTombstones.toArray()
}

function selectCachedProductTombstoneUpdates(
  rows: CachedProductTombstone[],
  existingRows: CachedProductTombstone[]
): CachedProductTombstone[] {
  const ids = Array.from(new Set(rows.map((row) => row.id)))
  const selected = new Map(
    existingRows
      .filter((row) => ids.includes(row.id))
      .map((row) => [row.id, row])
  )
  const changed = new Map<string, CachedProductTombstone>()

  for (const row of rows) {
    const existing = selected.get(row.id)
    if (!existing) {
      selected.set(row.id, row)
      changed.set(row.id, row)
      continue
    }

    const candidateWins =
      row.deletedAt > existing.deletedAt ||
      (row.deletedAt === existing.deletedAt &&
        row.deletionEventId <= existing.deletionEventId)
    const winner = candidateWins ? row : existing
    const sourceRelayUrls = uniqueStrings([
      ...(existing.sourceRelayUrls ?? []),
      ...(row.sourceRelayUrls ?? []),
    ])
    const merged: CachedProductTombstone = {
      ...winner,
      sourceRelayUrls,
      observedLocally:
        existing.observedLocally === true || row.observedLocally === true,
      cachedAt: Math.max(existing.cachedAt, row.cachedAt),
    }
    if (
      candidateWins ||
      sourceRelayUrls.length !== (existing.sourceRelayUrls?.length ?? 0) ||
      merged.observedLocally !== existing.observedLocally
    ) {
      selected.set(row.id, merged)
      changed.set(row.id, merged)
    }
  }

  return Array.from(changed.values())
}

async function storeCachedProductTombstones(
  rows: CachedProductTombstone[]
): Promise<void> {
  if (rows.length === 0) return

  if (testOverrides.putCachedProductTombstones) {
    const existingRows = testOverrides.getCachedProductTombstones
      ? await testOverrides.getCachedProductTombstones()
      : []
    const rowsToStore = selectCachedProductTombstoneUpdates(rows, existingRows)
    if (rowsToStore.length === 0) return
    await testOverrides.putCachedProductTombstones(rowsToStore)
    return
  }

  const ids = Array.from(new Set(rows.map((row) => row.id)))
  await db.transaction("rw", db.productTombstones, async () => {
    const existingRows = (await db.productTombstones.bulkGet(ids)).filter(
      (row): row is CachedProductTombstone => row !== undefined
    )
    const rowsToStore = selectCachedProductTombstoneUpdates(rows, existingRows)
    if (rowsToStore.length > 0) {
      await db.productTombstones.bulkPut(rowsToStore)
    }
  })
}

function rememberVolatileProductTombstones(
  rows: readonly CachedProductTombstone[]
): void {
  const updates = selectCachedProductTombstoneUpdates(
    [...rows],
    Array.from(volatileProductTombstones.values())
  )
  for (const row of updates) {
    volatileProductTombstones.set(row.id, row)
  }
}

async function flushVolatileProductTombstones(): Promise<boolean> {
  const pendingRows = Array.from(volatileProductTombstones.values())
  if (pendingRows.length === 0) return true

  try {
    await storeCachedProductTombstones(pendingRows)
  } catch {
    return false
  }

  for (const row of pendingRows) {
    // A concurrent read may have observed newer evidence for the same target
    // while persistence was in flight. Only clear the exact row we flushed.
    if (volatileProductTombstones.get(row.id) === row) {
      volatileProductTombstones.delete(row.id)
    }
  }
  return true
}

function deletionTimestampsFromTombstones(
  tombstones: readonly CachedProductTombstone[]
): DeletionTimestamps {
  const byEventId = new Map<string, ProductDeletionEvidence>()
  const byAddressId = new Map<string, ProductDeletionEvidence>()

  for (const tombstone of tombstones) {
    if (tombstone.eventId) {
      const key = scopedProductDeletionEventKey(
        tombstone.pubkey,
        tombstone.eventId
      )
      if (key) {
        setLatestDeletionEvidence(byEventId, key, {
          target: "event",
          deletionEventId: tombstone.deletionEventId,
          authorPubkey: tombstone.pubkey,
          deletedAt: tombstone.deletedAt,
          eventId: tombstone.eventId,
        })
      }
    }
    if (tombstone.addressId) {
      const key = productDeletionAddressKey(tombstone.addressId)
      if (key) {
        setLatestDeletionEvidence(byAddressId, key, {
          target: "address",
          deletionEventId: tombstone.deletionEventId,
          authorPubkey: tombstone.pubkey,
          deletedAt: tombstone.deletedAt,
          addressId: tombstone.addressId,
        })
      }
    }
  }

  return { byEventId, byAddressId }
}

function mergeDeletionTimestamps(
  ...frontiers: readonly DeletionTimestamps[]
): DeletionTimestamps {
  const byEventId = new Map<string, ProductDeletionEvidence>()
  const byAddressId = new Map<string, ProductDeletionEvidence>()

  for (const frontier of frontiers) {
    for (const [key, evidence] of frontier.byEventId) {
      setLatestDeletionEvidence(byEventId, key, evidence)
    }
    for (const [key, evidence] of frontier.byAddressId) {
      setLatestDeletionEvidence(byAddressId, key, evidence)
    }
  }

  return { byEventId, byAddressId }
}

async function mergeObservedDeletionTimestampsWithLocal(
  observed: DeletionTimestamps,
  authors: readonly string[]
): Promise<DeletionTimestamps> {
  try {
    return mergeDeletionTimestamps(
      await getLocalProductDeletionTimestamps(undefined, authors),
      observed
    )
  } catch {
    // If the local database is unavailable after relay validation, the
    // in-memory frontier is still authoritative for this read.
    return observed
  }
}

async function getLocalProductDeletionTimestamps(
  merchantPubkey?: string,
  authorPubkeys?: readonly string[]
): Promise<DeletionTimestamps> {
  const authorSet =
    authorPubkeys && authorPubkeys.length > 0
      ? new Set(authorPubkeys)
      : undefined
  const volatileRows = Array.from(volatileProductTombstones.values()).filter(
    (row) =>
      (!merchantPubkey || row.pubkey === merchantPubkey) &&
      (!authorSet || authorSet.has(row.pubkey))
  )
  let persistedRows: CachedProductTombstone[] = []
  try {
    persistedRows = await loadCachedProductTombstones(
      merchantPubkey,
      authorPubkeys
    )
  } catch (error) {
    if (volatileRows.length === 0) throw error
  }
  return deletionTimestampsFromTombstones([...persistedRows, ...volatileRows])
}

function filterDeletedProductRecords(
  records: CommerceProductRecord[],
  deletionTimestamps: DeletionTimestamps
): CommerceProductRecord[] {
  return records.filter(
    (record) => !isRecordDeletedByNip09(record, deletionTimestamps)
  )
}

export async function cacheSignedProductListingEvent(
  event: NDKEvent
): Promise<CommerceProductRecord> {
  if (
    event.kind !== EVENT_KINDS.PRODUCT ||
    !event.id ||
    !event.sig ||
    !isValidSignedPublicNostrEvent(event.rawEvent() as SignedPublicNostrEvent)
  ) {
    throw new Error("Expected a valid signed product listing event")
  }

  const [record] = dedupeProductEvents([event])
  if (!record) throw new Error("Could not parse signed product listing event")

  await cacheProductRecords([record])
  return record
}

export async function cacheSignedProductDeletionEvent(
  event: NDKEvent
): Promise<CachedProductTombstone[]> {
  const tombstones = tombstonesFromDeletionEvent(event, {
    observedLocally: true,
  })
  if (tombstones.length === 0) {
    throw new Error("Deletion event does not contain a valid product target")
  }
  await storeCachedProductTombstones(tombstones)
  return tombstones
}

async function getCachedProductRecords(
  merchantPubkey?: string,
  options: CachedProductReadOptions = {},
  authorPubkeys?: readonly string[]
): Promise<CommerceProductRecord[]> {
  const rows = await loadCachedProducts(merchantPubkey, authorPubkeys)
  const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
    merchantPubkey,
    authorPubkeys
  )
  return rows
    .filter(
      (row) =>
        options.includeStale || now() - row.cachedAt < PRODUCT_CACHE_TTL_MS
    )
    .map(fromCachedProduct)
    .filter(
      (record) => !isRecordDeletedByNip09(record, localDeletionTimestamps)
    )
    .filter(
      (record) =>
        options.includeMarketHidden || isMarketRenderableRecord(record)
    )
}

async function cacheProductRecords(
  records: CommerceProductRecord[]
): Promise<void> {
  if (records.length === 0) return
  await storeCachedProducts(records.map(toCachedProduct))
}

async function loadCachedProfiles(
  pubkeys: string[]
): Promise<Array<CachedProfile | undefined>> {
  if (testOverrides.getCachedProfiles) {
    return await testOverrides.getCachedProfiles(pubkeys)
  }

  return await db.profiles.bulkGet(pubkeys)
}

async function storeCachedProfiles(
  rows: CachedProfile[]
): Promise<CachedProfileRetentionResult> {
  if (rows.length === 0) {
    return { rows: [], displacedPubkeys: new Set() }
  }

  if (testOverrides.getCachedProfiles || testOverrides.putCachedProfiles) {
    const previous = testProfileCacheWriteLock
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    testProfileCacheWriteLock = previous.catch(() => undefined).then(() => gate)

    await previous.catch(() => undefined)
    try {
      const pubkeys = Array.from(new Set(rows.map((row) => row.pubkey)))
      const currentRows = testOverrides.getCachedProfiles
        ? await testOverrides.getCachedProfiles(pubkeys)
        : pubkeys.map(() => undefined)
      const retention = reduceCachedProfileRows(rows, currentRows)
      if (retention.updates.length > 0 && testOverrides.putCachedProfiles) {
        await testOverrides.putCachedProfiles(retention.updates)
      }
      return {
        rows: retention.rows,
        displacedPubkeys: retention.displacedPubkeys,
      }
    } finally {
      release()
    }
  }

  return await retainStrongestCachedProfiles(rows)
}

function hasProfileContent(
  profile: Pick<
    CachedProfile,
    | "name"
    | "displayName"
    | "about"
    | "picture"
    | "banner"
    | "nip05"
    | "lud16"
    | "website"
  >
): boolean {
  return [
    profile.name,
    profile.displayName,
    profile.about,
    profile.picture,
    profile.banner,
    profile.nip05,
    profile.lud16,
    profile.website,
  ].some((value) => typeof value === "string" && value.trim().length > 0)
}

function compareReplaceableProfileEvents(a: NDKEvent, b: NDKEvent): number {
  const createdAt = (b.created_at ?? 0) - (a.created_at ?? 0)
  if (createdAt !== 0) return createdAt
  return (a.id || "\uffff").localeCompare(b.id || "\uffff")
}

function pickLatestProfileEvent(
  events: readonly NDKEvent[],
  pubkey: string
): NDKEvent | undefined {
  return events
    .filter((event) => event.pubkey === pubkey)
    .sort(compareReplaceableProfileEvents)[0]
}

function pickLatestProfileEventWithContent(
  events: readonly NDKEvent[],
  pubkey: string
): NDKEvent | undefined {
  return events
    .filter((event) => event.pubkey === pubkey)
    .sort(compareReplaceableProfileEvents)
    .find((event) => hasProfileContent(parseProfileEvent(event)))
}

function mergeProfileEvents(
  pubkeys: readonly string[],
  currentProfiles: Record<string, Profile>,
  events: readonly NDKEvent[],
  currentRows: ReadonlyMap<string, CachedProfile> = new Map()
): {
  profiles: Record<string, Profile>
  rowsToCache: CachedProfile[]
  hasResolvedProfile: boolean
} {
  const profiles = { ...currentProfiles }
  const rowsToCache: CachedProfile[] = []
  let hasResolvedProfile = false

  for (const pubkey of pubkeys) {
    const event = pickLatestProfileEventWithContent(events, pubkey)
    const latestEvent = pickLatestProfileEvent(events, pubkey)
    const currentRow = currentRows.get(pubkey)
    const currentFrontier = currentRow?.eventCreatedAt ?? -1
    const latestEventCreatedAt = latestEvent?.created_at ?? -1
    const latestEventWins =
      !!latestEvent &&
      (latestEventCreatedAt > currentFrontier ||
        (latestEventCreatedAt === currentFrontier &&
          (latestEvent.id || "\uffff") < (currentRow?.eventId || "\uffff")))
    const frontier = latestEventWins ? latestEvent : undefined
    const exactCurrentFrontierObserved =
      !!latestEvent?.id &&
      latestEventCreatedAt === currentFrontier &&
      latestEvent.id === currentRow?.eventId
    const currentProjection = currentRow
      ? projectCachedProfile(currentRow)
      : undefined
    const currentFrontierWins =
      currentRow?.eventCreatedAt !== undefined &&
      (!latestEvent ||
        latestEventCreatedAt < currentFrontier ||
        (latestEventCreatedAt === currentFrontier &&
          (currentRow.eventId || "\uffff") <= (latestEvent.id || "\uffff")))
    const profile = exactCurrentFrontierObserved
      ? mergeRicherProfile(
          undefined,
          event ? parseProfileEvent(event) : { pubkey }
        )
      : mergeRicherProfile(
          profiles[pubkey] ?? currentProjection,
          currentFrontierWins
            ? undefined
            : event
              ? parseProfileEvent(event)
              : { pubkey }
        )
    const sourceRelayUrls = uniqueStrings([
      ...(currentRow?.sourceRelayUrls ?? []),
      ...(event ? getEventSourceRelayUrls(event) : []),
      ...(latestEvent ? getEventSourceRelayUrls(latestEvent) : []),
    ])
    profiles[pubkey] = profile ?? { pubkey }
    const observedFrontier =
      frontier ?? (exactCurrentFrontierObserved ? latestEvent : undefined)
    if (observedFrontier || (profile && hasProfileContent(profile))) {
      if (event) hasResolvedProfile = true
      const cachedProfile = profile ?? { pubkey }
      rowsToCache.push({
        pubkey: cachedProfile.pubkey,
        name: cachedProfile.name,
        displayName: cachedProfile.displayName,
        about: cachedProfile.about,
        picture: cachedProfile.picture,
        banner: cachedProfile.banner,
        nip05: cachedProfile.nip05,
        lud16: cachedProfile.lud16,
        website: cachedProfile.website,
        rawContent: observedFrontier?.content ?? currentRow?.rawContent,
        eventId: observedFrontier?.id || currentRow?.eventId,
        eventCreatedAt:
          observedFrontier?.created_at ?? currentRow?.eventCreatedAt,
        sourceRelayUrls:
          sourceRelayUrls.length > 0 ? sourceRelayUrls : undefined,
        cachedAt: now(),
      })
    }
  }

  return { profiles, rowsToCache, hasResolvedProfile }
}

async function loadCachedOrderMessages(
  principalPubkey: string
): Promise<CachedOrderMessage[]> {
  if (testOverrides.getCachedOrderMessages) {
    return await testOverrides.getCachedOrderMessages(principalPubkey)
  }

  return await db.orderMessages
    .where("recipientPubkey")
    .equals(principalPubkey)
    .or("senderPubkey")
    .equals(principalPubkey)
    .toArray()
}

async function storeCachedOrderMessages(
  rows: CachedOrderMessage[]
): Promise<void> {
  if (rows.length === 0) return

  if (testOverrides.putCachedOrderMessages) {
    await testOverrides.putCachedOrderMessages(rows)
    return
  }

  await db.orderMessages.bulkPut(rows)
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
  message: ParsedOrderMessage
): Promise<void> {
  await storeCachedOrderMessages([cachedOrderMessageRow(message)])
}

type DeletionTimestamps = {
  byEventId: Map<string, ProductDeletionEvidence>
  byAddressId: Map<string, ProductDeletionEvidence>
}

function setLatestDeletionEvidence(
  map: Map<string, ProductDeletionEvidence>,
  key: string,
  value: ProductDeletionEvidence
): void {
  const existing = map.get(key)
  if (
    !existing ||
    value.deletedAt > existing.deletedAt ||
    (value.deletedAt === existing.deletedAt &&
      value.deletionEventId <= existing.deletionEventId)
  ) {
    map.set(key, value)
  }
}

type ProductDeletionCandidate = {
  pubkey: string
  eventId?: string
  addressId?: string
  sourceRelayUrls?: readonly string[]
}

function deletionCandidateFromEvent(event: NDKEvent): ProductDeletionCandidate {
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
    readPolicy?: CommerceReadPolicy
    fallbackWhenEmpty?: boolean
    authenticatedPubkey?: string | null
    fetchEvents?: typeof runFetchEventsFanout
    onSkippedRelayUrls?: (relayUrls: readonly string[]) => void
    onIncompleteRelayHints?: () => void
    strictRelayHints?: boolean
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
      const filters: NDKFilter[] = [
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
        intent: "author_products",
        authors: authorChunk,
        authenticatedPubkey: options.authenticatedPubkey,
        maxRelays: options.readPolicy?.maxRelays,
        strictRelayHints: options.strictRelayHints,
      })
      if (!deletionRelayPlan.relayHintsComplete) {
        options.onIncompleteRelayHints?.()
      }
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
      const preferredDeletionRelayUrls = uniqueStrings([
        ...sourceRelayUrls,
        ...CANONICAL_APP_BACKPLANE_RELAYS,
        ...deletionRelayPlan.relayUrls,
      ])
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
      const fetchDeletionFilter = async (
        filter: NDKFilter
      ): Promise<NDKEvent[]> =>
        (
          await mapWithConcurrency(
            deletionRelayBatches,
            PRODUCT_AUTHOR_CHUNK_CONCURRENCY,
            async (relayUrls) =>
              await (options.fetchEvents ?? runFetchEventsFanout)(filter, {
                relayUrls,
                connectTimeoutMs: options.readPolicy?.connectTimeoutMs ?? 4_000,
                fetchTimeoutMs: options.readPolicy?.fetchTimeoutMs ?? 10_000,
                skipHealthFilter: options.strictRelayHints === true,
              })
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
  const deletionEventsById = new Map<string, NDKEvent>()
  for (const deletionEvent of deletionEventBatches.flat()) {
    putMergedEvent(deletionEventsById, deletionEvent)
  }
  const deletionEvents = Array.from(deletionEventsById.values())

  const observedTombstones: CachedProductTombstone[] = []
  for (const deletion of deletionEvents) {
    try {
      observedTombstones.push(
        ...tombstonesFromDeletionEvent(deletion, { observedLocally: false })
      )
    } catch {
      // Relay data is untrusted. Invalid signatures and malformed targets
      // never become durable deletion evidence.
    }
  }
  const observedDeletionTimestamps =
    deletionTimestampsFromTombstones(observedTombstones)
  rememberVolatileProductTombstones(observedTombstones)
  if (!(await flushVolatileProductTombstones())) {
    // The current read must still honor deletion evidence that was already
    // cryptographically validated. The volatile frontier is monotonic and is
    // retried on later reads; returning stale cache here would resurrect the
    // observed product.
  }

  // Persisted evidence is monotonic: an empty later relay response cannot
  // revoke a deletion that was already observed and validated.
  return await mergeObservedDeletionTimestampsWithLocal(
    observedDeletionTimestamps,
    authors
  )
}

async function fetchDeletionTimestampsForProductRecords(
  records: readonly CommerceProductRecord[],
  authorPubkeys: readonly string[] = uniqueStrings(
    records.map((record) => record.product.pubkey)
  )
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
    { fallbackWhenEmpty: true }
  )
}

function isDeletedByNip09(
  event: Pick<NDKEvent, "id" | "pubkey" | "created_at">,
  addressId: string | null,
  deletionTimestamps: DeletionTimestamps
): boolean {
  const createdAt = toEventCreatedAtSeconds(event)
  const eventKey = event.id
    ? scopedProductDeletionEventKey(event.pubkey, event.id)
    : null
  const addressKey = addressId ? productDeletionAddressKey(addressId) : null
  const evidence = [
    ...(eventKey && deletionTimestamps.byEventId.get(eventKey)
      ? [deletionTimestamps.byEventId.get(eventKey)!]
      : []),
    ...(addressKey && deletionTimestamps.byAddressId.get(addressKey)
      ? [deletionTimestamps.byAddressId.get(addressKey)!]
      : []),
  ]
  return isProductDeletedByNip09(
    {
      authorPubkey: event.pubkey,
      eventId: event.id,
      addressId,
      createdAt,
    },
    evidence
  )
}

const MAX_PRODUCT_PARSE_CACHE = 5000
const productParseCache = new Map<
  string,
  {
    parsed: ReturnType<typeof parseProductEvent>
    safety: ReturnType<typeof evaluateListingSafety>
  }
>()

// Parsing + listing-safety evaluation is deterministic per event id, but
// dedupeProductEvents re-runs over the full accumulated set on every streaming
// callback. Cache by id so each unique event is parsed/evaluated once instead
// of O(callbacks x events).
function parseAndEvaluateProductEvent(event: NDKEvent) {
  const cached = event.id ? productParseCache.get(event.id) : undefined
  if (cached) return cached
  const parsed = parseProductEvent(event)
  const entry = { parsed, safety: evaluateListingSafety(parsed) }
  if (event.id) {
    if (productParseCache.size >= MAX_PRODUCT_PARSE_CACHE) {
      productParseCache.clear()
    }
    productParseCache.set(event.id, entry)
  }
  return entry
}

function dedupeProductEvents(
  events: NDKEvent[],
  deletionTimestamps?: DeletionTimestamps
): CommerceProductRecord[] {
  const byAddress = new Map<string, CommerceProductRecord>()

  for (const event of events) {
    try {
      const { parsed, safety } = parseAndEvaluateProductEvent(event)

      const dTag = getTagValue(event.tags ?? [], "d")
      const addressId = dTag ? `30402:${event.pubkey}:${dTag}` : parsed.id

      if (
        deletionTimestamps &&
        isDeletedByNip09(event, dTag ? addressId : null, deletionTimestamps)
      ) {
        continue
      }

      const candidate: CommerceProductRecord = {
        product: parsed,
        safety,
        eventId: event.id,
        addressId,
        dTag,
        eventCreatedAt: toEventCreatedAtSeconds(event),
        sourceRelayUrls: getEventSourceRelayUrls(event),
      }

      const existing = byAddress.get(addressId)
      if (!existing) byAddress.set(addressId, candidate)
      else
        byAddress.set(addressId, mergeProductRecordSources(existing, candidate))
    } catch {
      // ignore malformed product events
    }
  }

  return Array.from(byAddress.values())
}

function isRecordDeletedByNip09(
  record: CommerceProductRecord,
  deletionTimestamps: DeletionTimestamps
): boolean {
  return isDeletedByNip09(
    {
      id: record.eventId,
      pubkey: record.product.pubkey,
      created_at: record.eventCreatedAt,
    },
    record.dTag ? record.addressId : null,
    deletionTimestamps
  )
}

function shouldReplaceProductRecord(
  existing: CommerceProductRecord,
  candidate: CommerceProductRecord
): boolean {
  if (candidate.eventCreatedAt !== existing.eventCreatedAt) {
    return candidate.eventCreatedAt > existing.eventCreatedAt
  }
  const existingHasSourceEventId = existing.eventId !== existing.addressId
  const candidateHasSourceEventId = candidate.eventId !== candidate.addressId
  if (candidateHasSourceEventId !== existingHasSourceEventId) {
    return candidateHasSourceEventId
  }
  return candidate.eventId <= existing.eventId
}

function mergeProductRecordSources(
  existing: CommerceProductRecord,
  candidate: CommerceProductRecord
): CommerceProductRecord {
  const winner = shouldReplaceProductRecord(existing, candidate)
    ? candidate
    : existing
  return {
    ...winner,
    sourceRelayUrls: uniqueStrings([
      ...(existing.sourceRelayUrls ?? []),
      ...(candidate.sourceRelayUrls ?? []),
    ]),
  }
}

function mergeCachedAndLiveProductRecords(input: {
  cached: CommerceProductRecord[]
  live: CommerceProductRecord[]
  deletionTimestamps: DeletionTimestamps
}): CommerceProductRecord[] {
  const byAddress = new Map<string, CommerceProductRecord>()

  for (const record of input.cached) {
    if (isRecordDeletedByNip09(record, input.deletionTimestamps)) continue
    byAddress.set(record.addressId, record)
  }

  for (const record of input.live) {
    if (isRecordDeletedByNip09(record, input.deletionTimestamps)) continue
    const existing = byAddress.get(record.addressId)
    if (!existing) byAddress.set(record.addressId, record)
    else
      byAddress.set(
        record.addressId,
        mergeProductRecordSources(existing, record)
      )
  }

  return Array.from(byAddress.values())
}

async function fetchPublicProductRecords(query: {
  authors?: string[]
  ids?: string[]
  dTags?: string[]
  deletionCandidates?: CommerceProductRecord[]
  deletionReadPolicy?: CommerceReadPolicy
  deletionFallbackWhenEmpty?: boolean
  parentAddresses?: string[]
  authenticatedPubkey?: string | null
  limit?: number
  readPolicy?: CommerceReadPolicy
  onTransportStatus?: (degraded: boolean, capped: boolean) => void
}): Promise<CommerceProductRecord[]> {
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.PRODUCT],
  }

  if (query.limit !== undefined) filter.limit = query.limit
  if (query.authors) filter.authors = query.authors
  if (query.ids) filter.ids = query.ids
  if (query.dTags) filter["#d"] = query.dTags
  if (query.parentAddresses) filter["#a"] = query.parentAddresses

  const relayUrls = await planCommerceReadRelays({
    intent:
      query.authors && query.authors.length > 0
        ? "author_products"
        : "commerce_products",
    authors: query.authors,
    authenticatedPubkey: query.authenticatedPubkey,
    maxRelays: query.readPolicy?.maxRelays,
  })

  const result = await runFetchEventsFanoutDetailed(filter, {
    relayUrls,
    connectTimeoutMs: query.readPolicy?.connectTimeoutMs ?? 4_000,
    fetchTimeoutMs: query.readPolicy?.fetchTimeoutMs ?? 8_000,
  })
  query.onTransportStatus?.(result.degraded, result.capped)

  const deletionTimestamps = await fetchProductDeletionTimestamps(
    [
      ...result.events.map(deletionCandidateFromEvent),
      ...(query.deletionCandidates ?? []).map(deletionCandidateFromRecord),
    ],
    {
      readPolicy: query.deletionReadPolicy ?? query.readPolicy,
      fallbackWhenEmpty: query.deletionFallbackWhenEmpty,
      authenticatedPubkey: query.authenticatedPubkey,
    }
  )
  return dedupeProductEvents(result.events, deletionTimestamps)
}

async function fetchPublicProductRecordsProgressive(
  query: {
    authors?: string[]
    ids?: string[]
    dTags?: string[]
    deletionCandidates?: CommerceProductRecord[]
    parentAddresses?: string[]
    authenticatedPubkey?: string | null
    limit?: number
    readPolicy?: CommerceReadPolicy
    onTransportStatus?: (degraded: boolean, capped: boolean) => void
  },
  onRecords: (records: CommerceProductRecord[], relayUrl: string) => void
): Promise<CommerceProductRecord[]> {
  if (testOverrides.fetchEventsFanout) {
    const records = await fetchPublicProductRecords(query)
    onRecords(records, "test")
    return records
  }

  const filter: NDKFilter = {
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
  const relayUrls = await planCommerceReadRelays({
    intent:
      query.authors && query.authors.length > 0
        ? "author_products"
        : "commerce_products",
    authors: query.authors,
    authenticatedPubkey: query.authenticatedPubkey,
    maxRelays: query.readPolicy?.maxRelays,
    relayHintMode: "skip",
  })
  const merged = new Map<string, NDKEvent>()
  const initialDeletionTimestamps = await getLocalProductDeletionTimestamps(
    undefined,
    query.authors
  )
  const shouldExpandRelayHints =
    query.authors && query.authors.length > BROAD_AUTHOR_HINT_LIMIT
  const expandedRelayUrlsPromise = shouldExpandRelayHints
    ? planCommerceReadRelays({
        intent: "author_products",
        authors: query.authors,
        authenticatedPubkey: query.authenticatedPubkey,
        maxRelays: query.readPolicy?.maxRelays,
        relayHintMode: "force",
      })
    : Promise.resolve(relayUrls)

  await streamProductRecordChunks({
    baseFilter: filter,
    authorChunks,
    relayUrls,
    readPolicy: query.readPolicy,
    merged,
    deletionTimestamps: initialDeletionTimestamps,
    onRecords,
    onTransportStatus: query.onTransportStatus,
  })

  const expandedRelayUrls = await expandedRelayUrlsPromise
  const expansionRelayUrls = expandedRelayUrls.filter(
    (relayUrl) => !relayUrls.includes(relayUrl)
  )
  if (expansionRelayUrls.length > 0) {
    await streamProductRecordChunks({
      baseFilter: filter,
      authorChunks,
      relayUrls: expansionRelayUrls,
      readPolicy: query.readPolicy,
      merged,
      deletionTimestamps: initialDeletionTimestamps,
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
      readPolicy: query.readPolicy,
      authenticatedPubkey: query.authenticatedPubkey,
    }
  )
  const resolved = dedupeProductEvents(mergedEvents, deletionTimestamps)
  return resolved
}

function applyProductLimit(
  records: CommerceProductRecord[],
  limit: number | undefined
): CommerceProductRecord[] {
  return limit === undefined ? records : records.slice(0, limit)
}

function getProductRawEventLimit(displayLimit: number | undefined): number {
  if (
    displayLimit === undefined ||
    !Number.isFinite(displayLimit) ||
    displayLimit <= 0
  ) {
    return PRODUCT_RAW_EVENT_LIMIT_DEFAULT
  }

  return Math.min(
    PRODUCT_RAW_EVENT_LIMIT_MAX,
    Math.max(
      PRODUCT_RAW_EVENT_LIMIT_FLOOR,
      Math.ceil(displayLimit) * PRODUCT_RAW_EVENT_OVERFETCH_FACTOR
    )
  )
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
      authenticatedPubkey: query.authenticatedPubkey,
    },
    { now: testOverrides.now }
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

export async function getMarketplaceProducts(
  query: MarketplaceProductsQuery = {}
): Promise<CommerceResult<CommerceProductRecord[]>> {
  if (
    !query.merchantPubkey &&
    query.authorPubkeys &&
    query.authorPubkeys.length === 0
  ) {
    return {
      data: [],
      meta: createMeta("marketplace_products", "public", PRODUCT_CAPABILITIES),
    }
  }

  try {
    const authorPubkeys = query.merchantPubkey
      ? [query.merchantPubkey]
      : query.authorPubkeys
    const cached = await getCachedProductRecords(
      query.merchantPubkey,
      { includeStale: true, includeMarketHidden: true },
      query.authorPubkeys
    )
    const rawEventLimit = getProductRawEventLimit(query.limit)
    let transportDegraded = false
    let readCapped = false
    const fetchedRecords = await fetchPublicProductRecords({
      authors:
        authorPubkeys && authorPubkeys.length > 0
          ? uniqueStrings(authorPubkeys)
          : undefined,
      authenticatedPubkey: query.authenticatedPubkey,
      deletionCandidates: cached,
      limit: rawEventLimit,
      readPolicy: query.readPolicy,
      onTransportStatus: (degraded, capped) => {
        transportDegraded ||= degraded
        readCapped ||= capped
      },
    })
    const deletionTimestamps = await getLocalProductDeletionTimestamps(
      query.merchantPubkey,
      query.authorPubkeys
    )
    const records = mergeCachedAndLiveProductRecords({
      cached,
      live: fetchedRecords,
      deletionTimestamps,
    })
    await cacheProductRecords(records)

    const filtered = applyProductLimit(
      sortProducts(
        filterProductRecordsForRead(records).filter((record) =>
          productMatchesQuery(record, query)
        ),
        query.sort
      ),
      query.limit
    )

    const meta = createMeta(
      "marketplace_products",
      "public",
      PRODUCT_CAPABILITIES,
      {
        capped: readCapped || fetchedRecords.length >= rawEventLimit,
        degraded:
          transportDegraded ||
          readCapped ||
          fetchedRecords.length >= rawEventLimit,
      }
    )
    return { data: withProductFamilyReadEvidence(filtered, meta), meta }
  } catch (error) {
    const cached = applyProductLimit(
      sortProducts(
        filterProductRecordsForRead(
          await getCachedProductRecords(
            query.merchantPubkey,
            { includeStale: true, includeMarketHidden: true },
            query.authorPubkeys
          )
        ).filter((record) => productMatchesQuery(record, query)),
        query.sort
      ),
      query.limit
    )

    if (cached.length > 0) {
      const meta = createMeta(
        "marketplace_products",
        "local_cache",
        PRODUCT_CAPABILITIES,
        { stale: true, degraded: true }
      )
      return { data: withProductFamilyReadEvidence(cached, meta), meta }
    }

    throw error
  }
}

export async function getMarketplaceProductsProgressive(
  query: MarketplaceProductsQuery = {},
  onProgress: (
    result: CommerceResult<CommerceProductRecord[]>,
    relayUrl: string
  ) => void
): Promise<CommerceResult<CommerceProductRecord[]>> {
  if (
    !query.merchantPubkey &&
    query.authorPubkeys &&
    query.authorPubkeys.length === 0
  ) {
    const empty = {
      data: [],
      meta: createMeta("marketplace_products", "public", PRODUCT_CAPABILITIES),
    }
    onProgress(empty, "none")
    return empty
  }

  const authorPubkeys = query.merchantPubkey
    ? [query.merchantPubkey]
    : query.authorPubkeys
  const limit = query.limit
  const cached = await getCachedProductRecords(
    query.merchantPubkey,
    { includeStale: true, includeMarketHidden: true },
    query.authorPubkeys
  )
  const rawEventLimit = getProductRawEventLimit(limit)
  let transportDegraded = false
  let readCapped = false
  const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
    query.merchantPubkey,
    query.authorPubkeys
  )
  const toResult = (
    records: CommerceProductRecord[],
    options: { degraded?: boolean; capped?: boolean } = {}
  ) => {
    const filteredRecords = mergeCachedAndLiveProductRecords({
      cached,
      live: records,
      deletionTimestamps: localDeletionTimestamps,
    })
    const data = applyProductLimit(
      sortProducts(
        filterProductRecordsForRead(filteredRecords).filter((record) =>
          productMatchesQuery(record, query)
        ),
        query.sort
      ),
      limit
    )
    const meta = createMeta(
      "marketplace_products",
      "public",
      PRODUCT_CAPABILITIES,
      {
        capped:
          (options.capped ?? readCapped) || records.length >= rawEventLimit,
        degraded:
          (options.degraded ?? readCapped) || records.length >= rawEventLimit,
      }
    )
    return { data: withProductFamilyReadEvidence(data, meta), meta }
  }

  const fetchedRecords = await fetchPublicProductRecordsProgressive(
    {
      authors:
        authorPubkeys && authorPubkeys.length > 0
          ? uniqueStrings(authorPubkeys)
          : undefined,
      authenticatedPubkey: query.authenticatedPubkey,
      deletionCandidates: cached,
      limit: rawEventLimit,
      readPolicy: query.readPolicy,
      onTransportStatus: (degraded, capped) => {
        transportDegraded ||= degraded
        readCapped ||= capped
      },
    },
    (records, relayUrl) => {
      // Until every planned relay settles, the progressive snapshot is
      // intentionally incomplete even if the first relay succeeded.
      onProgress(
        toResult(records, { degraded: true, capped: readCapped }),
        relayUrl
      )
    }
  )

  const currentDeletionTimestamps = await getLocalProductDeletionTimestamps(
    query.merchantPubkey,
    query.authorPubkeys
  )
  const records = mergeCachedAndLiveProductRecords({
    cached,
    live: fetchedRecords,
    deletionTimestamps: currentDeletionTimestamps,
  })
  const result = toResult(records, {
    degraded:
      transportDegraded || readCapped || fetchedRecords.length >= rawEventLimit,
    capped: readCapped || fetchedRecords.length >= rawEventLimit,
  })
  onProgress(result, "deletion-frontier")
  await cacheProductRecords(records)
  return result
}

export async function getCachedMarketplaceProducts(
  query: MarketplaceProductsQuery = {},
  options: CachedProductReadOptions = { includeStale: true }
): Promise<CommerceResult<CommerceProductRecord[]>> {
  if (
    !query.merchantPubkey &&
    query.authorPubkeys &&
    query.authorPubkeys.length === 0
  ) {
    return {
      data: [],
      meta: createMeta(
        "marketplace_products",
        "local_cache",
        PRODUCT_CAPABILITIES,
        {
          stale: true,
        }
      ),
    }
  }

  const cached = applyProductLimit(
    sortProducts(
      filterProductRecordsForRead(
        await getCachedProductRecords(
          query.merchantPubkey,
          { ...options, includeMarketHidden: true },
          query.authorPubkeys
        )
      ).filter((record) => productMatchesQuery(record, query)),
      query.sort
    ),
    query.limit
  )

  const meta = createMeta(
    "marketplace_products",
    "local_cache",
    PRODUCT_CAPABILITIES,
    {
      stale: true,
      degraded: cached.length > 0,
    }
  )
  return { data: withProductFamilyReadEvidence(cached, meta), meta }
}

export async function getMerchantStorefront(
  query: MerchantStorefrontQuery
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const cached = await getCachedProductRecords(query.merchantPubkey, {
    includeStale: true,
    includeMarketHidden: true,
  })

  try {
    let transportDegraded = false
    let readCapped = false
    const rawEventLimit = getProductRawEventLimit(query.limit)
    const liveRecords = await fetchPublicProductRecords({
      authors: [query.merchantPubkey],
      authenticatedPubkey: query.authenticatedPubkey,
      limit: rawEventLimit,
      readPolicy: query.readPolicy,
      deletionCandidates: cached,
      deletionReadPolicy: query.deletionReadPolicy,
      // Merchant reads preserve the pre-existing broad kind-5 fallback unless
      // a latency-sensitive caller (such as Market storefront hydration)
      // explicitly opts out.
      deletionFallbackWhenEmpty: query.deletionFallbackWhenEmpty !== false,
      onTransportStatus: (degraded, capped) => {
        transportDegraded ||= degraded
        readCapped ||= capped
      },
    })
    const deletionTimestamps = await getLocalProductDeletionTimestamps(
      query.merchantPubkey
    )
    const mergedRecords = mergeCachedAndLiveProductRecords({
      cached,
      live: liveRecords,
      deletionTimestamps,
    })

    const sorted = sortProducts(
      filterProductRecordsForRead(mergedRecords, {
        includeMarketHidden: query.includeMarketHidden,
        groupVariations: query.includeMarketHidden ? false : true,
      }).filter((record) =>
        productMatchesQuery(record, {
          merchantPubkey: query.merchantPubkey,
          textQuery: query.textQuery,
          tags: query.tag ? [query.tag] : undefined,
          sort: query.sort,
          limit: query.limit,
        })
      ),
      query.sort
    )
    const filtered = applyProductLimit(sorted, query.limit)

    await cacheProductRecords(mergedRecords)
    const meta =
      liveRecords.length === 0 && filtered.length > 0
        ? createMeta(
            "merchant_storefront",
            "local_cache",
            PRODUCT_CAPABILITIES,
            { stale: true, degraded: true }
          )
        : createMeta("merchant_storefront", "commerce", PRODUCT_CAPABILITIES, {
            capped: readCapped || liveRecords.length >= rawEventLimit,
            degraded:
              transportDegraded ||
              readCapped ||
              liveRecords.length >= rawEventLimit,
          })
    return {
      data: withProductFamilyReadEvidence(filtered, meta),
      meta,
    }
  } catch (error) {
    const filteredCache = sortProducts(
      filterProductRecordsForRead(cached, {
        includeMarketHidden: query.includeMarketHidden,
        groupVariations: query.includeMarketHidden ? false : true,
      }).filter((record) =>
        productMatchesQuery(record, {
          merchantPubkey: query.merchantPubkey,
          textQuery: query.textQuery,
          tags: query.tag ? [query.tag] : undefined,
        })
      ),
      query.sort
    )

    if (filteredCache.length > 0) {
      const meta = createMeta(
        "merchant_storefront",
        "local_cache",
        PRODUCT_CAPABILITIES,
        { stale: true, degraded: true }
      )
      return {
        data: withProductFamilyReadEvidence(
          applyProductLimit(filteredCache, query.limit),
          meta
        ),
        meta,
      }
    }

    throw error
  }
}

export async function getCachedMerchantStorefront(
  query: MerchantStorefrontQuery,
  options: CachedProductReadOptions = { includeStale: true }
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const readOptions = {
    ...options,
    includeMarketHidden: true,
  }
  const cached = applyProductLimit(
    sortProducts(
      filterProductRecordsForRead(
        await getCachedProductRecords(query.merchantPubkey, readOptions),
        {
          includeMarketHidden: query.includeMarketHidden,
          groupVariations: query.includeMarketHidden ? false : true,
        }
      ).filter((record) =>
        productMatchesQuery(record, {
          merchantPubkey: query.merchantPubkey,
          textQuery: query.textQuery,
          tags: query.tag ? [query.tag] : undefined,
          sort: query.sort,
        })
      ),
      query.sort
    ),
    query.limit
  )

  const meta = createMeta(
    "merchant_storefront",
    "local_cache",
    PRODUCT_CAPABILITIES,
    {
      stale: true,
      degraded: cached.length > 0,
    }
  )
  return { data: withProductFamilyReadEvidence(cached, meta), meta }
}

function parseAddress(
  productId: string
): { kind: number; pubkey: string; d: string } | null {
  const decoded = decodeURIComponent(productId)
  if (/^naddr1/i.test(decoded)) {
    try {
      const result = nip19.decode(decoded)
      if (
        result.type === "naddr" &&
        result.data &&
        typeof result.data === "object" &&
        "kind" in result.data &&
        "pubkey" in result.data &&
        "identifier" in result.data &&
        typeof result.data.kind === "number" &&
        typeof result.data.pubkey === "string" &&
        typeof result.data.identifier === "string"
      ) {
        return {
          kind: result.data.kind,
          pubkey: result.data.pubkey,
          d: result.data.identifier,
        }
      }
    } catch {
      return null
    }
  }
  const [kindStr, pubkey, ...dParts] = decoded.split(":")
  const d = dParts.join(":")
  const kind = Number(kindStr)
  if (!Number.isFinite(kind) || !pubkey || !d) return null
  return { kind, pubkey, d }
}

function getProductLookupIds(productId: string): {
  decodedId: string
  addressId: string | null
  address: { kind: number; pubkey: string; d: string } | null
} {
  const decodedId = decodeURIComponent(productId)
  const address = parseAddress(productId)
  const addressId = address
    ? `${address.kind}:${address.pubkey}:${address.d}`
    : null
  return { decodedId, addressId, address }
}

function findProductDetailRecord(
  records: CommerceProductRecord[],
  lookupIds: string[],
  includeMarketHidden?: boolean
): CommerceProductRecord | null {
  const prepared = filterProductRecordsForRead(records, {
    includeMarketHidden,
    groupVariations: true,
  })
  const target =
    records.find(
      (item) =>
        lookupIds.includes(item.product.id) ||
        lookupIds.includes(item.addressId) ||
        lookupIds.includes(item.eventId)
    ) ?? null

  if (!target) {
    return (
      prepared.find(
        (item) =>
          lookupIds.includes(item.product.id) ||
          lookupIds.includes(item.addressId) ||
          lookupIds.includes(item.eventId) ||
          item.family?.children.some((variation) =>
            lookupIds.includes(variation.product.id)
          )
      ) ?? null
    )
  }

  const displayAddress =
    target.product.type === "variation"
      ? target.product.parentProductId
      : target.addressId
  if (displayAddress) {
    const display = prepared.find((item) => item.addressId === displayAddress)
    const includesTargetVariation =
      target.product.type !== "variation" ||
      display?.family?.children.some(
        (variation) => variation.product.id === target.product.id
      )
    if (display && includesTargetVariation) return display
  }

  return includeMarketHidden ? target : null
}

async function fetchVariationGroupRecords(
  target: CommerceProductRecord
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
  const [parents, variations] = await Promise.all([
    target.product.type === "variation"
      ? fetchPublicProductRecords({
          authors: [parsedParent.pubkey],
          dTags: [parsedParent.d],
          limit: 10,
          onTransportStatus: (degraded, capped) => {
            transportDegraded ||= degraded
            readCapped ||= capped
          },
        })
      : Promise.resolve([]),
    fetchPublicProductRecords({
      authors: [parsedParent.pubkey],
      parentAddresses: [parentAddress],
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

function getVariationParentAddress(
  target: CommerceProductRecord
): string | undefined {
  if (target.product.type === "simple") return undefined
  return target.product.type === "variable"
    ? target.addressId
    : target.product.parentProductId
}

function isProductRecordInFamily(
  record: CommerceProductRecord,
  parentAddress: string
): boolean {
  return (
    record.addressId === parentAddress ||
    record.product.parentProductId === parentAddress
  )
}

function selectLatestProductRecordsByAddress(
  records: readonly CommerceProductRecord[]
): Map<string, CommerceProductRecord> {
  const selected = new Map<string, CommerceProductRecord>()
  for (const record of records) {
    const existing = selected.get(record.addressId)
    selected.set(
      record.addressId,
      existing ? mergeProductRecordSources(existing, record) : record
    )
  }
  return selected
}

function hasCompleteLiveVariationGroupCoverage(input: {
  target: CommerceProductRecord
  groupRead: {
    records: CommerceProductRecord[]
    degraded: boolean
  }
  knownRecords: CommerceProductRecord[]
  directRecords: CommerceProductRecord[]
}): boolean {
  if (input.target.product.type === "simple") return true
  if (input.groupRead.degraded) return false

  const parentAddress = getVariationParentAddress(input.target)
  if (!parentAddress) return false

  const liveByAddress = selectLatestProductRecordsByAddress([
    ...input.directRecords,
    ...input.groupRead.records,
  ])
  const selectedByAddress = selectLatestProductRecordsByAddress([
    ...input.knownRecords,
    ...input.directRecords,
    ...input.groupRead.records,
  ])
  const knownFamilyAddressIds = new Set(
    Array.from(selectedByAddress.values())
      .filter((record) => isProductRecordInFamily(record, parentAddress))
      .map((record) => record.addressId)
  )
  knownFamilyAddressIds.add(input.target.addressId)
  knownFamilyAddressIds.add(parentAddress)

  return Array.from(knownFamilyAddressIds).every((addressId) => {
    const selected = selectedByAddress.get(addressId)
    const live = liveByAddress.get(addressId)
    return !!selected && !!live && selected.eventId === live.eventId
  })
}

export async function getProductDetail(
  query: ProductDetailQuery
): Promise<CommerceResult<CommerceProductRecord | null>> {
  const { decodedId, addressId, address } = getProductLookupIds(query.productId)

  try {
    if (address && addressId && address.kind === EVENT_KINDS.PRODUCT) {
      const cached = await getCachedProductRecords(address.pubkey, {
        includeStale: true,
        includeMarketHidden: true,
      })
      let directReadDegraded = false
      let directReadCapped = false
      const direct = await fetchPublicProductRecords({
        authors: [address.pubkey],
        dTags: [address.d],
        deletionCandidates: cached,
        limit: 10,
        onTransportStatus: (degraded, capped) => {
          directReadDegraded ||= degraded
          directReadCapped ||= capped
        },
      })
      const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
        address.pubkey
      )
      const locallyVisibleDirect = filterDeletedProductRecords(
        direct,
        localDeletionTimestamps
      )
      const locallyMerged = mergeCachedAndLiveProductRecords({
        cached,
        live: locallyVisibleDirect,
        deletionTimestamps: localDeletionTimestamps,
      })
      const targetCandidate =
        locallyMerged.find((item) => item.addressId === addressId) ?? null
      const groupRead = targetCandidate
        ? await fetchVariationGroupRecords(targetCandidate)
        : { records: [], degraded: false, capped: false }
      const relayDeletionTimestamps =
        await fetchDeletionTimestampsForProductRecords(
          [...cached, ...direct, ...groupRead.records],
          [address.pubkey]
        )
      const deletionTimestamps = mergeDeletionTimestamps(
        relayDeletionTimestamps,
        localDeletionTimestamps
      )
      const directVisible = filterDeletedProductRecords(
        direct,
        deletionTimestamps
      )
      const groupVisible = filterDeletedProductRecords(
        groupRead.records,
        deletionTimestamps
      )
      const merged = mergeCachedAndLiveProductRecords({
        cached,
        live: [...directVisible, ...groupVisible],
        deletionTimestamps,
      })
      await cacheProductRecords(merged)
      const record = findProductDetailRecord(
        merged,
        [addressId],
        query.includeMarketHidden
      )
      if (record) {
        const selectedDirectTarget = merged.find(
          (candidate) => candidate.addressId === addressId
        )
        const hasLiveDirectTarget =
          !!selectedDirectTarget &&
          directVisible.some(
            (candidate) =>
              candidate.addressId === addressId &&
              candidate.eventId === selectedDirectTarget.eventId
          )
        const hasCompleteGroupCoverage =
          record.product.type === "simple"
            ? true
            : !!targetCandidate &&
              hasCompleteLiveVariationGroupCoverage({
                target: targetCandidate,
                groupRead: { ...groupRead, records: groupVisible },
                knownRecords: filterDeletedProductRecords(
                  cached,
                  deletionTimestamps
                ),
                directRecords: directVisible,
              })
        const completeLiveRead =
          hasLiveDirectTarget &&
          !directReadDegraded &&
          !directReadCapped &&
          hasCompleteGroupCoverage
        const hasLiveEvidence =
          directVisible.length > 0 || groupVisible.length > 0
        const meta = hasLiveEvidence
          ? createMeta("product_detail", "commerce", PRODUCT_CAPABILITIES, {
              stale: !completeLiveRead,
              degraded: !completeLiveRead,
              capped: groupRead.capped || directReadCapped,
            })
          : createMeta("product_detail", "local_cache", PRODUCT_CAPABILITIES, {
              stale: true,
              degraded: true,
            })
        return {
          data: withProductFamilyRecordReadEvidence(record, meta),
          meta,
        }
      }

      const storefront = await getMerchantStorefront({
        merchantPubkey: address.pubkey,
        includeMarketHidden: query.includeMarketHidden,
      })
      const fallbackRecord =
        storefront.data.find(
          (item) =>
            item.addressId === addressId ||
            item.family?.children.some(
              (variation) => variation.product.id === addressId
            )
        ) ?? null
      const meta = { ...storefront.meta, fetchedAt: now() }
      return {
        data: withProductFamilyRecordReadEvidence(fallbackRecord, meta),
        meta,
      }
    }

    if (/^[0-9a-f]{64}$/i.test(decodedId)) {
      const cached = (
        await getCachedProductRecords(undefined, {
          includeStale: true,
          includeMarketHidden: query.includeMarketHidden,
        })
      ).filter(
        (record) =>
          record.eventId === decodedId || record.product.id === decodedId
      )
      let directReadDegraded = false
      let directReadCapped = false
      const records = await fetchPublicProductRecords({
        ids: [decodedId],
        deletionCandidates: cached,
        onTransportStatus: (degraded, capped) => {
          directReadDegraded ||= degraded
          directReadCapped ||= capped
        },
      })
      const target = records[0] ?? null
      const groupRead = target
        ? await fetchVariationGroupRecords(target)
        : { records: [], degraded: false, capped: false }
      const fetched = [...records, ...groupRead.records]
      const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
        undefined,
        uniqueStrings(fetched.map((record) => record.product.pubkey))
      )
      const relayDeletionTimestamps =
        await fetchDeletionTimestampsForProductRecords(fetched)
      const deletionTimestamps = mergeDeletionTimestamps(
        relayDeletionTimestamps,
        localDeletionTimestamps
      )
      const visibleRecords = filterDeletedProductRecords(
        fetched,
        deletionTimestamps
      )
      await cacheProductRecords(visibleRecords)
      const record = findProductDetailRecord(
        visibleRecords,
        [decodedId],
        query.includeMarketHidden
      )
      const meta = createMeta(
        "product_detail",
        "public",
        PRODUCT_CAPABILITIES,
        {
          stale: directReadDegraded || directReadCapped || groupRead.degraded,
          degraded:
            directReadDegraded || directReadCapped || groupRead.degraded,
          capped: directReadCapped || groupRead.capped,
        }
      )
      return {
        data: withProductFamilyRecordReadEvidence(record, meta),
        meta,
      }
    }
  } catch (error) {
    const cached = await getCachedProductRecords(undefined, {
      includeStale: true,
      includeMarketHidden: true,
    })
    const lookupIds = [decodedId, addressId].filter(
      (lookupId): lookupId is string => !!lookupId
    )
    const record = findProductDetailRecord(
      cached,
      lookupIds,
      query.includeMarketHidden
    )
    if (record) {
      const meta = createMeta(
        "product_detail",
        "local_cache",
        PRODUCT_CAPABILITIES,
        { stale: true, degraded: true }
      )
      return {
        data: withProductFamilyRecordReadEvidence(record, meta),
        meta,
      }
    }
    throw error
  }

  const cached = await getCachedProductRecords(undefined, {
    includeStale: true,
    includeMarketHidden: true,
  })
  const lookupIds = [decodedId, addressId].filter(
    (lookupId): lookupId is string => !!lookupId
  )
  const record = findProductDetailRecord(
    cached,
    lookupIds,
    query.includeMarketHidden
  )
  const meta = createMeta(
    "product_detail",
    record ? "local_cache" : "public",
    PRODUCT_CAPABILITIES,
    { stale: !!record, degraded: !!record }
  )
  return {
    data: withProductFamilyRecordReadEvidence(record, meta),
    meta,
  }
}

/** Typed reason a requested product coordinate is not authoritatively live. */
export type ProductAvailabilityIssue =
  | "invalid_product_reference"
  | "lookup_unavailable"
  | "lookup_partial"
  | "product_missing"
  | "listing_filtered"
  | "cached_only"

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
  result: Awaited<ReturnType<typeof fetchEventsFanoutWithDiagnostics>>,
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
export async function getProductsByIds(
  productIds: string[],
  options: {
    includeMarketHidden?: boolean
    revalidateCanonical?: boolean
  } = {}
): Promise<ProductsByIdsResult> {
  const lookups = productIds.map((productId) => {
    const { address, addressId } = getProductLookupIds(productId)
    const valid = !!address && address.kind === EVENT_KINDS.PRODUCT
    return {
      productId,
      address: valid ? address : null,
      addressId: valid ? addressId : null,
    }
  })
  const addresses = lookups
    .map((lookup) => lookup.address)
    .filter(
      (address): address is { kind: number; pubkey: string; d: string } =>
        address !== null
    )

  if (addresses.length === 0) {
    return {
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
  }

  const authors = uniqueStrings(addresses.map((address) => address.pubkey))
  const wanted = new Set(
    addresses.map((address) => `${address.kind}:${address.pubkey}:${address.d}`)
  )
  const cachedByAuthors = await getCachedProductRecords(
    undefined,
    { includeStale: true, includeMarketHidden: true },
    authors
  )
  const cached = cachedByAuthors.filter((record) =>
    wanted.has(record.addressId)
  )
  // Checkout needs positive live evidence for the selected listing version.
  // Deletion reads preserve monotonic known evidence, but incomplete deletion
  // discovery alone is not a global absence proof and must not veto checkout.
  let listingCoverage: ProductAvailabilityCoverage = "unavailable"
  let deletionCoverage: ProductAvailabilityCoverage = "complete"
  let deletionTimestamps = await getLocalProductDeletionTimestamps(
    undefined,
    authors
  )
  const dTagsByAuthor = new Map<string, string[]>()
  for (const address of addresses) {
    const authorDTags = dTagsByAuthor.get(address.pubkey) ?? []
    authorDTags.push(address.d)
    dTagsByAuthor.set(address.pubkey, authorDTags)
  }
  const directReadEntries = Array.from(dTagsByAuthor.entries())
  const directReads = await Promise.allSettled(
    directReadEntries.map(async ([author, authorDTags]) => {
      const relayPlan = await planCommerceReadRelayPlan({
        intent: "author_products",
        authors: [author],
        strictRelayHints: options.revalidateCanonical,
      })
      const result = await runFetchEventsFanoutWithDiagnostics(
        {
          kinds: [EVENT_KINDS.PRODUCT],
          authors: [author],
          "#d": uniqueStrings(authorDTags),
        },
        {
          relayUrls: relayPlan.relayUrls,
          connectTimeoutMs: 4_000,
          fetchTimeoutMs: 8_000,
          skipHealthFilter: options.revalidateCanonical === true,
        }
      )
      return {
        events: result.events,
        coverage: mergeProductAvailabilityCoverage(
          productAvailabilityCoverageFromFanout(
            result,
            uniqueStrings([
              ...relayPlan.relayUrls,
              ...relayPlan.parkedRelayUrls,
            ])
          ),
          relayPlan.relayHintsComplete ? "complete" : "partial"
        ),
      }
    })
  )
  const fulfilledDirectReads = directReads.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  )
  const productEvents = fulfilledDirectReads.flatMap((result) => result.events)
  const listingCoverageByAuthor = new Map<string, ProductAvailabilityCoverage>(
    directReads.map(
      (result, index) =>
        [
          directReadEntries[index]![0],
          result.status === "fulfilled" ? result.value.coverage : "unavailable",
        ] as const
    )
  )
  const listingCoverageByAddress = new Map<string, ProductAvailabilityCoverage>(
    addresses.map(
      (address) =>
        [
          `${address.kind}:${address.pubkey}:${address.d}`,
          listingCoverageByAuthor.get(address.pubkey) ?? "unavailable",
        ] as const
    )
  )
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
  for (const target of directTargetCandidates) {
    if (target.product.type === "simple") continue
    const parentAddress = getVariationParentAddress(target)
    if (parentAddress) {
      const requestedAddresses =
        groupRequestedAddressesByParent.get(parentAddress) ?? new Set<string>()
      requestedAddresses.add(target.addressId)
      groupRequestedAddressesByParent.set(parentAddress, requestedAddresses)
      if (!groupTargetsByParent.has(parentAddress)) {
        groupTargetsByParent.set(parentAddress, target)
      }
    }
  }
  const groupTargets = Array.from(groupTargetsByParent.values())
  const groupFetches = await Promise.allSettled(
    groupTargets.map(fetchVariationGroupRecords)
  )
  const groupRecords = groupFetches.flatMap((result) =>
    result.status === "fulfilled" ? result.value.records : []
  )

  if (
    productEvents.length > 0 ||
    groupRecords.length > 0 ||
    cachedByAuthors.length > 0
  ) {
    let deletionReadAttempted = false
    let deletionPlanSkippedRelay = false
    let deletionRelayHintsIncomplete = false
    const fetchDeletionEventsWithCoverage: typeof runFetchEventsFanout = async (
      filter,
      fetchOptions
    ) => {
      const result = await runFetchEventsFanoutDetailed(filter, fetchOptions)
      const nextCoverage = mergeProductAvailabilityCoverage(
        productAvailabilityCoverageFromFanout(result, fetchOptions?.relayUrls),
        result.capped ? "partial" : "complete"
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
            fetchEvents: fetchDeletionEventsWithCoverage,
            onSkippedRelayUrls: (relayUrls) => {
              deletionPlanSkippedRelay ||= relayUrls.length > 0
            },
            onIncompleteRelayHints: () => {
              deletionRelayHintsIncomplete = true
            },
            strictRelayHints: options.revalidateCanonical,
          }
        )
      )
      if (!deletionReadAttempted) deletionCoverage = "unavailable"
      else if (deletionPlanSkippedRelay || deletionRelayHintsIncomplete) {
        deletionCoverage = mergeProductAvailabilityCoverage(
          deletionCoverage,
          "partial"
        )
      }
    } catch {
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
  const completeVariationCoverageByGroup = groupFetches.map(
    (result, index) =>
      result.status === "fulfilled" &&
      hasCompleteLiveVariationGroupCoverage({
        target: groupTargets[index]!,
        groupRead: {
          ...result.value,
          records: filterDeletedProductRecords(
            result.value.records,
            deletionTimestamps
          ),
        },
        knownRecords,
        directRecords: liveDirectRecords,
      })
  )
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
  const groupReadCapped = groupFetches.some(
    (result) => result.status === "fulfilled" && result.value.capped
  )
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
  const filtered = filterExactProductRecordsForRead(
    merged,
    wanted,
    options.includeMarketHidden
  )

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
    (!options.revalidateCanonical || deletionCoverage === "complete") &&
    !hasCacheOnlySelection
  const meta = createMeta("product_detail", source, PRODUCT_CAPABILITIES, {
    stale: !completeLiveRead,
    degraded,
    capped: groupReadCapped,
  })

  return {
    data: withProductFamilyReadEvidence(filtered, meta),
    meta,
    diagnostics,
  }
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

/**
 * Resolve one exact atomic kind-30402 listing.
 *
 * Unlike getProductDetail, variation coordinates are not projected to their
 * variable parent. Mutation workflows use this interface so stock and other
 * child-specific fields are always verified and republished on the selected
 * leaf.
 */
export async function getAtomicProductDetail(
  query: ProductDetailQuery
): Promise<CommerceResult<CommerceProductRecord | null>> {
  const { addressId } = getProductLookupIds(query.productId)
  if (!addressId) {
    return {
      data: null,
      meta: createMeta("product_detail", "public", PRODUCT_CAPABILITIES),
    }
  }

  const result = await getProductsByIds([addressId], {
    includeMarketHidden: query.includeMarketHidden,
    revalidateCanonical: query.revalidateCanonical,
  })
  return {
    data: result.data.find((record) => record.addressId === addressId) ?? null,
    meta: result.meta,
  }
}

export async function getCachedProductDetail(
  query: ProductDetailQuery,
  options: CachedProductReadOptions = { includeStale: true }
): Promise<CommerceResult<CommerceProductRecord | null>> {
  const { decodedId, addressId } = getProductLookupIds(query.productId)
  const cached = await getCachedProductRecords(undefined, {
    ...options,
    includeMarketHidden: true,
  })
  const lookupIds = [decodedId, addressId].filter(
    (lookupId): lookupId is string => !!lookupId
  )
  const record = findProductDetailRecord(
    cached,
    lookupIds,
    query.includeMarketHidden
  )

  const meta = createMeta(
    "product_detail",
    record ? "local_cache" : "public",
    PRODUCT_CAPABILITIES,
    { stale: !!record, degraded: !!record }
  )
  return {
    data: withProductFamilyRecordReadEvidence(record, meta),
    meta,
  }
}

export async function getProfiles(
  query: ProfileBatchQuery
): Promise<CommerceResult<Record<string, Profile>>> {
  const pubkeys = Array.from(
    new Set(query.pubkeys.map((pubkey) => pubkey.trim()).filter(Boolean))
  )
  const result: Record<string, Profile> = {}
  const missing: string[] = []

  if (pubkeys.length === 0) {
    return {
      data: result,
      meta: createMeta("profile_batch", "public", PROFILE_CAPABILITIES),
    }
  }

  // A forced refresh must bypass cached display data without forgetting the
  // durable replaceable-event frontier. Otherwise a narrower relay view can
  // regress raw kind-0 publish context and silently delete unchanged fields.
  let retainedCachedRows: Array<CachedProfile | undefined>
  try {
    retainedCachedRows = await loadCachedProfiles(pubkeys)
  } catch {
    // Profile cache persistence is best-effort. A storage failure must not
    // prevent a forced network refresh or turn a public profile read fatal.
    retainedCachedRows = pubkeys.map(() => undefined)
  }
  const cachedRows = query.skipCache ? [] : retainedCachedRows
  const cachedRowsByPubkey = new Map(
    retainedCachedRows.flatMap((row) =>
      row ? ([[row.pubkey, row]] as const) : []
    )
  )
  pubkeys.forEach((pubkey, index) => {
    const cached = cachedRows[index]
    const isAuthenticatedOwner =
      !!query.authenticatedPubkey &&
      pubkey.toLowerCase() === query.authenticatedPubkey.trim().toLowerCase()
    if (
      cached &&
      hasProfileContent(cached) &&
      !isAuthenticatedOwner &&
      now() - cached.cachedAt < PROFILE_CACHE_TTL_MS
    ) {
      result[pubkey] = projectCachedProfile(cached)
    } else {
      if (cached && hasProfileContent(cached)) {
        result[pubkey] = projectCachedProfile(cached)
      }
      missing.push(pubkey)
    }
  })

  if (missing.length === 0) {
    return {
      data: result,
      meta: createMeta("profile_batch", "local_cache", PROFILE_CAPABILITIES, {
        stale: false,
      }),
    }
  }

  if (
    query.onProgress &&
    Object.values(result).some((profile) => hasProfileContent(profile))
  ) {
    query.onProgress({
      data: { ...result },
      meta: createMeta("profile_batch", "local_cache", PROFILE_CAPABILITIES, {
        stale: true,
      }),
    })
  }

  try {
    const visible = query.priority !== "background"
    const sourceRelayHints = mergeContextualRelayHints(
      getProfileQueryRelayHints({ ...query, pubkeys: missing }),
      await loadProductSourceRelayHints(missing, query.authenticatedPubkey)
    )
    const relayUrls = await planCommerceReadRelays({
      intent: "profiles",
      authors: missing,
      authenticatedPubkey: query.authenticatedPubkey,
      maxRelays: query.readPolicy?.maxRelays ?? (visible ? 8 : 4),
      extraRelayUrls: sourceRelayHints.publicRelayUrls,
      authenticatedAuthorRelayUrls:
        sourceRelayHints.authenticatedAuthorRelayUrls,
    })
    const profileFilter: NDKFilter = {
      kinds: [EVENT_KINDS.PROFILE],
      authors: missing,
      limit: Math.max(10, missing.length * 3),
    }
    const fanoutOptions = {
      relayUrls,
      connectTimeoutMs:
        query.readPolicy?.connectTimeoutMs ?? (visible ? 1_500 : 3_000),
      fetchTimeoutMs:
        query.readPolicy?.fetchTimeoutMs ?? (visible ? 3_000 : 6_000),
    }
    const emitProgress = (events: readonly NDKEvent[]) => {
      if (!query.onProgress) return

      const progress = mergeProfileEvents(
        missing,
        result,
        events,
        cachedRowsByPubkey
      )
      if (!progress.hasResolvedProfile) return

      query.onProgress({
        data: progress.profiles,
        meta: createMeta("profile_batch", "public", PROFILE_CAPABILITIES),
      })
    }
    const events =
      query.onProgress && !testOverrides.fetchEventsFanout
        ? await fetchEventsFanoutProgressive(
            profileFilter,
            fanoutOptions,
            ({ mergedEvents }) => emitProgress(mergedEvents)
          )
        : await runFetchEventsFanout(profileFilter, fanoutOptions)

    if (query.onProgress && testOverrides.fetchEventsFanout) {
      emitProgress(events)
    }

    const { profiles, rowsToCache } = mergeProfileEvents(
      missing,
      result,
      events,
      cachedRowsByPubkey
    )
    const liveRowsByPubkey = new Map(
      mergeProfileEvents(missing, {}, events).rowsToCache.map((row) => [
        row.pubkey,
        row,
      ])
    )
    let cacheRetention: CachedProfileRetentionResult | undefined

    if (rowsToCache.length > 0) {
      cacheRetention = await storeCachedProfiles(rowsToCache)
      for (const row of cacheRetention.rows) {
        profiles[row.pubkey] = projectCachedProfile(row)
      }
    }
    Object.assign(result, profiles)

    const displaced = (cacheRetention?.displacedPubkeys.size ?? 0) > 0
    const missingPubkeys = new Set(missing)
    const usesFreshCachedResult = pubkeys.some(
      (pubkey) =>
        !missingPubkeys.has(pubkey) && hasProfileContent(result[pubkey])
    )
    const usesUnconfirmedCachedResult =
      cacheRetention?.rows.some((row) => {
        if (!hasProfileContent(row)) return false
        const liveRow = liveRowsByPubkey.get(row.pubkey)
        return (
          !liveRow ||
          row.eventId !== liveRow.eventId ||
          row.eventCreatedAt !== liveRow.eventCreatedAt ||
          !areProfileProjectionsEqual(
            projectCachedProfile(row),
            projectCachedProfile(liveRow)
          )
        )
      }) ?? false
    const dependsOnCache = usesFreshCachedResult || usesUnconfirmedCachedResult
    const stale = displaced || usesUnconfirmedCachedResult

    return {
      data: result,
      meta: createMeta(
        "profile_batch",
        dependsOnCache ? "local_cache" : "public",
        PROFILE_CAPABILITIES,
        {
          stale,
          degraded: stale,
        }
      ),
    }
  } catch (error) {
    const hasAnyCached = Object.keys(result).length > 0
    if (hasAnyCached) {
      for (const pubkey of missing) {
        result[pubkey] = result[pubkey] ?? { pubkey }
      }
      return {
        data: result,
        meta: createMeta("profile_batch", "local_cache", PROFILE_CAPABILITIES, {
          stale: true,
        }),
      }
    }
    throw error
  }
}

function getConversationPreview(message: ParsedOrderMessage): string {
  switch (message.type) {
    case "order":
      return `Order for ${message.payload.subtotal} ${message.payload.currency}`
    case "payment_request":
      return message.payload.note ?? "Invoice sent"
    case "status_update":
      return (
        message.payload.note ?? `Status updated to ${message.payload.status}`
      )
    case "shipping_update":
      return message.payload.note ?? "Shipping updated"
    case "receipt":
      return message.payload.note ?? "Payment received"
    case "message":
      return message.payload.note
    case "payment_proof":
      return "Payment proof shared"
    default:
      return "Order update"
  }
}

/** Route the commerce test giftUnwrap override into the shared boundary. */
function unwrapOptions(): UnwrapGiftWrapOptions {
  return testOverrides.giftUnwrap
    ? { giftUnwrap: testOverrides.giftUnwrap }
    : {}
}

async function fetchParsedOrderMessages(
  principalPubkey: string
): Promise<RawMessageFetchResult> {
  const authorization = resolveInboxSyncAuthorization(principalPubkey)
  assertInboxSyncAuthority(authorization)
  const cached = await loadCachedOrderMessages(principalPubkey)
  assertInboxSyncAuthority(authorization)

  const cachedById = new Map<string, ParsedOrderMessage>()
  for (const row of cached) {
    try {
      cachedById.set(row.id, JSON.parse(row.rawContent) as ParsedOrderMessage)
    } catch {
      // skip corrupt cache rows
    }
  }

  try {
    const signer = await resolveEnvelopeSigner()
    if (!signer) {
      if (cachedById.size > 0) {
        const messages = Array.from(cachedById.values()).sort(
          (a, b) => a.createdAt - b.createdAt
        )
        assertInboxSyncAuthority(authorization)
        return {
          messages,
          source: "local_cache",
          stale: true,
          decryptFailures: [],
          inbox: unavailableInboxStatus(),
        }
      }
      throw new Error("Connect your Nostr signer to view order conversations.")
    }

    const sync = await syncPrivateMessageInbox(
      principalPubkey,
      signer,
      authorization
    )
    for (const parsed of sync.orderMessages) cachedById.set(parsed.id, parsed)

    const messages = Array.from(cachedById.values()).sort(
      (a, b) => a.createdAt - b.createdAt
    )
    assertInboxSyncAuthority(authorization)
    return {
      messages,
      source:
        sync.inbox.coverage === "unavailable" ? "local_cache" : "commerce",
      stale: sync.inbox.coverage === "unavailable",
      decryptFailures: sync.decryptFailures,
      inbox: sync.inbox,
    }
  } catch (error) {
    if (error instanceof ProtectedInboxAuthorityChangedError) throw error
    if (cachedById.size > 0) {
      const messages = Array.from(cachedById.values()).sort(
        (a, b) => a.createdAt - b.createdAt
      )
      assertInboxSyncAuthority(authorization)
      return {
        messages,
        source: "local_cache",
        stale: true,
        decryptFailures: [],
        inbox: unavailableInboxStatus(),
      }
    }
    throw error
  }
}

/**
 * Resolve the principal's kind-10050 declaration with typed outcomes.
 * A missing declaration never blocks reading the principal's own gift wraps;
 * it only changes the read plan and the surfaced readiness state.
 */
async function resolvePrincipalInboxDeclaration(
  principalPubkey: string
): Promise<InboxDeclarationResolution> {
  if (testOverrides.resolveInboxRelayUrls) {
    try {
      const relays = await testOverrides.resolveInboxRelayUrls(principalPubkey)
      const secure = relays.filter((url) => !isInsecureRelayUrl(url))
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
  })
}

type InboxWrapFetchResult = {
  wraps: NDKEvent[]
  inbox: PrivateInboxReadStatus
}

/**
 * Permissive inbox read (CND-208): union of declared inbox relays, locally
 * enabled secure IN relays, and the bounded compatibility read set. All-failed
 * reads surface as coverage "unavailable" instead of a healthy empty inbox.
 */
async function fetchNewInboxWraps(
  principalPubkey: string,
  limit: number,
  authorization: ProtectedReadAuthorization | null
): Promise<InboxWrapFetchResult> {
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.GIFT_WRAP],
    "#p": [principalPubkey],
    limit,
  }

  const declaration = await resolvePrincipalInboxDeclaration(principalPubkey)
  const readPlan = planInboxReadRelays({
    declaration,
    authenticatedPubkey: principalPubkey,
    maxRelays: DM_INBOX_READ_FANOUT,
  })

  if (
    testOverrides.fetchEventsFanoutWithDiagnostics ||
    testOverrides.fetchEventsFanout
  ) {
    const result = await runFetchEventsFanoutWithDiagnostics(filter, {
      relayUrls: readPlan.relayUrls,
      connectTimeoutMs: 4_000,
      fetchTimeoutMs: 12_000,
    })
    const capped = isBoundedFanoutSaturated(filter, result.events)
    const successful = successfulWrapIdsByPrincipal.get(principalPubkey)
    return {
      wraps: result.events.filter((event) => !successful?.has(event.id)),
      inbox: {
        declarationState: declaration.state,
        coverage: capped ? "partial" : deriveInboxReadCoverage(result),
        capped,
        readSource: readPlan.source,
        authentication: {
          state: "not_challenged",
          challengedCount: 0,
          succeededCount: 0,
          failedCount: 0,
        },
      },
    }
  }

  const protectedResult = await (
    testOverrides.readProtectedInbox ?? readProtectedInbox
  )({
    principalPubkey,
    relayUrls: readPlan.relayUrls,
    limit,
    authorization,
    connectTimeoutMs: 4_000,
    queryTimeoutMs: 12_000,
  })

  const successful = successfulWrapIdsByPrincipal.get(principalPubkey)
  return {
    wraps: protectedResult.events
      .filter((event) => !successful?.has(event.id))
      .map((event) => new NDKEvent(undefined, event)),
    inbox: {
      declarationState: declaration.state,
      coverage: protectedResult.coverage,
      capped: protectedResult.capped,
      readSource: readPlan.source,
      authentication: protectedResult.auth,
    },
  }
}

async function loadCachedDirectMessages(
  principalPubkey: string
): Promise<StoredMessage[]> {
  if (testOverrides.getCachedDirectMessages) {
    return await testOverrides.getCachedDirectMessages(principalPubkey)
  }

  return await db.messages
    .where("recipientPubkey")
    .equals(principalPubkey)
    .or("senderPubkey")
    .equals(principalPubkey)
    .filter(
      (row) =>
        row.kind === EVENT_KINDS.DIRECT_MESSAGE ||
        row.kind === EVENT_KINDS.DM_LEGACY
    )
    .toArray()
}

async function storeCachedDirectMessages(rows: StoredMessage[]): Promise<void> {
  if (rows.length === 0) return
  if (testOverrides.putCachedDirectMessages) {
    await testOverrides.putCachedDirectMessages(rows)
    return
  }
  await db.messages.bulkPut(rows)
}

async function persistLegacyDirectMessages(
  rows: StoredMessage[],
  authorization: ProtectedReadAuthorization | null
): Promise<void> {
  const assertAuthority = () => assertInboxSyncAuthority(authorization)
  assertAuthority()
  if (rows.length === 0) return

  if (testOverrides.persistLegacyDirectMessages) {
    await testOverrides.persistLegacyDirectMessages(rows, assertAuthority)
    assertAuthority()
    return
  }
  if (testOverrides.putCachedDirectMessages) {
    await storeCachedDirectMessages(rows)
    assertAuthority()
    return
  }

  await db.transaction("rw", db.messages, async () => {
    assertAuthority()
    await db.messages.bulkPut(rows)
    assertAuthority()
  })
  assertAuthority()
}

function cachedDirectMessageRow(message: ParsedDirectMessage): StoredMessage {
  return {
    id: message.id,
    senderPubkey: message.senderPubkey,
    recipientPubkey: message.recipientPubkey,
    content: message.content,
    kind:
      message.transport === "nip04"
        ? EVENT_KINDS.DM_LEGACY
        : EVENT_KINDS.DIRECT_MESSAGE,
    createdAt: message.createdAt,
    read: 0,
  }
}

async function persistProtectedInboxMessages(
  orderRows: CachedOrderMessage[],
  directRows: StoredMessage[],
  authorization: ProtectedReadAuthorization | null
): Promise<void> {
  const assertAuthority = () => assertInboxSyncAuthority(authorization)
  assertAuthority()

  if (testOverrides.persistProtectedInboxMessages) {
    await testOverrides.persistProtectedInboxMessages(
      orderRows,
      directRows,
      assertAuthority
    )
    assertAuthority()
    return
  }

  if (
    testOverrides.putCachedOrderMessages ||
    testOverrides.putCachedDirectMessages
  ) {
    await storeCachedOrderMessages(orderRows)
    assertAuthority()
    await storeCachedDirectMessages(directRows)
    assertAuthority()
    return
  }

  await db.transaction("rw", db.orderMessages, db.messages, async () => {
    assertAuthority()
    if (orderRows.length > 0) await db.orderMessages.bulkPut(orderRows)
    if (directRows.length > 0) await db.messages.bulkPut(directRows)
    // Throwing here aborts the Dexie transaction, including completed bulkPut
    // requests, if another tab changed signer authority during persistence.
    assertAuthority()
  })
  assertAuthority()
}

function parseCachedDirectMessage(row: StoredMessage): ParsedDirectMessage {
  return {
    id: row.id,
    senderPubkey: row.senderPubkey,
    recipientPubkey: row.recipientPubkey,
    content: row.decrypted ?? row.content,
    createdAt: row.createdAt,
    transport: row.kind === EVENT_KINDS.DM_LEGACY ? "nip04" : "nip17",
  }
}

function successfulLegacyDmIds(sessionPrincipalKey: string): Set<string> {
  let ids = successfulLegacyDmIdsByPrincipal.get(sessionPrincipalKey)
  if (!ids) {
    ids = new Set<string>()
    successfulLegacyDmIdsByPrincipal.set(sessionPrincipalKey, ids)
  }
  return ids
}

function retryLegacyDms(
  sessionPrincipalKey: string
): Map<
  string,
  { event: NDKEvent; attempts: number; failure?: LegacyDmDecryptFailure }
> {
  let events = retryLegacyDmsByPrincipal.get(sessionPrincipalKey)
  if (!events) {
    events = new Map()
    retryLegacyDmsByPrincipal.set(sessionPrincipalKey, events)
  }
  return events
}

async function runLegacyDmSync(
  principalPubkey: string,
  signer: NDKSigner,
  authorization: ProtectedReadAuthorization | null,
  sessionPrincipalKey: string
): Promise<LegacyDmSyncResult> {
  const relayUrls = await planCommerceReadRelays({
    intent: "legacy_dm",
    authors: [principalPubkey],
    recipients: [principalPubkey],
    authenticatedPubkey: principalPubkey,
    maxRelays: DM_INBOX_READ_FANOUT,
  })
  const [incoming, outgoing, cached] = await Promise.all([
    runFetchEventsFanout(
      {
        kinds: [EVENT_KINDS.DM_LEGACY],
        "#p": [principalPubkey],
        limit: 400,
      },
      { relayUrls, connectTimeoutMs: 4_000, fetchTimeoutMs: 12_000 }
    ),
    runFetchEventsFanout(
      {
        kinds: [EVENT_KINDS.DM_LEGACY],
        authors: [principalPubkey],
        limit: 400,
      },
      { relayUrls, connectTimeoutMs: 4_000, fetchTimeoutMs: 12_000 }
    ),
    loadCachedDirectMessages(principalPubkey),
  ])
  assertInboxSyncAuthority(authorization)
  const cachedIds = new Set(cached.map((row) => row.id))
  const successful = successfulLegacyDmIds(sessionPrincipalKey)
  const retry = retryLegacyDms(sessionPrincipalKey)
  const candidates = new Map<string, NDKEvent>()
  for (const { event, attempts } of retry.values()) {
    if (attempts < MAX_LEGACY_DM_DECRYPT_ATTEMPTS) {
      candidates.set(event.id, event)
    }
  }
  for (const event of [...incoming, ...outgoing]) {
    const pending = retry.get(event.id)
    if (
      !successful.has(event.id) &&
      !cachedIds.has(event.id) &&
      (!pending || pending.attempts < MAX_LEGACY_DM_DECRYPT_ATTEMPTS)
    ) {
      candidates.set(event.id, event)
    }
  }
  for (const event of candidates.values()) {
    const pending = retry.get(event.id)
    retry.set(event.id, {
      event,
      attempts: pending?.attempts ?? 0,
      failure: pending?.failure,
    })
  }

  const decrypt = createNdkLegacyDmDecrypt(signer)
  const messages: ParsedDirectMessage[] = []
  for (let index = 0; index < candidates.size; index += 5) {
    const batch = Array.from(candidates.values()).slice(index, index + 5)
    const outcomes = await Promise.all(
      batch.map((event) =>
        decryptLegacyDirectMessage(event, principalPubkey, decrypt)
      )
    )
    assertInboxSyncAuthority(authorization)
    for (const outcome of outcomes) {
      if (outcome.status === "ignored") {
        successful.add(outcome.eventId)
        retry.delete(outcome.eventId)
      } else if (outcome.status === "decrypt_failed") {
        const pending = retry.get(outcome.failure.eventId)
        if (pending) {
          const attempts = pending.attempts + 1
          retry.set(outcome.failure.eventId, {
            ...pending,
            attempts,
            failure: {
              ...outcome.failure,
              retryable: attempts < MAX_LEGACY_DM_DECRYPT_ATTEMPTS,
            },
          })
        }
      } else {
        messages.push(outcome.message)
      }
    }
  }

  try {
    await persistLegacyDirectMessages(
      messages.map(cachedDirectMessageRow),
      authorization
    )
    for (const message of messages) {
      successful.add(message.id)
      retry.delete(message.id)
    }
  } catch (error) {
    if (error instanceof ProtectedInboxAuthorityChangedError) throw error
    assertInboxSyncAuthority(authorization)
    // Keep encrypted events in memory for retry; plaintext remains transient.
  }

  assertInboxSyncAuthority(authorization)
  return {
    directMessages: messages,
    decryptFailures: Array.from(retry.values()).flatMap(({ failure }) =>
      failure ? [failure] : []
    ),
  }
}

async function syncLegacyDms(
  principalPubkey: string,
  signer: NDKSigner,
  authorization: ProtectedReadAuthorization | null
): Promise<LegacyDmSyncResult> {
  const syncKey = `${authorization?.sessionScope ?? "legacy-test"}:${principalPubkey}`
  const existing = legacyDmSyncPromises.get(syncKey)
  if (existing) return await existing
  const pending = runLegacyDmSync(
    principalPubkey,
    signer,
    authorization,
    syncKey
  )
  legacyDmSyncPromises.set(syncKey, pending)
  try {
    return await pending
  } catch (error) {
    if (error instanceof ProtectedInboxAuthorityChangedError) {
      successfulLegacyDmIdsByPrincipal.delete(syncKey)
      retryLegacyDmsByPrincipal.delete(syncKey)
    }
    throw error
  } finally {
    if (legacyDmSyncPromises.get(syncKey) === pending) {
      legacyDmSyncPromises.delete(syncKey)
    }
  }
}

function successfulWrapIds(principalPubkey: string): Set<string> {
  let ids = successfulWrapIdsByPrincipal.get(principalPubkey)
  if (!ids) {
    ids = new Set<string>()
    successfulWrapIdsByPrincipal.set(principalPubkey, ids)
  }
  return ids
}

function retryWraps(
  principalPubkey: string
): Map<string, { event: NDKEvent; failure?: DecryptFailure }> {
  let wraps = retryWrapsByPrincipal.get(principalPubkey)
  if (!wraps) {
    wraps = new Map()
    retryWrapsByPrincipal.set(principalPubkey, wraps)
  }
  return wraps
}

async function runPrivateMessageInboxSync(
  principalPubkey: string,
  signer: NDKSigner,
  authorization: ProtectedReadAuthorization | null
): Promise<PrivateInboxSyncResult> {
  const [cachedOrders, cachedDirect, fetched] = await Promise.all([
    loadCachedOrderMessages(principalPubkey),
    loadCachedDirectMessages(principalPubkey),
    fetchNewInboxWraps(principalPubkey, 400, authorization),
  ])
  assertInboxSyncAuthority(authorization)
  const cachedOrderIds = new Set(cachedOrders.map((row) => row.id))
  const cachedDirectIds = new Set(cachedDirect.map((row) => row.id))
  const successful = successfulWrapIds(principalPubkey)
  const retry = retryWraps(principalPubkey)
  const candidates = new Map<string, NDKEvent>()

  for (const { event } of retry.values()) candidates.set(event.id, event)
  for (const event of fetched.wraps) candidates.set(event.id, event)
  for (const event of candidates.values()) {
    retry.set(event.id, { event, failure: retry.get(event.id)?.failure })
  }

  const outcomes = await unwrapGiftWraps(
    Array.from(candidates.values()),
    signer,
    unwrapOptions()
  )
  // Decrypted rumors must not escape after a cross-tab revision/account change,
  // even before the browser delivers its asynchronous storage event.
  assertInboxSyncAuthority(authorization)
  const orderEntries: Array<{
    wrapId: string
    message: ParsedOrderMessage
    isCached: boolean
  }> = []
  const directEntries: Array<{
    wrapId: string
    message: ParsedDirectMessage
    isCached: boolean
  }> = []

  for (const outcome of outcomes) {
    const pending = retry.get(outcome.wrapId)
    if (!pending) continue
    if (outcome.status === "decrypt_failed") {
      retry.set(outcome.wrapId, {
        event: pending.event,
        failure: { wrapId: outcome.wrapId, reason: outcome.reason },
      })
      continue
    }
    if (outcome.status === "ignored") {
      successful.add(outcome.wrapId)
      retry.delete(outcome.wrapId)
      continue
    }

    try {
      if (outcome.category === "order") {
        const message = parseOrderMessageRumorEvent(outcome.rumor)
        orderEntries.push({
          wrapId: outcome.wrapId,
          message,
          isCached: cachedOrderIds.has(message.id),
        })
      } else {
        const message = parseDirectMessageRumor(outcome.rumor)
        if (!message.id) throw new Error("Missing direct-message id")
        directEntries.push({
          wrapId: outcome.wrapId,
          message,
          isCached: cachedDirectIds.has(message.id),
        })
      }
    } catch {
      retry.set(outcome.wrapId, {
        event: pending.event,
        failure: { wrapId: outcome.wrapId, reason: "malformed" },
      })
    }
  }

  const persisted = (wrapId: string) => {
    successful.add(wrapId)
    retry.delete(wrapId)
  }
  const cachedOrderEntries = orderEntries.filter((entry) => entry.isCached)
  const newOrderEntries = orderEntries.filter((entry) => !entry.isCached)
  for (const entry of cachedOrderEntries) persisted(entry.wrapId)
  const cachedDirectEntries = directEntries.filter((entry) => entry.isCached)
  const newDirectEntries = directEntries.filter((entry) => !entry.isCached)
  for (const entry of cachedDirectEntries) persisted(entry.wrapId)

  try {
    await persistProtectedInboxMessages(
      newOrderEntries.map((entry) => cachedOrderMessageRow(entry.message)),
      newDirectEntries.map((entry) => cachedDirectMessageRow(entry.message)),
      authorization
    )
    for (const entry of newOrderEntries) persisted(entry.wrapId)
    for (const entry of newDirectEntries) persisted(entry.wrapId)
  } catch (error) {
    if (error instanceof ProtectedInboxAuthorityChangedError) throw error
    assertInboxSyncAuthority(authorization)
    // Keep wrappers pending for a later cache retry; parsed messages remain usable.
  }

  assertInboxSyncAuthority(authorization)

  return {
    orderMessages: orderEntries.map((entry) => entry.message),
    directMessages: directEntries.map((entry) => entry.message),
    decryptFailures: Array.from(retry.values()).flatMap(({ failure }) =>
      failure ? [failure] : []
    ),
    inbox: fetched.inbox,
  }
}

async function syncPrivateMessageInbox(
  principalPubkey: string,
  signer: NDKSigner,
  authorization: ProtectedReadAuthorization | null
): Promise<PrivateInboxSyncResult> {
  const syncKey = `${authorization?.sessionScope ?? "legacy-test"}:${principalPubkey}`
  const existing = inboxSyncPromises.get(syncKey)
  if (existing) return await existing

  const pending = runPrivateMessageInboxSync(
    principalPubkey,
    signer,
    authorization
  )
  inboxSyncPromises.set(syncKey, pending)
  try {
    return await pending
  } finally {
    if (inboxSyncPromises.get(syncKey) === pending) {
      inboxSyncPromises.delete(syncKey)
    }
  }
}

async function fetchParsedDirectMessages(
  principalPubkey: string
): Promise<RawDirectMessageFetchResult> {
  const authorization = resolveInboxSyncAuthorization(principalPubkey)
  assertInboxSyncAuthority(authorization)
  const cached = await loadCachedDirectMessages(principalPubkey)
  assertInboxSyncAuthority(authorization)
  const cachedById = new Map<string, ParsedDirectMessage>()
  const unreadMessageIds = new Set<string>()
  for (const row of cached) {
    cachedById.set(row.id, parseCachedDirectMessage(row))
    if (row.read === 0) unreadMessageIds.add(row.id)
  }

  try {
    const signer = await resolveEnvelopeSigner()
    if (!signer) {
      if (cachedById.size > 0) {
        const messages = Array.from(cachedById.values()).sort(
          (a, b) => a.createdAt - b.createdAt
        )
        assertInboxSyncAuthority(authorization)
        return {
          messages,
          unreadMessageIds,
          source: "local_cache",
          stale: true,
          decryptFailures: [],
          legacyDecryptFailures: [],
          inbox: unavailableInboxStatus(),
        }
      }
      throw new Error("Connect your Nostr signer to view messages.")
    }

    const [currentResult, legacyResult] = await Promise.allSettled([
      syncPrivateMessageInbox(principalPubkey, signer, authorization),
      syncLegacyDms(principalPubkey, signer, authorization),
    ])
    assertInboxSyncAuthority(authorization)
    if (
      currentResult.status === "rejected" &&
      currentResult.reason instanceof ProtectedInboxAuthorityChangedError
    ) {
      throw currentResult.reason
    }
    if (
      currentResult.status === "rejected" &&
      legacyResult.status === "rejected" &&
      cachedById.size === 0
    ) {
      throw currentResult.reason
    }
    const current =
      currentResult.status === "fulfilled"
        ? currentResult.value
        : { directMessages: [], decryptFailures: [], inbox: undefined }
    const legacy =
      legacyResult.status === "fulfilled"
        ? legacyResult.value
        : { directMessages: [], decryptFailures: [] }
    for (const parsed of [
      ...current.directMessages,
      ...legacy.directMessages,
    ]) {
      const isNew = !cachedById.has(parsed.id)
      cachedById.set(parsed.id, parsed)
      if (isNew && parsed.senderPubkey !== principalPubkey) {
        unreadMessageIds.add(parsed.id)
      }
    }

    const messages = Array.from(cachedById.values()).sort(
      (a, b) => a.createdAt - b.createdAt
    )
    assertInboxSyncAuthority(authorization)
    return {
      messages,
      unreadMessageIds,
      source: "commerce",
      stale:
        currentResult.status === "rejected" ||
        legacyResult.status === "rejected" ||
        current.inbox?.coverage === "unavailable",
      decryptFailures: current.decryptFailures,
      legacyDecryptFailures: legacy.decryptFailures,
      inbox: current.inbox,
    }
  } catch (error) {
    if (error instanceof ProtectedInboxAuthorityChangedError) throw error
    if (cachedById.size > 0) {
      const messages = Array.from(cachedById.values()).sort(
        (a, b) => a.createdAt - b.createdAt
      )
      assertInboxSyncAuthority(authorization)
      return {
        messages,
        unreadMessageIds,
        source: "local_cache",
        stale: true,
        decryptFailures: [],
        legacyDecryptFailures: [],
        inbox: unavailableInboxStatus(),
      }
    }
    throw error
  }
}

const BUYER_AUTHORED_TYPES = new Set(["order", "payment_proof"])
const MERCHANT_AUTHORED_TYPES = new Set([
  "payment_request",
  "status_update",
  "shipping_update",
  "receipt",
])

interface PrincipalResolution {
  role: "buyer" | "merchant"
  counterpartyPubkey: string
}

function resolvePrincipal(
  bucket: ParsedOrderMessage[],
  principalPubkey: string
): PrincipalResolution | null {
  const order = bucket.find((message) => message.type === "order")
  if (order) {
    if (order.senderPubkey === principalPubkey) {
      return { role: "buyer", counterpartyPubkey: order.recipientPubkey }
    }
    if (order.recipientPubkey === principalPubkey) {
      return { role: "merchant", counterpartyPubkey: order.senderPubkey }
    }
    return null
  }

  const roles = new Set<"buyer" | "merchant">()
  const counterparties = new Set<string>()
  for (const message of bucket) {
    let role: "buyer" | "merchant" | null = null
    let counterpartyPubkey: string | null = null
    if (BUYER_AUTHORED_TYPES.has(message.type)) {
      if (message.senderPubkey === principalPubkey) {
        role = "buyer"
        counterpartyPubkey = message.recipientPubkey
      } else if (message.recipientPubkey === principalPubkey) {
        role = "merchant"
        counterpartyPubkey = message.senderPubkey
      }
    } else if (MERCHANT_AUTHORED_TYPES.has(message.type)) {
      if (message.senderPubkey === principalPubkey) {
        role = "merchant"
        counterpartyPubkey = message.recipientPubkey
      } else if (message.recipientPubkey === principalPubkey) {
        role = "buyer"
        counterpartyPubkey = message.senderPubkey
      }
    }
    if (!role || !counterpartyPubkey || counterpartyPubkey === principalPubkey)
      continue
    roles.add(role)
    counterparties.add(counterpartyPubkey)
    if (roles.size > 1 || counterparties.size > 1) return null
  }

  const role = [...roles][0]
  const counterpartyPubkey = [...counterparties][0]
  return role && counterpartyPubkey ? { role, counterpartyPubkey } : null
}

function buildBuyerConversationSummaries(
  messages: ParsedOrderMessage[],
  buyerPubkey: string
): BuyerConversationSummary[] {
  const grouped = new Map<string, ParsedOrderMessage[]>()

  for (const message of messages) {
    const bucket = grouped.get(message.orderId) ?? []
    bucket.push(message)
    grouped.set(message.orderId, bucket)
  }

  const conversations: BuyerConversationSummary[] = []
  for (const [orderId, bucket] of grouped.entries()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt)
    const latest = bucket[bucket.length - 1]
    if (!latest) continue

    const principal = resolvePrincipal(bucket, buyerPubkey)
    if (!principal || principal.role !== "buyer") continue
    const merchantPubkey = principal.counterpartyPubkey

    const latestStatus = [...bucket]
      .reverse()
      .find(
        (message) =>
          message.type === "status_update" &&
          message.senderPubkey === merchantPubkey &&
          message.recipientPubkey === buyerPubkey
      )
    const summary = extractOrderSummary(bucket, {
      buyerPubkey,
      merchantPubkey,
    })

    conversations.push({
      id: orderId,
      orderId,
      merchantPubkey,
      latestAt: latest.createdAt,
      latestType: latest.type,
      status:
        latestStatus?.type === "status_update"
          ? latestStatus.payload.status
          : null,
      totalSummary:
        summary.items.length > 0
          ? `${summary.subtotal} ${summary.currency}`
          : null,
      preview: getConversationPreview(latest),
      messageCount: bucket.length,
      messages: bucket,
      context: bucket.some((message) => message.type === "order")
        ? "complete"
        : "missing_order",
    })
  }

  conversations.sort((a, b) => b.latestAt - a.latestAt)
  return conversations
}

function buildMerchantConversationSummaries(
  messages: ParsedOrderMessage[],
  merchantPubkey: string
): MerchantConversationSummary[] {
  const grouped = new Map<string, ParsedOrderMessage[]>()

  for (const message of messages) {
    const bucket = grouped.get(message.orderId) ?? []
    bucket.push(message)
    grouped.set(message.orderId, bucket)
  }

  const conversations: MerchantConversationSummary[] = []
  for (const [orderId, bucket] of grouped.entries()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt)
    const latest = bucket[bucket.length - 1]
    if (!latest) continue

    const principal = resolvePrincipal(bucket, merchantPubkey)
    if (!principal || principal.role !== "merchant") continue
    const buyerPubkey = principal.counterpartyPubkey

    const latestStatus = [...bucket]
      .reverse()
      .find(
        (message) =>
          message.type === "status_update" &&
          message.senderPubkey === merchantPubkey &&
          message.recipientPubkey === buyerPubkey
      )
    const summary = extractOrderSummary(bucket, {
      buyerPubkey,
      merchantPubkey,
    })

    conversations.push({
      id: orderId,
      orderId,
      buyerPubkey,
      merchantPubkey,
      latestAt: latest.createdAt,
      latestType: latest.type,
      status:
        latestStatus?.type === "status_update"
          ? latestStatus.payload.status
          : null,
      totalSummary:
        summary.items.length > 0
          ? `${summary.subtotal} ${summary.currency}`
          : null,
      preview: getConversationPreview(latest),
      messageCount: bucket.length,
      messages: bucket,
      context: bucket.some((message) => message.type === "order")
        ? "complete"
        : "missing_order",
    })
  }

  conversations.sort((a, b) => b.latestAt - a.latestAt)
  return conversations
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
      .slice(0, query.limit ?? 200),
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
    .slice(0, query.limit ?? 200)

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
      .slice(0, query.limit ?? 200),
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
    .slice(0, query.limit ?? 200)

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
  const messages = result.messages.filter(
    (message) => message.orderId === query.orderId
  )
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

// --- General direct messages (kind 14), threaded by counterparty pubkey ---

export interface DirectConversationSummary {
  /** Transport-qualified thread id. */
  id: string
  transport: ParsedDirectMessage["transport"]
  counterpartyPubkey: string
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

function counterpartyOf(
  message: ParsedDirectMessage,
  principalPubkey: string
): string {
  return message.senderPubkey === principalPubkey
    ? message.recipientPubkey
    : message.senderPubkey
}

function buildDirectConversationSummaries(
  messages: ParsedDirectMessage[],
  principalPubkey: string,
  unreadMessageIds: ReadonlySet<string>
): DirectConversationSummary[] {
  const grouped = new Map<string, ParsedDirectMessage[]>()
  for (const message of messages) {
    const counterparty = counterpartyOf(message, principalPubkey)
    if (!counterparty) continue
    const threadId = `${message.transport}:${counterparty}`
    const bucket = grouped.get(threadId) ?? []
    bucket.push(message)
    grouped.set(threadId, bucket)
  }

  const conversations: DirectConversationSummary[] = []
  for (const [id, bucket] of grouped.entries()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt)
    const latest = bucket[bucket.length - 1]
    if (!latest) continue
    const counterpartyPubkey = counterpartyOf(latest, principalPubkey)
    conversations.push({
      id,
      transport: latest.transport,
      counterpartyPubkey,
      latestAt: latest.createdAt,
      // Keep complete content so presentation can recognize structured legacy
      // envelopes before applying visual line clamping.
      preview: latest.content,
      messageCount: bucket.length,
      unreadFromCounterparty: bucket.filter(
        (message) =>
          message.senderPubkey === counterpartyPubkey &&
          unreadMessageIds.has(message.id)
      ).length,
      messages: bucket,
    })
  }

  conversations.sort((a, b) => b.latestAt - a.latestAt)
  return conversations
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
}): Promise<number> {
  if (testOverrides.markDirectMessagesRead) {
    return await testOverrides.markDirectMessagesRead(
      input.principalPubkey,
      input.counterpartyPubkey,
      input.transport
    )
  }

  return await db.messages
    .where("recipientPubkey")
    .equals(input.principalPubkey)
    .filter(
      (row) =>
        row.kind ===
          (input.transport === "nip04"
            ? EVENT_KINDS.DM_LEGACY
            : EVENT_KINDS.DIRECT_MESSAGE) &&
        row.senderPubkey === input.counterpartyPubkey &&
        row.read === 0
    )
    .modify({ read: 1 })
}
