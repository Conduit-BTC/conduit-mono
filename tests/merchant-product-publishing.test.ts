import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
  NDKEvent,
  NDKPrivateKeySigner,
  type NDKSigner,
  type NostrEvent,
} from "@nostr-dev-kit/ndk"
import {
  __resetCommerceTestOverrides,
  __resetRelayPublishTestOverrides,
  __setCommerceTestOverrides,
  __setRelayPublishTestOverrides,
  applyE2eRelayIsolation,
  buildProductListingEventDraft,
  cacheSignedProductListingEvent,
  CANONICAL_APP_BACKPLANE_RELAYS,
  CANONICAL_COMMERCE_DISCOVERY_RELAYS,
  config,
  deliverProductListingJob,
  EVENT_KINDS,
  getCachedMerchantStorefront,
  parseProductEvent,
  persistProductListingDelivery,
  planProductDeletionRelays,
  RemoteSignerError,
  resolveProductFulfillment,
  setSigner,
  type ProductDeletionOutboxRepository,
  type ProductListingDeliveryJob,
  type ProductListingOutboxRepository,
  type ProductSchema,
  type PublishWithPlannerResult,
} from "@conduit/core"
import type {
  CachedProduct,
  ProductDeletionDeliveryJob,
} from "@conduit/core/db"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  applyProductFulfillmentIntentForPublication,
  buildProductRemovalDeletionTargets,
  deliverSignedProductEvent,
  deliverSignedProductEventBundle,
  deliverSignedProductWriteBundle,
  getProductSignerRequestCount,
  isDeliverableMerchantProductEvent,
  publishCanonicalProductEvents,
  resolveProductFulfillmentIntentForTarget,
  resolvePublishedProductFulfillmentIntentForTarget,
  signAndPublishProductWriteBundle,
  type CanonicalProductPublishDependencies,
  type SignedProductWriteBundle,
} from "../apps/merchant/src/lib/product-publishing"
import {
  persistSignedProductDeletion,
  resumePendingProductDeletionDeliveries,
} from "../apps/merchant/src/lib/product-deletion-delivery"
import {
  deliverQueuedProductListings,
  ensureSignedProductListingsQueued,
  productListingJobToPublishResult,
  resolveProductListingRelayTargets,
  resumePendingProductListingDeliveries,
  resumeStagedProductListingDeliveries,
} from "../apps/merchant/src/lib/product-listing-delivery"
import { __resetNdkTestState } from "../packages/core/src/protocol/ndk"

const MERCHANT_SECRET = new Uint8Array(32).fill(4)
const OTHER_MERCHANT_SECRET = new Uint8Array(32).fill(5)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const NOW = 1_700_000_100_000
const allowAllAccountNetworkLocalStateRepository = {
  get: async () => undefined,
}

function publishAndParse(
  product: ProductSchema,
  dTag: string,
  intent: NonNullable<
    ReturnType<typeof resolvePublishedProductFulfillmentIntentForTarget>
  >
) {
  const prepared = applyProductFulfillmentIntentForPublication({
    product,
    merchantPubkey: MERCHANT_PUBKEY,
    productDTag: dTag,
    intent,
  })
  const draft = buildProductListingEventDraft({
    product: prepared,
    dTag,
    clientAppId: "merchant",
  })
  const signed = finalizeEvent(
    {
      kind: draft.kind,
      created_at: Math.floor(NOW / 1000),
      content: draft.content,
      tags: draft.tags,
    },
    MERCHANT_SECRET
  )
  expect(signed.sig).toHaveLength(128)
  return { prepared, parsed: parseProductEvent(signed) }
}

let cachedProducts: CachedProduct[] = []

function cloneDeletionJob(
  job: ProductDeletionDeliveryJob
): ProductDeletionDeliveryJob {
  return structuredClone(job)
}

class MemoryProductDeletionOutbox implements ProductDeletionOutboxRepository {
  constructor(
    private readonly storage: Map<
      string,
      ProductDeletionDeliveryJob
    > = new Map()
  ) {}

  async add(job: ProductDeletionDeliveryJob): Promise<void> {
    if (this.storage.has(job.id)) throw new Error("duplicate")
    this.storage.set(job.id, cloneDeletionJob(job))
  }

  async get(id: string): Promise<ProductDeletionDeliveryJob | undefined> {
    const job = this.storage.get(id)
    return job ? cloneDeletionJob(job) : undefined
  }

  async listUndelivered(): Promise<ProductDeletionDeliveryJob[]> {
    return Array.from(this.storage.values())
      .filter((job) => job.state !== "delivered")
      .map(cloneDeletionJob)
  }

  async update(
    id: string,
    updater: (current: ProductDeletionDeliveryJob) => ProductDeletionDeliveryJob
  ): Promise<ProductDeletionDeliveryJob> {
    const current = this.storage.get(id)
    if (!current) throw new Error("missing")
    const next = updater(cloneDeletionJob(current))
    this.storage.set(id, cloneDeletionJob(next))
    return cloneDeletionJob(next)
  }
}

function cloneListingJob(
  job: ProductListingDeliveryJob
): ProductListingDeliveryJob {
  return structuredClone(job)
}

class MemoryProductListingOutbox implements ProductListingOutboxRepository {
  constructor(
    private readonly storage: Map<string, ProductListingDeliveryJob> = new Map()
  ) {}

  async add(job: ProductListingDeliveryJob): Promise<void> {
    if (this.storage.has(job.id)) throw new Error("duplicate")
    this.storage.set(job.id, cloneListingJob(job))
  }

  async get(id: string): Promise<ProductListingDeliveryJob | undefined> {
    const job = this.storage.get(id)
    return job ? cloneListingJob(job) : undefined
  }

  async listUndelivered(): Promise<ProductListingDeliveryJob[]> {
    return Array.from(this.storage.values())
      .filter((job) => job.state === "pending" || job.state === "partial")
      .map(cloneListingJob)
  }

  async update(
    id: string,
    updater: (current: ProductListingDeliveryJob) => ProductListingDeliveryJob
  ): Promise<ProductListingDeliveryJob> {
    const current = this.storage.get(id)
    if (!current) throw new Error("missing")
    const next = updater(cloneListingJob(current))
    this.storage.set(id, cloneListingJob(next))
    return cloneListingJob(next)
  }
}

function createAckedProductListingDeliveryOptions() {
  return {
    repository: new MemoryProductListingOutbox(),
    accountNetworkLocalStateRepository:
      allowAllAccountNetworkLocalStateRepository,
    now: () => NOW,
    retryDelayMs: 1,
    restoreLocalEvidence: async () => {},
    publisher: async () => ({ status: "acked" as const }),
  }
}

function createProductListingRelayPlanningDependencies(
  relayUrl = "wss://relay.example"
) {
  return {
    planProductListingRelayTargets: async () => [
      { relayUrl, ownerSelected: false },
    ],
  }
}

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
  const product = makeProduct(input.dTag)
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

function makeSignedProductEventWithShippingTags(input: {
  dTag: string
  shippingTags: string[][]
}): NDKEvent {
  const product = makeProduct(input.dTag)
  const draft = buildProductListingEventDraft({
    product,
    dTag: input.dTag,
    clientAppId: "merchant",
  })
  return new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: draft.kind,
        created_at: Math.floor(NOW / 1000),
        content: draft.content,
        tags: [
          ...draft.tags.filter((tag) => tag[0] !== "shipping_option"),
          ...input.shippingTags,
        ],
      },
      MERCHANT_SECRET
    )
  )
}

