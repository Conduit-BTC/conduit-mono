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

describe("exact product cache stage", () => {
  for (const cache of ["empty", "populated", "deleted"] as const) {
    it(`reports the reconciled ${cache} snapshot before held relay discovery`, async () => {
      const candidate = listing(fastSecret, "cache-stage")
      if (cache !== "empty") await cacheSignedProductListingEvent(candidate)
      if (cache === "deleted")
        await cacheSignedProductDeletionEvent(deletion(candidate))
      const held = gate()
      const discoveryEntered = gate()
      let discoveryStarted = false
      let cacheReads = 0
      const snapshots: ProductsByIdsResult[] = []
      const progress: ProductsByIdsResult[] = []
      __setCommerceTestOverrides({
        getCachedProducts: async (_merchant, authors) => {
          cacheReads++
          return products.filter(
            (row) => !authors || authors.includes(row.pubkey)
          )
        },
        fetchEventsFanout: async (filter) =>
          filter.kinds?.includes(30402) ? [candidate] : [],
      })
      __setCommerceTestOverrides({
        getRelayLists: async () => {
          discoveryStarted = true
          discoveryEntered.release()
          await held.promise
          return new Map()
        },
      })
      const read = getProductsByIds([address(candidate)], {
        onCacheReady: (snapshot) => {
          expect(discoveryStarted).toBe(false)
          snapshots.push(snapshot)
        },
        onProgress: (snapshot) => progress.push(snapshot),
      })
      try {
        await discoveryEntered.promise
        expect(snapshots).toHaveLength(1)
        const snapshot = snapshots[0]!
        expect(snapshot.data.map((record) => record.addressId)).toEqual(
          cache === "populated" ? [address(candidate)] : []
        )
        expect(snapshot.diagnostics[0]!.issue).toBe(
          cache === "populated" ? "cached_only" : "pending"
        )
        expect(snapshot.meta).toMatchObject({ stale: true, degraded: true })
        expect(cacheReads).toBe(1)
        expect(progress).toHaveLength(cache === "populated" ? 1 : 0)
        if (cache === "populated") expect(snapshot).toBe(progress[0])
      } finally {
        held.release()
        await read.catch(() => undefined)
      }
      expect(snapshots).toHaveLength(1)
    })
  }

  it("suppresses the cache-stage callback if account authority changes during cache I/O", async () => {
    const candidate = listing(fastSecret, "cancel-cache-stage")
    const held = gate()
    const entered = gate()
    let active = true
    let callbacks = 0
    let relayReads = 0
    __setCommerceTestOverrides({
      getCachedProducts: async () => {
        entered.release()
        await held.promise
        return []
      },
    })
    __setCommerceTestOverrides({
      getRelayLists: async () => {
        relayReads++
        return new Map()
      },
    })
    const read = getProductsByIds([address(candidate)], {
      shouldContinue: () => active,
      onCacheReady: () => {
        callbacks++
      },
      onProgress: () => {
        callbacks++
      },
    })
    await entered.promise
    active = false
    held.release()
    await expect(read).rejects.toThrow("authority_changed")
    expect(callbacks).toBe(0)
    expect(relayReads).toBe(0)
  })

  it("preserves a cache-read rejection without signaling successful cache readiness", async () => {
    const candidate = listing(fastSecret, "failed-cache-stage")
    let callbacks = 0
    let relayReads = 0
    __setCommerceTestOverrides({
      getCachedProducts: async () => {
        throw new Error("Storage unavailable")
      },
    })
    __setCommerceTestOverrides({
      getRelayLists: async () => {
        relayReads++
        return new Map()
      },
    })
    await expect(
      getProductsByIds([address(candidate)], {
        onCacheReady: () => {
          callbacks++
        },
        onProgress: () => {
          callbacks++
        },
      })
    ).rejects.toThrow("Storage unavailable")
    expect(callbacks).toBe(0)
    expect(relayReads).toBe(0)
  })

  for (const ids of [[], ["invalid-product-reference"]]) {
    it(`signals the existing empty result for ${ids.length ? "invalid" : "empty"} targets`, async () => {
      const snapshots: ProductsByIdsResult[] = []
      const progress: ProductsByIdsResult[] = []
      const result = await getProductsByIds(ids, {
        onCacheReady: (snapshot) => snapshots.push(snapshot),
        onProgress: (snapshot) => progress.push(snapshot),
      })
      expect(snapshots).toEqual([result])
      expect(progress).toEqual([result])
      expect(result.data).toEqual([])
      snapshots.length = 0
      progress.length = 0
      await getProductsByIds(ids, {
        shouldContinue: () => false,
        onCacheReady: (snapshot) => snapshots.push(snapshot),
        onProgress: (snapshot) => progress.push(snapshot),
      })
      expect(snapshots).toEqual([])
      expect(progress).toEqual([])
    })
  }
})

