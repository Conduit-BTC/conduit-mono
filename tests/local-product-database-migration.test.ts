import { describe, expect, it } from "bun:test"
import Dexie from "dexie"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"

describe("local product journal schema convergence", () => {
  it("preserves main wallet and router state when adding local product stores", async () => {
    const options = { indexedDB: new IDBFactory(), IDBKeyRange }
    const name = "product-migration-main"
    const previous = new Dexie(name, options)
    previous.version(23).stores({
      wallets: "id",
      walletCredentials: "walletId",
      checkoutSparkPlanBindings: "checkoutId",
      checkoutSparkReconciliations: "checkoutId",
      checkoutSparkRetirements: "checkoutId",
      merchantShippingSettingsEvidence: "pubkey",
    })
    const rows = [
      ["wallets", { id: "synthetic-wallet", label: "test descriptor" }],
      [
        "walletCredentials",
        { walletId: "synthetic-wallet", format: "test-only" },
      ],
      [
        "checkoutSparkPlanBindings",
        { checkoutId: "synthetic-checkout", planDigest: "synthetic-digest" },
      ],
      [
        "checkoutSparkReconciliations",
        { checkoutId: "synthetic-checkout", revision: 3 },
      ],
      ["checkoutSparkRetirements", { checkoutId: "synthetic-retired" }],
      [
        "merchantShippingSettingsEvidence",
        { pubkey: "synthetic-owner", revision: 2 },
      ],
    ] as const
    for (const [table, row] of rows) await previous.table(table).put(row)
    previous.close()
    const current = new ConduitDB(name, options)
    try {
      await current.open()
      for (const [table, row] of rows) {
        expect(await current.table(table).toArray()).toEqual([row])
      }
      expect(await current.productListingOutbox.count()).toBe(0)
      expect(await current.localProductWriteIntents.count()).toBe(0)
    } finally {
      await current.delete()
    }
  })

  it("preserves pending local writes from the independent product preview lineage", async () => {
    const options = { indexedDB: new IDBFactory(), IDBKeyRange }
    const name = "product-migration-preview"
    const previous = new Dexie(name, options)
    const stores = {
      productListingOutbox:
        "id, merchantPubkey, state, nextRetryAt, updatedAt, createdAt",
      localProductWriteIntents: "id, merchantPubkey, listingJobId, committedAt",
      localProductWriteFrontiers: "id, merchantPubkey, intentId",
      localProductShippingOutbox: "id, merchantPubkey, createdAt",
      localProductStockCheckpoints:
        "id, merchantPubkey, orderId, productAddressId, state, committedAt",
    }
    previous.version(21).stores(stores)
    for (const table of Object.keys(stores)) {
      await previous
        .table(table)
        .put({ id: table, state: "pending", marker: 42 })
    }
    previous.close()
    const current = new ConduitDB(name, options)
    try {
      await current.open()
      for (const table of Object.keys(stores)) {
        expect(await current.table(table).toArray()).toEqual([
          { id: table, state: "pending", marker: 42 },
        ])
      }
      expect(await current.checkoutSparkPlanBindings.count()).toBe(0)
      expect(await current.merchantShippingSettingsEvidence.count()).toBe(0)
    } finally {
      await current.delete()
    }
  })
})
