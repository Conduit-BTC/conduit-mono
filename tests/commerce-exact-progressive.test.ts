import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  __resetRelayHealth,
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getCachedProductsByIds,
  getProductsByIds,
  hasExactLiveProductAvailabilityEvidence,
  type CachedProduct,
  type CachedProductTombstone,
  type ProductsByIdsResult,
} from "@conduit/core"

const fastSecret = generateSecretKey()
const slowSecret = generateSecretKey()
const now = 1_700_000_000_000
let products: CachedProduct[] = []
let tombstones: CachedProductTombstone[] = []

function listing(
  secret: Uint8Array,
  dTag: string,
  extraTags: string[][] = [],
  createdAt = 100
) {
  return new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: 30402,
        created_at: createdAt,
        content: "Synthetic exact product",
        tags: [
          ["d", dTag],
          ["title", dTag],
          ...(extraTags.some((tag) => tag[0] === "type")
            ? []
            : [["type", "simple", "physical"]]),
          ["price", "100", "SATS"],
          ["image", "https://cdn.conduit.market/conduit-test/product.png"],
          ...extraTags,
        ],
      },
      secret
    )
  )
}
const address = (event: NDKEvent) =>
  `30402:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")![1]}`
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
function deletion(event: NDKEvent, secret = fastSecret) {
  return new NDKEvent(
    undefined,
    finalizeEvent(
      { kind: 5, created_at: 200, tags: [["a", address(event)]], content: "" },
      secret
    )
  )
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetRelayHealth()
  products = []
  tombstones = []
  __setRelayListTestOverrides({
    fetchEventsFanout: async () => [],
    loadCached: async () => undefined,
    putCached: async () => {},
    now: () => now,
  })
  __setCommerceTestOverrides({
    now: () => now,
    getCachedProducts: async (merchant, authors) =>
      products.filter(
        (row) =>
          (!merchant || merchant === row.pubkey) &&
          (!authors || authors.includes(row.pubkey))
      ),
    putCachedProducts: async (rows) => {
      for (const row of rows)
        products = [...products.filter((current) => current.id !== row.id), row]
    },
    getCachedProductTombstones: async (merchant, authors) =>
      tombstones.filter(
        (row) =>
          (!merchant || merchant === row.pubkey) &&
          (!authors || authors.includes(row.pubkey))
      ),
    putCachedProductTombstones: async (rows) => {
      for (const row of rows)
        tombstones = [
          ...tombstones.filter((current) => current.id !== row.id),
          row,
        ]
    },
  })
})
afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetRelayHealth()
})

function installHeldRead(
  fast: NDKEvent[],
  slow: NDKEvent,
  networkDeletion?: NDKEvent
) {
  const held = gate()
  const fastReturned = gate()
  const filters: Array<{ authors?: string[]; dTags?: string[] }> = []
  __setCommerceTestOverrides({
    fetchEventsFanout: async (filter) => {
      if (filter.kinds?.includes(5))
        return networkDeletion ? [networkDeletion] : []
      if (!filter.kinds?.includes(30402)) return []
      filters.push({ authors: filter.authors, dTags: filter["#d"] })
      if (filter.authors?.includes(slow.pubkey)) {
        await held.promise
        return [slow]
      }
      fastReturned.release()
      return fast
    },
  })
  return { held, fastReturned, filters }
}

