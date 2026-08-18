/**
 * NIP-02 contact-list helpers.
 *
 * Contact lists are replaceable events with `p` tags for followed pubkeys.
 * These helpers stay deliberately bounded: they interpret known contact-list
 * events, but do not attempt expensive reverse follower discovery.
 */

import { NDKEvent } from "@nostr-dev-kit/ndk"
import { db, type CachedOwnContactListSnapshot } from "../db"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import { EVENT_KINDS } from "./kinds"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { getNdk } from "./ndk"
import {
  getRelayLists,
  getRelayListsDetailed,
  type RelayList,
  type RelayListResolutionState,
} from "./relay-list"
import { planRelayReads } from "./relay-planner"
import { publishWithPlanner } from "./relay-publish"
import {
  fetchSignedEventsFanoutDetailed,
  type RelayReadSourceStatus,
  verifySignedEvents,
} from "./relay-reader"
import {
  ReplaceablePublishSafetyError,
  assertSafeReplaceablePublish,
} from "./replaceable-safety"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export type FollowListEventLike = {
  id?: string
  pubkey?: string
  created_at?: number
  content?: string
  tags?: readonly (readonly string[])[]
}

export interface MerchantTrustSocialSummary {
  merchantFollowingCount: number
  viewerFollowsMerchant: boolean | null
  merchantFollowsViewer: boolean | null
  mutualFollowCount: number | null
}

export const CONTACT_LIST_WRITES_AVAILABLE: boolean = true
export const CONTACT_LIST_WRITE_UNAVAILABLE_MESSAGE =
  "Follow updates are temporarily paused while contact-list safety is upgraded."

export class ContactListWriteUnavailableError extends Error {
  readonly code = "contact_list_writes_unavailable"

  constructor() {
    super(CONTACT_LIST_WRITE_UNAVAILABLE_MESSAGE)
    this.name = "ContactListWriteUnavailableError"
  }
}

export type FollowListCoverageState = "complete" | "limited" | "unavailable"

export interface FollowListAuthorRead {
  pubkey: string
  event?: SignedPublicNostrEvent
  eventSourceRelayUrls: string[]
  /** Selected current NIP-65 author hints, before adding an independent base. */
  hintRelayUrls?: string[]
  plannedRelayUrls: string[]
  relays: RelayReadSourceStatus[]
  eventsVerified: boolean
  coverage: FollowListCoverageState
  relayListState: RelayListResolutionState
  relayHintTruncated: boolean
  snapshotState: "none" | "network" | "observed" | "pending"
}

export interface FollowListReadResult {
  events: SignedPublicNostrEvent[]
  authors: FollowListAuthorRead[]
  plannedRelayUrls: string[]
  relays: RelayReadSourceStatus[]
  eventsVerified: boolean
}

export interface MerchantTrustSocialReadResult extends MerchantTrustSocialSummary {
  readState: "available" | "limited" | "unavailable"
  pendingViewerFollowsMerchant: boolean | null
  authors: FollowListAuthorRead[]
}

export interface FollowListReadOptions {
  signal?: AbortSignal
  maxRelays?: number
  /** Force live NIP-65 discovery before a replacement-sensitive read. */
  refreshRelayLists?: boolean
  now?: () => number
  resolveRelayLists?: typeof getRelayLists
  resolveRelayListsDetailed?: typeof getRelayListsDetailed
  fetchEvents?: typeof fetchSignedEventsFanoutDetailed
}

const FOLLOW_LIST_FUTURE_TOLERANCE_SECONDS = 5 * 60
const FOLLOW_LIST_CONNECT_TIMEOUT_MS = 2_500
const FOLLOW_LIST_FETCH_TIMEOUT_MS = 4_000
const FOLLOW_LIST_EVENTS_PER_AUTHOR = 10
const FOLLOW_LIST_MAX_AUTHORS = 8
const FOLLOW_LIST_MAX_RELAYS_PER_AUTHOR = 4
const FOLLOW_LIST_MAX_VERIFICATION_CANDIDATES =
  FOLLOW_LIST_EVENTS_PER_AUTHOR * FOLLOW_LIST_MAX_RELAYS_PER_AUTHOR
const MAX_OBSERVED_OWN_FOLLOW_LISTS = 64

type ObservedOwnFollowList = {
  event: SignedPublicNostrEvent
  eventSourceRelayUrls: string[]
  state: "observed" | "pending"
}

const observedOwnFollowLists = new Map<string, ObservedOwnFollowList>()