function makeProduct(dTag: string): ProductSchema {
  return {
    id: `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:${dTag}`,
    pubkey: MERCHANT_PUBKEY,
    title: `Listing ${dTag}`,
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
}

async function readProductAfterCacheReload(
  rows: CachedProduct[],
  dTag: string
): Promise<ProductSchema | undefined> {
  __resetCommerceTestOverrides()
  __setCommerceTestOverrides({
    now: () => NOW,
    getCachedProducts: async () => rows,
    getCachedProductTombstones: async () => [],
  })
  const reloaded = await getCachedMerchantStorefront({
    merchantPubkey: MERCHANT_PUBKEY,
    includeMarketHidden: true,
  })
  return reloaded.data.find((record) => record.dTag === dTag)?.product
}

beforeEach(() => {
  cachedProducts = []
  __resetCommerceTestOverrides()
  __resetRelayPublishTestOverrides()
  __resetNdkTestState()
  __setCommerceTestOverrides({
    now: () => NOW,
    getCachedProducts: async () => cachedProducts,
    getCachedProductTombstones: async () => [],
    putCachedProducts: async (rows) => {
      for (const row of rows) {
        cachedProducts = [
          ...cachedProducts.filter((existing) => existing.id !== row.id),
          row,
        ]
      }
    },
    putCachedProductTombstones: async () => {},
  })
  __setRelayPublishTestOverrides({
    accountNetworkLocalStateRepository:
      allowAllAccountNetworkLocalStateRepository,
    publishSignedEventFrameToRelay: async () => "acked",
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
  it("freezes configured product fallbacks into a non-authoritative relay plan", () => {
    const plannedRelayUrl = "wss://merchant-relay.example"
    const targets = resolveProductListingRelayTargets({
      intent: "author_event",
      primaryRelayUrls: [plannedRelayUrl],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
      signedRelayListAuthoritative: false,
    })
    const targetUrls = targets.map(({ relayUrl }) => relayUrl)

    expect(targetUrls).toContain(plannedRelayUrl)
    expect(targetUrls).toContain(CANONICAL_APP_BACKPLANE_RELAYS[0]!)
    for (const relayUrl of CANONICAL_COMMERCE_DISCOVERY_RELAYS) {
      expect(targetUrls).toContain(relayUrl)
    }
  })

  it("does not add configured fallbacks to an authoritative empty relay plan", () => {
    expect(
      resolveProductListingRelayTargets({
        intent: "author_event",
        primaryRelayUrls: [],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
        signedRelayListAuthoritative: true,
      })
    ).toEqual([])
  })

  it("revalidates live account authority before product relay I/O", async () => {
    const relayUrl = CANONICAL_APP_BACKPLANE_RELAYS[0]!
    __setRelayPublishTestOverrides({
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [relayUrl],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })
    const event = new NDKEvent(undefined, makeSignedEvent(EVENT_KINDS.PRODUCT))
    const publish = spyOn(event, "publish").mockResolvedValue(
      new Set([{ url: `${relayUrl}/` }]) as never
    )

    await expect(
      deliverSignedProductEvent(event, MERCHANT_PUBKEY, {
        authenticatedPubkey: MERCHANT_PUBKEY,
        shouldContinue: () => false,
      })
    ).rejects.toThrow("Signed product event could not be delivered")
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("counts only the approval-bearing events in each product change bundle", () => {
    const ordinary = {
      product: makeProduct("ordinary"),
      dTag: "ordinary",
      fulfillmentIntent: { kind: "coordinate_after_order" as const },
    }
    const fixed = {
      product: makeProduct("fixed"),
      dTag: "fixed",
      fulfillmentIntent: {
        kind: "fixed_standard" as const,
        amount: 5,
        currency: "SATS",
        countries: ["US"],
      },
    }
    const deletion = buildProductRemovalDeletionTargets([
      {
        eventId: "d".repeat(64),
        addressId: `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:removed`,
        sourceRelayUrls: [],
      },
    ])

    expect(getProductSignerRequestCount({ listings: [ordinary] })).toBe(1)
    expect(getProductSignerRequestCount({ listings: [fixed] })).toBe(2)
    expect(
      getProductSignerRequestCount({
        listings: [ordinary, fixed],
        deletions: deletion,
      })
    ).toBe(4)
    expect(
      getProductSignerRequestCount({ listings: [], deletions: deletion })
    ).toBe(1)
  })

  for (const scenario of [
    {
      name: "multiple shipping option references",
      dTag: "cached-multiple-shipping-references",
      shippingTags: [
        [
          "shipping_option",
          `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT_PUBKEY}:cached-standard`,
        ],
        [
          "shipping_option",
          `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT_PUBKEY}:cached-express`,
        ],
      ],
    },
    {
      name: "product-level shipping extra cost",
      dTag: "cached-shipping-extra-cost",
      shippingTags: [
        [
          "shipping_option",
          `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT_PUBKEY}:cached-standard`,
          "5",
        ],
      ],
    },
  ]) {
    it(`preserves ${scenario.name} across cache reload before a stock update`, async () => {
      const event = makeSignedProductEventWithShippingTags(scenario)

      expect(parseProductEvent(event).shippingOptionLaunchUnsupported).toBe(
        true
      )
      await cacheSignedProductListingEvent(event)
      expect(
        cachedProducts.find((row) => row.dTag === scenario.dTag)
          ?.shippingOptionLaunchUnsupported
      ).toBe(true)

      const product = await readProductAfterCacheReload(
        structuredClone(cachedProducts),
        scenario.dTag
      )

      expect(product?.shippingOptionLaunchUnsupported).toBe(true)
      if (!product) throw new Error("Expected the cached product after reload")
      const stockUpdate = { ...product, stock: 1, updatedAt: NOW + 1 }
      expect(resolveProductFulfillment(stockUpdate, [])).toMatchObject({
        status: "order_first",
        reason: "unsupported",
      })
      expect(
        resolvePublishedProductFulfillmentIntentForTarget(stockUpdate)
      ).toBeNull()
    })
  }

  it("round-trips an explicit supported shipping reference cache marker", async () => {
    const dTag = "cached-supported-shipping-reference"
    const event = makeSignedProductEventWithShippingTags({
      dTag,
      shippingTags: [
        [
          "shipping_option",
          `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT_PUBKEY}:cached-standard`,
        ],
      ],
    })

    expect(parseProductEvent(event).shippingOptionLaunchUnsupported).toBe(false)
    await cacheSignedProductListingEvent(event)
    expect(cachedProducts[0]?.shippingOptionLaunchUnsupported).toBe(false)

    const product = await readProductAfterCacheReload(
      structuredClone(cachedProducts),
      dTag
    )
    expect(product?.shippingOptionLaunchUnsupported).toBe(false)
  })

  it("fails legacy or malformed referenced cache rows closed", async () => {
    const dTag = "cached-ambiguous-shipping-reference"
    const event = makeSignedProductEventWithShippingTags({
      dTag,
      shippingTags: [
        [
          "shipping_option",
          `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT_PUBKEY}:cached-standard`,
        ],
      ],
    })
    await cacheSignedProductListingEvent(event)
    const baseline = cachedProducts[0]
    if (!baseline) throw new Error("Expected the cached product row")

    for (const cachedValue of [undefined, "false"] as const) {
      const row = structuredClone(baseline)
      const runtimeRow = row as unknown as Record<string, unknown>
      if (cachedValue === undefined) {
        delete runtimeRow.shippingOptionLaunchUnsupported
      } else {
        runtimeRow.shippingOptionLaunchUnsupported = cachedValue
      }

      const product = await readProductAfterCacheReload([row], dTag)
      expect(product?.shippingOptionLaunchUnsupported).toBe(true)
      if (!product) throw new Error("Expected the cached product after reload")
      expect(resolveProductFulfillment(product, [])).toMatchObject({
        status: "order_first",
        reason: "unsupported",
      })
    }
  })

  it("leaves cache rows without a shipping reference unaffected", async () => {
    const dTag = "cached-without-shipping-reference"
    await cacheSignedProductListingEvent(
      makeSignedProductEventWithShippingTags({ dTag, shippingTags: [] })
    )
    const row = cachedProducts[0]
    if (!row) throw new Error("Expected the cached product row")
    expect(row.shippingOptionId).toBeUndefined()
    expect(row.shippingOptionLaunchUnsupported).toBeUndefined()

    const runtimeRow = row as unknown as Record<string, unknown>
    runtimeRow.shippingOptionLaunchUnsupported = true
    const product = await readProductAfterCacheReload([row], dTag)
    expect(product?.shippingOptionId).toBeUndefined()
    expect(product?.shippingOptionLaunchUnsupported).toBeUndefined()
  })

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

  it("does not infer owner relay authority from a signed product author", async () => {
    const authenticatedPubkeys: Array<string | null | undefined> = []
    const relayUrl = CANONICAL_COMMERCE_DISCOVERY_RELAYS[0]!
    __setRelayPublishTestOverrides({
      planPublishRelays: async (input) => {
        authenticatedPubkeys.push(input.authenticatedPubkey)
        return {
          intent: "author_event",
          primaryRelayUrls: [relayUrl],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        }
      },
    })

    await deliverSignedProductEvent(
      makeSignedProductEvent({
        dTag: "auth-absent",
        acceptedRelayUrl: relayUrl,
      }),
      MERCHANT_PUBKEY
    )
    await deliverSignedProductEvent(
      makeSignedProductEvent({
        dTag: "auth-owner",
        acceptedRelayUrl: relayUrl,
      }),
      MERCHANT_PUBKEY,
      { authenticatedPubkey: MERCHANT_PUBKEY }
    )
    await deliverSignedProductEvent(
      makeSignedProductEvent({
        dTag: "auth-stale",
        acceptedRelayUrl: relayUrl,
      }),
      MERCHANT_PUBKEY,
      { authenticatedPubkey: getPublicKey(OTHER_MERCHANT_SECRET) }
    )

    expect(authenticatedPubkeys).toEqual([null, MERCHANT_PUBKEY, null])
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

  it("preserves fallback provenance when its post-ACK cache write fails", async () => {
    const fallbackRelayUrl = CANONICAL_COMMERCE_DISCOVERY_RELAYS[0]!
    const event = makeSignedProductEvent({
      dTag: "fallback-volatile",
      acceptedRelayUrl: fallbackRelayUrl,
    })
    await cacheSignedProductListingEvent(event)
    __setCommerceTestOverrides({
      putCachedProducts: async () => {
        throw new Error("IndexedDB write failed")
      },
    })

    const delivery = await deliverSignedProductEvent(event, MERCHANT_PUBKEY)
    const volatileCached = await getCachedMerchantStorefront({
      merchantPubkey: MERCHANT_PUBKEY,
      includeMarketHidden: true,
    })
    const volatileRecord = volatileCached.data.find(
      (record) => record.dTag === "fallback-volatile"
    )

    expect(delivery.successfulRelayUrls).toEqual([fallbackRelayUrl])
    expect(volatileRecord?.sourceRelayUrls).toEqual([fallbackRelayUrl])
    expect(
      planProductDeletionRelays({
        currentWriteRelayUrls: [],
        sourceRelayUrls: volatileRecord?.sourceRelayUrls ?? [],
        canonicalConduitRelayUrl: CANONICAL_APP_BACKPLANE_RELAYS[0]!,
      })
    ).toContainEqual({
      relayUrl: fallbackRelayUrl,
      roles: ["source"],
    })

    __setCommerceTestOverrides({
      putCachedProducts: async (rows) => {
        for (const row of rows) {
          cachedProducts = [
            ...cachedProducts.filter((existing) => existing.id !== row.id),
            row,
          ]
        }
      },
    })
    const durableCached = await getCachedMerchantStorefront({
      merchantPubkey: MERCHANT_PUBKEY,
      includeMarketHidden: true,
    })

    expect(
      durableCached.data.find((record) => record.dTag === "fallback-volatile")
        ?.sourceRelayUrls
    ).toEqual([fallbackRelayUrl])
    expect(
      cachedProducts.find((product) => product.dTag === "fallback-volatile")
        ?.sourceRelayUrls
    ).toEqual([fallbackRelayUrl])
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

  it("durably resumes a mixed family edit without misclassifying exclusive relay ACKs", async () => {
    const deletionAckRelayUrl = "wss://relay.damus.io"
    const deletionPendingRelayUrl = "wss://relay.nostr.net"
    const durableStorage = new Map<string, ProductDeletionDeliveryJob>()
    const beforeReload = new MemoryProductDeletionOutbox(durableStorage)
    const signer = new NDKPrivateKeySigner(MERCHANT_SECRET)
    setSigner(signer)
    const deletionTargets = buildProductRemovalDeletionTargets([
      {
        eventId: "b".repeat(64),
        addressId: `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:variation`,
        sourceRelayUrls: [deletionAckRelayUrl, deletionPendingRelayUrl],
      },
    ])
    let signedBundle: SignedProductWriteBundle | null = null
    let signedDeletionId = ""
    const delivery = await signAndPublishProductWriteBundle(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        listings: [
          {
            product: makeProduct("root"),
            dTag: "root",
            fulfillmentIntent: { kind: "coordinate_after_order" },
          },
        ],
        deletions: deletionTargets,
        onSignedLocal: async (bundle) => {
          signedBundle = bundle
          const listing = bundle.events.find(
            (event) => event.kind === EVENT_KINDS.PRODUCT
          )
          const deletion = bundle.events.find(
            (event) => event.kind === EVENT_KINDS.DELETION
          )
          if (!listing) throw new Error("Expected a signed listing event")
          if (!deletion) throw new Error("Expected a signed deletion event")
          signedDeletionId = deletion.id
          listing.publish = (async (relaySet: unknown) => {
            const attemptedRelayUrls = [
              ...((relaySet as { relayUrls?: Set<string> | string[] })
                .relayUrls ?? []),
            ]
            return new Set(attemptedRelayUrls.map((url) => ({ url })))
          }) as never
          deletion.publish = (async () => new Set()) as never
        },
        productListingDeliveryOptions:
          createAckedProductListingDeliveryOptions(),
        deletionDeliveryOptions: {
          repository: beforeReload,
          accountNetworkLocalStateRepository:
            allowAllAccountNetworkLocalStateRepository,
          now: () => NOW,
          retryDelayMs: 1,
          restoreLocalEvidence: async () => {},
          publisher: async ({ relayUrl }) =>
            relayUrl === deletionPendingRelayUrl
              ? { status: "timed_out" }
              : { status: "acked" },
        },
      },
      createProductListingRelayPlanningDependencies(
        CANONICAL_APP_BACKPLANE_RELAYS[0]!
      )
    )
    if (!signedBundle) throw new Error("Expected the signed retry bundle")
    const stagedDeletion = await beforeReload.get(signedDeletionId)

    expect(signedBundle.deletionDeliveryJobId).toBe(signedDeletionId)
    expect(signedBundle.events[0]?.tags).toContainEqual(["d", "root"])
    expect(
      delivery.successfulRelayUrls.includes(CANONICAL_APP_BACKPLANE_RELAYS[0]!)
    ).toBe(true)
    expect(delivery.successfulRelayUrls).toContain(deletionAckRelayUrl)
    expect(delivery.failedRelayUrls).toEqual([deletionPendingRelayUrl])
    expect(stagedDeletion?.state).toBe("partial")
    expect(stagedDeletion?.signedEvent.id).toBe(signedDeletionId)
    expect(stagedDeletion?.signedEvent.tags).toContainEqual([
      "a",
      `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:variation`,
    ])
    expect(stagedDeletion?.relayPlan).toContainEqual({
      relayUrl: deletionAckRelayUrl,
      roles: ["source"],
    })
    expect(stagedDeletion?.relayPlan).toContainEqual({
      relayUrl: deletionPendingRelayUrl,
      roles: ["source"],
    })

    const afterReload = new MemoryProductDeletionOutbox(durableStorage)
    const resumedRelayUrls: string[] = []
    const resumedEventIds: string[] = []
    await resumePendingProductDeletionDeliveries({
      repository: afterReload,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      now: () => NOW + 10_000,
      retryDelayMs: 1,
      deliveryLeaseOwner: "after-reload",
      isCompanionListingReady: async () => true,
      restoreLocalEvidence: async () => {},
      publisher: async ({ relayUrl, signedEvent }) => {
        resumedRelayUrls.push(relayUrl)
        resumedEventIds.push(signedEvent.id)
        return { status: "acked" }
      },
    })

    expect(resumedRelayUrls).toEqual([deletionPendingRelayUrl])
    expect(resumedEventIds).toEqual([signedDeletionId])
    expect((await afterReload.get(signedDeletionId))?.state).toBe("delivered")
  })

  it("resumes the exact signed product family after partial relay delivery and reload", async () => {
    const firstRelayUrl = "wss://relay.damus.io"
    const secondRelayUrl = "wss://relay.nostr.net"
    const durableStorage = new Map<string, ProductListingDeliveryJob>()
    const beforeReload = new MemoryProductListingOutbox(durableStorage)
    const delegate = new NDKPrivateKeySigner(MERCHANT_SECRET)
    let signRequests = 0
    setSigner({
      user: () => delegate.user(),
      sign: async (event: NostrEvent) => {
        signRequests += 1
        return await delegate.sign(event)
      },
    } as NDKSigner)

    let signedBundle: SignedProductWriteBundle | null = null
    const initialAttempts: Array<{ eventId: string; relayUrl: string }> = []
    const initial = await signAndPublishProductWriteBundle(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        listings: ["root", "variation"].map((dTag) => ({
          product: makeProduct(dTag),
          dTag,
          fulfillmentIntent: { kind: "coordinate_after_order" as const },
        })),
        onSignedLocal: async (bundle) => {
          signedBundle = bundle
          const jobId = bundle.productListingDeliveryJobId
          expect(jobId).toBeString()
          // Caller-specific local state completes before a background worker
          // can observe and publish the durable family.
          expect(await beforeReload.get(jobId!)).toBeUndefined()
          expect(initialAttempts).toEqual([])
        },
        productListingDeliveryOptions: {
          repository: beforeReload,
          accountNetworkLocalStateRepository:
            allowAllAccountNetworkLocalStateRepository,
          now: () => NOW,
          retryDelayMs: 1,
          publisher: async ({ relayUrl, signedEvent }) => {
            initialAttempts.push({ eventId: signedEvent.id, relayUrl })
            const dTag = signedEvent.tags.find(([name]) => name === "d")?.[1]
            if (relayUrl === firstRelayUrl) {
              return { status: dTag === "root" ? "acked" : "timed_out" }
            }
            return { status: dTag === "root" ? "rejected" : "acked" }
          },
        },
      },
      {
        planProductListingRelayTargets: async () => [
          { relayUrl: firstRelayUrl, ownerSelected: false },
          { relayUrl: secondRelayUrl, ownerSelected: false },
        ],
      }
    )
    if (!signedBundle) throw new Error("Expected a signed product bundle")
    const jobId = signedBundle.productListingDeliveryJobId
    if (!jobId) throw new Error("Expected a durable listing delivery job")
    const staged = await beforeReload.get(jobId)
    const exactSignedEvents = structuredClone(staged?.signedEvents ?? [])

    expect(signRequests).toBe(2)
    expect(initial.successfulRelayUrls).toEqual([])
    expect(staged?.state).toBe("partial")
    expect(staged?.relayDelivery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: exactSignedEvents[0]?.id,
          relayUrl: firstRelayUrl,
          status: "acked",
        }),
        expect.objectContaining({
          eventId: exactSignedEvents[1]?.id,
          relayUrl: firstRelayUrl,
          status: "timed_out",
        }),
        expect.objectContaining({
          eventId: exactSignedEvents[0]?.id,
          relayUrl: secondRelayUrl,
          status: "rejected",
        }),
        expect.objectContaining({
          eventId: exactSignedEvents[1]?.id,
          relayUrl: secondRelayUrl,
          status: "acked",
        }),
      ])
    )
    expect(
      cachedProducts.find((product) => product.dTag === "root")?.sourceRelayUrls
    ).toEqual([firstRelayUrl])
    expect(
      cachedProducts.find((product) => product.dTag === "variation")
        ?.sourceRelayUrls
    ).toEqual([secondRelayUrl])

    const afterReload = new MemoryProductListingOutbox(durableStorage)
    const resumed: Array<{ event: NostrEvent; relayUrl: string }> = []
    await resumePendingProductListingDeliveries(
      {
        repository: afterReload,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        now: () => NOW + 10_000,
        retryDelayMs: 1,
        publisher: async ({ relayUrl, signedEvent }) => {
          resumed.push({ event: signedEvent, relayUrl })
          return { status: "acked" }
        },
      },
      {
        planProductListingRelayTargets: async () => [
          {
            relayUrl: CANONICAL_APP_BACKPLANE_RELAYS[0]!,
            ownerSelected: false,
          },
        ],
      }
    )

    const delivered = await afterReload.get(jobId)
    expect(signRequests).toBe(2)
    expect(resumed).toEqual([
      { event: exactSignedEvents[1], relayUrl: firstRelayUrl },
    ])
    expect(delivered?.signedEvents).toEqual(exactSignedEvents)
    expect(delivered?.relayTargets).toEqual(staged?.relayTargets)
    expect(delivered?.state).toBe("delivered")
    expect(delivered?.relayDelivery).toContainEqual(
      expect.objectContaining({
        eventId: exactSignedEvents[0]?.id,
        relayUrl: secondRelayUrl,
        status: "rejected",
      })
    )
    const resumedVariation = cachedProducts.find(
      (product) => product.dTag === "variation"
    )
    expect(resumedVariation?.sourceRelayUrls).toEqual([
      firstRelayUrl,
      secondRelayUrl,
    ])
    expect(
      planProductDeletionRelays({
        currentWriteRelayUrls: [],
        sourceRelayUrls: resumedVariation?.sourceRelayUrls ?? [],
        canonicalConduitRelayUrl: CANONICAL_APP_BACKPLANE_RELAYS[0]!,
      }).map(({ relayUrl }) => relayUrl)
    ).toEqual(expect.arrayContaining([firstRelayUrl, secondRelayUrl]))
  })

  it("does not let a stale timeout overwrite another tab's relay ACK", async () => {
    const relayUrl = "wss://relay.example"
    const storage = new Map<string, ProductListingDeliveryJob>()
    const firstTab = new MemoryProductListingOutbox(storage)
    const secondTab = new MemoryProductListingOutbox(storage)
    const signedEvent = makeSignedEvent(EVENT_KINDS.PRODUCT)
    const staged = await persistProductListingDelivery(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: [signedEvent],
        relayTargets: [{ relayUrl, ownerSelected: false }],
      },
      { repository: firstTab, now: () => NOW }
    )
    let releaseFirstAttempt = () => {}
    let firstAttemptStarted = () => {}
    const firstAttemptIsStarted = new Promise<void>((resolve) => {
      firstAttemptStarted = resolve
    })
    const releaseFirstAttemptPromise = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve
    })

    const staleTimeout = deliverProductListingJob(
      staged.id,
      async () => {
        firstAttemptStarted()
        await releaseFirstAttemptPromise
        return { status: "timed_out" }
      },
      {
        repository: firstTab,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        now: () => NOW,
        retryDelayMs: 1,
      }
    )
    await firstAttemptIsStarted
    await deliverProductListingJob(
      staged.id,
      async () => ({ status: "acked" }),
      {
        repository: secondTab,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        now: () => NOW + 1,
        retryDelayMs: 1,
      }
    )
    releaseFirstAttempt()
    await staleTimeout

    const delivered = await firstTab.get(staged.id)
    expect(delivered?.state).toBe("delivered")
    expect(delivered?.relayDelivery).toContainEqual(
      expect.objectContaining({
        eventId: signedEvent.id,
        relayUrl,
        status: "acked",
      })
    )
  })

  it("lets a durable relay ACK upgrade a concurrent rejection", async () => {
    const relayUrl = "wss://relay.example"
    const storage = new Map<string, ProductListingDeliveryJob>()
    const firstTab = new MemoryProductListingOutbox(storage)
    const secondTab = new MemoryProductListingOutbox(storage)
    const signedEvent = makeSignedEvent(EVENT_KINDS.PRODUCT)
    const staged = await persistProductListingDelivery(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: [signedEvent],
        relayTargets: [{ relayUrl, ownerSelected: false }],
      },
      { repository: firstTab, now: () => NOW }
    )
    let releaseAck = () => {}
    let ackStarted = () => {}
    const ackIsStarted = new Promise<void>((resolve) => {
      ackStarted = resolve
    })
    const releaseAckPromise = new Promise<void>((resolve) => {
      releaseAck = resolve
    })

    const delayedAck = deliverProductListingJob(
      staged.id,
      async () => {
        ackStarted()
        await releaseAckPromise
        return { status: "acked" }
      },
      {
        repository: firstTab,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        now: () => NOW + 1,
        retryDelayMs: 1,
      }
    )
    await ackIsStarted
    await deliverProductListingJob(
      staged.id,
      async () => ({ status: "rejected" }),
      {
        repository: secondTab,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        now: () => NOW,
        retryDelayMs: 1,
      }
    )
    releaseAck()
    await delayedAck

    const delivered = await firstTab.get(staged.id)
    expect(delivered?.state).toBe("delivered")
    expect(delivered?.relayDelivery).toContainEqual(
      expect.objectContaining({
        eventId: signedEvent.id,
        relayUrl,
        status: "acked",
      })
    )
  })

  it("completes once one relay acknowledges the entire signed family", async () => {
    const commonRelayUrl = "wss://relay.damus.io"
    const timedOutRelayUrl = "wss://relay.nostr.net"
    const repository = new MemoryProductListingOutbox()
    const signedEvents = ["root", "variation"].map((dTag) =>
      makeSignedProductEventWithShippingTags({
        dTag: `common-${dTag}`,
        shippingTags: [],
      }).rawEvent()
    )
    const staged = await persistProductListingDelivery(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents,
        relayTargets: [
          { relayUrl: commonRelayUrl, ownerSelected: false },
          { relayUrl: timedOutRelayUrl, ownerSelected: false },
        ],
      },
      { repository, now: () => NOW, retryDelayMs: 1 }
    )
    let attempts = 0

    const delivered = await deliverProductListingJob(
      staged.id,
      async ({ relayUrl }) => {
        attempts += 1
        return {
          status:
            relayUrl === commonRelayUrl
              ? ("acked" as const)
              : ("timed_out" as const),
        }
      },
      {
        repository,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        now: () => NOW,
        retryDelayMs: 1,
      }
    )

    expect(delivered.state).toBe("delivered")
    expect(attempts).toBe(4)
    await resumePendingProductListingDeliveries({
      repository,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      now: () => NOW + 10_000,
      retryDelayMs: 1,
      restoreLocalEvidence: async () => {},
      publisher: async () => {
        attempts += 1
        return { status: "acked" }
      },
    })
    expect(attempts).toBe(4)
  })

  it("reports an all-rejected family as terminal and does not retry it", async () => {
    const relayUrl = "wss://relay.example"
    const repository = new MemoryProductListingOutbox()
    const staged = await persistProductListingDelivery(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: [
          makeSignedProductEventWithShippingTags({
            dTag: "terminal-rejection",
            shippingTags: [],
          }).rawEvent(),
        ],
        relayTargets: [{ relayUrl, ownerSelected: false }],
      },
      { repository, now: () => NOW, retryDelayMs: 1 }
    )
    let attempts = 0

    const result = await deliverQueuedProductListings(staged.id, {
      repository,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      restoreLocalEvidence: async () => {},
      publisher: async () => {
        attempts += 1
        return { status: "rejected" }
      },
    })

    expect(result.failedRelayUrls).toEqual([relayUrl])
    expect(result.rejectedRelayUrls).toEqual([relayUrl])
    expect((await repository.get(staged.id))?.state).toBe("failed")
    await resumePendingProductListingDeliveries({
      repository,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      now: () => NOW + 10_000,
      retryDelayMs: 1,
      restoreLocalEvidence: async () => {},
      publisher: async () => {
        attempts += 1
        return { status: "acked" }
      },
    })
    expect(attempts).toBe(1)
  })

  it("reports an ineligible persisted target as pending instead of delivered", async () => {
    const relayUrl = "ws://127.0.0.1:4799"
    const repository = new MemoryProductListingOutbox()
    const staged = await persistProductListingDelivery(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: [makeSignedEvent(EVENT_KINDS.PRODUCT)],
        relayTargets: [{ relayUrl, ownerSelected: true }],
      },
      { repository, now: () => NOW }
    )

    const result = await deliverQueuedProductListings(staged.id, {
      repository,
      authenticatedPubkey: null,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      restoreLocalEvidence: async () => {},
      publisher: async () => {
        throw new Error("ineligible target must not reach the publisher")
      },
    })

    expect(result.attemptedRelayUrls).toEqual([])
    expect(result.successfulRelayUrls).toEqual([])
    expect(result.failedRelayUrls).toEqual([relayUrl])
    expect(
      productListingJobToPublishResult((await repository.get(staged.id))!)
    ).toMatchObject({ failedRelayUrls: [relayUrl] })
  })

  it("migrates a pre-outbox retry before publishing its exact signed event", async () => {
    const relayUrl = "wss://relay.example"
    const repository = new MemoryProductListingOutbox()
    const signedEvent = makeSignedProductEventWithShippingTags({
      dTag: "legacy-pending-stock",
      shippingTags: [],
    }).rawEvent()
    let planCalls = 0
    let relayAttempts = 0

    const queued = await ensureSignedProductListingsQueued(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: [signedEvent],
        authenticatedPubkey: MERCHANT_PUBKEY,
      },
      { repository, now: () => NOW },
      {
        planRelayTargets: async () => {
          planCalls += 1
          return [{ relayUrl, ownerSelected: false }]
        },
      }
    )

    expect(planCalls).toBe(1)
    expect(relayAttempts).toBe(0)
    expect(queued.signedEvents).toEqual([signedEvent])
    expect(queued.relayTargets).toEqual([{ relayUrl, ownerSelected: false }])

    await deliverQueuedProductListings(queued.id, {
      repository,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      restoreLocalEvidence: async () => {},
      publisher: async ({ signedEvent: attemptedEvent }) => {
        relayAttempts += 1
        expect(attemptedEvent).toEqual(signedEvent)
        return { status: "acked" }
      },
    })
    expect(relayAttempts).toBe(1)

    const existing = await ensureSignedProductListingsQueued(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: [signedEvent],
      },
      { repository },
      {
        planRelayTargets: async () => {
          planCalls += 1
          return [{ relayUrl: "wss://different.example", ownerSelected: false }]
        },
      }
    )
    expect(existing.relayTargets).toEqual(queued.relayTargets)
    expect(planCalls).toBe(1)
  })

  it("does not make a relay ACK terminal before its provenance is durable", async () => {
    const relayUrl = CANONICAL_APP_BACKPLANE_RELAYS[0]!
    const repository = new MemoryProductListingOutbox()
    const signedEvent = makeSignedProductEventWithShippingTags({
      dTag: "durable-ack-provenance",
      shippingTags: [],
    }).rawEvent()
    const cachedRows: CachedProduct[] = []
    let failCacheWrite = true
    let relayAttempts = 0
    __setCommerceTestOverrides({
      getCachedProducts: async () => cachedRows,
      putCachedProducts: async (rows) => {
        if (failCacheWrite) throw new Error("product cache unavailable")
        cachedRows.push(...rows)
      },
    })
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async () => {
        relayAttempts += 1
        return "acked"
      },
    })
    const queued = await persistProductListingDelivery(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: [signedEvent],
        relayTargets: [{ relayUrl, ownerSelected: false }],
      },
      { repository, now: () => NOW, retryDelayMs: 1 }
    )

    const first = await deliverQueuedProductListings(queued.id, {
      repository,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      now: () => NOW,
      retryDelayMs: 1,
      restoreLocalEvidence: async () => {},
    })

    expect(first.successfulRelayUrls).toEqual([])
    expect((await repository.get(queued.id))?.state).toBe("partial")
    expect(relayAttempts).toBe(1)

    failCacheWrite = false
    const retried = await deliverQueuedProductListings(queued.id, {
      repository,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      now: () => NOW + 10_000,
      retryDelayMs: 1,
      restoreLocalEvidence: async () => {},
    })

    expect(retried.successfulRelayUrls).toEqual([relayUrl])
    expect((await repository.get(queued.id))?.state).toBe("delivered")
    expect(relayAttempts).toBe(2)
    expect(
      cachedRows.find((row) => row.dTag === "durable-ack-provenance")
        ?.sourceRelayUrls
    ).toEqual([relayUrl])
  })

  it("starts a later family while a larger family still has delayed pairs", async () => {
    const relayUrl = "wss://relay.example"
    const repository = new MemoryProductListingOutbox()
    const slowEvents = Array.from({ length: 8 }, (_, index) =>
      makeSignedProductEventWithShippingTags({
        dTag: `slow-${index}`,
        shippingTags: [],
      }).rawEvent()
    )
    const laterEvent = makeSignedProductEventWithShippingTags({
      dTag: "later",
      shippingTags: [],
    }).rawEvent()
    await persistProductListingDelivery(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: slowEvents,
        relayTargets: [{ relayUrl, ownerSelected: false }],
      },
      { repository, now: () => NOW }
    )
    await persistProductListingDelivery(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: [laterEvent],
        relayTargets: [{ relayUrl, ownerSelected: false }],
      },
      { repository, now: () => NOW + 1 }
    )
    let releaseSlow = () => {}
    const slowRelease = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let laterStarted = false
    let activeSlowPairs = 0
    let maximumActiveSlowPairs = 0

    const delivery = resumePendingProductListingDeliveries({
      repository,
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      now: () => NOW + 10_000,
      retryDelayMs: 1,
      restoreLocalEvidence: async () => {},
      publisher: async ({ signedEvent }) => {
        const dTag = signedEvent.tags.find(([name]) => name === "d")?.[1]
        if (dTag === "later") {
          laterStarted = true
          return { status: "acked" }
        }
        activeSlowPairs += 1
        maximumActiveSlowPairs = Math.max(
          maximumActiveSlowPairs,
          activeSlowPairs
        )
        await slowRelease
        activeSlowPairs -= 1
        return { status: "acked" }
      },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(laterStarted).toBe(true)
    expect(maximumActiveSlowPairs).toBe(6)
    releaseSlow()
    await delivery
  })

  it("keeps both mixed-mutation workers blocked when deletion staging fails", async () => {
    const listingStorage = new Map<string, ProductListingDeliveryJob>()
    const listingRepository = new MemoryProductListingOutbox(listingStorage)
    const deletionRepository = new MemoryProductDeletionOutbox()
    deletionRepository.add = async () => {
      throw new Error("deletion outbox unavailable")
    }
    let listingRelayAttempts = 0
    let deletionRelayAttempts = 0
    let onDeliveryQueuedCalls = 0
    setSigner(new NDKPrivateKeySigner(MERCHANT_SECRET))

    await expect(
      signAndPublishProductWriteBundle(
        {
          merchantPubkey: MERCHANT_PUBKEY,
          listings: [
            {
              product: makeProduct("mixed-stage-failure"),
              dTag: "mixed-stage-failure",
              fulfillmentIntent: { kind: "coordinate_after_order" },
            },
          ],
          deletions: buildProductRemovalDeletionTargets([
            {
              eventId: "d".repeat(64),
              addressId: `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:old`,
              sourceRelayUrls: [],
            },
          ]),
          onSignedLocal: async () => {},
          onDeliveryQueued: async () => {
            onDeliveryQueuedCalls += 1
          },
          productListingDeliveryOptions: {
            repository: listingRepository,
            accountNetworkLocalStateRepository:
              allowAllAccountNetworkLocalStateRepository,
            publisher: async () => {
              listingRelayAttempts += 1
              return { status: "acked" }
            },
          },
          deletionDeliveryOptions: {
            repository: deletionRepository,
            accountNetworkLocalStateRepository:
              allowAllAccountNetworkLocalStateRepository,
            restoreLocalEvidence: async () => {},
            publisher: async () => {
              deletionRelayAttempts += 1
              return { status: "acked" }
            },
          },
        },
        createProductListingRelayPlanningDependencies()
      )
    ).rejects.toThrow("Signed product event could not be delivered")

    const [stagedListing] = Array.from(listingStorage.values())
    expect(stagedListing?.readyForDelivery).toBe(false)
    expect(stagedListing?.companionDeletionJobId).toBeString()
    await resumePendingProductListingDeliveries({
      repository: new MemoryProductListingOutbox(listingStorage),
      accountNetworkLocalStateRepository:
        allowAllAccountNetworkLocalStateRepository,
      now: () => NOW + 10_000,
      retryDelayMs: 1,
      publisher: async () => {
        listingRelayAttempts += 1
        return { status: "acked" }
      },
    })

    expect(listingRelayAttempts).toBe(0)
    expect(deletionRelayAttempts).toBe(0)
    expect(onDeliveryQueuedCalls).toBe(0)
  })

  it("arms a reciprocal mixed mutation after reloading the staged crash window", async () => {
    const relayUrl = CANONICAL_APP_BACKPLANE_RELAYS[0]!
    const listingRepository = new MemoryProductListingOutbox()
    const deletionRepository = new MemoryProductDeletionOutbox()
    const signedListing = makeSignedProductEventWithShippingTags({
      dTag: "crash-window-replacement",
      shippingTags: [],
    }).rawEvent()
    const signedDeletion = makeSignedEvent(EVENT_KINDS.DELETION)
    const listingJob = await persistProductListingDelivery(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: [signedListing],
        relayTargets: [{ relayUrl, ownerSelected: false }],
        companionDeletionJobId: signedDeletion.id,
      },
      { repository: listingRepository, now: () => NOW }
    )
    await persistSignedProductDeletion(
      {
        signedEvent: signedDeletion,
        currentWriteRelayUrls: [relayUrl],
        sourceRelayUrls: [],
        companionListingJobId: listingJob.id,
      },
      { repository: deletionRepository, now: () => NOW }
    )
    const restored: string[] = []
    let listingAttempts = 0
    let deletionAttempts = 0

    await Promise.all([
      resumePendingProductListingDeliveries({
        repository: listingRepository,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        publisher: async () => {
          listingAttempts += 1
          return { status: "acked" }
        },
      }),
      resumePendingProductDeletionDeliveries({
        repository: deletionRepository,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        isCompanionListingReady: async (jobId, deletionId) => {
          const listing = await listingRepository.get(jobId)
          return (
            listing?.companionDeletionJobId === deletionId &&
            listing.readyForDelivery !== false
          )
        },
        restoreLocalEvidence: async () => {},
        publisher: async () => {
          deletionAttempts += 1
          return { status: "acked" }
        },
      }),
    ])

    expect(listingAttempts).toBe(0)
    expect(deletionAttempts).toBe(0)

    await resumeStagedProductListingDeliveries({
      repository: listingRepository,
      deletionDeliveryOptions: { repository: deletionRepository },
      restoreLocalListingEvidence: async (job) => {
        restored.push(...job.signedEvents.map(({ id }) => id))
      },
      restoreLocalDeletionEvidence: async (event) => {
        restored.push(event.id)
      },
      now: () => NOW + 1,
    })

    expect(restored).toEqual([signedListing.id, signedDeletion.id])
    expect((await listingRepository.get(listingJob.id))?.readyForDelivery).toBe(
      true
    )

    await Promise.all([
      resumePendingProductListingDeliveries({
        repository: listingRepository,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        restoreLocalEvidence: async () => {},
        publisher: async () => {
          listingAttempts += 1
          return { status: "acked" }
        },
      }),
      resumePendingProductDeletionDeliveries({
        repository: deletionRepository,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        isCompanionListingReady: async (jobId, deletionId) => {
          const listing = await listingRepository.get(jobId)
          return (
            listing?.companionDeletionJobId === deletionId &&
            listing.readyForDelivery !== false
          )
        },
        restoreLocalEvidence: async () => {},
        publisher: async () => {
          deletionAttempts += 1
          return { status: "acked" }
        },
      }),
    ])

    expect(listingAttempts).toBe(1)
    expect(deletionAttempts).toBeGreaterThan(0)
  })

  it("does not stage either mixed-mutation worker when the local commit fails", async () => {
    const listingStorage = new Map<string, ProductListingDeliveryJob>()
    const listingRepository = new MemoryProductListingOutbox(listingStorage)
    const deletionRepository = new MemoryProductDeletionOutbox()
    let listingAttempts = 0
    let deletionAttempts = 0
    setSigner(new NDKPrivateKeySigner(MERCHANT_SECRET))

    await expect(
      signAndPublishProductWriteBundle(
        {
          merchantPubkey: MERCHANT_PUBKEY,
          listings: [
            {
              product: makeProduct("local-commit-failure"),
              dTag: "local-commit-failure",
              fulfillmentIntent: { kind: "coordinate_after_order" },
            },
          ],
          deletions: buildProductRemovalDeletionTargets([
            {
              eventId: "f".repeat(64),
              addressId: `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:old`,
              sourceRelayUrls: [],
            },
          ]),
          onSignedLocal: async () => {
            throw new Error("local product commit failed")
          },
          productListingDeliveryOptions: {
            repository: listingRepository,
            accountNetworkLocalStateRepository:
              allowAllAccountNetworkLocalStateRepository,
            publisher: async () => {
              listingAttempts += 1
              return { status: "acked" }
            },
          },
          deletionDeliveryOptions: {
            repository: deletionRepository,
            accountNetworkLocalStateRepository:
              allowAllAccountNetworkLocalStateRepository,
            restoreLocalEvidence: async () => {},
            publisher: async () => {
              deletionAttempts += 1
              return { status: "acked" }
            },
          },
        },
        createProductListingRelayPlanningDependencies()
      )
    ).rejects.toThrow("Signed product event could not be delivered")

    expect(listingStorage.size).toBe(0)
    expect((await deletionRepository.listUndelivered()).length).toBe(0)
    await resumeStagedProductListingDeliveries({
      repository: listingRepository,
      deletionDeliveryOptions: { repository: deletionRepository },
      restoreLocalListingEvidence: async () => {},
      restoreLocalDeletionEvidence: async () => {},
    })
    await Promise.all([
      resumePendingProductListingDeliveries({
        repository: listingRepository,
        publisher: async () => {
          listingAttempts += 1
          return { status: "acked" }
        },
      }),
      resumePendingProductDeletionDeliveries({
        repository: deletionRepository,
        isCompanionListingReady: async (jobId, deletionId) => {
          const listing = await listingRepository.get(jobId)
          return (
            listing?.companionDeletionJobId === deletionId &&
            listing.readyForDelivery !== false
          )
        },
        restoreLocalEvidence: async () => {},
        publisher: async () => {
          deletionAttempts += 1
          return { status: "acked" }
        },
      }),
    ])

    expect(listingAttempts).toBe(0)
    expect(deletionAttempts).toBe(0)
  })

  it("finishes the local commit but stops before relay I/O when persistence fails", async () => {
    const repository = new MemoryProductListingOutbox()
    repository.add = async () => {
      throw new Error("listing outbox unavailable")
    }
    let onSignedLocalCalls = 0
    let onDeliveryQueuedCalls = 0
    let productRelayAttempts = 0
    setSigner(new NDKPrivateKeySigner(MERCHANT_SECRET))

    await expect(
      signAndPublishProductWriteBundle(
        {
          merchantPubkey: MERCHANT_PUBKEY,
          listings: [
            {
              product: makeProduct("persist-first"),
              dTag: "persist-first",
              fulfillmentIntent: { kind: "coordinate_after_order" },
            },
          ],
          onSignedLocal: async () => {
            onSignedLocalCalls += 1
          },
          onDeliveryQueued: async () => {
            onDeliveryQueuedCalls += 1
          },
          productListingDeliveryOptions: {
            repository,
            accountNetworkLocalStateRepository:
              allowAllAccountNetworkLocalStateRepository,
            publisher: async () => {
              productRelayAttempts += 1
              return { status: "acked" }
            },
          },
        },
        {
          planProductListingRelayTargets: async () => [
            { relayUrl: "wss://relay.example", ownerSelected: false },
          ],
        }
      )
    ).rejects.toThrow("Signed product event could not be delivered")

    expect(onSignedLocalCalls).toBe(1)
    expect(onDeliveryQueuedCalls).toBe(0)
    expect(productRelayAttempts).toBe(0)
  })

  it("exposes the exact retry only after its listing outbox is durable", async () => {
    const repository = new MemoryProductListingOutbox()
    let queuedBundle: SignedProductWriteBundle | null = null
    let productRelayAttempts = 0
    setSigner(new NDKPrivateKeySigner(MERCHANT_SECRET))

    const result = await signAndPublishProductWriteBundle(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        listings: [
          {
            product: makeProduct("queued-before-retry"),
            dTag: "queued-before-retry",
            fulfillmentIntent: { kind: "coordinate_after_order" },
          },
        ],
        onSignedLocal: async () => {},
        onDeliveryQueued: async (bundle) => {
          queuedBundle = bundle
          expect(bundle.productListingDeliveryJobId).toBeString()
          expect(
            await repository.get(bundle.productListingDeliveryJobId!)
          ).toMatchObject({
            id: bundle.productListingDeliveryJobId,
            readyForDelivery: true,
          })
          expect(productRelayAttempts).toBe(0)
        },
        productListingDeliveryOptions: {
          repository,
          accountNetworkLocalStateRepository:
            allowAllAccountNetworkLocalStateRepository,
          publisher: async () => {
            productRelayAttempts += 1
            return { status: "timed_out" }
          },
        },
      },
      {
        planProductListingRelayTargets: async () => [
          { relayUrl: "wss://relay.example", ownerSelected: false },
        ],
      }
    )

    expect(queuedBundle).not.toBeNull()
    expect(productRelayAttempts).toBe(1)
    expect(result.failedRelayUrls).toEqual(["wss://relay.example"])
  })

  it("serializes family event approvals through a non-reentrant signer", async () => {
    const delegate = new NDKPrivateKeySigner(MERCHANT_SECRET)
    const signedKinds: number[] = []
    const signerProgress: Array<{
      kind: string
      current: number
      total: number
    }> = []
    let signRequestInFlight = false
    const signer = {
      user: () => delegate.user(),
      sign: async (event: NostrEvent) => {
        if (signRequestInFlight) {
          throw new Error("signer rejected an overlapping approval request")
        }
        signRequestInFlight = true
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          signedKinds.push(event.kind)
          return await delegate.sign(event)
        } finally {
          signRequestInFlight = false
        }
      },
    } as NDKSigner
    setSigner(signer)
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: ["wss://relay.example"],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })
    const publishSpy = spyOn(NDKEvent.prototype, "publish").mockResolvedValue(
      new Set([{ url: "wss://relay.example/" }]) as never
    )
    let signerRequestsCompleteCalls = 0
    let signedKindsAtCompletion: number[] = []
    let publishCallsAtCompletion = -1

    try {
      await signAndPublishProductWriteBundle(
        {
          merchantPubkey: MERCHANT_PUBKEY,
          listings: ["family-a", "family-b"].map((dTag) => ({
            product: makeProduct(dTag),
            dTag,
            fulfillmentIntent: {
              kind: "fixed_standard" as const,
              amount: 5,
              currency: "SATS",
              countries: ["US"],
            },
          })),
          onSignerRequest: (progress) => signerProgress.push(progress),
          onSignerRequestsComplete: () => {
            signerRequestsCompleteCalls += 1
            signedKindsAtCompletion = [...signedKinds]
            publishCallsAtCompletion = publishSpy.mock.calls.length
          },
          onSignedLocal: async () => {},
          productListingDeliveryOptions:
            createAckedProductListingDeliveryOptions(),
        },
        createProductListingRelayPlanningDependencies()
      )

      expect(signedKinds).toEqual([
        EVENT_KINDS.SHIPPING_OPTION,
        EVENT_KINDS.PRODUCT,
        EVENT_KINDS.SHIPPING_OPTION,
        EVENT_KINDS.PRODUCT,
      ])
      expect(signerProgress).toEqual([
        { kind: "shipping", current: 1, total: 4 },
        { kind: "product", current: 2, total: 4 },
        { kind: "shipping", current: 3, total: 4 },
        { kind: "product", current: 4, total: 4 },
      ])
      expect(signerRequestsCompleteCalls).toBe(1)
      expect(signedKindsAtCompletion).toEqual(signedKinds)
      expect(publishCallsAtCompletion).toBe(0)
    } finally {
      publishSpy.mockRestore()
    }
  })

  it("does not dispatch the second product approval while the app is hidden", async () => {
    const delegate = new NDKPrivateKeySigner(MERCHANT_SECRET)
    const signedKinds: number[] = []
    const signerProgress: Array<{
      kind: string
      current: number
      total: number
    }> = []
    let visible = true
    let restoreVisibility = () => {}
    const visibleAgain = new Promise<void>((resolve) => {
      restoreVisibility = resolve
    })
    let visibilityChecks = 0
    setSigner({
      user: () => delegate.user(),
      sign: async (event: NostrEvent) => {
        signedKinds.push(event.kind)
        const signature = await delegate.sign(event)
        if (event.kind === EVENT_KINDS.SHIPPING_OPTION) visible = false
        return signature
      },
    } as NDKSigner)
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: ["wss://relay.example"],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })
    const publishSpy = spyOn(NDKEvent.prototype, "publish").mockResolvedValue(
      new Set([{ url: "wss://relay.example/" }]) as never
    )

    try {
      const publishing = signAndPublishProductWriteBundle(
        {
          merchantPubkey: MERCHANT_PUBKEY,
          listings: [
            {
              product: makeProduct("hidden-between-approvals"),
              dTag: "hidden-between-approvals",
              fulfillmentIntent: {
                kind: "fixed_standard",
                amount: 5,
                currency: "SATS",
                countries: ["US"],
              },
            },
          ],
          onSignerRequest: (progress) => signerProgress.push(progress),
          waitForSignerVisibility: async () => {
            visibilityChecks += 1
            if (!visible) await visibleAgain
          },
          onSignedLocal: async () => {},
          productListingDeliveryOptions:
            createAckedProductListingDeliveryOptions(),
        },
        createProductListingRelayPlanningDependencies()
      )

      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(signedKinds).toEqual([EVENT_KINDS.SHIPPING_OPTION])
      expect(signerProgress).toEqual([
        { kind: "shipping", current: 1, total: 2 },
        { kind: "product", current: 2, total: 2 },
      ])

      visible = true
      restoreVisibility()
      await publishing

      expect(signedKinds).toEqual([
        EVENT_KINDS.SHIPPING_OPTION,
        EVENT_KINDS.PRODUCT,
      ])
      expect(visibilityChecks).toBe(2)
    } finally {
      publishSpy.mockRestore()
    }
  })

  it("requires an explicit retry after signer recovery without duplicate delivery", async () => {
    const delegate = new NDKPrivateKeySigner(MERCHANT_SECRET)
    let signRequests = 0
    let signedLocalCalls = 0
    let listingDeliveryAttempts = 0
    const failedSigner = {
      user: () => delegate.user(),
      sign: async () => {
        signRequests += 1
        throw new RemoteSignerError(
          "timeout",
          "The remote signer timed out during sign event.",
          { operation: "sign event" }
        )
      },
    } as NDKSigner
    setSigner(failedSigner)
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: ["wss://relay.example"],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })
    const publishSpy = spyOn(NDKEvent.prototype, "publish").mockResolvedValue(
      new Set([{ url: "wss://relay.example/" }]) as never
    )
    const input = {
      merchantPubkey: MERCHANT_PUBKEY,
      listings: [
        {
          product: makeProduct("recovery-explicit-retry"),
          dTag: "recovery-explicit-retry",
          fulfillmentIntent: { kind: "coordinate_after_order" as const },
        },
      ],
      onSignedLocal: async () => {
        signedLocalCalls += 1
      },
      productListingDeliveryOptions: {
        repository: new MemoryProductListingOutbox(),
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        publisher: async () => {
          listingDeliveryAttempts += 1
          return { status: "acked" as const }
        },
      },
    }

    try {
      await expect(
        signAndPublishProductWriteBundle(
          input,
          createProductListingRelayPlanningDependencies()
        )
      ).rejects.toMatchObject({
        code: "timeout",
        operation: "sign event",
      })
      expect(signRequests).toBe(1)
      expect(signedLocalCalls).toBe(0)
      expect(listingDeliveryAttempts).toBe(0)
      expect(publishSpy).toHaveBeenCalledTimes(0)

      setSigner({
        user: () => delegate.user(),
        sign: async (event: NostrEvent) => {
          signRequests += 1
          return delegate.sign(event)
        },
      } as NDKSigner)

      // Restoring the signer is state repair only. Publication starts only
      // after the merchant explicitly submits the draft again.
      await Promise.resolve()
      expect(signRequests).toBe(1)
      expect(signedLocalCalls).toBe(0)
      expect(listingDeliveryAttempts).toBe(0)
      expect(publishSpy).toHaveBeenCalledTimes(0)

      await signAndPublishProductWriteBundle(
        input,
        createProductListingRelayPlanningDependencies()
      )
      expect(signRequests).toBe(2)
      expect(signedLocalCalls).toBe(1)
      expect(listingDeliveryAttempts).toBe(1)
      expect(publishSpy).toHaveBeenCalledTimes(0)
    } finally {
      publishSpy.mockRestore()
    }
  })

  it("keeps durable family-removal delivery on loopback in E2E isolation", async () => {
    const loopbackRelayUrl = "ws://127.0.0.1:7777"
    const previousConfig = structuredClone(config)
    const durableStorage = new Map<string, ProductDeletionDeliveryJob>()
    const repository = new MemoryProductDeletionOutbox(durableStorage)
    const attemptedDeletionRelayUrls: string[] = []
    let deletionDeliveryJobId = ""

    try {
      Object.assign(config, applyE2eRelayIsolation(config, [loopbackRelayUrl]))
      __setRelayPublishTestOverrides({
        planPublishRelays: async () => ({
          intent: "author_event",
          primaryRelayUrls: ["wss://saved-public.example", loopbackRelayUrl],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        }),
      })
      setSigner(new NDKPrivateKeySigner(MERCHANT_SECRET))

      await signAndPublishProductWriteBundle(
        {
          merchantPubkey: MERCHANT_PUBKEY,
          listings: [
            {
              product: makeProduct("root"),
              dTag: "root",
              fulfillmentIntent: { kind: "coordinate_after_order" },
            },
          ],
          deletions: buildProductRemovalDeletionTargets([
            {
              eventId: "e".repeat(64),
              addressId: `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:variation`,
              sourceRelayUrls: ["wss://source-public.example"],
            },
          ]),
          onSignedLocal: async (bundle) => {
            deletionDeliveryJobId = bundle.deletionDeliveryJobId ?? ""
            const listing = bundle.events.find(
              (event) => event.kind === EVENT_KINDS.PRODUCT
            )
            if (!listing) throw new Error("Expected a signed listing event")
            listing.publish = (async () =>
              new Set([{ url: `${loopbackRelayUrl}/` }])) as never
          },
          productListingDeliveryOptions:
            createAckedProductListingDeliveryOptions(),
          deletionDeliveryOptions: {
            repository,
            accountNetworkLocalStateRepository:
              allowAllAccountNetworkLocalStateRepository,
            now: () => NOW,
            retryDelayMs: 1,
            restoreLocalEvidence: async () => {},
            publisher: async ({ relayUrl }) => {
              attemptedDeletionRelayUrls.push(relayUrl)
              return { status: "timed_out" }
            },
          },
        },
        createProductListingRelayPlanningDependencies(loopbackRelayUrl)
      )

      const job = await repository.get(deletionDeliveryJobId)
      expect(config.e2eRelayIsolationEnabled).toBe(true)
      expect(config.appBackplaneRelayUrls).toEqual([loopbackRelayUrl])
      expect(job?.relayPlan.map((target) => target.relayUrl)).toEqual([
        loopbackRelayUrl,
      ])
      expect(job?.state).toBe("partial")

      const afterReload = new MemoryProductDeletionOutbox(durableStorage)
      await resumePendingProductDeletionDeliveries({
        repository: afterReload,
        accountNetworkLocalStateRepository:
          allowAllAccountNetworkLocalStateRepository,
        now: () => NOW + 10_000,
        retryDelayMs: 1,
        deliveryLeaseOwner: "after-isolated-reload",
        isCompanionListingReady: async () => true,
        restoreLocalEvidence: async () => {},
        publisher: async ({ relayUrl }) => {
          attemptedDeletionRelayUrls.push(relayUrl)
          return { status: "acked" }
        },
      })

      expect(attemptedDeletionRelayUrls).toEqual([
        loopbackRelayUrl,
        loopbackRelayUrl,
      ])
      expect((await afterReload.get(deletionDeliveryJobId))?.state).toBe(
        "delivered"
      )
    } finally {
      Object.assign(config, previousConfig)
    }
  })

  it("does not arm durable removal delivery before replacement listings are cached", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const signer = new NDKPrivateKeySigner(MERCHANT_SECRET)
    setSigner(signer)
    __setCommerceTestOverrides({
      putCachedProducts: async () => {
        throw new Error("listing cache unavailable")
      },
    })
    let onSignedLocalCalls = 0
    let deletionPublishAttempts = 0

    await expect(
      signAndPublishProductWriteBundle({
        merchantPubkey: MERCHANT_PUBKEY,
        listings: [
          {
            product: makeProduct("root"),
            dTag: "root",
            fulfillmentIntent: { kind: "coordinate_after_order" },
          },
        ],
        deletions: buildProductRemovalDeletionTargets([
          {
            eventId: "c".repeat(64),
            addressId: `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:variation`,
            sourceRelayUrls: ["wss://relay.damus.io"],
          },
        ]),
        onSignedLocal: async () => {
          onSignedLocalCalls += 1
        },
        deletionDeliveryOptions: {
          repository,
          accountNetworkLocalStateRepository:
            allowAllAccountNetworkLocalStateRepository,
          restoreLocalEvidence: async () => {},
          publisher: async () => {
            deletionPublishAttempts += 1
            return { status: "acked" }
          },
        },
      })
    ).rejects.toThrow("listing cache unavailable")

    expect(await repository.listUndelivered()).toEqual([])
    expect(onSignedLocalCalls).toBe(0)
    expect(deletionPublishAttempts).toBe(0)
  })

  it("stops the production bundle before product side effects when fixed shipping has no ACK", async () => {
    const repository = new MemoryProductDeletionOutbox()
    const publishAttempts: number[] = []
    let onSignedLocalCalls = 0
    setSigner(new NDKPrivateKeySigner(MERCHANT_SECRET))
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: ["wss://relay.example"],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })
    const publishSpy = spyOn(NDKEvent.prototype, "publish").mockImplementation(
      async function (this: NDKEvent) {
        publishAttempts.push(this.kind ?? -1)
        return new Set()
      }
    )

    try {
      await expect(
        signAndPublishProductWriteBundle({
          merchantPubkey: MERCHANT_PUBKEY,
          listings: [
            {
              product: makeProduct("root"),
              dTag: "root",
              fulfillmentIntent: {
                kind: "fixed_standard",
                amount: 5,
                currency: "SATS",
                countries: ["US"],
              },
            },
          ],
          deletions: buildProductRemovalDeletionTargets([
            {
              eventId: "c".repeat(64),
              addressId: `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:variation`,
              sourceRelayUrls: ["wss://relay.damus.io"],
            },
          ]),
          onSignedLocal: async () => {
            onSignedLocalCalls += 1
          },
          deletionDeliveryOptions: {
            repository,
            accountNetworkLocalStateRepository:
              allowAllAccountNetworkLocalStateRepository,
            restoreLocalEvidence: async () => {},
            publisher: async () => ({ status: "acked" }),
          },
        })
      ).rejects.toThrow("Product publication was stopped.")

      expect(publishAttempts).toEqual([EVENT_KINDS.SHIPPING_OPTION])
      expect(cachedProducts).toEqual([])
      expect(await repository.listUndelivered()).toEqual([])
      expect(onSignedLocalCalls).toBe(0)
    } finally {
      publishSpy.mockRestore()
    }
  })

  it("rejects a durable deletion job without the exact merchant event", async () => {
    const repository = new MemoryProductDeletionOutbox()

    await expect(
      deliverSignedProductWriteBundle(
        {
          events: [],
          deletionDeliveryJobId: "d".repeat(64),
        },
        MERCHANT_PUBKEY,
        { repository }
      )
    ).rejects.toThrow("exact signed merchant deletion")

    const otherMerchantPubkey = getPublicKey(OTHER_MERCHANT_SECRET)
    const wrongMerchantDeletion = new NDKEvent(
      undefined,
      finalizeEvent(
        {
          kind: EVENT_KINDS.DELETION,
          created_at: Math.floor(NOW / 1000),
          content: "Listing removed",
          tags: [
            ["a", `${EVENT_KINDS.PRODUCT}:${otherMerchantPubkey}:variation`],
          ],
        },
        OTHER_MERCHANT_SECRET
      )
    )

    await expect(
      deliverSignedProductWriteBundle(
        {
          events: [wrongMerchantDeletion],
          deletionDeliveryJobId: wrongMerchantDeletion.id,
        },
        MERCHANT_PUBKEY,
        { repository }
      )
    ).rejects.toThrow("exact signed merchant deletion")
  })
})

