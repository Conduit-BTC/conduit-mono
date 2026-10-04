import { parseEventMarketCalendarEvent } from "./event-market"
import { parseEventMarketSeriesEvent } from "./event-market-schedule"
import { getAccountSigner } from "./session-signer"
import {
  publishWithPlanner,
  type PublishWithPlannerResult,
} from "./relay-publish"
import type { SignedPublicNostrEvent } from "./signed-event"

interface CalendarRetryDependencies {
  publish: (
    signedEvent: SignedPublicNostrEvent,
    organizerPubkey: string,
    shouldContinue?: () => boolean
  ) => Promise<PublishWithPlannerResult>
}

const defaultDependencies: CalendarRetryDependencies = {
  publish: async (signedEvent, organizerPubkey, shouldContinue) => {
    const signer = getAccountSigner()
    if (
      !signer ||
      (await signer.getPublicKey()).toLowerCase() !== organizerPubkey
    )
      throw new Error("Active signer does not match the organizer.")
    if (shouldContinue?.() === false)
      throw new Error("Organizer session changed.")
    return publishWithPlanner(signedEvent, {
      intent: "commerce_author_event",
      authorPubkey: organizerPubkey,
      authenticatedPubkey: organizerPubkey,
      accountPubkey: organizerPubkey,
      deliveryMode: "critical",
      shouldContinue,
    })
  },
}

/** Retry an exact saved NIP-52 date or finite calendar without signing another revision. */
export async function retryEventMarketCalendarDelivery(
  input: {
    organizerPubkey: string
    authenticatedPubkey: string | null
    signedEvent: SignedPublicNostrEvent
    shouldContinue?: () => boolean
  },
  dependencies: CalendarRetryDependencies = defaultDependencies
): Promise<PublishWithPlannerResult> {
  const organizerPubkey = input.organizerPubkey.trim().toLowerCase()
  const calendar =
    parseEventMarketCalendarEvent(input.signedEvent) ??
    parseEventMarketSeriesEvent(input.signedEvent)
  if (
    !calendar ||
    ("authorPubkey" in calendar
      ? calendar.authorPubkey
      : calendar.organizerPubkey) !== organizerPubkey ||
    input.authenticatedPubkey?.toLowerCase() !== organizerPubkey
  )
    throw new Error(
      "The exact signed organizer calendar is required for retry."
    )
  if (input.shouldContinue?.() === false)
    throw new Error("Organizer session changed.")
  const delivery = await dependencies.publish(
    input.signedEvent,
    organizerPubkey,
    input.shouldContinue
  )
  if (input.shouldContinue?.() === false)
    throw new Error("Organizer session changed.")
  return delivery
}