describe("progressive exact product reads", () => {
  for (const phase of ["write", "read"] as const) {
    it(`finishes another author and starts queued work while one cache ${phase} is held`, async () => {
      const records = [
        listing(fastSecret, "held-cache"),
        listing(slowSecret, "independent-cache"),
        listing(generateSecretKey(), "queued-cache"),
      ]
      const held = gate()
      const entered = gate()
      const independentFinished = gate()
      const queuedStarted = gate()
      let armedRead = false
      let heldOnce = false
      __setCommerceTestOverrides({
        getCachedProducts: async (merchant, authors) => {
          if (phase === "read" && armedRead && authors && !heldOnce) {
            heldOnce = true
            entered.release()
            await held.promise
          }
          return products.filter(
            (row) =>
              (!merchant || row.pubkey === merchant) &&
              (!authors || authors.includes(row.pubkey))
          )
        },
        putCachedProducts: async (rows) => {
          if (rows.some((row) => row.pubkey === records[0]!.pubkey)) {
            if (phase === "write" && !heldOnce) {
              heldOnce = true
              entered.release()
              await held.promise
            }
            armedRead = true
          }
          for (const row of rows)
            products = [
              ...products.filter((current) => current.id !== row.id),
              row,
            ]
        },
        fetchEventsFanout: async (filter) => {
          if (!filter.kinds?.includes(30402)) return []
          const index = records.findIndex((record) =>
            filter.authors?.includes(record.pubkey)
          )
          if (index === 1) await entered.promise
          if (index === 2) queuedStarted.release()
          return index < 0 ? [] : [records[index]!]
        },
      })
      const snapshots: ProductsByIdsResult[] = []
      const read = getProductsByIds(records.map(address), {
        onProgress: (snapshot) => {
          snapshots.push(snapshot)
          if (
            snapshot.diagnostics.find(
              (row) => row.addressId === address(records[1]!)
            )?.issue === null
          )
            independentFinished.release()
        },
      })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await entered.promise
        const completed = await Promise.race([
          Promise.all([
            independentFinished.promise,
            queuedStarted.promise,
          ]).then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), 500)
          }),
        ])
        expect(completed).toBe(true)
        expect(
          snapshots
            .at(-1)!
            .diagnostics.find((row) => row.addressId === address(records[0]!))
            ?.issue
        ).not.toBeNull()
      } finally {
        clearTimeout(timeout)
        held.release()
        await read.catch(() => undefined)
      }
      expect((await read).diagnostics.every((row) => row.issue === null)).toBe(
        true
      )
      expect(snapshots.at(-1)).toEqual(await read)
    })
  }

  it("retains live-only family identities when an older concurrent cache read settles", async () => {
    const first = listing(fastSecret, "stale-cache-read")
    const parent = listing(slowSecret, "concurrent-family", [
      ["type", "variable", "physical"],
    ])
    const child = listing(slowSecret, "concurrent-child", [
      ["type", "variation", "physical"],
      ["a", address(parent)],
      ["spec", "size", "small"],
    ])
    const remaining = listing(slowSecret, "concurrent-remaining", [
      ["type", "variation", "physical"],
      ["a", address(parent)],
      ["spec", "size", "large"],
    ])
    const reparented = listing(
      slowSecret,
      "concurrent-child",
      [
        ["type", "variation", "physical"],
        ["a", `30402:${parent.pubkey}:other-family`],
        ["spec", "size", "small"],
      ],
      150
    )
    const queued = listing(generateSecretKey(), "after-overlap")
    const cacheHeld = gate()
    const cacheEntered = gate()
    const familyFinished = gate()
    const firstFinished = gate()
    const queuedHeld = gate()
    let armFirstRead = false
    let heldOnce = false
    let failFamilyWrites = true
    __setCommerceTestOverrides({
      getCachedProducts: async (_merchant, authors) => {
        const captured = products.filter(
          (row) => !authors || authors.includes(row.pubkey)
        )
        if (armFirstRead && authors && !heldOnce) {
          heldOnce = true
          cacheEntered.release()
          await cacheHeld.promise
        }
        return captured
      },
      putCachedProducts: async (rows) => {
        if (
          failFamilyWrites &&
          rows.some((row) => row.pubkey === parent.pubkey)
        )
          throw new Error("Storage unavailable")
        for (const row of rows)
          products = [
            ...products.filter((current) => current.id !== row.id),
            row,
          ]
        if (rows.some((row) => row.pubkey === first.pubkey)) armFirstRead = true
      },
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        if (filter.authors?.includes(parent.pubkey)) {
          await cacheEntered.promise
          return [parent, child, remaining]
        }
        if (filter.authors?.includes(queued.pubkey)) {
          await queuedHeld.promise
          return [queued]
        }
        return [first]
      },
    })
    const snapshots: ProductsByIdsResult[] = []
    const read = getProductsByIds([first, parent, queued].map(address), {
      onProgress: (snapshot) => {
        snapshots.push(snapshot)
        if (
          snapshot.diagnostics.find((row) => row.addressId === address(parent))
            ?.issue === null
        )
          familyFinished.release()
        if (
          snapshot.diagnostics.find((row) => row.addressId === address(first))
            ?.issue === null
        )
          firstFinished.release()
      },
    })
    try {
      await familyFinished.promise
      expect(products.some((row) => row.id === address(child))).toBe(false)
      cacheHeld.release()
      await firstFinished.promise
      failFamilyWrites = false
      await cacheSignedProductListingEvent(reparented)
    } finally {
      cacheHeld.release()
      queuedHeld.release()
      await read.catch(() => undefined)
    }
    const family = (await read).data.find(
      (record) => record.addressId === address(parent)
    )!.family!
    expect(family.children.map((record) => record.addressId)).toEqual([
      address(remaining),
    ])
    expect(snapshots.at(-1)).toEqual(await read)
  })

  it("distinguishes cached and uncached coordinates of the same queued author", async () => {
    const queuedSecret = generateSecretKey()
    const cached = listing(queuedSecret, "queued-cached")
    const uncached = listing(queuedSecret, "queued-uncached")
    const filtered = listing(queuedSecret, "queued-hidden", [
      ["visibility", "private"],
    ])
    await cacheSignedProductListingEvent(cached)
    await cacheSignedProductListingEvent(filtered)
    const blockers = [
      listing(fastSecret, "blocker-a"),
      listing(slowSecret, "blocker-b"),
    ]
    const held = gate()
    const bothStarted = gate()
    let started = 0
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        if (
          blockers.some((record) => filter.authors?.includes(record.pubkey))
        ) {
          if (++started === 2) bothStarted.release()
          await held.promise
        }
        return [...blockers, cached, uncached, filtered].filter((record) =>
          filter.authors?.includes(record.pubkey)
        )
      },
    })
    const snapshots: ProductsByIdsResult[] = []
    const read = getProductsByIds(
      [...blockers, cached, uncached, filtered].map(address),
      {
        onProgress: (snapshot) => snapshots.push(snapshot),
      }
    )
    try {
      await bothStarted.promise
      const snapshot = snapshots.at(-1)!
      expect(
        snapshot.diagnostics.find((row) => row.addressId === address(cached))
          ?.issue
      ).toBe("cached_only")
      expect(
        snapshot.diagnostics.find((row) => row.addressId === address(uncached))
          ?.issue
      ).toBe("pending")
      expect(
        snapshot.diagnostics.find((row) => row.addressId === address(filtered))
          ?.issue
      ).toBe("pending")
      expect(snapshot.data.map((row) => row.addressId)).toEqual([
        address(cached),
      ])
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    expect(
      (await read).diagnostics.find(
        (row) => row.addressId === address(filtered)
      )?.issue
    ).toBe("listing_filtered")
  })

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
      expect(snapshots).toHaveLength(2)
      expect(
        snapshots[0]!.data.map((record) => record.addressId).sort()
      ).toEqual(fast.map(address).sort())
      expect(snapshots[0]!.meta).toMatchObject({ stale: true, degraded: true })
      expect(snapshots[0]!.diagnostics.every((row) => row.issue !== null)).toBe(
        true
      )
      expect(
        snapshots[1]!.diagnostics
          .filter((row) => fast.map(address).includes(row.addressId!))
          .every(
            (row) => row.issue === null && row.coverage?.listing === "complete"
          )
      ).toBe(true)
      expect(
        snapshots[1]!.diagnostics.find((row) => row.addressId === address(slow))
          ?.issue
      ).toBe("pending")
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

  it("runs at most two complete author pipelines and publishes each before queued authors", async () => {
    const listings = Array.from({ length: 5 }, (_, index) =>
      listing(generateSecretKey(), `merchant-${index}`)
    )
    const held = listings.map(() => gate())
    const started = listings.map(() => gate())
    const finished = listings.map(() => gate())
    const activeAuthors = new Set<string>()
    const completedAuthors = new Set<string>()
    let maximumAuthors = 0
    let sharedCacheReads = 0
    const snapshots: ProductsByIdsResult[] = []
    __setCommerceTestOverrides({
      getCachedProducts: async (_merchant, authors) => {
        if (authors?.length === listings.length) sharedCacheReads++
        return products.filter(
          (row) => !authors || authors.includes(row.pubkey)
        )
      },
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        const index = listings.findIndex((record) =>
          filter.authors?.includes(record.pubkey)
        )
        if (index < 0) return []
        activeAuthors.add(listings[index]!.pubkey)
        maximumAuthors = Math.max(maximumAuthors, activeAuthors.size)
        started[index]!.release()
        await held[index]!.promise
        return [listings[index]!]
      },
    })
    const read = getProductsByIds(listings.map(address), {
      onProgress: (snapshot) => {
        snapshots.push(snapshot)
        for (const [index, record] of listings.entries()) {
          if (
            snapshot.diagnostics.find(
              (row) => row.addressId === address(record)
            )?.issue !== null
          )
            continue
          if (!completedAuthors.has(record.pubkey)) {
            completedAuthors.add(record.pubkey)
            activeAuthors.delete(record.pubkey)
            finished[index]!.release()
          }
        }
      },
    })
    try {
      await Promise.all([started[0]!.promise, started[1]!.promise])
      expect(activeAuthors.size).toBe(2)
      expect(sharedCacheReads).toBe(1)
      held[0]!.release()
      await Promise.all([finished[0]!.promise, started[2]!.promise])
      expect(completedAuthors.has(listings[1]!.pubkey)).toBe(false)
      expect(snapshots.at(-1)!.diagnostics[0]!.issue).toBeNull()
      expect(snapshots.at(-1)!.diagnostics[4]!.issue).toBe("pending")
      for (const index of [2, 3, 4]) {
        await started[index]!.promise
        held[index]!.release()
        await finished[index]!.promise
      }
      expect(completedAuthors.size).toBe(4)
      expect(maximumAuthors).toBe(2)
    } finally {
      held.forEach((entry) => entry.release())
      await read.catch(() => undefined)
    }
    const final = await read
    expect(final.data).toHaveLength(5)
    expect(final.diagnostics.every((row) => row.issue === null)).toBe(true)
    expect(snapshots.at(-1)).toEqual(final)
    // One shared initial load, then one reconciliation per direct snapshot and
    // per completed author. No app pre-scan or recursive author preparation.
    expect(sharedCacheReads).toBe(11)
  })

  it("loads exact cached targets without materializing unrelated merchant catalogs", async () => {
    const records = Array.from({ length: 8 }, (_, index) =>
      listing(generateSecretKey(), `target-${index}`)
    )
    for (const record of records) await cacheSignedProductListingEvent(record)
    const original = [...products]
    products.push(
      ...original.flatMap((row) =>
        Array.from({ length: 500 }, (_, index) => ({
          ...row,
          id: `30402:${row.pubkey}:unrelated-${index}`,
          dTag: `unrelated-${index}`,
          title: `Unrelated ${index}`,
        }))
      )
    )
    let selectedReads = 0
    let selectedRows = 0
    __setCommerceTestOverrides({
      getCachedProducts: async (_merchant, authors, selection) => {
        const rows = products.filter(
          (row) =>
            (!authors || authors.includes(row.pubkey)) &&
            (!selection ||
              selection.ids?.includes(row.id) ||
              (!!row.parentProductId &&
                selection.parentIds?.includes(row.parentProductId)))
        )
        if (authors) {
          expect(selection?.ids?.length).toBe(8)
          selectedReads++
          selectedRows += rows.length
        }
        return rows
      },
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(30402)
          ? records.filter((record) => filter.authors?.includes(record.pubkey))
          : [],
    })
    const snapshots: ProductsByIdsResult[] = []
    const result = await getProductsByIds(records.map(address), {
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    expect(result.data).toHaveLength(8)
    expect(result.diagnostics.every((row) => row.issue === null)).toBe(true)
    expect(snapshots.at(-1)).toEqual(result)
    expect(selectedReads).toBe(17)
    expect(selectedRows).toBe(136)
  })

  it("retains an exact cached child with family context while its author is queued", async () => {
    const held = gate()
    const firstTwoStarted = gate()
    const parentDraft = listing(fastSecret, "queued-parent", [
      ["type", "variable", "physical"],
      ["visibility", "private"],
    ])
    const parent = new NDKEvent(
      undefined,
      finalizeEvent(
        {
          ...parentDraft.rawEvent(),
          tags: parentDraft.tags.filter((tag) => tag[0] !== "image"),
        },
        fastSecret
      )
    )
    const child = listing(fastSecret, "queued-child", [
      ["type", "variation", "physical"],
      ["a", address(parent)],
      ["spec", "size", "small"],
      ["visibility", "private"],
    ])
    await cacheSignedProductListingEvent(parent)
    await cacheSignedProductListingEvent(child)
    const other = [
      listing(generateSecretKey(), "first"),
      listing(generateSecretKey(), "second"),
    ]
    let starts = 0
    const snapshots: ProductsByIdsResult[] = []
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        if (filter.authors?.includes(parent.pubkey)) return [parent, child]
        starts++
        if (starts === 2) firstTwoStarted.release()
        await held.promise
        return other.filter((record) => filter.authors?.includes(record.pubkey))
      },
    })
    const read = getProductsByIds([...other.map(address), address(child)], {
      includeMerchantHiddenProductIds: [address(child)],
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    try {
      await firstTwoStarted.promise
      expect(starts).toBe(2)
      const cached = snapshots[0]!
      expect(cached).toBeDefined()
      expect(cached.data.map((record) => record.addressId)).toEqual([
        address(child),
      ])
      expect(
        cached.diagnostics.find((row) => row.addressId === address(child))
          ?.issue
      ).toBe("cached_only")
      expect(
        cached.diagnostics.some((row) => row.addressId === address(parent))
      ).toBe(false)
      expect(cached.data[0]!.safety.state).not.toBe("blocked")
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    const final = await read
    expect(
      final.diagnostics.find((row) => row.addressId === address(child))?.issue
    ).toBeNull()
  })

  it("does not complete an author before its deletion read settles", async () => {
    const product = listing(fastSecret, "held-deletion")
    const deletionHeld = gate()
    const deletionStarted = gate()
    const snapshots: ProductsByIdsResult[] = []
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(30402)) return [product]
        if (filter.kinds?.includes(5)) {
          deletionStarted.release()
          await deletionHeld.promise
        }
        return []
      },
    })
    const read = getProductsByIds([address(product)], {
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    try {
      await deletionStarted.promise
      expect(snapshots.at(-1)!.diagnostics[0]!.issue).toBe("lookup_partial")
    } finally {
      deletionHeld.release()
      await read.catch(() => undefined)
    }
    expect((await read).diagnostics[0]!.issue).toBeNull()
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
    let deletionIndex: number
    try {
      await afterFastRead(fastReturned)
      expect(snapshots[0]?.data.map((record) => record.addressId)).toContain(
        address(fast)
      )
      deletionIndex = snapshots.length
      await cacheSignedProductDeletionEvent(deletion(fast))
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    await read
    expect(
      snapshots
        .slice(deletionIndex)
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
      expect(snapshots).toHaveLength(2)
      active = false
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    await expect(read).rejects.toThrow()
    expect(snapshots).toHaveLength(2)
  })

  it("does not start queued authors after cancellation", async () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      listing(generateSecretKey(), `cancel-${index}`)
    )
    const held = gate()
    const started = gate()
    const snapshots: ProductsByIdsResult[] = []
    let starts = 0
    let active = true
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        starts++
        if (starts === 2) started.release()
        await held.promise
        return records.filter((record) =>
          filter.authors?.includes(record.pubkey)
        )
      },
    })
    const read = getProductsByIds(records.map(address), {
      shouldContinue: () => active,
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    try {
      await started.promise
      active = false
    } finally {
      held.release()
      await read.catch(() => undefined)
    }
    await expect(read).rejects.toThrow()
    expect(starts).toBe(2)
    expect(snapshots).toHaveLength(0)
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

  for (const observe of [false, true]) {
    for (const topology of ["missing child", "simple to variable"] as const) {
      it(`keeps cached family context for ${topology} when live cache writes fail (${observe ? "progressive" : "bulk"})`, async () => {
        const parent = listing(
          fastSecret,
          "write-failure-parent",
          [["type", "variable", "physical"]],
          150
        )
        const child = listing(
          fastSecret,
          "write-failure-child",
          [
            ["type", "variation", "physical"],
            ["a", address(parent)],
            ["spec", "size", "small"],
          ],
          150
        )
        const sibling = listing(fastSecret, "cached-sibling", [
          ["type", "variation", "physical"],
          ["a", address(parent)],
          ["spec", "size", "large"],
        ])
        if (topology === "missing child")
          await cacheSignedProductListingEvent(parent)
        else
          await cacheSignedProductListingEvent(
            listing(fastSecret, "write-failure-parent")
          )
        await cacheSignedProductListingEvent(sibling)
        __setCommerceTestOverrides({
          putCachedProducts: async () => {
            throw new Error("Storage unavailable")
          },
          fetchEventsFanout: async (filter) => {
            if (!filter.kinds?.includes(30402)) return []
            // Family transport is unavailable: retained sibling context must
            // survive the direct target's new topology and failed persistence.
            if (
              filter["#a"] ||
              (topology === "missing child" &&
                filter["#d"]?.includes("write-failure-parent"))
            )
              return []
            return topology === "missing child" ? [child] : [parent]
          },
        })
        const target = topology === "missing child" ? child : parent
        const snapshots: ProductsByIdsResult[] = []
        const result = await getProductsByIds([address(target)], {
          onProgress: observe
            ? (snapshot) => snapshots.push(snapshot)
            : undefined,
        })
        expect(result.data).toHaveLength(1)
        expect(result.data[0]!.addressId).toBe(address(target))
        if (topology === "simple to variable")
          expect(
            result.data[0]!.family!.children.map((record) => record.addressId)
          ).toEqual([address(sibling)])
        expect(result.meta.degraded).toBe(true)
        if (observe) expect(snapshots.at(-1)).toEqual(result)
      })
    }
  }

  for (const persisted of [true, false]) {
    for (const change of ["reparent", "simple"] as const) {
      it(`rereads a ${persisted ? "cached" : "live-only"} sibling after its ${change} revision leaves a completed family`, async () => {
        const parent = listing(fastSecret, "changing-family", [
          ["type", "variable", "physical"],
        ])
        const child = listing(fastSecret, "moving-child", [
          ["type", "variation", "physical"],
          ["a", address(parent)],
          ["spec", "size", "small"],
        ])
        const remaining = listing(fastSecret, "remaining-child", [
          ["type", "variation", "physical"],
          ["a", address(parent)],
          ["spec", "size", "large"],
        ])
        const reparented =
          change === "simple"
            ? listing(fastSecret, "moving-child", [], 150)
            : listing(
                fastSecret,
                "moving-child",
                [
                  ["type", "variation", "physical"],
                  ["a", `30402:${parent.pubkey}:different-family`],
                  ["spec", "size", "small"],
                ],
                150
              )
        for (const record of persisted
          ? [parent, child, remaining]
          : [parent, remaining])
          await cacheSignedProductListingEvent(record)
        if (!persisted) {
          __setCommerceTestOverrides({
            putCachedProducts: async () => {
              throw new Error("Storage unavailable")
            },
          })
        }
        const slow = listing(slowSecret, "held-after-family")
        const { held, fastReturned } = installHeldRead(
          [parent, child, remaining],
          slow
        )
        const snapshots: ProductsByIdsResult[] = []
        const read = getProductsByIds([parent, slow].map(address), {
          onProgress: (snapshot) => snapshots.push(snapshot),
        })
        try {
          await afterFastRead(fastReturned)
          expect(
            snapshots
              .at(-1)!
              .data.find((record) => record.addressId === address(parent))!
              .family!.children.some(
                (record) => record.addressId === address(child)
              )
          ).toBe(true)
          // The live child has never been persisted in this case. Its identity
          // must survive the failed write so a later unrelated author publication
          // can still select a revision that no longer belongs to this family.
          if (!persisted) {
            expect(products.some((row) => row.id === address(child))).toBe(
              false
            )
            __setCommerceTestOverrides({
              putCachedProducts: async (rows) => {
                for (const row of rows)
                  products = [
                    ...products.filter((current) => current.id !== row.id),
                    row,
                  ]
              },
            })
          }
          await cacheSignedProductListingEvent(reparented)
        } finally {
          held.release()
          await read.catch(() => undefined)
        }
        const family = (await read).data.find(
          (record) => record.addressId === address(parent)
        )!.family!
        expect(family.children.map((record) => record.addressId)).toEqual([
          address(remaining),
        ])
        expect(snapshots.at(-1)).toEqual(await read)
      })
    }
  }

  for (const change of ["simple-to-variable", "reparent"] as const) {
    it(`retains a completed author's late ${change} family without another relay read`, async () => {
      const oldParent = listing(fastSecret, "old-parent", [
        ["type", "variable", "physical"],
      ])
      const newParent = listing(
        fastSecret,
        "new-parent",
        [["type", "variable", "physical"]],
        150
      )
      const old =
        change === "simple-to-variable"
          ? listing(fastSecret, "changing-target")
          : listing(fastSecret, "changing-target", [
              ["type", "variation", "physical"],
              ["a", address(oldParent)],
              ["spec", "size", "small"],
            ])
      const newer = listing(
        fastSecret,
        "changing-target",
        change === "simple-to-variable"
          ? [["type", "variable", "physical"]]
          : [
              ["type", "variation", "physical"],
              ["a", address(newParent)],
              ["spec", "size", "small"],
            ],
        150
      )
      const child = listing(
        fastSecret,
        "new-child",
        [
          ["type", "variation", "physical"],
          ["a", address(newer)],
          ["spec", "size", "large"],
        ],
        150
      )
      const slow = listing(slowSecret, "held-after-topology-change")
      const { held, filters } = installHeldRead(
        change === "simple-to-variable" ? [old] : [oldParent, old],
        slow
      )
      const completed = gate()
      const snapshots: ProductsByIdsResult[] = []
      const read = getProductsByIds([old, slow].map(address), {
        onProgress: (snapshot) => {
          snapshots.push(snapshot)
          if (
            hasExactLiveProductAvailabilityEvidence(
              snapshot.diagnostics.find(
                (row) => row.addressId === address(old)
              ),
              address(old)
            )
          )
            completed.release()
        },
      })
      let readsBeforeRevision: number
      try {
        // Positive exact evidence is published only after this author completes.
        await completed.promise
        expect(
          filters.some((filter) => filter.authors?.includes(slow.pubkey))
        ).toBe(true)
        readsBeforeRevision = filters.length
        for (const event of change === "simple-to-variable"
          ? [newer, child]
          : [newParent, newer]) {
          await cacheSignedProductListingEvent(event)
        }
        const cached = await getCachedProductsByIds([address(old)])
        expect(
          cached.data
            .flatMap((record) => [record, ...(record.family?.children ?? [])])
            .find((record) => record.addressId === address(old))?.eventId
        ).toBe(newer.id)
      } finally {
        held.release()
        await read.catch(() => undefined)
      }
      const final = await read
      const selected = final.data.find(
        (record) => record.addressId === address(old)
      )!
      const diagnostic = final.diagnostics.find(
        (row) => row.addressId === address(old)
      )!
      expect(selected?.eventId).toBe(newer.id)
      expect(diagnostic.issue).toBe("cached_only")
      expect(
        hasExactLiveProductAvailabilityEvidence(diagnostic, address(old))
      ).toBe(false)
      expect(final.meta).toMatchObject({
        source: "local_cache",
        stale: true,
        degraded: true,
      })
      if (change === "simple-to-variable") {
        expect(
          selected.family?.children.map((record) => record.addressId)
        ).toEqual([address(child)])
      } else {
        expect(selected.product.parentProductId).toBe(address(newParent))
        expect(
          selected.exactReadContext?.records.map((record) => record.addressId)
        ).toContain(address(newParent))
        expect(
          selected.exactReadContext?.records.map((record) => record.addressId)
        ).not.toContain(address(oldParent))
      }
      expect(
        final.data.find((record) => record.addressId === address(slow))?.eventId
      ).toBe(slow.id)
      expect(filters).toHaveLength(readsBeforeRevision)
      expect(snapshots.at(-1)).toEqual(final)
    })
  }

  it("keeps the completed result identical with and without observation", async () => {
    const records = [
      listing(fastSecret, "unchanged-final"),
      listing(slowSecret, "unchanged-other"),
    ]
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(30402)
          ? records.filter((record) => filter.authors?.includes(record.pubkey))
          : [],
    })
    const unobserved = await getProductsByIds(records.map(address))
    const snapshots: ProductsByIdsResult[] = []
    const observed = await getProductsByIds(records.map(address), {
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