interface FollowListTestOverrides {
  getNdk?: typeof getNdk
  readLatestFollowLists?: typeof readLatestFollowLists
  publishWithPlanner?: typeof publishWithPlanner
  loadOwnContactListSnapshot?: (
    pubkey: string
  ) => Promise<CachedOwnContactListSnapshot | undefined>
  putOwnContactListSnapshot?: (
    snapshot: CachedOwnContactListSnapshot
  ) => Promise<void>
}

let followListTestOverrides: FollowListTestOverrides = {}

export function __setFollowListTestOverrides(
  overrides: Partial<FollowListTestOverrides>
): void {
  followListTestOverrides = { ...followListTestOverrides, ...overrides }
}

export function __resetFollowListTestState(): void {
  observedOwnFollowLists.clear()
  followListTestOverrides = {}
}

function throwIfFollowReadAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error("The operation was aborted.")
  error.name = "AbortError"
  throw error
}

function normalizeHexPubkey(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase()
  if (!trimmed || !/^[0-9a-f]{64}$/.test(trimmed)) return null
  return trimmed
}

export function extractFollowPubkeys(
  tags: readonly (readonly string[])[] | undefined
): string[] {
  const seen = new Set<string>()

  for (const tag of tags ?? []) {
    if (tag[0] !== "p") continue
    const pubkey = normalizeHexPubkey(tag[1])
    if (pubkey) seen.add(pubkey)
  }

  return Array.from(seen)
}

export function selectLatestFollowListEvent<T extends FollowListEventLike>(
  events: Iterable<T>
): T | undefined {
  return Array.from(events).sort((a, b) => {
    const timestampDelta = (b.created_at ?? 0) - (a.created_at ?? 0)
    if (timestampDelta !== 0) return timestampDelta

    // NIP-01 resolves replaceable-event timestamp ties to the lowest id.
    const aId = a.id ?? "\uffff"
    const bId = b.id ?? "\uffff"
    return aId < bId ? -1 : aId > bId ? 1 : 0
  })[0]
}

function cloneSignedEvent(
  event: SignedPublicNostrEvent
): SignedPublicNostrEvent {
  return {
    ...event,
    tags: event.tags.map((tag) => [...tag]),
  }
}

function cloneOwnContactListSnapshot(
  snapshot: CachedOwnContactListSnapshot
): CachedOwnContactListSnapshot {
  return {
    ...snapshot,
    event: cloneSignedEvent(snapshot.event),
    sourceRelayUrls: [...snapshot.sourceRelayUrls],
  }
}

function isValidOwnContactListSnapshot(
  snapshot: CachedOwnContactListSnapshot | undefined,
  pubkey: string
): snapshot is CachedOwnContactListSnapshot {
  return !!(
    snapshot &&
    snapshot.pubkey === pubkey &&
    snapshot.event.pubkey === pubkey &&
    snapshot.event.kind === EVENT_KINDS.CONTACT_LIST &&
    (snapshot.state === "observed" || snapshot.state === "pending") &&
    isValidSignedPublicNostrEvent(snapshot.event)
  )
}

function chooseStrongestOwnContactListSnapshot(
  left: CachedOwnContactListSnapshot | undefined,
  right: CachedOwnContactListSnapshot
): CachedOwnContactListSnapshot {
  if (!left) return cloneOwnContactListSnapshot(right)
  if (left.event.id === right.event.id) {
    return {
      pubkey: right.pubkey,
      event: cloneSignedEvent(right.event),
      sourceRelayUrls: Array.from(
        new Set([...left.sourceRelayUrls, ...right.sourceRelayUrls])
      ),
      state:
        left.state === "observed" || right.state === "observed"
          ? "observed"
          : "pending",
      cachedAt: Math.max(left.cachedAt, right.cachedAt),
    }
  }
  const strongest = selectLatestFollowListEvent([left.event, right.event])
  return cloneOwnContactListSnapshot(strongest === right.event ? right : left)
}

function rememberOwnContactListSnapshot(
  snapshot: CachedOwnContactListSnapshot
): CachedOwnContactListSnapshot {
  const existing = observedOwnFollowLists.get(snapshot.pubkey)
  const chosen = chooseStrongestOwnContactListSnapshot(
    existing
      ? {
          pubkey: snapshot.pubkey,
          event: existing.event,
          sourceRelayUrls: existing.eventSourceRelayUrls,
          state: existing.state,
          cachedAt: 0,
        }
      : undefined,
    snapshot
  )
  if (
    !existing &&
    observedOwnFollowLists.size >= MAX_OBSERVED_OWN_FOLLOW_LISTS
  ) {
    const oldestKey = observedOwnFollowLists.keys().next().value
    if (oldestKey) observedOwnFollowLists.delete(oldestKey)
  }
  observedOwnFollowLists.set(snapshot.pubkey, {
    event: cloneSignedEvent(chosen.event),
    eventSourceRelayUrls: [...chosen.sourceRelayUrls],
    state: chosen.state,
  })
  return chosen
}

