import Dexie from "dexie"
import { describe, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"

// Each concurrent v24 lineage upgrades through one additive schema. None of
// the previously shipped versions is rewritten to make another branch fit.
for (const [name, store, schema, row] of [
  [
    "wallet recovery",
    "sparkRecoveryEvidence",
    "ownerPubkey",
    { ownerPubkey: "synthetic-owner", checkpoint: "retained" },
  ],
  [
    "organizer decisions",
    "eventMarketMerchantDecisionJobs",
    "id, marketCoordinate, merchantPubkey, status, updatedAt",
    {
      id: "synthetic-decision",
      marketCoordinate: "synthetic-market",
      merchantPubkey: "synthetic-owner",
      status: "pending",
      updatedAt: 10,
      createdAt: 10,
    },
  ],
  [
    "local stock",
    "localProductStockCheckpoints",
    "id, merchantPubkey, orderId, productAddressId, state, committedAt",
    {
      id: "synthetic-stock",
      merchantPubkey: "synthetic-owner",
      orderId: "synthetic-order",
      productAddressId: "synthetic-product",
      state: "committed",
      committedAt: 10,
    },
  ],
] as const) {
  describe(`commerce inbox migration from v24 ${name}`, () => {
    it("preserves prior rows and creates every inbox and concurrent recovery store", async () => {
      const databaseName = `migration-${crypto.randomUUID()}`
      const dependencies = { indexedDB: new IDBFactory(), IDBKeyRange }
      const prior = new Dexie(databaseName, dependencies)
      prior.version(24).stores({
        [store]: schema,
        messages: "id, senderPubkey, recipientPubkey",
        orderMessages: "id, senderPubkey, recipientPubkey",
      })
      await prior.open()
      await prior.table(store).put(row)
      prior.close()
      const upgraded = new ConduitDB(databaseName, dependencies)
      try {
        await upgraded.open()
        expect(upgraded.verno).toBe(25)
        expect(
          await upgraded
            .table(store)
            .get("id" in row ? row.id : row.ownerPubkey)
        ).toEqual(row)
        expect(upgraded.tables.map((table) => table.name)).toEqual(
          expect.arrayContaining([
            "sparkRecoveryEvidence",
            "eventMarketMerchantDecisionJobs",
            "localProductStockCheckpoints",
            "commerceInboxKeys",
            "commerceInboxWrappers",
            "commerceInboxRecords",
            "commerceInboxRanges",
            "commerceInboxDeliveries",
            "commerceInboxDeletions",
          ])
        )
        expect(
          upgraded.eventMarketMerchantDecisionJobs.schema.indexes.some(
            (index) => index.name === "createdAt"
          )
        ).toBe(true)
      } finally {
        await upgraded.delete()
      }
    })
  })
}
