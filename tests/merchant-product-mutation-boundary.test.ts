import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetRelayPublishTestOverrides,
  __setCommerceTestOverrides,
  __setRelayPublishTestOverrides,
  buildProductListingEventDraft,
  getProductShippingOptionAddress,
  setSigner,
  type ParsedShippingOption,
  type ProductSchema,
} from "@conduit/core"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
} from "../packages/core/src/protocol/event-market"
import { __resetNdkTestState } from "../packages/core/src/protocol/ndk"
import {
  applyProductFulfillmentIntentForPublication,
  getProductPreservedFulfillmentFields,
  signAndPublishProductWriteBundle,
  type ProductListingPublishTarget,
  type ProductPublicationDependencies,
  type ProductSignerRequestProgress,
} from "../apps/merchant/src/lib/product-publishing"
import {
  MAX_PRODUCT_VARIATION_COUNT,
  buildProductFamilyChangePlan,
  createEmptyProductVariationForm,
  getProductVariationFormError,
  getProductVariationFormState,
  type ProductListingRecordLike,
} from "../apps/merchant/src/lib/productVariations"

const SECRET = generateSecretKey()
const MERCHANT = getPublicKey(SECRET)
const ORGANIZER = "b".repeat(64)
const START = 1_800_000_000_000

function product(
  dTag = "listing",
  overrides: Partial<ProductSchema> = {}
): ProductSchema {
  const pickup = `30406:${ORGANIZER}:${dTag}`
  return {
    id: `30402:${MERCHANT}:${dTag}`,
    pubkey: MERCHANT,
    title: "Merchant listing",
    price: 100,
    currency: "SATS",
    type: "simple",
    specifications: [],
    format: "physical",
    visibility: "private",
    stock: 10,
    images: [{ url: "https://example.com/product.png" }],
    tags: ["one", "two", "three"],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: START - 100_000,
    updatedAt: START - 100_000,
    collectionRefs: [`30405:${ORGANIZER}:market`],
    shippingOptionId: pickup,
    shippingOptionDTag: dTag,
    shippingOptionRefs: [{ coordinate: pickup }],
    canonicalShippingResolved: false,
    shippingOptionLaunchUnsupported: true,
    ...overrides,
  }
}

function record(value: ProductSchema): ProductListingRecordLike {
  return {
    product: value,
    addressId: value.id,
    dTag: value.id.split(":").slice(2).join(":"),
    eventId: "a".repeat(64),
    eventCreatedAt: Math.floor(value.updatedAt / 1000),
  }
}

function plan(
  baseline: ProductSchema,
  update: Partial<ProductSchema>,
  now = START
) {
  return buildProductFamilyChangePlan({
    baseProduct: { ...baseline, ...update },
    parentDTag: record(baseline).dTag!,
    variations: createEmptyProductVariationForm(),
    currency: baseline.currency,
    fulfillmentIntent: { kind: "preserve_existing", baseline },
    authoringCountries: [],
    existing: {
      root: record(baseline),
      variations: [],
      orphanVariation: false,
    },
    now,
  })
}

function canonicalProduct(
  dTag = "listing",
  overrides: Partial<ProductSchema> = {}
): ProductSchema {
  const shippingOptionId = getProductShippingOptionAddress(MERCHANT, dTag)
  return product(dTag, {
    visibility: "public",
    collectionRefs: undefined,
    shippingOptionId,
    shippingOptionDTag: `${dTag}-shipping-standard`,
    shippingOptionRefs: [{ coordinate: shippingOptionId }],
    canonicalShippingResolved: false,
    shippingOptionLaunchUnsupported: false,
    ...overrides,
  })
}

function shippingOption(
  baseline: ProductSchema,
  overrides: Partial<ParsedShippingOption> = {}
): ParsedShippingOption {
  return {
    eventId: "c".repeat(64),
    id: baseline.shippingOptionId!,
    pubkey: MERCHANT,
    dTag: baseline.shippingOptionDTag!,
    title: "Standard Shipping",
    currency: baseline.currency,
    price: 5,
    countries: ["US"],
    countryRules: [{ code: "US", name: "US", restrictTo: [], exclude: [] }],
    service: "standard",
    createdAt: baseline.updatedAt - 1,
    launchUnsupportedTags: [],
    ...overrides,
  }
}