async function loadOwnContactListSnapshot(
  pubkey: string,
  signal?: AbortSignal
): Promise<CachedOwnContactListSnapshot | undefined> {
  let stored: CachedOwnContactListSnapshot | undefined
  try {
    stored = followListTestOverrides.loadOwnContactListSnapshot
      ? await followListTestOverrides.loadOwnContactListSnapshot(pubkey)
      : await db.ownContactListSnapshots.get(pubkey)
  } catch {
    stored = undefined
  }
  throwIfFollowReadAborted(signal)

  if (stored) {
    if (!isValidOwnContactListSnapshot(stored, pubkey)) {
      // Ignore corrupt rows in place. Deleting by pubkey after this read would
      // race a valid pending snapshot written by another tab. The next
      // transactional valid write safely replaces the row.
      stored = undefined
    }
  }

  const memory = observedOwnFollowLists.get(pubkey)
  const memorySnapshot: CachedOwnContactListSnapshot | undefined = memory
    ? {
        pubkey,
        event: memory.event,
        sourceRelayUrls: memory.eventSourceRelayUrls,
        state: memory.state,
        cachedAt: 0,
      }
    : undefined
  const chosen = stored
    ? chooseStrongestOwnContactListSnapshot(memorySnapshot, stored)
    : memorySnapshot
  return chosen ? rememberOwnContactListSnapshot(chosen) : undefined
}

async function persistOwnContactListSnapshot(
  snapshot: CachedOwnContactListSnapshot,
  options: {
    required: boolean
    /** `null` means the complete preflight read established no prior event. */
    expectedBaseEvent?: SignedPublicNostrEvent | null
  }
): Promise<CachedOwnContactListSnapshot> {
  const normalized = cloneOwnContactListSnapshot(snapshot)
  const chooseAfterBaseCheck = (
    current: CachedOwnContactListSnapshot | undefined
  ): CachedOwnContactListSnapshot => {
    const validCurrent = isValidOwnContactListSnapshot(
      current,
      normalized.pubkey
    )
      ? current
      : undefined
    if (validCurrent && options.expectedBaseEvent === null) {
      throw new ReplaceablePublishSafetyError(
        "Refusing to publish an initial follow list because a durable owner snapshot appeared after the read."
      )
    }
    if (validCurrent && options.expectedBaseEvent) {
      const strongestBeforeUpdate = selectLatestFollowListEvent([
        validCurrent.event,
        options.expectedBaseEvent,
      ])
      if (strongestBeforeUpdate?.id !== options.expectedBaseEvent.id) {
        throw new ReplaceablePublishSafetyError(
          "Refusing to publish a follow-list replacement because the durable owner snapshot changed after the read."
        )
      }
    }
    return chooseStrongestOwnContactListSnapshot(validCurrent, normalized)
  }

  try {
    let chosen: CachedOwnContactListSnapshot
    if (followListTestOverrides.putOwnContactListSnapshot) {
      const current = followListTestOverrides.loadOwnContactListSnapshot
        ? await followListTestOverrides.loadOwnContactListSnapshot(
            normalized.pubkey
          )
        : undefined
      chosen = chooseAfterBaseCheck(current)
      await followListTestOverrides.putOwnContactListSnapshot(chosen)
    } else {
      chosen = await db.transaction(
        "rw",
        db.ownContactListSnapshots,
        async () => {
          const current = await db.ownContactListSnapshots.get(
            normalized.pubkey
          )
          const next = chooseAfterBaseCheck(current)
          await db.ownContactListSnapshots.put(next)
          return next
        }
      )
    }
    return rememberOwnContactListSnapshot(chosen)
  } catch (error) {
    if (options.required) throw error
    return rememberOwnContactListSnapshot(normalized)
  }
}

