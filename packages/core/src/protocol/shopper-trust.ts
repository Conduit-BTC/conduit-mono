/**
 * Cache-first public evidence for the shopper on a selected incoming order.
 *
 * The module intentionally returns observations, never a score or verdict.
 * Relay results and cached projections are bounded evidence, not global truth.
 */

import type { NDKFilter } from "@nostr-dev-kit/ndk"
import {
  db,
  pruneShopperTrustSnapshots,
  type CachedShopperTrustSignal,
  type CachedShopperTrustSnapshot,
} from "../db"
import { getFollowListPubkeySet } from "./follows"
import { EVENT_KINDS } from "./kinds"
import {
  decodeLightningInvoiceAmount,
  parseZapReceiptDescription,
  validateZapInvoiceDescriptionBinding,
} from "./lightning"
import {
  fetchEventsFanoutDetailed,
  type FetchEventsFanoutOptions,
  type FetchEventsFanoutResult,
  verifySignedPublicNostrEvents,
} from "./ndk"
import { getRelayLists } from "./relay-list"
import { planRelayReads } from "./relay-planner"
import { tryNormalizeRelayUrl } from "./relay-settings"
import type { SignedPublicNostrEvent } from "./signed-event"

const HEX_PUBKEY = /^[0-9a-f]{64}$/i
const CONTACT_LIST_LIMIT = 10
const FOLLOWER_CANDIDATE_LIMIT = 500
const FOLLOWER_CANDIDATE_CAP = 250
const ACCOUNT_ACTIVITY_LIMIT = 500
const ZAP_RECEIPT_LIMIT = 500
const REPORT_LIMIT = 500
const REPORTER_CAP = 250
const SHOPPER_TRUST_RELAY_CAP = 6
const AUTHOR_HINT_RELAY_CAP = 4
const AUTHOR_READ_RELAY_CAP = 8
const FUTURE_EVENT_TOLERANCE_SECONDS = 5 * 60
const READ_TIMEOUT_MS = 5_000
const FALLBACK_EVENT_VERIFICATION_CAP = 512
const EMBEDDED_ZAP_REQUEST_VERIFICATION_CAP = 128
const MAX_ZAP_EVENT_TAGS = 128
const MAX_ZAP_DESCRIPTION_CHARS = 64 * 1024
const MAX_ZAP_INVOICE_CHARS = 16 * 1024
const ZAP_PARSE_YIELD_INTERVAL = 8

const ACCOUNT_ACTIVITY_KINDS = [
  EVENT_KINDS.PROFILE,
  1,
  EVENT_KINDS.CONTACT_LIST,
  6,
  7,
  EVENT_KINDS.ZAP_REQUEST,
  30_023,
] as const

export const SHOPPER_TRUST_CACHE_FRESH_MS = 5 * 60_000
export const SHOPPER_TRUST_DEGRADED_CACHE_RETRY_MS = 30_000

export const NIP56_REPORT_TYPES = [
  "nudity",
  "malware",
  "profanity",
  "illegal",
  "spam",
  "impersonation",
  "other",
] as const

export type Nip56ReportType = (typeof NIP56_REPORT_TYPES)[number]
export type ShopperTrustSignalState =
  "available" | "partial" | "stale" | "unavailable"
export type ShopperTrustSignalSource = "cache" | "network" | "none"

export interface ShopperTrustCoverage {
  attemptedRelays: number
  responsiveRelays: number
  transportComplete: boolean
  completeForPlan: boolean
  truncated: boolean
}

export interface ShopperTrustSignal<T> {
  state: ShopperTrustSignalState
  value: T | null
  source: ShopperTrustSignalSource
  observedAt?: number
  coverage: ShopperTrustCoverage
}

export interface ShopperTrustEvidence {
  merchantPubkey: string
  shopperPubkey: string
  oldestEvent: ShopperTrustSignal<{ timestamp: number | null }>
  followersObserved: ShopperTrustSignal<{ count: number }>
  followsInCommon: ShopperTrustSignal<{ count: number }>
  zapsSent: ShopperTrustSignal<{ count: number }>
  zapsReceived: ShopperTrustSignal<{ count: number }>
  reportsFromNetwork: ShopperTrustSignal<{
    count: number
    reporterCount: number
    byType: Partial<Record<Nip56ReportType, number>>
  }>
  source: "cache" | "network" | "mixed" | "none"
  degraded: boolean
  refreshedAt?: number
}

export interface ShopperTrustEvidenceCache {
  get: (id: string) => Promise<CachedShopperTrustSnapshot | undefined>
  put: (row: CachedShopperTrustSnapshot) => Promise<void>
}

export type ShopperTrustFetchEvents = (
  filter: NDKFilter,
  options?: FetchEventsFanoutOptions
) => Promise<FetchEventsFanoutResult>

export type ShopperTrustResolveRelayLists = typeof getRelayLists

export interface GetShopperTrustEvidenceOptions {
  cache?: ShopperTrustEvidenceCache | null
  fetchEvents?: ShopperTrustFetchEvents
  now?: () => number
  onProgress?: (snapshot: ShopperTrustEvidence) => void
  relayUrls?: string[]
  resolveRelayLists?: ShopperTrustResolveRelayLists
  /** Override the public fallback portion of the relay plan (test seam). */
  baseRelayUrls?: readonly string[]
  /** Cancel obsolete reads when the selected order changes. */
  signal?: AbortSignal
  /** Bypass aggregate freshness for an explicit user or relay-scope refresh. */
  forceRefresh?: boolean
}

type ReadResult = {
  events: SignedPublicNostrEvent[]
  coverage: ShopperTrustCoverage
}

type ZapParties = {
  requestId: string
  senderPubkey: string
  recipientPubkey: string
}

type ZapCandidate = ZapParties & {
  request: SignedPublicNostrEvent
}

type ZapCandidateParseResult = {
  candidate: ZapCandidate | null
  truncated: boolean
}

type ZapObservation = {
  count: number
  truncated: boolean
}

