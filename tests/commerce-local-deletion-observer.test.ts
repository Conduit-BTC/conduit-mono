import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
  __setCommerceTestOverrides,
  db,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getLocalProductDeletionSnapshot,
  getCachedProductsByIds,
  getMarketplaceProducts,
  prepareProductCatalog,
  reconcileProductRecordsWithDeletions,
  subscribeLocalProductDeletionChanges,
  type CachedProduct,
  type CachedProductTombstone,
  type CommerceProductRecord,
  type LocalProductDeletionSnapshot,
} from "@conduit/core"

const key = generateSecretKey()
const author = getPublicKey(key)
let tombstones: CachedProductTombstone[] = []
const unsubscribers: Array<() => void> = []

function deletion(address: string, timestamp = 110, eventId?: string) {
  return new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: 5,
        created_at: timestamp,
        content: "",
        tags: eventId ? [["e", eventId]] : [["a", address]],
      },
      key
    )
  )
}

async function record(
  name: string,
  type = "simple",
  parent?: string,
  createdAt = 100
) {
  return cacheSignedProductListingEvent(
    new NDKEvent(
      undefined,
      finalizeEvent(
        {
          kind: 30402,
          created_at: createdAt,
          content: "",
          tags: [
            ["d", name],
            ["title", name],
            ["price", "20", "SATS"],
            ["type", type, "physical"],
            ["image", "https://example.com/product.png"],
            ...(parent
              ? [
                  ["parent", parent],
                  ["spec", "size", name],
                ]
              : []),
          ],
        },
        key
      )
    )
  )
}

function observe() {
  const snapshots: LocalProductDeletionSnapshot[] = []
  let settle!: (snapshot: LocalProductDeletionSnapshot) => void
  const ready = new Promise<LocalProductDeletionSnapshot>((resolve) => {
    settle = resolve
  })
  const unsubscribe = subscribeLocalProductDeletionChanges((snapshot) => {
    snapshots.push(snapshot)
    if (snapshot.status !== "loading") settle(snapshot)
  })
  unsubscribers.push(unsubscribe)
  return { snapshots, ready, unsubscribe }
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  tombstones = []
  __setCommerceTestOverrides({
    getCachedProductTombstones: async () => tombstones,
    putCachedProductTombstones: async (rows) => {
      tombstones = [
        ...tombstones.filter((row) => !rows.some((next) => next.id === row.id)),
        ...rows,
      ]
    },
    getCachedProducts: async () => [],
    putCachedProducts: async () => {},
  })
})

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
})