async function preserveStrongestOwnFollowList(
  read: FollowListAuthorRead,
  authenticatedPubkey: string | null,
  signal?: AbortSignal
): Promise<FollowListAuthorRead> {
  if (read.pubkey !== authenticatedPubkey) return read
  const retained = await loadOwnContactListSnapshot(read.pubkey, signal)

  if (read.event && read.eventsVerified) {
    const networkSnapshot: CachedOwnContactListSnapshot = {
      pubkey: read.pubkey,
      event: read.event,
      sourceRelayUrls: read.eventSourceRelayUrls,
      state: "observed",
      cachedAt: Date.now(),
    }
    const strongest = chooseStrongestOwnContactListSnapshot(
      retained,
      networkSnapshot
    )
    if (strongest.event.id === read.event.id) {
      const persisted = await persistOwnContactListSnapshot(networkSnapshot, {
        required: false,
      })
      if (persisted.event.id === read.event.id) {
        return { ...read, snapshotState: "network" }
      }
      // A stronger snapshot may have won the transaction after the initial
      // cache read. Never report the weaker network event as authoritative.
      return {
        ...read,
        event: persisted.event,
        eventSourceRelayUrls: [...persisted.sourceRelayUrls],
        eventsVerified: true,
        coverage: "limited",
        snapshotState: persisted.state,
      }
    }
  }

  if (!retained) return read
  return {
    ...read,
    event: retained.event,
    eventSourceRelayUrls: [...retained.sourceRelayUrls],
    eventsVerified: true,
    coverage: "limited",
    snapshotState: retained.state,
  }
}

export function getFollowListPubkeySet(
  event: FollowListEventLike | null | undefined
): Set<string> {
  return new Set(extractFollowPubkeys(event?.tags))
}

export function buildMerchantTrustSocialSummary({
  viewerFollowPubkeys,
  merchantFollowPubkeys,
  merchantPubkey,
  viewerPubkey,
}: {
  viewerFollowPubkeys?: Iterable<string> | null
  merchantFollowPubkeys?: Iterable<string> | null
  merchantPubkey: string
  viewerPubkey?: string | null
}): MerchantTrustSocialSummary {
  const normalizedMerchantPubkey = normalizeHexPubkey(merchantPubkey)
  const normalizedViewerPubkey = normalizeHexPubkey(viewerPubkey ?? undefined)
  const viewerFollows = new Set(
    Array.from(viewerFollowPubkeys ?? [])
      .map((pubkey) => normalizeHexPubkey(pubkey))
      .filter(Boolean) as string[]
  )
  const merchantFollows = new Set(
    Array.from(merchantFollowPubkeys ?? [])
      .map((pubkey) => normalizeHexPubkey(pubkey))
      .filter(Boolean) as string[]
  )
  let mutualFollowCount: number | null = null

  if (viewerFollowPubkeys && merchantFollowPubkeys) {
    mutualFollowCount = 0
    for (const pubkey of viewerFollows) {
      if (merchantFollows.has(pubkey)) mutualFollowCount += 1
    }
  }

  return {
    merchantFollowingCount: merchantFollows.size,
    viewerFollowsMerchant:
      normalizedMerchantPubkey && viewerFollowPubkeys
        ? viewerFollows.has(normalizedMerchantPubkey)
        : null,
    merchantFollowsViewer:
      normalizedViewerPubkey && merchantFollowPubkeys
        ? merchantFollows.has(normalizedViewerPubkey)
        : null,
    mutualFollowCount,
  }
}

