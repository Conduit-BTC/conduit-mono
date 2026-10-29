import { afterEach, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  QueryClient,
  QueryObserver,
} from "../apps/merchant/node_modules/@tanstack/react-query"
import type { ConduitDB } from "@conduit/core/db"
import {
  assertCheckoutSparkOrganizerCommerceProof,
  assertEventMarketOrganizerPurchaseAuthority,
} from "@conduit/core"
import type { EventMarketOrganizerMerchandise } from "@conduit/core/protocol/event-market-organizer-merchandise"
import {
  EventMarketOrganizerPickupForm,
  EventMarketOrganizerRecoveryDiscoveryNotice,
  EventMarketOrganizerRecoveryReadDetails,
  continueEventMarketOrganizerPickup,
} from "../apps/merchant/src/components/EventMarketOrganizerPickupCard"
import { eventMarketFreePurchaseFixture } from "./support/event-market-free-purchase-fixture"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import { createInMemoryInboxDeclarationEvidenceRepository } from "@conduit/core/protocol/inbox-declaration-evidence"
import { admitFixture } from "./helpers/public-event"
import {
  CheckoutSparkOrganizerRoutingTimeoutError,
  createCheckoutSparkOrganizerRoutingObservation,
} from "../apps/merchant/src/lib/checkout-spark-organizer-routing-observation"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})
const controls = {
  orderLabel: "example",
  quantity: 1,
  routing: false,
  paymentVerified: false,
  handedOut: false,
  waitingForBuyer: false,
  claimCode: "",
  onClaimCode: () => {},
  onContinue: () => {},
  onPause: () => {},
  onHandout: () => {},
  onRetryHandout: () => {},
}

it("keeps an inactive routed purchase waiting for Pay instead of inventing a recovery deadline", () => {
  const markup = renderToStaticMarkup(
    <EventMarketOrganizerPickupForm
      {...controls}
      waitingForBuyer
      buyerNotStarted
    />
  )
  expect(markup).toContain("Waiting for buyer to start payment")
  expect(markup).toContain("Recovery timing starts when the buyer chooses Pay")
  expect(markup).not.toContain("buyer still has time to finish routing")
  const button = markup.match(
    /<button\b[^>]*>Continue this order<\/button>/
  )?.[0]
  expect(button).toContain('disabled=""')
})

it("shows one actionable incomplete-history notice rather than claiming the inbox is empty", () => {
  for (const selectionCount of [0, 1]) {
    const markup = renderToStaticMarkup(
      <EventMarketOrganizerRecoveryDiscoveryNotice
        missingInitialCheckouts={1}
        selectionCount={selectionCount}
        conflictingCheckouts={1}
        capped
      />
    )
    expect(markup).toContain("Payment updates are saved")
    expect(markup).toContain("needs reconciliation before another action")
    expect(markup).toContain("original recovery message is not available")
    expect(markup).toContain("Refresh or load older saved event orders")
    expect(markup).toContain("Do not pay again")
    expect(markup).not.toContain("No event pickup or checkout recovery")
    expect(markup.match(/role="status"/g)?.length).toBe(1)
    expect(markup).not.toContain("<button")
  }
})

it("clears the missing-initial notice once ready and preserves bounded empty/conflicting states", () => {
  const render = (selectionCount: number, conflictingCheckouts = 0) =>
    renderToStaticMarkup(
      <EventMarketOrganizerRecoveryDiscoveryNotice
        missingInitialCheckouts={0}
        selectionCount={selectionCount}
        conflictingCheckouts={conflictingCheckouts}
        capped={false}
      />
    )
  expect(render(1)).toBe("")
  expect(render(0)).toContain("This does not prove no older order exists")
  expect(render(0, 1)).toContain("needs reconciliation")
  expect(render(0, 1)).not.toContain("No event pickup or checkout recovery")
})

it("keeps aggregate recovery read counts collapsed and separate from payment or handout actions", () => {
  const markup = renderToStaticMarkup(
    <EventMarketOrganizerRecoveryReadDetails
      readDetails={{
        allOrganizerInitial: 3,
        allOrganizerProgress: 8,
        selectedMarketInitial: 1,
        selectedMarketProgress: 5,
        missingInitialWrapper: 1,
      }}
      missingInitialCheckouts={2}
      conflictingCheckouts={4}
      capped
    />
  )
  expect(markup).toContain("Recovery read details")
  expect(markup).toContain("All saved initial recovery messages</dt><dd>3")
  expect(markup).toContain("All saved progress messages</dt><dd>8")
  expect(markup).toContain(
    "This event&#x27;s initial recovery messages</dt><dd>1"
  )
  expect(markup).toContain("This event&#x27;s progress messages</dt><dd>5")
  expect(markup).toContain("Groups missing initial recovery</dt><dd>2")
  expect(markup).toContain("Groups missing a saved initial envelope</dt><dd>1")
  expect(markup).toContain("Conflicting groups</dt><dd>4")
  expect(markup).toContain("Capped read</dt><dd>1")
  expect(markup).toContain(
    "not payment verification or permission to hand out goods"
  )
  expect(markup).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/)
  expect(markup).not.toContain("<button")
  expect(markup).not.toContain("<form")
})

