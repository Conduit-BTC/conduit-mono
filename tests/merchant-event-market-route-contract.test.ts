import { describe, expect, it } from "bun:test"

describe("merchant organizer event market route", () => {
  it("registers the authenticated route, navigation, and page title", async () => {
    const route = await Bun.file("apps/merchant/src/routes/events.tsx").text()
    const header = await Bun.file(
      "apps/merchant/src/components/MerchantHeader.tsx"
    ).text()
    const root = await Bun.file("apps/merchant/src/routes/__root.tsx").text()
    const tree = await Bun.file("apps/merchant/src/routeTree.gen.ts").text()

    expect(route).toContain('createFileRoute("/events")')
    expect(route).toContain("requireAuth()")
    expect(header).toContain('{ to: "/events", label: "Events"')
    expect(root).toContain('if (pathname === "/events") return "Events"')
    expect(tree).toContain("'/events': typeof EventsRoute")
  })

  it("keeps protocol behavior behind the Merchant adapter", async () => {
    const route = await Bun.file("apps/merchant/src/routes/events.tsx").text()

    expect(route).toContain("listOrganizerEventMarkets")
    expect(route).toContain("publishMerchantOrganizerEventMarket")
    expect(route).toContain("publishMerchantOrganizerMembership")
    expect(route).toContain("retryMerchantOrganizerRecord")
    expect(route).not.toContain("NDKEvent")
    expect(route).not.toContain("parseProductEvent")
    expect(route).not.toContain("kind: 30405")
    expect(route).not.toContain("kind: 30406")
    expect(route.toLowerCase()).not.toContain("chicago")
  })

  it("separates event discovery from ownership and publishes from the event", async () => {
    const route = await Bun.file("apps/merchant/src/routes/events.tsx").text()
    const panel = await Bun.file(
      "apps/merchant/src/components/MerchantEventMarketPanel.tsx"
    ).text()
    const publisher = await Bun.file(
      "apps/merchant/src/components/EventProductPublisherDialog.tsx"
    ).text()
    const adapter = await Bun.file(
      "apps/merchant/src/lib/event-product-publishing.ts"
    ).text()

    expect(route).toContain(
      '<TabsTrigger value="find">Find events</TabsTrigger>'
    )
    expect(route).toContain('<TabsTrigger value="mine">My events</TabsTrigger>')
    expect(route).toContain("discoverFollowedEventMarkets")
    expect(route).toContain("loadSavedDiscoveredEventMarkets")
    expect(route).toContain(
      "This event belongs to another organizer. Open it under Find events."
    )
    expect(panel).toContain("Sell at this event")
    expect(panel).toContain("<EventProductPublisherDialog")
    expect(publisher).toContain("start from one of your")
    expect(publisher).toContain("The original listing is never changed")
    expect(publisher).toContain("Organizer hands it out")
    expect(adapter).toContain("eventProductFormFromTemplate")
    expect(adapter).toContain("signAndPublishProductListing")
    expect(adapter).toContain("buildProductLocalPickupMetadata")
  })

  it("shows explicit bounded discovery states and exact-hydrates a selected event", async () => {
    const route = await Bun.file("apps/merchant/src/routes/events.tsx").text()
    const adapter = await Bun.file(
      "apps/merchant/src/lib/event-market.ts"
    ).text()
    const core = await Bun.file(
      "packages/core/src/protocol/event-market-discovery.ts"
    ).text()

    expect(adapter).toContain("discoverFollowedOrganizerEventMarkets")
    expect(core).toContain('projection: "discovery"')
    expect(core).toContain("FOLLOWED_EVENT_MARKET_READ_CONCURRENCY = 4")
    expect(route).toContain('discoveryQuery.data?.state === "partial"')
    expect(route).toContain('discoveryQuery.data?.state === "unavailable"')
    expect(route).toContain('discoveryQuery.data?.state === "complete_empty"')
    expect(route).toContain("Retry event discovery")
    expect(route).toContain(
      "Checking followed organizers on their planned relays"
    )
    expect(route).toContain("no global event absence is inferred")
    expect(route).toContain("aria-label={`View ${market.title}`}")
    expect(route).toContain("resolveOrganizerEventMarket(")
    expect(route).toContain("merchantPubkey,\n        signal")
    expect(route).not.toContain("selectedFromDiscovery")
  })

  it("exposes signer, delivery, degraded evidence, and organizer acceptance workflows", async () => {
    const route = await Bun.file("apps/merchant/src/routes/events.tsx").text()
    const editor = await Bun.file(
      "apps/merchant/src/components/OrganizerEventMarketEditor.tsx"
    ).text()
    const panel = await Bun.file(
      "apps/merchant/src/components/OrganizerEventMarketPanel.tsx"
    ).text()

    expect(editor).toContain("Confirm each organizer record in your signer")
    expect(route).toContain(
      'if (record.record === "collection") setPublishState("publishing")'
    )
    expect(editor).toContain("Everything here is published publicly")
    expect(route).toContain("Organizer discovery is degraded")
    expect(route).toContain("No missing event is inferred")
    expect(panel).toContain("acknowledged")
    expect(panel).toContain("rejected")
    expect(panel).toContain("timed out")
    expect(panel).toContain("Retry delivery")
    expect(panel).toContain("Pending request")
    expect(panel).toContain(
      'removable ? "Remove" : canAccept ? "Accept" : "Cannot accept"'
    )
    expect(panel).toContain("disabled={pending || (!removable && !canAccept)}")
    expect(panel).toContain("<SignedProductPreview item={item} />")
    expect(panel).toContain("Exact signed listing")
    expect(panel).toContain("No signed product description.")
    expect(panel).toContain("formatSourcePrice")
    expect(panel).toContain("productPreview.images[0]")
    expect(panel).toContain("isParticipationProductPreviewVerified")
    expect(panel).toContain('data-preview-state="unavailable"')
    expect(panel).toContain(
      "The exact signed product preview is unavailable or no longer matches this request."
    )
    expect(panel).toContain("organizer-owned collection coordinate")
    expect(panel).toContain("Canonical event catalog QR code")
    expect(panel).toContain("<QRCodeSVG value={shareUrl}")
    expect(route).toContain("loadOrganizerEventMarketDeliveryOutbox")
    expect(route).toContain("saveOrganizerEventMarketDelivery")
    expect(
      route.match(/findSavedOrganizerEventMarketReference/g)?.length
    ).toBeGreaterThanOrEqual(4)
    expect(route).not.toContain("setSelectedReference(reference)")
  })

  it("keeps merchant booth pickup evidence on the merchant product graph", async () => {
    const adapter = await Bun.file(
      "apps/merchant/src/lib/event-market.ts"
    ).text()

    expect(adapter).toContain(
      "pickupCoordinates: pickupCoordinate ? [pickupCoordinate] : []"
    )
    expect(adapter).toContain(
      "pickupCoordinates: input.market.pickupCoordinate"
    )
    expect(adapter).not.toContain("getOrganizerEventUpdatePickupCoordinates")
    expect(adapter).not.toContain("...input.market.pickupCoordinates")
    expect(adapter).not.toContain("acceptedPickupCoordinate")
    expect(adapter).toContain("isParticipationHandoffVerified(")
    expect(adapter).toContain(
      "isParticipationProductPreviewVerified(input.item)"
    )
  })

  it("keeps product local-pickup import in a focused editor and Core-backed adapter", async () => {
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
    expect(editor).toContain('<SelectItem value="local_pickup">Local pickup')
    expect(editor).toContain("Event catalog naddr or link")
    expect(editor).toContain("Your active organizer events")
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
    expect(orders).toContain("await assertCurrentPickupAuthorization()")
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
    expect(queue).toContain("Mark handed out")
    expect(queue).toContain("formatEventMarketPickupClaimCode")
    expect(queue).toContain("safePickupClaimCode")
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
})