export async function readLatestFollowLists(
  {
    pubkeys,
    authenticatedPubkey,
  }: {
    pubkeys: readonly string[]
    authenticatedPubkey?: string | null
  },
  options: FollowListReadOptions = {}
): Promise<FollowListReadResult> {
  throwIfFollowReadAborted(options.signal)
  const normalizedPubkeys = Array.from(
    new Set(
      pubkeys
        .map((pubkey) => normalizeHexPubkey(pubkey))
        .filter((pubkey): pubkey is string => !!pubkey)
    )
  ).slice(0, FOLLOW_LIST_MAX_AUTHORS)
  if (normalizedPubkeys.length === 0) {
    return {
      events: [],
      authors: [],
      plannedRelayUrls: [],
      relays: [],
      eventsVerified: true,
    }
  }

  const relayLookupOptions = {
    allowInsecureRelayUrlsForPubkey: authenticatedPubkey,
    skipCache: options.refreshRelayLists,
    signal: options.signal,
  }
  let relayLists: Map<string, RelayList>
  let relayListStates: Map<string, RelayListResolutionState>
  if (options.resolveRelayLists) {
    relayLists = await options.resolveRelayLists(
      normalizedPubkeys,
      relayLookupOptions
    )
    relayListStates = new Map(
      normalizedPubkeys.map((pubkey) => {
        const list = relayLists.get(pubkey)
        return [
          pubkey,
          list?.lookupState ?? (list ? "fresh-cache" : "missing"),
        ] as const
      })
    )
  } else {
    const detailed = await (
      options.resolveRelayListsDetailed ?? getRelayListsDetailed
    )(normalizedPubkeys, relayLookupOptions)
    relayLists = detailed.relayLists
    relayListStates = detailed.resolutionStates
  }
  throwIfFollowReadAborted(options.signal)
  const fetchEvents = options.fetchEvents ?? fetchSignedEventsFanoutDetailed
  const normalizedAuthenticatedPubkey = normalizeHexPubkey(
    authenticatedPubkey ?? undefined
  )
  const latestAllowedTimestamp =
    Math.floor((options.now?.() ?? Date.now()) / 1_000) +
    FOLLOW_LIST_FUTURE_TOLERANCE_SECONDS
  const requestedMaxRelays = Math.floor(
    options.maxRelays ?? FOLLOW_LIST_MAX_RELAYS_PER_AUTHOR
  )
  const maxRelays = Number.isFinite(requestedMaxRelays)
    ? Math.max(
        2,
        Math.min(FOLLOW_LIST_MAX_RELAYS_PER_AUTHOR, requestedMaxRelays)
      )
    : FOLLOW_LIST_MAX_RELAYS_PER_AUTHOR

  const authors = await Promise.all(
    normalizedPubkeys.map(async (pubkey): Promise<FollowListAuthorRead> => {
      const relayListState = relayListStates.get(pubkey) ?? "lookup-unavailable"
      const authorPlan = planRelayReads({
        intent: "contact_lists",
        authors: [pubkey],
        relayLists,
        authenticatedPubkey,
        maxRelays,
        // Health is an availability signal, not permission to omit an
        // author's declared write relay from a replacement-sensitive read.
        skipHealthFilter: true,
      })
      const basePlan = planRelayReads({
        intent: "contact_lists",
        authenticatedPubkey,
        maxRelays: 1,
        // Reserve one curated/settings relay even when its health score is
        // parked; otherwise an attacker-controlled hint can become the only
        // destination and eliminate the independent observation.
        skipHealthFilter: true,
      })
      const hintSet = new Set(authorPlan.hintRelayUrls)
      const hinted = [...authorPlan.hintRelayUrls]
      const nonHinted = authorPlan.relayUrls.filter((url) => !hintSet.has(url))
      const reservedBaseRelay = basePlan.relayUrls[0]
      const hintCapacity =
        reservedBaseRelay && !hintSet.has(reservedBaseRelay)
          ? maxRelays - 1
          : maxRelays
      const selectedHints = hinted.slice(0, hintCapacity)
      const relayHintTruncated = selectedHints.length < hinted.length
      const plannedRelayUrls = Array.from(
        new Set([
          ...selectedHints,
          ...basePlan.relayUrls.slice(0, 1),
          ...nonHinted,
        ])
      ).slice(0, maxRelays)

      if (plannedRelayUrls.length === 0) {
        return await preserveStrongestOwnFollowList(
          {
            pubkey,
            eventSourceRelayUrls: [],
            hintRelayUrls: selectedHints,
            plannedRelayUrls: [],
            relays: [],
            eventsVerified: true,
            coverage: "unavailable",
            relayListState,
            relayHintTruncated,
            snapshotState: "none",
          },
          normalizedAuthenticatedPubkey,
          options.signal
        )
      }

      let result: Awaited<ReturnType<typeof fetchSignedEventsFanoutDetailed>>
      try {
        result = await fetchEvents(
          {
            kinds: [EVENT_KINDS.CONTACT_LIST],
            authors: [pubkey],
            limit: FOLLOW_LIST_EVENTS_PER_AUTHOR,
          },
          {
            relayUrls: plannedRelayUrls,
            connectTimeoutMs: FOLLOW_LIST_CONNECT_TIMEOUT_MS,
            fetchTimeoutMs: FOLLOW_LIST_FETCH_TIMEOUT_MS,
            skipHealthFilter: true,
            signal: options.signal,
          }
        )
      } catch (error) {
        if (options.signal?.aborted) throw error
        return await preserveStrongestOwnFollowList(
          {
            pubkey,
            eventSourceRelayUrls: [],
            hintRelayUrls: selectedHints,
            plannedRelayUrls,
            relays: plannedRelayUrls.map((relayUrl) => ({
              relayUrl,
              status: "failed",
              eventCount: 0,
            })),
            eventsVerified: true,
            coverage: "unavailable",
            relayListState,
            relayHintTruncated,
            snapshotState: "none",
          },
          normalizedAuthenticatedPubkey,
          options.signal
        )
      }

      const statusByRelay = new Map(
        result.relays.map((relay) => [relay.relayUrl, relay] as const)
      )
      const relays = plannedRelayUrls.map(
        (relayUrl): RelayReadSourceStatus =>
          statusByRelay.get(relayUrl) ?? {
            relayUrl,
            status: "failed",
            eventCount: 0,
          }
      )
      const usesVerifiedReader =
        fetchEvents === fetchSignedEventsFanoutDetailed &&
        result.eventsVerified === true
      const candidateOverflow =
        result.events.length > FOLLOW_LIST_MAX_VERIFICATION_CANDIDATES
      const candidates = result.events.slice(
        0,
        FOLLOW_LIST_MAX_VERIFICATION_CANDIDATES
      )
      const verification = usesVerifiedReader
        ? { events: candidates, truncated: false }
        : await verifySignedEvents(candidates, {
            signal: options.signal,
            maxEvents: FOLLOW_LIST_MAX_VERIFICATION_CANDIDATES,
          })
      const eventsVerified = !candidateOverflow && !verification.truncated
      const event = selectLatestFollowListEvent(
        verification.events.filter(
          (candidate) =>
            candidate.kind === EVENT_KINDS.CONTACT_LIST &&
            candidate.pubkey === pubkey &&
            candidate.created_at <= latestAllowedTimestamp
        )
      )
      const hasUsableSource = relays.some((relay) => relay.status !== "failed")
      const relayDiscoveryComplete =
        relayListState === "network" ||
        relayListState === "fresh-cache" ||
        relayListState === "missing"
      const coverage: FollowListCoverageState = !hasUsableSource
        ? "unavailable"
        : eventsVerified &&
            relayDiscoveryComplete &&
            !relayHintTruncated &&
            relays.every((relay) => relay.status === "success")
          ? "complete"
          : "limited"

      return await preserveStrongestOwnFollowList(
        {
          pubkey,
          event,
          eventSourceRelayUrls: event
            ? [...(result.eventSourceRelayUrls[event.id] ?? [])]
            : [],
          hintRelayUrls: selectedHints,
          plannedRelayUrls,
          relays,
          eventsVerified,
          coverage,
          relayListState,
          relayHintTruncated,
          snapshotState: event ? "network" : "none",
        },
        normalizedAuthenticatedPubkey,
        options.signal
      )
    })
  )

  return {
    events: authors.flatMap(({ event }) => (event ? [event] : [])),
    authors,
    plannedRelayUrls: Array.from(
      new Set(authors.flatMap(({ plannedRelayUrls }) => plannedRelayUrls))
    ),
    relays: authors.flatMap(({ relays }) => relays),
    eventsVerified: authors.every(({ eventsVerified }) => eventsVerified),
  }
}