function publishResult(
  successfulRelayUrls: string[]
): PublishWithPlannerResult {
  return {
    plan: {
      intent: "author_event",
      primaryRelayUrls: [],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    },
    attemptedRelayUrls: ["wss://relay.example"],
    successfulRelayUrls,
    failedRelayUrls: [],
    relayFailureMessages: {},
  }
}

function event(kind: number): NDKEvent {
  return { kind } as NDKEvent
}

describe("canonical product publication ordering", () => {
  it("upgrades a legacy inline listing to the product-scoped coordinate", () => {
    const legacy = parseProductEvent({
      id: "legacy-event",
      pubkey: MERCHANT_PUBKEY,
      created_at: 1_700_000_100,
      content: "Legacy listing",
      tags: [
        ["d", "listing"],
        ["title", "Listing"],
        ["price", "10", "USD"],
        ["type", "simple", "physical"],
        ["shipping_cost", "5", "USD"],
        ["shipping_country", "US"],
      ],
    })

    const prepared = applyProductFulfillmentIntentForPublication({
      product: legacy,
      merchantPubkey: MERCHANT_PUBKEY,
      productDTag: "listing",
      intent: {
        kind: "fixed_standard",
        amount: 5,
        currency: "USD",
        countries: ["US"],
      },
    })

    expect(prepared).toMatchObject({
      shippingOptionId: `30406:${MERCHANT_PUBKEY}:listing-shipping-standard`,
      shippingOptionDTag: "listing-shipping-standard",
      shippingCountries: ["US"],
      shippingCountryRules: [
        { code: "US", name: "US", restrictTo: [], exclude: [] },
      ],
    })
  })

  it("requires a shipping ACK before caching or publishing the product", async () => {
    const calls: string[] = []
    const productEvent = event(30402)
    const variationEvent = event(30402)
    const shippingEvent = event(30406)
    const variationShippingEvent = event(30406)
    const dependencies: CanonicalProductPublishDependencies = {
      publishShippingEvent: async () => {
        calls.push("shipping_ack")
        return publishResult(["wss://relay.example"])
      },
      cacheEvent: async () => {
        calls.push("product_cache")
      },
      deliverEvents: async () => {
        calls.push("product_publish")
        return publishResult(["wss://relay.example"])
      },
    }

    await publishCanonicalProductEvents(
      {
        writes: [
          { productEvent, shippingEvent },
          {
            productEvent: variationEvent,
            shippingEvent: variationShippingEvent,
          },
        ],
        events: [productEvent, variationEvent],
        merchantPubkey: "merchant",
        onSignedLocal: async () => {
          calls.push("product_local")
        },
      },
      dependencies
    )

    expect(calls).toEqual([
      "shipping_ack",
      "shipping_ack",
      "product_cache",
      "product_cache",
      "product_local",
      "product_publish",
    ])
  })

  it("stops before every product side effect when shipping has no ACK", async () => {
    const calls: string[] = []
    const dependencies: CanonicalProductPublishDependencies = {
      publishShippingEvent: async () => {
        calls.push("shipping_attempt")
        return publishResult([])
      },
      cacheEvent: async () => {
        calls.push("product_cache")
      },
      deliverEvents: async () => {
        calls.push("product_publish")
        return publishResult(["wss://relay.example"])
      },
    }

    await expect(
      publishCanonicalProductEvents(
        {
          writes: [{ productEvent: event(30402), shippingEvent: event(30406) }],
          events: [event(30402)],
          merchantPubkey: "merchant",
          onSignedLocal: async () => {
            calls.push("product_local")
          },
        },
        dependencies
      )
    ).rejects.toThrow("Product publication was stopped.")
    expect(calls).toEqual(["shipping_attempt"])
  })

  it("publishes non-fixed products without a shipping event", async () => {
    const calls: string[] = []
    const dependencies: CanonicalProductPublishDependencies = {
      publishShippingEvent: async () => {
        calls.push("unexpected_shipping")
        return publishResult([])
      },
      cacheEvent: async () => {
        calls.push("product_cache")
      },
      deliverEvents: async () => {
        calls.push("product_publish")
        return publishResult(["wss://relay.example"])
      },
    }

    await publishCanonicalProductEvents(
      {
        writes: [{ productEvent: event(30402), shippingEvent: null }],
        events: [event(30402)],
        merchantPubkey: "merchant",
        onSignedLocal: async () => {
          calls.push("product_local")
        },
      },
      dependencies
    )

    expect(calls).toEqual(["product_cache", "product_local", "product_publish"])
  })

  it("removes legacy shipping fields from non-fixed publication state", () => {
    const product = parseProductEvent({
      id: "legacy-event",
      pubkey: MERCHANT_PUBKEY,
      created_at: 1_700_000_100,
      content: "Legacy listing",
      tags: [
        ["d", "listing"],
        ["title", "Listing"],
        ["price", "10", "USD"],
        ["type", "simple", "physical"],
        ["shipping_cost", "5", "USD"],
        ["shipping_country", "US"],
      ],
    })

    expect(
      applyProductFulfillmentIntentForPublication({
        product,
        merchantPubkey: MERCHANT_PUBKEY,
        productDTag: "listing",
        intent: { kind: "coordinate_after_order" },
      })
    ).toMatchObject({
      shippingCostSats: undefined,
      sourceShippingCost: undefined,
      shippingOptionId: undefined,
      shippingCountries: undefined,
      canonicalShippingResolved: false,
    })
  })

  it("preserves signed event pickup references while publishing a stock update", () => {
    const collectionCoordinate = `30405:${MERCHANT_PUBKEY}:event`
    const pickupCoordinate = `30406:${MERCHANT_PUBKEY}:event-pickup`
    const product = {
      ...makeProduct("event-listing"),
      stock: 1,
      collectionRefs: [collectionCoordinate],
      shippingOptionId: pickupCoordinate,
      shippingOptionRefs: [
        {
          coordinate: pickupCoordinate,
          relayHints: ["wss://relay.example"],
        },
      ],
      canonicalShippingResolved: false,
    }

    const intent = resolvePublishedProductFulfillmentIntentForTarget(product)
    expect(intent).toEqual({ kind: "coordinate_after_order" })

    const { prepared, parsed } = publishAndParse(
      { ...product, stock: 0 },
      "event-listing",
      intent!
    )
    expect(prepared).toMatchObject({
      stock: 0,
      collectionRefs: [collectionCoordinate],
      shippingOptionId: pickupCoordinate,
      shippingOptionRefs: [
        {
          coordinate: pickupCoordinate,
          relayHints: ["wss://relay.example"],
        },
      ],
      canonicalShippingResolved: false,
    })

    expect(parsed).toMatchObject({
      stock: 0,
      collectionRefs: [collectionCoordinate],
      shippingOptionId: pickupCoordinate,
      shippingOptionRefs: [
        {
          coordinate: pickupCoordinate,
          dTag: "event-pickup",
        },
      ],
    })
  })

  it("preserves a collection-level pickup reference while publishing stock", () => {
    const collectionCoordinate = `30405:${MERCHANT_PUBKEY}:event`
    const product = {
      ...makeProduct("collection-pickup-listing"),
      stock: 0,
      collectionRefs: [collectionCoordinate],
      shippingOptionId: collectionCoordinate,
      shippingOptionRefs: [{ coordinate: collectionCoordinate }],
      canonicalShippingResolved: false,
    }
    const { parsed } = publishAndParse(product, "collection-pickup-listing", {
      kind: "coordinate_after_order",
    })

    expect(parsed).toMatchObject({
      stock: 0,
      collectionRefs: [collectionCoordinate],
      shippingOptionId: collectionCoordinate,
      shippingOptionRefs: [{ coordinate: collectionCoordinate, dTag: "event" }],
    })
  })

  it("uses a variation's fixed shipping override under an order-first root", () => {
    expect(
      resolveProductFulfillmentIntentForTarget({
        product: {
          format: "physical",
          sourceShippingCost: {
            amount: 12.34,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        },
        fallbackIntent: { kind: "coordinate_after_order" },
        authoringCountries: ["CA"],
      })
    ).toEqual({
      kind: "fixed_standard",
      amount: 12.34,
      currency: "USD",
      countries: ["CA"],
    })
  })

  it("fails closed instead of widening legacy postal rules to a country", () => {
    const product = {
      format: "physical" as const,
      shippingCostSats: 250,
      shippingCountries: ["US"],
      shippingCountryRules: [
        {
          code: "US",
          name: "United States",
          restrictTo: ["787**"],
          exclude: ["78799"],
        },
      ],
    }

    expect(() =>
      resolveProductFulfillmentIntentForTarget({
        product,
        fallbackIntent: { kind: "coordinate_after_order" },
        authoringCountries: ["US"],
      })
    ).toThrow("Remove postal restrictions")
    expect(
      resolvePublishedProductFulfillmentIntentForTarget(product)
    ).toBeNull()
  })

  it("fails closed when a fixed variation has no shipping destinations", () => {
    expect(() =>
      resolveProductFulfillmentIntentForTarget({
        product: { format: "physical", shippingCostSats: 250 },
        fallbackIntent: { kind: "coordinate_after_order" },
        authoringCountries: [],
      })
    ).toThrow("Fixed variation shipping requires at least one valid country")
  })
})
