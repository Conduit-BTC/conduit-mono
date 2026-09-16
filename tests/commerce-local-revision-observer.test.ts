import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  cacheSignedProductListingEvent,
  db,
  getProductsByIds,
  reconcileProductRecordsWithRevisions,
  subscribeLocalProductRevisionChanges,
  type CachedProduct,
  type LocalProductRevisionSnapshot,
} from "@conduit/core"

const key = generateSecretKey()
const author = getPublicKey(key)
const address = (name: string) => `30402:${author}:${name}`
let rows: CachedProduct[] = []
const cleanups: Array<() => void> = []

function event(
  name: string,
  timestamp: number,
  type = "simple",
  parent?: string
) {
  return new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: 30402,
        created_at: timestamp,
        content: "Public product description",
        tags: [
          ["d", name],
          ["title", name],
          ["stock", "5"],
          ["price", "20", "SATS"],
          ["type", type, "physical"],
          ["image", "https://cdn.conduit.market/conduit-test/product.png"],
          ...(parent
            ? [
                ["a", parent],
                ["spec", "size", name],
              ]
            : []),
        ],
      },
      key
    )
  )
}

function observe(ids: string[]) {
  const snapshots: LocalProductRevisionSnapshot[] = []
  let resolve!: () => void
  const ready = new Promise<void>((done) => {
    resolve = done
  })
  const stop = subscribeLocalProductRevisionChanges(ids, (snapshot) => {
    snapshots.push(snapshot)
    if (snapshot.status !== "loading") resolve()
  })
  cleanups.push(stop)
  return { snapshots, ready, stop }
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  rows = []
  __setCommerceTestOverrides({
    now: () => 500_000,
    getRelayLists: async () => new Map(),
    fetchEventsFanout: async () => [],
    getCachedProductTombstones: async () => [],
    getCachedProducts: async () => rows,
    putCachedProducts: async (updates) => {
      rows = [
        ...rows.filter((row) => !updates.some((next) => next.id === row.id)),
        ...updates,
      ]
    },
  })
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  __resetCommerceTestOverrides()
})