export async function fetchMerchantTrustSocialSummary(
  {
    merchantPubkey,
    viewerPubkey,
  }: {
    merchantPubkey: string
    viewerPubkey: string
  },
  options: FollowListReadOptions = {}
): Promise<MerchantTrustSocialReadResult> {
  const read = await readLatestFollowLists(
    {
      pubkeys: [viewerPubkey, merchantPubkey],
      authenticatedPubkey: viewerPubkey,
    },
    options
  )
  const viewerLatest = selectLatestFollowListEvent(
    read.events.filter((event) => event.pubkey === viewerPubkey)
  )
  const merchantLatest = selectLatestFollowListEvent(
    read.events.filter((event) => event.pubkey === merchantPubkey)
  )
  const viewerAuthor = read.authors.find(
    (author) => author.pubkey === normalizeHexPubkey(viewerPubkey)
  )

  const summary = buildMerchantTrustSocialSummary({
    merchantPubkey,
    viewerPubkey,
    viewerFollowPubkeys: viewerLatest
      ? getFollowListPubkeySet(viewerLatest)
      : null,
    merchantFollowPubkeys: merchantLatest
      ? getFollowListPubkeySet(merchantLatest)
      : null,
  })
  const readState = read.authors.every(
    ({ coverage }) => coverage === "complete"
  )
    ? "available"
    : read.authors.every(({ coverage }) => coverage === "unavailable")
      ? "unavailable"
      : "limited"
  const pendingViewerFollowsMerchant =
    viewerAuthor?.snapshotState === "pending" && viewerLatest
      ? getFollowListPubkeySet(viewerLatest).has(merchantPubkey)
      : null

  return {
    ...summary,
    readState,
    pendingViewerFollowsMerchant,
    authors: read.authors,
  }
}

