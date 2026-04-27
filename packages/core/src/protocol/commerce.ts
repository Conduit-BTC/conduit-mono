import {
  giftUnwrap,
  type NDKEvent,
  type NDKFilter,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import {
  db,
  type CachedOrderMessage,
  type CachedProduct,
  type CachedProfile,
} from "../db"
import { config } from "../config"
import type { Product, Profile } from "../types"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanout, requireNdkConnected } from "./ndk"
import { extractOrderSummary } from "./order-summary"
import { parseOrderMessageRumorEvent, type ParsedOrderMessage } from "./orders"
import { parseProductEvent } from "./products"
import { parseProfileEvent } from "./profiles"
import {
  getCommerceReadRelayUrls,
  getGeneralReadRelayUrls,
} from "./relay-settings"

const PRODUCT_CACHE_TTL_MS = 5 * 60_000
const PROFILE_CACHE_TTL_MS = 5 * 60_000

export type CommerceReadSource = "commerce" | "public" | "local_cache"
export type CommerceSortMode =
  | "newest"
  | "price_asc"
  | "price_desc"
  | "updated_at_desc"
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
}

export interface CommerceResult<T> {
  data: T
  meta: CommerceQueryMeta
}

export interface CommerceProductRecord {
  product: Product
  eventId: string
  addressId: string
  dTag: string | null
  eventCreatedAt: number
}

export interface MarketplaceProductsQuery {
  merchantPubkey?: string
  textQuery?: string
  tags?: string[]
  sort?: CommerceSortMode
  limit?: number
  cursor?: string
}

export interface MerchantStorefrontQuery {
  merchantPubkey: string
  textQuery?: string
  tag?: string
  sort?: CommerceSortMode
  limit?: number
  cursor?: string
}

export interface ProductDetailQuery {
  productId: string
  revalidateCanonical?: boolean
}

export interface ProfileBatchQuery {
  pubkeys: string[]
  skipCache?: boolean
}

export interface ConversationListQuery {
  principalPubkey: string
  limit?: number
  textQuery?: string
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
}

export interface BuyerConversationSummary extends ConversationSummaryBase {
  merchantPubkey: string
}

export interface MerchantConversationSummary extends ConversationSummaryBase {
  buyerPubkey: string
}

export type ConversationSummary =
  | BuyerConversationSummary
  | MerchantConversationSummary

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
}

