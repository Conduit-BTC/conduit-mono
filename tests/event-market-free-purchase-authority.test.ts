import { afterEach, expect, it } from "bun:test"
import type { ConduitDB } from "@conduit/core/db"
import {
  createEventMarketFreePurchase,
  buildEventMarketFreePurchaseRumor,
} from "@conduit/core/protocol/event-market-free-purchase"
import {
  openEventMarketFreePurchaseAuthority,
  assertEventMarketOrganizerPurchaseAuthority,
} from "@conduit/core/protocol/event-market-organizer-purchase"
import { proveEventMarketFreeOrganizerCommerce } from "@conduit/core/protocol/checkout-spark-organizer-commerce"
import {
  acceptCheckoutSparkOrganizerStockOrder,
  confirmOrganizerStockOrderHandout,
} from "@conduit/core/protocol/event-market-stock-handout"
import { parseEventMarketOrganizerFeeTerms } from "@conduit/core/protocol/event-market-organizer-fee"
import { freezeCheckoutSparkEventMarketBinding } from "@conduit/core/protocol/checkout-spark-event-market"
import { formatEventMarketPickupClaimCode } from "@conduit/core/protocol/event-market-handoff"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import {
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"
import {
  createSessionGuestOrderSigningIdentity,
  createGuestEventMarketFreePurchaseSigner,
  GUEST_ORDER_SESSION_TTL_MS,
} from "../apps/market/src/lib/guest-order-identity"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})
async function fixture() {
  const f = await checkoutSparkOrganizerFixture({
    commerceTotalSats: 0,
    supplier: false,
  })
  databases.push(f.database)
  const market = f.signOrganizer({
    ...f.events.market,
    tags: f.events.market.tags.filter((tag) => tag[0] !== "conduit_event_fee"),
  })
  const binding = freezeCheckoutSparkEventMarketBinding(
    {
      ...f.eventMarket,
      marketEventId: market.id,
      organizerFee: parseEventMarketOrganizerFeeTerms({
        event: market,
        marketCoordinate: f.eventMarket.marketCoordinate,
      }),
      organizerFeeSats: 0,
    },
    {
      merchantPubkey: f.merchantPubkey,
      commerceQuote: f.plan.commerceQuote,
      acceptedAtMs: AT,
    }
  )
  const sources = f.sourceEvents.map((event) =>
    event.id === f.events.market.id ? market : event
  )
  const identity = createSessionGuestOrderSigningIdentity(
    f.plan.orderId,
    f.merchantPubkey,
    { storage: null, nowMs: AT }
  )
  const order = createCheckoutSparkEventMarketFixtureOrder(
    { ...f, sourceEvents: sources },
    identity.pubkey,
    AT,
    binding
  )
  const payload = createEventMarketFreePurchase({
    order,
    commerceQuote: f.plan.commerceQuote,
    eventMarket: binding,
    sourceEvents: sources,
  })
  const guestSigner = createGuestEventMarketFreePurchaseSigner(identity, {
    payload,
    now: () => f.clock.now,
  })
  const rumor = buildEventMarketFreePurchaseRumor(payload)
  const wrap = await wrapPrivateMessage(
    rumor,
    { pubkey: f.organizerPubkey },
    guestSigner,
    { rumorKind: 16 }
  )
  const input = {
    db: f.database,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizerPubkey,
    writerId: f.writerId,
    signedRecipientWrap: wrap,
    shouldContinue: () => f.clock.active,
    now: () => f.clock.now,
  }
  const authority = await openEventMarketFreePurchaseAuthority(input)
  const session = {
    db: f.database,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizerPubkey,
    shouldContinue: () => f.clock.active,
  }
  return {
    ...f,
    payload,
    identity,
    guestSigner,
    rumor,
    input,
    authority,
    session,
  }
}

it("authenticates a minimal free guest purchase and hands out exactly once without any financial plan, wallet or invoice", async () => {
  const f = await fixture()
  const purchase = assertEventMarketOrganizerPurchaseAuthority(f.authority)
  expect(purchase.kind).toBe("free")
  expect(purchase).not.toHaveProperty("plan")
  expect(purchase).not.toHaveProperty("wallet")
  expect(purchase).not.toHaveProperty("funding")
  expect(purchase.orderId).toBe(f.payload.orderId)
  const offline = {
    resolveInboxRelays: async () => {
      throw new Error("Controlled offline inbox")
    },
  }
  try {
    await acceptCheckoutSparkOrganizerStockOrder({
      ...f.session,
      authority: f.authority,
      delivery: offline,
      nowMs: f.clock.now,
    })
  } catch {
    /* durable reservation precedes delivery */
  }
  expect(await f.database.eventMarketOrganizerStockEntries.count()).toBe(1)
  const proof = await proveEventMarketFreeOrganizerCommerce({
    authority: f.authority,
    assertCurrent: () => {
      if (!f.clock.active) throw new Error("Stopped")
    },
    now: () => f.clock.now,
  })
  const confirm = {
    ...f.session,
    authority: f.authority,
    commerceProof: proof,
    enteredClaimCode: formatEventMarketPickupClaimCode(purchase.claimRef),
    physicalReleaseConfirmed: true as const,
    delivery: offline,
    nowMs: f.clock.now,
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await confirmOrganizerStockOrderHandout(confirm)
    } catch {
      /* the same physical marker survives delivery failure */
    }
  }
  const entries = await f.database.eventMarketOrganizerStockEntries.toArray()
  expect(entries).toHaveLength(1)
  expect(entries[0]!.handout?.rumor).toBeDefined()
  expect(
    (await f.database.eventMarketOrganizerStockPools.toArray())[0]!
      .acceptedQuantity
  ).toBe(1)
  expect(await f.database.checkoutSparkPlanBindings.count()).toBe(0)
  expect(await f.database.checkoutSparkReconciliations.count()).toBe(0)
})

it("keeps the guest free-purchase signer recipient/payload/seal-only, with no inbox or generic signing", async () => {
  const f = await fixture()
  await expect(
    f.guestSigner.encryptNip44(f.merchantPubkey, JSON.stringify(f.rumor))
  ).rejects.toThrow()
  await expect(
    f.guestSigner.encryptNip44(
      f.organizerPubkey,
      JSON.stringify({ ...f.rumor, content: "{}" })
    )
  ).rejects.toThrow()
  await expect(
    f.guestSigner.signEvent({
      kind: 16,
      pubkey: f.identity.pubkey,
      content: "",
      created_at: AT / 1000,
      tags: [],
    })
  ).rejects.toThrow()
  await expect(
    f.guestSigner.decryptNip44(f.organizerPubkey, "not-a-message")
  ).rejects.toThrow()
  f.clock.now = AT + GUEST_ORDER_SESSION_TTL_MS
  await expect(f.guestSigner.getPublicKey()).rejects.toThrow()
})

it("requires the original Merchant grant, explicit writer and current account for a free physical release", async () => {
  const f = await fixture()
  await expect(
    openEventMarketFreePurchaseAuthority({
      ...f.input,
      writerId: crypto.randomUUID(),
    })
  ).rejects.toThrow()
  expect(() =>
    assertEventMarketOrganizerPurchaseAuthority(
      JSON.parse(JSON.stringify(f.authority))
    )
  ).toThrow()
  f.clock.active = false
  await expect(
    proveEventMarketFreeOrganizerCommerce({
      authority: f.authority,
      assertCurrent: () => {},
      now: () => f.clock.now,
    })
  ).rejects.toThrow()
})