function copyMutableTags(
  tags: readonly (readonly string[])[] | undefined
): string[][] {
  return (tags ?? []).map((tag) => [...tag])
}

export function buildContactListUpdateTags({
  currentTags,
  targetPubkey,
  shouldFollow,
}: {
  currentTags: readonly (readonly string[])[] | undefined
  targetPubkey: string
  shouldFollow: boolean
}): string[][] {
  const normalizedTargetPubkey = normalizeHexPubkey(targetPubkey)
  if (!normalizedTargetPubkey) {
    throw new Error("Cannot update a follow list with an invalid target pubkey")
  }

  const nextTags = copyMutableTags(currentTags)
  const currentFollowPubkeys = getFollowListPubkeySet({ tags: currentTags })
  const alreadyFollowing = currentFollowPubkeys.has(normalizedTargetPubkey)

  if (shouldFollow && !alreadyFollowing) {
    nextTags.push(["p", normalizedTargetPubkey])
  }
  if (!shouldFollow && alreadyFollowing) {
    for (let index = nextTags.length - 1; index >= 0; index -= 1) {
      const tag = nextTags[index]
      if (
        tag[0] === "p" &&
        normalizeHexPubkey(tag[1]) === normalizedTargetPubkey
      ) {
        nextTags.splice(index, 1)
      }
    }
  }

  return nextTags
}

export function requirePublishableContactListSnapshot(
  read: FollowListReadResult,
  ownerPubkey: string
): SignedPublicNostrEvent | null {
  const normalizedOwnerPubkey = normalizeHexPubkey(ownerPubkey)
  const author = read.authors.find(
    (candidate) => candidate.pubkey === normalizedOwnerPubkey
  )
  const hasCompletedSource = author?.relays.some(
    (relay) =>
      relay.status === "success" &&
      author.eventSourceRelayUrls.includes(relay.relayUrl)
  )
  const hasCurrentRelayDiscovery =
    author?.relayListState === "network" || author?.relayListState === "missing"
  const selectedHintRelayUrls = author?.hintRelayUrls ?? []
  const selectedHintRelayUrlSet = new Set(selectedHintRelayUrls)
  const completedOwnerLocalHint = author?.eventSourceRelayUrls.some(
    (relayUrl) =>
      selectedHintRelayUrlSet.has(relayUrl) &&
      !normalizePublicWebSocketUrl(relayUrl) &&
      author.relays.some(
        (relay) => relay.relayUrl === relayUrl && relay.status === "success"
      )
  )
  const allSelectedHintsCompleted = selectedHintRelayUrls.every((relayUrl) =>
    author?.relays.some(
      (relay) => relay.relayUrl === relayUrl && relay.status === "success"
    )
  )
  const exactOwnerLocalEvidenceIsPublishable =
    author?.snapshotState === "network" &&
    author.coverage === "limited" &&
    !author.relayHintTruncated &&
    hasCurrentRelayDiscovery &&
    completedOwnerLocalHint &&
    allSelectedHintsCompleted
  const completeEmptyNetworkReadIsPublishable =
    !author?.event &&
    author?.snapshotState === "none" &&
    author.eventsVerified &&
    author.coverage === "complete" &&
    !author.relayHintTruncated &&
    hasCurrentRelayDiscovery &&
    author.plannedRelayUrls.length > 0 &&
    author.relays.every(
      (relay) =>
        relay.status === "success" &&
        relay.eventCount === 0 &&
        relay.rejectedEventCount === 0
    ) &&
    author.plannedRelayUrls.every((relayUrl) =>
      author.relays.some(
        (relay) =>
          relay.relayUrl === relayUrl &&
          relay.status === "success" &&
          relay.eventCount === 0 &&
          relay.rejectedEventCount === 0
      )
    )

  if (completeEmptyNetworkReadIsPublishable) return null

  if (
    !author?.event ||
    !author.eventsVerified ||
    (author.coverage !== "complete" && !exactOwnerLocalEvidenceIsPublishable) ||
    !hasCurrentRelayDiscovery ||
    !hasCompletedSource
  ) {
    throw new ReplaceablePublishSafetyError(
      "Refusing to publish a follow-list replacement without a verified snapshot from a relay that completed the read."
    )
  }

  return author.event
}