it("renders safe zero counts when older discovery fixtures omit read details", () => {
  const markup = renderToStaticMarkup(
    <EventMarketOrganizerRecoveryReadDetails />
  )
  expect(markup.match(/<dd>0<\/dd>/g)?.length).toBe(8)
  expect(markup).not.toContain("undefined")
  expect(markup).not.toContain("NaN")
  expect(markup).not.toContain("<button")
})

it("shows only fixed last-observed recovery verdicts and timing in collapsed check details", () => {
  const timeout = new CheckoutSparkOrganizerRoutingTimeoutError({
    ...createCheckoutSparkOrganizerRoutingObservation(() => 0, 0).timeout()
      .diagnostic,
    stage: "Verifying the original funding",
    elapsedMs: 120_300,
    writerChecks: 12,
    writerCheckMs: 4_500,
    lastPayoutObservation: "paid",
    lastRecipientObservation: "verified_unsettled",
    lastProgressAck: "accepted",
    lastNativeObservation: "pending_sender",
    lastNativePreflight: "ready",
    lastNativeSend: "submitted",
    lastWorkflowOutcome: "wait",
    lastWorkflowWaitReason: "provider_evidence_unavailable",
    completedWorkflowSteps: 2,
    scheduledBackoffMs: 3_000,
  })
  const diagnostic = {
    ...timeout.diagnostic,
    providerMessage: "unused-provider-detail",
    privatePayload: "unused-private-detail",
  }
  const markup = renderToStaticMarkup(
    <EventMarketOrganizerPickupForm
      {...controls}
      {...{ diagnostic }}
      error={timeout.message}
      needsAttention
    />
  )
  expect(markup).toContain("Recovery check details")
  expect(markup).toContain("Verifying the original funding")
  expect(markup).toContain("120300 ms")
  expect(markup).toContain("Writer checks</dt><dd>12")
  expect(markup).toContain("4500 ms")
  expect(markup).toContain("Last observed exact payout</dt><dd>paid")
  expect(markup).toContain(
    "Last observed recipient check</dt><dd>verified_unsettled"
  )
  expect(markup).toContain(
    "Last observed progress acknowledgment</dt><dd>accepted"
  )
  expect(markup).toContain("Last observed Conduit check</dt><dd>pending_sender")
  expect(markup).toContain("Last observed Conduit preflight</dt><dd>ready")
  expect(markup).toContain(
    "Last observed Conduit send response</dt><dd>submitted"
  )
  expect(markup).toContain("Last observed workflow outcome</dt><dd>wait")
  expect(markup).toContain(
    "Last observed workflow wait reason</dt><dd>provider_evidence_unavailable"
  )
  expect(markup).toContain("Completed workflow steps</dt><dd>2")
  expect(markup).toContain("3000 ms")
  expect(markup).toContain(
    "not payment confirmation or the cause of the timeout"
  )
  expect(markup).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/)
  expect(markup).not.toContain("unused-provider-detail")
  expect(markup).not.toContain("unused-private-detail")
  expect(markup).not.toContain("CheckoutSparkOrganizerRoutingTimeoutError")
  expect(
    renderToStaticMarkup(<EventMarketOrganizerPickupForm {...controls} />)
  ).not.toContain("Recovery check details")
})

it("shows each exact pickup product, selected variation and quantity before handout", () => {
  const merchandise = {
    state: "ready" as const,
    lines: [
      {
        productCoordinate: "first-item",
        title: "Tasting apples",
        familyTitle: "Orchard fruit",
        quantity: 2,
        specifications: [{ key: "Size", value: "Large" }],
      },
      {
        productCoordinate: "second-item",
        title: "Pear juice",
        quantity: 1,
        specifications: [],
      },
    ],
  }
  const markup = renderToStaticMarkup(
    <EventMarketOrganizerPickupForm
      {...controls}
      {...{ merchandise }}
      quantity={3}
      paymentVerified
    />
  )
  expect(markup).toContain("Tasting apples")
  expect(markup).toContain("Orchard fruit")
  expect(markup).toContain("Size: Large")
  expect(markup).toContain("Qty 2")
  expect(markup).toContain("Pear juice")
  expect(markup).toContain("Qty 1")
  expect(markup).not.toContain("first-item")
  expect(markup).not.toContain("second-item")
})

