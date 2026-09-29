import { NDKEvent } from "@nostr-dev-kit/ndk"
import { parseAddressableCoordinate } from "./event-market"
import {
  buildEventMarketAuthorizationDraft,
  parseEventMarketAuthorizationEvent,
  type EventMarketAuthorizationState,
} from "./event-market-authorization"
import { readEventMarketAuthorization } from "./event-market-authorization-read"
import { waitForVisibleDocument } from "./interactive-signer"
import { EVENT_KINDS } from "./kinds"
import { getNdk } from "./ndk"
import {
  publishWithPlanner,
  type PublishWithPlannerResult,
} from "./relay-publish"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

interface AuthorizationPublishDependencies {
  read: typeof readEventMarketAuthorization
  sign: (input: {
    draft: ReturnType<typeof buildEventMarketAuthorizationDraft>
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
async function sign(
  input: Parameters<AuthorizationPublishDependencies["sign"]>[0]
): Promise<SignedPublicNostrEvent> {
  await waitForVisibleDocument()
  if (input.shouldContinue?.() === false)
    throw new Error("Organizer session changed.")
  const ndk = await getNdk()
  if (!ndk.signer) throw new Error("Organizer signer is not connected.")
  if ((await ndk.signer.user()).pubkey.toLowerCase() !== input.organizerPubkey)
    throw new Error("Active signer does not match the organizer.")
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
  )
    throw new Error("Signer returned invalid Event Market authorization.")
  return signed
}
async function publish(
  event: SignedPublicNostrEvent,
  authorPubkey: string,
  shouldContinue?: () => boolean
): Promise<PublishWithPlannerResult> {
  const ndk = await getNdk()
  return publishWithPlanner(new NDKEvent(ndk, event), {
    intent: "commerce_author_event",
    authorPubkey,
    authenticatedPubkey: authorPubkey,
    accountPubkey: authorPubkey,
    deliveryMode: "critical",
    shouldContinue,
  })
}
const defaults: AuthorizationPublishDependencies = {
  read: readEventMarketAuthorization,
  sign,
  publish,
}

/** Sign the exact observed causal successor, persist it, then attempt relay delivery. */
export async function publishEventMarketAuthorization(
  input: {
    marketCoordinate: string
    merchantPubkey: string
    state: EventMarketAuthorizationState
    authenticatedPubkey: string | null
    expectedTipIds: readonly string[]
    repair?: { deletionId: string; targetId: string }
    shouldContinue?: () => boolean
    onSignedLocal: (event: SignedPublicNostrEvent) => Promise<void>
  },
  dependencies: AuthorizationPublishDependencies = defaults
): Promise<{
  signedEvent: SignedPublicNostrEvent
  delivery: PublishWithPlannerResult
}> {
  const market = parseAddressableCoordinate(input.marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (
    !market ||
    input.authenticatedPubkey?.toLowerCase() !== market.authorPubkey
  )
    throw new Error("The authenticated organizer is required.")
  const current = await dependencies.read({
    marketCoordinate: market.coordinate,
    merchantPubkey: input.merchantPubkey,
    authenticatedPubkey: market.authorPubkey,
    shouldContinue: input.shouldContinue,
  })
  if (
    !current.retained ||
    current.coverage === "stale" ||
    current.coverage === "unavailable"
  )
    throw new Error("Current signed authorization needs organizer review.")
  if (
    input.repair &&
    !current.observedEvidence.some(
      (event) =>
        event.id === input.repair!.deletionId &&
        event.kind === EVENT_KINDS.DELETION &&
        event.pubkey === market.authorPubkey &&
        event.tags.some(
          (tag) => tag[0] === "e" && tag[1] === input.repair!.targetId
        )
    )
  )
    throw new Error("The exact signed deletion to repair was not observed.")
  let tips: Array<{
    eventId: string
    sequence: number
    signedEvent: SignedPublicNostrEvent
  }>
  if (
    current.resolution.state === "active" ||
    current.resolution.state === "revoked"
  )
    tips = [current.resolution.tip]
  else if (
    current.resolution.state === "conflicting" ||
    (current.resolution.state === "deleted" && input.repair)
  )
    tips = current.resolution.tips
  else if (
    current.resolution.state === "missing" &&
    current.coverage === "complete"
  )
    tips = []
  else throw new Error("Current signed authorization needs organizer review.")
  const observed = tips.map((tip) => tip.eventId).sort()
  const expected = [...input.expectedTipIds].sort()
  if (JSON.stringify(observed) !== JSON.stringify(expected))
    throw new Error(
      "Merchant authorization changed. Review the latest transitions."
    )
  if (tips.length > 8)
    throw new Error("Too many authorization tips to reconcile.")
  const sequence =
    tips.length === 0 ? 0 : 1 + Math.max(...tips.map((tip) => tip.sequence))
  const draft = buildEventMarketAuthorizationDraft({
    marketCoordinate: market.coordinate,
    merchantPubkey: input.merchantPubkey,
    state: input.state,
    sequence,
    parentIds: observed,
    ...(input.repair ? { repairs: [input.repair] } : {}),
  })
  const createdAt = Math.max(
    Math.floor(Date.now() / 1_000),
    ...tips.map((tip) => tip.signedEvent.created_at + 1)
  )
  const signedEvent = await dependencies.sign({
    draft,
    createdAt,
    organizerPubkey: market.authorPubkey,
    shouldContinue: input.shouldContinue,
  })
  const parsed = parseEventMarketAuthorizationEvent(signedEvent)
  if (
    !parsed ||
    parsed.marketCoordinate !== market.coordinate ||
    parsed.merchantPubkey !== input.merchantPubkey ||
    parsed.state !== input.state ||
    parsed.sequence !== sequence ||
    JSON.stringify(parsed.parentIds) !== JSON.stringify(observed) ||
    parsed.signedEvent.created_at !== createdAt ||
    JSON.stringify(parsed.repairs) !==
      JSON.stringify(input.repair ? [input.repair] : []) ||
    JSON.stringify(signedEvent.tags) !== JSON.stringify(draft.tags) ||
    signedEvent.content !== draft.content
  )
    throw new Error("Signer changed the Event Market authorization draft.")
  await input.onSignedLocal(signedEvent)
  const delivery = await dependencies.publish(
    signedEvent,
    market.authorPubkey,
    input.shouldContinue
  )
  if (delivery.successfulRelayUrls.length === 0)
    throw new Error(
      "The signed authorization was saved for retry but no relay acknowledged it."
    )
  return { signedEvent, delivery }
}

/** Retry the exact signed transition; do not mint an alternate branch. */
export async function retryEventMarketAuthorizationDelivery(
  input: {
    signedEvent: SignedPublicNostrEvent
    authenticatedPubkey: string | null
    shouldContinue?: () => boolean
  },
  dependencies: Pick<
    AuthorizationPublishDependencies,
    "read" | "publish"
  > = defaults
): Promise<PublishWithPlannerResult> {
  const parsed = parseEventMarketAuthorizationEvent(input.signedEvent)
  if (
    !parsed ||
    input.authenticatedPubkey?.toLowerCase() !== parsed.organizerPubkey
  )
    throw new Error(
      "The exact signed organizer authorization is required for retry."
    )
  const current = await dependencies.read({
    marketCoordinate: parsed.marketCoordinate,
    merchantPubkey: parsed.merchantPubkey,
    authenticatedPubkey: parsed.organizerPubkey,
    shouldContinue: input.shouldContinue,
  })
  if (
    current.resolution.state === "active" ||
    current.resolution.state === "revoked"
  ) {
    if (
      current.resolution.tip.eventId !== parsed.eventId &&
      current.resolution.ancestry.some(
        (event) => event.eventId === parsed.eventId
      )
    )
      throw new Error("A later authorization superseded this retry.")
  }
  return dependencies.publish(
    input.signedEvent,
    parsed.organizerPubkey,
    input.shouldContinue
  )
}
