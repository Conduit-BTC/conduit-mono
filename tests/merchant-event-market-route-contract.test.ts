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
    expect(newRoute).toContain("onCreateDismiss={closeCreation}")
    expect(newRoute).toContain('navigate({ to: "/events"')
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
    const route = await Bun.file(
      "apps/market/src/routes/events/$collectionRef.tsx"
    ).text()

    expect(route).toContain("buildMerchantEventParticipationUrl")
    expect(route).toMatch(/inferConduitAppOrigin\(\s*"merchant"/)
    expect(route).toContain("Sell at this event")
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

  it("binds owner relay reads to the live Merchant session", async () => {
    const [route, detailRoute, adapter, handoff, merchandise] =
      await Promise.all([
        Bun.file("apps/merchant/src/routes/events.tsx").text(),
        Bun.file("apps/merchant/src/routes/events/$collectionRef.tsx").text(),
        Bun.file("apps/merchant/src/lib/event-market.ts").text(),
        Bun.file("apps/merchant/src/lib/event-market-handoff.ts").text(),
        Bun.file(
          "packages/core/src/protocol/event-market-merchandise.ts"
        ).text(),
      ])

    expect(detailRoute).toContain(
      "const { pubkey, status, authGeneration } = useAuth()"
    )
    expect(detailRoute).toContain(
      "authGenerationRef.current === authGeneration"
    )
    expect(route).toContain("queryFn: ({ signal }) =>")
    expect(route).toContain("queryFn: async ({ signal }) =>")
    expect(route).toContain("shouldContinue,")
    expect(route).toMatch(
      /publishMerchantOrganizerEventMarket\(\{\r?\n\s+organizerPubkey,\r?\n\s+authenticatedPubkey,\r?\n\s+shouldContinue,/
    )
    expect(route).toMatch(
      /publishMerchantOrganizerMembership\(\{\r?\n\s+organizerPubkey,\r?\n\s+authenticatedPubkey,\r?\n\s+shouldContinue,/
    )
    expect(route).toMatch(
      /retryMerchantOrganizerRecord\(\{\r?\n\s+organizerPubkey,\r?\n\s+authenticatedPubkey,\r?\n\s+shouldContinue,/
    )
    expect(adapter).toContain("...(signal ? { signal } : {})")
    expect(adapter).toContain("...(shouldContinue ? { shouldContinue } : {})")
    expect(handoff).toContain("shouldContinue: input.shouldContinue")
    expect(handoff).toContain("signal: input.signal")
    expect(merchandise).toContain("shouldContinue: input.shouldContinue")
  })

  it("separates event discovery from ownership and publishes from the event", async () => {
    const route = await Bun.file("apps/merchant/src/routes/events.tsx").text()
    const timeline = await Bun.file(
      "apps/merchant/src/components/MerchantEventsTimeline.tsx"
    ).text()
    const panel = await Bun.file(
      "apps/merchant/src/components/MerchantEventMarketPanel.tsx"
    ).text()
    const publisher = await Bun.file(
      "apps/merchant/src/components/EventProductPublisherDialog.tsx"
    ).text()
    const adapter = await Bun.file(
      "apps/merchant/src/lib/event-product-publishing.ts"
    ).text()

    expect(route).toContain("<MerchantEventsTimeline")
    expect(route).not.toContain("<TabsTrigger")
    expect(route).not.toContain("Merchant workspace")
    expect(route).not.toContain("onSourceChange")
    expect(timeline).not.toContain("Network perspective")
    expect(timeline).not.toContain("Event timeline")
    expect(timeline).not.toContain("Browse events from your network")
    expect(timeline).toContain('aria-label="Events timeline"')
    expect(route).toContain("Create event")
    expect(timeline).toContain('source: "combined"')
    expect(timeline).toContain('organizing: "Organizing"')
    expect(timeline).toContain('selling: "Selling at"')
    expect(timeline).not.toContain('saved: "Saved"')
    expect(timeline).toContain("<MerchantEventTimelineEntry")
    expect(timeline).not.toContain("Open a known event")
    expect(route).toContain("merchantEventMarketQueryOptions")
    expect(panel).toContain("Sell at this event")
    expect(panel).toContain("isParticipationProductAvailable")
    expect(panel).toContain("eventMarketRequiredRecordsResolved")
    expect(panel).toContain("<EventProductPublisherDialog")
    expect(publisher).toContain("start from one of your")
    expect(publisher).toContain("The original listing is never changed")
    expect(publisher).toContain("Organizer hands it out")
    expect(adapter).toContain("eventProductFormFromTemplate")
    expect(adapter).toContain("signAndPublishProductListing")
    expect(adapter).toContain("buildProductLocalPickupMetadata")
  })

  it("projects discovery through result consequences and exact-hydrates a selected event", async () => {
    const route = await Bun.file("apps/merchant/src/routes/events.tsx").text()
    const timeline = await Bun.file(
      "apps/merchant/src/components/MerchantEventsTimeline.tsx"
    ).text()
    const timelineHook = await Bun.file(
      "apps/merchant/src/hooks/useMerchantEventTimeline.ts"
    ).text()
    const adapter = await Bun.file(
      "apps/merchant/src/lib/event-market.ts"
    ).text()
    const core = await Bun.file(
      "packages/core/src/protocol/event-market-discovery.ts"
    ).text()
    const query = await Bun.file(
      "apps/merchant/src/lib/merchant-event-query.ts"
    ).text()

    expect(adapter).toContain("discoverFollowedOrganizerEventMarkets")
    expect(core).toContain('projection: "discovery"')
    expect(core).toContain("FOLLOWED_EVENT_MARKET_READ_CONCURRENCY = 4")
    expect(route).toContain("getResultPresentation")
    expect(core).toContain("FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT = 128")
    expect(core).toContain("kinds: [EVENT_KINDS.PRODUCT_COLLECTION]")
    expect(core).not.toContain("FOLLOWED_EVENT_MARKET_ORGANIZER_LIMIT")
    expect(timelineHook).toContain("merchantEventTimelineQueryOptions(")
    expect(query).toContain("discoverPerspectiveEventMarkets")
    expect(timelineHook).toContain("includeEnded: true")
    expect(timelineHook).toContain("resolveEventMarketPerspectiveAuthorPubkeys")
    expect(timelineHook).toContain("qualifyMerchantEventTimelineNetwork")
    expect(timelineHook).toContain("followingQuery.isRefetchError")
    expect(timelineHook).toContain("followingQuery.isPaused")
    expect(timelineHook).toContain("conduitQuery.isRefetchError")
    expect(timelineHook).toContain("conduitQuery.isPaused")
    expect(timelineHook).toContain("hydrateMerchantEventRelationships({")
    expect(timelineHook).toContain(
      "prioritizeMerchantEventRelationshipReferences({"
    )
    expect(timelineHook).toContain(
      "if (authorPubkeys !== undefined) void refreshPerspective()"
    )
    expect(timelineHook).toContain("sellingCollectionCoordinates")
    expect(timelineHook).toMatch(
      /const productReadIncomplete =\s*\n\s*isCommerceReadIncomplete\(productsQuery\.data\?\.meta\) \|\|\s*\n\s*productsQuery\.isError \|\|\s*\n\s*productsQuery\.isPaused/
    )
    expect(timelineHook).toContain("isMerchantEventTimelineInitialLoading")
    expect(timelineHook).toMatch(
      /productRelationshipReadPending:\s*\n\s*productsQuery\.isPending && !productsQuery\.isPaused/
    )
    expect(timelineHook).toContain("listOrganizerEventMarkets")
    expect(timelineHook).not.toContain("ORGANIZER_LIMIT")
    expect(core).toContain("candidate-first relay scans")
    expect(core).toContain("readEventMarketCollectionCandidates")
    expect(timeline).toContain("getResultPresentation")
    expect(timeline).toContain("Events couldn't be fully loaded")
    expect(timeline).toContain("Retry to check for more events")
    expect(timeline).toContain(
      "Discovery is incomplete, so matching events may still be available."
    )
    expect(timeline).toContain('resultPresentation.visibility === "compact"')
    expect(timeline).not.toContain("getOrganizerDiscoveryPresentation")
    expect(timeline).not.toContain("planned bounded relay")
    expect(route).not.toContain("getOrganizerDiscoveryPresentation")
    expect(route).not.toContain("formatEventRelayReadCoverage")
    expect(query).toContain("merchantEventMarketQueryOptions")
    expect(query).toContain("resolveOrganizerEventMarketRead(")
    expect(query).toContain("onProgress")
    expect(query).toContain("complete: false")
    expect(route).toContain("getSettledMerchantEventMarketRead")
    expect(route).not.toContain("selectedFromDiscovery")
  })

  it("keeps exact selections URL-backed and prevents stale organizer actions", async () => {
    const [route, newRoute, detailRoute] = await Promise.all([
      Bun.file("apps/merchant/src/routes/events.tsx").text(),
      Bun.file("apps/merchant/src/routes/events/new.tsx").text(),
      Bun.file("apps/merchant/src/routes/events/$collectionRef.tsx").text(),
    ])
    const routeSources = `${route}\n${newRoute}\n${detailRoute}`
    const panel = await Bun.file(
      "apps/merchant/src/components/MerchantEventMarketPanel.tsx"
    ).text()

    expect(routeSources.match(/onSelected={openEvent}/g)).toHaveLength(2)
    expect(route).toContain("onSelected?.(selected)")
    expect(route).toContain("onSelected?.(reference)")
    expect(route).toContain(
      "shouldResolveSelectedReference && !selectedSettledRead"
    )
    expect(route).toContain("!selectedReferenceResolutionPending &&")
    expect(route).toContain("enabled: !!organizerPubkey && !embedded")
    expect(route).toContain("compact")
    expect(panel).toContain("compact = false")
    expect(panel).toContain("{compact ? (")
  })

  it("exposes signer, delivery, result recovery, and organizer acceptance workflows", async () => {
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
    expect(route).toContain("organizerCatalogPresentation")
    expect(route).toContain("Events couldn't be loaded")
    expect(route).toContain("Retry to check for events")
    expect(panel).toContain("acknowledged")
    expect(panel).toContain("rejected")
    expect(panel).toContain("timed out")
    expect(panel).toContain("Retry delivery")
    expect(panel).toContain("Pending request")
    expect(panel).toContain("label={actionability.label}")
    expect(panel).toContain(
      'removable ? "Remove" : canAccept ? "Accept" : "Cannot accept"'
    )
    expect(panel).toContain("disabled={pending || (!removable && !canAccept)}")
    expect(panel).toContain("<SignedProductPreview item={item} />")
    expect(panel).toContain("Exact merchant-signed listing")
    expect(panel).toContain("No signed product description.")
    expect(panel).toContain("formatSourcePrice")
    expect(panel).toContain("productPreview.images[0]")
    expect(panel).toContain("isParticipationProductPreviewVerified")
    expect(panel).toContain('data-preview-state="unavailable"')
    expect(panel).toContain(
      "The exact signed product preview is unavailable or no longer matches this request."
    )
    expect(panel).toContain("organizer-owned collection coordinate")
    expect(route).toContain("loadOrganizerEventMarketDeliveryOutbox")
    expect(route).toContain("saveOrganizerEventMarketDelivery")
    expect(
      route.match(/findSavedOrganizerEventMarketReference/g)?.length
    ).toBeGreaterThanOrEqual(4)
    expect(route).toMatch(
      /setSelectedReference\(reference\)\r?\n\s+onSelected\?\.\(reference\)/
    )
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

  it("makes event authoring requirements and modal state explicit", async () => {
    const route = await Bun.file("apps/merchant/src/routes/events.tsx").text()
    const editor = await Bun.file(
      "apps/merchant/src/components/OrganizerEventMarketEditor.tsx"
    ).text()
    const form = await Bun.file(
      "apps/merchant/src/lib/event-market-form.ts"
    ).text()
    expect(editor).toContain("Fields marked Required")
    expect(editor).toContain("RequiredFieldLabel")
    expect(editor).toContain("Event photo URL")
    expect(editor).toContain("https://nostrcheck.me/media")
    expect(editor).toContain("Browser extension upload")
    expect(editor).toContain("approve it with your Nostr signer")
    expect(editor).toContain("Copy the direct HTTPS")
    expect(editor).toContain("supports Blossom")
    expect(editor).toContain("NIP-96")
    expect(editor).toContain('rel="noopener noreferrer"')
    expect(editor).toContain("getOrganizerEventTimezoneOptions")
    expect(editor).toContain("No changes to publish")
    expect(editor).toContain("isOrganizerEventMarketFormDirty")
    expect(form).toContain('"America/Chicago"')
    expect(form).toContain("browserTimezone()")

    const openEdit = route.slice(
      route.indexOf("function openEdit(): void"),
      route.indexOf("async function copyShareLink")
    )
    expect(openEdit).toContain('setPublishState("idle")')
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
})
