import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildEventMarketRosterDraft,
  parseEventMarketRosterEvent,
  type EventMarketCommerceState,
  type EventMarketMerchantRow,
} from "./event-market-roster"
import { readEventMarketRoster } from "./event-market-roster-read"
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
  } else if (
    current.resolution.state !== "missing" ||
    current.coverage !== "complete" ||
    input.expectedPreviousEventId
  ) {
    throw new Error(
      "The Event Market coordinate could not be confirmed for creation."
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
