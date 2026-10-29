import type { CheckoutSparkCommerceQuote } from "./checkout-spark-reconciliation"
import { hasEventMarketListingVisibility } from "./product-event-visibility"
import {
  freezeCheckoutSparkEventMarketBinding,
  type CheckoutSparkEventMarketBinding,
} from "./checkout-spark-event-market"
import {
  parseAddressableCoordinate,
  parseEventMarketCalendarFieldsForPrivateOrder,
} from "./event-market"
import { parseEventMarketAssignmentEvent } from "./event-market-assignment"
import { resolveEventMarketAuthorizationForPrivateOrder } from "./event-market-authorization"
import { parseEventMarketRosterFieldsForPrivateOrder } from "./event-market-roster"
import { parseEventMarketSeriesFieldsForPrivateOrder } from "./event-market-schedule"
import {
  assertCurrentEventMarketOrganizerFeeTerms,
  parseEventMarketOrganizerFeeTerms,
} from "./event-market-organizer-fee"
import { parseCheckoutSparkSignedProductFields } from "./checkout-spark-product-fields"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

function unavailable(): never {
  throw new Error("Checkout Spark exact Event Market authority is unavailable.")
}

export function getCheckoutSparkEventMarketSourceReferences(
  binding: CheckoutSparkEventMarketBinding,
  merchantPubkey: string
): readonly {
  eventId: string
  kind: 5 | 3841 | 30402 | 30409 | 30410 | 31922 | 31923 | 31924
  pubkey: string
}[] {
  const occurrence = parseAddressableCoordinate(
    binding.occurrenceCoordinate,
    [31922, 31923]
  )
  if (!occurrence || (occurrence.kind !== 31922 && occurrence.kind !== 31923))
    unavailable()
  return [
    {
      eventId: binding.marketEventId,
      kind: 30409,
      pubkey: binding.organizerPubkey,
    },
    {
      eventId: binding.occurrenceEventId,
      kind: occurrence.kind,
      pubkey: binding.organizerPubkey,
    },
    ...(binding.schedule
      ? [
          {
            eventId: binding.schedule.eventId,
            kind: 31924 as const,
            pubkey: binding.organizerPubkey,
          },
        ]
      : []),
    ...binding.grantAncestryEventIds.map((eventId) => ({
      eventId,
      kind: 3841 as const,
      pubkey: binding.organizerPubkey,
    })),
    ...binding.observedDeletionEventIds.map((eventId) => ({
      eventId,
      kind: 5 as const,
      pubkey: binding.organizerPubkey,
    })),
    ...binding.lines.flatMap((line) => [
      {
        eventId: line.assignmentEventId,
        kind: 30410 as const,
        pubkey: merchantPubkey,
      },
      ...(line.parentProduct
        ? [
            {
              eventId: line.parentProduct.eventId,
              kind: 30402 as const,
              pubkey: merchantPubkey,
            },
          ]
        : []),
    ]),
  ]
}