interface PublicationObservation {
  signerRequests: ProductSignerRequestProgress[]
  publishedKinds: number[]
  signedBundleCount: number
  signedEvents?: NDKEvent[]
}

async function attemptProductPublication(input: {
  listings: readonly ProductListingPublishTarget[]
  getShippingOptions?: ProductPublicationDependencies["getShippingOptions"]
  observed?: PublicationObservation
}): Promise<void> {
  setSigner(new NDKPrivateKeySigner(SECRET))
  __setCommerceTestOverrides({
    now: () => START,
    getCachedProducts: async () => [],
    getCachedProductTombstones: async () => [],
    putCachedProducts: async () => {},
  })
  __setRelayPublishTestOverrides({
    accountNetworkLocalStateRepository: { get: async () => undefined },
    planPublishRelays: async () => ({
      intent: "author_event",
      primaryRelayUrls: ["wss://relay.example"],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    }),
  })
  const publish = spyOn(NDKEvent.prototype, "publish").mockImplementation(
    async function (this: NDKEvent) {
      if (typeof this.kind === "number") {
        input.observed?.publishedKinds.push(this.kind)
      }
      return new Set([{ url: "wss://relay.example/" }]) as never
    }
  )
  try {
    await signAndPublishProductWriteBundle(
      {
        merchantPubkey: MERCHANT,
        listings: input.listings,
        waitForSignerVisibility: async () => {},
        onSignerRequest: (progress) =>
          input.observed?.signerRequests.push(progress),
        onSignedLocal: async ({ events }) => {
          if (input.observed) {
            input.observed.signedBundleCount += 1
            input.observed.signedEvents?.push(...events)
          }
        },
      },
      {
        getShippingOptions: input.getShippingOptions ?? (async () => []),
      }
    )
  } finally {
    publish.mockRestore()
  }
}

async function attemptPreservedPublication(input: {
  baseline: ProductSchema
  update: Partial<ProductSchema>
  options?: ParsedShippingOption[]
  observed?: PublicationObservation
}): Promise<void> {
  const change = plan(input.baseline, input.update)
  await attemptProductPublication({
    listings: change.publish.map((target) => ({
      ...target,
      previousEventCreatedAt: target.existing!.eventCreatedAt,
    })),
    getShippingOptions: async () => input.options ?? [],
    observed: input.observed,
  })
}

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayPublishTestOverrides()
  __resetEventMarketTestOverrides()
  __resetNdkTestState()
})