async function afterFastRead(fastReturned: ReturnType<typeof gate>) {
  await fastReturned.promise
  // The fast transport result continues through asynchronous cache projection.
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe("progressive exact product reads", () => {
  it("emits the completed author batch before a held sibling without adding requests", async () => {
    const fast = [
      listing(fastSecret, "fast-one"),
      listing(fastSecret, "fast-two"),
    ]
    const slow = listing(slowSecret, "slow")
    const { held, fastReturned, filters } = installHeldRead(fast, slow)
    const snapshots: ProductsByIdsResult[] = []
    const read = getProductsByIds([...fast, slow].map(address), {
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    try {
      await afterFastRead(fastReturned)
      expect(snapshots).toHaveLength(1)
      expect(
        snapshots[0]!.data.map((record) => record.addressId).sort()
      ).toEqual(fast.map(address).sort())
      expect(snapshots[0]!.meta).toMatchObject({ stale: true, degraded: true })
      expect(
        snapshots[0]!.diagnostics.every(
          (row) => row.coverage?.listing !== "complete"
        )
      ).toBe(true)
      expect(
        (await getCachedProductsByIds(fast.map(address))).data
      ).toHaveLength(2)
      expect(filters).toHaveLength(2)
      expect(
        filters.find((filter) => filter.authors?.includes(fast[0]!.pubkey))
          ?.dTags
      ).toHaveLength(2)
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    const final = await read
    expect(final.data).toHaveLength(3)
    expect(snapshots.at(-1)).toEqual(final)
    expect(final.meta.stale).toBe(false)
  })

  it("retracts an earlier product when a later signed network deletion arrives", async () => {
    const fast = listing(fastSecret, "deleted-after-preview")
    const slow = listing(slowSecret, "survivor")
    const { held, fastReturned } = installHeldRead([fast], slow, deletion(fast))
    const snapshots: ProductsByIdsResult[] = []
    const read = getProductsByIds([fast, slow].map(address), {
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    try {
      await afterFastRead(fastReturned)
      expect(snapshots[0]?.data.map((record) => record.addressId)).toContain(
        address(fast)
      )
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    const final = await read
    expect(final.data.map((record) => record.addressId)).toEqual([
      address(slow),
    ])
    expect(snapshots.at(-1)).toEqual(final)
  })

  it("rechecks local signed tombstones before every later emission", async () => {
    const fast = listing(fastSecret, "locally-deleted")
    const slow = listing(slowSecret, "later")
    const { held, fastReturned } = installHeldRead([fast], slow)
    const snapshots: ProductsByIdsResult[] = []
    const read = getProductsByIds([fast, slow].map(address), {
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    try {
      await afterFastRead(fastReturned)
      expect(snapshots[0]?.data.map((record) => record.addressId)).toContain(
        address(fast)
      )
      await cacheSignedProductDeletionEvent(deletion(fast))
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    await read
    expect(
      snapshots
        .slice(1)
        .every((snapshot) =>
          snapshot.data.every((record) => record.addressId !== address(fast))
        )
    ).toBe(true)
  })

  it("suppresses queued progress and completion after account scope cancellation", async () => {
    const fast = listing(fastSecret, "cancelled-fast")
    const slow = listing(slowSecret, "cancelled-slow")
    const { held, fastReturned } = installHeldRead([fast], slow)
    const snapshots: ProductsByIdsResult[] = []
    let active = true
    const read = getProductsByIds([fast, slow].map(address), {
      shouldContinue: () => active,
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    try {
      await afterFastRead(fastReturned)
      expect(snapshots).toHaveLength(1)
      active = false
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    await expect(read).rejects.toThrow()
    expect(snapshots).toHaveLength(1)
  })

  it("keeps the newest cached revision and the existing merchant-hidden safety exception", async () => {
    const old = listing(fastSecret, "hidden", [["visibility", "private"]])
    const newer = listing(
      fastSecret,
      "hidden",
      [["visibility", "private"]],
      150
    )
    const unsafe = listing(fastSecret, "Counterfeit goods", [
      ["visibility", "private"],
    ])
    const slow = listing(slowSecret, "other")
    await cacheSignedProductListingEvent(newer)
    const { held, fastReturned } = installHeldRead([old, unsafe], slow)
    const snapshots: ProductsByIdsResult[] = []
    const read = getProductsByIds([old, unsafe, slow].map(address), {
      includeMerchantHiddenProductIds: [address(old), address(unsafe)],
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    try {
      await afterFastRead(fastReturned)
      expect(
        snapshots[0]?.data.find((record) => record.addressId === address(old))
          ?.eventId
      ).toBe(newer.id)
      expect(
        snapshots[0]?.data.some(
          (record) => record.addressId === address(unsafe)
        )
      ).toBe(false)
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    await read
  })
  it("keeps variation families browse-only and retracts a deleted child during final cache persistence", async () => {
    const parent = listing(fastSecret, "family", [
      ["type", "variable", "physical"],
      ["visibility", "private"],
    ])
    const child = listing(fastSecret, "family-red", [
      ["type", "variation", "physical"],
      ["a", address(parent)],
      ["spec", "color", "red"],
      ["visibility", "private"],
    ])
    const slow = listing(slowSecret, "family-sibling")
    const { held, fastReturned } = installHeldRead([parent, child], slow)
    const snapshots: ProductsByIdsResult[] = []
    let writes = 0
    __setCommerceTestOverrides({
      putCachedProducts: async (rows) => {
        writes++
        for (const row of rows)
          products = [
            ...products.filter((current) => current.id !== row.id),
            row,
          ]
        // First fast preview, then slow preview, then the final reconciled write.
        if (writes === 3) await cacheSignedProductDeletionEvent(deletion(child))
      },
    })
    const ids = [parent, child, slow].map(address)
    const read = getProductsByIds(ids, {
      includeMerchantHiddenProductIds: ids,
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    try {
      await afterFastRead(fastReturned)
      const family = snapshots[0]?.data.find(
        (record) => record.addressId === address(parent)
      )?.family
      expect(family?.children.map((record) => record.addressId)).toContain(
        address(child)
      )
      expect(family?.readEvidence).toMatchObject({
        stale: true,
        degraded: true,
      })
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    const final = await read
    expect(snapshots.at(-1)).toEqual(final)
    expect(
      final.data.every(
        (record) =>
          record.addressId !== address(child) &&
          !record.family?.children.some(
            (candidate) => candidate.addressId === address(child)
          )
      )
    ).toBe(true)
  })

  it("keeps the completed result identical with and without observation", async () => {
    const product = listing(fastSecret, "unchanged-final")
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(30402) ? [product] : [],
    })
    const unobserved = await getProductsByIds([address(product)])
    const snapshots: ProductsByIdsResult[] = []
    const observed = await getProductsByIds([address(product)], {
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    expect(observed).toEqual(unobserved)
    expect(snapshots.at(-1)).toEqual(unobserved)
  })
  for (const updatePhase of ["held sibling", "final cache write"] as const) {
    it(`retains a newer cached signed withdrawal learned during ${updatePhase}`, async () => {
      const collection = `30405:${"a".repeat(64)}:event`
      const fast = listing(fastSecret, "withdrawal", [
        ["visibility", "private"],
        ["a", collection],
        ["shipping_option", collection],
      ])
      const withdrawn = listing(
        fastSecret,
        "withdrawal",
        [["visibility", "private"]],
        150
      )
      const slow = listing(slowSecret, "withdrawal-sibling")
      const { held, fastReturned } = installHeldRead([fast], slow)
      const snapshots: ProductsByIdsResult[] = []
      if (updatePhase === "final cache write") {
        let writes = 0
        __setCommerceTestOverrides({
          putCachedProducts: async (rows) => {
            writes++
            for (const row of rows)
              products = [
                ...products.filter((current) => current.id !== row.id),
                row,
              ]
            if (writes === 3) await cacheSignedProductListingEvent(withdrawn)
          },
        })
      }
      const read = getProductsByIds([fast, slow].map(address), {
        includeMerchantHiddenProductIds: [address(fast)],
        onProgress: (snapshot) => snapshots.push(snapshot),
      })
      try {
        await afterFastRead(fastReturned)
        expect(
          snapshots[0]?.data.find(
            (record) => record.addressId === address(fast)
          )?.product.collectionRefs
        ).toContain(collection)
        if (updatePhase === "held sibling")
          await cacheSignedProductListingEvent(withdrawn)
      } finally {
        held.release()
        await read.catch(() => undefined)
      }
      const final = await read
      const selected = final.data.find(
        (record) => record.addressId === address(fast)
      )
      expect(selected?.eventId).toBe(withdrawn.id)
      expect(selected?.product.collectionRefs ?? []).not.toContain(collection)
      expect(final.meta).toMatchObject({
        stale: true,
        degraded: true,
        source: "local_cache",
      })
      expect(
        hasExactLiveProductAvailabilityEvidence(
          final.diagnostics.find((row) => row.addressId === address(fast)),
          address(fast)
        )
      ).toBe(false)
      expect(snapshots.at(-1)).toEqual(final)
    })
  }
})