it("shows unavailable exact details honestly and disables physical handout", () => {
  const markup = renderToStaticMarkup(
    <EventMarketOrganizerPickupForm
      {...controls}
      paymentVerified
      historyReady
      claimCode="A-VALID-PICKUP-CODE"
      merchandise={{ state: "unavailable" }}
    />
  )
  expect(markup).toContain("Exact item details are unavailable")
  expect(markup).not.toContain('aria-label="Items to hand out"')
  const handout = markup.match(
    /<button\b[^>]*>Confirm code and hand out once<\/button>/
  )?.[0]
  expect(handout).toBeDefined()
  expect(handout).toContain('disabled=""')
})

it("describes free pickup without a payment, wallet, routing spinner or claim release before verification", () => {
  const initial = renderToStaticMarkup(
    <EventMarketOrganizerPickupForm {...controls} free />
  )
  expect(initial).toContain("No payment required")
  expect(initial).toContain("Check free pickup")
  expect(initial).not.toContain("Goods payment")
  expect(initial).not.toContain("Confirm code and hand out once")
  const busy = renderToStaticMarkup(
    <EventMarketOrganizerPickupForm {...controls} free routing />
  )
  expect(busy).toContain("Checking free pickup")
  expect(busy).not.toContain(
    "Please keep this page open while we check your payment"
  )
  const ready = renderToStaticMarkup(
    <EventMarketOrganizerPickupForm
      {...controls}
      free
      paymentVerified
      claimCode="EXAMPLE"
      historyReady={false}
    />
  )
  expect(ready).toContain("Free pickup verified")
  expect(ready).toContain("Confirm code and hand out once")
  expect(ready).toContain('disabled=""')
})

it("carries only frozen merchandise into the actual paid and free organizer handout views", async () => {
  const paid = await checkoutSparkOrganizerFixture()
  const free = await eventMarketFreePurchaseFixture()
  databases.push(paid.database, free.database)
  for (const authority of [paid.authority, free.freeAuthority]) {
    const purchase = assertEventMarketOrganizerPurchaseAuthority(authority)
    expect(Object.hasOwn(purchase, "merchandise")).toBe(true)
    const merchandise = (
      purchase as { merchandise?: EventMarketOrganizerMerchandise }
    ).merchandise
    const markup = renderToStaticMarkup(
      <EventMarketOrganizerPickupForm
        {...controls}
        merchandise={merchandise}
        free={purchase.kind === "free"}
      />
    )
    expect(markup).toContain("Fixture apples")
    expect(markup).toContain("Qty 1")
    expect(markup).not.toContain("Exact item details are unavailable")
    expect(Object.hasOwn(purchase, "wallet")).toBe(false)
    expect(Object.hasOwn(purchase, "sourceEvents")).toBe(false)
  }
})

it("uses the actual free authority to reserve stock and verify a zero-cost pickup without any financial state", async () => {
  const f = await eventMarketFreePurchaseFixture()
  databases.push(f.database)
  const inbox = createInMemoryInboxDeclarationEvidenceRepository()
  const relay = "wss://relay.conduit.market"
  for (const [pubkey, sign] of [
    [f.organizerPubkey, f.signOrganizer],
    [f.merchantPubkey, f.signMerchant],
  ] as const) {
    await inbox.merge({
      pubkey,
      observedAt: Date.now(),
      signedEvent: await admitFixture(
        sign({
          kind: 10050,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", relay]],
          content: "",
        })
      ),
    })
  }
  const input = {
    db: f.database,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizerPubkey,
    shouldContinue: () => f.clock.active,
    authority: f.freeAuthority,
  }
  const dependencies = {
    now: () => f.clock.now,
    delivery: {
      recipientInboxRelays: [relay],
      resolveInboxRelays: async () => [relay],
      inboxDeclarationEvidenceRepository: inbox,
      accountNetworkLocalStateRepository: { get: async () => undefined },
      publishFn: async () => ({
        attemptedRelayUrls: [relay],
        successfulRelayUrls: [relay],
        failedRelayUrls: [],
        relayFailureMessages: {},
      }),
    },
  }
  const result = await continueEventMarketOrganizerPickup(input, dependencies)
  expect(result.status).toBe("complete")
  expect(result.commerceProof).not.toBeNull()
  assertCheckoutSparkOrganizerCommerceProof(result.commerceProof!, {
    organizerPubkey: f.organizerPubkey,
    orderId: f.payload.orderId,
    merchantPubkey: f.merchantPubkey,
    orderBinding: f.payload.orderBinding,
    initialHandoffId: f.payload.handoffId,
  })
  expect(await f.database.eventMarketOrganizerStockEntries.count()).toBe(1)
  expect(await f.database.checkoutSparkPlanBindings.count()).toBe(0)
  expect(await f.database.checkoutSparkReconciliations.count()).toBe(0)
  await continueEventMarketOrganizerPickup(input, dependencies)
  expect(await f.database.eventMarketOrganizerStockEntries.count()).toBe(1)
  f.clock.active = false
  await expect(
    continueEventMarketOrganizerPickup(input, dependencies)
  ).rejects.toThrow()
})

