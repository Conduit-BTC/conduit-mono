import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
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
  EVENT_KINDS,
  getCachedMerchantStorefront,
  parseProductEvent,
  planProductDeletionRelays,
  setSigner,
  type ProductDeletionOutboxRepository,
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
  isDeliverableMerchantProductEvent,
  publishCanonicalProductEvents,
  resolveProductFulfillmentIntentForTarget,
  resolvePublishedProductFulfillmentIntentForTarget,
  signAndPublishProductWriteBundle,
  type CanonicalProductPublishDependencies,
  type SignedProductWriteBundle,
} from "../apps/merchant/src/lib/product-publishing"
import { resumePendingProductDeletionDeliveries } from "../apps/merchant/src/lib/product-deletion-delivery"
import { __resetNdkTestState } from "../packages/core/src/protocol/ndk"

const MERCHANT_SECRET = new Uint8Array(32).fill(4)
const OTHER_MERCHANT_SECRET = new Uint8Array(32).fill(5)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const NOW = 1_700_000_100_000

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
    const delivery = await signAndPublishProductWriteBundle({
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
      deletionDeliveryOptions: {
        repository: beforeReload,
        now: () => NOW,
        retryDelayMs: 1,
        restoreLocalEvidence: async () => {},
        publisher: async ({ relayUrl }) =>
          relayUrl === deletionPendingRelayUrl
            ? { status: "timed_out" }
            : { status: "acked" },
      },
    })
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
      now: () => NOW + 10_000,
      retryDelayMs: 1,
      deliveryLeaseOwner: "after-reload",
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

      await signAndPublishProductWriteBundle({
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
        deletionDeliveryOptions: {
          repository,
          now: () => NOW,
          retryDelayMs: 1,
          restoreLocalEvidence: async () => {},
          publisher: async ({ relayUrl }) => {
            attemptedDeletionRelayUrls.push(relayUrl)
            return { status: "timed_out" }
          },
        },
      })

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
        now: () => NOW + 10_000,
        retryDelayMs: 1,
        deliveryLeaseOwner: "after-isolated-reload",
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
