import { afterEach, expect, it } from "bun:test"
import type { ConduitDB } from "@conduit/core/db"
import {
  acceptCheckoutSparkOrganizerStockOrder,
  confirmOrganizerStockOrderHandout,
  assertMerchantOrganizerStockOrderHandout,
} from "@conduit/core/protocol/event-market-stock-handout"
import { proveEventMarketFreeOrganizerCommerce } from "@conduit/core/protocol/checkout-spark-organizer-commerce"
import { formatEventMarketPickupClaimCode } from "@conduit/core/protocol/event-market-handoff"
import { getOrganizerStockOrderBindings } from "@conduit/core/protocol/merchant-order-acceptance-bindings"
import { SessionSigner } from "@conduit/core/protocol/session-signer"
import { eventMarketFreePurchaseFixture } from "./support/event-market-free-purchase-fixture"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})
const offline = {
  resolveInboxRelays: async () => {
    throw new Error("Controlled offline delivery")
  },
}
async function retain(operation: Promise<unknown>) {
  try {
    await operation
  } catch {
    /* committed private work remains */
  }
}

it("requires exact imported stock and the organizer's authenticated physical handout, never payment labels or another Merchant release", async () => {
  const f = await eventMarketFreePurchaseFixture()
  databases.push(f.database)
  const merchantSigner = new SessionSigner(f.merchantSigner, {
    expectedPubkey: f.merchantPubkey,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => f.clock.active,
  })
  const merchant = {
    db: f.database,
    signer: merchantSigner,
    authenticatedPubkey: f.merchantPubkey,
    shouldContinue: () => f.clock.active,
    order: f.order,
  }
  await expect(
    assertMerchantOrganizerStockOrderHandout(merchant)
  ).rejects.toThrow("Import")
  const organizer = {
    db: f.database,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizerPubkey,
    shouldContinue: () => f.clock.active,
  }
  await retain(
    acceptCheckoutSparkOrganizerStockOrder({
      ...organizer,
      authority: f.freeAuthority,
      nowMs: f.clock.now,
      delivery: offline,
    })
  )
  const proof = await proveEventMarketFreeOrganizerCommerce({
    authority: f.freeAuthority,
    assertCurrent: () => {},
    now: () => f.clock.now,
  })
  const bindings = getOrganizerStockOrderBindings(f.order)
  const entries = await f.database.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.organizerPubkey)
    .toArray()
  const parsed = JSON.parse(entries[0]!.orderPoolBinding!) as Array<{
    writerId: string
  }>
  // Baseline of an already-imported local stock decision; its incoming signed
  // acceptance/handout ciphertext is produced by the real organizer workflow.
  const attribution = {
    originalOrderRumorId: f.rumor.id,
    organizerPubkey: f.organizerPubkey,
    claimRef: entries[0]!.claimRef,
    entries: entries.map((row) => ({
      poolId: row.poolId,
      entryId: row.rumor.id,
      writerId: parsed[0]!.writerId,
      quantity: row.quantity,
    })),
  }
  await f.database.merchantInventoryAcceptedOrders.put({
    orderId: f.order.id,
    merchantPubkey: f.merchantPubkey,
    identityBinding: bindings.identityBinding,
    termsBinding: bindings.termsBinding,
    evidence: bindings.termsBinding,
    acceptedAt: f.clock.now,
    items: f.order.items.map((item) => ({
      productCoordinate: item.productId,
      quantity: item.quantity,
      method: "pickup",
    })),
    organizerImport: attribution,
  })
  const imported = entries.map((row) => ({
    ...row,
    id: `${f.merchantPubkey}:${row.rumor.id}`,
    accountPubkey: f.merchantPubkey,
    imported: true,
    receivedEnvelope: row.wraps!.recipient,
  }))
  await f.database.eventMarketOrganizerStockEntries.bulkPut(imported)
  await expect(
    assertMerchantOrganizerStockOrderHandout(merchant)
  ).rejects.toThrow("handout")
  await retain(
    confirmOrganizerStockOrderHandout({
      ...organizer,
      authority: f.freeAuthority,
      commerceProof: proof,
      enteredClaimCode: formatEventMarketPickupClaimCode(entries[0]!.claimRef),
      physicalReleaseConfirmed: true,
      nowMs: f.clock.now + 2,
      delivery: offline,
    })
  )
  const completed = await f.database.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.organizerPubkey)
    .toArray()
  for (const row of completed)
    await f.database.eventMarketOrganizerStockEntries.update(
      `${f.merchantPubkey}:${row.rumor.id}`,
      {
        handout: {
          ...row.handout!,
          receivedEnvelope: row.handout!.wraps!.recipient,
        },
      }
    )
  const before = await f.database.eventMarketOrganizerStockEntries.count()
  const result = await assertMerchantOrganizerStockOrderHandout(merchant)
  expect(result.orderId).toBe(f.order.id)
  expect(result).not.toHaveProperty("paid")
  expect(await f.database.eventMarketOrganizerStockEntries.count()).toBe(before)
  await expect(
    assertMerchantOrganizerStockOrderHandout({
      ...merchant,
      order: { ...f.order, note: "changed" },
    })
  ).rejects.toThrow()
  f.clock.active = false
  await expect(
    assertMerchantOrganizerStockOrderHandout(merchant)
  ).rejects.toThrow()
})