it.each(["complete", "delivery-failed", "session-ended"] as const)(
  "keeps saved stock totals scoped to the active session after %s continuation",
  async (outcome) => {
    const f = await eventMarketFreePurchaseFixture()
    databases.push(f.database)
    const purchase = assertEventMarketOrganizerPurchaseAuthority(
      f.freeAuthority
    )
    const client = new QueryClient()
    const authGeneration = 4
    const queryKey = [
      "event-stock-panel",
      f.organizerPubkey,
      purchase.eventMarket.marketCoordinate,
      "history",
      authGeneration,
    ]
    const observer = new QueryObserver(client, {
      queryKey,
      staleTime: Infinity,
      queryFn: async () =>
        (await f.database.eventMarketOrganizerStockPools.toArray()).reduce(
          (total, pool) => total + pool.acceptedQuantity,
          0
        ),
    })
    const unsubscribe = observer.subscribe(() => {})
    const unrelated = [
      ["event-stock-panel", "another-account", queryKey[2], "history", 4],
      ["event-stock-panel", f.organizerPubkey, "another-market", "history", 4],
      [...queryKey.slice(0, 4), 3],
    ]
    for (const key of unrelated) client.setQueryData(key, 0)
    const inbox = createInMemoryInboxDeclarationEvidenceRepository()
    const relay = "wss://relay.conduit.market"
    for (const [pubkey, sign] of [
      [f.organizerPubkey, f.signOrganizer],
      [f.merchantPubkey, f.signMerchant],
    ] as const) {
      await inbox.merge({
        pubkey,
        observedAt: Date.now(),
        signedEvent: await admitFixture(
          sign({
            kind: 10050,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["relay", relay]],
            content: "",
          })
        ),
      })
    }
    try {
      await observer.refetch()
      expect(observer.getCurrentResult().data).toBe(0)
      const dependencies = {
        now: () => f.clock.now,
        stockQuery: {
          client,
          authGeneration,
          isCurrent: () => f.clock.active,
        },
        delivery: {
          recipientInboxRelays: [relay],
          resolveInboxRelays: async () => [relay],
          inboxDeclarationEvidenceRepository: inbox,
          accountNetworkLocalStateRepository: { get: async () => undefined },
          publishFn: async () => {
            if (outcome === "session-ended") f.clock.active = false
            return {
              attemptedRelayUrls: [relay],
              successfulRelayUrls: outcome === "complete" ? [relay] : [],
              failedRelayUrls: outcome === "complete" ? [] : [relay],
              relayFailureMessages: {},
            }
          },
        },
      }
      const continuation = continueEventMarketOrganizerPickup(
        {
          db: f.database,
          signer: f.organizerSigner,
          authenticatedPubkey: f.organizerPubkey,
          shouldContinue: () => f.clock.active,
          authority: f.freeAuthority,
        },
        dependencies
      )
      if (outcome === "complete")
        expect((await continuation).status).toBe("complete")
      else await expect(continuation).rejects.toThrow()
      expect(await f.database.eventMarketOrganizerStockEntries.count()).toBe(1)
      expect(observer.getCurrentResult().data).toBe(
        outcome === "session-ended" ? 0 : 1
      )
      expect(client.getQueryState(queryKey)?.isInvalidated).toBe(false)
      for (const key of unrelated)
        expect(client.getQueryState(key)?.isInvalidated).toBe(false)
      expect(await f.database.checkoutSparkReconciliations.count()).toBe(0)
    } finally {
      unsubscribe()
      client.clear()
    }
  }
)
