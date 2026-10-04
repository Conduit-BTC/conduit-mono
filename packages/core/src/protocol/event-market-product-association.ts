import { getAccountSigner } from "./session-signer"
import {
  cacheSignedProductListingEvent,
  getProductsByIds,
  hasExactLiveProductAvailabilityEvidence,
} from "./commerce"
import { readEventMarketAuthorization } from "./event-market-authorization-read"
import { readEventMarketRoster } from "./event-market-roster-read"
import {
  decodeEventMarketReference,
  parseAddressableCoordinate,
} from "./event-market"
import { publishWithPlanner } from "./relay-publish"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { waitForVisibleDocument } from "./interactive-signer"
import type { UnsignedNostrEvent } from "./nostr-event-signer"

/** Association changes only the selected market tag, never shipping or product options. */
export function buildEventMarketProductAssociationDraft(input: {
  event: SignedPublicNostrEvent
  marketCoordinate: string
  enabled: boolean
  now?: number
}): UnsignedNostrEvent {
  if (
    !isValidSignedPublicNostrEvent(input.event) ||
    input.event.kind !== 30402 ||
    !parseAddressableCoordinate(input.marketCoordinate, [30409])
  )
    throw new Error(
      "Valid signed product and Event Market coordinates are required."
    )
  const tags = input.event.tags
    .filter((tag) => tag[0] !== "a" || tag[1] !== input.marketCoordinate)
    .map((tag) => [...tag])
  if (input.enabled) tags.push(["a", input.marketCoordinate])
  return {
    kind: 30402,
    pubkey: input.event.pubkey,
    content: input.event.content,
    tags,
    created_at: Math.max(
      input.now ?? Math.floor(Date.now() / 1000),
      input.event.created_at + 1
    ),
  }
}

export interface EventMarketProductAssociationInput {
  merchantPubkey: string
  marketReference: string
  products: readonly { coordinate: string; eventId: string }[]
  enabled: boolean
  authenticatedPubkey: string | null
  shouldContinue?: () => boolean
  /** Full immutable bundle saved before cache or network writes; used for exact retry. */
  onSignedLocal: (events: SignedPublicNostrEvent[]) => Promise<void>
  savedEvents?: readonly SignedPublicNostrEvent[]
}

const defaults = {
  getSigner: getAccountSigner,
  readProducts: getProductsByIds,
  readMarket: readEventMarketRoster,
  readAuthorization: readEventMarketAuthorization,
  cache: cacheSignedProductListingEvent,
  publish: publishWithPlanner,
  waitForVisibility: waitForVisibleDocument,
}