describe("local product deletion observation", () => {
  for (const mode of [
    "no write",
    "metadata merge",
    "newer incoming",
  ] as const) {
    it(`retains the transaction winner before returning (${mode})`, async () => {
      const candidate = await record("coffee", "simple", undefined, 200)
      const later = await record("coffee", "simple", undefined, 400)
      const observer = observe()
      await observer.ready
      const stored = deletion(
        candidate.addressId,
        mode === "newer incoming" ? 100 : 300
      )
      // Another context committed this row; observer delivery is still pending.
      tombstones = [
        {
          id: `a:${candidate.addressId}`,
          pubkey: author,
          addressId: candidate.addressId,
          deletedAt: stored.created_at!,
          deletionEventId: stored.id,
          signedEvent: stored.rawEvent(),
          sourceRelayUrls: [],
          observedLocally: mode !== "metadata merge",
          cachedAt: 1,
        },
      ]
      // Exercise the production transaction branch, not the stronger persistence
      // override. Only the database operations and observer delivery are controlled.
      __setCommerceTestOverrides({
        putCachedProductTombstones: undefined,
        fetchEventsFanout: async () => {
          throw new Error("Unexpected relay read")
        },
      })
      const table = db.productTombstones
      const originalGet = table.bulkGet
      const originalPut = table.bulkPut
      const originalTransaction = db.transaction
      let reads = 0
      let writes = 0
      table.bulkGet = (async (ids: string[]) => {
        reads++
        return ids.map((id) => tombstones.find((row) => row.id === id))
      }) as typeof table.bulkGet
      table.bulkPut = (async (rows: CachedProductTombstone[]) => {
        writes++
        tombstones = rows
        return rows.at(-1)!.id
      }) as typeof table.bulkPut
      db.transaction = ((...args: unknown[]) =>
        (args.at(-1) as () => Promise<unknown>)()) as typeof db.transaction
      try {
        await cacheSignedProductDeletionEvent(
          deletion(candidate.addressId, mode === "newer incoming" ? 300 : 100)
        )
        const snapshot = getLocalProductDeletionSnapshot()
        expect(tombstones[0]?.deletedAt).toBe(300)
        expect(snapshot.evidence[0]?.deletedAt).toBe(300)
        expect(observer.snapshots.at(-1)).toBe(snapshot)
        expect(
          reconcileProductRecordsWithDeletions(
            [candidate, later],
            snapshot.evidence
          )
        ).toEqual([later])
        expect(reads).toBe(1)
        expect(writes).toBe(mode === "no write" ? 0 : 1)

        // Delayed empty/older observations cannot weaken the adopted winner.
        observer.unsubscribe()
        tombstones = []
        const empty = observe()
        expect((await empty.ready).evidence).toEqual(snapshot.evidence)
        empty.unsubscribe()
        const old = deletion(candidate.addressId, 100)
        tombstones = [
          {
            id: `a:${candidate.addressId}`,
            pubkey: author,
            addressId: candidate.addressId,
            deletedAt: 100,
            deletionEventId: old.id,
            signedEvent: old.rawEvent(),
            cachedAt: 1,
          },
        ]
        expect((await observe().ready).evidence).toEqual(snapshot.evidence)
      } finally {
        table.bulkGet = originalGet
        table.bulkPut = originalPut
        db.transaction = originalTransaction
      }
    })
  }

  it("announces committed signed evidence before the write returns without relay I/O", async () => {
    __setCommerceTestOverrides({
      fetchEventsFanout: async () => {
        throw new Error("Unexpected relay read")
      },
    })
    const observer = observe()
    expect((await observer.ready).status).toBe("ready")
    const address = `30402:${author}:coffee`
    await cacheSignedProductDeletionEvent(deletion(address))
    expect(observer.snapshots.at(-1)?.evidence).toEqual([
      {
        target: "address",
        addressId: address,
        authorPubkey: author,
        deletedAt: 110,
        deletionEventId: deletion(address).id,
      },
    ])
    expect(getLocalProductDeletionSnapshot().revision).toBe(1)
    const snapshot = getLocalProductDeletionSnapshot()
    await cacheSignedProductDeletionEvent(deletion(address))
    expect(getLocalProductDeletionSnapshot()).toBe(snapshot)
  })

  it("does not regress a newer write when the initial storage read finishes later", async () => {
    let resolveRead!: (rows: CachedProductTombstone[]) => void
    let reading = false
    __setCommerceTestOverrides({
      getCachedProductTombstones: async () => {
        if (reading) return tombstones
        reading = true
        return new Promise((resolve) => {
          resolveRead = resolve
        })
      },
    })
    const observer = observe()
    while (!resolveRead) await new Promise((resolve) => setTimeout(resolve, 0))
    await cacheSignedProductDeletionEvent(deletion(`30402:${author}:coffee`))
    resolveRead([])
    expect((await observer.ready).evidence).toHaveLength(1)
    expect(getLocalProductDeletionSnapshot().revision).toBe(1)
  })

  it("loads evidence discovered while unsubscribed on a new observation", async () => {
    const observer = observe()
    await observer.ready
    observer.unsubscribe()
    const previousCount = observer.snapshots.length
    // Simulate a committed write from another same-origin context while no
    // local observer is attached, rather than invoking the local writer.
    const address = `30402:${author}:coffee`
    const signed = deletion(address)
    tombstones = [
      {
        id: `a:${address}`,
        pubkey: author,
        addressId: address,
        deletedAt: 110,
        deletionEventId: signed.id,
        signedEvent: signed.rawEvent(),
        cachedAt: 1,
      },
    ]
    const resumed = observe()
    expect(resumed.snapshots[0]?.status).toBe("loading")
    expect((await resumed.ready).evidence).toHaveLength(1)
    expect(observer.snapshots).toHaveLength(previousCount)
  })

  it("preserves known deletion evidence when initial storage becomes unavailable", async () => {
    await cacheSignedProductDeletionEvent(deletion(`30402:${author}:coffee`))
    const revision = getLocalProductDeletionSnapshot().revision
    __setCommerceTestOverrides({
      getCachedProductTombstones: async () => {
        throw new Error("Storage unavailable")
      },
    })
    const snapshot = await observe().ready
    expect(snapshot.status).toBe("unavailable")
    expect(snapshot.evidence).toHaveLength(1)
    expect(snapshot.revision).toBe(revision)
  })

  it("revokes from a validated remote deletion before its failed persistence attempt", async () => {
    const product = new NDKEvent(
      undefined,
      finalizeEvent(
        {
          kind: 30402,
          created_at: 100,
          content: "",
          tags: [
            ["d", "coffee"],
            ["title", "Coffee"],
            ["price", "20", "SATS"],
            ["type", "simple", "physical"],
            ["image", "https://example.com/product.png"],
          ],
        },
        key
      )
    )
    const address = `30402:${author}:coffee`
    const signed = deletion(address)
    __setRelayListTestOverrides({
      loadCached: async (pubkey) => ({
        pubkey,
        readRelayUrls: ["wss://read.example"],
        writeRelayUrls: ["wss://write.example"],
        eventCreatedAt: 1,
        cachedAt: 1_700_000_000_000,
      }),
    })
    let observedBeforeWrite = false
    __setCommerceTestOverrides({
      now: () => 1_700_000_000_000,
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(30402)
          ? [product]
          : filter.kinds?.includes(5)
            ? [signed]
            : [],
      putCachedProductTombstones: async () => {
        observedBeforeWrite = getLocalProductDeletionSnapshot().evidence.some(
          (e) => e.deletionEventId === signed.id
        )
        throw new Error("Storage write unavailable")
      },
    })
    const observer = observe()
    await observer.ready
    const result = await getMarketplaceProducts({ merchantPubkey: author })
    expect(observedBeforeWrite).toBe(true)
    expect(result.data).toEqual([])
    expect(tombstones).toEqual([])
    expect(observer.snapshots.at(-1)?.evidence).toHaveLength(1)
    const revision = getLocalProductDeletionSnapshot().revision
    observer.unsubscribe()
    __setCommerceTestOverrides({
      getCachedProductTombstones: async () => {
        throw new Error("Storage read unavailable")
      },
    })
    const retained = await observe().ready
    expect(retained.status).toBe("unavailable")
    expect(retained.evidence).toHaveLength(1)
    expect(retained.revision).toBe(revision)
  })

  it("retains a validated local deletion when persistence fails and retries durably", async () => {
    let cachedProducts: CachedProduct[] = []
    __setCommerceTestOverrides({
      getCachedProducts: async () => cachedProducts,
      putCachedProducts: async (rows) => {
        cachedProducts = rows
      },
    })
    const candidate = await record("coffee")
    const observer = observe()
    await observer.ready
    const signed = deletion(candidate.addressId)
    let announcedBeforeWrite = false
    __setCommerceTestOverrides({
      putCachedProductTombstones: async () => {
        announcedBeforeWrite =
          observer.snapshots
            .at(-1)
            ?.evidence.some((entry) => entry.deletionEventId === signed.id) ??
          false
        throw new Error("Local deletion storage failed")
      },
    })
    await expect(cacheSignedProductDeletionEvent(signed)).rejects.toThrow(
      "Local deletion storage failed"
    )
    expect(announcedBeforeWrite).toBe(true)
    expect(tombstones).toEqual([])
    expect((await getCachedProductsByIds([candidate.addressId])).data).toEqual(
      []
    )
    const revision = getLocalProductDeletionSnapshot().revision
    __setCommerceTestOverrides({
      putCachedProductTombstones: async (rows) => {
        tombstones = rows
      },
    })
    await cacheSignedProductDeletionEvent(signed)
    expect(tombstones).toHaveLength(1)
    expect(getLocalProductDeletionSnapshot().revision).toBe(revision)
    expect((await getCachedProductsByIds([candidate.addressId])).data).toEqual(
      []
    )
  })

  it("does not retain malformed signed deletion evidence", async () => {
    const signed = deletion(`30402:${author}:coffee`)
    signed.sig = "0".repeat(128)
    await expect(cacheSignedProductDeletionEvent(signed)).rejects.toThrow(
      "valid signed"
    )
    expect(getLocalProductDeletionSnapshot().evidence).toEqual([])
  })
})

