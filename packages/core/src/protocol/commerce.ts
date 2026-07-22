import {
  giftUnwrap,
  type NDKEvent,
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
import { config } from "../config"
import { compareCommercePrices } from "../pricing"
import type { Product, Profile } from "../types"
import { EVENT_KINDS } from "./kinds"
import {
  fetchEventsFanout,
  fetchEventsFanoutProgressive,
  getEventSourceRelayUrls,
  requireNdkConnected,
} from "./ndk"
import { extractOrderSummary } from "./order-summary"
import { parseOrderMessageRumorEvent, type ParsedOrderMessage } from "./orders"
import {
  __resetInboxRelayCache,
  createNdkLegacyDmDecrypt,
  decryptLegacyDirectMessage,
  fetchInboxRelayUrls,
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
  canonicalizeProductTags,
  normalizeProductSummaryForDisplay,
  parseProductEvent,
} from "./products"
import { parseProfileEvent } from "./profiles"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import {
  getCommerceReadRelayUrls,
  getGeneralReadRelayUrls,
} from "./relay-settings"
import { getRelayLists, isInsecureRelayUrl } from "./relay-list"
import { planRelayReads, type RelayReadIntent } from "./relay-planner"

const PRODUCT_CACHE_TTL_MS = 24 * 60 * 60_000
const BROAD_AUTHOR_HINT_LIMIT = 16
const DM_INBOX_READ_FANOUT = 24
// Keep author-scoped product filters small enough for public relays that
// reject or truncate very large authors arrays. This is a transport batch
// size, not a product truth cap.
const PRODUCT_AUTHOR_CHUNK_SIZE = 64
const PRODUCT_AUTHOR_CHUNK_CONCURRENCY = 2
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

export interface CommerceQueryMeta {
  source: CommerceReadSource
  degraded: boolean
  stale: boolean
  capabilities: CommerceCapabilities
  fetchedAt: number
  nextCursor?: string
  /**
   * Gift wraps that could not be turned into messages this read (id + coarse
   * reason only, never content). Surfaced so UIs render a retryable degraded
   * state instead of silently dropping messages.
   */
  decryptFailures?: DecryptFailure[]
  /** Deprecated kind-4 failures, kept distinct from NIP-17 gift wraps. */
  legacyDecryptFailures?: LegacyDmDecryptFailure[]
}

export interface CommerceResult<T> {
  data: T
  meta: CommerceQueryMeta
}

export interface CommerceProductRecord {
  product: Product
  safety?: ListingSafetyEvaluation
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
}

type RawDirectMessageFetchResult = {
  messages: ParsedDirectMessage[]
  unreadMessageIds: Set<string>
  source: CommerceReadSource
  stale: boolean
  decryptFailures: DecryptFailure[]
  legacyDecryptFailures: LegacyDmDecryptFailure[]
}

type PrivateInboxSyncResult = {
  orderMessages: ParsedOrderMessage[]
  directMessages: ParsedDirectMessage[]
  decryptFailures: DecryptFailure[]
}

type LegacyDmSyncResult = {
  directMessages: ParsedDirectMessage[]
  decryptFailures: LegacyDmDecryptFailure[]
}

type CommerceTestOverrides = {
  fetchEventsFanout?: typeof fetchEventsFanout
  fetchEventsFanoutProgressive?: typeof fetchEventsFanoutProgressive
  requireNdkConnected?: typeof requireNdkConnected
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

/**
 * Resolve a planner-driven relay URL list for a commerce read intent.
 * Pulls cached NIP-65 relay lists for any author/recipient hints so
 * fanout includes the author's write/read relays alongside user settings.
 * Falls back to the legacy URL accessors if planning yields nothing.
 */
async function planCommerceReadRelays(input: {
  intent: RelayReadIntent
  authors?: readonly string[]
  recipients?: readonly string[]
  authenticatedPubkey?: string | null
  maxRelays?: number
  relayHintMode?: "auto" | "skip" | "force"
  extraRelayUrls?: readonly string[]
}): Promise<string[]> {
  const hintPubkeys = Array.from(
    new Set(
      [...(input.authors ?? []), ...(input.recipients ?? [])]
        .map((p) => p.trim())
        .filter(Boolean)
    )
  )

  const shouldFetchRelayHints =
    hintPubkeys.length > 0 &&
    (input.relayHintMode === "force" ||
      (input.relayHintMode !== "skip" &&
        hintPubkeys.length <= BROAD_AUTHOR_HINT_LIMIT))
  const relayLists = shouldFetchRelayHints
    ? await getRelayLists(
        hintPubkeys,
        testOverrides.fetchEventsFanout
          ? {
              cacheOnly: true,
              allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
            }
          : {
              allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
            }
      )
    : undefined

  const plan = planRelayReads({
    intent: input.intent,
    authors: input.authors,
    recipients: input.recipients,
    relayLists,
    authenticatedPubkey: input.authenticatedPubkey,
    maxRelays: input.maxRelays,
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
    input.relayHintMode !== "force" &&
    (input.intent === "commerce_products" ||
      (input.intent === "author_products" && (input.authors?.length ?? 0) > 1))
  const externalRelayHints = (input.extraRelayUrls ?? []).filter(
    (url) => !isInsecureRelayUrl(url)
  )
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
    input.maxRelays === undefined
      ? plannedRelayUrls
      : plannedRelayUrls.slice(0, input.maxRelays)

  if (expandedRelayUrls.length > 0) return expandedRelayUrls

  // Defensive fallback: legacy resolution paths.
  switch (input.intent) {
    case "commerce_products":
    case "author_products":
      return commerceReadRelayUrls()
    default:
      return publicReadRelayUrls()
  }
}

async function runFetchEventsFanout(
  filter: NDKFilter,
  options?: Parameters<typeof fetchEventsFanout>[1]
): Promise<NDKEvent[]> {
  const impl = testOverrides.fetchEventsFanout ?? fetchEventsFanout
  return (await impl(filter, options)) as NDKEvent[]
}

async function runRequireNdkConnected(): Promise<
  Awaited<ReturnType<typeof requireNdkConnected>>
> {
  const impl = testOverrides.requireNdkConnected ?? requireNdkConnected
  return await impl()
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
    nextCursor?: string
    decryptFailures?: DecryptFailure[]
    legacyDecryptFailures?: LegacyDmDecryptFailure[]
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
    degraded:
      options.degraded ??
      (options.stale === true ||
        source !== plan.sources[0] ||
        decryptFailures !== undefined ||
        legacyDecryptFailures !== undefined),
    capabilities,
    fetchedAt: now(),
    nextCursor: options.nextCursor,
    decryptFailures,
    legacyDecryptFailures,
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

function putMergedEvent(merged: Map<string, NDKEvent>, event: NDKEvent): void {
  const fallbackId = `${event.pubkey}:${event.kind}:${event.created_at ?? 0}`
  merged.set(event.id || fallbackId, event)
}

async function streamProductRecordChunks(input: {
  baseFilter: NDKFilter
  authorChunks: Array<string[] | undefined>
  relayUrls: string[]
  readPolicy?: CommerceReadPolicy
  merged: Map<string, NDKEvent>
  onRecords: (records: CommerceProductRecord[], relayUrl: string) => void
}): Promise<void> {
  if (input.relayUrls.length === 0) return

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
          ({ mergedEvents, relayUrl }) => {
            for (const event of mergedEvents) {
              putMergedEvent(input.merged, event)
            }
            input.onRecords(
              dedupeProductEvents(Array.from(input.merged.values())),
              relayUrl
            )
          }
        )
        for (const event of events) {
          putMergedEvent(input.merged, event)
        }
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
  switch (sort) {
    case "price_asc":
      return items.sort(
        (a, b) =>
          compareCommercePrices(a.product, b.product, null, "asc") ||
          b.product.updatedAt - a.product.updatedAt
      )
    case "price_desc":
      return items.sort(
        (a, b) =>
          compareCommercePrices(a.product, b.product, null, "desc") ||
          b.product.updatedAt - a.product.updatedAt
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
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
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
  return isListingMarketVisible(
    record.safety ?? evaluateListingSafety(record.product)
  )
}

function filterProductRecordsForRead(
  records: CommerceProductRecord[],
  options: { includeMarketHidden?: boolean } = {}
): CommerceProductRecord[] {
  return options.includeMarketHidden
    ? records
    : records.filter(isMarketRenderableRecord)
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
    format: product.format,
    shippingCostSats: product.shippingCostSats,
    sourceShippingCost: product.sourceShippingCost,
    shippingOptionId: product.shippingOptionId,
    shippingOptionDTag: product.shippingOptionDTag,
    shippingCountries: product.shippingCountries,
    shippingCountryRules: product.shippingCountryRules,
    visibility: product.visibility,
    stock: product.stock,
    images: product.images,
    tags: canonicalizeProductTags(product.tags),
    publicZapEnabled: product.publicZapEnabled,
    zapMessagePolicy: product.zapMessagePolicy,
    publicZapPolicyKnown: product.publicZapPolicyKnown,
    location: product.location,
    eventId: record.eventId,
    eventCreatedAt: record.eventCreatedAt,
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
    format: row.format ?? "physical",
    shippingCostSats: row.shippingCostSats,
    sourceShippingCost: row.sourceShippingCost,
    shippingOptionId: row.shippingOptionId,
    shippingOptionDTag: row.shippingOptionDTag,
    shippingCountries: row.shippingCountries,
    shippingCountryRules: row.shippingCountryRules,
    visibility: row.visibility ?? "public",
    stock: row.stock,
    images: row.images ?? [],
    tags,
    publicZapEnabled: row.publicZapEnabled ?? true,
    zapMessagePolicy,
    publicZapPolicyKnown: row.publicZapPolicyKnown ?? false,
    location: row.location,
    createdAt: row.createdAt ?? row.cachedAt,
    updatedAt: row.updatedAt ?? row.cachedAt,
  }

  const dTag = product.id.startsWith("30402:")
    ? product.id.split(":").slice(2).join(":")
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

async function loadProductSourceRelayHints(
  pubkeys: readonly string[]
): Promise<string[]> {
  const uniquePubkeys = uniqueStrings(pubkeys)
  if (uniquePubkeys.length === 0) return []

  const rows = (
    await Promise.all(uniquePubkeys.map((pubkey) => loadCachedProducts(pubkey)))
  ).flat()

  return uniqueStrings(rows.flatMap((row) => row.sourceRelayUrls ?? []))
}

function getProfileQueryRelayHints(query: ProfileBatchQuery): string[] {
  if (!query.relayHintsByPubkey) return []
  return uniqueStrings(
    query.pubkeys.flatMap((pubkey) => query.relayHintsByPubkey?.[pubkey] ?? [])
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
    if (!existing || shouldReplaceCachedProduct(existing, row)) {
      selected.set(row.id, row)
      changed.set(row.id, row)
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

function productDeletionEventKey(pubkey: string, eventId: string): string {
  return `${pubkey}:${eventId}`
}

function parseProductAddressTag(
  value: string,
  authorPubkey: string
): { addressId: string; pubkey: string } | null {
  const [kind, pubkey, ...dParts] = value.split(":")
  const dTag = dParts.join(":")
  if (kind !== String(EVENT_KINDS.PRODUCT) || !pubkey || !dTag) return null
  if (pubkey !== authorPubkey) return null
  return {
    addressId: `${EVENT_KINDS.PRODUCT}:${pubkey}:${dTag}`,
    pubkey,
  }
}

function tombstonesFromDeletionEvent(
  event: NDKEvent
): CachedProductTombstone[] {
  if (!event.pubkey) throw new Error("Deletion event pubkey is required")
  if (!event.id) throw new Error("Deletion event id is required")

  const deletedAt = toEventCreatedAtSeconds(event)
  const rows = new Map<string, CachedProductTombstone>()
  const cachedAt = now()

  for (const tag of event.tags ?? []) {
    const [tagName, tagValue] = tag
    if (!tagValue) continue

    if (tagName === "a") {
      const address = parseProductAddressTag(tagValue, event.pubkey)
      if (!address) continue
      rows.set(productTombstoneIdForAddress(address.addressId), {
        id: productTombstoneIdForAddress(address.addressId),
        pubkey: address.pubkey,
        addressId: address.addressId,
        deletedAt,
        deletionEventId: event.id,
        cachedAt,
      })
    }

    if (tagName === "e") {
      rows.set(productTombstoneIdForEvent(event.pubkey, tagValue), {
        id: productTombstoneIdForEvent(event.pubkey, tagValue),
        pubkey: event.pubkey,
        eventId: tagValue,
        deletedAt,
        deletionEventId: event.id,
        cachedAt,
      })
    }
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
    if (!existing || row.deletedAt >= existing.deletedAt) {
      selected.set(row.id, row)
      changed.set(row.id, row)
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

function deletionTimestampsFromTombstones(
  tombstones: readonly CachedProductTombstone[]
): DeletionTimestamps {
  const byEventId = new Map<string, number>()
  const byAddressId = new Map<string, number>()

  for (const tombstone of tombstones) {
    if (tombstone.eventId) {
      setLatestTimestamp(
        byEventId,
        productDeletionEventKey(tombstone.pubkey, tombstone.eventId),
        tombstone.deletedAt
      )
    }
    if (tombstone.addressId) {
      setLatestTimestamp(byAddressId, tombstone.addressId, tombstone.deletedAt)
    }
  }

  return { byEventId, byAddressId }
}

function mergeDeletionTimestamps(
  ...inputs: readonly DeletionTimestamps[]
): DeletionTimestamps {
  const byEventId = new Map<string, number>()
  const byAddressId = new Map<string, number>()

  for (const input of inputs) {
    for (const [eventId, deletedAt] of input.byEventId) {
      setLatestTimestamp(byEventId, eventId, deletedAt)
    }
    for (const [addressId, deletedAt] of input.byAddressId) {
      setLatestTimestamp(byAddressId, addressId, deletedAt)
    }
  }

  return { byEventId, byAddressId }
}

async function getLocalProductDeletionTimestamps(
  merchantPubkey?: string,
  authorPubkeys?: readonly string[]
): Promise<DeletionTimestamps> {
  return deletionTimestampsFromTombstones(
    await loadCachedProductTombstones(merchantPubkey, authorPubkeys)
  )
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
  if (
    event.kind !== EVENT_KINDS.DELETION ||
    !event.id ||
    !event.sig ||
    !isValidSignedPublicNostrEvent(event.rawEvent() as SignedPublicNostrEvent)
  ) {
    throw new Error("Expected a valid signed product deletion event")
  }

  const tombstones = tombstonesFromDeletionEvent(event)
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

async function storeCachedProfiles(rows: CachedProfile[]): Promise<void> {
  if (rows.length === 0) return

  if (testOverrides.putCachedProfiles) {
    await testOverrides.putCachedProfiles(rows)
    return
  }

  await db.profiles.bulkPut(rows)
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

function cachedProfileToProfile(row: CachedProfile): Profile {
  return {
    pubkey: row.pubkey,
    name: row.name,
    displayName: row.displayName,
    about: row.about,
    picture: row.picture,
    banner: row.banner,
    nip05: row.nip05,
    lud16: row.lud16,
    website: row.website,
  }
}

function mergeProfileField(
  current: string | undefined,
  incoming: string | undefined
): string | undefined {
  return typeof incoming === "string" && incoming.trim().length > 0
    ? incoming
    : current
}

function mergeProfileData(
  current: Profile | undefined,
  incoming: Profile | undefined
): Profile | undefined {
  if (!incoming) return current
  if (!current) return incoming
  if (!hasProfileContent(incoming)) {
    return hasProfileContent(current) ? current : incoming
  }
  if (!hasProfileContent(current)) return incoming

  return {
    pubkey: incoming.pubkey || current.pubkey,
    name: mergeProfileField(current.name, incoming.name),
    displayName: mergeProfileField(current.displayName, incoming.displayName),
    about: mergeProfileField(current.about, incoming.about),
    picture: mergeProfileField(current.picture, incoming.picture),
    banner: mergeProfileField(current.banner, incoming.banner),
    nip05: mergeProfileField(current.nip05, incoming.nip05),
    lud16: mergeProfileField(current.lud16, incoming.lud16),
    website: mergeProfileField(current.website, incoming.website),
  }
}

function pickLatestProfileEventWithContent(
  events: readonly NDKEvent[],
  pubkey: string
): NDKEvent | undefined {
  return events
    .filter((event) => event.pubkey === pubkey)
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .find((event) => hasProfileContent(parseProfileEvent(event)))
}

function mergeProfileEvents(
  pubkeys: readonly string[],
  currentProfiles: Record<string, Profile>,
  events: readonly NDKEvent[]
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
    const profile = mergeProfileData(
      profiles[pubkey],
      event ? parseProfileEvent(event) : { pubkey }
    )
    const sourceRelayUrls = event ? getEventSourceRelayUrls(event) : undefined
    profiles[pubkey] = profile ?? { pubkey }
    if (profile && hasProfileContent(profile)) {
      if (event) hasResolvedProfile = true
      rowsToCache.push({
        pubkey: profile.pubkey,
        name: profile.name,
        displayName: profile.displayName,
        about: profile.about,
        picture: profile.picture,
        banner: profile.banner,
        nip05: profile.nip05,
        lud16: profile.lud16,
        website: profile.website,
        sourceRelayUrls,
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
  byEventId: Map<string, number>
  byAddressId: Map<string, number>
}

function setLatestTimestamp(
  map: Map<string, number>,
  key: string,
  value: number
): void {
  const existing = map.get(key) ?? -1
  if (value >= existing) map.set(key, value)
}

function collectProductAddresses(events: NDKEvent[]): string[] {
  const addresses = new Set<string>()
  for (const event of events) {
    const dTag = getTagValue(event.tags ?? [], "d")
    if (!dTag) continue
    addresses.add(`30402:${event.pubkey}:${dTag}`)
  }
  return Array.from(addresses)
}

async function fetchDeletionTimestamps(
  merchantPubkey: string,
  productEventIds: string[],
  productAddresses: string[],
  options: {
    readPolicy?: CommerceReadPolicy
    fallbackWhenEmpty?: boolean
    authenticatedPubkey?: string | null
  } = {}
): Promise<DeletionTimestamps> {
  const byEventId = new Map<string, number>()
  const byAddressId = new Map<string, number>()

  const filters: NDKFilter[] = []
  if (productEventIds.length > 0) {
    filters.push({
      kinds: [EVENT_KINDS.DELETION],
      authors: [merchantPubkey],
      "#e": productEventIds,
      limit: 300,
    })
  }
  if (productAddresses.length > 0) {
    filters.push({
      kinds: [EVENT_KINDS.DELETION],
      authors: [merchantPubkey],
      "#a": productAddresses,
      limit: 300,
    })
  }

  const deletionEvents: NDKEvent[] = []
  const deletionRelayUrls = await planCommerceReadRelays({
    intent: "author_products",
    authors: [merchantPubkey],
    authenticatedPubkey: options.authenticatedPubkey,
    maxRelays: options.readPolicy?.maxRelays,
  })
  const fanoutOptions = {
    relayUrls: deletionRelayUrls,
    connectTimeoutMs: options.readPolicy?.connectTimeoutMs ?? 4_000,
    fetchTimeoutMs: options.readPolicy?.fetchTimeoutMs ?? 10_000,
  }
  for (const filter of filters) {
    const fetched = await runFetchEventsFanout(filter, fanoutOptions)
    deletionEvents.push(...fetched)
  }

  if (deletionEvents.length === 0 && options.fallbackWhenEmpty !== false) {
    const fallback = await runFetchEventsFanout(
      {
        kinds: [EVENT_KINDS.DELETION],
        authors: [merchantPubkey],
        limit: 300,
      },
      fanoutOptions
    )
    deletionEvents.push(...fallback)
  }

  for (const deletion of deletionEvents) {
    const deletedAt = toEventCreatedAtSeconds(deletion)
    for (const tag of deletion.tags ?? []) {
      const tagName = tag[0]
      const tagValue = tag[1]
      if (!tagValue) continue
      if (tagName === "e") {
        setLatestTimestamp(
          byEventId,
          productDeletionEventKey(deletion.pubkey, tagValue),
          deletedAt
        )
      }
      if (tagName === "a") {
        const address = parseProductAddressTag(tagValue, deletion.pubkey)
        if (address) {
          setLatestTimestamp(byAddressId, address.addressId, deletedAt)
        }
      }
    }
  }

  return { byEventId, byAddressId }
}

function isDeletedByNip09(
  event: Pick<NDKEvent, "id" | "pubkey" | "created_at">,
  addressId: string,
  deletionTimestamps: DeletionTimestamps
): boolean {
  const createdAt = toEventCreatedAtSeconds(event)
  if (event.id) {
    const deletedAt =
      deletionTimestamps.byEventId.get(
        productDeletionEventKey(event.pubkey, event.id)
      ) ?? -1
    if (deletedAt >= createdAt) return true
  }

  const deletedAtAddress = deletionTimestamps.byAddressId.get(addressId) ?? -1
  return deletedAtAddress >= createdAt
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
        isDeletedByNip09(event, addressId, deletionTimestamps)
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
      if (!existing || shouldReplaceProductRecord(existing, candidate)) {
        byAddress.set(addressId, candidate)
      }
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
  const deletedByEvent =
    deletionTimestamps.byEventId.get(
      productDeletionEventKey(record.product.pubkey, record.eventId)
    ) ?? -1
  if (deletedByEvent >= record.eventCreatedAt) return true

  const deletedByAddress =
    deletionTimestamps.byAddressId.get(record.addressId) ?? -1
  return deletedByAddress >= record.eventCreatedAt
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
    if (!existing || shouldReplaceProductRecord(existing, record)) {
      byAddress.set(record.addressId, record)
    }
  }

  return Array.from(byAddress.values())
}

async function fetchPublicProductRecords(query: {
  authors?: string[]
  ids?: string[]
  dTags?: string[]
  authenticatedPubkey?: string | null
  limit?: number
  readPolicy?: CommerceReadPolicy
}): Promise<CommerceProductRecord[]> {
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.PRODUCT],
  }

  if (query.limit !== undefined) filter.limit = query.limit
  if (query.authors) filter.authors = query.authors
  if (query.ids) filter.ids = query.ids
  if (query.dTags) filter["#d"] = query.dTags

  const relayUrls = await planCommerceReadRelays({
    intent:
      query.authors && query.authors.length > 0
        ? "author_products"
        : "commerce_products",
    authors: query.authors,
    authenticatedPubkey: query.authenticatedPubkey,
    maxRelays: query.readPolicy?.maxRelays,
  })

  const events = await runFetchEventsFanout(filter, {
    relayUrls,
    connectTimeoutMs: query.readPolicy?.connectTimeoutMs ?? 4_000,
    fetchTimeoutMs: query.readPolicy?.fetchTimeoutMs ?? 8_000,
  })

  return dedupeProductEvents(events)
}

async function fetchPublicProductRecordsProgressive(
  query: {
    authors?: string[]
    ids?: string[]
    dTags?: string[]
    authenticatedPubkey?: string | null
    limit?: number
    readPolicy?: CommerceReadPolicy
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
    onRecords,
  })

  const expandedRelayUrls = await expandedRelayUrlsPromise
  const expansionRelayUrls = expandedRelayUrls.filter(
    (relayUrl) => !relayUrls.includes(relayUrl)
  )
  await streamProductRecordChunks({
    baseFilter: filter,
    authorChunks,
    relayUrls: expansionRelayUrls,
    readPolicy: query.readPolicy,
    merged,
    onRecords,
  })

  return dedupeProductEvents(Array.from(merged.values()))
}

function applyProductLimit(
  records: CommerceProductRecord[],
  limit: number | undefined
): CommerceProductRecord[] {
  return limit === undefined ? records : records.slice(0, limit)
}

function parseContactListPubkeys(
  event: Pick<NDKEvent, "tags"> | undefined
): string[] {
  if (!event) return []
  return uniqueStrings(
    (event.tags ?? [])
      .filter((tag) => tag[0] === "p" && typeof tag[1] === "string")
      .map((tag) => tag[1])
  )
}

function pickLatestEvent<T extends Pick<NDKEvent, "created_at">>(
  events: T[]
): T | undefined {
  return events.reduce<T | undefined>((latest, event) => {
    if (!latest) return event
    return (event.created_at ?? 0) >= (latest.created_at ?? 0) ? event : latest
  }, undefined)
}

export async function getFollowPubkeys(
  query: FollowListQuery
): Promise<CommerceResult<string[]>> {
  const pubkey = query.pubkey.trim()
  if (!pubkey) {
    return {
      data: [],
      meta: createMeta("profile_batch", "public", PROFILE_CAPABILITIES),
    }
  }

  const relayUrls = await planCommerceReadRelays({
    intent: "profile_social_feed",
    authors: [pubkey],
    authenticatedPubkey: query.authenticatedPubkey,
  })
  const events = await runFetchEventsFanout(
    {
      kinds: [EVENT_KINDS.CONTACT_LIST],
      authors: [pubkey],
      limit: 5,
    },
    {
      relayUrls,
      connectTimeoutMs: 2_500,
      fetchTimeoutMs: 4_000,
    }
  )

  return {
    data: parseContactListPubkeys(pickLatestEvent(events)),
    meta: createMeta("profile_batch", "public", PROFILE_CAPABILITIES),
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
    const fetchedRecords = await fetchPublicProductRecords({
      authors:
        authorPubkeys && authorPubkeys.length > 0
          ? uniqueStrings(authorPubkeys)
          : undefined,
      authenticatedPubkey: query.authenticatedPubkey,
      limit: query.limit,
      readPolicy: query.readPolicy,
    })
    const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
      query.merchantPubkey,
      query.authorPubkeys
    )
    const records = filterDeletedProductRecords(
      fetchedRecords,
      localDeletionTimestamps
    )
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

    return {
      data: filtered,
      meta: createMeta("marketplace_products", "public", PRODUCT_CAPABILITIES),
    }
  } catch (error) {
    const cached = applyProductLimit(
      sortProducts(
        (
          await getCachedProductRecords(
            query.merchantPubkey,
            undefined,
            query.authorPubkeys
          )
        ).filter((record) => productMatchesQuery(record, query)),
        query.sort
      ),
      query.limit
    )

    if (cached.length > 0) {
      return {
        data: cached,
        meta: createMeta(
          "marketplace_products",
          "local_cache",
          PRODUCT_CAPABILITIES,
          { stale: true }
        ),
      }
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
  const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
    query.merchantPubkey,
    query.authorPubkeys
  )
  const toResult = (records: CommerceProductRecord[]) => {
    const filteredRecords = filterDeletedProductRecords(
      records,
      localDeletionTimestamps
    )
    return {
      data: applyProductLimit(
        sortProducts(
          filterProductRecordsForRead(filteredRecords).filter((record) =>
            productMatchesQuery(record, query)
          ),
          query.sort
        ),
        limit
      ),
      meta: createMeta("marketplace_products", "public", PRODUCT_CAPABILITIES),
    }
  }

  const fetchedRecords = await fetchPublicProductRecordsProgressive(
    {
      authors:
        authorPubkeys && authorPubkeys.length > 0
          ? uniqueStrings(authorPubkeys)
          : undefined,
      authenticatedPubkey: query.authenticatedPubkey,
      limit,
      readPolicy: query.readPolicy,
    },
    (records, relayUrl) => {
      onProgress(toResult(records), relayUrl)
    }
  )

  const records = filterDeletedProductRecords(
    fetchedRecords,
    localDeletionTimestamps
  )
  const result = toResult(records)
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
      (
        await getCachedProductRecords(
          query.merchantPubkey,
          options,
          query.authorPubkeys
        )
      ).filter((record) => productMatchesQuery(record, query)),
      query.sort
    ),
    query.limit
  )

  return {
    data: cached,
    meta: createMeta(
      "marketplace_products",
      "local_cache",
      PRODUCT_CAPABILITIES,
      {
        stale: true,
        degraded: cached.length > 0,
      }
    ),
  }
}

export async function getMerchantStorefront(
  query: MerchantStorefrontQuery
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const cached = await getCachedProductRecords(query.merchantPubkey, {
    includeStale: true,
    includeMarketHidden: query.includeMarketHidden,
  })

  try {
    const relayUrls = await planCommerceReadRelays({
      intent: "author_products",
      authors: [query.merchantPubkey],
      authenticatedPubkey: query.authenticatedPubkey,
    })
    const productFilter: NDKFilter = {
      kinds: [EVENT_KINDS.PRODUCT],
      authors: [query.merchantPubkey],
    }
    if (query.limit !== undefined) productFilter.limit = query.limit

    const rawEvents = await runFetchEventsFanout(productFilter, {
      relayUrls,
      connectTimeoutMs: query.readPolicy?.connectTimeoutMs ?? 4_000,
      fetchTimeoutMs: query.readPolicy?.fetchTimeoutMs ?? 10_000,
    })

    const relayDeletionTimestamps = await fetchDeletionTimestamps(
      query.merchantPubkey,
      rawEvents.map((event) => event.id).filter(Boolean) as string[],
      uniqueStrings([
        ...collectProductAddresses(rawEvents),
        ...cached.map((record) => record.addressId),
      ]),
      {
        readPolicy: query.deletionReadPolicy,
        fallbackWhenEmpty: query.deletionFallbackWhenEmpty,
        authenticatedPubkey: query.authenticatedPubkey,
      }
    )
    const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
      query.merchantPubkey
    )
    const deletionTimestamps = mergeDeletionTimestamps(
      relayDeletionTimestamps,
      localDeletionTimestamps
    )

    const liveRecords = dedupeProductEvents(rawEvents, deletionTimestamps)
    const mergedRecords = mergeCachedAndLiveProductRecords({
      cached,
      live: liveRecords,
      deletionTimestamps,
    })

    const sorted = sortProducts(
      filterProductRecordsForRead(mergedRecords, {
        includeMarketHidden: query.includeMarketHidden,
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
    return {
      data: filtered,
      meta:
        liveRecords.length === 0 && filtered.length > 0
          ? createMeta(
              "merchant_storefront",
              "local_cache",
              PRODUCT_CAPABILITIES,
              { stale: true, degraded: true }
            )
          : createMeta("merchant_storefront", "commerce", PRODUCT_CAPABILITIES),
    }
  } catch (error) {
    const filteredCache = sortProducts(
      cached.filter((record) =>
        productMatchesQuery(record, {
          merchantPubkey: query.merchantPubkey,
          textQuery: query.textQuery,
          tags: query.tag ? [query.tag] : undefined,
        })
      ),
      query.sort
    )

    if (filteredCache.length > 0) {
      return {
        data: applyProductLimit(filteredCache, query.limit),
        meta: createMeta(
          "merchant_storefront",
          "local_cache",
          PRODUCT_CAPABILITIES,
          { stale: true }
        ),
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
    includeMarketHidden:
      options.includeMarketHidden ?? query.includeMarketHidden,
  }
  const cached = applyProductLimit(
    sortProducts(
      (await getCachedProductRecords(query.merchantPubkey, readOptions)).filter(
        (record) =>
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

  return {
    data: cached,
    meta: createMeta(
      "merchant_storefront",
      "local_cache",
      PRODUCT_CAPABILITIES,
      {
        stale: true,
        degraded: cached.length > 0,
      }
    ),
  }
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

export async function getProductDetail(
  query: ProductDetailQuery
): Promise<CommerceResult<CommerceProductRecord | null>> {
  const { decodedId, addressId, address } = getProductLookupIds(query.productId)

  try {
    if (address && addressId && address.kind === EVENT_KINDS.PRODUCT) {
      const cached = (
        await getCachedProductRecords(address.pubkey, {
          includeStale: true,
          includeMarketHidden: query.includeMarketHidden,
        })
      ).filter((item) => item.addressId === addressId)
      const direct = await fetchPublicProductRecords({
        authors: [address.pubkey],
        dTags: [address.d],
        limit: 10,
      })
      const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
        address.pubkey
      )
      const merged = mergeCachedAndLiveProductRecords({
        cached,
        live: direct,
        deletionTimestamps: localDeletionTimestamps,
      })
      await cacheProductRecords(merged)
      const record =
        filterProductRecordsForRead(merged, {
          includeMarketHidden: query.includeMarketHidden,
        }).find((item) => item.addressId === addressId) ?? null
      if (record) {
        return {
          data: record,
          meta:
            direct.length > 0
              ? createMeta("product_detail", "commerce", PRODUCT_CAPABILITIES)
              : createMeta(
                  "product_detail",
                  "local_cache",
                  PRODUCT_CAPABILITIES,
                  { stale: true, degraded: true }
                ),
        }
      }

      const storefront = await getMerchantStorefront({
        merchantPubkey: address.pubkey,
        includeMarketHidden: query.includeMarketHidden,
      })
      const fallbackRecord =
        storefront.data.find((item) => item.addressId === addressId) ?? null
      return {
        data: fallbackRecord,
        meta: { ...storefront.meta, fetchedAt: now() },
      }
    }

    if (/^[0-9a-f]{64}$/i.test(decodedId)) {
      const records = await fetchPublicProductRecords({
        ids: [decodedId],
        limit: 1,
      })
      await cacheProductRecords(records)
      const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
        undefined,
        uniqueStrings(records.map((record) => record.product.pubkey))
      )
      const visibleRecords = filterDeletedProductRecords(
        records,
        localDeletionTimestamps
      )
      const record =
        filterProductRecordsForRead(visibleRecords, {
          includeMarketHidden: query.includeMarketHidden,
        })[0] ?? null
      return {
        data: record,
        meta: createMeta("product_detail", "public", PRODUCT_CAPABILITIES),
      }
    }
  } catch (error) {
    const cached = await getCachedProductRecords(undefined, {
      includeStale: true,
      includeMarketHidden: query.includeMarketHidden,
    })
    const lookupIds = [decodedId, addressId].filter(Boolean)
    const record =
      cached.find(
        (item) =>
          lookupIds.includes(item.product.id) ||
          lookupIds.includes(item.addressId)
      ) ?? null
    if (record) {
      return {
        data: record,
        meta: createMeta(
          "product_detail",
          "local_cache",
          PRODUCT_CAPABILITIES,
          { stale: true }
        ),
      }
    }
    throw error
  }

  const cached = await getCachedProductRecords(undefined, {
    includeStale: true,
    includeMarketHidden: query.includeMarketHidden,
  })
  const lookupIds = [decodedId, addressId].filter(Boolean)
  const record =
    cached.find(
      (item) =>
        lookupIds.includes(item.product.id) ||
        lookupIds.includes(item.addressId)
    ) ?? null
  return {
    data: record,
    meta: createMeta(
      "product_detail",
      record ? "local_cache" : "public",
      PRODUCT_CAPABILITIES,
      { stale: !!record, degraded: !!record }
    ),
  }
}

// Resolve many product listings by addressId in a single relay fanout (instead
// of one read per id). Used to hydrate order-item name/image without hammering
// relays with N separate reads.
export async function getProductsByIds(
  productIds: string[]
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const addresses = productIds
    .map((id) => getProductLookupIds(id).address)
    .filter(
      (address): address is { kind: number; pubkey: string; d: string } =>
        !!address && address.kind === EVENT_KINDS.PRODUCT
    )

  if (addresses.length === 0) {
    return {
      data: [],
      meta: createMeta("product_detail", "commerce", PRODUCT_CAPABILITIES),
    }
  }

  const authors = uniqueStrings(addresses.map((address) => address.pubkey))
  const dTags = uniqueStrings(addresses.map((address) => address.d))
  const wanted = new Set(
    addresses.map((address) => `${address.kind}:${address.pubkey}:${address.d}`)
  )
  const cached = (
    await getCachedProductRecords(undefined, { includeStale: true }, authors)
  ).filter((record) => wanted.has(record.addressId))
  const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
    undefined,
    authors
  )

  try {
    const records = await fetchPublicProductRecords({
      authors,
      dTags,
      limit: Math.max(addresses.length * 2, 20),
    })
    const merged = mergeCachedAndLiveProductRecords({
      cached,
      live: records,
      deletionTimestamps: localDeletionTimestamps,
    })
    await cacheProductRecords(merged)
    const filtered = merged.filter((record) => wanted.has(record.addressId))
    return {
      data: filtered,
      meta:
        records.length > 0
          ? createMeta("product_detail", "commerce", PRODUCT_CAPABILITIES)
          : createMeta("product_detail", "local_cache", PRODUCT_CAPABILITIES, {
              stale: filtered.length > 0,
              degraded: filtered.length > 0,
            }),
    }
  } catch {
    const fallback = mergeCachedAndLiveProductRecords({
      cached,
      live: [],
      deletionTimestamps: localDeletionTimestamps,
    })
    return {
      data: fallback,
      meta: createMeta("product_detail", "local_cache", PRODUCT_CAPABILITIES, {
        stale: fallback.length > 0,
        degraded: fallback.length > 0,
      }),
    }
  }
}

export async function getCachedProductDetail(
  query: ProductDetailQuery,
  options: CachedProductReadOptions = { includeStale: true }
): Promise<CommerceResult<CommerceProductRecord | null>> {
  const { decodedId, addressId } = getProductLookupIds(query.productId)
  const cached = await getCachedProductRecords(undefined, options)
  const lookupIds = [decodedId, addressId].filter(Boolean)
  const record =
    cached.find(
      (item) =>
        lookupIds.includes(item.product.id) ||
        lookupIds.includes(item.addressId)
    ) ?? null

  return {
    data: record,
    meta: createMeta(
      "product_detail",
      record ? "local_cache" : "public",
      PRODUCT_CAPABILITIES,
      { stale: !!record, degraded: !!record }
    ),
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

  const cachedRows = query.skipCache ? [] : await loadCachedProfiles(pubkeys)
  pubkeys.forEach((pubkey, index) => {
    const cached = cachedRows[index]
    if (
      cached &&
      hasProfileContent(cached) &&
      now() - cached.cachedAt < PROFILE_CACHE_TTL_MS
    ) {
      result[pubkey] = cachedProfileToProfile(cached)
    } else {
      if (cached && hasProfileContent(cached)) {
        result[pubkey] = cachedProfileToProfile(cached)
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
    const sourceRelayHints = uniqueStrings([
      ...getProfileQueryRelayHints({ ...query, pubkeys: missing }),
      ...(await loadProductSourceRelayHints(missing)),
    ])
    const relayUrls = await planCommerceReadRelays({
      intent: "profiles",
      authors: missing,
      authenticatedPubkey: query.authenticatedPubkey,
      maxRelays: query.readPolicy?.maxRelays ?? (visible ? 8 : 4),
      extraRelayUrls: sourceRelayHints,
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

      const progress = mergeProfileEvents(missing, result, events)
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
      events
    )
    Object.assign(result, profiles)

    if (rowsToCache.length > 0) {
      await storeCachedProfiles(rowsToCache)
    }

    return {
      data: result,
      meta: createMeta("profile_batch", "public", PROFILE_CAPABILITIES),
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
  const cached = await loadCachedOrderMessages(principalPubkey)

  const cachedById = new Map<string, ParsedOrderMessage>()
  for (const row of cached) {
    try {
      cachedById.set(row.id, JSON.parse(row.rawContent) as ParsedOrderMessage)
    } catch {
      // skip corrupt cache rows
    }
  }

  try {
    const ndk = await runRequireNdkConnected()
    const signer = ndk.signer
    if (!signer) {
      if (cachedById.size > 0) {
        const messages = Array.from(cachedById.values()).sort(
          (a, b) => a.createdAt - b.createdAt
        )
        return {
          messages,
          source: "local_cache",
          stale: true,
          decryptFailures: [],
        }
      }
      throw new Error("Connect your Nostr signer to view order conversations.")
    }

    const sync = await syncPrivateMessageInbox(principalPubkey, signer)
    for (const parsed of sync.orderMessages) cachedById.set(parsed.id, parsed)

    const messages = Array.from(cachedById.values()).sort(
      (a, b) => a.createdAt - b.createdAt
    )
    return {
      messages,
      source: "commerce",
      stale: false,
      decryptFailures: sync.decryptFailures,
    }
  } catch (error) {
    if (cachedById.size > 0) {
      const messages = Array.from(cachedById.values()).sort(
        (a, b) => a.createdAt - b.createdAt
      )
      return {
        messages,
        source: "local_cache",
        stale: true,
        decryptFailures: [],
      }
    }
    throw error
  }
}

/** Resolve the principal's declared NIP-17 inbox. Empty lists are not cached. */
async function resolveInboxReadRelays(
  principalPubkey: string
): Promise<string[]> {
  if (testOverrides.resolveInboxRelayUrls) {
    const relays = await testOverrides.resolveInboxRelayUrls(principalPubkey)
    const secure = relays.filter((url) => !isInsecureRelayUrl(url))
    if (secure.length === 0) {
      throw new Error("No NIP-17 inbox relay declaration found.")
    }
    return secure
  }
  const secure = await fetchInboxRelayUrls(principalPubkey, {
    fetchEvents: runFetchEventsFanout,
    relayUrls: publicReadRelayUrls(),
  })
  if (secure.length === 0) {
    throw new Error("No NIP-17 inbox relay declaration found.")
  }
  return secure
}

async function fetchNewInboxWraps(
  principalPubkey: string,
  limit: number
): Promise<NDKEvent[]> {
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.GIFT_WRAP],
    "#p": [principalPubkey],
    limit,
  }

  const inboxRelayUrls = await resolveInboxReadRelays(principalPubkey)

  const wrapped = await runFetchEventsFanout(filter, {
    relayUrls: inboxRelayUrls.slice(0, DM_INBOX_READ_FANOUT),
    connectTimeoutMs: 4_000,
    fetchTimeoutMs: 12_000,
  })

  const successful = successfulWrapIdsByPrincipal.get(principalPubkey)
  return wrapped.filter((event) => !successful?.has(event.id))
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

function successfulLegacyDmIds(principalPubkey: string): Set<string> {
  let ids = successfulLegacyDmIdsByPrincipal.get(principalPubkey)
  if (!ids) {
    ids = new Set<string>()
    successfulLegacyDmIdsByPrincipal.set(principalPubkey, ids)
  }
  return ids
}

function retryLegacyDms(
  principalPubkey: string
): Map<
  string,
  { event: NDKEvent; attempts: number; failure?: LegacyDmDecryptFailure }
> {
  let events = retryLegacyDmsByPrincipal.get(principalPubkey)
  if (!events) {
    events = new Map()
    retryLegacyDmsByPrincipal.set(principalPubkey, events)
  }
  return events
}

async function runLegacyDmSync(
  principalPubkey: string,
  signer: NDKSigner
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
  const cachedIds = new Set(cached.map((row) => row.id))
  const successful = successfulLegacyDmIds(principalPubkey)
  const retry = retryLegacyDms(principalPubkey)
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
    await storeCachedDirectMessages(messages.map(cachedDirectMessageRow))
    for (const message of messages) {
      successful.add(message.id)
      retry.delete(message.id)
    }
  } catch {
    // Keep encrypted events in memory for retry; plaintext remains transient.
  }

  return {
    directMessages: messages,
    decryptFailures: Array.from(retry.values()).flatMap(({ failure }) =>
      failure ? [failure] : []
    ),
  }
}

async function syncLegacyDms(
  principalPubkey: string,
  signer: NDKSigner
): Promise<LegacyDmSyncResult> {
  const existing = legacyDmSyncPromises.get(principalPubkey)
  if (existing) return await existing
  const pending = runLegacyDmSync(principalPubkey, signer)
  legacyDmSyncPromises.set(principalPubkey, pending)
  try {
    return await pending
  } finally {
    if (legacyDmSyncPromises.get(principalPubkey) === pending) {
      legacyDmSyncPromises.delete(principalPubkey)
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
  signer: NDKSigner
): Promise<PrivateInboxSyncResult> {
  const [cachedOrders, cachedDirect, fetched] = await Promise.all([
    loadCachedOrderMessages(principalPubkey),
    loadCachedDirectMessages(principalPubkey),
    fetchNewInboxWraps(principalPubkey, 400),
  ])
  const cachedOrderIds = new Set(cachedOrders.map((row) => row.id))
  const cachedDirectIds = new Set(cachedDirect.map((row) => row.id))
  const successful = successfulWrapIds(principalPubkey)
  const retry = retryWraps(principalPubkey)
  const candidates = new Map<string, NDKEvent>()

  for (const { event } of retry.values()) candidates.set(event.id, event)
  for (const event of fetched) candidates.set(event.id, event)
  for (const event of candidates.values()) {
    retry.set(event.id, { event, failure: retry.get(event.id)?.failure })
  }

  const outcomes = await unwrapGiftWraps(
    Array.from(candidates.values()),
    signer,
    unwrapOptions()
  )
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
  try {
    await storeCachedOrderMessages(
      newOrderEntries.map((entry) => cachedOrderMessageRow(entry.message))
    )
    for (const entry of newOrderEntries) persisted(entry.wrapId)
  } catch {
    // Keep wrappers pending for a later cache retry; parsed messages remain usable.
  }

  const cachedDirectEntries = directEntries.filter((entry) => entry.isCached)
  const newDirectEntries = directEntries.filter((entry) => !entry.isCached)
  for (const entry of cachedDirectEntries) persisted(entry.wrapId)
  try {
    await storeCachedDirectMessages(
      newDirectEntries.map((entry) => cachedDirectMessageRow(entry.message))
    )
    for (const entry of newDirectEntries) persisted(entry.wrapId)
  } catch {
    // Keep wrappers pending for a later cache retry; parsed messages remain usable.
  }

  return {
    orderMessages: orderEntries.map((entry) => entry.message),
    directMessages: directEntries.map((entry) => entry.message),
    decryptFailures: Array.from(retry.values()).flatMap(({ failure }) =>
      failure ? [failure] : []
    ),
  }
}

async function syncPrivateMessageInbox(
  principalPubkey: string,
  signer: NDKSigner
): Promise<PrivateInboxSyncResult> {
  const existing = inboxSyncPromises.get(principalPubkey)
  if (existing) return await existing

  const pending = runPrivateMessageInboxSync(principalPubkey, signer)
  inboxSyncPromises.set(principalPubkey, pending)
  try {
    return await pending
  } finally {
    if (inboxSyncPromises.get(principalPubkey) === pending) {
      inboxSyncPromises.delete(principalPubkey)
    }
  }
}

async function fetchParsedDirectMessages(
  principalPubkey: string
): Promise<RawDirectMessageFetchResult> {
  const cached = await loadCachedDirectMessages(principalPubkey)
  const cachedById = new Map<string, ParsedDirectMessage>()
  const unreadMessageIds = new Set<string>()
  for (const row of cached) {
    cachedById.set(row.id, parseCachedDirectMessage(row))
    if (row.read === 0) unreadMessageIds.add(row.id)
  }

  try {
    const ndk = await runRequireNdkConnected()
    const signer = ndk.signer
    if (!signer) {
      if (cachedById.size > 0) {
        const messages = Array.from(cachedById.values()).sort(
          (a, b) => a.createdAt - b.createdAt
        )
        return {
          messages,
          unreadMessageIds,
          source: "local_cache",
          stale: true,
          decryptFailures: [],
          legacyDecryptFailures: [],
        }
      }
      throw new Error("Connect your Nostr signer to view messages.")
    }

    const [currentResult, legacyResult] = await Promise.allSettled([
      syncPrivateMessageInbox(principalPubkey, signer),
      syncLegacyDms(principalPubkey, signer),
    ])
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
        : { directMessages: [], decryptFailures: [] }
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
    return {
      messages,
      unreadMessageIds,
      source: "commerce",
      stale:
        currentResult.status === "rejected" ||
        legacyResult.status === "rejected",
      decryptFailures: current.decryptFailures,
      legacyDecryptFailures: legacy.decryptFailures,
    }
  } catch (error) {
    if (cachedById.size > 0) {
      const messages = Array.from(cachedById.values()).sort(
        (a, b) => a.createdAt - b.createdAt
      )
      return {
        messages,
        unreadMessageIds,
        source: "local_cache",
        stale: true,
        decryptFailures: [],
        legacyDecryptFailures: [],
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
      { stale: result.stale, decryptFailures: result.decryptFailures }
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
      { stale: result.stale, decryptFailures: result.decryptFailures }
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
      { stale: result.stale, decryptFailures: result.decryptFailures }
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