/** Focused existing-listing write; current admission comes from the organizer's roster/grant. */
export async function publishEventMarketProductAssociation(
  input: EventMarketProductAssociationInput,
  dependencies: Partial<typeof defaults> = {}
) {
  const deps = { ...defaults, ...dependencies }
  const assertCurrent = () => {
    if (input.shouldContinue?.() === false)
      throw new Error("Product signer session changed.")
  }
  assertCurrent()
  const market = decodeEventMarketReference(input.marketReference, [30409])
  const coordinates = input.products.map((product) => product.coordinate)
  if (
    !market ||
    input.authenticatedPubkey !== input.merchantPubkey ||
    !coordinates.length ||
    coordinates.length > 65 ||
    new Set(coordinates).size !== coordinates.length ||
    coordinates.some(
      (coordinate) =>
        parseAddressableCoordinate(coordinate, [30402])?.authorPubkey !==
        input.merchantPubkey
    )
  )
    throw new Error(
      "A merchant-owned product and selected Event Market are required."
    )
  let events: SignedPublicNostrEvent[]
  if (input.savedEvents) {
    events = [...input.savedEvents]
    if (
      events.length !== coordinates.length ||
      events.some(
        (event, index) =>
          !isValidSignedPublicNostrEvent(event) ||
          event.kind !== 30402 ||
          event.pubkey !== input.merchantPubkey ||
          event.tags.filter((tag) => tag[0] === "d").length !== 1 ||
          `30402:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` !==
            coordinates[index] ||
          event.tags.some(
            (tag) => tag[0] === "a" && tag[1] === market.coordinate
          ) !== input.enabled
      )
    )
      throw new Error("Saved product association does not match this action.")
  } else {
    const signer = deps.getSigner()
    if (!signer || (await signer.getPublicKey()) !== input.merchantPubkey)
      throw new Error("Active signer does not match current merchant pubkey.")
    assertCurrent()
    const [products, roster, authorization] = await Promise.all([
      deps.readProducts(coordinates, {
        includeMarketHidden: true,
        authenticatedPubkey: input.authenticatedPubkey,
        accountPubkey: input.merchantPubkey,
        shouldContinue: input.shouldContinue,
      }),
      input.enabled
        ? deps.readMarket({
            reference: input.marketReference,
            authenticatedPubkey: input.authenticatedPubkey,
            shouldContinue: input.shouldContinue,
          })
        : Promise.resolve(null),
      input.enabled
        ? deps.readAuthorization({
            marketCoordinate: market.coordinate,
            merchantPubkey: input.merchantPubkey,
            authenticatedPubkey: input.authenticatedPubkey,
            shouldContinue: input.shouldContinue,
          })
        : Promise.resolve(null),
    ])
    assertCurrent()
    if (
      input.enabled &&
      (!roster ||
        roster.resolution.state !== "current" ||
        roster.resolution.market.state !== "open" ||
        !roster.resolution.market.merchants.some(
          (row) => row.pubkey === input.merchantPubkey
        ) ||
        !roster.retained ||
        !["complete", "partial"].includes(roster.coverage) ||
        !roster.calendar ||
        !["complete", "partial"].includes(roster.calendarCoverage ?? "") ||
        authorization?.resolution.state !== "active" ||
        !authorization.actionable)
    )
      throw new Error(
        "Current organizer-signed Event Market approval and grant could not be confirmed. Refresh before linking this product."
      )
    const drafts = input.products.map((expected) => {
      const record = products.data.find(
        (item) => item.addressId === expected.coordinate
      )
      const event = record?.product.signedProductEvent
      if (
        !record ||
        !event ||
        event.pubkey !== input.merchantPubkey ||
        event.tags.filter((tag) => tag[0] === "d").length !== 1 ||
        `30402:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` !==
          expected.coordinate ||
        !hasExactLiveProductAvailabilityEvidence(
          products.diagnostics.find(
            (diagnostic) => diagnostic.addressId === expected.coordinate
          ),
          expected.coordinate
        ) ||
        record.eventId !== expected.eventId ||
        event.id !== expected.eventId ||
        record.product.format !== "physical"
      )
        throw new Error(
          "The product changed or could not be verified. Refresh products before changing its event association."
        )
      return buildEventMarketProductAssociationDraft({
        event,
        marketCoordinate: market.coordinate,
        enabled: input.enabled,
      })
    })
    events = []
    for (const draft of drafts) {
      assertCurrent()
      await deps.waitForVisibility()
      assertCurrent()
      const signed = await signer.signEvent(draft)
      assertCurrent()
      if (
        !isValidSignedPublicNostrEvent(signed) ||
        signed.pubkey !== draft.pubkey ||
        signed.kind !== draft.kind ||
        signed.created_at !== draft.created_at ||
        signed.content !== draft.content ||
        JSON.stringify(signed.tags) !== JSON.stringify(draft.tags)
      )
        throw new Error("Signer returned invalid product association evidence.")
      events.push(signed)
    }
    await input.onSignedLocal(events)
  }
  for (const event of events) {
    assertCurrent()
    await deps.cache(event, { persistence: "best_effort" })
  }
  const deliveries = []
  for (const event of events) {
    assertCurrent()
    const delivery = await deps.publish(event, {
      intent: "commerce_author_event",
      authorPubkey: input.merchantPubkey,
      accountPubkey: input.merchantPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      deliveryMode: "critical",
      extraRelayUrls: market.relayHints,
      shouldContinue: input.shouldContinue,
    })
    assertCurrent()
    await deps.cache(event, {
      sourceRelayUrls: delivery.successfulRelayUrls,
      persistence: "best_effort",
    })
    deliveries.push(delivery)
  }
  return { events, deliveries }
}
