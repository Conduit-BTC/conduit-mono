import { NDKEvent } from "@nostr-dev-kit/ndk"
import { db, type EventMarketMerchantDecisionJob } from "../db"
import { parseAddressableCoordinate } from "./event-market"
import { EVENT_KINDS } from "./kinds"
import {
  buildEventMarketAuthorizationDraft,
  parseEventMarketAuthorizationEvent,
  type EventMarketAuthorizationRepair,
  type ParsedEventMarketAuthorization,
} from "./event-market-authorization"
import {
  buildEventMarketRosterDraft,
  parseEventMarketRosterEvent,
  type EventMarketCommerceState,
  type EventMarketMerchantRow,
} from "./event-market-roster"
import {
  readEventMarketAuthorization,
  readEventMarketRoster,
} from "./event-market-roster-read"
import { waitForVisibleDocument } from "./interactive-signer"
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

interface MerchantDecisionDependencies extends RosterPublishDependencies {
  readAuthorization: typeof readEventMarketAuthorization
  persist: typeof persistMerchantDecision
  load: typeof loadEventMarketMerchantDecision
  acknowledge: typeof acknowledgeMerchantDecision
}

export interface SignedEventMarketMerchantDecision {
  action: "approve" | "revoke"
  roster: SignedPublicNostrEvent
  authorization: SignedPublicNostrEvent
}

