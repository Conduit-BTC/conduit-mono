import {
  getEventMarketReadPlan,
  getLocalEventMarketEvidenceSnapshot,
  getRetainedEventMarketCollectionLifecycleEvidence,
  isEventMarketAddressableRevisionDeleted,
  parseEventMarketCollectionEvent,
  type ParsedEventMarketCollection,
} from "./event-market"
import { EVENT_KINDS } from "./kinds"
import {
  fetchSignedEventsFanoutDetailed,
  type RelayReadOptions,
} from "./relay-reader"
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

  if (
    isEventMarketAddressableRevisionDeleted(original, input.events) ||
    isEventMarketAddressableRevisionDeleted(current, input.events)
  ) {
    return false
  }

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
  getRetainedEvidence: typeof getRetainedEventMarketCollectionLifecycleEvidence
  getLocalEvidence: typeof getLocalEventMarketEvidenceSnapshot
  getReadPlan: typeof getEventMarketReadPlan
  fetchEvents: typeof fetchSignedEventsFanoutDetailed
}

/** Read two exact signed collection revisions and bounded deletion evidence.
 * Retention establishes immutable contents or revocation, never the current
 * collection's freshness. The caller must separately supply a freshly
 * resolved public pickup graph. */
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
    getRetainedEvidence: getRetainedEventMarketCollectionLifecycleEvidence,
    getLocalEvidence: getLocalEventMarketEvidenceSnapshot,
    getReadPlan: getEventMarketReadPlan,
    fetchEvents: fetchSignedEventsFanoutDetailed,
    ...overrides,
  }
  const organizer = input.current.authorPubkey
  const ids = new Set(
    [input.original.eventId, input.current.eventId].map((id) =>
      id.toLowerCase()
    )
  )
  const revisions = [input.original, input.current]
  const retained = await dependencies.getRetainedEvidence({
    organizerPubkey: organizer,
    revisions,
    signal: input.signal,
  })
  const evidence = new Map<string, SignedPublicNostrEvent>()
  const retain = (events: readonly SignedPublicNostrEvent[]) => {
    for (const event of events) {
      if (!isValidSignedPublicNostrEvent(event)) continue
      const relevantDeletion =
        event.kind === EVENT_KINDS.DELETION &&
        revisions.some((revision) =>
          isEventMarketAddressableRevisionDeleted(revision, [event])
        )
      if (ids.has(event.id.toLowerCase()) || relevantDeletion) {
        evidence.set(event.id.toLowerCase(), event)
      }
    }
  }
  if (input.current.signedEvent) retain([input.current.signedEvent])
  retain(retained.events)
  retain(dependencies.getLocalEvidence(organizer).events)
  if (input.signal?.aborted || input.shouldContinue?.() === false) return []
  const hasKnownDeletion = () =>
    [...evidence.values()].some(
      (event) =>
        event.kind === EVENT_KINDS.DELETION &&
        revisions.some((revision) =>
          isEventMarketAddressableRevisionDeleted(revision, [event])
        )
    )
  if (hasKnownDeletion()) return [...evidence.values()]

  const authenticatedPubkey = input.authenticatedPubkey?.trim().toLowerCase()
  const plan = await dependencies.getReadPlan({
    organizerPubkey: organizer,
    authenticatedPubkey,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    shouldContinue: input.shouldContinue,
    signal: input.signal,
  })
  if (input.signal?.aborted || input.shouldContinue?.() === false) return []
  const fetchOptions = {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    relayUrls: plan.candidateRelayUrls,
    maxRelayAttempts: plan.maxRelayAttempts,
    ownerSelectedRelayUrls: plan.ownerSelectedRelayUrls,
    appRelayUrls: plan.appRelayUrls,
    personalRelayUrls: plan.personalRelayUrls,
    independentRelayUrls: plan.independentRelayUrls,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    shouldContinue: input.shouldContinue,
    signal: input.signal,
    reuseRelayConnections: true,
  }
  const missingRevisionIds = [...ids].filter((id) => !evidence.has(id))
  if (missingRevisionIds.length > 0) {
    const result = await dependencies.fetchEvents(
      {
        kinds: [30405],
        authors: [organizer],
        ids: missingRevisionIds,
        limit: 2,
      },
      fetchOptions
    )
    if (input.signal?.aborted || input.shouldContinue?.() === false) return []
    retain(result.events)
  }

  for (const filter of [
    {
      kinds: [EVENT_KINDS.DELETION],
      authors: [organizer],
      "#e": [...ids],
      limit: 500,
    },
    {
      kinds: [EVENT_KINDS.DELETION],
      authors: [organizer],
      "#a": [input.original.coordinate],
      limit: 500,
    },
  ]) {
    const deletionResult = await dependencies.fetchEvents(filter, fetchOptions)
    if (input.signal?.aborted || input.shouldContinue?.() === false) return []
    retain(deletionResult.events)
  }
  return [...evidence.values()]
}
