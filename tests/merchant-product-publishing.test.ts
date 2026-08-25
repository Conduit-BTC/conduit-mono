import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  __resetCommerceTestOverrides,
  __resetRelayPublishTestOverrides,
  __setCommerceTestOverrides,
  __setRelayPublishTestOverrides,
  buildProductListingEventDraft,
  cacheSignedProductListingEvent,
  CANONICAL_APP_BACKPLANE_RELAYS,
  CANONICAL_COMMERCE_DISCOVERY_RELAYS,
  EVENT_KINDS,
  planProductDeletionRelays,
  type ProductSchema,
} from "@conduit/core"
import type { CachedProduct } from "@conduit/core/db"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  deliverSignedProductEvent,
  deliverSignedProductEventBundle,
  isDeliverableMerchantProductEvent,
} from "../apps/merchant/src/lib/product-publishing"
import { __resetNdkTestState } from "../packages/core/src/protocol/ndk"

const MERCHANT_SECRET = new Uint8Array(32).fill(4)
const OTHER_MERCHANT_SECRET = new Uint8Array(32).fill(5)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const NOW = 1_700_000_100_000

let cachedProducts: CachedProduct[] = []

function makeSignedEvent(kind: number) {
  return finalizeEvent(
    {
      kind,
      created_at: 1_700_000_100,
      content: kind === EVENT_KINDS.DELETION ? "Listing removed" : "Listing",
      tags:
        kind === EVENT_KINDS.DELETION
          ? [["a", `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:listing`]]
          : [["d", "listing"]],
    },
    MERCHANT_SECRET
  )
}

function makeSignedProductEvent(input: {
  dTag: string
  acceptedRelayUrl: string
}): NDKEvent {
  const product: ProductSchema = {
    id: `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:${input.dTag}`,
    pubkey: MERCHANT_PUBKEY,
    title: `Listing ${input.dTag}`,
    summary: "Fallback provenance regression listing.",
    price: 10,
    currency: "USD",
    type: "simple",
    specifications: [],
    format: "physical",
    visibility: "public",
    images: [{ url: "https://example.com/product.png" }],
    tags: ["test"],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: NOW,
    updatedAt: NOW,
  }
  const draft = buildProductListingEventDraft({
    product,
    dTag: input.dTag,
    clientAppId: "merchant",
  })
  const event = new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: draft.kind,
        created_at: Math.floor(NOW / 1000),
        content: draft.content,
        tags: draft.tags,
      },
      MERCHANT_SECRET
    )
  )
  event.publish = (async (relaySet: unknown) => {
    const attemptedRelayUrls = [
      ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ?? []),
    ]
    expect(attemptedRelayUrls).toContain(`${input.acceptedRelayUrl}/`)
    return new Set([{ url: `${input.acceptedRelayUrl}/` }])
  }) as never
  return event
}

beforeEach(() => {
  cachedProducts = []
  __resetCommerceTestOverrides()
  __resetRelayPublishTestOverrides()
  __resetNdkTestState()
  __setCommerceTestOverrides({
    now: () => NOW,
    getCachedProducts: async () => cachedProducts,
    putCachedProducts: async (rows) => {
      for (const row of rows) {
        cachedProducts = [
          ...cachedProducts.filter((existing) => existing.id !== row.id),
          row,
        ]
      }
    },
  })
  __setRelayPublishTestOverrides({
    planPublishRelays: async () => ({
      intent: "author_event",
      primaryRelayUrls: [],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    }),
  })
})

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayPublishTestOverrides()
  __resetNdkTestState()
})

describe("merchant product event delivery", () => {
  it("accepts signed product listings and NIP-09 deletion events", () => {
    expect(
      isDeliverableMerchantProductEvent(
        makeSignedEvent(EVENT_KINDS.PRODUCT),
        MERCHANT_PUBKEY
      )
    ).toBe(true)
    expect(
      isDeliverableMerchantProductEvent(
        makeSignedEvent(EVENT_KINDS.DELETION),
        MERCHANT_PUBKEY
      )
    ).toBe(true)
  })

  it("rejects unsupported kinds and a different merchant identity", () => {
    expect(
      isDeliverableMerchantProductEvent(makeSignedEvent(1), MERCHANT_PUBKEY)
    ).toBe(false)
    expect(
      isDeliverableMerchantProductEvent(
        makeSignedEvent(EVENT_KINDS.PRODUCT),
        getPublicKey(OTHER_MERCHANT_SECRET)
      )
    ).toBe(false)
  })

  it("retains a fallback-only listing ACK for an immediate deletion", async () => {
    const fallbackRelayUrl = CANONICAL_COMMERCE_DISCOVERY_RELAYS[0]!
    const event = makeSignedProductEvent({
      dTag: "fallback-single",
      acceptedRelayUrl: fallbackRelayUrl,
    })
    await cacheSignedProductListingEvent(event)

    const delivery = await deliverSignedProductEvent(event, MERCHANT_PUBKEY)
    const cached = cachedProducts.find(
      (product) => product.dTag === "fallback-single"
    )

    expect(delivery.successfulRelayUrls).toEqual([fallbackRelayUrl])
    expect(cached?.sourceRelayUrls).toEqual([fallbackRelayUrl])
    expect(
      planProductDeletionRelays({
        currentWriteRelayUrls: [],
        sourceRelayUrls: cached?.sourceRelayUrls ?? [],
        canonicalConduitRelayUrl: CANONICAL_APP_BACKPLANE_RELAYS[0]!,
      })
    ).toContainEqual({
      relayUrl: fallbackRelayUrl,
      roles: ["source"],
    })
  })

  it("retains per-listing fallback ACKs outside the bundle intersection", async () => {
    const [firstFallbackRelayUrl, secondFallbackRelayUrl] =
      CANONICAL_COMMERCE_DISCOVERY_RELAYS
    const first = makeSignedProductEvent({
      dTag: "fallback-bundle-a",
      acceptedRelayUrl: firstFallbackRelayUrl!,
    })
    const second = makeSignedProductEvent({
      dTag: "fallback-bundle-b",
      acceptedRelayUrl: secondFallbackRelayUrl!,
    })
    await cacheSignedProductListingEvent(first)
    await cacheSignedProductListingEvent(second)

    const delivery = await deliverSignedProductEventBundle(
      [first, second],
      MERCHANT_PUBKEY
    )
    const firstCached = cachedProducts.find(
      (product) => product.dTag === "fallback-bundle-a"
    )
    const secondCached = cachedProducts.find(
      (product) => product.dTag === "fallback-bundle-b"
    )

    expect(delivery.successfulRelayUrls).toEqual([])
    expect(firstCached?.sourceRelayUrls).toEqual([firstFallbackRelayUrl])
    expect(secondCached?.sourceRelayUrls).toEqual([secondFallbackRelayUrl])
    const deletionRelayUrls = planProductDeletionRelays({
      currentWriteRelayUrls: [],
      sourceRelayUrls: [
        ...(firstCached?.sourceRelayUrls ?? []),
        ...(secondCached?.sourceRelayUrls ?? []),
      ],
      canonicalConduitRelayUrl: CANONICAL_APP_BACKPLANE_RELAYS[0]!,
    }).map(({ relayUrl }) => relayUrl)
    expect(deletionRelayUrls).toContain(firstFallbackRelayUrl)
    expect(deletionRelayUrls).toContain(secondFallbackRelayUrl)
  })
})