/** Reconstruct exact historical terms, not live freshness or global absence. */
export function assertCheckoutSparkSignedEventMarketSources(input: {
  eventMarket: CheckoutSparkEventMarketBinding
  commerceQuote: CheckoutSparkCommerceQuote
  merchantPubkey: string
  sourceEvents: readonly SignedPublicNostrEvent[]
  acceptedAtMs: number
}): CheckoutSparkEventMarketBinding {
  const binding = freezeCheckoutSparkEventMarketBinding(
    input.eventMarket,
    input
  )
  const byId = new Map<string, SignedPublicNostrEvent>()
  for (const event of input.sourceEvents) {
    if (
      !isValidSignedPublicNostrEvent(event) ||
      event.created_at * 1000 > input.acceptedAtMs
    )
      unavailable()
    const previous = byId.get(event.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event))
      unavailable()
    byId.set(event.id, event)
  }
  const required = getCheckoutSparkEventMarketSourceReferences(
    binding,
    input.merchantPubkey
  )
  for (const reference of required) {
    const event = byId.get(reference.eventId)
    if (
      !event ||
      event.kind !== reference.kind ||
      event.pubkey !== reference.pubkey
    )
      unavailable()
  }
  const marketEvent = byId.get(binding.marketEventId)!
  const market = parseEventMarketRosterFieldsForPrivateOrder(marketEvent)
  const calendar = parseEventMarketCalendarFieldsForPrivateOrder(
    byId.get(binding.occurrenceEventId)!
  )
  const row = market?.merchants.find(
    (candidate) => candidate.pubkey === input.merchantPubkey
  )
  const series = binding.schedule
    ? parseEventMarketSeriesFieldsForPrivateOrder(
        byId.get(binding.schedule.eventId)!
      )
    : null
  if (
    !market ||
    market.coordinate !== binding.marketCoordinate ||
    market.organizerPubkey !== binding.organizerPubkey ||
    market.state !== "open" ||
    !row ||
    row.mode !== binding.mode ||
    row.assignment !== binding.assignment ||
    !calendar ||
    calendar.coordinate !== binding.occurrenceCoordinate ||
    calendar.authorPubkey !== binding.organizerPubkey ||
    calendar.end <= input.acceptedAtMs ||
    (binding.schedule
      ? !series ||
        series.coordinate !== binding.schedule.coordinate ||
        series.coordinate !== market.calendarCoordinate ||
        series.organizerPubkey !== binding.organizerPubkey ||
        !series.memberCoordinates.includes(calendar.coordinate)
      : market.calendarCoordinate !== calendar.coordinate)
  )
    unavailable()
  const fee = assertCurrentEventMarketOrganizerFeeTerms(
    parseEventMarketOrganizerFeeTerms({
      event: marketEvent,
      marketCoordinate: binding.marketCoordinate,
    }),
    input.acceptedAtMs
  )
  const expectedFee = binding.organizerFee
  if (
    fee.state !== expectedFee.state ||
    fee.marketCoordinate !== expectedFee.marketCoordinate ||
    fee.organizerPubkey !== expectedFee.organizerPubkey ||
    fee.eventId !== expectedFee.eventId ||
    fee.createdAt !== expectedFee.createdAt ||
    (fee.state === "active" &&
      (expectedFee.state !== "active" ||
        fee.basisPoints !== expectedFee.basisPoints ||
        fee.minimumSats !== expectedFee.minimumSats ||
        fee.lightningAddress !== expectedFee.lightningAddress ||
        fee.expiresAt !== expectedFee.expiresAt))
  )
    unavailable()
  const authorization = resolveEventMarketAuthorizationForPrivateOrder({
    marketCoordinate: binding.marketCoordinate,
    merchantPubkey: input.merchantPubkey,
    transitions: binding.grantAncestryEventIds.map((id) => byId.get(id)!),
    deletions: binding.observedDeletionEventIds.map((id) => byId.get(id)!),
  })
  if (
    authorization.state !== "active" ||
    authorization.tip.eventId !== binding.grantEventId ||
    authorization.ancestry.length !== binding.grantAncestryEventIds.length
  )
    unavailable()
  for (const line of binding.lines) {
    const productEvent = byId.get(line.productEventId)
    if (!productEvent || productEvent.pubkey !== input.merchantPubkey)
      unavailable()
    const product = parseCheckoutSparkSignedProductFields(productEvent)
    const assignment = parseEventMarketAssignmentEvent(
      byId.get(line.assignmentEventId)!
    )
    if (
      product.id !== line.productCoordinate ||
      !hasEventMarketListingVisibility(product) ||
      product.format !== "physical" ||
      product.type === "variable" ||
      product.priceEvidenceMalformed ||
      !assignment ||
      assignment.coordinate !== line.assignmentCoordinate ||
      assignment.merchantPubkey !== input.merchantPubkey ||
      assignment.marketCoordinate !== binding.marketCoordinate ||
      assignment.occurrenceCoordinate !== binding.occurrenceCoordinate ||
      assignment.productCoordinate !== line.productCoordinate ||
      assignment.state !== "active" ||
      !assignment.fulfillmentMethods.includes("pickup") ||
      assignment.stockPool.state === "invalid" ||
      (assignment.inventory.mode === "tracked"
        ? product.stock === undefined ||
          assignment.inventory.quantity < line.quantity ||
          product.stock < assignment.inventory.quantity
        : product.stock !== undefined)
    )
      unavailable()
    if (binding.mode === "organizer_handoff") {
      if (
        binding.organizerPubkey === input.merchantPubkey ||
        assignment.stockPool.state !== "valid" ||
        assignment.stockPool.pool.state !== "active" ||
        assignment.stockPool.pool.poolId !== line.stockPoolId ||
        assignment.stockPool.pool.organizerPubkey !== binding.organizerPubkey ||
        assignment.stockPool.pool.quantity -
          assignment.stockPool.pool.importedQuantity <
          line.quantity
      )
        unavailable()
    } else if (
      assignment.stockPool.state === "valid" &&
      assignment.stockPool.pool.state === "active"
    )
      unavailable()
    if (product.type === "variation") {
      const parentEvent =
        line.parentProduct && byId.get(line.parentProduct.eventId)
      if (!parentEvent || parentEvent.pubkey !== input.merchantPubkey)
        unavailable()
      const parent = parseCheckoutSparkSignedProductFields(parentEvent)
      if (
        parent.type !== "variable" ||
        !hasEventMarketListingVisibility(parent) ||
        parent.id !== product.parentProductId ||
        parent.id !== line.parentProduct?.coordinate
      )
        unavailable()
    } else if (line.parentProduct) unavailable()
    const quoteLine = input.commerceQuote.lines.find(
      (candidate) => candidate.productCoordinate === line.productCoordinate
    )!
    if (
      quoteLine.unitShippingSats !== 0 ||
      quoteLine.sourceShippingCost !== undefined ||
      quoteLine.shippingOption !== undefined ||
      quoteLine.shippingPolicy !== undefined ||
      quoteLine.pickup !== undefined
    )
      unavailable()
  }
  return binding
}