describe("local product deletion reconciliation", () => {
  it("removes an exact revision without removing another revision or author", async () => {
    const candidate = await record("coffee")
    await cacheSignedProductDeletionEvent(
      deletion(candidate.addressId, 1, candidate.eventId)
    )
    const later = { ...candidate, eventId: "a".repeat(64), eventCreatedAt: 120 }
    const otherAuthor = {
      ...candidate,
      product: { ...candidate.product, pubkey: "b".repeat(64) },
    }
    expect(
      reconcileProductRecordsWithDeletions(
        [candidate, later, otherAuthor],
        getLocalProductDeletionSnapshot().evidence
      )
    ).toEqual([later, otherAuthor])
  })

  it("rebuilds family choices and summaries after child deletion and removes deleted parent structure", async () => {
    const parent = await record("shirt", "variable")
    const small = await record("small", "variation", parent.addressId)
    const large = await record("large", "variation", parent.addressId)
    // Preserve fixture protocol-independent family linkage explicitly.
    for (const child of [small, large]) {
      child.product.parentProductId = parent.addressId
      child.product.specifications = [
        { key: "size", value: child.product.title },
      ]
    }
    const readEvidence = {
      source: "commerce" as const,
      fetchedAt: 1,
      stale: false,
      degraded: false,
      capped: false,
    }
    const prepared = prepareProductCatalog([parent, small, large], readEvidence)
      .items[0]
    if (prepared?.kind !== "family") throw new Error("Expected family")
    const family: CommerceProductRecord = { ...parent, family: prepared.family }
    const unrelated = await record("coffee")
    const original = [family, unrelated]
    expect(reconcileProductRecordsWithDeletions(original, [])).toBe(original)
    await cacheSignedProductDeletionEvent(deletion(small.addressId))
    const reconciled = reconcileProductRecordsWithDeletions(
      [family, unrelated],
      getLocalProductDeletionSnapshot().evidence
    )
    expect(
      reconciled[0]?.family?.children.map((child) => child.addressId)
    ).toEqual([large.addressId])
    expect(reconciled[0]?.family?.axes[0]?.values).toEqual(["large"])
    expect(reconciled[0]?.family?.priceSummary.minimum?.addressId).toBe(
      large.addressId
    )
    expect(reconciled[0]?.family?.readEvidence).toBe(readEvidence)
    expect(reconciled[1]).toBe(unrelated)
    await cacheSignedProductDeletionEvent(deletion(parent.addressId))
    expect(
      reconcileProductRecordsWithDeletions(
        reconciled,
        getLocalProductDeletionSnapshot().evidence
      )
    ).toEqual([unrelated])
    expect(
      reconcileProductRecordsWithDeletions(
        [{ ...unrelated, eventCreatedAt: 120 }],
        [
          {
            target: "address",
            authorPubkey: author,
            addressId: unrelated.addressId,
            deletedAt: 110,
            deletionEventId: "d".repeat(64),
          },
        ]
      )
    ).toHaveLength(1)
  })
})
