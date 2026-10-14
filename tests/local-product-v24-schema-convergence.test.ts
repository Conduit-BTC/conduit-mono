import { describe, expect, it } from "bun:test"
import Dexie from "dexie"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"

const localStores = {
  productListingOutbox:
    "id, merchantPubkey, state, nextRetryAt, updatedAt, createdAt",
  localProductWriteIntents: "id, merchantPubkey, listingJobId, committedAt",
  localProductWriteFrontiers: "id, merchantPubkey, intentId",
  localProductShippingOutbox: "id, merchantPubkey, createdAt",
  localProductStockCheckpoints:
    "id, merchantPubkey, orderId, productAddressId, state, committedAt",
}
const commonStores = {
  wallets: "id",
  walletCredentials: "walletId",
  checkoutSparkPlanBindings: "checkoutId",
  checkoutSparkReconciliations: "checkoutId",
  checkoutSparkRetirements: "checkoutId",
  eventMarketRosterEvidence: "id, marketCoordinate, cachedAt",
  merchantShippingSettingsEvidence: "pubkey",
}

describe("already-v24 database lineage convergence", () => {
  it.each(["main", "supplier_branch"] as const)(
    "preserves durable rows and acquires the union from %s v24",
    async (lineage) => {
      const options = { indexedDB: new IDBFactory(), IDBKeyRange }
      const name = `synthetic-v24-${lineage}`
      const historical = new Dexie(name, options)
      historical.version(24).stores({
        ...commonStores,
        ...(lineage === "supplier_branch" ? localStores : {}),
        eventMarketMerchantDecisionJobs:
          lineage === "main"
            ? "id, marketCoordinate, merchantPubkey, status, updatedAt"
            : "id, [marketCoordinate+merchantPubkey], status, createdAt",
      })
      const rows: Array<[string, object]> = [
        ["wallets", { id: "synthetic-wallet", marker: "descriptor" }],
        [
          "walletCredentials",
          { walletId: "synthetic-wallet", marker: "opaque-test-envelope" },
        ],
        [
          "checkoutSparkPlanBindings",
          { checkoutId: "synthetic-active", planDigest: "synthetic-binding" },
        ],
        [
          "checkoutSparkReconciliations",
          {
            checkoutId: "synthetic-active",
            revision: 7,
            marker: "possibly-sent",
          },
        ],
        [
          "checkoutSparkRetirements",
          { checkoutId: "synthetic-retired", planDigest: "retained-binding" },
        ],
        [
          "eventMarketRosterEvidence",
          {
            id: "synthetic-roster",
            marketCoordinate: "synthetic-market",
            cachedAt: 1,
          },
        ],
        [
          "merchantShippingSettingsEvidence",
          { pubkey: "synthetic-owner", marker: "retained-evidence" },
        ],
        [
          "eventMarketMerchantDecisionJobs",
          {
            id: "synthetic-decision",
            marketCoordinate: "synthetic-market",
            merchantPubkey: "synthetic-owner",
            status: "pending",
            updatedAt: 2,
            createdAt: 1,
          },
        ],
      ]
      if (lineage === "supplier_branch") {
        for (const table of Object.keys(localStores))
          rows.push([
            table,
            {
              id: table,
              merchantPubkey: "synthetic-owner",
              state: "pending",
              marker: "exact-saved-work",
            },
          ])
      }
      for (const [table, row] of rows) await historical.table(table).put(row)
      historical.close()
      const current = new ConduitDB(name, options)
      try {
        await current.open()
        expect(current.verno).toBe(26)
        for (const [table, row] of rows)
          expect(await current.table(table).toArray()).toEqual([row])
        for (const table of Object.keys(localStores)) {
          expect(
            current.tables.some((candidate) => candidate.name === table)
          ).toBe(true)
          expect(await current.table(table).count()).toBe(
            lineage === "main" ? 0 : 1
          )
        }
        const jobs = current.eventMarketMerchantDecisionJobs
        expect(jobs.schema.indexes.map((index) => index.name)).toEqual([
          "marketCoordinate",
          "merchantPubkey",
          "[marketCoordinate+merchantPubkey]",
          "status",
          "updatedAt",
          "createdAt",
        ])
        expect(
          await jobs
            .where("marketCoordinate")
            .equals("synthetic-market")
            .count()
        ).toBe(1)
        expect(
          await jobs.where("merchantPubkey").equals("synthetic-owner").count()
        ).toBe(1)
        expect(await jobs.where("updatedAt").equals(2).count()).toBe(1)
      } finally {
        current.close()
        await current.delete()
      }
    }
  )
})
