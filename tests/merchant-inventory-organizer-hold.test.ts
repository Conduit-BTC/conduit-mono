import { afterEach, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { ConduitDB } from "@conduit/core/db"
import { computeEventMarketAssignmentDTag } from "@conduit/core/protocol/event-market-assignment"
import {
  acceptMerchantInventoryOrder,
  commitMerchantInventoryAssignment,
  commitMerchantInventoryStockEdit,
  initializeMerchantInventoryProduct,
  outstandingOrganizerStockHold,
  readMerchantInventoryAvailability,
} from "@conduit/core/protocol/merchant-inventory"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete()
})

async function fixture() {
  const secret = generateSecretKey()
  const merchantPubkey = getPublicKey(secret)
  const organizerPubkey = getPublicKey(generateSecretKey())
  const productCoordinate = `30402:${merchantPubkey}:held-stock`
  const marketCoordinate = `30409:${organizerPubkey}:held-market`
  const occurrenceCoordinate = `31923:${organizerPubkey}:held-occurrence`
  const assignmentCoordinate = `30410:${merchantPubkey}:${computeEventMarketAssignmentDTag({ marketCoordinate, occurrenceCoordinate, productCoordinate })}`
  const db = new ConduitDB(`organizer-hold-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(db)
  const product = finalizeEvent(
    {
      kind: 30402,
      created_at: 100,
      content: "",
      tags: [
        ["d", "held-stock"],
        ["type", "simple", "physical"],
        ["title", "Held stock"],
        ["price", "1", "SAT"],
        ["stock", "20"],
      ],
    },
    secret
  )
  await initializeMerchantInventoryProduct({
    db,
    productCoordinate,
    merchantPubkey,
    stock: 20,
    signedProductEvent: product,
  })
  const context = {
    kind: "validated-event-market-assignment" as const,
    productEventId: product.id,
    marketEventId: product.id,
    occurrenceEventId: product.id,
    grantEventId: product.id,
    occurrenceEndMs: 20_000,
    terminal: false,
  }
  await commitMerchantInventoryAssignment({
    db,
    productCoordinate,
    assignmentCoordinate,
    marketCoordinate,
    occurrenceCoordinate,
    inventory: { mode: "tracked", quantity: 6 },
    state: "active",
    fulfillmentMethods: ["pickup"],
    context,
    expectedRevision: null,
    mutationId: "allocation",
    nowMs: 1_000,
  })
  const hold = {
    poolId: crypto.randomUUID(),
    organizerPubkey,
    quantity: 4,
    importedQuantity: 0,
    closed: false,
  }
  await db.merchantInventoryAssignments.update(assignmentCoordinate, {
    organizerStockHold: hold,
  })
  return {
    db,
    product,
    productCoordinate,
    merchantPubkey,
    organizerPubkey,
    assignmentCoordinate,
    marketCoordinate,
    occurrenceCoordinate,
    context,
    hold,
  }
}

function accept(
  f: Awaited<ReturnType<typeof fixture>>,
  orderId: string,
  quantity: number,
  method: "ordinary" | "pickup" = "pickup"
) {
  return acceptMerchantInventoryOrder({
    db: f.db,
    orderId,
    merchantPubkey: f.merchantPubkey,
    identityBinding: orderId,
    termsBinding: orderId,
    evidence: orderId,
    items: [
      {
        productCoordinate: f.productCoordinate,
        ...(method === "pickup"
          ? { assignmentCoordinate: f.assignmentCoordinate }
          : {}),
        method,
        quantity,
        admission:
          method === "ordinary"
            ? {
                kind: "validated-ordinary-product",
                productEventId: f.product.id,
              }
            : {
                kind: "validated-event-market-order",
                productEventId: f.product.id,
                assignmentCoordinate: f.assignmentCoordinate,
                marketEventId: f.product.id,
                occurrenceEventId: f.product.id,
                grantEventId: f.product.id,
              },
      },
    ],
    acceptedAt: 1_000,
  })
}

async function expectFailure(operation: Promise<unknown>) {
  let failure: unknown
  try {
    await operation
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
}

async function changeAssignment(
  f: Awaited<ReturnType<typeof fixture>>,
  quantity: number,
  state: "active" | "removed" = "active"
) {
  const current = await f.db.merchantInventoryAssignments.get(
    f.assignmentCoordinate
  )
  return commitMerchantInventoryAssignment({
    db: f.db,
    productCoordinate: f.productCoordinate,
    assignmentCoordinate: f.assignmentCoordinate,
    marketCoordinate: f.marketCoordinate,
    occurrenceCoordinate: f.occurrenceCoordinate,
    inventory: { mode: "tracked", quantity },
    state,
    fulfillmentMethods: state === "active" ? ["pickup"] : [],
    context:
      state === "active" ? f.context : { kind: "merchant-assignment-removal" },
    expectedRevision: current!.revision,
    mutationId: `assignment:${state}:${quantity}`,
    nowMs: 1_000,
  })
}

it("keeps organizer stock reserved when the occurrence expires", async () => {
  const f = await fixture()
  expect(
    (await readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000))
      .ordinaryAvailable
  ).toBe(14)
  expect(
    (await readMerchantInventoryAvailability(f.db, f.productCoordinate, 20_000))
      .ordinaryAvailable
  ).toBe(16)
})

it("allows only the seller-owned pickup remainder, preserving the organizer pool", async () => {
  const f = await fixture()
  await expectFailure(accept(f, "held-units", 3))
  await accept(f, "seller-units", 2)
  await expectFailure(accept(f, "one-too-many", 1))
  const current = await readMerchantInventoryAvailability(
    f.db,
    f.productCoordinate,
    1_000
  )
  expect(current.product.stock).toBe(18)
  expect(current.assignments[0]?.inventory).toEqual({
    mode: "tracked",
    quantity: 4,
  })
  expect(current.assignments[0]?.organizerStockHold).toEqual(f.hold)
  expect(current.ordinaryAvailable).toBe(14)
})

it("reserves an entire pickup allocation while leaving unrelated ordinary stock sellable", async () => {
  const f = await fixture()
  await f.db.merchantInventoryAssignments.update(f.assignmentCoordinate, {
    organizerStockHold: { ...f.hold, quantity: 6 },
  })
  await expectFailure(accept(f, "no-seller-pickup", 1))
  await accept(f, "ordinary-stock", 14, "ordinary")
  const current = await readMerchantInventoryAvailability(
    f.db,
    f.productCoordinate,
    1_000
  )
  expect(current.product.stock).toBe(6)
  expect(current.ordinaryAvailable).toBe(0)
  expect(outstandingOrganizerStockHold(current.assignments[0]!)).toBe(6)
})

it("preserves an organizer hold through allocation reduction, removal and replay", async () => {
  const f = await fixture()
  await changeAssignment(f, 2)
  expect(
    (await readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000))
      .ordinaryAvailable
  ).toBe(16)
  await changeAssignment(f, 0, "removed")
  const replay = await changeAssignment(f, 0, "removed")
  expect(replay.organizerStockHold).toEqual(f.hold)
  expect(
    (await readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000))
      .ordinaryAvailable
  ).toBe(16)
  await expectFailure(
    commitMerchantInventoryStockEdit({
      db: f.db,
      productCoordinate: f.productCoordinate,
      expectedRevision: 0,
      stock: 3,
      mutationId: "below-hold",
      nowMs: 1_000,
    })
  )
  expect(
    (await readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000))
      .product.stock
  ).toBe(20)
})

it("does not turn removed held stock into untracked inventory", async () => {
  const f = await fixture()
  await changeAssignment(f, 0, "removed")
  await expectFailure(
    commitMerchantInventoryStockEdit({
      db: f.db,
      productCoordinate: f.productCoordinate,
      expectedRevision: 0,
      stock: undefined,
      mutationId: "tracking-bypass",
      nowMs: 1_000,
    })
  )
  expect(
    (await readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000))
      .product.stock
  ).toBe(20)
})

it("serializes concurrent seller pickup and ordinary sales without consuming the organizer pool", async () => {
  const f = await fixture()
  const peer = new ConduitDB(f.db.name, { indexedDB, IDBKeyRange })
  try {
    const results = await Promise.allSettled([
      accept(f, "pickup-a", 2),
      accept({ ...f, db: peer }, "pickup-b", 2),
      accept(f, "ordinary", 14, "ordinary"),
    ])
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(2)
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1)
    const remaining = await readMerchantInventoryAvailability(
      f.db,
      f.productCoordinate,
      1_000
    )
    expect(remaining.product.stock).toBe(4)
    expect(remaining.assignments[0]?.inventory).toEqual({
      mode: "tracked",
      quantity: 4,
    })
    expect(remaining.assignments[0]?.organizerStockHold).toEqual(f.hold)
    expect(remaining.ordinaryAvailable).toBe(0)
  } finally {
    peer.close()
  }
})

it.each(["removed", "expired", "terminal"] as const)(
  "protects the held floor for ordinary purchases after assignment %s",
  async (lifecycle) => {
    const f = await fixture()
    if (lifecycle === "removed") await changeAssignment(f, 0, "removed")
    else
      await f.db.merchantInventoryAssignments.update(
        f.assignmentCoordinate,
        lifecycle === "expired"
          ? { occurrenceEndMs: 1_000 }
          : { terminal: true }
      )
    await expectFailure(accept(f, "ordinary-over-hold", 17, "ordinary"))
    const order = await accept(f, "ordinary-remainder", 16, "ordinary")
    expect(order.replayed).toBe(false)
    expect(
      (await accept(f, "ordinary-remainder", 16, "ordinary")).replayed
    ).toBe(true)
    const remaining = await readMerchantInventoryAvailability(
      f.db,
      f.productCoordinate,
      1_000
    )
    expect(remaining.product.stock).toBe(4)
    expect(remaining.ordinaryAvailable).toBe(0)
    expect(remaining.assignments[0]?.organizerStockHold).toEqual(f.hold)
  }
)

it("uses only unreconciled quantities in the hold and releases a closed pool", async () => {
  const f = await fixture()
  await changeAssignment(f, 0, "removed")
  await f.db.merchantInventoryAssignments.update(f.assignmentCoordinate, {
    organizerStockHold: { ...f.hold, importedQuantity: 2 },
  })
  expect(
    (await readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000))
      .ordinaryAvailable
  ).toBe(18)
  await f.db.merchantInventoryAssignments.update(f.assignmentCoordinate, {
    organizerStockHold: { ...f.hold, importedQuantity: 2, closed: true },
  })
  expect(
    (await readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000))
      .ordinaryAvailable
  ).toBe(20)
})

it("retains the hold through assignment edit transaction failure", async () => {
  const f = await fixture()
  const assignment = await f.db.merchantInventoryAssignments.get(
    f.assignmentCoordinate
  )
  try {
    await f.db.transaction(
      "rw",
      f.db.merchantInventoryProducts,
      f.db.merchantInventoryAssignments,
      async () => {
        await changeAssignment(f, 0, "removed")
        throw new Error("Synthetic storage failure")
      }
    )
  } catch {
    /* The failed outer transaction must restore the complete allocation. */
  }
  expect(
    await f.db.merchantInventoryAssignments.get(f.assignmentCoordinate)
  ).toEqual(assignment)
  expect(
    (await readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000))
      .ordinaryAvailable
  ).toBe(14)
})

it.each([
  { quantity: -1 },
  { quantity: 0 },
  { quantity: 0.5 },
  { quantity: 2_147_483_648 },
  { importedQuantity: -1 },
  { importedQuantity: 5 },
  { importedQuantity: Number.NaN },
  { poolId: "" },
  { organizerPubkey: "not-a-pubkey" },
  { closed: "true" },
] as const)(
  "fails closed on malformed organizer hold summaries",
  async (invalid) => {
    const f = await fixture()
    await f.db.merchantInventoryAssignments.update(f.assignmentCoordinate, {
      organizerStockHold: { ...f.hold, ...invalid } as never,
    })
    await expectFailure(
      readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000)
    )
    await expectFailure(accept(f, "no-malformed-sale", 1, "ordinary"))
    expect(await f.db.merchantInventoryAcceptedOrders.count()).toBe(0)
  }
)

it("rejects untracked or malformed persisted holds even for removed assignments", async () => {
  const f = await fixture()
  await f.db.merchantInventoryAssignments.update(f.assignmentCoordinate, {
    state: "removed",
    inventory: { mode: "untracked" },
  })
  const assignment = await f.db.merchantInventoryAssignments.get(
    f.assignmentCoordinate
  )
  expect(() => outstandingOrganizerStockHold(assignment!)).toThrow(
    "tracked inventory"
  )
  await expectFailure(
    readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000)
  )
  await f.db.merchantInventoryAssignments.update(f.assignmentCoordinate, {
    inventory: { mode: "tracked", quantity: 0 },
  })
  await f.db.merchantInventoryProducts.update(f.productCoordinate, {
    stock: undefined,
  })
  await expectFailure(
    readMerchantInventoryAvailability(f.db, f.productCoordinate, 1_000)
  )
  await expectFailure(accept(f, "no-untracked-bypass", 1, "ordinary"))
})
