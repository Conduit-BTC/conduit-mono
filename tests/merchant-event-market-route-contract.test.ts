import { describe, expect, it } from "bun:test"
import {
  getNextMerchantEventTimelineLimit,
  MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
} from "../apps/merchant/src/lib/merchant-event-timeline"
async function source(path: string) {
  return Bun.file(path).text()
}

describe("current Merchant Event Market routes", () => {
  it("registers canonical routes and preserves the selected occurrence without requiring an account to read", async () => {
    const [newRoute, detail, tree] = await Promise.all([
      source("apps/merchant/src/routes/events/new.tsx"),
      source("apps/merchant/src/routes/events/$collectionRef.tsx"),
      source("apps/merchant/src/routeTree.gen.ts"),
    ])
    expect(newRoute).toContain('createFileRoute("/events/new")')
    expect(newRoute).toContain("<FutureEventMarketCreate")
    expect(detail).toContain('createFileRoute("/events/$collectionRef")')
    expect(detail).toContain("selectedOccurrence={occurrence}")
    expect(detail).toContain("occurrence: coordinate")
    expect(detail).not.toContain("requireAuth")
    expect(tree).toContain(
      "'/events/$collectionRef': typeof EventsCollectionRefRoute"
    )
  })

  it("gives unsupported event links a clear repost action without legacy readers or writers", async () => {
    const detail = await source(
      "apps/merchant/src/routes/events/$collectionRef.tsx"
    )
    expect(detail).toContain(
      "decodeEventMarketReference(collectionRef, [30409])"
    )
    expect(detail).toContain("Repost this event")
    expect(detail).toContain('to="/events/new"')
    expect(detail).not.toContain("LegacyEventReadOnly")
    expect(detail).not.toContain("LegacyOrganizerHandoffQueue")
  })

  it("keeps authoring, requests and paired approval on their shared workflows", async () => {
    const [create, manager, participation, enrollment] = await Promise.all([
      source("apps/merchant/src/components/FutureEventMarketCreate.tsx"),
      source("apps/merchant/src/components/FutureEventMarketManager.tsx"),
      source(
        "apps/merchant/src/components/FutureEventMerchantParticipation.tsx"
      ),
      source("apps/merchant/src/hooks/useEventMarketEnrollment.ts"),
    ])
    expect(create).toContain("publishFutureEventMarketCreation")
    expect(manager).toContain("publishEventMarketMerchantDecision")
    expect(manager).toContain("retryEventMarketMerchantDecisionDelivery")
    expect(manager).toContain("readEventMarketAuthorization")
    expect(manager).toContain("expectedTipIds")
    expect(participation).toContain('auth.data?.resolution.state === "active"')
    expect(participation).toContain("auth.data.actionable === true")
    expect(enrollment).toContain("publishEventMarketEnrollment")
    expect(enrollment).toContain("retryEventMarketEnrollmentDelivery")
    expect(enrollment).not.toContain("publishEventMarketMerchantDecision")
    for (const contents of [create, manager, participation, enrollment])
      expect(contents).toContain("isAuthGenerationCurrent")
  })

  it("keeps event context during reviewed inbox setup without becoming a second inbox writer", async () => {
    const [setup, create, manager] = await Promise.all([
      source("apps/merchant/src/components/EventMessagesSetup.tsx"),
      source("apps/merchant/src/components/FutureEventMarketCreate.tsx"),
      source("apps/merchant/src/components/FutureEventMarketManager.tsx"),
    ])
    expect(setup).toContain("useInboxDeclaration")
    expect(setup).toContain("useAccountNetworkSettings")
    expect(setup).toContain("<RelaySettingsPanel")
    expect(setup).toContain("Publish or discard the relay edits")
    expect(setup).not.toContain("publishPrivateMessageRelayList")
    expect(create).toContain('<EventMessagesSetup role="host"')
    expect(manager).toContain("<EventMessagesSetup")
  })

  it("keeps event and merchant PDF signs on current selected-date destinations", async () => {
    const [manager, print] = await Promise.all([
      source("apps/merchant/src/components/FutureEventMarketManager.tsx"),
      source("apps/merchant/src/components/EventQrPrintPreview.tsx"),
    ])
    expect(manager).toContain("buildFutureEventQrSignSheets")
    expect(manager).toContain(
      "occurrenceCoordinate: selectedCalendar?.coordinate"
    )
    expect(manager).toContain("Print event and booth signs")
    expect(manager).toContain("<EventQrPrintPreview")
    expect(print).toContain("Print / Save as PDF")
    expect(print).toContain("window.print()")
  })

  it("advances one chronological presentation page with bounded counts", () => {
    expect(MERCHANT_EVENT_TIMELINE_PAGE_SIZE).toBe(12)
    expect(getNextMerchantEventTimelineLimit(12, 40)).toBe(24)
    expect(getNextMerchantEventTimelineLimit(24, 27)).toBe(27)
    expect(getNextMerchantEventTimelineLimit(-1, 5)).toBe(5)
    expect(getNextMerchantEventTimelineLimit(NaN, Infinity)).toBe(0)
  })

  it("keeps the mounted timeline progressive, centered on Now and responsive to exact date boundaries", async () => {
    const [timeline, anchor] = await Promise.all([
      source("apps/merchant/src/components/MerchantEventsTimeline.tsx"),
      source("packages/ui/src/hooks/useEventTimelineAnchor.ts"),
    ])
    expect(timeline).toContain("useProgressiveEventMarketDiscovery")
    expect(timeline).toContain("paginateEventTimeline")
    expect(timeline).toContain("useTimeBoundaryNow(timelineBoundaries)")
    expect(timeline).toContain("useEventTimelineAnchor")
    expect(anchor).toContain("!input.isFetching")
    expect(anchor).toContain("timelineViewportPositions.has(input.viewportKey)")
  })

  it("keeps event product selection on ordinary products and the current signed association", async () => {
    const [products, fulfillment] = await Promise.all([
      source("apps/merchant/src/routes/products.tsx"),
      source("apps/merchant/src/components/ProductFulfillmentEditor.tsx"),
    ])
    expect(products).toContain("Offer this product at this event")
    expect(products).toContain("readEventMarketAuthorization")
    expect(products).toContain("setEventMarketProductAssociation")
    expect(products).toContain("existing?.product.eventMarketRefs")
    expect(products).toContain(
      "buildShippingMetadata(signerPubkey, dTag, form)"
    )
    expect(fulfillment).toContain('<SelectItem value="ship">')
    expect(fulfillment).toContain('<SelectItem value="digital">')
    expect(fulfillment).not.toContain('value="local_pickup"')
  })
})
