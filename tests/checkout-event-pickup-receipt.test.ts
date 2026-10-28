import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import { createEventPickupReceiptRepository } from "@conduit/core/protocol/event-pickup-receipt-storage"
import { verifyEventPickupReceipt } from "@conduit/core/protocol/event-guest-checkout"
import { orderSchema } from "@conduit/core/schemas"
import {
  buildEventMarketOrderRumorTags,
  createOrderRelayDeliveryRepository,
  EVENT_KINDS,
  stageOrderRelayDelivery,
  type StagedOrderLifecycleInput,
} from "@conduit/core"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  assertStagedOrderLifecycleMatchesRumor,
  prepareBuyerRumor,
} from "../apps/market/src/lib/order-publish"
import { createCheckoutEventReceiptPreparation } from "../apps/market/src/lib/checkout-event-pickup-receipt"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

const databases: ConduitDB[] = []
afterEach(async () => {
  mock.restore()
  const opened = databases.splice(0)
  for (const database of opened) database.close()
  for (const database of new Map(
    opened.map((item) => [item.name, item])
  ).values())
    await database.delete()
})

test("a failed browser save blocks checkout, and retry keeps the original order and receipt", async () => {
  const state = fixture()
  const prepare = createCheckoutEventReceiptPreparation({
    database: state.database,
    now: state.now,
  })
  const write = spyOn(state.database.eventPickupReceipts, "put")
  write.mockRejectedValueOnce(new Error("synthetic storage rejection"))
  await expect(prepare(state.input)).rejects.toMatchObject({
    code: "unavailable",
  })
  write.mockRestore()
  const original = await prepare({
    ...state.input,
    orderId: crypto.randomUUID(),
  })
  const retried = await prepare({
    ...state.input,
    orderId: crypto.randomUUID(),
  })
  expect(original.orderId === state.input.orderId).toBe(true)
  expect(retried).toEqual(original)
  expect(Object.keys(original).sort()).toEqual([
    "orderId",
    "pickupReceiptCommitment",
  ])
})

test("a silently dropped save cannot release a checkout commitment", async () => {
  const state = fixture()
  const prepare = createCheckoutEventReceiptPreparation({
    database: state.database,
    now: state.now,
  })
  spyOn(state.database.eventPickupReceipts, "put").mockResolvedValue(
    state.input.orderId
  )
  let mayPublish = false
  await expect(
    prepare(state.input).then(() => {
      mayPublish = true
    })
  ).rejects.toMatchObject({ code: "unavailable" })
  expect(mayPublish).toBe(false)
})

test("guest contact-free checkout uses the saved receipt without creating signing recovery", async () => {
  const state = fixture()
  const prepare = createCheckoutEventReceiptPreparation({
    database: state.database,
    now: state.now,
  })
  const prepared = await prepare({
    ...state.input,
    buyerScope: { kind: "guest" },
  })
  const saved = await createEventPickupReceiptRepository({
    database: state.database,
    now: state.now,
  }).load(prepared.orderId, { kind: "guest" })
  const order = orderSchema.parse({
    ...state.order,
    id: prepared.orderId,
    buyerIdentityKind: "guest_ephemeral",
    pickupReceiptCommitment: prepared.pickupReceiptCommitment,
    contactFreePickup: {
      label: "Guest",
      receiptCommitment: prepared.pickupReceiptCommitment,
    },
  })
  expect(verifyEventPickupReceipt(saved?.receipt, order, state.merchant)).toBe(
    true
  )
  expect(saved?.owner).toBe("guest")
  expect(Object.keys(saved ?? {}).sort()).toEqual([
    "createdAt",
    "expiresAt",
    "merchantPubkey",
    "occurrenceCoordinate",
    "occurrenceEnd",
    "orderId",
    "owner",
    "receipt",
    "schemaVersion",
  ])
})

test("ordinary checkout does not create an Event receipt or open its storage", async () => {
  const state = fixture()
  const prepare = createCheckoutEventReceiptPreparation({
    database: state.database,
    now: state.now,
  })
  const prepared = await prepare({
    ...state.input,
    items: state.input.items.map((item) => ({
      ...item,
      fulfillment: undefined,
    })),
  })
  expect(prepared).toEqual({ orderId: state.input.orderId })
  expect(state.database.isOpen()).toBe(false)
})

