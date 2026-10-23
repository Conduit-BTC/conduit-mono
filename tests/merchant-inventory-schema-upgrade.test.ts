import { describe, expect, it } from "bun:test"
import Dexie from "dexie"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { ConduitDB } from "../packages/core/src/db"
import { computeEventMarketAssignmentDTag } from "../packages/core/src/protocol/event-market-assignment"
import {
  acceptMerchantInventoryOrder,
  commitMerchantInventoryAssignment,
  initializeMerchantInventoryProduct,
  readMerchantInventoryAvailability,
  resumeMerchantInventoryPublication,
} from "../packages/core/src/protocol/merchant-inventory"
import { acceptInstalledAssignmentOrderV25 } from "./helpers/merchant-inventory-v25"
import histories from "./fixtures/event-market-db-histories.json"

describe("composed inventory and accepted-order schema upgrades", () => {
  for (const history of histories)
    it(`preserves actual ${history.name} acceptance and consumes later orders once after upgrade/reopen`, async () => {
      const secret = generateSecretKey()
      const merchant = getPublicKey(secret)
      const organizer = getPublicKey(generateSecretKey())
      const productCoordinate = `30402:${merchant}:upgrade-stock`
      const marketCoordinate = `30409:${organizer}:market`
      const occurrenceCoordinate = `31923:${organizer}:day`
      const assignmentCoordinate = `30410:${merchant}:${computeEventMarketAssignmentDTag({ marketCoordinate, occurrenceCoordinate, productCoordinate })}`
      const source = finalizeEvent(
        {
          kind: 30402,
          created_at: 100,
          content: "",
          tags: [
            ["d", "upgrade-stock"],
            ["title", "Product"],
            ["price", "1", "SAT"],
            ["type", "simple", "physical"],
            ["stock", "20"],
          ],
        },
        secret
      )
      const name = `inventory-domain-upgrade-${crypto.randomUUID()}`
      const options = { indexedDB: new IDBFactory(), IDBKeyRange }
      const old = new Dexie(name, options)
      old.version(history.version).stores(history.stores)
      await old.open()
      const initialize = async (database: ConduitDB) => {
        await initializeMerchantInventoryProduct({
          db: database,
          productCoordinate,
          merchantPubkey: merchant,
          stock: 20,
          signedProductEvent: source,
        })
        await commitMerchantInventoryAssignment({
          db: database,
          productCoordinate,
          assignmentCoordinate,
          marketCoordinate,
          occurrenceCoordinate,
          inventory: { mode: "tracked", quantity: 6 },
          state: "active",
          fulfillmentMethods: ["pickup"],
          expectedRevision: null,
          mutationId: "initial-allocation",
          context: {
            kind: "validated-event-market-assignment",
            productEventId: source.id,
            marketEventId: "a".repeat(64),
            occurrenceEventId: "b".repeat(64),
            grantEventId: "c".repeat(64),
            occurrenceEndMs: Date.now() + 3600000,
            terminal: false,
          },
        })
      }
      const order = (database: ConduitDB, id: string, quantity: number) => ({
        db: database,
        orderId: id,
        merchantPubkey: merchant,
        identityBinding: id,
        termsBinding: id,
        evidence: id,
        items: [
          {
            productCoordinate,
            assignmentCoordinate,
            method: "pickup" as const,
            quantity,
            admission: {
              kind: "validated-event-market-order" as const,
              productEventId: source.id,
              assignmentCoordinate,
              marketEventId: "a".repeat(64),
              occurrenceEventId: "b".repeat(64),
              grantEventId: "c".repeat(64),
            },
          },
        ],
      })
      const hadInventory = old.tables.some(
        (table) => table.name === "merchantInventoryProducts"
      )
      if (hadInventory) {
        // Exercise the installed v25 writer before opening the upgraded schema.
        await initialize(old as ConduitDB)
        await acceptInstalledAssignmentOrderV25(
          order(old as ConduitDB, "before-upgrade", 2)
        )
      }
      old.close()
      const upgraded = new ConduitDB(name, options)
      try {
        await upgraded.open()
        expect(upgraded.backendDB().version).toBe(310)
        expect(upgraded.tables.map((table) => table.name)).toEqual(
          expect.arrayContaining([
            "eventMarketOrganizerStockPools",
            "eventMarketOrganizerStockEntries",
            "eventMarketOrganizerStockWriters",
          ])
        )
        expect(await upgraded.eventMarketOrganizerStockWriters.count()).toBe(0)
        if (!hadInventory) {
          await initialize(upgraded)
          await acceptMerchantInventoryOrder(
            order(upgraded, "before-upgrade", 2)
          )
        }
        expect(
          (await upgraded.merchantInventoryProducts.get(productCoordinate))
            ?.stock
        ).toBe(18)
        expect(
          (
            await upgraded.merchantInventoryAssignments.get(
              assignmentCoordinate
            )
          )?.inventory
        ).toEqual({ mode: "tracked", quantity: 4 })
        expect(
          (
            await acceptMerchantInventoryOrder(
              order(upgraded, "before-upgrade", 2)
            )
          ).replayed
        ).toBe(true)
        const concurrent = await Promise.all([
          acceptMerchantInventoryOrder(order(upgraded, "after-upgrade", 1)),
          acceptMerchantInventoryOrder(order(upgraded, "after-upgrade", 1)),
        ])
        expect(concurrent.filter((result) => !result.replayed)).toHaveLength(1)
        expect(
          (await readMerchantInventoryAvailability(upgraded, productCoordinate))
            .ordinaryAvailable
        ).toBe(14)
        expect(
          (await upgraded.merchantInventoryProducts.get(productCoordinate))
            ?.stock
        ).toBe(17)
        let rejected = false
        try {
          await acceptMerchantInventoryOrder(order(upgraded, "oversold", 100))
        } catch (error) {
          rejected =
            error instanceof Error &&
            error.message === "Insufficient pickup allocation"
        }
        expect(rejected).toBe(true)
        expect(await upgraded.merchantInventoryAcceptedOrders.count()).toBe(2)
        upgraded.close({ disableAutoOpen: false })
        await upgraded.open()
        let signatures = 0
        await resumeMerchantInventoryPublication({
          db: upgraded,
          merchantPubkey: merchant,
          sign: async (draft) => {
            signatures++
            return finalizeEvent(
              { ...draft, tags: draft.tags.map((tag) => [...tag]) },
              secret
            )
          },
          publish: async () => false,
        })
        const signed =
          await upgraded.merchantInventoryProducts.get(productCoordinate)
        const ids = signed!.publicationJobs.map((work) => work.signedEvent!.id)
        expect(signatures).toBeGreaterThan(0)
        upgraded.close({ disableAutoOpen: false })
        await upgraded.open()
        await resumeMerchantInventoryPublication({
          db: upgraded,
          merchantPubkey: merchant,
          sign: async () => {
            throw new Error("Retained signatures must be reused")
          },
          publish: async () => false,
        })
        expect(
          (
            await upgraded.merchantInventoryProducts.get(productCoordinate)
          )?.publicationJobs.map((work) => work.signedEvent?.id)
        ).toEqual(ids)
        expect(
          (
            await acceptMerchantInventoryOrder(
              order(upgraded, "after-upgrade", 1)
            )
          ).replayed
        ).toBe(true)
        expect(
          (await upgraded.merchantInventoryProducts.get(productCoordinate))
            ?.stock
        ).toBe(17)
        expect(await upgraded.merchantInventoryAcceptedOrders.count()).toBe(2)
      } finally {
        upgraded.close()
        await upgraded.delete()
      }
    })
})