export async function publishContactListUpdate({
  ownerPubkey,
  targetPubkey,
  shouldFollow,
  appId,
}: {
  ownerPubkey: string
  targetPubkey: string
  shouldFollow: boolean
  appId: ConduitAppId
}): Promise<void> {
  if (!CONTACT_LIST_WRITES_AVAILABLE) {
    throw new ContactListWriteUnavailableError()
  }

  const normalizedOwnerPubkey = normalizeHexPubkey(ownerPubkey)
  const normalizedTargetPubkey = normalizeHexPubkey(targetPubkey)

  if (!normalizedOwnerPubkey || !normalizedTargetPubkey) {
    throw new Error("Cannot update a follow list with an invalid pubkey")
  }

  const ndk = followListTestOverrides.getNdk?.() ?? getNdk()
  if (!ndk.signer) throw new Error("Signer not connected")

  const signerPubkey = normalizeHexPubkey((await ndk.signer.user()).pubkey)
  if (signerPubkey !== normalizedOwnerPubkey) {
    throw new Error("Active signer does not match this follow list")
  }

  const readFollowLists =
    followListTestOverrides.readLatestFollowLists ?? readLatestFollowLists
  const existing = await readFollowLists(
    {
      pubkeys: [normalizedOwnerPubkey],
      authenticatedPubkey: normalizedOwnerPubkey,
    },
    {
      maxRelays: FOLLOW_LIST_MAX_RELAYS_PER_AUTHOR,
      refreshRelayLists: true,
    }
  )
  const ownerRead = existing.authors.find(
    (candidate) => candidate.pubkey === normalizedOwnerPubkey
  )
  const publishEvent =
    followListTestOverrides.publishWithPlanner ?? publishWithPlanner
  const replaceableSafety = {
    contactList: {
      enforceMinimumPubkeys: false,
    },
  }

  const publishExact = async (
    event: NDKEvent,
    snapshot: SignedPublicNostrEvent
  ): Promise<string[]> => {
    assertSafeReplaceablePublish(event, replaceableSafety)
    const result = await publishEvent(event, {
      intent: "author_event",
      authorPubkey: normalizedOwnerPubkey,
      authenticatedPubkey: normalizedOwnerPubkey,
      replaceableSafety,
    })
    if (result.successfulRelayUrls.length === 0) {
      throw new Error("No relay acknowledged the follow-list update.")
    }
    await persistOwnContactListSnapshot(
      {
        pubkey: normalizedOwnerPubkey,
        event: snapshot,
        sourceRelayUrls: result.successfulRelayUrls,
        state: "observed",
        cachedAt: Date.now(),
      },
      { required: false }
    )
    return result.successfulRelayUrls
  }

  if (
    ownerRead?.event &&
    getFollowListPubkeySet(ownerRead.event).has(normalizedTargetPubkey) ===
      shouldFollow
  ) {
    if (ownerRead.snapshotState === "pending") {
      await publishExact(
        new NDKEvent(ndk, cloneSignedEvent(ownerRead.event)),
        ownerRead.event
      )
    }
    return
  }

  const latest = requirePublishableContactListSnapshot(
    existing,
    normalizedOwnerPubkey
  )

  if (!latest && !shouldFollow) return

  const nextTags = buildContactListUpdateTags({
    currentTags: latest?.tags,
    targetPubkey: normalizedTargetPubkey,
    shouldFollow,
  })

  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.CONTACT_LIST
  event.created_at = Math.max(
    Math.floor(Date.now() / 1000),
    (latest?.created_at ?? -1) + 1
  )
  event.content = latest?.content ?? ""
  event.tags = appendConduitClientTag(nextTags, appId)

  assertSafeReplaceablePublish(event, replaceableSafety)
  await event.sign(ndk.signer)
  const signedEvent = event.rawEvent() as SignedPublicNostrEvent
  const retained = await persistOwnContactListSnapshot(
    {
      pubkey: normalizedOwnerPubkey,
      event: signedEvent,
      sourceRelayUrls: [],
      state: "pending",
      cachedAt: Date.now(),
    },
    { required: true, expectedBaseEvent: latest }
  )
  if (retained.event.id !== signedEvent.id) {
    throw new ReplaceablePublishSafetyError(
      "Refusing to publish a follow-list replacement because a stronger owner snapshot was stored concurrently."
    )
  }

  // A timeout or lost ACK is ambiguous: the relay may have stored this exact
  // signed replacement. Keep it as pending so the next identical action
  // retries the same event instead of signing over it.
  await publishExact(event, signedEvent)
}
