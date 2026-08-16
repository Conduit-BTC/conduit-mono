import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { finalizeEvent } from "nostr-tools/pure"

import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  EVENT_KINDS,
  getMarketplaceProductsProgressive,
  type CachedProduct,
  type CachedProductTombstone,
  type CommerceProductRecord,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"

const FIXED_NOW = 1_700_000_000_000
const AUTHOR_COUNT = 17

function sourceRelayUrl(index: number): string {
  return `wss://product-deletion-source-${index}.conduit.market`
}

let cachedProducts: CachedProduct[] = []
let cachedTombstones: CachedProductTombstone[] = []

function makeProduct(secretKey: Uint8Array, index: number): NDKEvent {
  const dTag = `source-only-${index}`
  const event = new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 100 + index,
        content: `Source-only product ${index}`,
        tags: [
          ["d", dTag],
          ["title", `Source-only product ${index}`],
          ["price", "25", "USD"],
          ["type", "simple", "physical"],
          ["image", `https://cdn.conduit.market/source-only-${index}.png`],
          ["t", "source-read"],
        ],
      },
      secretKey
    )
  )
  attachEventSourceRelayUrl(event, sourceRelayUrl(index))
  return event
}

describe("product deletion reads retain source-relay provenance", () => {
  beforeEach(() => {
    __resetCommerceTestOverrides()
    __resetRelayListTestOverrides()
    cachedProducts = []
    cachedTombstones = []
  })

  afterEach(() => {
    __resetCommerceTestOverrides()
    __resetRelayListTestOverrides()
    cachedProducts = []
    cachedTombstones = []
  })

  it("suppresses the final progressive product when its tombstone exists only on an expanded source relay", async () => {
    const secretKeys = Array.from({ length: AUTHOR_COUNT }, (_, index) =>
      new Uint8Array(32).fill(index + 1)
    )
    const products = secretKeys.map(makeProduct)
    const targetIndex = products.length - 1
    const target = products[targetIndex]!
    const targetSourceRelayUrl = sourceRelayUrl(targetIndex)
    const stalePrivateSourceRelayUrl = "wss://127.0.0.1:7447"
    attachEventSourceRelayUrl(target, stalePrivateSourceRelayUrl)
    const targetAddress = `${EVENT_KINDS.PRODUCT}:${target.pubkey}:source-only-${targetIndex}`
    const deletion = new NDKEvent(
      undefined,
      finalizeEvent(
        {
          kind: EVENT_KINDS.DELETION,
          created_at: 500,
          content: "",
          tags: [
            ["e", target.id],
            ["a", targetAddress],
          ],
        },
        secretKeys[targetIndex]
      )
    )
    attachEventSourceRelayUrl(deletion, targetSourceRelayUrl)

    const authorPubkeys = products.map((product) => product.pubkey)
    const deletionRelayAttempts: string[][] = []
    const snapshots: CommerceProductRecord[][] = []

    __setRelayListTestOverrides({
      loadCached: async (pubkey) => ({
        pubkey,
        readRelayUrls: [],
        writeRelayUrls: [],
        eventCreatedAt: 1,
        cachedAt: FIXED_NOW,
      }),
    })
    __setCommerceTestOverrides({
      now: () => FIXED_NOW,
      getCachedProducts: async (merchantPubkey, scopedAuthors) =>
        cachedProducts.filter(
          (row) =>
            (!merchantPubkey || row.pubkey === merchantPubkey) &&
            (!scopedAuthors || scopedAuthors.includes(row.pubkey))
        ),
      putCachedProducts: async (rows) => {
        for (const row of rows) {
          cachedProducts = [
            ...cachedProducts.filter((existing) => existing.id !== row.id),
            row,
          ]
        }
      },
      getCachedProductTombstones: async (merchantPubkey, scopedAuthors) =>
        cachedTombstones.filter(
          (row) =>
            (!merchantPubkey || row.pubkey === merchantPubkey) &&
            (!scopedAuthors || scopedAuthors.includes(row.pubkey))
        ),
      putCachedProductTombstones: async (rows) => {
        for (const row of rows) {
          cachedTombstones = [
            ...cachedTombstones.filter((existing) => existing.id !== row.id),
            row,
          ]
        }
      },
      fetchEventsFanoutProgressive: async (filter, options, onProgress) => {
        const events = products.filter(
          (product) =>
            !filter.authors || filter.authors.includes(product.pubkey)
        )
        __setCommerceTestOverrides({
          fetchEventsFanout: async (deletionFilter, deletionOptions) => {
            if (!deletionFilter.kinds?.includes(EVENT_KINDS.DELETION)) {
              return []
            }
            const relayUrls = deletionOptions?.relayUrls ?? []
            deletionRelayAttempts.push([...relayUrls])
            return relayUrls.includes(targetSourceRelayUrl) ? [deletion] : []
          },
        })
        await onProgress({
          relayUrl: options.relayUrls?.[0] || "none",
          events,
          mergedEvents: events,
        })
        return events
      },
    })

    const result = await getMarketplaceProductsProgressive(
      {
        authorPubkeys,
        limit: 50,
        readPolicy: {
          maxRelays: 8,
          connectTimeoutMs: 10,
          fetchTimeoutMs: 10,
        },
      },
      (progress) => snapshots.push(progress.data)
    )

    expect(
      snapshots.some((snapshot) =>
        snapshot.some((record) => record.eventId === target.id)
      )
    ).toBe(true)
    expect(
      deletionRelayAttempts.some((relayUrls) =>
        relayUrls.includes(targetSourceRelayUrl)
      )
    ).toBe(true)
    expect(
      deletionRelayAttempts.every(
        (relayUrls) => !relayUrls.includes(stalePrivateSourceRelayUrl)
      )
    ).toBe(true)
    expect(
      deletionRelayAttempts.some((relayUrls) =>
        relayUrls.includes("wss://relay.conduit.market")
      )
    ).toBe(true)
    expect(
      deletionRelayAttempts.every((relayUrls) => relayUrls.length <= 8)
    ).toBe(true)
    expect(
      cachedTombstones.map(({ id, eventId, addressId }) => ({
        id,
        eventId,
        addressId,
      }))
    ).toEqual([
      {
        id: `e:${target.pubkey}:${target.id}`,
        eventId: target.id,
        addressId: undefined,
      },
      {
        id: `a:${targetAddress}`,
        eventId: undefined,
        addressId: targetAddress,
      },
    ])
    expect(result.data).toHaveLength(AUTHOR_COUNT - 1)
    expect(result.data.some((record) => record.eventId === target.id)).toBe(
      false
    )
    expect(
      snapshots.at(-1)?.some((record) => record.eventId === target.id)
    ).toBe(false)
    for (const tombstone of cachedTombstones) {
      expect(tombstone.signedEvent).toEqual(deletion.rawEvent())
      expect(tombstone.sourceRelayUrls).toEqual([targetSourceRelayUrl])
      expect(tombstone.observedLocally).toBe(false)
    }
  })
})