function normalizePubkey(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return HEX_PUBKEY.test(normalized) ? normalized : null
}

function snapshotId(merchantPubkey: string, shopperPubkey: string): string {
  return `v2:${merchantPubkey}:${shopperPubkey}`
}

function interleaveRelayGroups(
  groups: readonly (readonly string[])[],
  limit: number
): string[] {
  const selected: string[] = []
  const seen = new Set<string>()
  const maxLength = Math.max(0, ...groups.map((group) => group.length))

  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      const relayUrl = group[index]
      if (!relayUrl || seen.has(relayUrl)) continue
      seen.add(relayUrl)
      selected.push(relayUrl)
      if (selected.length >= limit) return selected
    }
  }

  return selected
}

function defaultCache(): ShopperTrustEvidenceCache | null {
  if (typeof window === "undefined") return null

  return {
    get: (id) => db.shopperTrustSnapshots.get(id),
    put: async (row) => {
      await db.shopperTrustSnapshots.put(row)
      await pruneShopperTrustSnapshots(row.cachedAt)
    },
  }
}

function emptyCoverage(attemptedRelays = 0): ShopperTrustCoverage {
  return {
    attemptedRelays,
    responsiveRelays: 0,
    transportComplete: false,
    completeForPlan: false,
    truncated: false,
  }
}

function mergeCoverage(
  coverages: readonly ShopperTrustCoverage[],
  truncated = false
): ShopperTrustCoverage {
  if (coverages.length === 0) return emptyCoverage()

  return {
    attemptedRelays: Math.max(
      ...coverages.map((coverage) => coverage.attemptedRelays)
    ),
    responsiveRelays: Math.min(
      ...coverages.map((coverage) => coverage.responsiveRelays)
    ),
    transportComplete: coverages.every(
      (coverage) => coverage.transportComplete
    ),
    completeForPlan: coverages.every((coverage) => coverage.completeForPlan),
    truncated: truncated || coverages.some((coverage) => coverage.truncated),
  }
}

function getEventCandidate(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "rawEvent" in value &&
    typeof (value as { rawEvent?: unknown }).rawEvent === "function"
  ) {
    try {
      return (value as { rawEvent: () => unknown }).rawEvent()
    } catch {
      return null
    }
  }
  return value
}

function toSignedEventCandidate(value: unknown): SignedPublicNostrEvent | null {
  const candidate = getEventCandidate(value)
  if (!candidate || typeof candidate !== "object") return null

  const event = candidate as Partial<SignedPublicNostrEvent>
  if (
    typeof event.id !== "string" ||
    typeof event.pubkey !== "string" ||
    typeof event.created_at !== "number" ||
    typeof event.kind !== "number" ||
    typeof event.content !== "string" ||
    typeof event.sig !== "string" ||
    !Array.isArray(event.tags) ||
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((entry) => typeof entry === "string")
    )
  ) {
    return null
  }

  return event as SignedPublicNostrEvent
}

function dedupeEventCandidates(
  events: readonly unknown[]
): SignedPublicNostrEvent[] {
  const byId = new Map<string, SignedPublicNostrEvent>()
  for (const event of events) {
    const candidate = toSignedEventCandidate(event)
    if (candidate) byId.set(candidate.id, candidate)
  }
  return [...byId.values()]
}

function coverageFromRead(
  result: FetchEventsFanoutResult,
  plannedRelayUrls: readonly string[],
  truncated = false
): ShopperTrustCoverage {
  const plannedRelays = new Set(plannedRelayUrls)
  const statusByRelay = new Map(
    result.relays
      .filter(({ relayUrl }) => plannedRelays.has(relayUrl))
      .map((relay) => [relay.relayUrl, relay] as const)
  )
  const attemptedRelays = plannedRelays.size
  const responsiveRelays = [...statusByRelay.values()].filter(
    ({ status }) => status !== "failed"
  ).length
  const completeForPlan =
    attemptedRelays > 0 &&
    statusByRelay.size === attemptedRelays &&
    responsiveRelays === attemptedRelays &&
    [...statusByRelay.values()].every(({ status }) => status === "success")

  return {
    attemptedRelays,
    responsiveRelays,
    transportComplete: completeForPlan,
    completeForPlan,
    truncated,
  }
}

function compareEventsNewestFirst(
  left: SignedPublicNostrEvent,
  right: SignedPublicNostrEvent
): number {
  if (left.created_at !== right.created_at) {
    return right.created_at - left.created_at
  }
  return left.id.localeCompare(right.id)
}

function isWithinFutureTolerance(
  event: SignedPublicNostrEvent,
  nowSeconds: number
): boolean {
  return event.created_at <= nowSeconds + FUTURE_EVENT_TOLERANCE_SECONDS
}

async function safeRead(
  fetchEvents: ShopperTrustFetchEvents,
  filter: NDKFilter,
  relayUrls: string[],
  truncated = false,
  signal?: AbortSignal
): Promise<ReadResult> {
  try {
    throwIfTrustAborted(signal)
    const result = await fetchEvents(filter, {
      relayUrls,
      connectTimeoutMs: 2_000,
      fetchTimeoutMs: READ_TIMEOUT_MS,
      skipHealthFilter: true,
      signal,
    })
    throwIfTrustAborted(signal)
    const usesVerifiedFanout =
      fetchEvents === fetchEventsFanoutDetailed &&
      result.eventsVerified === true
    const boundedResultEvents = usesVerifiedFanout
      ? result.events
      : result.events.slice(0, FALLBACK_EVENT_VERIFICATION_CAP)
    const candidates = dedupeEventCandidates(boundedResultEvents)
    const verification = usesVerifiedFanout
      ? { events: candidates, truncated: false }
      : await verifySignedPublicNostrEvents(candidates, {
          signal,
          maxEvents: FALLBACK_EVENT_VERIFICATION_CAP,
        })
    const verifiedEvents = dedupeEventCandidates(verification.events).sort(
      compareEventsNewestFirst
    )
    const limit =
      typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : null
    const reachedLimit =
      limit !== null &&
      (verifiedEvents.length >= limit ||
        result.relays.some(({ eventCount }) => eventCount >= limit))

    return {
      events: limit === null ? verifiedEvents : verifiedEvents.slice(0, limit),
      coverage: coverageFromRead(
        result,
        relayUrls,
        truncated ||
          reachedLimit ||
          verification.truncated ||
          result.events.length > boundedResultEvents.length
      ),
    }
  } catch (error) {
    if (signal?.aborted || isTrustAbortError(error)) throw error
    return {
      events: [],
      coverage: emptyCoverage(relayUrls.length),
    }
  }
}

