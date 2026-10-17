import { afterEach, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ConduitDB } from "@conduit/core/db"
import { assertCheckoutSparkOrganizerCommerceProof } from "@conduit/core"
import {
  EventMarketOrganizerPickupForm,
  continueEventMarketOrganizerPickup,
} from "../apps/merchant/src/components/EventMarketOrganizerPickupCard"
import { eventMarketFreePurchaseFixture } from "./support/event-market-free-purchase-fixture"
import { createInMemoryInboxDeclarationEvidenceRepository } from "@conduit/core/protocol/inbox-declaration-evidence"
import { admitFixture } from "./helpers/public-event"

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
