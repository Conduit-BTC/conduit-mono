import { describe, expect, it } from "bun:test"
import Dexie from "dexie"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { isDeepStrictEqual } from "node:util"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  ConduitDB,
  db as defaultDb,
  ensureCommerceCacheScope,
  pruneCommerceCaches,
  type EventMarketOrganizerStockEntry,
  type EventMarketOrganizerStockPool,
} from "@conduit/core/db"
import { createEventMarketStockAuthorityRumor } from "@conduit/core/protocol/event-market-stock-authority"
import frozenHistories from "./fixtures/event-market-db-histories.json"

function records() {
  const secret = generateSecretKey()
  const merchantPubkey = getPublicKey(secret)
  const organizerPubkey = getPublicKey(generateSecretKey())
  const productCoordinate = `30402:${merchantPubkey}:schema-stock`
  const assignmentCoordinate = `30410:${merchantPubkey}:schema-assignment`
  const source = finalizeEvent(
    {
      kind: 30402,
      created_at: 100,
      content: "",
      tags: [
        ["d", "schema-stock"],
        ["title", "Stock"],
        ["type", "simple", "physical"],
        ["price", "1", "SAT"],
        ["stock", "12"],
      ],
    },
    secret
  )
  const grantRumor = createEventMarketStockAuthorityRumor({
    createdAt: 100,
    payload: {
      type: "grant",
      version: 1,
      nonce: crypto.randomUUID(),
      merchantPubkey,
      organizerPubkey,
      writerId: crypto.randomUUID(),
      productCoordinate,
      assignmentCoordinate,
      marketCoordinate: `30409:${organizerPubkey}:schema-market`,
      occurrenceCoordinate: `31923:${organizerPubkey}:schema-day`,
      productEventId: source.id,
      assignmentEventId: source.id,
      marketEventId: source.id,
      occurrenceEventId: source.id,
      grantEventId: source.id,
      quantity: 5,
      expiresAtMs: 200_000,
    },
  })
  const grant = JSON.parse(grantRumor.content)
  const rumor = createEventMarketStockAuthorityRumor({
    createdAt: 110,
    payload: {
      type: "accepted",
      version: 1,
      merchantPubkey,
      organizerPubkey,
      writerId: grant.writerId,
      poolId: grantRumor.id,
      sequence: 1,
      previousId: grantRumor.id,
      orderId: crypto.randomUUID(),
      identityBinding: source.id,
      termsBinding: source.id,
      claimRef: source.id,
      quantity: 2,
      acceptedAtMs: 110_000,
    },
  })
  const accepted = JSON.parse(rumor.content)
  const pool: EventMarketOrganizerStockPool = {
    id: `${organizerPubkey}:${grantRumor.id}`,
    accountPubkey: organizerPubkey,
    poolId: grantRumor.id,
    merchantPubkey,
    organizerPubkey,
    writerId: grant.writerId,
    productCoordinate,
    assignmentCoordinate,
    grantRumor,
    quantity: 5,
    acceptedQuantity: 2,
    acceptedSequence: 1,
    lastAcceptedId: rumor.id,
    importedQuantity: 0,
    importedSequence: 0,
    lastImportedId: grantRumor.id,
    state: "active",
  }
  const entry: EventMarketOrganizerStockEntry = {
    id: `${organizerPubkey}:${rumor.id}`,
    accountPubkey: organizerPubkey,
    poolId: grantRumor.id,
    sequence: 1,
    orderId: accepted.orderId,
    claimRef: accepted.claimRef,
    rumor,
    quantity: 2,
    evidence: "retained-private-fixture",
    imported: false,
  }
  return {
    pool,
    entry,
    inventory: {
      product: {
        coordinate: productCoordinate,
        merchantPubkey,
        stock: 12,
        revision: 1,
        sourceProductEvent: source,
        signedProductEvent: source,
        publicationJobs: [],
      },
      assignment: {
        coordinate: assignmentCoordinate,
        merchantPubkey,
        productCoordinate,
        marketCoordinate: grant.marketCoordinate,
        occurrenceCoordinate: grant.occurrenceCoordinate,
        inventory: { mode: "tracked", quantity: 5 },
        state: "active",
        fulfillmentMethods: ["pickup"],
        occurrenceEndMs: 200_000,
        terminal: false,
        revision: 1,
        publicationJobs: [],
      },
      accepted: {
        orderId: accepted.orderId,
        merchantPubkey,
        identityBinding: source.id,
        termsBinding: source.id,
        evidence: "retained-before-upgrade",
        items: [
          {
            productCoordinate,
            assignmentCoordinate,
            method: "pickup",
            quantity: 2,
          },
        ],
        acceptedAt: 110_000,
      },
    },
  }
}