function trustAbortError(): Error {
  const error = new Error("The operation was aborted.")
  error.name = "AbortError"
  return error
}

function throwIfTrustAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw trustAbortError()
}

function isTrustAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  )
}

function networkSignal<T>(
  value: T,
  coverage: ShopperTrustCoverage,
  observedAt: number
): ShopperTrustSignal<T> {
  if (coverage.responsiveRelays === 0) {
    return {
      state: "unavailable",
      value: null,
      source: "none",
      coverage,
    }
  }

  return {
    state:
      coverage.completeForPlan && !coverage.truncated ? "available" : "partial",
    value,
    source: "network",
    observedAt,
    coverage,
  }
}

function unavailableSignal<T>(
  coverage: ShopperTrustCoverage
): ShopperTrustSignal<T> {
  return {
    state: "unavailable",
    value: null,
    source: "none",
    coverage,
  }
}

function cacheSignal<T>(
  signal: CachedShopperTrustSignal<T>,
  stale: boolean
): ShopperTrustSignal<T> {
  const state = stale && signal.value !== null ? "stale" : signal.state

  return {
    ...signal,
    state,
    source: signal.value === null ? "none" : "cache",
  }
}

function preferNetwork<T>(
  network: ShopperTrustSignal<T>,
  cached: ShopperTrustSignal<T> | undefined
): ShopperTrustSignal<T> {
  if (network.state !== "unavailable" || !cached?.value) return network
  return {
    ...cached,
    state: "stale",
    source: "cache",
  }
}

function preferBoundedCount<T>(
  network: ShopperTrustSignal<T>,
  cached: ShopperTrustSignal<T> | undefined,
  count: (value: T) => number
): ShopperTrustSignal<T> {
  const preferred = preferNetwork(network, cached)
  if (
    network.state === "unavailable" ||
    !network.value ||
    !cached?.value ||
    count(network.value) >= count(cached.value)
  ) {
    return preferred
  }

  // A bounded or partially responsive relay scan cannot prove that stronger
  // previously observed evidence disappeared. Retain the prior aggregate and
  // mark it stale while carrying the current scan's coverage diagnostics.
  return {
    ...cached,
    state: "stale",
    source: "cache",
    coverage: network.coverage,
  }
}

function preferOldestEventTimestamp(
  network: ShopperTrustEvidence["oldestEvent"],
  cached: ShopperTrustEvidence["oldestEvent"] | undefined
): ShopperTrustEvidence["oldestEvent"] {
  const preferred = preferNetwork(network, cached)
  const cachedTimestamp = cached?.value?.timestamp
  if (
    network.state === "unavailable" ||
    !cached ||
    cachedTimestamp === null ||
    cachedTimestamp === undefined
  ) {
    return preferred
  }

  const networkTimestamp = network.value?.timestamp
  if (
    typeof networkTimestamp === "number" &&
    networkTimestamp <= cachedTimestamp
  ) {
    return network
  }

  // Preserve the oldest valid signed-event timestamp already observed when a
  // narrower later scan omits that event. This remains an author-provided event
  // date, never evidence of account creation or age.
  return {
    ...network,
    value: { timestamp: cachedTimestamp },
    source: "cache",
    observedAt: cached.observedAt,
  }
}

function snapshotSource(
  signals: readonly ShopperTrustSignal<unknown>[]
): ShopperTrustEvidence["source"] {
  const sources = new Set(
    signals.map(({ source }) => source).filter((source) => source !== "none")
  )
  if (sources.size === 0) return "none"
  if (sources.size > 1) return "mixed"
  return sources.has("cache") ? "cache" : "network"
}

function buildEvidence(input: {
  merchantPubkey: string
  shopperPubkey: string
  oldestEvent: ShopperTrustEvidence["oldestEvent"]
  followersObserved: ShopperTrustEvidence["followersObserved"]
  followsInCommon: ShopperTrustEvidence["followsInCommon"]
  zapsSent: ShopperTrustEvidence["zapsSent"]
  zapsReceived: ShopperTrustEvidence["zapsReceived"]
  reportsFromNetwork: ShopperTrustEvidence["reportsFromNetwork"]
  refreshedAt?: number
}): ShopperTrustEvidence {
  const signals: ShopperTrustSignal<unknown>[] = [
    input.oldestEvent,
    input.followersObserved,
    input.followsInCommon,
    input.zapsSent,
    input.zapsReceived,
    input.reportsFromNetwork,
  ]

  return {
    ...input,
    source: snapshotSource(signals),
    degraded: signals.some(({ state }) => state !== "available"),
  }
}

function rowToEvidence(
  row: CachedShopperTrustSnapshot,
  stale: boolean
): ShopperTrustEvidence {
  return buildEvidence({
    merchantPubkey: row.merchantPubkey,
    shopperPubkey: row.shopperPubkey,
    oldestEvent: cacheSignal(row.oldestEvent, stale),
    followersObserved: cacheSignal(row.followersObserved, stale),
    followsInCommon: cacheSignal(row.followsInCommon, stale),
    zapsSent: cacheSignal(row.zapsSent, stale),
    zapsReceived: cacheSignal(row.zapsReceived, stale),
    reportsFromNetwork: cacheSignal(
      {
        ...row.reportsFromNetwork,
        value: row.reportsFromNetwork.value
          ? { ...row.reportsFromNetwork.value, byType: {} }
          : null,
      },
      stale
    ),
    refreshedAt: row.cachedAt,
  })
}