test("the published Event order and staged lifecycle must retain the same receipt commitment", async () => {
  const state = fixture()
  const prepared = await createCheckoutEventReceiptPreparation({
    database: state.database,
    now: state.now,
  })(state.input)
  const order = orderSchema.parse({
    ...state.order,
    id: prepared.orderId,
    buyerIdentityKind: "signed_in",
    pickupReceiptCommitment: prepared.pickupReceiptCommitment,
  })
  const rumor = new NDKEvent()
  rumor.kind = EVENT_KINDS.ORDER
  rumor.created_at = Math.floor(order.createdAt / 1_000)
  rumor.tags = [
    ["p", state.merchant],
    ["type", "order"],
    ["order", order.id],
    ["amount", String(order.subtotal)],
    ["currency", "SATS"],
    ...buildEventMarketOrderRumorTags(order),
  ]
  rumor.content = JSON.stringify(order)
  prepareBuyerRumor(rumor, state.buyer)
  const lifecycle: StagedOrderLifecycleInput = {
    orderId: order.id,
    buyerPubkey: state.buyer,
    buyerIdentityKind: "signed_in",
    merchantPubkey: state.merchant,
    pickupReceiptCommitment: prepared.pickupReceiptCommitment,
    checkoutMode: "pay_later",
    items: order.items,
    itemSubtotalSats: order.subtotal,
    shippingCostSats: 0,
    totalSats: order.subtotal,
    totalMsats: order.subtotal * 1_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    createdAt: order.createdAt,
  }
  expect(() =>
    assertStagedOrderLifecycleMatchesRumor(
      lifecycle,
      rumor,
      state.buyer,
      state.merchant
    )
  ).not.toThrow()
  expect(() =>
    assertStagedOrderLifecycleMatchesRumor(
      { ...lifecycle, pickupReceiptCommitment: "0".repeat(64) },
      rumor,
      state.buyer,
      state.merchant
    )
  ).toThrow("Order rumor does not match its staged lifecycle snapshot.")

  const relayUrl = "wss://receipt-orders.conduit.market"
  const wrapped = finalizeEvent(
    {
      kind: EVENT_KINDS.GIFT_WRAP,
      created_at: rumor.created_at!,
      tags: [["p", state.merchant]],
      content: "synthetic recipient wrap",
    },
    generateSecretKey()
  )
  const declaration = finalizeEvent(
    {
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      created_at: rumor.created_at!,
      tags: [["relay", relayUrl]],
      content: "",
    },
    state.merchantSecret
  )
  const stagedInput: Parameters<typeof stageOrderRelayDelivery>[0] = {
    lifecycle,
    leaseOwner: "receipt-test",
    prepared: {
      rumorId: rumor.id!,
      signedRecipientWrap: wrapped,
      route: "declared_inbox" as const,
      routingAuthority: {
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        eventId: declaration.id,
        eventCreatedAt: declaration.created_at,
        pubkey: state.merchant,
        relayUrls: [relayUrl],
      },
      relayPlan: [{ relayUrl, source: "declared" as const }],
    },
  }
  await stageOrderRelayDelivery(stagedInput, {
    repository: createOrderRelayDeliveryRepository(state.database),
    now: state.now,
  })
  state.database.close()
  const reopened = new ConduitDB(state.database.name, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(reopened)
  const repository = createOrderRelayDeliveryRepository(reopened)
  const restored = await repository.get(order.id)
  expect(restored?.pickupReceiptCommitment).toBe(
    prepared.pickupReceiptCommitment
  )
  expect(restored?.paymentStatus).toBe("not_started")
  const retainedReceipt = await createEventPickupReceiptRepository({
    database: reopened,
    now: state.now,
  }).load(order.id, state.input.buyerScope)
  expect(
    JSON.stringify(restored).includes(retainedReceipt!.receipt.claimSecret)
  ).toBe(false)
  await expect(
    stageOrderRelayDelivery(
      {
        ...stagedInput,
        lifecycle: { ...lifecycle, pickupReceiptCommitment: "0".repeat(64) },
      },
      { repository, now: state.now }
    )
  ).rejects.toHaveProperty("name", "OrderRelayDeliveryStageConflictError")
})

test("an account change gets a separate receipt and a changed occurrence cannot extend an existing attempt", async () => {
  const state = fixture()
  const prepare = createCheckoutEventReceiptPreparation({
    database: state.database,
    now: state.now,
  })
  const first = await prepare(state.input)
  await expect(
    prepare({
      ...state.input,
      items: state.input.items.map((item) => ({
        ...item,
        fulfillment: {
          ...state.fulfillment,
          calendar: {
            ...state.fulfillment.calendar,
            end: state.fulfillment.calendar.end + 1_000,
          },
        },
      })),
    })
  ).rejects.toThrow("The selected Event pickup changed. Review it again.")
  const replacement = await prepare({
    ...state.input,
    buyerScope: { kind: "signed_in", pubkey: state.organizer },
    orderId: crypto.randomUUID(),
  })
  expect(replacement.orderId === first.orderId).toBe(false)
  expect(
    replacement.pickupReceiptCommitment === first.pickupReceiptCommitment
  ).toBe(false)
})

function fixture() {
  const event = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const database = new ConduitDB(`checkout-receipt-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(database)
  const now = () => event.fulfillment.calendar.start
  const input = {
    scope: "selected-purchase",
    merchantPubkey: event.merchant,
    buyerScope: { kind: "signed_in" as const, pubkey: event.buyer },
    items: event.order.items,
    orderId: crypto.randomUUID(),
    shouldContinue: () => true,
  }
  return { ...event, database, now, input }
}

test("Event checkout only receives an exact receipt commitment after verified browser retention", async () => {
  const state = fixture()
  const prepare = createCheckoutEventReceiptPreparation({
    database: state.database,
    now: state.now,
  })
  const prepared = await prepare(state.input)
  const saved = await createEventPickupReceiptRepository({
    database: state.database,
    now: state.now,
  }).load(prepared.orderId, state.input.buyerScope)
  expect(saved?.receipt === undefined).toBe(false)
  const order = orderSchema.parse({
    ...state.order,
    id: prepared.orderId,
    buyerIdentityKind: "signed_in",
    pickupReceiptCommitment: prepared.pickupReceiptCommitment,
  })
  expect(verifyEventPickupReceipt(saved?.receipt, order, state.merchant)).toBe(
    true
  )
  expect(saved?.occurrenceCoordinate).toBe(
    state.fulfillment.calendar.coordinate
  )
  expect(saved?.expiresAt).toBe(
    state.fulfillment.calendar.end + 24 * 60 * 60 * 1_000
  )
})
