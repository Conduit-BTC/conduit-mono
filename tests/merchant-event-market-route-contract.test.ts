import { describe, expect, it } from "bun:test"
import { subscribeToTimeBoundaries } from "@conduit/ui"
import type { PerspectiveEventMarketDiscoveryResult } from "@conduit/core"
import type { MerchantOrganizerEventMarket } from "../apps/merchant/src/lib/event-market"
import {
  filterAndSortMerchantEventTimeline,
  getMerchantEventTimelineStatus,
  qualifyMerchantEventTimelineNetwork,
  type MerchantEventTimelineItem,
} from "../apps/merchant/src/lib/merchant-event-timeline"
import { createFakeTimeBoundaryClock } from "./helpers/fake-time-boundary-clock"

function timedTimelineItem(
  suffix: string,
  startMs: number,
  endMs: number
): MerchantEventTimelineItem {
  const organizer = "a".repeat(64)
  const collectionCoordinate = `30405:${organizer}:${suffix}`
  const calendarCoordinate = `31923:${organizer}:${suffix}`
  const market: MerchantOrganizerEventMarket = {
    state: "active",
    organizerPubkey: organizer,
    collectionCoordinate,
    calendarCoordinate,
    pickupCoordinates: [],
    naddr: collectionCoordinate,
    title: suffix,
    calendarKind: 31923,
    start: startMs / 1_000,
    end: endMs / 1_000,
    collectionCreatedAt: 1,
    productCoordinates: [],
    participation: [],
    source: {
      state: "active",
      reference: collectionCoordinate,
      organizerPubkey: organizer,
      collectionCoordinate,
      calendarCoordinate,
      organizerProductCoordinates: [],
      acceptedProductCoordinates: [],
      acceptedProductEvidence: [],
      organizerOnlyProductCoordinates: [],
      participationRequests: [],
      pickups: [],
      participationBudget: {
        state: "within_budget",
        targetCount: 0,
        targetLimit: 64,
      },
      pickupBudget: {
        state: "within_budget",
        targetCount: 0,
        targetLimit: 64,
      },
      coverage: {
        attemptedRelayCount: 1,
        completeRelayCount: 1,
        partialRelayCount: 0,
        failedRelayCount: 0,
      },
    },
  }
  return { market, relationships: [], reconciliationPending: false }
}