function signalToCache<T>(
  signal: ShopperTrustSignal<T>
): CachedShopperTrustSignal<T> {
  return {
    state: signal.state,
    value: signal.value,
    observedAt: signal.observedAt,
    coverage: signal.coverage,
  }
}

function evidenceToRow(
  evidence: ShopperTrustEvidence,
  cachedAt: number
): CachedShopperTrustSnapshot {
  return {
    id: snapshotId(evidence.merchantPubkey, evidence.shopperPubkey),
    merchantPubkey: evidence.merchantPubkey,
    shopperPubkey: evidence.shopperPubkey,
    oldestEvent: signalToCache(evidence.oldestEvent),
    followersObserved: signalToCache(evidence.followersObserved),
    followsInCommon: signalToCache(evidence.followsInCommon),
    zapsSent: signalToCache(evidence.zapsSent),
    zapsReceived: signalToCache(evidence.zapsReceived),
    reportsFromNetwork: {
      ...signalToCache(evidence.reportsFromNetwork),
      value: evidence.reportsFromNetwork.value
        ? {
            count: evidence.reportsFromNetwork.value.count,
            reporterCount: evidence.reportsFromNetwork.value.reporterCount,
          }
        : null,
    },
    degraded: evidence.degraded,
    cachedAt,
  }
}

function eventIsNewer(
  candidate: SignedPublicNostrEvent,
  current: SignedPublicNostrEvent
): boolean {
  return compareEventsNewestFirst(candidate, current) < 0
}

function latestEventsByAuthor(
  events: readonly SignedPublicNostrEvent[]
): Map<string, SignedPublicNostrEvent> {
  const latest = new Map<string, SignedPublicNostrEvent>()
  for (const event of events) {
    const current = latest.get(event.pubkey)
    if (!current || eventIsNewer(event, current)) {
      latest.set(event.pubkey, event)
    }
  }
  return latest
}

function eventTagsPubkey(
  event: SignedPublicNostrEvent,
  pubkey: string
): boolean {
  return getFollowListPubkeySet(event).has(pubkey)
}

function isValidEventCoordinate(value: string): boolean {
  const match = /^(\d+):([0-9a-f]{64}):(.*)$/.exec(value)
  if (!match) return false
  const kind = Number(match[1])
  return (
    Number.isSafeInteger(kind) &&
    (kind === 0 ||
      kind === 3 ||
      (kind >= 10_000 && kind < 20_000) ||
      (kind >= 30_000 && kind < 40_000))
  )
}

function parseZapCandidate(
  event: SignedPublicNostrEvent,
  nowSeconds: number
): ZapCandidateParseResult {
  if (
    event.kind !== EVENT_KINDS.ZAP_RECEIPT ||
    event.created_at > nowSeconds + FUTURE_EVENT_TOLERANCE_SECONDS
  ) {
    return { candidate: null, truncated: false }
  }
  if (event.tags.length > MAX_ZAP_EVENT_TAGS) {
    return { candidate: null, truncated: true }
  }

  const recipientTags = event.tags.filter(([name]) => name === "p")
  const senderTags = event.tags.filter(([name]) => name === "P")
  const eventReferenceTags = event.tags.filter(([name]) => name === "e")
  const coordinateTags = event.tags.filter(([name]) => name === "a")
  const descriptions = event.tags.filter(([name]) => name === "description")
  const invoices = event.tags.filter(([name]) => name === "bolt11")
  if (
    recipientTags.length !== 1 ||
    senderTags.length > 1 ||
    eventReferenceTags.length > 1 ||
    coordinateTags.length > 1 ||
    (eventReferenceTags.length === 1 &&
      !/^[0-9a-f]{64}$/.test(eventReferenceTags[0]?.[1] ?? "")) ||
    (coordinateTags.length === 1 &&
      !isValidEventCoordinate(coordinateTags[0]?.[1] ?? "")) ||
    descriptions.length !== 1 ||
    invoices.length !== 1
  ) {
    return { candidate: null, truncated: false }
  }

  const recipientPubkey = normalizePubkey(recipientTags[0]?.[1] ?? "")
  const description = descriptions[0]?.[1]
  const invoice = invoices[0]?.[1]
  if (!recipientPubkey || !description || !invoice) {
    return { candidate: null, truncated: false }
  }
  if (
    description.length > MAX_ZAP_DESCRIPTION_CHARS ||
    invoice.length > MAX_ZAP_INVOICE_CHARS
  ) {
    return { candidate: null, truncated: true }
  }

  const request = toSignedEventCandidate(
    parseZapReceiptDescription(description)
  )
  if (
    !request ||
    request.kind !== EVENT_KINDS.ZAP_REQUEST ||
    event.created_at < request.created_at - 5
  ) {
    return { candidate: null, truncated: false }
  }

  const requestRecipientTags = request.tags.filter(([name]) => name === "p")
  const requestRelayTags = request.tags.filter(([name]) => name === "relays")
  const requestRecipientPubkey = normalizePubkey(
    requestRecipientTags[0]?.[1] ?? ""
  )
  const senderPubkey = normalizePubkey(request.pubkey)
  const receiptSenderPubkey =
    senderTags.length === 1 ? normalizePubkey(senderTags[0]?.[1] ?? "") : null
  if (
    requestRecipientTags.length !== 1 ||
    requestRelayTags.length !== 1 ||
    !requestRelayTags[0]
      ?.slice(1)
      .some((relayUrl) => tryNormalizeRelayUrl(relayUrl).ok) ||
    !requestRecipientPubkey ||
    requestRecipientPubkey !== recipientPubkey ||
    !senderPubkey ||
    (senderTags.length === 1 && receiptSenderPubkey !== senderPubkey) ||
    !validateZapInvoiceDescriptionBinding({
      invoice,
      zapRequestJson: description,
    }).ok
  ) {
    return { candidate: null, truncated: false }
  }

  const requestAmountTags = request.tags.filter(([name]) => name === "amount")
  if (requestAmountTags.length > 1) {
    return { candidate: null, truncated: false }
  }
  if (requestAmountTags.length === 1) {
    const rawAmount = requestAmountTags[0]?.[1] ?? ""
    const requestAmount = /^\d+$/.test(rawAmount)
      ? Number(rawAmount)
      : Number.NaN
    const invoiceAmount = decodeLightningInvoiceAmount(invoice).msats
    if (
      !Number.isSafeInteger(requestAmount) ||
      requestAmount <= 0 ||
      invoiceAmount !== requestAmount
    ) {
      return { candidate: null, truncated: false }
    }
  }

  return {
    candidate: {
      requestId: request.id,
      senderPubkey,
      recipientPubkey,
      request,
    },
    truncated: false,
  }
}

