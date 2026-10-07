import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { matchFilter, type Filter } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { ConduitDB } from "@conduit/core/db"
import { buildEventMarketAssignmentDraft } from "@conduit/core/protocol/event-market-assignment"
import { recoverMerchantInventoryProduct } from "@conduit/core/protocol/merchant-inventory-recovery"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

function source(
  events: readonly SignedPublicNostrEvent[],
  status: "success" | "partial" = "success"
) {
  return {
    plan: async () => ({
      relayUrls: ["wss://source.example"],
      candidateRelayUrls: ["wss://source.example"],
      maxRelayAttempts: 1,
      ownerSelectedRelayUrls: [],
      appRelayUrls: ["wss://source.example"],
      personalRelayUrls: [],
      independentRelayUrls: [],
      relayListState: "missing" as const,
      relayHintTruncated: false,
    }),
    fetch: async (filter: Filter) => ({
      events: events.filter((event) => matchFilter(filter, event)),
      relays: [{ relayUrl: "wss://source.example", status }],
    }),
  }
}

async function withDb(run: (db: ConduitDB) => Promise<void>) {
  const db = new ConduitDB(`merchant-recovery-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  try {
    await run(db)
  } finally {
    await db.delete()
  }
}

describe("first-use merchant inventory recovery", () => {
  it("restores discoverable signed allocation before admitting ordinary stock", async () => {
    await withDb(async (db) => {
      const fixture = createEventMarketOrderFixture({
        mode: "merchant_present",
        newAssignment: true,
      })
      const input = {
        db,
        merchantPubkey: fixture.fulfillment.merchantPubkey,
        productCoordinate: fixture.fulfillment.product.coordinate,
        signedProductEvent: fixture.fulfillment.product.signedEvent!,
      }
      const result = await recoverMerchantInventoryProduct(
        input,
        source(fixture.events)
      )
      expect(result.state).toBe("ready")
      if (result.state !== "ready") return
      expect(result.recoveredAssignments).toBe(1)
      expect(result.coverage).toBe("complete")
      expect(result.product.stock).toBe(6)
      const assignment = await db.merchantInventoryAssignments
        .toCollection()
        .first()
      expect(assignment?.inventory).toEqual({ mode: "tracked", quantity: 6 })
      expect(assignment?.occurrenceEndMs).toBe(fixture.fulfillment.calendar.end)
      const untouched = await recoverMerchantInventoryProduct(input, source([]))
      expect(untouched).toMatchObject({
        state: "ready",
        alreadyCommitted: true,
        recoveredAssignments: 0,
      })
      expect(await db.merchantInventoryAssignments.count()).toBe(1)
    })
  })

  it("reports degraded bounded coverage without claiming global assignment absence", async () => {
    await withDb(async (db) => {
      const fixture = createEventMarketOrderFixture({
        mode: "merchant_present",
        newAssignment: true,
      })
      const result = await recoverMerchantInventoryProduct(
        {
          db,
          merchantPubkey: fixture.fulfillment.merchantPubkey,
          productCoordinate: fixture.fulfillment.product.coordinate,
          signedProductEvent: fixture.fulfillment.product.signedEvent!,
        },
        source([], "partial")
      )
      expect(result).toMatchObject({
        state: "ready",
        coverage: "partial",
        recoveredAssignments: 0,
      })
    })
  })

  it("stops a concrete cross-market over-allocation without committing a partial product", async () => {
    await withDb(async (db) => {
      const first = createEventMarketOrderFixture({
        mode: "merchant_present",
        newAssignment: true,
        dTag: "market-a",
        productDTag: "shared-coffee",
      })
      const second = createEventMarketOrderFixture({
        mode: "merchant_present",
        newAssignment: true,
        dTag: "market-b",
        productDTag: "shared-coffee",
      })
      const result = await recoverMerchantInventoryProduct(
        {
          db,
          merchantPubkey: first.fulfillment.merchantPubkey,
          productCoordinate: first.fulfillment.product.coordinate,
          signedProductEvent: first.fulfillment.product.signedEvent!,
        },
        source([...first.events, ...second.events])
      )
      expect(result).toMatchObject({
        state: "unsafe_conflict",
        reason: "overallocated",
      })
      expect(await db.merchantInventoryProducts.count()).toBe(0)
      expect(await db.merchantInventoryAssignments.count()).toBe(0)
    })
  })

  it("accepts a repaired current assignment but refuses a malformed strongest revision", async () => {
    const merchantSecret = generateSecretKey()
    const organizerSecret = generateSecretKey()
    const merchantPubkey = getPublicKey(merchantSecret)
    const organizer = getPublicKey(organizerSecret)
    const productCoordinate = `30402:${merchantPubkey}:item`
    const marketCoordinate = `30409:${organizer}:market`
    const occurrenceCoordinate = `31923:${organizer}:occurrence`
    const product = finalizeEvent(
      {
        kind: 30402,
        created_at: 100,
        tags: [
          ["d", "item"],
          ["type", "simple", "physical"],
          ["stock", "5"],
        ],
        content: "item",
      },
      merchantSecret
    )
    const draft = buildEventMarketAssignmentDraft({
      merchantPubkey,
      marketCoordinate,
      occurrenceCoordinate,
      productCoordinate,
      state: "active",
      inventory: { mode: "tracked", quantity: 2 },
      fulfillmentMethods: ["pickup"],
    })
    const valid = finalizeEvent({ ...draft, created_at: 102 }, merchantSecret)
    const oldMalformed = finalizeEvent(
      { ...draft, created_at: 101, content: "invalid assignment content" },
      merchantSecret
    )
    const input = (db: ConduitDB) => ({
      db,
      merchantPubkey,
      productCoordinate,
      signedProductEvent: product,
    })
    await withDb(async (db) => {
      const result = await recoverMerchantInventoryProduct(
        input(db),
        source([oldMalformed, valid])
      )
      expect(result).toMatchObject({ state: "ready", recoveredAssignments: 1 })
      expect(
        (await db.merchantInventoryAssignments.toCollection().first())
          ?.inventory
      ).toEqual({ mode: "tracked", quantity: 2 })
    })
    const strongerMalformed = finalizeEvent(
      { ...draft, created_at: 103, content: "invalid assignment content" },
      merchantSecret
    )
    await withDb(async (db) => {
      const result = await recoverMerchantInventoryProduct(
        input(db),
        source([valid, strongerMalformed])
      )
      expect(result).toMatchObject({
        state: "unsafe_conflict",
        reason: "malformed_assignment",
      })
      expect(await db.merchantInventoryProducts.count()).toBe(0)
    })
  })
})