describe("merchant organizer event market route", () => {
  it("retains verified markets while limiting stale perspective coverage", () => {
    const markets = [timedTimelineItem("retained", 0, 1).market.source]
    const network = (
      source: PerspectiveEventMarketDiscoveryResult["perspective"]["source"],
      coverage: PerspectiveEventMarketDiscoveryResult["perspective"]["coverage"] = "complete"
    ): PerspectiveEventMarketDiscoveryResult => ({
      state: "complete",
      markets,
      perspective: {
        source,
        coverage,
        eventObserved: true,
        snapshotState: "network",
        truncated: false,
        authorCount: 1,
      },
      candidateScanCoverage: {
        plannedReadCount: 1,
        completeReadCount: 1,
      },
      candidateCollectionCount: 1,
      candidateScanState: "complete",
      searchedOrganizerCount: 1,
      incompleteOrganizerCount: 0,
      failedOrganizerCount: 0,
      boundedOrganizerCount: 1,
      truncated: false,
    })

    for (const source of ["following", "conduit", "combined"] as const) {
      const retained = network(source)
      const qualified = qualifyMerchantEventTimelineNetwork(retained, true)!
      expect(qualified).not.toBe(retained)
      expect(qualified.markets).toBe(markets)
      expect(qualified.perspective.coverage).toBe("limited")
      expect(qualifyMerchantEventTimelineNetwork(retained, false)).toBe(
        retained
      )
    }

    for (const coverage of ["limited", "unavailable"] as const) {
      const alreadyIncomplete = network("combined", coverage)
      expect(qualifyMerchantEventTimelineNetwork(alreadyIncomplete, true)).toBe(
        alreadyIncomplete
      )
    }
  })

  it("registers canonical event routes without replacing signed-out URLs", async () => {
    const route = await Bun.file("apps/merchant/src/routes/events.tsx").text()
    const indexRoute = await Bun.file(
      "apps/merchant/src/routes/events/index.tsx"
    ).text()
    const newRoute = await Bun.file(
      "apps/merchant/src/routes/events/new.tsx"
    ).text()
    const detailRoute = await Bun.file(
      "apps/merchant/src/routes/events/$collectionRef.tsx"
    ).text()
    const dashboardRoute = await Bun.file(
      "apps/merchant/src/routes/index.tsx"
    ).text()
    const header = await Bun.file(
      "apps/merchant/src/components/MerchantHeader.tsx"
    ).text()
    const root = await Bun.file("apps/merchant/src/routes/__root.tsx").text()
    const tree = await Bun.file("apps/merchant/src/routeTree.gen.ts").text()

    expect(route).toContain('createFileRoute("/events")')
    expect(indexRoute).toContain('createFileRoute("/events/")')
    expect(newRoute).toContain('createFileRoute("/events/new")')
    expect(detailRoute).toContain('createFileRoute("/events/$collectionRef")')
    expect(route).toContain('to: "/events/$collectionRef"')
    expect(dashboardRoute).toContain('to: "/events/$collectionRef"')
    expect(dashboardRoute).toContain("params: { collectionRef: pendingEvent }")
    expect(route).not.toContain("requireAuth")
    expect(newRoute).not.toContain("requireAuth")
    expect(detailRoute).not.toContain("requireAuth")
    expect(newRoute).toContain(
      "<FutureEventMarketCreate onPublished={openEvent} />"
    )
    expect(newRoute).not.toContain("OrganizerEventMarketEditor")
    expect(root).toContain("if (!signerWorkspaceAvailable)")
    expect(root).toContain("<ConnectGate />")
    expect(root).toContain("<Outlet key={pubkey} />")
    expect(header).toContain('{ to: "/events", label: "Events"')
    expect(root).toContain('pathname.startsWith("/events/")')
    expect(tree).toContain("'/events': typeof EventsRoute")
    expect(tree).toContain("'/events/new': typeof EventsNewRoute")
    expect(tree).toContain(
      "'/events/$collectionRef': typeof EventsCollectionRefRoute"
    )
  })

  it("links the Market event page to the canonical Merchant detail route", async () => {
    const [route, futurePage] = await Promise.all([
      Bun.file("apps/market/src/routes/events/$collectionRef.tsx").text(),
      Bun.file("apps/market/src/components/FutureEventMarketPage.tsx").text(),
    ])

    expect(route).toContain("<FutureEventMarketPage")
    expect(futurePage).toContain("buildMerchantEventParticipationUrl")
    expect(futurePage).toMatch(/inferConduitAppOrigin\(\s*"merchant"/)
    expect(futurePage).toContain("Sell here")
  })

  it("keeps the initial timeline centered on Now while progressive results arrive", async () => {
    const [timeline, anchor] = await Promise.all([
      Bun.file(
        "apps/merchant/src/components/MerchantEventsTimeline.tsx"
      ).text(),
      Bun.file("packages/ui/src/hooks/useEventTimelineAnchor.ts").text(),
    ])

    expect(timeline).toContain("useEventTimelineAnchor")
    expect(anchor).toContain("!input.isFetching")
    expect(anchor).toContain("input.pastCount")
    expect(anchor).toContain("timelineViewportPositions.has(input.viewportKey)")
  })

  it("keeps ordinary event pages focused on people and actions", async () => {
    const [detailRoute, organizerPanel] = await Promise.all([
      Bun.file("apps/merchant/src/routes/events/$collectionRef.tsx").text(),
      Bun.file(
        "apps/merchant/src/components/OrganizerEventMarketPanel.tsx"
      ).text(),
    ])

    expect(detailRoute).toContain("Back to events")
    expect(detailRoute).not.toContain(">\n            All events\n")
    expect(organizerPanel).not.toContain("Refresh evidence")
    expect(organizerPanel).not.toContain("Technical details")
    expect(organizerPanel).not.toContain("formatEventRelayReadCoverage")
  })

  it("hydrates merchant identity without changing organizer acceptance authority", async () => {
    const panel = await Bun.file(
      "apps/merchant/src/components/OrganizerEventMarketPanel.tsx"
    ).text()

    expect(panel).toContain("maxUnresolvedRefetches: 1")
    expect(panel).toContain('data-testid="participation-merchant-identity"')
    expect(panel).toContain("data-profile-state={state}")
    expect(panel).toContain('"Profile not loaded"')
    expect(panel).not.toContain("No public profile found")
    expect(panel).toContain("getProfileName(profile)")
    expect(panel).toContain("Copy npub")
    expect(panel).toContain("getStorefrontUrl(pubkey)")
    expect(panel).toContain("Open storefront")
    expect(panel).toContain("Profile context is informational")
    expect(panel).toContain(
      "const canAccept = handoffVerified && previewVerified"
    )
    expect(panel).toContain("disabled={pending || (!removable && !canAccept)}")
  })

  it("keeps merchant booth pickup evidence on the merchant product graph", async () => {
    const adapter = await Bun.file(
      "apps/merchant/src/lib/event-market.ts"
    ).text()

    expect(adapter).toContain(
      "pickupCoordinates: pickupCoordinate ? [pickupCoordinate] : []"
    )
    expect(adapter).toContain("pickupCoordinates: market.pickupCoordinates")
    expect(adapter).not.toContain("getOrganizerEventUpdatePickupCoordinates")
    expect(adapter).not.toContain("...input.market.pickupCoordinates")
    expect(adapter).not.toContain("acceptedPickupCoordinate")
    expect(adapter).toContain("isParticipationHandoffVerified(")
    expect(adapter).toContain(
      "isParticipationProductPreviewVerified(input.item)"
    )
  })

  it("keeps ordinary product shipping and future market tagging while retiring old pickup authoring", async () => {
    const products = await Bun.file(
      "apps/merchant/src/routes/products.tsx"
    ).text()
    const editor = await Bun.file(
      "apps/merchant/src/components/ProductFulfillmentEditor.tsx"
    ).text()

    expect(products).toContain("<ProductFulfillmentEditor")
    expect(products).toContain("resolveOrganizerEventMarket(")
    expect(products).toContain("buildProductLocalPickupMetadata")
    expect(editor).toContain('<SelectItem value="digital">Digital')
    expect(editor).toContain('<SelectItem value="ship">Ship')
    expect(editor).not.toContain('<SelectItem value="local_pickup">')
    expect(products).toContain("Collection-based event pickup is retired")
    expect(products).toContain("readEventMarketAuthorization({")
    expect(products).toContain("Event Market naddr or 30409 coordinate")
    expect(products).toContain("Event Market")
    expect(products).toContain("listOrganizerEventMarkets")
    expect(products).toContain('market.state === "active"')
    expect(editor).toContain("Request pending")
    const publishProduct = products.slice(
      products.indexOf("async function publishProduct("),
      products.indexOf("async function deleteProduct(")
    )
    expect(publishProduct).not.toContain("resolveEventMarketOrganizerInbox")
    expect(publishProduct).not.toContain(
      "Organizer handoff requires a usable kind-10050"
    )
    expect(products).not.toContain("nip19.decode")
    expect(products.toLowerCase()).not.toContain("chicago")
  })

  it("verifies the signed pickup snapshot before the Merchant order workflow", async () => {
    const orders = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(orders).toContain("getMerchantOrderFulfillment(")
    expect(orders).toContain("verifyMerchantPickupOrderAuthorization(")
    expect(orders).toContain(
      'pickupAuthorizationQuery.data?.status === "verified"'
    )
    expect(orders).toContain("!snapshottedOrderFulfillment.hasPickupClaim ||")
    expect(orders).toContain("snapshottedOrderFulfillment.hasPickupClaim,")
    expect(orders).toContain("fulfillmentMode: orderFulfillment.mode")
    expect(orders).toContain(
      "requiresShipping: orderFulfillment.requiresShipping"
    )
    expect(orders).toContain("<PickupFulfillmentCard")
    expect(orders).toContain(
      "const organizerIdentityPubkey = normalizeEventActorPubkey("
    )
    expect(orders).toContain("useProfile(organizerIdentityPubkey")
    expect(orders).toContain('data-testid="merchant-order-pickup"')
    expect(orders).toContain('data-testid="merchant-order-pickup-unverified"')
    expect(orders).toContain(
      "Current organizer-authored public pickup evidence"
    )
    expect(orders).not.toContain(
      'mode: "unknown",\n          requiresShipping: true,\n          pickup: null'
    )
    expect(orders).toContain("orderFulfillment.requiresShipping &&")
    expect(orders).toContain("primaryButtonActions.map((action)")
    expect(orders).toContain(
      "await assertCurrentPickupAuthorization(authority)"
    )
    expect(orders).toContain(
      "Pickup orders do not use carrier or tracking details."
    )
    expect(orders).toContain(
      "if (!snapshottedOrderFulfillment.hasPickupClaim) return null"
    )
    expect(orders).toContain(
      "pickupAuthorizationVerified && orderFulfillment.pickup"
    )
    expect(orders).toContain("isZeroCostPickup: isAuthorizedZeroCostPickup")
    expect(
      orders.match(
        /delivery\.record\.orderCorrelationRef === selectedOrderCorrelationRef/g
      )?.length
    ).toBeGreaterThanOrEqual(2)
    expect(orders).toContain(
      "pickupFulfillmentActionsAuthorized && !organizerCompletionBlocked"
    )
    expect(orders).toContain(
      'assertPaidForFulfillment(nextStatus === "complete")'
    )
    const advanceStatus = orders.slice(
      orders.indexOf("const advanceStatusMutation = useMutation({"),
      orders.indexOf("const shippingMutation = useMutation({")
    )
    expect(advanceStatus).toContain(
      "releaseCompletedEventMarketHandoffReceipt("
    )
    expect(
      advanceStatus.indexOf("releaseCompletedEventMarketHandoffReceipt(")
    ).toBeGreaterThan(
      advanceStatus.indexOf("await publishMerchantOrderMessage({")
    )
  })

  it("refetches acknowledgement evidence for the exact ready receipt on mount", async () => {
    const orders = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const queryStart = orders.indexOf("const handoffAcksQuery = useQuery({")
    const queryEnd = orders.indexOf("const selectedReadyGraph", queryStart)
    const query = orders.slice(queryStart, queryEnd)

    expect(queryStart).toBeGreaterThan(-1)
    expect(queryEnd).toBeGreaterThan(queryStart)
    expect(query).toContain(
      'selectedReadyDelivery?.record.readyReceiptId ?? "none"'
    )
    expect(query).toContain('selectedReadyDelivery?.record.claimRef ?? "none"')
    expect(query).toContain("staleTime: 0")
    expect(query).toContain('refetchOnMount: "always"')
    expect(query).not.toContain("staleTime: 15_000")
    expect(orders).toContain("resolveMerchantHandoffAckReadState")
    expect(orders).toContain(
      "const currentAckRead = await handoffAcksQuery.refetch()"
    )
    expect(orders).toContain('case "coverage_incomplete"')
    expect(orders).toContain("handoffAckDiscoveryDegraded")
    expect(orders).toContain("data-ack-read-state={")
    expect(orders).toContain('handoffAckState.blocker ?? "clear"')
    expect(orders).toContain(
      'data-ack-exact={exactHandoffAck ? "true" : "false"}'
    )
    expect(orders).not.toContain(
      "const handoffAckEvidenceBlocked =\n    !!selectedReadyDelivery &&\n    (handoffAcksQuery.isFetching"
    )
  })

  it("keeps handoff consent explicit and organizer authority narrowly scoped", async () => {
    const eventEditor = await Bun.file(
      "apps/merchant/src/components/OrganizerEventMarketEditor.tsx"
    ).text()
    const productEditor = await Bun.file(
      "apps/merchant/src/components/ProductFulfillmentEditor.tsx"
    ).text()
    const queue = await Bun.file(
      "apps/merchant/src/components/OrganizerHandoffReceiptQueue.tsx"
    ).text()
    const handoff = await Bun.file(
      "apps/merchant/src/lib/event-market-handoff.ts"
    ).text()
    const orders = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(eventEditor).toContain("Organizer can hand out products")
    expect(eventEditor).toContain("not independent payment proof")
    expect(eventEditor).toContain(
      "Pickup uses the event venue and adds no charge"
    )
    expect(eventEditor).toContain("organizerHandoffEnabled")
    expect(productEditor).toContain("Merchant hands out")
    expect(productEditor).toContain("Organizer hands out")
    expect(productEditor).toContain("usable kind-10050 receipt inbox")
    expect(productEditor).toContain("checkout stays closed")
    expect(productEditor).toContain("disabled={!market.pickupCoordinate}")
    expect(productEditor).not.toContain(
      '!market.pickupCoordinate || organizerInboxState !== "ready"'
    )
    expect(productEditor).toContain("no organizer receipt is shared")
    expect(queue).toContain("Only minimal merchant-authorized pickup receipts")
    expect(queue).toContain("degradedResultsAreMaterial: true")
    expect(queue).toContain('resultPresentation.visibility === "compact"')
    expect(queue).toContain("(!loading || claims.length > 0)")
    expect(queue).toContain("disabled={loading}")
    expect(queue).toContain(
      "Retry before handing out an item to check for a newer or revoked receipt."
    )
    expect(queue).toContain("Mark handed out")
    expect(queue).toContain("formatEventMarketPickupClaimCode")
    expect(queue).toContain("safePickupClaimCode")
    expect(queue).toContain(
      "normalizeEventActorPubkey(claim.receipt.payload.merchantPubkey)"
    )
    expect(queue).toContain(
      "merchantProfilesQuery.getProfile(\n                      merchantIdentityPubkey"
    )
    expect(queue).toContain("Product details unavailable")
    expect(queue).toContain("Exact signed product evidence")
    expect(queue).toContain("isVerifiedEventMarketReceiptMerchandiseResolution")
    expect(queue).not.toContain("item.variants.map")
    expect(handoff).toContain("buildEventMarketReadyReceiptPayload")
    expect(handoff).toContain("getEventMarketReceiptMerchandise")
    expect(handoff).toContain("resolveEventMarketHandoffAckGate")
    expect(handoff).toContain("market: input.market")
    expect(handoff).toContain("merchandise: input.merchandise")
    expect(handoff).not.toContain("randomUUID")
    expect(queue).not.toContain("publishMerchantOrderMessage")
    expect(queue).not.toContain("confirm_payment")
    expect(queue).not.toContain("payment_request")
    expect(orders).toContain("issueOrganizerReadyReceipt")
    expect(orders).toContain("Confirm organizer release")
    expect(orders).toContain("I confirm payment is settled")
    expect(orders).toContain("authorizationConfirmed,")
    expect(orders).toContain("organizerReceiptMutation.mutate(true)")
    expect(orders).toContain("revokeOrganizerReadyReceipt")
    expect(orders).toContain("resolveMerchantHandoffAckReadState")
    expect(orders).toContain("Coordinate and take over handoff")
    expect(orders).toContain(
      "delivery.record.readyReceiptId === marker?.readyReceiptId"
    )
    expect(handoff).not.toContain("coordinatedFallbackConfirmed")
    expect(orders).not.toContain("scopedHandoffAcks.find")
    expect(orders).toContain("Use the existing Mark complete action")
    expect(orders).not.toContain(
      'recordBrowserTelemetryEvent({\n        app: "merchant",\n        eventName: "organizer'
    )
  })

  it("recomputes a mounted Merchant timeline at event boundaries", async () => {
    const timeline = await Bun.file(
      "apps/merchant/src/components/MerchantEventsTimeline.tsx"
    ).text()
    const start = 1_000
    const end = 2_000
    const item = timedTimelineItem("boundary", start, end)
    const later = timedTimelineItem("later", 3_000, 4_000)
    const clock = createFakeTimeBoundaryClock(start - 1)
    const observedBoundaries: number[] = []
    let renderedNowMs = clock.now()
    const unmount = subscribeToTimeBoundaries({
      boundaries: [start, end, 3_000, 4_000],
      currentNowMs: renderedNowMs,
      onBoundary: (nowMs) => {
        observedBoundaries.push(nowMs)
        renderedNowMs = nowMs
      },
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })

    expect(timeline).toContain("useTimeBoundaryNow(timelineBoundaries)")
    expect(timeline).not.toContain("const nowMs = Date.now()")
    expect(timeline).not.toContain("setInterval")
    expect(
      filterAndSortMerchantEventTimeline([item], {}, renderedNowMs)
    ).toHaveLength(1)

    clock.advanceTo(start)
    expect(observedBoundaries).toEqual([start])
    expect(
      filterAndSortMerchantEventTimeline([item], {}, renderedNowMs)
    ).toHaveLength(1)

    clock.advanceTo(end)
    expect(observedBoundaries).toEqual([start, end])
    expect(
      filterAndSortMerchantEventTimeline([item], {}, renderedNowMs)
    ).toHaveLength(1)
    expect(getMerchantEventTimelineStatus(item, renderedNowMs).label).toBe(
      "Past event"
    )
    expect(
      filterAndSortMerchantEventTimeline([later], {}, renderedNowMs)
    ).toHaveLength(1)
    expect(clock.pendingTimerCount()).toBe(1)

    unmount()
    expect(clock.pendingTimerCount()).toBe(0)
  })

  it("uses one future market writer and keeps historical event links read only", async () => {
    const [newRoute, detailRoute, futureCreate, futureManager] =
      await Promise.all([
        Bun.file("apps/merchant/src/routes/events/new.tsx").text(),
        Bun.file("apps/merchant/src/routes/events/$collectionRef.tsx").text(),
        Bun.file(
          "apps/merchant/src/components/FutureEventMarketCreate.tsx"
        ).text(),
        Bun.file(
          "apps/merchant/src/components/FutureEventMarketManager.tsx"
        ).text(),
      ])
    expect(newRoute).toContain("<FutureEventMarketCreate")
    expect(newRoute).not.toContain("OrganizerEventMarketEditor")
    expect(detailRoute).toContain(
      "decodeEventMarketReference(collectionRef, [30409])"
    )
    expect(detailRoute).toContain("<LegacyEventReadOnly")
    expect(detailRoute).not.toContain("publishMerchantOrganizerEventMarket")
    expect(futureCreate).toContain("publishEventMarketRoster")
    expect(futureManager).toContain("publishEventMarketMerchantDecision")
    expect(futureManager).toContain("retryEventMarketMerchantDecisionDelivery")
    expect(futureManager).toContain("readEventMarketAuthorization")
    expect(futureManager).toContain("expectedTipIds")
    expect(futureManager).toContain("isAuthGenerationCurrent")
  })

  it("routes future catalog and products through current signed evidence", async () => {
    const [marketRoute, futurePage, products] = await Promise.all([
      Bun.file("apps/market/src/routes/events/$collectionRef.tsx").text(),
      Bun.file("apps/market/src/components/FutureEventMarketPage.tsx").text(),
      Bun.file("apps/merchant/src/routes/products.tsx").text(),
    ])
    expect(marketRoute).toContain("<FutureEventMarketPage")
    expect(futurePage).toContain("readEventMarketCatalog")
    expect(futurePage).toContain("buildMerchantEventParticipationUrl")
    expect(products).toContain("readEventMarketRoster")
    expect(products).toContain("readEventMarketAuthorization")
    expect(products).toContain("Collection-based event pickup is retired")
  })
})