describe("local product revision evidence", () => {
  it("retains failed-save evidence before subscription and rejects older late delivery", async () => {
    const old = await cacheSignedProductListingEvent(event("coffee", 100))
    const previousRows = [...rows]
    __setCommerceTestOverrides({
      putCachedProducts: async () => {
        throw new Error("unavailable")
      },
    })
    await expect(
      cacheSignedProductListingEvent(event("coffee", 300))
    ).rejects.toThrow("unavailable")
    const observation = observe([old.addressId])
    expect(observation.snapshots[0]?.records[0]?.eventCreatedAt).toBe(300)
    await observation.ready
    expect(observation.snapshots.at(-1)?.records[0]?.eventCreatedAt).toBe(300)
    rows = previousRows
    await expect(
      cacheSignedProductListingEvent(event("coffee", 200))
    ).rejects.toThrow("unavailable")
    expect(observation.snapshots.at(-1)?.records[0]?.eventCreatedAt).toBe(300)
    const reconciled = reconcileProductRecordsWithRevisions(
      [old],
      observation.snapshots.at(-1)!.records
    )
    expect(reconciled[0]?.eventCreatedAt).toBe(300)
    expect(
      reconcileProductRecordsWithRevisions(
        reconciled,
        observation.snapshots.at(-1)!.records
      )
    ).toBe(reconciled)
  })

  it("uses the lower event id for equal timestamps and settles unavailable storage", async () => {
    const first = event("coffee", 300)
    const second = new NDKEvent(
      undefined,
      finalizeEvent(
        {
          ...first.rawEvent(),
          content: "Another signed description",
        },
        key
      )
    )
    const [winner, loser] = [first, second].sort((left, right) =>
      left.id.localeCompare(right.id)
    )
    await cacheSignedProductListingEvent(loser!)
    const observation = observe([address("coffee")])
    await observation.ready
    await cacheSignedProductListingEvent(winner!)
    await cacheSignedProductListingEvent(loser!)
    expect(observation.snapshots.at(-1)?.records[0]?.eventId).toBe(winner!.id)
    __setCommerceTestOverrides({
      getCachedProducts: async () => {
        throw new Error("unavailable")
      },
    })
    const unavailable = observe([address("coffee")])
    await unavailable.ready
    expect(unavailable.snapshots.at(-1)?.status).toBe("unavailable")
    expect(unavailable.snapshots.at(-1)?.records[0]?.eventId).toBe(winner!.id)
  })

  it("keeps in-flight signed evidence when a subscription ends before a failed save", async () => {
    const observation = observe([address("coffee")])
    await observation.ready
    let fail!: () => void
    __setCommerceTestOverrides({
      putCachedProducts: async () =>
        new Promise<void>((_, reject) => {
          fail = () => reject(new Error("unavailable"))
        }),
    })
    const writing = cacheSignedProductListingEvent(event("coffee", 300))
    await Promise.resolve()
    expect(observation.snapshots.at(-1)?.records[0]?.eventCreatedAt).toBe(300)
    observation.stop()
    fail()
    await expect(writing).rejects.toThrow("unavailable")
    const resumed = observe([address("coffee")])
    await resumed.ready
    expect(resumed.snapshots.at(-1)?.records[0]?.eventCreatedAt).toBe(300)
  })

  for (const mode of [
    "no write",
    "metadata merge",
    "newer incoming",
  ] as const) {
    it(`publishes the selected transaction winner (${mode})`, async () => {
      const old = await cacheSignedProductListingEvent(event("coffee", 100))
      const observation = observe([old.addressId])
      await observation.ready
      const newerEvent = event("coffee", 300)
      // Obtain a real persisted row without delivering it to this observer.
      const captured = [...rows]
      observation.stop()
      await cacheSignedProductListingEvent(newerEvent)
      const stored = rows[0]!
      rows = captured
      const resumed = observe([old.addressId])
      await resumed.ready
      rows = [{ ...stored, cachedAt: mode === "metadata merge" ? 0 : 500_000 }]
      __setCommerceTestOverrides({ putCachedProducts: undefined })
      const originalGet = db.products.bulkGet
      const originalPut = db.products.bulkPut
      const originalTransaction = db.transaction
      let reads = 0
      let writes = 0
      db.products.bulkGet = (async (ids: string[]) => {
        reads++
        return ids.map((id) => rows.find((row) => row.id === id))
      }) as typeof db.products.bulkGet
      db.products.bulkPut = (async (updates: CachedProduct[]) => {
        writes++
        rows = updates
        return updates.at(-1)!.id
      }) as typeof db.products.bulkPut
      db.transaction = (async (...args: unknown[]) =>
        (args.at(-1) as () => unknown)()) as typeof db.transaction
      try {
        await cacheSignedProductListingEvent(
          event("coffee", mode === "newer incoming" ? 400 : 200)
        )
        expect(reads).toBe(1)
        expect(writes).toBe(mode === "no write" ? 0 : 1)
        expect(resumed.snapshots.at(-1)?.records[0]?.eventCreatedAt).toBe(
          mode === "newer incoming" ? 400 : 300
        )
        expect(
          resumed.snapshots
            .slice(2)
            .every((snapshot) =>
              snapshot.records.every((record) => record.eventCreatedAt !== 200)
            )
        ).toBe(true)
      } finally {
        db.products.bulkGet = originalGet
        db.products.bulkPut = originalPut
        db.transaction = originalTransaction
      }
    })
  }

  it("scopes reads and notifications to requested product addresses", async () => {
    const originalGet = db.products.bulkGet
    __setCommerceTestOverrides({ getCachedProducts: undefined })
    const reads: string[][] = []
    db.products.bulkGet = (async (ids: string[]) => {
      reads.push(ids)
      return ids.map(() => undefined)
    }) as typeof db.products.bulkGet
    try {
      const observation = observe([address("coffee")])
      await observation.ready
      expect(reads).toEqual([[address("coffee")]])
      const before = observation.snapshots.length
      await cacheSignedProductListingEvent(event("unrelated", 100))
      expect(observation.snapshots.length).toBe(before)
      await cacheSignedProductListingEvent(event("coffee", 100))
      expect(
        observation.snapshots.at(-1)?.records.map((record) => record.addressId)
      ).toEqual([address("coffee")])
    } finally {
      db.products.bulkGet = originalGet
    }
  })

  for (const type of ["simple", "variation"] as const) {
    it(`rebuilds retained family dependencies after a child becomes ${type}`, async () => {
      const parent = await cacheSignedProductListingEvent(
        event("family", 100, "variable")
      )
      const child = await cacheSignedProductListingEvent(
        event("child", 100, "variation", parent.addressId)
      )
      await cacheSignedProductListingEvent(
        event("sibling", 100, "variation", parent.addressId)
      )
      const original = (
        await getProductsByIds([parent.addressId, child.addressId])
      ).data
      expect(original).toHaveLength(2)
      const newer = await cacheSignedProductListingEvent(
        event(
          "child",
          300,
          type,
          type === "variation" ? address("other-family") : undefined
        )
      )
      const reconciled = reconcileProductRecordsWithRevisions(original, [newer])
      const group = reconciled.find(
        (record) => record.addressId === parent.addressId
      )
      expect(group?.family?.children.map((record) => record.addressId)).toEqual(
        [address("sibling")]
      )
      expect(group?.family?.readEvidence.stale).toBe(true)
      expect(
        reconciled.find((record) => record.addressId === child.addressId)
          ?.product.type
      ).toBe(type === "simple" ? "simple" : undefined)
      expect(reconcileProductRecordsWithRevisions(reconciled, [newer])).toBe(
        reconciled
      )
    })
  }

  it("does not lend old completion to a simple product becoming an unverified variation", async () => {
    const original = await cacheSignedProductListingEvent(event("coffee", 100))
    const newer = await cacheSignedProductListingEvent(
      event("coffee", 300, "variation", address("missing-parent"))
    )
    expect(reconcileProductRecordsWithRevisions([original], [newer])).toEqual(
      []
    )
  })
})