type CommerceTestOverrides = {
  fetchEventsFanout?: typeof fetchEventsFanout
  requireNdkConnected?: typeof requireNdkConnected
  now?: () => number
  getCachedProducts?: (merchantPubkey?: string) => Promise<CachedProduct[]>
  putCachedProducts?: (rows: CachedProduct[]) => Promise<void>
  getCachedProfiles?: (
    pubkeys: string[]
  ) => Promise<Array<CachedProfile | undefined>>
  putCachedProfiles?: (rows: CachedProfile[]) => Promise<void>
  getCachedOrderMessages?: (
    principalPubkey: string
  ) => Promise<CachedOrderMessage[]>
  putCachedOrderMessages?: (rows: CachedOrderMessage[]) => Promise<void>
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

function now(): number {
  return testOverrides.now?.() ?? Date.now()
}

function publicReadRelayUrls(): string[] {
  return getGeneralReadRelayUrls({
    fallbackRelayUrls:
      config.publicRelayUrls.length > 0 ? config.publicRelayUrls : undefined,
  })
}

function commerceReadRelayUrls(): string[] {
  return getCommerceReadRelayUrls({
    fallbackRelayUrls:
      config.commerceRelayUrls.length > 0
        ? config.commerceRelayUrls
        : config.publicRelayUrls,
  })
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
}

function createMeta(
  planName: CommerceReadPlanName,
  source: CommerceReadSource,
  capabilities: CommerceCapabilities,
  options: { stale?: boolean; degraded?: boolean; nextCursor?: string } = {}
): CommerceQueryMeta {
  const plan = resolveReadPlan(planName)
  return {
    source,
    stale: options.stale ?? source === "local_cache",
    degraded: options.degraded ?? source !== plan.sources[0],
    capabilities,
    fetchedAt: now(),
    nextCursor: options.nextCursor,
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

function productMatchesQuery(
  record: CommerceProductRecord,
  query: MarketplaceProductsQuery
): boolean {
  const { product } = record
  const textQuery = normalizeText(query.textQuery)
  if (query.merchantPubkey && product.pubkey !== query.merchantPubkey)
    return false
  if (textQuery) {
    const haystack = `${product.title}\n${product.summary ?? ""}`.toLowerCase()
    if (!haystack.includes(textQuery)) return false
  }

  if (query.tags && query.tags.length > 0) {
    const tagSet = new Set(query.tags.map((tag) => tag.toLowerCase()))
    if (!product.tags.some((tag) => tagSet.has(tag.toLowerCase()))) return false
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
          a.product.price - b.product.price ||
          b.product.updatedAt - a.product.updatedAt
      )
    case "price_desc":
      return items.sort(
        (a, b) =>
          b.product.price - a.product.price ||
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

function toCachedProduct(record: CommerceProductRecord) {
  const { product } = record
  return {
    id: product.id,
    pubkey: product.pubkey,
    title: product.title,
    summary: product.summary,
    price: product.price,
    currency: product.currency,
    type: product.type,
    visibility: product.visibility,
    stock: product.stock,
    images: product.images,
    tags: product.tags,
    location: product.location,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    cachedAt: now(),
  }
}

function fromCachedProduct(row: CachedProduct): CommerceProductRecord {
  const product: Product = {
    id: row.id,
    pubkey: row.pubkey,
    title: row.title,
    summary: row.summary,
    price: row.price,
    currency: row.currency,
    type: row.type ?? "simple",
    visibility: row.visibility ?? "public",
    stock: row.stock,
    images: row.images ?? [],
    tags: row.tags ?? [],
    location: row.location,
    createdAt: row.createdAt ?? row.cachedAt,
    updatedAt: row.updatedAt ?? row.cachedAt,
  }

  const dTag = product.id.startsWith("30402:")
    ? product.id.split(":").slice(2).join(":")
    : null
  return {
    product,
    eventId: product.id,
    addressId: product.id,
    dTag,
    eventCreatedAt: Math.floor(product.createdAt / 1000),
  }
}

async function loadCachedProducts(
  merchantPubkey?: string
): Promise<CachedProduct[]> {
  if (testOverrides.getCachedProducts) {
    return await testOverrides.getCachedProducts(merchantPubkey)
  }

  return merchantPubkey
    ? await db.products.where("pubkey").equals(merchantPubkey).toArray()
    : await db.products.toArray()
}

async function storeCachedProducts(rows: CachedProduct[]): Promise<void> {
  if (rows.length === 0) return

  if (testOverrides.putCachedProducts) {
    await testOverrides.putCachedProducts(rows)
    return
  }

  await db.products.bulkPut(rows)
}

async function getCachedProductRecords(
  merchantPubkey?: string
): Promise<CommerceProductRecord[]> {
  const rows = await loadCachedProducts(merchantPubkey)
  return rows
    .filter((row) => now() - row.cachedAt < PRODUCT_CACHE_TTL_MS)
    .map(fromCachedProduct)
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
  productAddresses: string[]
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
  for (const filter of filters) {
    const fetched = await runFetchEventsFanout(filter, {
      relayUrls: commerceReadRelayUrls(),
      connectTimeoutMs: 4_000,
      fetchTimeoutMs: 10_000,
    })
    deletionEvents.push(...fetched)
  }

  if (deletionEvents.length === 0) {
    const fallback = await runFetchEventsFanout(
      {
        kinds: [EVENT_KINDS.DELETION],
        authors: [merchantPubkey],
        limit: 300,
      },
      {
        relayUrls: commerceReadRelayUrls(),
        connectTimeoutMs: 4_000,
        fetchTimeoutMs: 10_000,
      }
    )
    deletionEvents.push(...fallback)
  }

  for (const deletion of deletionEvents) {
    const deletedAt = toEventCreatedAtSeconds(deletion)
    for (const tag of deletion.tags ?? []) {
      const tagName = tag[0]
      const tagValue = tag[1]
      if (!tagValue) continue
      if (tagName === "e") setLatestTimestamp(byEventId, tagValue, deletedAt)
      if (tagName === "a") setLatestTimestamp(byAddressId, tagValue, deletedAt)
    }
  }

  return { byEventId, byAddressId }
}

function isDeletedByNip09(
  event: Pick<NDKEvent, "id" | "created_at">,
  addressId: string,
  deletionTimestamps: DeletionTimestamps
): boolean {
  const createdAt = toEventCreatedAtSeconds(event)
  if (event.id) {
    const deletedAt = deletionTimestamps.byEventId.get(event.id) ?? -1
    if (deletedAt >= createdAt) return true
  }

  const deletedAtAddress = deletionTimestamps.byAddressId.get(addressId) ?? -1
  return deletedAtAddress >= createdAt
}

function dedupeProductEvents(
  events: NDKEvent[],
  deletionTimestamps?: DeletionTimestamps
): CommerceProductRecord[] {
  const byAddress = new Map<string, CommerceProductRecord>()

  for (const event of events) {
    try {
      const parsed = parseProductEvent(event)
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
        eventId: event.id,
        addressId,
        dTag,
        eventCreatedAt: toEventCreatedAtSeconds(event),
      }

      const dedupeKey = dTag ?? parsed.id
      const existing = byAddress.get(dedupeKey)
      if (!existing || candidate.eventCreatedAt >= existing.eventCreatedAt) {
        byAddress.set(dedupeKey, candidate)
      }
    } catch {
      // ignore malformed product events
    }
  }

  return Array.from(byAddress.values())
}

async function fetchPublicProductRecords(query: {
  authors?: string[]
  ids?: string[]
  dTags?: string[]
  limit: number
}): Promise<CommerceProductRecord[]> {
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.PRODUCT],
    limit: query.limit,
  }

  if (query.authors) filter.authors = query.authors
  if (query.ids) filter.ids = query.ids
  if (query.dTags) filter["#d"] = query.dTags

  const events = await runFetchEventsFanout(filter, {
    relayUrls: publicReadRelayUrls(),
    connectTimeoutMs: 4_000,
    fetchTimeoutMs: 8_000,
  })

  return dedupeProductEvents(events)
}

export async function getMarketplaceProducts(
  query: MarketplaceProductsQuery = {}
): Promise<CommerceResult<CommerceProductRecord[]>> {
  try {
    const records = await fetchPublicProductRecords({
      authors: query.merchantPubkey ? [query.merchantPubkey] : undefined,
      limit: query.limit ?? 50,
    })

    const filtered = sortProducts(
      records.filter((record) => productMatchesQuery(record, query)),
      query.sort
    ).slice(0, query.limit ?? 50)

    await cacheProductRecords(filtered)
    return {
      data: filtered,
      meta: createMeta("marketplace_products", "public", PRODUCT_CAPABILITIES),
    }
  } catch (error) {
    const cached = sortProducts(
      (await getCachedProductRecords(query.merchantPubkey)).filter((record) =>
        productMatchesQuery(record, query)
      ),
      query.sort
    ).slice(0, query.limit ?? 50)

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

export async function getMerchantStorefront(
  query: MerchantStorefrontQuery
): Promise<CommerceResult<CommerceProductRecord[]>> {
  try {
    const rawEvents = await runFetchEventsFanout(
      {
        kinds: [EVENT_KINDS.PRODUCT],
        authors: [query.merchantPubkey],
        limit: query.limit ?? 200,
      },
      {
        relayUrls: commerceReadRelayUrls(),
        connectTimeoutMs: 4_000,
        fetchTimeoutMs: 10_000,
      }
    )

    const deletionTimestamps = await fetchDeletionTimestamps(
      query.merchantPubkey,
      rawEvents.map((event) => event.id).filter(Boolean) as string[],
      collectProductAddresses(rawEvents)
    )

    const filtered = sortProducts(
      dedupeProductEvents(rawEvents, deletionTimestamps).filter((record) =>
        productMatchesQuery(record, {
          merchantPubkey: query.merchantPubkey,
          textQuery: query.textQuery,
          tags: query.tag ? [query.tag] : undefined,
          sort: query.sort,
          limit: query.limit,
        })
      ),
      query.sort
    ).slice(0, query.limit ?? 200)

    await cacheProductRecords(filtered)
    return {
      data: filtered,
      meta: createMeta("merchant_storefront", "commerce", PRODUCT_CAPABILITIES),
    }
  } catch (error) {
    const cached = sortProducts(
      (await getCachedProductRecords(query.merchantPubkey)).filter((record) =>
        productMatchesQuery(record, {
          merchantPubkey: query.merchantPubkey,
          textQuery: query.textQuery,
          tags: query.tag ? [query.tag] : undefined,
        })
      ),
      query.sort
    )

    if (cached.length > 0) {
      return {
        data: cached,
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

function parseAddress(
  productId: string
): { kind: number; pubkey: string; d: string } | null {
  const decoded = decodeURIComponent(productId)
  const [kindStr, pubkey, ...dParts] = decoded.split(":")
  const d = dParts.join(":")
  const kind = Number(kindStr)
  if (!Number.isFinite(kind) || !pubkey || !d) return null
  return { kind, pubkey, d }
}

export async function getProductDetail(
  query: ProductDetailQuery
): Promise<CommerceResult<CommerceProductRecord | null>> {
  const addr = parseAddress(query.productId)
  const decodedId = decodeURIComponent(query.productId)

  try {
    if (addr && addr.kind === EVENT_KINDS.PRODUCT) {
      const storefront = await getMerchantStorefront({
        merchantPubkey: addr.pubkey,
        limit: 200,
      })
      const record =
        storefront.data.find((item) => item.addressId === decodedId) ?? null
      return { data: record, meta: { ...storefront.meta, fetchedAt: now() } }
    }

    if (/^[0-9a-f]{64}$/i.test(decodedId)) {
      const records = await fetchPublicProductRecords({
        ids: [decodedId],
        limit: 1,
      })
      const record = records[0] ?? null
      if (record) {
        await cacheProductRecords([record])
      }
      return {
        data: record,
        meta: createMeta("product_detail", "public", PRODUCT_CAPABILITIES),
      }
    }
  } catch (error) {
    const cached = await getCachedProductRecords()
    const record =
      cached.find(
        (item) => item.product.id === decodedId || item.addressId === decodedId
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

  const cached = await getCachedProductRecords()
  const record =
    cached.find(
      (item) => item.product.id === decodedId || item.addressId === decodedId
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
    if (cached && now() - cached.cachedAt < PROFILE_CACHE_TTL_MS) {
      result[pubkey] = {
        pubkey: cached.pubkey,
        name: cached.name,
        displayName: cached.displayName,
        about: cached.about,
        picture: cached.picture,
        banner: cached.banner,
        nip05: cached.nip05,
        lud16: cached.lud16,
        website: cached.website,
      }
    } else {
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

  try {
    const ndk = await runRequireNdkConnected()
    const events = Array.from(
      await ndk.fetchEvents({
        kinds: [EVENT_KINDS.PROFILE],
        authors: missing,
        limit: Math.max(10, missing.length * 3),
      })
    ) as NDKEvent[]

    const latestByPubkey = new Map<string, NDKEvent>()
    for (const event of events) {
      const existing = latestByPubkey.get(event.pubkey)
      if (!existing || (event.created_at ?? 0) > (existing.created_at ?? 0)) {
        latestByPubkey.set(event.pubkey, event)
      }
    }

    const rowsToCache: Array<{
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
    }> = []

    for (const pubkey of missing) {
      const event = latestByPubkey.get(pubkey)
      const profile = event ? parseProfileEvent(event) : { pubkey }
      result[pubkey] = profile
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
        cachedAt: now(),
      })
    }

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

function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

async function tryUnwrap(event: NDKEvent, signer: NDKSigner) {
  try {
    return await raceTimeout(
      (async () => {
        try {
          return await giftUnwrap(event, undefined, signer, "nip44")
        } catch {
          // fall through to nip04
        }

        try {
          return await giftUnwrap(event, undefined, signer, "nip04")
        } catch {
          return null
        }
      })(),
      8_000,
      null
    )
  } catch {
    return null
  }
}

async function unwrapBatch(
  events: NDKEvent[],
  signer: NDKSigner,
  batchSize = 5
): Promise<Array<Awaited<ReturnType<typeof tryUnwrap>>>> {
  const results: Array<Awaited<ReturnType<typeof tryUnwrap>>> = []

  for (let index = 0; index < events.length; index += batchSize) {
    const batch = events.slice(index, index + batchSize)
    const batchResults = await Promise.all(
      batch.map((event) => tryUnwrap(event, signer))
    )
    results.push(...batchResults)
  }

  return results
}

const knownWrapIds = new Set<string>()

async function fetchParsedOrderMessages(
  principalPubkey: string,
  limit: number
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
        return { messages, source: "local_cache", stale: true }
      }
      throw new Error("Connect your Nostr signer to view order conversations.")
    }

    const filter: NDKFilter = {
      kinds: [EVENT_KINDS.GIFT_WRAP],
      "#p": [principalPubkey],
      limit,
    }

    const wrapped = await runFetchEventsFanout(filter, {
      relayUrls: commerceReadRelayUrls(),
      connectTimeoutMs: 4_000,
      fetchTimeoutMs: 12_000,
    })

    const newWrapped = wrapped.filter((event) => !knownWrapIds.has(event.id))
    const unwrapped = await unwrapBatch(newWrapped, signer)

    const newRows: Array<{
      id: string
      orderId: string
      type: string
      senderPubkey: string
      recipientPubkey: string
      createdAt: number
      rawContent: string
      cachedAt: number
    }> = []

    for (const rumor of unwrapped) {
      if (!rumor || rumor.kind !== EVENT_KINDS.ORDER) continue
      try {
        const parsed = parseOrderMessageRumorEvent(rumor)
        if (!cachedById.has(parsed.id)) {
          newRows.push({
            id: parsed.id,
            orderId: parsed.orderId,
            type: parsed.type,
            senderPubkey: parsed.senderPubkey,
            recipientPubkey: parsed.recipientPubkey,
            createdAt: parsed.createdAt,
            rawContent: JSON.stringify(parsed),
            cachedAt: now(),
          })
        }
        cachedById.set(parsed.id, parsed)
      } catch {
        // ignore malformed order messages
      }
    }

    for (const event of wrapped) knownWrapIds.add(event.id)

    if (newRows.length > 0) {
      await storeCachedOrderMessages(newRows)
    }

    const messages = Array.from(cachedById.values()).sort(
      (a, b) => a.createdAt - b.createdAt
    )
    return { messages, source: "commerce", stale: false }
  } catch (error) {
    if (cachedById.size > 0) {
      const messages = Array.from(cachedById.values()).sort(
        (a, b) => a.createdAt - b.createdAt
      )
      return { messages, source: "local_cache", stale: true }
    }
    throw error
  }
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

    const latestStatus = [...bucket]
      .reverse()
      .find((message) => message.type === "status_update")
    const otherParticipants = Array.from(
      new Set(
        bucket
          .map((message) =>
            message.senderPubkey === buyerPubkey
              ? message.recipientPubkey
              : message.senderPubkey
          )
          .filter(Boolean)
      )
    )
    const merchantPubkey = otherParticipants[0] ?? ""
    const summary = extractOrderSummary(bucket)

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

    const latestStatus = [...bucket]
      .reverse()
      .find((message) => message.type === "status_update")
    const otherParticipants = Array.from(
      new Set(
        bucket
          .map((message) =>
            message.senderPubkey === merchantPubkey
              ? message.recipientPubkey
              : message.senderPubkey
          )
          .filter(Boolean)
      )
    )
    const buyerPubkey = otherParticipants[0] ?? ""
    const summary = extractOrderSummary(bucket)

    conversations.push({
      id: orderId,
      orderId,
      buyerPubkey,
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
    })
  }

  conversations.sort((a, b) => b.latestAt - a.latestAt)
  return conversations
}

export async function getBuyerConversationList(
  query: ConversationListQuery
): Promise<CommerceResult<BuyerConversationSummary[]>> {
  const result = await fetchParsedOrderMessages(
    query.principalPubkey,
    query.limit ?? 200
  )
  return {
    data: buildBuyerConversationSummaries(
      result.messages,
      query.principalPubkey
    ),
    meta: createMeta(
      "protected_conversation_list",
      result.source,
      CONVERSATION_CAPABILITIES,
      { stale: result.stale }
    ),
  }
}

export async function getMerchantConversationList(
  query: ConversationListQuery
): Promise<CommerceResult<MerchantConversationSummary[]>> {
  const result = await fetchParsedOrderMessages(
    query.principalPubkey,
    query.limit ?? 200
  )
  return {
    data: buildMerchantConversationSummaries(
      result.messages,
      query.principalPubkey
    ),
    meta: createMeta(
      "protected_conversation_list",
      result.source,
      CONVERSATION_CAPABILITIES,
      { stale: result.stale }
    ),
  }
}

export async function getConversationDetail(
  query: ConversationDetailQuery
): Promise<CommerceResult<ConversationDetail | null>> {
  const result = await fetchParsedOrderMessages(query.principalPubkey, 200)
  const messages = result.messages.filter(
    (message) => message.orderId === query.orderId
  )
  return {
    data: messages.length > 0 ? { orderId: query.orderId, messages } : null,
    meta: createMeta(
      "conversation_detail",
      result.source,
      CONVERSATION_CAPABILITIES,
      { stale: result.stale }
    ),
  }
}