const repairedStores = {
  ...frozenHistories[0]!.stores,
  eventMarketRosterEvidence: "id, marketCoordinate, cachedAt, discoveryBytes",
}
const unionStores = Object.assign(
  {},
  ...frozenHistories.map((history) => history.stores),
  repairedStores
)
const histories = [
  ...frozenHistories,
  { name: "repaired main", version: 26.1, stores: repairedStores },
  {
    name: "complete inventory/discovery union",
    version: 27,
    stores: unionStores,
  },
]

async function expectConstraint(operation: Promise<unknown>) {
  let failed = false
  try {
    await operation
  } catch (error) {
    failed = error instanceof Error && error.name === "ConstraintError"
  }
  expect(failed).toBe(true)
}

describe("durable organizer stock schema", () => {
  for (const history of histories) {
    it(`preserves populated v${history.version} ${history.name} tables and adds durable v28 stock journals`, async () => {
      const options = { indexedDB: new IDBFactory(), IDBKeyRange }
      const name = `organizer-stock-upgrade-${crypto.randomUUID()}`
      const old = new Dexie(name, options)
      old.version(history.version).stores(history.stores)
      const fixture = records()
      const retained = new Map<string, object[]>()
      await old.open()
      try {
        for (const [table, schema] of Object.entries(history.stores)) {
          const primary = String(schema)
            .split(",")[0]!
            .replace(/^[&+*]+/, "")
          const rows = [
            { [primary]: `${table}-retained`, marker: "existing-union-row" },
          ]
          await old.table(table).bulkPut(rows)
        }
        for (const [table, row] of [
          ["merchantInventoryProducts", fixture.inventory.product],
          ["merchantInventoryAssignments", fixture.inventory.assignment],
          ["merchantInventoryAcceptedOrders", fixture.inventory.accepted],
        ] as const) {
          if (old.tables.some((candidate) => candidate.name === table))
            await old.table(table).put(row)
        }
        for (const table of old.tables)
          retained.set(table.name, await table.toArray())
      } finally {
        old.close()
      }
      const upgraded = new ConduitDB(name, options)
      try {
        await upgraded.open()
        expect(upgraded.verno).toBe(28)
        expect(upgraded.backendDB().version).toBe(280)
        for (const [table, rows] of retained) {
          expect(
            upgraded.tables.some((candidate) => candidate.name === table)
          ).toBe(true)
          const restored = await upgraded.table(table).toArray()
          // Do not expose signed/private fixture data in assertion failure output.
          if (!isDeepStrictEqual(restored, rows))
            throw new Error(`Upgrade changed existing ${table} records.`)
        }
        for (const table of [
          "merchantInventoryProducts",
          "merchantInventoryAssignments",
          "merchantInventoryAcceptedOrders",
          "localProductWriteIntents",
          "localProductWriteFrontiers",
          "localProductShippingOutbox",
          "commerceInboxWrappers",
          "sparkRecoveryEvidence",
        ])
          expect(
            upgraded.tables.some((candidate) => candidate.name === table)
          ).toBe(true)
        expect(
          upgraded.eventMarketRosterEvidence.schema.idxByName.discoveryBytes
        ).toBeDefined()
        expect(await upgraded.eventMarketOrganizerStockPools.count()).toBe(0)
        expect(await upgraded.eventMarketOrganizerStockEntries.count()).toBe(0)
        await upgraded.eventMarketOrganizerStockPools.add(fixture.pool)
        await upgraded.eventMarketOrganizerStockEntries.add(fixture.entry)
        upgraded.close({ disableAutoOpen: false })
        await upgraded.open()
        expect(
          isDeepStrictEqual(
            await upgraded.eventMarketOrganizerStockPools.get(fixture.pool.id),
            fixture.pool
          )
        ).toBe(true)
        expect(
          isDeepStrictEqual(
            await upgraded.eventMarketOrganizerStockEntries.get(
              fixture.entry.id
            ),
            fixture.entry
          )
        ).toBe(true)
        for (const [table, rows] of retained) {
          if (!isDeepStrictEqual(await upgraded.table(table).toArray(), rows))
            throw new Error(`Reopen changed existing ${table} records.`)
        }
      } finally {
        upgraded.close()
        await upgraded.delete()
      }
    })
  }

  it("enforces account/pool/sequence/order/claim uniqueness without cross-account collisions", async () => {
    const options = { indexedDB: new IDBFactory(), IDBKeyRange }
    const database = new ConduitDB(
      `organizer-stock-keys-${crypto.randomUUID()}`,
      options
    )
    const { pool, entry } = records()
    try {
      await database.open()
      await database.eventMarketOrganizerStockPools.add(pool)
      await expectConstraint(
        database.eventMarketOrganizerStockPools.add({
          ...pool,
          id: crypto.randomUUID(),
        })
      )
      const otherAccount = getPublicKey(generateSecretKey())
      await database.eventMarketOrganizerStockPools.add({
        ...pool,
        id: crypto.randomUUID(),
        accountPubkey: otherAccount,
      })
      await database.eventMarketOrganizerStockEntries.add(entry)
      await expectConstraint(
        database.eventMarketOrganizerStockEntries.add({
          ...entry,
          id: crypto.randomUUID(),
          orderId: crypto.randomUUID(),
          claimRef: getPublicKey(generateSecretKey()),
        })
      )
      await expectConstraint(
        database.eventMarketOrganizerStockEntries.add({
          ...entry,
          id: crypto.randomUUID(),
          sequence: 2,
          claimRef: getPublicKey(generateSecretKey()),
        })
      )
      await expectConstraint(
        database.eventMarketOrganizerStockEntries.add({
          ...entry,
          id: crypto.randomUUID(),
          sequence: 2,
          orderId: crypto.randomUUID(),
        })
      )
      await database.eventMarketOrganizerStockEntries.add({
        ...entry,
        id: crypto.randomUUID(),
        accountPubkey: otherAccount,
      })
      await database.eventMarketOrganizerStockEntries.add({
        ...entry,
        id: crypto.randomUUID(),
        poolId: getPublicKey(generateSecretKey()),
      })
      await database.eventMarketOrganizerStockEntries.add({
        ...entry,
        id: crypto.randomUUID(),
        sequence: 2,
        orderId: crypto.randomUUID(),
        claimRef: getPublicKey(generateSecretKey()),
      })
      expect(await database.eventMarketOrganizerStockPools.count()).toBe(2)
      expect(await database.eventMarketOrganizerStockEntries.count()).toBe(4)
      database.close({ disableAutoOpen: false })
      await database.open()
      expect(await database.eventMarketOrganizerStockEntries.count()).toBe(4)
    } finally {
      database.close()
      await database.delete()
    }
  })

  it("retains stock authority and accepted inventory across relay-scope clearing and cache pruning", async () => {
    const database = new ConduitDB(
      `organizer-stock-prune-${crypto.randomUUID()}`,
      { indexedDB: new IDBFactory(), IDBKeyRange }
    )
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const descriptors = new Map<string, PropertyDescriptor | undefined>()
    const { pool, entry, inventory } = records()
    try {
      await database.open()
      await database.eventMarketOrganizerStockPools.add(pool)
      await database.eventMarketOrganizerStockEntries.add(entry)
      await database.merchantInventoryProducts.add(inventory.product)
      await database.merchantInventoryAssignments.add(
        inventory.assignment as never
      )
      await database.merchantInventoryAcceptedOrders.add(
        inventory.accepted as never
      )
      // Run the real cache functions only against this isolated fake-indexeddb.
      for (const table of database.tables) {
        descriptors.set(
          table.name,
          Object.getOwnPropertyDescriptor(defaultDb, table.name)
        )
        Object.defineProperty(defaultDb, table.name, {
          configurable: true,
          writable: true,
          value: table,
        })
      }
      const local = new Map<string, string>()
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          localStorage: {
            getItem: (key: string) => local.get(key) ?? null,
            setItem: (key: string, value: string) => local.set(key, value),
          },
        },
      })
      await ensureCommerceCacheScope()
      await pruneCommerceCaches()
      expect(
        isDeepStrictEqual(
          await database.eventMarketOrganizerStockPools.get(pool.id),
          pool
        )
      ).toBe(true)
      expect(
        isDeepStrictEqual(
          await database.eventMarketOrganizerStockEntries.get(entry.id),
          entry
        )
      ).toBe(true)
      expect(await database.merchantInventoryProducts.count()).toBe(1)
      expect(await database.merchantInventoryAssignments.count()).toBe(1)
      expect(await database.merchantInventoryAcceptedOrders.count()).toBe(1)
    } finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(defaultDb, key, descriptor)
        else Reflect.deleteProperty(defaultDb, key)
      }
      if (originalWindow)
        Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
      database.close()
      await database.delete()
    }
  })
})