async function persistMerchantDecision(
  signed: SignedEventMarketMerchantDecision
): Promise<void> {
  const authorization = parseEventMarketAuthorizationEvent(signed.authorization)
  const roster = parseEventMarketRosterEvent(signed.roster)
  if (
    !authorization ||
    !roster ||
    authorization.marketCoordinate !== roster.coordinate
  ) {
    throw new Error("Invalid signed merchant decision cannot be saved.")
  }
  await db.transaction("rw", db.eventMarketMerchantDecisionJobs, async () => {
    const existing = await db.eventMarketMerchantDecisionJobs.get(
      authorization.eventId
    )
    if (existing) {
      if (
        existing.action !== signed.action ||
        JSON.stringify(existing.roster) !== JSON.stringify(signed.roster) ||
        JSON.stringify(existing.authorization) !==
          JSON.stringify(signed.authorization)
      ) {
        throw new Error("Saved merchant decision signature changed.")
      }
      return
    }
    const pending = await db.eventMarketMerchantDecisionJobs
      .where("[marketCoordinate+merchantPubkey]")
      .equals([roster.coordinate, authorization.merchantPubkey])
      .filter((job) => job.status === "pending")
      .first()
    if (pending) {
      throw new Error(
        "Retry the pending merchant decision before signing another."
      )
    }
    const now = Date.now()
    await db.eventMarketMerchantDecisionJobs.add({
      id: authorization.eventId,
      marketCoordinate: roster.coordinate,
      merchantPubkey: authorization.merchantPubkey,
      action: signed.action,
      roster: signed.roster,
      authorization: signed.authorization,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
  })
}

export async function loadEventMarketMerchantDecision(
  decisionId: string
): Promise<EventMarketMerchantDecisionJob | undefined> {
  if (!/^[0-9a-f]{64}$/.test(decisionId)) return undefined
  return db.eventMarketMerchantDecisionJobs.get(decisionId)
}

/** Find exact saved signatures that still need delivery after a reload. */
export async function listPendingEventMarketMerchantDecisions(
  marketCoordinate: string
): Promise<EventMarketMerchantDecisionJob[]> {
  const market = parseAddressableCoordinate(marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (!market || market.coordinate !== marketCoordinate) return []
  const jobs = await db.eventMarketMerchantDecisionJobs
    .where("status")
    .equals("pending")
    .filter((job) => job.marketCoordinate === market.coordinate)
    .toArray()
  return jobs
}

async function acknowledgeMerchantDecision(decisionId: string): Promise<void> {
  const updated = await db.eventMarketMerchantDecisionJobs.update(decisionId, {
    status: "acknowledged",
    updatedAt: Date.now(),
  })
  if (updated !== 1) throw new Error("Saved merchant decision is unavailable.")
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

const defaultMerchantDecisionDependencies: MerchantDecisionDependencies = {
  ...defaultDependencies,
  readAuthorization: readEventMarketAuthorization,
  persist: persistMerchantDecision,
  load: loadEventMarketMerchantDecision,
  acknowledge: acknowledgeMerchantDecision,
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
    if (
      JSON.stringify(previous.merchants.map((row) => row.pubkey).sort()) !==
      JSON.stringify(input.merchants.map((row) => row.pubkey).sort())
    ) {
      throw new Error(
        "Merchant approval and revocation require a causal authorization decision."
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
  if (!previous && input.merchants.length > 0) {
    throw new Error("Create the Event Market before approving merchants.")
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
    signedEvent.kind !== draft.kind ||
    signedEvent.content !== draft.content ||
    JSON.stringify(signedEvent.tags) !== JSON.stringify(draft.tags) ||
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
    !current.retained ||
    current.resolution.state === "conflicting" ||
    current.resolution.state === "malformed" ||
    current.resolution.state === "deleted" ||
    current.resolution.state === "invalid_reference" ||
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

function decisionParents(
  resolution: Awaited<
    ReturnType<typeof readEventMarketAuthorization>
  >["resolution"]
): ParsedEventMarketAuthorization[] {
  switch (resolution.state) {
    case "missing":
      return []
    case "active":
    case "revoked":
    case "deleted":
      return [resolution.tip]
    case "conflicting":
      return resolution.tips
    default:
      throw new Error("Merchant authorization needs organizer review.")
  }
}

function deletionRepairs(
  resolution: Awaited<
    ReturnType<typeof readEventMarketAuthorization>
  >["resolution"]
): EventMarketAuthorizationRepair[] {
  if (resolution.state !== "deleted") return []
  const ancestryIds = new Set(resolution.ancestry.map((event) => event.id))
  const repairs = resolution.deletions.flatMap((deletion) =>
    deletion.tags
      .filter((tag) => tag[0] === "e")
      .map((tag) => ({
        deletionId: deletion.id,
        targetEventId: tag[1] ?? "",
      }))
  )
  if (repairs.some((repair) => !ancestryIds.has(repair.targetEventId))) {
    throw new Error("Deleted merchant authorization needs organizer review.")
  }
  return repairs
}

/**
 * Sign and save both independent relay events before publishing either one.
 * A roster row or authorization tip alone never admits new commerce.
 */
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
    /** Optional caller hook after Core has saved both exact signed events. */
    onSignedLocal?: (
      decision: SignedEventMarketMerchantDecision
    ) => Promise<void>
  },
  dependencies: MerchantDecisionDependencies = defaultMerchantDecisionDependencies
): Promise<{
  signed: SignedEventMarketMerchantDecision
  rosterDelivery: PublishWithPlannerResult
  authorizationDelivery: PublishWithPlannerResult
}> {
  const organizerPubkey = input.organizerPubkey.trim().toLowerCase()
  if (
    !/^[0-9a-f]{64}$/.test(organizerPubkey) ||
    input.authenticatedPubkey?.toLowerCase() !== organizerPubkey ||
    !/^[0-9a-f]{64}$/.test(input.merchantPubkey) ||
    (input.action === "approve" &&
      input.row?.pubkey !== input.merchantPubkey) ||
    (input.action === "revoke" && input.row !== undefined)
  ) {
    throw new Error(
      "The authenticated organizer and merchant decision are required."
    )
  }
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
    marketRead.resolution.state !== "current" ||
    marketRead.resolution.market.eventId !== input.expectedPreviousEventId ||
    marketRead.resolution.market.calendarCoordinate !==
      input.calendarCoordinate ||
    !authorizationRead.retained
  ) {
    throw new Error(
      "Current signed Event Market authority needs organizer review."
    )
  }
  const market = marketRead.resolution.market
  const parents = decisionParents(authorizationRead.resolution)
  const observedTipIds = parents.map((parent) => parent.eventId).sort()
  if (
    JSON.stringify(observedTipIds) !==
    JSON.stringify([...input.expectedAuthorizationTipIds].sort())
  ) {
    throw new Error("Merchant authorization changed. Review it before signing.")
  }
  const existingRow = market.merchants.find(
    (row) => row.pubkey === input.merchantPubkey
  )
  if (input.action === "approve") {
    if (
      existingRow ||
      authorizationRead.resolution.state === "active" ||
      (authorizationRead.resolution.state === "deleted" &&
        authorizationRead.resolution.tip.state !== "revoked")
    ) {
      throw new Error(
        "Merchant reapproval needs a revoked tip and removed row."
      )
    }
  } else if (authorizationRead.resolution.state === "missing") {
    throw new Error("Merchant revocation needs an observed authorization tip.")
  }
  const nextRows = market.merchants.filter(
    (row) => row.pubkey !== input.merchantPubkey
  )
  if (input.action === "approve") nextRows.push(input.row!)
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
    parents,
    repairs: deletionRepairs(authorizationRead.resolution),
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
  const parsedAuthorization = parseEventMarketAuthorizationEvent(authorization)
  if (
    !parsedRoster ||
    roster.kind !== rosterDraft.kind ||
    roster.content !== rosterDraft.content ||
    JSON.stringify(roster.tags) !== JSON.stringify(rosterDraft.tags) ||
    parsedRoster.coordinate !== coordinate ||
    parsedRoster.previousEventId !== market.eventId ||
    parsedRoster.calendarCoordinate !== input.calendarCoordinate ||
    parsedRoster.state !== market.state ||
    JSON.stringify(parsedRoster.merchants) !== JSON.stringify(nextRows) ||
    !parsedAuthorization ||
    authorization.kind !== authorizationDraft.kind ||
    authorization.content !== authorizationDraft.content ||
    JSON.stringify(authorization.tags) !==
      JSON.stringify(authorizationDraft.tags) ||
    parsedAuthorization.marketCoordinate !== coordinate ||
    parsedAuthorization.merchantPubkey !== input.merchantPubkey ||
    parsedAuthorization.state !==
      (input.action === "approve" ? "active" : "revoked") ||
    JSON.stringify(parsedAuthorization.parentIds) !==
      JSON.stringify(parents.map((parent) => parent.eventId)) ||
    roster.created_at !== createdAt ||
    authorization.created_at !== createdAt
  ) {
    throw new Error("Signer changed the Event Market merchant decision.")
  }
  const signed: SignedEventMarketMerchantDecision = {
    action: input.action,
    roster,
    authorization,
  }
  await dependencies.persist(signed)
  await input.onSignedLocal?.(signed)
  const first = input.action === "approve" ? roster : authorization
  const second = input.action === "approve" ? authorization : roster
  let firstResult: PublishWithPlannerResult | undefined
  let secondResult: PublishWithPlannerResult | undefined
  try {
    firstResult = await dependencies.publish(
      first,
      organizerPubkey,
      input.shouldContinue
    )
  } catch {
    // The second independent signed event can still close an interrupted state.
  }
  if (input.shouldContinue?.() === false) {
    throw new Error(
      "Organizer session changed during merchant decision delivery."
    )
  }
  try {
    secondResult = await dependencies.publish(
      second,
      organizerPubkey,
      input.shouldContinue
    )
  } catch {
    // Both exact signatures remain saved for retry.
  }
  if (
    !firstResult?.successfulRelayUrls.length ||
    !secondResult?.successfulRelayUrls.length
  ) {
    throw new Error(
      "The signed merchant decision was saved for retry but both relay events were not acknowledged."
    )
  }
  await dependencies.acknowledge(authorization.id)
  return {
    signed,
    rosterDelivery: input.action === "approve" ? firstResult : secondResult,
    authorizationDelivery:
      input.action === "approve" ? secondResult : firstResult,
  }
}

/** Reuse both saved signatures after checking the exact roster and causal tips. */
export async function retryEventMarketMerchantDecisionDelivery(
  input: {
    decisionId: string
    authenticatedPubkey: string | null
    shouldContinue?: () => boolean
  },
  dependencies: Pick<
    MerchantDecisionDependencies,
    "read" | "readAuthorization" | "publish" | "load" | "acknowledge"
  > = defaultMerchantDecisionDependencies
): Promise<{
  rosterDelivery: PublishWithPlannerResult
  authorizationDelivery: PublishWithPlannerResult
}> {
  const job = await dependencies.load(input.decisionId)
  if (!job || job.id !== input.decisionId) {
    throw new Error("Saved merchant decision is unavailable for retry.")
  }
  const signed: SignedEventMarketMerchantDecision = {
    action: job.action,
    roster: job.roster,
    authorization: job.authorization,
  }
  const roster = parseEventMarketRosterEvent(signed.roster)
  const authorization = parseEventMarketAuthorizationEvent(signed.authorization)
  if (
    !roster ||
    !authorization ||
    job.id !== authorization.eventId ||
    job.marketCoordinate !== roster.coordinate ||
    job.merchantPubkey !== authorization.merchantPubkey ||
    input.authenticatedPubkey?.toLowerCase() !== roster.organizerPubkey ||
    roster.coordinate !== authorization.marketCoordinate ||
    Boolean(
      roster.merchants.find(
        (row) => row.pubkey === authorization.merchantPubkey
      )
    ) !==
      (signed.action === "approve") ||
    authorization.state !==
      (signed.action === "approve" ? "active" : "revoked") ||
    !roster.previousEventId
  ) {
    throw new Error("The exact signed merchant decision is required for retry.")
  }
  const [marketRead, authorizationRead] = await Promise.all([
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
    !authorizationRead.retained
  ) {
    throw new Error(
      "A newer or invalid signed Event Market roster blocks this retry."
    )
  }
  if (authorizationRead.resolution.state === "deleted") {
    const requiredRepairs = deletionRepairs(authorizationRead.resolution)
    if (
      authorizationRead.resolution.tip.eventId === authorization.eventId ||
      requiredRepairs.some(
        (repair) =>
          !authorization.repairs.some(
            (savedRepair) =>
              savedRepair.deletionId === repair.deletionId &&
              savedRepair.targetEventId === repair.targetEventId
          )
      )
    ) {
      throw new Error("Deleted merchant authorization blocks this retry.")
    }
  }
  const currentTipIds = decisionParents(authorizationRead.resolution).map(
    (tip) => tip.eventId
  )
  const savedIsSoleTip =
    currentTipIds.length === 1 && currentTipIds[0] === authorization.eventId
  const observedOnlyParents =
    currentTipIds.length === authorization.parentIds.length &&
    currentTipIds.every((id) => authorization.parentIds.includes(id))
  if (!savedIsSoleTip && !observedOnlyParents) {
    throw new Error(
      "A newer or invalid merchant authorization blocks this retry."
    )
  }
  const first =
    signed.action === "approve" ? signed.roster : signed.authorization
  const second =
    signed.action === "approve" ? signed.authorization : signed.roster
  let firstResult: PublishWithPlannerResult | undefined
  let secondResult: PublishWithPlannerResult | undefined
  try {
    firstResult = await dependencies.publish(
      first,
      roster.organizerPubkey,
      input.shouldContinue
    )
  } catch {
    // Still attempt the other exact signed event.
  }
  if (input.shouldContinue?.() === false) {
    throw new Error("Organizer session changed during merchant decision retry.")
  }
  try {
    secondResult = await dependencies.publish(
      second,
      roster.organizerPubkey,
      input.shouldContinue
    )
  } catch {
    // Keep both exact signatures available for a later retry.
  }
  if (
    !firstResult?.successfulRelayUrls.length ||
    !secondResult?.successfulRelayUrls.length
  ) {
    throw new Error("The saved merchant decision still needs relay delivery.")
  }
  await dependencies.acknowledge(authorization.eventId)
  return {
    rosterDelivery: signed.action === "approve" ? firstResult : secondResult,
    authorizationDelivery:
      signed.action === "approve" ? secondResult : firstResult,
  }
}
