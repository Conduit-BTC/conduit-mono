import {
  readEventMarketOrderEvidenceByIds,
  verifyEventMarketOrderEvidence,
  type EventMarketOrderEvidenceResult,
  type OrderSchema,
} from "@conduit/core"

/** Historical signed evidence verifies a created future order's exact terms. */
export async function verifyFutureEventMarketOrderAuthorization(input: {
  order: OrderSchema
  merchantPubkey: string
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
}): Promise<ReturnType<typeof verifyEventMarketOrderEvidence>> {
  return (await readVerifiedFutureEventMarketOrderEvidence(input)).result
}

export async function readVerifiedFutureEventMarketOrderEvidence(input: {
  order: OrderSchema
  merchantPubkey: string
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
}): Promise<{
  result: ReturnType<typeof verifyEventMarketOrderEvidence>
  events: Awaited<
    ReturnType<typeof readEventMarketOrderEvidenceByIds>
  >["events"]
}> {
  if (input.shouldContinue?.() === false) {
    throw new DOMException("Order authorization was cancelled.", "AbortError")
  }
  const future = input.order.items.filter(
    (item) => item.fulfillment?.type === "event_market_pickup"
  )
  const first = future[0]?.fulfillment
  if (
    first?.type !== "event_market_pickup" ||
    input.order.merchantPubkey !== input.merchantPubkey ||
    future.length !==
      input.order.items.filter((item) => item.format === "physical").length
  )
    return { result: { status: "invalid", reason: "order" }, events: [] }
  const embedded = verifyEventMarketOrderEvidence({
    order: input.order,
    events: [],
  })
  if (embedded.status === "verified") return { result: embedded, events: [] }
  const ids = [
    ...new Set([
      first.market.eventId,
      first.calendar.eventId,
      ...first.grant.ancestryEventIds,
      ...first.grant.observedDeletionEventIds,
      ...future.flatMap((item) =>
        item.fulfillment?.type === "event_market_pickup"
          ? [item.fulfillment.product.eventId]
          : []
      ),
    ]),
  ]
  const read = await readEventMarketOrderEvidenceByIds({
    marketCoordinate: first.market.coordinate,
    merchantPubkey: input.merchantPubkey,
    eventIds: ids,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
  })
  return {
    events: read.events,
    result: verifyEventMarketOrderEvidence({
      order: input.order,
      events: read.events,
    }),
  }
}

export function getMerchantPickupAuthorizationMessage(
  result: EventMarketOrderEvidenceResult | undefined
): string {
  if (!result) return "Checking the order’s exact signed Event Market evidence."
  if (result.status === "verified")
    return "The order’s exact signed Event Market evidence is verified."
  return result.reason === "missing_evidence"
    ? "The order’s exact signed Event Market evidence is unavailable. Retry when relay access recovers."
    : "The order’s signed Event Market evidence does not match its created terms."
}