async function countZaps(
  events: readonly SignedPublicNostrEvent[],
  expected: { direction: "sent" | "received"; shopperPubkey: string },
  nowSeconds: number,
  signal?: AbortSignal
): Promise<ZapObservation> {
  const boundedEvents = events.slice(0, EMBEDDED_ZAP_REQUEST_VERIFICATION_CAP)
  const candidates: ZapCandidate[] = []
  let parseTruncated = events.length > boundedEvents.length
  for (let index = 0; index < boundedEvents.length; index += 1) {
    throwIfTrustAborted(signal)
    const parsed = parseZapCandidate(boundedEvents[index], nowSeconds)
    if (parsed.candidate) candidates.push(parsed.candidate)
    if (parsed.truncated) parseTruncated = true
    if (
      index + 1 < boundedEvents.length &&
      (index + 1) % ZAP_PARSE_YIELD_INTERVAL === 0
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  throwIfTrustAborted(signal)
  const uniqueRequests = [
    ...new Map(
      candidates.map((candidate) => [candidate.request.id, candidate.request])
    ).values(),
  ]
  const verification = await verifySignedPublicNostrEvents(uniqueRequests, {
    signal,
    maxEvents: EMBEDDED_ZAP_REQUEST_VERIFICATION_CAP,
  })
  const verifiedRequestIds = new Set(
    verification.events.map((event) => event.id)
  )
  const requestIds = new Set<string>()
  for (const parties of candidates) {
    if (!verifiedRequestIds.has(parties.requestId)) continue
    if (
      (expected.direction === "sent" &&
        parties.senderPubkey === expected.shopperPubkey) ||
      (expected.direction === "received" &&
        parties.recipientPubkey === expected.shopperPubkey)
    ) {
      requestIds.add(parties.requestId)
    }
  }
  return {
    count: requestIds.size,
    truncated: parseTruncated || verification.truncated,
  }
}

function reportType(
  event: SignedPublicNostrEvent,
  shopperPubkey: string
): Nip56ReportType | null {
  const target = event.tags.find(
    ([name, pubkey]) => name === "p" && pubkey === shopperPubkey
  )
  const rawType = target?.[2]?.trim().toLowerCase()
  return NIP56_REPORT_TYPES.includes(
    rawType as (typeof NIP56_REPORT_TYPES)[number]
  )
    ? (rawType as (typeof NIP56_REPORT_TYPES)[number])
    : null
}

function reportWasDeleted(
  report: SignedPublicNostrEvent,
  deletions: readonly SignedPublicNostrEvent[]
): boolean {
  return deletions.some(
    (deletion) =>
      deletion.kind === EVENT_KINDS.DELETION &&
      deletion.pubkey === report.pubkey &&
      deletion.tags.some(
        ([name, eventId]) => name === "e" && eventId === report.id
      )
  )
}

async function resolveRelayUrls(
  merchantPubkey: string,
  shopperPubkey: string,
  resolveRelayLists: ShopperTrustResolveRelayLists,
  baseRelayUrlsOverride?: readonly string[],
  signal?: AbortSignal
): Promise<{ relayUrls: string[]; completeRelayHints: boolean }> {
  let relayLists = new Map()
  let lookupFailed = false
  try {
    relayLists = await resolveRelayLists([merchantPubkey, shopperPubkey], {
      allowInsecureRelayUrlsForPubkey: merchantPubkey,
      signal,
    })
  } catch (error) {
    if (signal?.aborted || isTrustAbortError(error)) throw error
    lookupFailed = true
    // Cached NIP-65 hints improve coverage but are not required to plan.
  }

  const baseRelayUrls =
    baseRelayUrlsOverride ??
    planRelayReads({
      intent: "shopper_trust",
      authenticatedPubkey: merchantPubkey,
      maxRelays: SHOPPER_TRUST_RELAY_CAP,
    }).relayUrls
  const merchantRelays = relayLists.get(merchantPubkey)
  const shopperRelays = relayLists.get(shopperPubkey)

  // Keep the cap fair across the shopper outbox/inbox, merchant outbox, and
  // public fallback. A long merchant relay list must not crowd every shopper
  // or public relay out of the plan.
  return {
    relayUrls: interleaveRelayGroups(
      [
        shopperRelays?.writeRelayUrls ?? [],
        shopperRelays?.readRelayUrls ?? [],
        merchantRelays?.writeRelayUrls ?? [],
        baseRelayUrls,
      ],
      SHOPPER_TRUST_RELAY_CAP
    ),
    completeRelayHints:
      !lookupFailed &&
      ![merchantRelays, shopperRelays].some(
        (list) => list?.lookupState === "stale-cache"
      ),
  }
}

async function resolveAuthorReadRelayPlan(
  authors: readonly string[],
  fallbackRelayUrls: readonly string[],
  resolveRelayLists: ShopperTrustResolveRelayLists,
  signal?: AbortSignal
): Promise<{ relayUrls: string[]; completeAuthorHints: boolean }> {
  if (authors.length === 0) {
    return {
      relayUrls: [...fallbackRelayUrls],
      completeAuthorHints: true,
    }
  }

  let relayLists = new Map<
    string,
    { writeRelayUrls: string[]; lookupState?: string }
  >()
  let lookupFailed = false
  try {
    relayLists = await resolveRelayLists(authors, {
      relayUrls: fallbackRelayUrls,
      signal,
    })
  } catch (error) {
    if (signal?.aborted || isTrustAbortError(error)) throw error
    lookupFailed = true
    // Missing NIP-65 data degrades the observation to the bounded fallback.
  }

  const authorHintGroups = authors.map(
    (author) => relayLists.get(author)?.writeRelayUrls ?? []
  )
  const selectedHints = interleaveRelayGroups(
    authorHintGroups,
    AUTHOR_HINT_RELAY_CAP
  )
  const selectedHintSet = new Set(selectedHints)
  const completeAuthorHints =
    !lookupFailed &&
    authors.every((author, index) => {
      const list = relayLists.get(author)
      const relayUrls = authorHintGroups[index] ?? []
      return (
        list?.lookupState !== "stale-cache" &&
        relayUrls.length > 0 &&
        relayUrls.some((relayUrl) => selectedHintSet.has(relayUrl))
      )
    })

  return {
    relayUrls: interleaveRelayGroups(
      [selectedHints, fallbackRelayUrls],
      AUTHOR_READ_RELAY_CAP
    ),
    completeAuthorHints,
  }
}

async function loadCached(
  cache: ShopperTrustEvidenceCache | null,
  id: string
): Promise<CachedShopperTrustSnapshot | undefined> {
  try {
    return await cache?.get(id)
  } catch {
    return undefined
  }
}

async function persistCached(
  cache: ShopperTrustEvidenceCache | null,
  row: CachedShopperTrustSnapshot
): Promise<void> {
  try {
    await cache?.put(row)
  } catch {
    // Public evidence cache is a performance hint, never a source of truth.
  }
}

function cachedSnapshotNeedsShortRetry(
  row: CachedShopperTrustSnapshot
): boolean {
  const signals = [
    row.oldestEvent,
    row.followersObserved,
    row.followsInCommon,
    row.zapsSent,
    row.zapsReceived,
    row.reportsFromNetwork,
  ]

  return signals.some(
    (signal) =>
      signal.state === "partial" ||
      signal.state === "unavailable" ||
      signal.state === "stale" ||
      signal.coverage.truncated ||
      !(signal.coverage.transportComplete ?? signal.coverage.completeForPlan)
  )
}

export async function getShopperTrustEvidence(
  input: {
    merchantPubkey: string
    shopperPubkey: string
  },
  options: GetShopperTrustEvidenceOptions = {}
): Promise<ShopperTrustEvidence> {
  const signal = options.signal
  throwIfTrustAborted(signal)
  const merchantPubkey = normalizePubkey(input.merchantPubkey)
  const shopperPubkey = normalizePubkey(input.shopperPubkey)
  if (!merchantPubkey || !shopperPubkey) {
    throw new Error("Shopper trust evidence requires valid public keys.")
  }

  const now = options.now?.() ?? Date.now()
  const nowSeconds = Math.floor(now / 1_000)
  const id = snapshotId(merchantPubkey, shopperPubkey)
  const cache = options.cache === undefined ? defaultCache() : options.cache
  const cachedRow = await loadCached(cache, id)
  throwIfTrustAborted(signal)
  const cacheTtl =
    cachedRow && cachedSnapshotNeedsShortRetry(cachedRow)
      ? SHOPPER_TRUST_DEGRADED_CACHE_RETRY_MS
      : SHOPPER_TRUST_CACHE_FRESH_MS
  const cacheIsFresh = !!cachedRow && now - cachedRow.cachedAt <= cacheTtl
  const cachedEvidence = cachedRow
    ? rowToEvidence(cachedRow, !cacheIsFresh)
    : undefined

  if (cachedEvidence) {
    throwIfTrustAborted(signal)
    options.onProgress?.(cachedEvidence)
  }
  if (cacheIsFresh && cachedEvidence && !options.forceRefresh) {
    return cachedEvidence
  }

  const resolveRelayLists = options.resolveRelayLists ?? getRelayLists
  const initialRelayPlan = options.relayUrls
    ? { relayUrls: options.relayUrls, completeRelayHints: true }
    : await resolveRelayUrls(
        merchantPubkey,
        shopperPubkey,
        resolveRelayLists,
        options.baseRelayUrls,
        signal
      )
  const { relayUrls } = initialRelayPlan
  throwIfTrustAborted(signal)
  const fetchEvents = options.fetchEvents ?? fetchEventsFanoutDetailed

  if (relayUrls.length === 0) {
    if (cachedEvidence) return cachedEvidence
    const coverage = emptyCoverage()
    return buildEvidence({
      merchantPubkey,
      shopperPubkey,
      oldestEvent: unavailableSignal(coverage),
      followersObserved: unavailableSignal(coverage),
      followsInCommon: unavailableSignal(coverage),
      zapsSent: unavailableSignal(coverage),
      zapsReceived: unavailableSignal(coverage),
      reportsFromNetwork: unavailableSignal(coverage),
    })
  }

  const [
    contactsRead,
    activityRead,
    followerCandidatesRead,
    zapsReceivedRead,
    zapsSentRead,
  ] = await Promise.all([
    safeRead(
      fetchEvents,
      {
        kinds: [EVENT_KINDS.CONTACT_LIST],
        authors: [merchantPubkey, shopperPubkey],
        limit: CONTACT_LIST_LIMIT,
      },
      relayUrls,
      !initialRelayPlan.completeRelayHints,
      signal
    ),
    safeRead(
      fetchEvents,
      {
        kinds: [...ACCOUNT_ACTIVITY_KINDS],
        authors: [shopperPubkey],
        limit: ACCOUNT_ACTIVITY_LIMIT,
      },
      relayUrls,
      !initialRelayPlan.completeRelayHints,
      signal
    ),
    safeRead(
      fetchEvents,
      {
        kinds: [EVENT_KINDS.CONTACT_LIST],
        "#p": [shopperPubkey],
        limit: FOLLOWER_CANDIDATE_LIMIT,
      },
      relayUrls,
      !initialRelayPlan.completeRelayHints,
      signal
    ),
    safeRead(
      fetchEvents,
      {
        kinds: [EVENT_KINDS.ZAP_RECEIPT],
        "#p": [shopperPubkey],
        limit: ZAP_RECEIPT_LIMIT,
      },
      relayUrls,
      !initialRelayPlan.completeRelayHints,
      signal
    ),
    safeRead(
      fetchEvents,
      {
        kinds: [EVENT_KINDS.ZAP_RECEIPT],
        "#P": [shopperPubkey],
        limit: ZAP_RECEIPT_LIMIT,
      },
      relayUrls,
      !initialRelayPlan.completeRelayHints,
      signal
    ),
  ])
  throwIfTrustAborted(signal)

  const contactEvents = contactsRead.events.filter(
    (event) =>
      event.kind === EVENT_KINDS.CONTACT_LIST &&
      (event.pubkey === merchantPubkey || event.pubkey === shopperPubkey) &&
      isWithinFutureTolerance(event, nowSeconds)
  )
  const latestContacts = latestEventsByAuthor(contactEvents)
  const merchantContacts = latestContacts.get(merchantPubkey)
  const shopperContacts = latestContacts.get(shopperPubkey)
  const merchantFollows = getFollowListPubkeySet(merchantContacts)
  const shopperFollows = getFollowListPubkeySet(shopperContacts)
  let followsInCommonCount = 0
  for (const followedPubkey of merchantFollows) {
    if (shopperFollows.has(followedPubkey)) followsInCommonCount += 1
  }

  const candidatePubkeys = Array.from(
    new Set(
      followerCandidatesRead.events
        .filter(
          (event) =>
            event.kind === EVENT_KINDS.CONTACT_LIST &&
            event.pubkey !== shopperPubkey &&
            isWithinFutureTolerance(event, nowSeconds) &&
            eventTagsPubkey(event, shopperPubkey)
        )
        .map((event) => event.pubkey)
    )
  )
    .sort()
    .slice(0, FOLLOWER_CANDIDATE_CAP)
  const followerCandidatesTruncated =
    candidatePubkeys.length >= FOLLOWER_CANDIDATE_CAP ||
    followerCandidatesRead.events.length >= FOLLOWER_CANDIDATE_LIMIT
  const followerRelayPlan =
    candidatePubkeys.length === 0
      ? null
      : options.relayUrls
        ? { relayUrls, completeAuthorHints: false }
        : await resolveAuthorReadRelayPlan(
            candidatePubkeys,
            relayUrls,
            resolveRelayLists,
            signal
          )
  throwIfTrustAborted(signal)
  const confirmedFollowersRead = !followerRelayPlan
    ? null
    : await safeRead(
        fetchEvents,
        {
          kinds: [EVENT_KINDS.CONTACT_LIST],
          authors: candidatePubkeys,
          limit: Math.max(10, candidatePubkeys.length * 3),
        },
        followerRelayPlan.relayUrls,
        followerCandidatesTruncated || !followerRelayPlan.completeAuthorHints,
        signal
      )
  throwIfTrustAborted(signal)
  const followerCoverage = confirmedFollowersRead
    ? mergeCoverage(
        [followerCandidatesRead.coverage, confirmedFollowersRead.coverage],
        followerCandidatesTruncated || !followerRelayPlan?.completeAuthorHints
      )
    : {
        ...followerCandidatesRead.coverage,
        truncated:
          followerCandidatesRead.coverage.truncated ||
          followerCandidatesTruncated,
      }
  const confirmedLatest = confirmedFollowersRead
    ? latestEventsByAuthor(
        confirmedFollowersRead.events.filter(
          (event) =>
            event.kind === EVENT_KINDS.CONTACT_LIST &&
            candidatePubkeys.includes(event.pubkey) &&
            isWithinFutureTolerance(event, nowSeconds)
        )
      )
    : new Map<string, SignedPublicNostrEvent>()
  const followerCount =
    candidatePubkeys.length === 0
      ? 0
      : candidatePubkeys.filter((pubkey) => {
          const latest = confirmedLatest.get(pubkey)
          return !!latest && eventTagsPubkey(latest, shopperPubkey)
        }).length

  const publicActivity = activityRead.events.filter(
    (event) =>
      event.pubkey === shopperPubkey &&
      isWithinFutureTolerance(event, nowSeconds)
  )
  const oldestEventTimestamp =
    publicActivity.length > 0
      ? Math.min(...publicActivity.map((event) => event.created_at))
      : null

  const fullReporterPubkeys = Array.from(
    new Set([merchantPubkey, ...merchantFollows])
  )
  const reporterPubkeys = fullReporterPubkeys
    .sort((left, right) => {
      if (left === merchantPubkey) return -1
      if (right === merchantPubkey) return 1
      return left.localeCompare(right)
    })
    .slice(0, REPORTER_CAP)
  const reportersTruncated = fullReporterPubkeys.length > REPORTER_CAP
  const reportRelayPlan =
    contactsRead.coverage.responsiveRelays === 0
      ? null
      : options.relayUrls
        ? { relayUrls, completeAuthorHints: false }
        : await resolveAuthorReadRelayPlan(
            reporterPubkeys,
            relayUrls,
            resolveRelayLists,
            signal
          )
  throwIfTrustAborted(signal)
  const reportsRead = !reportRelayPlan
    ? null
    : await safeRead(
        fetchEvents,
        {
          kinds: [EVENT_KINDS.REPORT],
          "#p": [shopperPubkey],
          limit: REPORT_LIMIT,
        },
        reportRelayPlan.relayUrls,
        reportersTruncated || !reportRelayPlan.completeAuthorHints,
        signal
      )
  throwIfTrustAborted(signal)
  const eligibleReports = (reportsRead?.events ?? []).filter(
    (event) =>
      event.kind === EVENT_KINDS.REPORT &&
      reporterPubkeys.includes(event.pubkey) &&
      isWithinFutureTolerance(event, nowSeconds) &&
      event.tags.some(
        ([name, pubkey]) => name === "p" && pubkey === shopperPubkey
      )
  )
  const reportDeletionAuthors = Array.from(
    new Set(eligibleReports.map((event) => event.pubkey))
  )
  const reportDeletionRelayPlan =
    eligibleReports.length === 0
      ? null
      : options.relayUrls
        ? { relayUrls, completeAuthorHints: false }
        : await resolveAuthorReadRelayPlan(
            reportDeletionAuthors,
            relayUrls,
            resolveRelayLists,
            signal
          )
  throwIfTrustAborted(signal)
  const reportDeletionsRead = !reportDeletionRelayPlan
    ? null
    : await safeRead(
        fetchEvents,
        {
          kinds: [EVENT_KINDS.DELETION],
          "#e": eligibleReports.map((event) => event.id),
          limit: REPORT_LIMIT,
        },
        reportDeletionRelayPlan.relayUrls,
        !reportDeletionRelayPlan.completeAuthorHints,
        signal
      )
  throwIfTrustAborted(signal)
  const visibleReports = eligibleReports.filter(
    (report) =>
      !reportWasDeleted(
        report,
        (reportDeletionsRead?.events ?? []).filter((event) =>
          isWithinFutureTolerance(event, nowSeconds)
        )
      )
  )
  const typedReports = visibleReports.flatMap((report) => {
    const type = reportType(report, shopperPubkey)
    return type ? [{ report, type }] : []
  })
  const reportCounts: Partial<Record<Nip56ReportType, number>> = {}
  for (const { type } of typedReports) {
    reportCounts[type] = (reportCounts[type] ?? 0) + 1
  }
  const reportCoverage = reportsRead
    ? mergeCoverage(
        [
          contactsRead.coverage,
          reportsRead.coverage,
          ...(reportDeletionsRead ? [reportDeletionsRead.coverage] : []),
        ],
        reportersTruncated || reportsRead.events.length >= REPORT_LIMIT
      )
    : contactsRead.coverage
  const [zapsSentObservation, zapsReceivedObservation] = await Promise.all([
    countZaps(
      zapsSentRead.events,
      { direction: "sent", shopperPubkey },
      nowSeconds,
      signal
    ),
    countZaps(
      zapsReceivedRead.events,
      { direction: "received", shopperPubkey },
      nowSeconds,
      signal
    ),
  ])
  throwIfTrustAborted(signal)

  const networkOldestEvent = networkSignal(
    { timestamp: oldestEventTimestamp },
    activityRead.coverage,
    now
  )
  const networkFollowers = networkSignal(
    { count: followerCount },
    followerCoverage,
    now
  )
  const networkCommon = networkSignal(
    { count: followsInCommonCount },
    contactsRead.coverage,
    now
  )
  const networkZapsSent = networkSignal(
    { count: zapsSentObservation.count },
    {
      ...zapsSentRead.coverage,
      // NIP-57's P tag is optional, so sender discovery is inherently
      // incomplete even when every planned relay responds.
      completeForPlan: false,
      truncated:
        zapsSentRead.events.length >= ZAP_RECEIPT_LIMIT ||
        zapsSentObservation.truncated,
    },
    now
  )
  const networkZapsReceived = networkSignal(
    { count: zapsReceivedObservation.count },
    {
      ...zapsReceivedRead.coverage,
      // These counts intentionally stop short of historical LNURL-provider
      // authority claims. They represent signed request observations embedded
      // in invoice-bound events, not verified payments.
      completeForPlan: false,
      truncated:
        zapsReceivedRead.events.length >= ZAP_RECEIPT_LIMIT ||
        zapsReceivedObservation.truncated,
    },
    now
  )
  const networkReports = reportsRead
    ? networkSignal(
        {
          count: typedReports.length,
          reporterCount: new Set(
            typedReports.map(({ report }) => report.pubkey)
          ).size,
          byType: reportCounts,
        },
        reportCoverage,
        now
      )
    : unavailableSignal<{
        count: number
        reporterCount: number
        byType: Partial<Record<Nip56ReportType, number>>
      }>(reportCoverage)

  const evidence = buildEvidence({
    merchantPubkey,
    shopperPubkey,
    oldestEvent: preferOldestEventTimestamp(
      networkOldestEvent,
      cachedEvidence?.oldestEvent
    ),
    followersObserved: preferBoundedCount(
      networkFollowers,
      cachedEvidence?.followersObserved,
      ({ count }) => count
    ),
    followsInCommon: preferBoundedCount(
      networkCommon,
      cachedEvidence?.followsInCommon,
      ({ count }) => count
    ),
    zapsSent: preferBoundedCount(
      networkZapsSent,
      cachedEvidence?.zapsSent,
      ({ count }) => count
    ),
    zapsReceived: preferBoundedCount(
      networkZapsReceived,
      cachedEvidence?.zapsReceived,
      ({ count }) => count
    ),
    reportsFromNetwork: preferBoundedCount(
      networkReports,
      cachedEvidence?.reportsFromNetwork,
      ({ count }) => count
    ),
    refreshedAt: now,
  })

  const hasNetworkObservation = [
    networkOldestEvent,
    networkFollowers,
    networkCommon,
    networkZapsSent,
    networkZapsReceived,
    networkReports,
  ].some(({ source }) => source === "network")
  if (hasNetworkObservation) {
    throwIfTrustAborted(signal)
    await persistCached(cache, evidenceToRow(evidence, now))
    throwIfTrustAborted(signal)
  }

  throwIfTrustAborted(signal)
  return evidence
}