describe("merchant-owned product mutation boundary", () => {
  for (const now of [START - 1, START, START + 1, START + 86_400_000]) {
    for (const networkState of ["delayed", "unavailable"] as const) {
      it(`signs only the merchant stock edit at ${now - START}ms with ${networkState} organizer evidence`, async () => {
        let graphReads = 0
        __setEventMarketTestOverrides({
          fetchEventsFanoutDetailed: async () => {
            graphReads += 1
            if (networkState === "unavailable")
              throw new Error("Organizer unavailable")
            return await new Promise<never>(() => {})
          },
          getRelayListsDetailed: async () => {
            graphReads += 1
            throw new Error("Organizer relay discovery must not run")
          },
        })
        __setCommerceTestOverrides({
          now: () => now,
          getCachedProducts: async () => [],
          getCachedProductTombstones: async () => [],
          putCachedProducts: async () => {},
        })
        __setRelayPublishTestOverrides({
          accountNetworkLocalStateRepository: { get: async () => undefined },
          planPublishRelays: async () => ({
            intent: "author_event",
            primaryRelayUrls: ["wss://relay.example"],
            broadcastRelayUrls: [],
            parkedRelayUrls: [],
          }),
        })
        setSigner(new NDKPrivateKeySigner(SECRET))
        const clock = spyOn(Date, "now").mockReturnValue(now)
        const publish = spyOn(NDKEvent.prototype, "publish").mockResolvedValue(
          new Set([{ url: "wss://relay.example/" }]) as never
        )
        const baseline = product()
        const change = plan(baseline, { stock: 4 }, now)
        const signed: NDKEvent[] = []
        try {
          await signAndPublishProductWriteBundle({
            merchantPubkey: MERCHANT,
            listings: change.publish.map((target) => ({
              ...target,
              previousEventCreatedAt: target.existing!.eventCreatedAt,
            })),
            waitForSignerVisibility: async () => {},
            onSignedLocal: async (bundle) => {
              signed.push(...bundle.events)
            },
          })
          expect(graphReads).toBe(0)
          expect(signed).toHaveLength(1)
          expect(signed[0]!.kind).toBe(30402)
          expect(signed[0]!.pubkey).toBe(MERCHANT)
          expect(signed[0]!.tags).toContainEqual(["stock", "4"])
          expect(signed[0]!.tags).toContainEqual([
            "a",
            baseline.collectionRefs![0]!,
          ])
          expect(signed[0]!.tags).toContainEqual([
            "shipping_option",
            baseline.shippingOptionId!,
          ])
          expect(signed[0]!.tags).toContainEqual(["visibility", "hidden"])
          expect(signed[0]!.created_at).toBeGreaterThan(
            record(baseline).eventCreatedAt
          )
          expect(publish).toHaveBeenCalledTimes(1)
        } finally {
          publish.mockRestore()
          clock.mockRestore()
        }
      })
    }
  }

  it("stops before signing when a canonical shipping revision is newer than the listing", async () => {
    const baseline = canonicalProduct()
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
    }
    await expect(
      attemptPreservedPublication({
        baseline,
        update: { stock: 4 },
        options: [
          shippingOption(baseline, { createdAt: baseline.updatedAt + 1 }),
        ],
        observed,
      })
    ).rejects.toThrow("changed since this listing was published")
    expect(observed).toEqual({
      signerRequests: [],
      publishedKinds: [],
      signedBundleCount: 0,
    })
  })

  it("stops before signing when a preserved canonical listing changes currency units", async () => {
    const baseline = canonicalProduct()
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
    }
    await expect(
      attemptPreservedPublication({
        baseline,
        update: {
          currency: "USD",
          sourcePrice: {
            amount: 100,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        },
        options: [shippingOption(baseline)],
        observed,
      })
    ).rejects.toThrow("Change fulfillment before changing currency")
    expect(observed).toEqual({
      signerRequests: [],
      publishedKinds: [],
      signedBundleCount: 0,
    })
  })

  it("stops before signing instead of stripping legacy inline shipping", async () => {
    const baseline = product("legacy", {
      collectionRefs: undefined,
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
      shippingOptionRefs: undefined,
      shippingOptionLaunchUnsupported: undefined,
      sourceShippingCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      shippingCountries: ["US"],
      currency: "USD",
    })
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
    }
    await expect(
      attemptPreservedPublication({
        baseline,
        update: { stock: 4 },
        observed,
      })
    ).rejects.toThrow("upgrade legacy shipping")
    expect(observed).toEqual({
      signerRequests: [],
      publishedKinds: [],
      signedBundleCount: 0,
    })
  })

  it("stops before signing for mixed or ambiguous canonical references", async () => {
    const canonical = canonicalProduct()
    const unsafeBaselines = [
      canonicalProduct("repeated", {
        shippingOptionRefs: [
          { coordinate: getProductShippingOptionAddress(MERCHANT, "repeated") },
          { coordinate: getProductShippingOptionAddress(MERCHANT, "repeated") },
        ],
      }),
      canonicalProduct("extra", {
        shippingOptionRefs: [
          {
            coordinate: getProductShippingOptionAddress(MERCHANT, "extra"),
            extraCost: {
              amount: 1,
              currency: "SATS",
              normalizedCurrency: "SATS",
            },
          },
        ],
      }),
    ]

    for (const baseline of unsafeBaselines) {
      const observed = {
        signerRequests: [] as ProductSignerRequestProgress[],
        publishedKinds: [] as number[],
        signedBundleCount: 0,
      }
      await expect(
        attemptPreservedPublication({
          baseline,
          update: { stock: 4 },
          options: [shippingOption(canonical)],
          observed,
        })
      ).rejects.toThrow("cannot be preserved safely")
      expect(observed).toEqual({
        signerRequests: [],
        publishedKinds: [],
        signedBundleCount: 0,
      })
    }
  })

  it("republishes current canonical shipping before the preserved product", async () => {
    const baseline = canonicalProduct()
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
    }
    await attemptPreservedPublication({
      baseline,
      update: { stock: 4 },
      options: [shippingOption(baseline)],
      observed,
    })
    expect(observed).toEqual({
      signerRequests: [
        { kind: "shipping", current: 1, total: 2 },
        { kind: "product", current: 2, total: 2 },
      ],
      publishedKinds: [30406, 30402],
      signedBundleCount: 1,
    })
  })

  it("preserves catalog references while republishing canonical shipping", async () => {
    const collectionRefs = [
      `30405:${ORGANIZER}:market`,
      `30405:${ORGANIZER}:secondary-market`,
    ]
    const baseline = canonicalProduct("cataloged", { collectionRefs })
    const signedEvents: NDKEvent[] = []
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
      signedEvents,
    }
    await attemptPreservedPublication({
      baseline,
      update: { stock: 4 },
      options: [shippingOption(baseline)],
      observed,
    })

    expect(observed.publishedKinds).toEqual([30406, 30402])
    const productEvent = signedEvents.find((event) => event.kind === 30402)
    expect(productEvent).toBeDefined()
    expect(productEvent!.tags.filter(([name]) => name === "a")).toEqual(
      collectionRefs.map((coordinate) => ["a", coordinate])
    )
    expect(
      productEvent!.tags.filter(([name]) => name === "shipping_option")
    ).toEqual([["shipping_option", baseline.shippingOptionId!]])
  })

  it("batches canonical preparation for a maximum-size variation family", async () => {
    const baselines = Array.from(
      { length: MAX_PRODUCT_VARIATION_COUNT + 1 },
      (_, index) => canonicalProduct(`family-${index}`)
    )
    const requestedCoordinates: string[][] = []
    const signedEvents: NDKEvent[] = []
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
      signedEvents,
    }

    await attemptProductPublication({
      listings: baselines.map((baseline) => ({
        product: { ...baseline, stock: 4 },
        dTag: record(baseline).dTag!,
        previousEventCreatedAt: record(baseline).eventCreatedAt,
        fulfillmentIntent: { kind: "preserve_existing", baseline },
      })),
      getShippingOptions: async (coordinates) => {
        requestedCoordinates.push([...coordinates])
        return baselines.map((baseline) => shippingOption(baseline))
      },
      observed,
    })

    expect(requestedCoordinates).toEqual([
      baselines.map((baseline) => baseline.shippingOptionId!),
    ])
    expect(observed.signerRequests).toHaveLength(baselines.length * 2)
    expect(observed.signedBundleCount).toBe(1)
    const productEvents = signedEvents.filter((event) => event.kind === 30402)
    expect(productEvents).toHaveLength(baselines.length)
    for (const baseline of baselines) {
      const dTag = record(baseline).dTag!
      const event = productEvents.find((candidate) =>
        candidate.tags.some(([name, value]) => name === "d" && value === dTag)
      )
      expect(event).toBeDefined()
      expect(
        event!.tags.filter(([name]) => name === "shipping_option")
      ).toEqual([["shipping_option", baseline.shippingOptionId!]])
    }
  })

  it("rejects a missing option in a maximum-size family before signing", async () => {
    const baselines = Array.from(
      { length: MAX_PRODUCT_VARIATION_COUNT + 1 },
      (_, index) => canonicalProduct(`missing-family-${index}`)
    )
    const requestedCoordinates: string[][] = []
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
    }

    await expect(
      attemptProductPublication({
        listings: baselines.map((baseline) => ({
          product: { ...baseline, stock: 4 },
          dTag: record(baseline).dTag!,
          previousEventCreatedAt: record(baseline).eventCreatedAt,
          fulfillmentIntent: { kind: "preserve_existing", baseline },
        })),
        getShippingOptions: async (coordinates) => {
          requestedCoordinates.push([...coordinates])
          return baselines
            .slice(0, -1)
            .map((baseline) => shippingOption(baseline))
        },
        observed,
      })
    ).rejects.toThrow("could not be verified safely")

    expect(requestedCoordinates).toEqual([
      baselines.map((baseline) => baseline.shippingOptionId!),
    ])
    expect(observed).toEqual({
      signerRequests: [],
      publishedKinds: [],
      signedBundleCount: 0,
    })
  })

  it("preserves an event pickup alongside independent catalog membership", async () => {
    const collectionRefs = [
      `30405:${ORGANIZER}:market`,
      `30405:${ORGANIZER}:independent-catalog`,
    ]
    const baseline = product("cataloged-event", { collectionRefs })
    const signedEvents: NDKEvent[] = []
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
      signedEvents,
    }

    await attemptPreservedPublication({
      baseline,
      update: { title: "Updated title", stock: 4 },
      observed,
    })

    expect(observed.publishedKinds).toEqual([30402])
    const productEvent = signedEvents.find((event) => event.kind === 30402)
    expect(productEvent).toBeDefined()
    expect(productEvent!.tags.filter(([name]) => name === "a")).toEqual(
      collectionRefs.map((coordinate) => ["a", coordinate])
    )
    expect(
      productEvent!.tags.filter(([name]) => name === "shipping_option")
    ).toEqual([["shipping_option", baseline.shippingOptionId!]])
    expect(productEvent!.tags).toContainEqual(["visibility", "hidden"])
  })

  it("preserves a valid event-pickup extra cost without a shipping read", async () => {
    const baseline = product("event-extra", {
      shippingOptionRefs: [
        {
          coordinate: `30406:${ORGANIZER}:event-extra`,
          extraCost: {
            amount: 0,
            currency: "SATS",
            normalizedCurrency: "SATS",
          },
        },
      ],
      shippingOptionId: `30406:${ORGANIZER}:event-extra`,
      sourceShippingCost: {
        amount: 0,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    })
    let shippingReads = 0
    setSigner(new NDKPrivateKeySigner(SECRET))
    __setCommerceTestOverrides({
      now: () => START,
      getCachedProducts: async () => [],
      getCachedProductTombstones: async () => [],
      putCachedProducts: async () => {},
    })
    __setRelayPublishTestOverrides({
      accountNetworkLocalStateRepository: { get: async () => undefined },
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: ["wss://relay.example"],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })
    const publish = spyOn(NDKEvent.prototype, "publish").mockResolvedValue(
      new Set([{ url: "wss://relay.example/" }]) as never
    )
    try {
      const change = plan(baseline, { stock: 4 })
      const signed: NDKEvent[] = []
      await signAndPublishProductWriteBundle(
        {
          merchantPubkey: MERCHANT,
          listings: change.publish.map((target) => ({
            ...target,
            previousEventCreatedAt: target.existing!.eventCreatedAt,
          })),
          waitForSignerVisibility: async () => {},
          onSignedLocal: async ({ events }) => signed.push(...events),
        },
        {
          getShippingOptions: async () => {
            shippingReads += 1
            return []
          },
        }
      )
      expect(shippingReads).toBe(0)
      expect(signed).toHaveLength(1)
      expect(signed[0]!.tags).toContainEqual([
        "shipping_option",
        baseline.shippingOptionId!,
        "0",
      ])
    } finally {
      publish.mockRestore()
    }
  })

  it("preserves reference extras and unresolved network projections through the actual draft", () => {
    const baseline = product("listing", {
      shippingOptionRefs: [
        {
          coordinate: `30406:${ORGANIZER}:pickup`,
          extraCost: {
            amount: 3,
            currency: "SATS",
            normalizedCurrency: "SATS",
          },
        },
        {
          coordinate: `30405:${ORGANIZER}:market`,
          extraCost: {
            amount: 3,
            currency: "SATS",
            normalizedCurrency: "SATS",
          },
        },
      ],
      shippingCountries: ["US"],
      shippingOptionCreatedAt: 123,
    })
    const target = plan(baseline, { title: "Updated title", stock: 0 })
      .publish[0]!
    const prepared = applyProductFulfillmentIntentForPublication({
      product: target.product,
      merchantPubkey: MERCHANT,
      productDTag: target.dTag,
      intent: target.fulfillmentIntent,
    })
    expect(getProductPreservedFulfillmentFields(prepared)).toEqual(
      getProductPreservedFulfillmentFields(baseline)
    )
    const draft = buildProductListingEventDraft({
      product: prepared,
      dTag: target.dTag,
    })
    expect(draft.tags.filter(([name]) => name === "shipping_option")).toEqual([
      ["shipping_option", `30406:${ORGANIZER}:pickup`, "3"],
      ["shipping_option", `30405:${ORGANIZER}:market`, "3"],
    ])
  })

  it("rejects a spoofed baseline, altered association, and silent visibility changes", () => {
    const baseline = product()
    for (const wrong of [
      { ...baseline, pubkey: ORGANIZER },
      { ...baseline, id: `30402:${MERCHANT}:other` },
    ]) {
      expect(() =>
        applyProductFulfillmentIntentForPublication({
          product: baseline,
          merchantPubkey: MERCHANT,
          productDTag: "listing",
          intent: { kind: "preserve_existing", baseline: wrong },
        })
      ).toThrow("same merchant product")
    }
    for (const update of [
      { collectionRefs: [`30405:${ORGANIZER}:other`] },
      { shippingOptionRefs: [] },
      { format: "digital" as const },
      { visibility: "public" as const },
    ]) {
      expect(() => plan(baseline, update)).toThrow("change fulfillment")
    }
  })

  it("allows an unchanged existing zero price but rejects newly zero and extra-cost currency changes", () => {
    expect(
      plan(product("listing", { price: 0 }), { stock: 2 }).publish
    ).toHaveLength(1)
    expect(() => plan(product(), { price: 0 })).toThrow("new zero price")
    const baseline = product("listing", {
      shippingOptionRefs: [
        {
          coordinate: `30406:${ORGANIZER}:pickup`,
          extraCost: {
            amount: 3,
            currency: "SATS",
            normalizedCurrency: "SATS",
          },
        },
      ],
    })
    expect(() => plan(baseline, { currency: "USD" })).toThrow(
      "extra-cost currency"
    )
  })

  it("preserves free products across form currency normalization without changing units", () => {
    for (const [original, normalized] of [
      ["sats", "SATS"],
      ["SAT", "SATS"],
      ["msat", "MSATS"],
      ["xbt", "BTC"],
    ]) {
      const baseline = product("listing", {
        price: 0,
        currency: original!,
        sourcePrice: {
          amount: 0,
          currency: original!,
          normalizedCurrency: original!.toUpperCase(),
        },
      })
      const target = plan(baseline, {
        stock: 3,
        currency: normalized!,
        sourcePrice: {
          amount: 0,
          currency: normalized!,
          normalizedCurrency: normalized!,
        },
      }).publish[0]!
      const draft = buildProductListingEventDraft({
        product: target.product,
        dTag: target.dTag,
      })
      expect(draft.tags).toContainEqual(["price", "0", original!])
    }
    const baseline = product("listing", { price: 0, currency: "SATS" })
    expect(() => plan(baseline, { stock: 3, currency: "BTC" })).toThrow(
      "new zero price"
    )
    expect(() => plan(baseline, { stock: 3, currency: "MSATS" })).toThrow(
      "new zero price"
    )
  })

  it("keeps existing shipping extras valid across case and same-unit currency aliases", () => {
    for (const original of ["sats", "SAT"]) {
      const baseline = product("listing", {
        currency: original,
        sourcePrice: {
          amount: 100,
          currency: original,
          normalizedCurrency: original.toUpperCase(),
        },
        shippingOptionRefs: [
          {
            coordinate: `30406:${ORGANIZER}:pickup`,
            extraCost: {
              amount: 3,
              currency: original,
              normalizedCurrency: original.toUpperCase(),
            },
          },
        ],
      })
      const target = plan(baseline, {
        stock: 3,
        currency: "SATS",
        sourcePrice: {
          amount: 101,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
      }).publish[0]!
      const draft = buildProductListingEventDraft({
        product: target.product,
        dTag: target.dTag,
      })
      expect(draft.tags).toContainEqual(["price", "101", original])
      expect(draft.tags).toContainEqual([
        "shipping_option",
        `30406:${ORGANIZER}:pickup`,
        "3",
      ])
      expect(() =>
        plan(baseline, {
          currency: "BTC",
          sourcePrice: {
            amount: 1,
            currency: "BTC",
            normalizedCurrency: "BTC",
          },
        })
      ).toThrow("extra-cost currency")
    }
  })

  it("does not launder malformed shipping extras while preserving", () => {
    expect(() =>
      plan(
        product("listing", {
          shippingOptionRefs: [
            {
              coordinate: `30406:${ORGANIZER}:pickup`,
              extraCostMalformed: true,
            },
          ],
        }),
        { stock: 2 }
      )
    ).toThrow("extra cost is malformed")
  })

  it("preserves each existing child's own association and unresolved shipping independently", () => {
    const parent = record(product("parent", { type: "variable" }))
    const children = [
      record(
        product("small", {
          type: "variation",
          parentProductId: parent.addressId,
          specifications: [{ key: "Size", value: "S" }],
          stock: 7,
          price: 0,
        })
      ),
      record(
        product("large", {
          type: "variation",
          parentProductId: parent.addressId,
          specifications: [{ key: "Size", value: "L" }],
          stock: 9,
          collectionRefs: undefined,
        })
      ),
    ]
    const state = getProductVariationFormState(parent, children).state
    expect(
      state.rows.some((row) => row.shippingResolution === "unresolved")
    ).toBe(true)
    const changed = structuredClone(state)
    changed.rows[0]!.stock = "5"
    expect(
      getProductVariationFormError(changed, "SATS", {
        preserveExistingFulfillment: true,
        allowZeroPrice: true,
      })
    ).toBeNull()
    const input = {
      baseProduct: parent.product,
      parentDTag: parent.dTag!,
      variations: changed,
      currency: "SATS",
      fulfillmentIntent: {
        kind: "preserve_existing" as const,
        baseline: parent.product,
      },
      authoringCountries: [],
      existing: { root: parent, variations: children, orphanVariation: false },
      now: START,
    }
    const result = buildProductFamilyChangePlan(input)
    expect(result.publish).toHaveLength(1)
    expect(result.publish[0]!.product.id).toBe(children[0]!.product.id)
    for (const target of result.desired) {
      expect(getProductPreservedFulfillmentFields(target.product)).toEqual(
        getProductPreservedFulfillmentFields(target.existing!.product)
      )
    }
    const newChild = structuredClone(changed)
    newChild.rows.push({ ...newChild.rows[0]!, dTag: undefined })
    expect(() =>
      buildProductFamilyChangePlan({ ...input, variations: newChild })
    ).toThrow("before adding a variation")
    const changedShipping = structuredClone(changed)
    changedShipping.rows[0]!.format = "digital"
    expect(() =>
      buildProductFamilyChangePlan({ ...input, variations: changedShipping })
    ).toThrow("changing variation fulfillment")
    const newlyFreeChild = structuredClone(changed)
    newlyFreeChild.rows[1]!.price = "0"
    expect(() =>
      buildProductFamilyChangePlan({ ...input, variations: newlyFreeChild })
    ).toThrow("Price must be greater than zero")
  })
})
