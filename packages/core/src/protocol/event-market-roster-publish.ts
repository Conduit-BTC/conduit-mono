import { NDKEvent } from "@nostr-dev-kit/ndk"
import { db, type EventMarketMerchantDecisionJob } from "../db"
import {
  buildEventMarketAuthorizationDraft,
  parseEventMarketAuthorizationEvent,
  type EventMarketAuthorizationRepair,
  type ParsedEventMarketAuthorization,
} from "./event-market-authorization"
import { readEventMarketAuthorization } from "./event-market-authorization-read"
import {
  buildEventMarketCalendarDraft,
  parseAddressableCoordinate,
  parseEventMarketCalendarEvent,
  type EventMarketCalendarDraftInput,
} from "./event-market"
import {
  buildEventMarketRosterDraft,
  parseEventMarketRosterEvent,
  type EventMarketCommerceState,
  type EventMarketMerchantRow,
} from "./event-market-roster"
import { readEventMarketRoster } from "./event-market-roster-read"
import {
  buildEventMarketSeriesDraft,
  parseEventMarketSeriesEvent,
} from "./event-market-schedule"
import { waitForVisibleDocument } from "./interactive-signer"
import { EVENT_KINDS } from "./kinds"
import { getNdk } from "./ndk"
import {
  publishWithPlanner,
  type PublishWithPlannerResult,
} from "./relay-publish"
import {
  compareReplaceableEventFrontiers,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

interface RosterPublishDependencies {
  read: typeof readEventMarketRoster
  sign: (input: {
    draft: ReturnType<typeof buildEventMarketRosterDraft>
    createdAt: number
    organizerPubkey: string
    shouldContinue?: () => boolean
  }) => Promise<SignedPublicNostrEvent>
  publish: (
    event: SignedPublicNostrEvent,
    authorPubkey: string,
    shouldContinue?: () => boolean
  ) => Promise<PublishWithPlannerResult>
}

async function signRoster(input: {
  draft: ReturnType<typeof buildEventMarketRosterDraft>
  createdAt: number
  organizerPubkey: string
  shouldContinue?: () => boolean
}): Promise<SignedPublicNostrEvent> {
  await waitForVisibleDocument()
  if (input.shouldContinue?.() === false)
    throw new Error("Organizer session changed.")
  const ndk = await getNdk()
  if (!ndk.signer) throw new Error("Organizer signer is not connected.")
  const signerPubkey = (await ndk.signer.user()).pubkey.toLowerCase()
  if (signerPubkey !== input.organizerPubkey) {
    throw new Error("Active signer does not match the organizer.")
  }
  const event = new NDKEvent(ndk)
  event.kind = input.draft.kind
  event.tags = input.draft.tags
  event.content = input.draft.content
  event.created_at = input.createdAt
  if (input.shouldContinue?.() === false)
    throw new Error("Organizer session changed.")
  await event.sign(ndk.signer)
  const signed = event.rawEvent() as SignedPublicNostrEvent
  if (
    !isValidSignedPublicNostrEvent(signed) ||
    signed.pubkey !== input.organizerPubkey
  ) {
    throw new Error("Signer returned invalid Event Market evidence.")
  }
  return signed
}

async function publishRoster(
  signedEvent: SignedPublicNostrEvent,
  authorPubkey: string,
  shouldContinue?: () => boolean
): Promise<PublishWithPlannerResult> {
  const ndk = await getNdk()
  return publishWithPlanner(new NDKEvent(ndk, signedEvent), {
    intent: "commerce_author_event",
    authorPubkey,
    authenticatedPubkey: authorPubkey,
    accountPubkey: authorPubkey,
    deliveryMode: "critical",
    shouldContinue,
  })
}

const defaultDependencies: RosterPublishDependencies = {
  read: readEventMarketRoster,
  sign: signRoster,
  publish: publishRoster,
}

/** Content-free per-record relay outcomes for an organizer publication. */
export function summarizeEventMarketPublishDelivery(
  delivery: PublishWithPlannerResult
): {
  acknowledged: number
  rejected: number
  timedOut: number
  otherFailed: number
} {
  const rejected = new Set(delivery.rejectedRelayUrls ?? [])
  const failed = delivery.failedRelayUrls.filter(
    (url) => !delivery.successfulRelayUrls.includes(url)
  )
  const timedOut = failed.filter(
    (url) =>
      !rejected.has(url) &&
      /timeout|acknowledg/i.test(delivery.relayFailureMessages[url] ?? "")
  ).length
  return {
    acknowledged: delivery.successfulRelayUrls.length,
    rejected: [...rejected].filter((url) => failed.includes(url)).length,
    timedOut,
    otherFailed:
      failed.length -
      [...rejected].filter((url) => failed.includes(url)).length -
      timedOut,
  }
}

/** Compare the strongest known signed head before requesting an organizer signature. */
export async function publishEventMarketRoster(
  input: {
    organizerPubkey: string
    authenticatedPubkey: string | null
    dTag: string
    calendarCoordinate: string
    state: EventMarketCommerceState
    merchants: readonly EventMarketMerchantRow[]
    expectedPreviousEventId?: string
    shouldContinue?: () => boolean
    /** Durable exact-retry save. Must finish before any relay publish begins. */
    onSignedLocal: (event: SignedPublicNostrEvent) => Promise<void>
    onDelivery?: (
      delivery: ReturnType<typeof summarizeEventMarketPublishDelivery>
    ) => void
  },
  dependencies: RosterPublishDependencies = defaultDependencies
): Promise<{
  signedEvent: SignedPublicNostrEvent
  delivery: PublishWithPlannerResult
}> {
  const organizerPubkey = input.organizerPubkey.trim().toLowerCase()
  if (
    !/^[0-9a-f]{64}$/.test(organizerPubkey) ||
    input.authenticatedPubkey?.toLowerCase() !== organizerPubkey
  ) {
    throw new Error("The authenticated organizer is required.")
  }
  const coordinate = `30409:${organizerPubkey}:${input.dTag}`
  const current = await dependencies.read({
    reference: coordinate,
    authenticatedPubkey: organizerPubkey,
    shouldContinue: input.shouldContinue,
  })
  if (
    !current.retained ||
    current.resolution.state === "conflicting" ||
    current.resolution.state === "malformed" ||
    current.resolution.state === "deleted"
  ) {
    throw new Error(
      "Current signed Event Market authority needs organizer review."
    )
  }
  const previous =
    current.resolution.state === "current" ? current.resolution.market : null
  if (previous) {
    if (
      previous.eventId !== input.expectedPreviousEventId ||
      previous.calendarCoordinate !== input.calendarCoordinate
    ) {
      throw new Error(
        "The Event Market changed. Review the latest roster before signing."
      )
    }
  } else if (
    current.resolution.state !== "missing" ||
    current.coverage !== "complete" ||
    input.expectedPreviousEventId
  ) {
    throw new Error(
      "The Event Market coordinate could not be confirmed for creation."
    )
  }
  const previousMerchants = new Set(
    previous?.merchants.map((merchant) => merchant.pubkey) ?? []
  )
  const nextMerchants = new Set(
    input.merchants.map((merchant) => merchant.pubkey)
  )
  if (
    previousMerchants.size !== nextMerchants.size ||
    [...previousMerchants].some((merchant) => !nextMerchants.has(merchant))
  ) {
    throw new Error(
      "Merchant membership changes require paired causal authorization."
    )
  }
  const draft = buildEventMarketRosterDraft({
    dTag: input.dTag,
    organizerPubkey,
    calendarCoordinate: input.calendarCoordinate,
    state: input.state,
    merchants: input.merchants,
    ...(previous ? { previousEventId: previous.eventId } : {}),
  })
  const createdAt = Math.max(
    Math.floor(Date.now() / 1_000),
    (previous?.signedEvent.created_at ?? 0) + (previous ? 1 : 0)
  )
  const signedEvent = await dependencies.sign({
    draft,
    createdAt,
    organizerPubkey,
    shouldContinue: input.shouldContinue,
  })
  const parsed = parseEventMarketRosterEvent(signedEvent)
  if (
    !parsed ||
    parsed.coordinate !== coordinate ||
    parsed.createdAt !== createdAt ||
    parsed.calendarCoordinate !== input.calendarCoordinate ||
    parsed.state !== input.state ||
    parsed.previousEventId !== previous?.eventId ||
    JSON.stringify(parsed.merchants) !== JSON.stringify(input.merchants)
  ) {
    throw new Error("Signer changed the Event Market roster draft.")
  }
  await input.onSignedLocal(signedEvent)
  const delivery = await dependencies.publish(
    signedEvent,
    organizerPubkey,
    input.shouldContinue
  )
  input.onDelivery?.(summarizeEventMarketPublishDelivery(delivery))
  if (delivery.successfulRelayUrls.length === 0) {
    throw new Error(
      "The signed Event Market roster was saved for retry but no relay acknowledged it."
    )
  }
  return { signedEvent, delivery }
}

/** Retry the saved immutable signature; never construct another roster revision. */
export async function retryEventMarketRosterDelivery(
  input: {
    signedEvent: SignedPublicNostrEvent
    authenticatedPubkey: string | null
    shouldContinue?: () => boolean
  },
  dependencies: Pick<
    RosterPublishDependencies,
    "read" | "publish"
  > = defaultDependencies
): Promise<PublishWithPlannerResult> {
  const parsed = parseEventMarketRosterEvent(input.signedEvent)
  if (
    !parsed ||
    input.authenticatedPubkey?.toLowerCase() !== parsed.organizerPubkey
  ) {
    throw new Error("The exact signed organizer roster is required for retry.")
  }
  const current = await dependencies.read({
    reference: parsed.coordinate,
    authenticatedPubkey: parsed.organizerPubkey,
    shouldContinue: input.shouldContinue,
  })
  if (
    current.resolution.state === "conflicting" ||
    current.resolution.state === "malformed" ||
    current.resolution.state === "deleted" ||
    (current.resolution.state === "current" &&
      current.resolution.market.eventId !== parsed.eventId &&
      compareReplaceableEventFrontiers(
        {
          createdAt: current.resolution.market.signedEvent.created_at,
          eventId: current.resolution.market.eventId,
        },
        { createdAt: parsed.signedEvent.created_at, eventId: parsed.eventId }
      ) > 0)
  ) {
    throw new Error("A newer signed Event Market roster superseded this retry.")
  }
  return dependencies.publish(
    input.signedEvent,
    parsed.organizerPubkey,
    input.shouldContinue
  )
}

/** Publish a NIP-52 calendar without creating a legacy collection or pickup record. */
export async function publishFutureEventMarketCalendar(input: {
  organizerPubkey: string
  authenticatedPubkey: string | null
  calendar: EventMarketCalendarDraftInput
  /** Supply the market coordinate and exact observed calendar head for edits. */
  marketCoordinate?: string
  expectedPreviousEventId?: string
  /** Previous signed calendar creation time in milliseconds. */
  previousCreatedAt?: number
  shouldContinue?: () => boolean
  onSignedLocal: (event: SignedPublicNostrEvent) => Promise<void>
}): Promise<{
  signedEvent: SignedPublicNostrEvent
  delivery: PublishWithPlannerResult
}> {
  const organizerPubkey = input.organizerPubkey.toLowerCase()
  if (
    !/^[0-9a-f]{64}$/.test(organizerPubkey) ||
    input.authenticatedPubkey?.toLowerCase() !== organizerPubkey
  )
    throw new Error("The authenticated organizer is required.")
  const draft = buildEventMarketCalendarDraft(input.calendar)
  let observedPreviousCreatedAt = 0
  if (input.marketCoordinate) {
    const read = await readEventMarketRoster({
      reference: input.marketCoordinate,
      authenticatedPubkey: organizerPubkey,
      shouldContinue: input.shouldContinue,
    })
    if (
      read.resolution.state !== "current" ||
      !read.calendar ||
      read.calendarCoverage === "stale" ||
      read.calendarCoverage === "unavailable" ||
      read.calendar.eventId !== input.expectedPreviousEventId ||
      read.calendar.coordinate !==
        `${draft.kind}:${organizerPubkey}:${input.calendar.dTag}`
    )
      throw new Error(
        "Calendar changed. Review the latest signed event before editing."
      )
    observedPreviousCreatedAt = read.calendar.createdAt
  } else if (input.expectedPreviousEventId) {
    throw new Error("Calendar edits require the current market reference.")
  }
  const createdAt = Math.max(
    Math.floor(Date.now() / 1_000),
    Math.floor(observedPreviousCreatedAt / 1_000) +
      (observedPreviousCreatedAt ? 1 : 0),
    input.previousCreatedAt === undefined
      ? 0
      : Math.floor(input.previousCreatedAt / 1_000) + 1
  )
  const signedEvent = await signRoster({
    draft,
    createdAt,
    organizerPubkey,
    shouldContinue: input.shouldContinue,
  })
  const parsed = parseEventMarketCalendarEvent(signedEvent)
  if (
    !parsed ||
    parsed.coordinate !==
      `${draft.kind}:${organizerPubkey}:${input.calendar.dTag}` ||
    signedEvent.created_at !== createdAt ||
    JSON.stringify(signedEvent.tags) !== JSON.stringify(draft.tags) ||
    signedEvent.content !== draft.content
  )
    throw new Error("Signer changed the calendar draft.")
  await input.onSignedLocal(signedEvent)
  const delivery = await publishRoster(
    signedEvent,
    organizerPubkey,
    input.shouldContinue
  )
  if (delivery.successfulRelayUrls.length === 0)
    throw new Error(
      "The signed calendar was saved for retry but no relay acknowledged it."
    )
  return { signedEvent, delivery }
}

/** Publish new concrete NIP-52 dates before the signed finite calendar that lists them. */
export async function publishFutureEventMarketSeries(
  input: {
    organizerPubkey: string
    authenticatedPubkey: string | null
    scheduleDTag: string
    title: string
    newOccurrences: readonly EventMarketCalendarDraftInput[]
    /** Existing coordinates to retain on an extension, in their current order. */
    retainedMemberCoordinates?: readonly string[]
    /** Explicit future members to remove from a current schedule. */
    removedMemberCoordinates?: readonly string[]
    marketCoordinate?: string
    expectedPreviousEventId?: string
    shouldContinue?: () => boolean
    onSignedLocal: (event: SignedPublicNostrEvent) => Promise<void>
    onProgress?: (progress: {
      record: "occurrence" | "schedule"
      index?: number
      total: number
      phase: "signing" | "signed" | "publishing" | "acknowledged"
    }) => void
    onDelivery?: (outcome: {
      record: "occurrence" | "schedule"
      index?: number
      delivery: ReturnType<typeof summarizeEventMarketPublishDelivery>
    }) => void
    /** Previously saved records resume with their identical signed bytes. */
    savedSignedEvents?: readonly SignedPublicNostrEvent[]
  },
  dependencies: RosterPublishDependencies = defaultDependencies
): Promise<{
  occurrences: Array<{
    signedEvent: SignedPublicNostrEvent
    delivery: PublishWithPlannerResult
  }>
  schedule: {
    signedEvent: SignedPublicNostrEvent
    delivery: PublishWithPlannerResult
  }
}> {
  const organizerPubkey = input.organizerPubkey.toLowerCase()
  if (
    !/^[0-9a-f]{64}$/.test(organizerPubkey) ||
    input.authenticatedPubkey?.toLowerCase() !== organizerPubkey ||
    input.newOccurrences.length > 32
  )
    throw new Error(
      "The authenticated organizer and at most 32 new dates are required."
    )
  const scheduleCoordinate = `${EVENT_KINDS.CALENDAR}:${organizerPubkey}:${input.scheduleDTag}`
  let previousCreatedAt = 0
  let currentMembers: string[] = []
  let currentOccurrences: Array<{ coordinate: string; end: number }> = []
  if (input.marketCoordinate) {
    const read = await dependencies.read({
      reference: input.marketCoordinate,
      authenticatedPubkey: organizerPubkey,
      shouldContinue: input.shouldContinue,
    })
    if (
      read.resolution.state !== "current" ||
      read.resolution.market.organizerPubkey !== organizerPubkey ||
      read.resolution.market.calendarCoordinate !== scheduleCoordinate ||
      read.schedule?.kind !== "series" ||
      read.calendarCoverage !== "complete" ||
      read.schedule.series.eventId !== input.expectedPreviousEventId
    )
      throw new Error(
        "Schedule changed. Review the latest signed dates before editing."
      )
    previousCreatedAt = read.schedule.series.createdAt
    currentMembers = read.schedule.series.memberCoordinates
    currentOccurrences = read.schedule.occurrences.map((entry) => ({
      coordinate: entry.occurrence.coordinate,
      end: entry.occurrence.end,
    }))
  } else if (input.expectedPreviousEventId) {
    throw new Error("Schedule edits require the current market reference.")
  }
  const removed = new Set(input.removedMemberCoordinates ?? [])
  if (
    [...removed].some(
      (coordinate) =>
        !currentMembers.includes(coordinate) ||
        !currentOccurrences.some(
          (entry) => entry.coordinate === coordinate && entry.end > Date.now()
        )
    ) ||
    (input.retainedMemberCoordinates ?? []).some(
      (coordinate) =>
        !currentMembers.includes(coordinate) || removed.has(coordinate)
    ) ||
    currentMembers.some(
      (coordinate) =>
        !removed.has(coordinate) &&
        !(input.retainedMemberCoordinates ?? []).includes(coordinate)
    )
  )
    throw new Error("Review the current schedule before removing dates.")
  const occurrenceDrafts = input.newOccurrences.map(
    buildEventMarketCalendarDraft
  )
  const newCoordinates = input.newOccurrences.map(
    (occurrence, index) =>
      `${occurrenceDrafts[index]!.kind}:${organizerPubkey}:${occurrence.dTag}`
  )
  const memberCoordinates = [
    ...(input.retainedMemberCoordinates ?? []),
    ...newCoordinates,
  ]
  const draft = buildEventMarketSeriesDraft({
    dTag: input.scheduleDTag,
    organizerPubkey,
    title: input.title,
    memberCoordinates,
  })
  const expectedDrafts = new Map([
    ...occurrenceDrafts.map(
      (occurrenceDraft, index) =>
        [newCoordinates[index]!, occurrenceDraft] as const
    ),
    [scheduleCoordinate, draft] as const,
  ])
  const saved = new Map<string, SignedPublicNostrEvent>()
  for (const event of input.savedSignedEvents ?? []) {
    if (!isValidSignedPublicNostrEvent(event)) continue
    const coordinate = `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}`
    const expected = expectedDrafts.get(coordinate)
    if (
      !expected ||
      JSON.stringify(event.tags) !== JSON.stringify(expected.tags) ||
      event.content !== expected.content
    )
      continue
    const prior = saved.get(coordinate)
    if (prior && prior.id !== event.id)
      throw new Error(
        "Multiple saved signatures for one prepared date need organizer review."
      )
    saved.set(coordinate, event)
  }
  const occurrences: Array<{
    signedEvent: SignedPublicNostrEvent
    delivery: PublishWithPlannerResult
  }> = []
  for (const [index, occurrenceDraft] of occurrenceDrafts.entries()) {
    input.onProgress?.({
      record: "occurrence",
      index: index + 1,
      total: occurrenceDrafts.length,
      phase: "signing",
    })
    const coordinate = newCoordinates[index]!
    const prior = saved.get(coordinate)
    const signedEvent =
      prior ??
      (await dependencies.sign({
        draft: occurrenceDraft,
        createdAt: Math.floor(Date.now() / 1_000),
        organizerPubkey,
        shouldContinue: input.shouldContinue,
      }))
    const parsed = parseEventMarketCalendarEvent(signedEvent)
    if (
      !parsed ||
      parsed.coordinate !== coordinate ||
      JSON.stringify(signedEvent.tags) !==
        JSON.stringify(occurrenceDraft.tags) ||
      signedEvent.content !== occurrenceDraft.content
    )
      throw new Error(
        "Saved or signer-provided occurrence differs from the prepared date."
      )
    if (!prior) await input.onSignedLocal(signedEvent)
    input.onProgress?.({
      record: "occurrence",
      index: index + 1,
      total: occurrenceDrafts.length,
      phase: "signed",
    })
    input.onProgress?.({
      record: "occurrence",
      index: index + 1,
      total: occurrenceDrafts.length,
      phase: "publishing",
    })
    const delivery = await dependencies.publish(
      signedEvent,
      organizerPubkey,
      input.shouldContinue
    )
    occurrences.push({ signedEvent, delivery })
    input.onDelivery?.({
      record: "occurrence",
      index: index + 1,
      delivery: summarizeEventMarketPublishDelivery(delivery),
    })
    if (delivery.successfulRelayUrls.length === 0)
      throw new Error(
        "A signed date was saved for exact retry but no relay acknowledged it."
      )
    input.onProgress?.({
      record: "occurrence",
      index: index + 1,
      total: occurrenceDrafts.length,
      phase: "acknowledged",
    })
  }
  input.onProgress?.({
    record: "schedule",
    total: occurrenceDrafts.length,
    phase: "signing",
  })
  const savedSchedule = saved.get(scheduleCoordinate)
  const signedSchedule =
    savedSchedule ??
    (await dependencies.sign({
      draft,
      createdAt: Math.max(
        Math.floor(Date.now() / 1_000),
        Math.floor(previousCreatedAt / 1_000) + (previousCreatedAt ? 1 : 0)
      ),
      organizerPubkey,
      shouldContinue: input.shouldContinue,
    }))
  const parsedSchedule = parseEventMarketSeriesEvent(signedSchedule)
  if (
    !parsedSchedule ||
    parsedSchedule.coordinate !== scheduleCoordinate ||
    (savedSchedule &&
      previousCreatedAt > 0 &&
      signedSchedule.created_at <= Math.floor(previousCreatedAt / 1_000)) ||
    JSON.stringify(signedSchedule.tags) !== JSON.stringify(draft.tags) ||
    signedSchedule.content !== draft.content
  )
    throw new Error(
      "Saved or signer-provided schedule differs from the prepared dates."
    )
  if (!savedSchedule) await input.onSignedLocal(signedSchedule)
  input.onProgress?.({
    record: "schedule",
    total: occurrenceDrafts.length,
    phase: "signed",
  })
  input.onProgress?.({
    record: "schedule",
    total: occurrenceDrafts.length,
    phase: "publishing",
  })
  const scheduleDelivery = await dependencies.publish(
    signedSchedule,
    organizerPubkey,
    input.shouldContinue
  )
  input.onDelivery?.({
    record: "schedule",
    delivery: summarizeEventMarketPublishDelivery(scheduleDelivery),
  })
  if (scheduleDelivery.successfulRelayUrls.length === 0)
    throw new Error(
      "The signed schedule was saved for exact retry but no relay acknowledged it."
    )
  input.onProgress?.({
    record: "schedule",
    total: occurrenceDrafts.length,
    phase: "acknowledged",
  })
  return {
    occurrences,
    schedule: { signedEvent: signedSchedule, delivery: scheduleDelivery },
  }
}

/** Replace one listed occurrence without changing the market or its member list. */
export async function publishFutureEventMarketOccurrenceRevision(input: {
  marketCoordinate: string
  organizerPubkey: string
  authenticatedPubkey: string | null
  expectedPreviousEventId: string
  calendar: EventMarketCalendarDraftInput
  /** Saved signature from an interrupted attempt; publish its identical bytes. */
  savedSignedEvent?: SignedPublicNostrEvent
  shouldContinue?: () => boolean
  onSignedLocal: (event: SignedPublicNostrEvent) => Promise<void>
  onDelivery?: (
    delivery: ReturnType<typeof summarizeEventMarketPublishDelivery>
  ) => void
}): Promise<{
  signedEvent: SignedPublicNostrEvent
  delivery: PublishWithPlannerResult
}> {
  const organizerPubkey = input.organizerPubkey.toLowerCase()
  if (
    !/^[0-9a-f]{64}$/.test(organizerPubkey) ||
    input.authenticatedPubkey?.toLowerCase() !== organizerPubkey
  )
    throw new Error("The authenticated organizer is required.")
  const draft = buildEventMarketCalendarDraft(input.calendar)
  const occurrenceCoordinate = `${draft.kind}:${organizerPubkey}:${input.calendar.dTag}`
  const read = await readEventMarketRoster({
    reference: input.marketCoordinate,
    authenticatedPubkey: organizerPubkey,
    shouldContinue: input.shouldContinue,
  })
  const current =
    read.schedule?.kind === "series"
      ? read.schedule.occurrences.find(
          (entry) => entry.occurrence.coordinate === occurrenceCoordinate
        )
      : undefined
  if (
    read.resolution.state !== "current" ||
    read.calendarCoverage !== "complete" ||
    read.schedule?.kind !== "series" ||
    !current ||
    current.coverage !== "complete" ||
    (current.occurrence.eventId !== input.expectedPreviousEventId &&
      current.occurrence.eventId !== input.savedSignedEvent?.id) ||
    current.occurrence.end <= Date.now()
  )
    throw new Error(
      "Occurrence changed. Review the latest signed date before editing."
    )
  const createdAt = Math.max(
    Math.floor(Date.now() / 1_000),
    Math.floor(current.occurrence.createdAt / 1_000) + 1
  )
  const signedEvent =
    input.savedSignedEvent ??
    (await signRoster({
      draft,
      createdAt,
      organizerPubkey,
      shouldContinue: input.shouldContinue,
    }))
  const parsed = parseEventMarketCalendarEvent(signedEvent)
  if (
    !parsed ||
    parsed.coordinate !== occurrenceCoordinate ||
    (!input.savedSignedEvent && signedEvent.created_at !== createdAt) ||
    (input.savedSignedEvent &&
      current.occurrence.eventId !== signedEvent.id &&
      signedEvent.created_at <=
        Math.floor(current.occurrence.createdAt / 1_000)) ||
    JSON.stringify(signedEvent.tags) !== JSON.stringify(draft.tags) ||
    signedEvent.content !== draft.content
  )
    throw new Error("Signer changed the selected occurrence.")
  if (!input.savedSignedEvent) await input.onSignedLocal(signedEvent)
  const delivery = await publishRoster(
    signedEvent,
    organizerPubkey,
    input.shouldContinue
  )
  input.onDelivery?.(summarizeEventMarketPublishDelivery(delivery))
  if (delivery.successfulRelayUrls.length === 0)
    throw new Error(
      "The signed occurrence was saved for exact retry but no relay acknowledged it."
    )
  return { signedEvent, delivery }
}

export interface SignedEventMarketMerchantDecision {
  action: "approve" | "revoke"
  roster: SignedPublicNostrEvent
  authorization: SignedPublicNostrEvent
}

/** List exact, unfinished local organizer decisions for the recovery surface. */
export async function listPendingEventMarketMerchantDecisions(
  marketCoordinate: string
): Promise<EventMarketMerchantDecisionJob[]> {
  const market = parseAddressableCoordinate(marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (!market || market.coordinate !== marketCoordinate) return []
  return (
    await db.eventMarketMerchantDecisionJobs
      .where("marketCoordinate")
      .equals(market.coordinate)
      .toArray()
  )
    .filter((job) => job.status === "pending")
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 64)
}

interface MerchantDecisionDependencies extends RosterPublishDependencies {
  readAuthorization: typeof readEventMarketAuthorization
  persist: (decision: SignedEventMarketMerchantDecision) => Promise<void>
  load: (id: string) => Promise<EventMarketMerchantDecisionJob | undefined>
  acknowledge: (id: string) => Promise<void>
}

const merchantDecisionDependencies: MerchantDecisionDependencies = {
  ...defaultDependencies,
  readAuthorization: readEventMarketAuthorization,
  persist: async (decision) => {
    const authorization = parseEventMarketAuthorizationEvent(
      decision.authorization
    )
    if (!authorization) throw new Error("Signed merchant decision is invalid.")
    const now = Date.now()
    await db.eventMarketMerchantDecisionJobs.put({
      id: authorization.eventId,
      marketCoordinate: authorization.marketCoordinate,
      merchantPubkey: authorization.merchantPubkey,
      action: decision.action,
      roster: decision.roster,
      authorization: decision.authorization,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
  },
  load: (id) => db.eventMarketMerchantDecisionJobs.get(id),
  acknowledge: async (id) => {
    await db.eventMarketMerchantDecisionJobs.update(id, {
      status: "acknowledged",
      updatedAt: Date.now(),
    })
  },
}

function authorizationTips(
  resolution: Awaited<
    ReturnType<typeof readEventMarketAuthorization>
  >["resolution"]
): ParsedEventMarketAuthorization[] {
  if (resolution.state === "missing") return []
  if (resolution.state === "active" || resolution.state === "revoked")
    return [resolution.tip]
  if (resolution.state === "deleted" || resolution.state === "conflicting")
    return resolution.tips
  throw new Error("Merchant authorization needs organizer review.")
}

/** Sign and durably save both organizer authorities before publishing either one. */
export async function publishEventMarketMerchantDecision(
  input: {
    organizerPubkey: string
    authenticatedPubkey: string | null
    dTag: string
    calendarCoordinate: string
    merchantPubkey: string
    action: "approve" | "revoke"
    row?: EventMarketMerchantRow
    expectedPreviousEventId: string
    expectedAuthorizationTipIds: readonly string[]
    shouldContinue?: () => boolean
    onSignedLocal?: (
      decision: SignedEventMarketMerchantDecision
    ) => Promise<void>
  },
  dependencies: MerchantDecisionDependencies = merchantDecisionDependencies
): Promise<{
  signed: SignedEventMarketMerchantDecision
  rosterDelivery: PublishWithPlannerResult
  authorizationDelivery: PublishWithPlannerResult
}> {
  const organizerPubkey = input.organizerPubkey.toLowerCase()
  if (
    !/^[0-9a-f]{64}$/.test(organizerPubkey) ||
    input.authenticatedPubkey?.toLowerCase() !== organizerPubkey ||
    !/^[0-9a-f]{64}$/.test(input.merchantPubkey) ||
    (input.action === "approve" &&
      input.row?.pubkey !== input.merchantPubkey) ||
    (input.action === "revoke" && input.row !== undefined)
  )
    throw new Error(
      "The authenticated organizer and merchant decision are required."
    )
  const coordinate = `30409:${organizerPubkey}:${input.dTag}`
  const [marketRead, authorizationRead] = await Promise.all([
    dependencies.read({
      reference: coordinate,
      authenticatedPubkey: organizerPubkey,
      shouldContinue: input.shouldContinue,
    }),
    dependencies.readAuthorization({
      marketCoordinate: coordinate,
      merchantPubkey: input.merchantPubkey,
      authenticatedPubkey: organizerPubkey,
      shouldContinue: input.shouldContinue,
    }),
  ])
  if (
    !marketRead.retained ||
    marketRead.coverage !== "complete" ||
    marketRead.resolution.state !== "current" ||
    marketRead.resolution.market.eventId !== input.expectedPreviousEventId ||
    marketRead.resolution.market.calendarCoordinate !==
      input.calendarCoordinate ||
    !authorizationRead.retained ||
    authorizationRead.coverage !== "complete"
  )
    throw new Error(
      "Current signed Event Market authority needs organizer review."
    )
  const market = marketRead.resolution.market
  const parents = authorizationTips(authorizationRead.resolution)
  const parentIds = parents.map((parent) => parent.eventId).sort()
  if (
    JSON.stringify(parentIds) !==
    JSON.stringify([...input.expectedAuthorizationTipIds].sort())
  )
    throw new Error("Merchant authorization changed. Review it before signing.")
  const existingRow = market.merchants.find(
    (row) => row.pubkey === input.merchantPubkey
  )
  if (input.action === "approve") {
    if (
      existingRow ||
      authorizationRead.resolution.state === "active" ||
      (authorizationRead.resolution.state === "deleted" &&
        parents.some((parent) => parent.state !== "revoked"))
    )
      throw new Error(
        "Merchant reapproval needs a revoked tip and removed row."
      )
  } else if (authorizationRead.resolution.state === "missing") {
    throw new Error("Merchant revocation needs an observed authorization tip.")
  }
  const nextRows = market.merchants.filter(
    (row) => row.pubkey !== input.merchantPubkey
  )
  if (input.action === "approve") nextRows.push(input.row!)
  const repairs: EventMarketAuthorizationRepair[] = []
  if (authorizationRead.resolution.state === "deleted") {
    const observedIds = new Set(
      authorizationRead.observedEvidence
        .filter((event) => event.kind === EVENT_KINDS.EVENT_MARKET_AUTH)
        .map((event) => event.id)
    )
    for (const deletion of authorizationRead.observedEvidence.filter(
      (event) => event.kind === EVENT_KINDS.DELETION
    )) {
      for (const tag of deletion.tags.filter((tag) => tag[0] === "e")) {
        if (!observedIds.has(tag[1] ?? ""))
          throw new Error(
            "Deleted merchant authorization needs organizer review."
          )
        repairs.push({ deletionId: deletion.id, targetId: tag[1]! })
      }
    }
  }
  const rosterDraft = buildEventMarketRosterDraft({
    dTag: input.dTag,
    organizerPubkey,
    calendarCoordinate: input.calendarCoordinate,
    state: market.state,
    merchants: nextRows,
    previousEventId: market.eventId,
  })
  const authorizationDraft = buildEventMarketAuthorizationDraft({
    marketCoordinate: coordinate,
    merchantPubkey: input.merchantPubkey,
    state: input.action === "approve" ? "active" : "revoked",
    sequence:
      parents.length === 0
        ? 0
        : 1 + Math.max(...parents.map((parent) => parent.sequence)),
    parentIds,
    repairs,
  })
  const createdAt = Math.max(
    Math.floor(Date.now() / 1_000),
    market.createdAt + 1,
    ...parents.map((parent) => parent.signedEvent.created_at + 1)
  )
  const roster = await dependencies.sign({
    draft: rosterDraft,
    createdAt,
    organizerPubkey,
    shouldContinue: input.shouldContinue,
  })
  const authorization = await dependencies.sign({
    draft: authorizationDraft,
    createdAt,
    organizerPubkey,
    shouldContinue: input.shouldContinue,
  })
  const parsedRoster = parseEventMarketRosterEvent(roster)
  const parsedAuth = parseEventMarketAuthorizationEvent(authorization)
  if (
    !parsedRoster ||
    !parsedAuth ||
    JSON.stringify(roster.tags) !== JSON.stringify(rosterDraft.tags) ||
    JSON.stringify(authorization.tags) !==
      JSON.stringify(authorizationDraft.tags) ||
    roster.content !== rosterDraft.content ||
    authorization.content !== authorizationDraft.content ||
    roster.created_at !== createdAt ||
    authorization.created_at !== createdAt ||
    parsedRoster.coordinate !== coordinate ||
    parsedRoster.previousEventId !== market.eventId ||
    parsedAuth.marketCoordinate !== coordinate ||
    parsedAuth.merchantPubkey !== input.merchantPubkey ||
    JSON.stringify(parsedAuth.parentIds) !== JSON.stringify(parentIds)
  )
    throw new Error("Signer changed the Event Market merchant decision.")
  const signed = { action: input.action, roster, authorization }
  await dependencies.persist(signed)
  await input.onSignedLocal?.(signed)
  const first = input.action === "approve" ? roster : authorization
  const second = input.action === "approve" ? authorization : roster
  let firstDelivery: PublishWithPlannerResult | undefined
  let secondDelivery: PublishWithPlannerResult | undefined
  try {
    firstDelivery = await dependencies.publish(
      first,
      organizerPubkey,
      input.shouldContinue
    )
  } catch {
    /* The exact pair remains saved for retry. */
  }
  if (input.shouldContinue?.() === false)
    throw new Error(
      "Organizer session changed during merchant decision delivery."
    )
  try {
    secondDelivery = await dependencies.publish(
      second,
      organizerPubkey,
      input.shouldContinue
    )
  } catch {
    /* The exact pair remains saved for retry. */
  }
  if (
    !firstDelivery?.successfulRelayUrls.length ||
    !secondDelivery?.successfulRelayUrls.length
  )
    throw new Error(
      "The signed merchant decision was saved for retry but both relay events were not acknowledged."
    )
  await dependencies.acknowledge(authorization.id)
  return {
    signed,
    rosterDelivery: input.action === "approve" ? firstDelivery : secondDelivery,
    authorizationDelivery:
      input.action === "approve" ? secondDelivery : firstDelivery,
  }
}

/** Replay the saved pair only while its observed parent and tip still match. */
export async function retryEventMarketMerchantDecisionDelivery(
  input: {
    decisionId: string
    authenticatedPubkey: string | null
    shouldContinue?: () => boolean
  },
  dependencies: MerchantDecisionDependencies = merchantDecisionDependencies
): Promise<{
  rosterDelivery: PublishWithPlannerResult
  authorizationDelivery: PublishWithPlannerResult
}> {
  const job = await dependencies.load(input.decisionId)
  if (!job || job.status !== "pending")
    throw new Error("Saved merchant decision is unavailable for retry.")
  const roster = parseEventMarketRosterEvent(job.roster)
  const authorization = parseEventMarketAuthorizationEvent(job.authorization)
  if (
    !roster ||
    !authorization ||
    job.id !== authorization.eventId ||
    job.marketCoordinate !== roster.coordinate ||
    job.merchantPubkey !== authorization.merchantPubkey ||
    input.authenticatedPubkey?.toLowerCase() !== roster.organizerPubkey ||
    roster.coordinate !== authorization.marketCoordinate ||
    Boolean(
      roster.merchants.some(
        (row) => row.pubkey === authorization.merchantPubkey
      )
    ) !==
      (job.action === "approve") ||
    !roster.previousEventId
  )
    throw new Error("The exact signed merchant decision is required for retry.")
  const [marketRead, authRead] = await Promise.all([
    dependencies.read({
      reference: roster.coordinate,
      authenticatedPubkey: roster.organizerPubkey,
      shouldContinue: input.shouldContinue,
    }),
    dependencies.readAuthorization({
      marketCoordinate: roster.coordinate,
      merchantPubkey: authorization.merchantPubkey,
      authenticatedPubkey: roster.organizerPubkey,
      shouldContinue: input.shouldContinue,
    }),
  ])
  if (
    !marketRead.retained ||
    marketRead.resolution.state !== "current" ||
    ![roster.eventId, roster.previousEventId].includes(
      marketRead.resolution.market.eventId
    ) ||
    !authRead.retained
  )
    throw new Error(
      "A newer or invalid signed Event Market roster blocks this retry."
    )
  if (authRead.resolution.state === "deleted") {
    if (
      authRead.resolution.tips.some(
        (tip) => tip.eventId === authorization.eventId
      )
    )
      throw new Error("Deleted merchant authorization blocks this retry.")
    const observedTargets = authRead.observedEvidence
      .filter((event) => event.kind === EVENT_KINDS.DELETION)
      .flatMap((event) =>
        event.tags
          .filter((tag) => tag[0] === "e")
          .map((tag) => ({ deletionId: event.id, targetId: tag[1] ?? "" }))
      )
    if (
      observedTargets.some(
        (pair) =>
          !authorization.repairs.some(
            (repair) =>
              repair.deletionId === pair.deletionId &&
              repair.targetId === pair.targetId
          )
      )
    )
      throw new Error("Deleted merchant authorization blocks this retry.")
  }
  const currentTips = authorizationTips(authRead.resolution).map(
    (tip) => tip.eventId
  )
  const savedIsTip =
    currentTips.length === 1 && currentTips[0] === authorization.eventId
  const observedParents =
    currentTips.length === authorization.parentIds.length &&
    currentTips.every((id) => authorization.parentIds.includes(id))
  if (!savedIsTip && !observedParents)
    throw new Error(
      "A newer or invalid merchant authorization blocks this retry."
    )
  const first = job.action === "approve" ? job.roster : job.authorization
  const second = job.action === "approve" ? job.authorization : job.roster
  const firstDelivery = await dependencies.publish(
    first,
    roster.organizerPubkey,
    input.shouldContinue
  )
  const secondDelivery = await dependencies.publish(
    second,
    roster.organizerPubkey,
    input.shouldContinue
  )
  if (
    !firstDelivery.successfulRelayUrls.length ||
    !secondDelivery.successfulRelayUrls.length
  )
    throw new Error("The signed merchant decision remains saved for retry.")
  await dependencies.acknowledge(job.id)
  return {
    rosterDelivery: job.action === "approve" ? firstDelivery : secondDelivery,
    authorizationDelivery:
      job.action === "approve" ? secondDelivery : firstDelivery,
  }
}
