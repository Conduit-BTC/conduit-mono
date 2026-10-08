import Dexie from "dexie"
import { describe, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"

// Each concurrent v24/v25 lineage upgrades through one additive schema. None of
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
  [
    "durable encrypted inbox",
    "commerceInboxWrappers",
    "id, accountPubkey, state, observedAt",
    {
      id: "synthetic-wrapper",
      accountPubkey: "synthetic-owner",
      state: "retained",
      observedAt: 10,
      ciphertext: crypto.randomUUID(),
    },
  ],
] as const) {
  for (const priorVersion of store === "commerceInboxWrappers"
    ? [25]
    : [24, 25]) {
    describe(`commerce inbox migration from v${priorVersion} ${name}`, () => {
      it("preserves prior rows and creates every inbox and concurrent recovery store", async () => {
        const databaseName = `migration-${crypto.randomUUID()}`
        const dependencies = { indexedDB: new IDBFactory(), IDBKeyRange }
        const prior = new Dexie(databaseName, dependencies)
        prior.version(priorVersion).stores({
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
          expect(upgraded.verno).toBe(26)
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
              "localProductWriteIntents",
              "localProductWriteFrontiers",
              "localProductShippingOutbox",
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
}
