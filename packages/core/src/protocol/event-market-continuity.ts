import {
  getLocalEventMarketEvidenceSnapshot,
  getRetainedEventMarketCollectionEvidence,
  parseEventMarketCollectionEvent,
  type ParsedEventMarketCollection,
} from "./event-market"
import { readDurableAccountRelaySettingsPlanningSnapshot } from "./network-preferences"
import { getRelayLists } from "./relay-list"
import { planRelayReads } from "./relay-planner"
import {
  fetchSignedEventsFanoutDetailed,
  type RelayReadOptions,
} from "./relay-reader"
import { normalizeOwnerSelectedRelayUrls } from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

type CollectionRevision = Pick<
  ParsedEventMarketCollection,
  "coordinate" | "eventId" | "createdAt"
>

/** This evidence can preserve an existing order's collection binding only.
 * It never authorizes a new order, a payment, or a changed pickup graph. */
export function isEventMarketCollectionLifecycleContinuation(input: {
  original: CollectionRevision
  current: ParsedEventMarketCollection
  events: readonly SignedPublicNostrEvent[]
}): boolean {
  const { original, current } = input
  if (
    original.coordinate !== current.coordinate ||
    !current.orderAcceptance ||
    !(
      current.createdAt > original.createdAt ||
      (current.createdAt === original.createdAt &&
        current.eventId.toLowerCase() < original.eventId.toLowerCase())
    )
  )
    return false

  const previousEvent = input.events.find(
    (event) => event.id.toLowerCase() === original.eventId.toLowerCase()
  )
  const currentEvent = input.events.find(
    (event) => event.id.toLowerCase() === current.eventId.toLowerCase()
  )
  if (
    !previousEvent ||
    !currentEvent ||
    !isValidSignedPublicNostrEvent(previousEvent) ||
    !isValidSignedPublicNostrEvent(currentEvent)
  )
    return false

  const previous = parseEventMarketCollectionEvent(previousEvent)
  const next = parseEventMarketCollectionEvent(currentEvent)
  if (
    !previous ||
    !next ||
    previous.coordinate !== original.coordinate ||
    previous.createdAt !== original.createdAt ||
    previous.orderAcceptance === "closed" ||
    next.coordinate !== current.coordinate ||
    next.createdAt !== current.createdAt ||
    next.orderAcceptance !== current.orderAcceptance ||
    previousEvent.content !== currentEvent.content
  )
    return false

  // Preserve every signed field other than the acceptance tag and NIP-01
  // revision metadata. Even a metadata edit takes the normal review path.
  const terms = (event: SignedPublicNostrEvent) =>
    event.tags.filter((tag) => tag[0] !== "conduit_event_market")
  return (
    JSON.stringify(terms(previousEvent)) === JSON.stringify(terms(currentEvent))
  )
}

interface CollectionContinuityDependencies {
  getRetainedEvidence: typeof getRetainedEventMarketCollectionEvidence
  getLocalEvidence: typeof getLocalEventMarketEvidenceSnapshot
  readSettings: typeof readDurableAccountRelaySettingsPlanningSnapshot
  getRelayLists: typeof getRelayLists
  fetchEvents: typeof fetchSignedEventsFanoutDetailed
}

/** Read at most two exact signed collection revisions. Retention establishes
 * their immutable contents, never the current collection's freshness. The
 * caller must separately supply a freshly resolved public pickup graph. */
export async function getEventMarketCollectionLifecycleEvidence(
  input: {
    original: CollectionRevision
    current: ParsedEventMarketCollection
    authenticatedPubkey?: string | null
    accountNetworkLocalStateRepository?: RelayReadOptions["accountNetworkLocalStateRepository"]
    shouldContinue?: RelayReadOptions["shouldContinue"]
    signal?: AbortSignal
  },
  overrides: Partial<CollectionContinuityDependencies> = {}
): Promise<SignedPublicNostrEvent[]> {
  if (
    input.original.eventId === input.current.eventId ||
    input.original.coordinate !== input.current.coordinate ||
    !input.current.orderAcceptance
  )
    return []
  const dependencies = {
    getRetainedEvidence: getRetainedEventMarketCollectionEvidence,
    getLocalEvidence: getLocalEventMarketEvidenceSnapshot,
    readSettings: readDurableAccountRelaySettingsPlanningSnapshot,
    getRelayLists,
    fetchEvents: fetchSignedEventsFanoutDetailed,
    ...overrides,
  }
  const organizer = input.current.authorPubkey
  const ids = new Set(
    [input.original.eventId, input.current.eventId].map((id) =>
      id.toLowerCase()
    )
  )
  const retained = await dependencies.getRetainedEvidence({
    organizerPubkeys: [organizer],
    signal: input.signal,
  })
  const evidence = new Map<string, SignedPublicNostrEvent>()
  const retain = (events: readonly SignedPublicNostrEvent[]) => {
    for (const event of events) {
      if (
        ids.has(event.id.toLowerCase()) &&
        isValidSignedPublicNostrEvent(event)
      ) {
        evidence.set(event.id.toLowerCase(), event)
      }
    }
  }
  if (input.current.signedEvent) retain([input.current.signedEvent])
  retain(retained.events)
  retain(dependencies.getLocalEvidence(organizer).events)
  if (input.signal?.aborted || input.shouldContinue?.() === false) return []
  if (evidence.size === ids.size) return [...evidence.values()]

  const authenticatedPubkey = input.authenticatedPubkey?.trim().toLowerCase()
  let settings: Awaited<
    ReturnType<typeof readDurableAccountRelaySettingsPlanningSnapshot>
  > | null = null
  if (authenticatedPubkey && /^[0-9a-f]{64}$/.test(authenticatedPubkey)) {
    try {
      settings = await dependencies.readSettings(authenticatedPubkey)
    } catch {
      // Unavailable owner settings grant no owner-selected transport authority.
    }
  }
  const ownerSelectedRelayUrls = normalizeOwnerSelectedRelayUrls(
    settings?.settings.entries.flatMap((entry) =>
      entry.readEnabled ||
      (organizer === authenticatedPubkey && entry.writeEnabled)
        ? [entry.url]
        : []
    ) ?? []
  )
  const readOptions = {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    ownerSelectedRelayUrls,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    shouldContinue: input.shouldContinue,
    signal: input.signal,
  }
  const relayLists = await dependencies.getRelayLists([organizer], readOptions)
  const plan = planRelayReads({
    intent: "author_products",
    authors: [organizer],
    relayLists,
    authenticatedPubkey,
    ownerSelectedRelayUrls,
    settings: settings?.settings,
    signedRelayListAuthoritative: settings?.signedRelayListAuthoritative,
    maxRelays: 8,
  })
  const result = await dependencies.fetchEvents(
    {
      kinds: [30405],
      authors: [organizer],
      ids: [...ids].filter((id) => !evidence.has(id)),
      limit: 2,
    },
    {
      ...readOptions,
      relayUrls: plan.relayUrls,
      ownerSelectedRelayUrls: plan.ownerSelectedRelayUrls,
      reuseRelayConnections: true,
    }
  )
  if (input.signal?.aborted || input.shouldContinue?.() === false) return []
  retain(result.events)
  return [...evidence.values()]
}
