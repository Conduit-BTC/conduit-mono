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
  createProductsByIdsReadCoordinator,
  getCachedProductsByIds,
  getProductsByIds,
  hasExactLiveProductAvailabilityEvidence,
  type CachedProduct,
  type CachedProductTombstone,
  type ProductsByIdsResult,
} from "@conduit/core"

const fastSecret = generateSecretKey()
const slowSecret = generateSecretKey()
const thirdSecret = generateSecretKey()
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
  const deletionFilters: Array<{
    authors?: string[]
    eventIds?: string[]
    addresses?: string[]
  }> = []
  __setCommerceTestOverrides({
    fetchEventsFanout: async (filter) => {
      if (filter.kinds?.includes(5)) {
        deletionFilters.push({
          authors: filter.authors,
          eventIds: filter["#e"],
          addresses: filter["#a"],
        })
        return networkDeletion ? [networkDeletion] : []
      }
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
  return { held, fastReturned, filters, deletionFilters }
}

async function afterFastRead(fastReturned: ReturnType<typeof gate>) {
  await fastReturned.promise
  // The fast transport result continues through asynchronous cache projection.
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe("progressive exact product reads", () => {
  it("shares one author concurrency budget across overlapping exact reads", async () => {
    const listings = Array.from({ length: 4 }, (_, index) =>
      listing(generateSecretKey(), `coordinated-${index}`)
    )
    const release = gate()
    const twoStarted = gate()
    let activeProductReads = 0
    let maximumProductReads = 0
    let startedProductReads = 0
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        activeProductReads += 1
        startedProductReads += 1
        maximumProductReads = Math.max(maximumProductReads, activeProductReads)
        if (startedProductReads === 2) twoStarted.release()
        try {
          await release.promise
          return listings.filter(
            (event) =>
              filter.authors?.includes(event.pubkey) &&
              filter["#d"]?.includes(
                event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""
              )
          )
        } finally {
          activeProductReads -= 1
        }
      },
    })
    const coordinator = createProductsByIdsReadCoordinator(2)
    const first = getProductsByIds(listings.slice(0, 2).map(address), {
      readCoordinator: coordinator,
    })
    const second = getProductsByIds(listings.slice(2).map(address), {
      readCoordinator: coordinator,
    })
    try {
      await twoStarted.promise
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(maximumProductReads).toBe(2)
    } finally {
      release.release()
    }

    const results = await Promise.all([first, second])
    expect(results.map((result) => result.data.length)).toEqual([2, 2])
    expect(maximumProductReads).toBe(2)
  })

  it("settles a completed author before a held sibling without rereading exact products", async () => {
    const fast = [
      listing(fastSecret, "fast-one"),
      listing(fastSecret, "fast-two"),
    ]
    const slow = listing(slowSecret, "slow")
    const { held, fastReturned, filters, deletionFilters } = installHeldRead(
      fast,
      slow
    )
    const snapshots: ProductsByIdsResult[] = []
    const settled: ProductsByIdsResult[] = []
    const read = getProductsByIds([...fast, slow].map(address), {
      onProgress: (snapshot) => snapshots.push(snapshot),
      onAuthorSettled: (snapshot) => settled.push(snapshot),
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
      expect(settled).toHaveLength(1)
      expect(
        fast.every((event) =>
          hasExactLiveProductAvailabilityEvidence(
            settled[0]!.diagnostics.find(
              (diagnostic) => diagnostic.addressId === address(event)
            ),
            address(event)
          )
        )
      ).toBe(true)
      expect(
        settled[0]!.diagnostics.some(
          (diagnostic) => diagnostic.addressId === address(slow)
        )
      ).toBe(false)
      expect(
        deletionFilters.filter((filter) =>
          filter.authors?.includes(fast[0]!.pubkey)
        )
      ).toHaveLength(2)
      expect(
        deletionFilters.some((filter) => filter.authors?.includes(slow.pubkey))
      ).toBe(false)
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
    expect(settled.at(-1)).toEqual(final)
    expect(final.meta.stale).toBe(false)
  })

  it("reconciles each settled author against cache only once", async () => {
    const listings = Array.from({ length: 4 }, (_, index) =>
      listing(generateSecretKey(), `linear-reconciliation-${index}`)
    )
    const cacheReadScopes: string[][] = []
    __setCommerceTestOverrides({
      getCachedProducts: async (merchant, authors) => {
        if (authors) cacheReadScopes.push([...authors])
        return products.filter(
          (row) =>
            (!merchant || merchant === row.pubkey) &&
            (!authors || authors.includes(row.pubkey))
        )
      },
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(30402)
          ? listings.filter(
              (event) =>
                filter.authors?.includes(event.pubkey) &&
                event.tags.some(
                  (tag) =>
                    tag[0] === "d" && filter["#d"]?.includes(tag[1] ?? "")
                )
            )
          : [],
    })
    const settled: ProductsByIdsResult[] = []

    const result = await getProductsByIds(listings.map(address), {
      onAuthorSettled: (snapshot) => settled.push(snapshot),
    })

    expect(result.data).toHaveLength(listings.length)
    expect(settled.map((snapshot) => snapshot.data.length)).toEqual([
      1, 2, 3, 4,
    ])
    expect(cacheReadScopes.map((scope) => scope.length)).toEqual([
      listings.length,
      1,
      1,
      1,
      1,
      listings.length,
    ])
  })

  it("revalidates a settled author after a signed tombstone is cached", async () => {
    const fast = listing(fastSecret, "settled-then-deleted")
    const slow = listing(slowSecret, "held-sibling")
    const { held, fastReturned } = installHeldRead([fast], slow)
    const settled: ProductsByIdsResult[] = []
    const read = getProductsByIds([fast, slow].map(address), {
      onAuthorSettled: (snapshot) => settled.push(snapshot),
    })

    try {
      await afterFastRead(fastReturned)
      expect(settled).toHaveLength(1)
      expect(
        hasExactLiveProductAvailabilityEvidence(
          settled[0]!.diagnostics.find(
            (diagnostic) => diagnostic.addressId === address(fast)
          ),
          address(fast)
        )
      ).toBe(true)
      await cacheSignedProductDeletionEvent(deletion(fast))
    } finally {
      held.release()
      await read.catch(() => undefined)
    }

    const final = await read
    expect(settled.length).toBeGreaterThan(1)
    expect(
      settled.slice(1).every(
        (snapshot) =>
          !snapshot.data.some((record) => record.addressId === address(fast)) &&
          !hasExactLiveProductAvailabilityEvidence(
            snapshot.diagnostics.find(
              (diagnostic) => diagnostic.addressId === address(fast)
            ),
            address(fast)
          )
      )
    ).toBe(true)
    expect(
      final.data.some((record) => record.addressId === address(fast))
    ).toBe(false)
  })

  it("revalidates a settled author after a newer signed withdrawal is cached", async () => {
    const fast = listing(fastSecret, "settled-then-withdrawn")
    const withdrawn = listing(
      fastSecret,
      "settled-then-withdrawn",
      [["visibility", "private"]],
      150
    )
    const slow = listing(slowSecret, "held-withdrawal-sibling")
    const { held, fastReturned } = installHeldRead([fast], slow)
    const withdrawalVisible = gate()
    const finishWithdrawalWrite = gate()
    __setCommerceTestOverrides({
      putCachedProducts: async (rows) => {
        for (const row of rows)
          products = [
            ...products.filter((current) => current.id !== row.id),
            row,
          ]
        if (rows.some((row) => row.eventId === withdrawn.id)) {
          withdrawalVisible.release()
          await finishWithdrawalWrite.promise
        }
      },
    })
    const settled: ProductsByIdsResult[] = []
    const laterSettled = gate()
    const read = getProductsByIds([fast, slow].map(address), {
      onAuthorSettled: (snapshot) => {
        settled.push(snapshot)
        if (settled.length > 1) laterSettled.release()
      },
    })
    let withdrawalCacheWrite:
      ReturnType<typeof cacheSignedProductListingEvent> | undefined

    try {
      await afterFastRead(fastReturned)
      expect(settled).toHaveLength(1)
      expect(
        hasExactLiveProductAvailabilityEvidence(
          settled[0]!.diagnostics.find(
            (diagnostic) => diagnostic.addressId === address(fast)
          ),
          address(fast)
        )
      ).toBe(true)
      withdrawalCacheWrite = cacheSignedProductListingEvent(withdrawn)
      await withdrawalVisible.promise
      held.release()
      await laterSettled.promise
    } finally {
      finishWithdrawalWrite.release()
      held.release()
      await withdrawalCacheWrite?.catch(() => undefined)
      await read.catch(() => undefined)
    }

    const final = await read
    expect(settled.length).toBeGreaterThan(1)
    for (const snapshot of settled.slice(1)) {
      expect(
        snapshot.data.some((record) => record.addressId === address(fast))
      ).toBe(false)
      expect(
        hasExactLiveProductAvailabilityEvidence(
          snapshot.diagnostics.find(
            (diagnostic) => diagnostic.addressId === address(fast)
          ),
          address(fast)
        )
      ).toBe(false)
    }
    expect(
      final.data.some((record) => record.addressId === address(fast))
    ).toBe(false)
  })

  it("holds an author pipeline slot through deletion reconciliation", async () => {
    const first = listing(fastSecret, "pipeline-first")
    const second = listing(slowSecret, "pipeline-second")
    const third = listing(thirdSecret, "pipeline-third")
    const deletionHeld = gate()
    const deletionStarted = gate()
    const productReadAuthors: string[] = []
    let deletionStarts = 0
    let activeReads = 0
    let maxActiveReads = 0
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        activeReads++
        maxActiveReads = Math.max(maxActiveReads, activeReads)
        try {
          if (filter.kinds?.includes(5)) {
            deletionStarts++
            if (deletionStarts === 2) deletionStarted.release()
            await deletionHeld.promise
            return []
          }
          if (!filter.kinds?.includes(30402)) return []
          const author = filter.authors?.[0]
          if (author) productReadAuthors.push(author)
          return [first, second, third].filter(
            (event) =>
              filter.authors?.includes(event.pubkey) &&
              event.tags.some(
                (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1] ?? "")
              )
          )
        } finally {
          activeReads--
        }
      },
    })
    const settled: ProductsByIdsResult[] = []
    const read = getProductsByIds([first, second, third].map(address), {
      onAuthorSettled: (snapshot) => settled.push(snapshot),
    })
    try {
      await deletionStarted.promise
      expect(new Set(productReadAuthors)).toEqual(
        new Set([first.pubkey, second.pubkey])
      )
      expect(productReadAuthors).not.toContain(third.pubkey)
      expect(settled).toHaveLength(0)
    } finally {
      deletionHeld.release()
      await read.catch(() => undefined)
    }
    const final = await read
    expect(final.data).toHaveLength(3)
    expect(productReadAuthors).toHaveLength(3)
    expect(new Set(productReadAuthors).size).toBe(3)
    // Two author pipelines may each overlap their independent `#e` and `#a`
    // deletion checks, but a third author cannot enter the shared coordinator.
    expect(maxActiveReads).toBeLessThanOrEqual(4)
  })

  it("overlaps exact event-id and coordinate deletion checks before settling an author", async () => {
    const product = listing(fastSecret, "parallel-deletion-frontier")
    const releaseDeletionReads = gate()
    const firstDeletionReadStarted = gate()
    let activeDeletionReads = 0
    let maximumDeletionReads = 0
    let deletionReadStarts = 0
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(5)) {
          activeDeletionReads++
          deletionReadStarts++
          maximumDeletionReads = Math.max(
            maximumDeletionReads,
            activeDeletionReads
          )
          if (deletionReadStarts === 1) firstDeletionReadStarted.release()
          try {
            await releaseDeletionReads.promise
            return []
          } finally {
            activeDeletionReads--
          }
        }
        return filter.kinds?.includes(30402) ? [product] : []
      },
    })
    const settled: ProductsByIdsResult[] = []
    const read = getProductsByIds([address(product)], {
      onAuthorSettled: (snapshot) => settled.push(snapshot),
    })
    await firstDeletionReadStarted.promise
    try {
      expect(deletionReadStarts).toBe(2)
      expect(maximumDeletionReads).toBe(2)
      expect(settled).toHaveLength(0)
    } finally {
      releaseDeletionReads.release()
      await read.catch(() => undefined)
    }
    expect((await read).data).toHaveLength(1)
    expect(settled).toHaveLength(1)
  })

  it("waits for an exact variation family before settling a fast author", async () => {
    const parent = listing(fastSecret, "settled-family", [
      ["type", "variable", "physical"],
    ])
    const child = listing(fastSecret, "settled-family-blue", [
      ["type", "variation", "physical"],
      ["a", address(parent)],
      ["spec", "color", "blue"],
    ])
    const slow = listing(slowSecret, "settled-family-sibling")
    const slowHeld = gate()
    const familyHeld = gate()
    const familyStarted = gate()
    const settledStarted = gate()
    const settled: ProductsByIdsResult[] = []
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(5)) return []
        if (!filter.kinds?.includes(30402)) return []
        if (filter.authors?.includes(slow.pubkey)) {
          await slowHeld.promise
          return [slow]
        }
        if (filter["#a"]?.includes(address(parent))) {
          familyStarted.release()
          await familyHeld.promise
          return [child]
        }
        return [parent]
      },
    })
    const read = getProductsByIds([parent, slow].map(address), {
      onAuthorSettled: (snapshot) => {
        settled.push(snapshot)
        settledStarted.release()
      },
    })
    try {
      await familyStarted.promise
      expect(settled).toHaveLength(0)
      familyHeld.release()
      await settledStarted.promise
      const fastSnapshot = settled.at(-1)!
      const family = fastSnapshot.data.find(
        (record) => record.addressId === address(parent)
      )?.family
      expect(family?.state).toBe("ready")
      expect(family?.children.map((record) => record.addressId)).toEqual([
        address(child),
      ])
      expect(
        hasExactLiveProductAvailabilityEvidence(
          fastSnapshot.diagnostics.find(
            (diagnostic) => diagnostic.addressId === address(parent)
          ),
          address(parent)
        )
      ).toBe(true)
    } finally {
      familyHeld.release()
      slowHeld.release()
      await read.catch(() => undefined)
    }
    await read
  })

  it("retracts an earlier product when a later signed network deletion arrives", async () => {
    const fast = listing(fastSecret, "deleted-after-preview")
    const slow = listing(slowSecret, "survivor")
    const { held, fastReturned } = installHeldRead([fast], slow, deletion(fast))
    const snapshots: ProductsByIdsResult[] = []
    const settled: ProductsByIdsResult[] = []
    const read = getProductsByIds([fast, slow].map(address), {
      onProgress: (snapshot) => snapshots.push(snapshot),
      onAuthorSettled: (snapshot) => settled.push(snapshot),
    })
    try {
      await afterFastRead(fastReturned)
      expect(snapshots[0]?.data.map((record) => record.addressId)).toContain(
        address(fast)
      )
      expect(settled).toHaveLength(1)
      expect(
        settled.every(
          (snapshot) =>
            !hasExactLiveProductAvailabilityEvidence(
              snapshot.diagnostics.find(
                (diagnostic) => diagnostic.addressId === address(fast)
              ),
              address(fast)
            )
        )
      ).toBe(true)
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
