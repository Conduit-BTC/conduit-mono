import {
  fixtureWrite,
  fixturePublisher,
  resetFixturePublishers,
} from "./helpers/plain-publisher"
import { setTestAccountSigner as setSigner } from "./helpers/plain-signer"
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { IDBFactory as FakeIDBFactory, IDBKeyRange } from "fake-indexeddb"
import type {
  CommerceProductRecord,
  OrderSummary,
  ParsedShippingOption,
  ProductSchema,
  SignedPublicNostrEvent,
} from "@conduit/core"
import type {
  ProductListingPublishTarget,
  ProductPublicationDependencies,
  ProductSignerRequestProgress,
} from "../apps/merchant/src/lib/product-publishing"
import type { ProductListingRecordLike } from "../apps/merchant/src/lib/productVariations"

const {
  __resetCommerceTestOverrides,
  __resetShippingTestOverrides,
  __resetRelayPublishTestOverrides,
  __setCommerceTestOverrides,
  __setShippingTestOverrides,
  __setRelayPublishTestOverrides,
  buildProductListingEventDraft,
  db,
  EVENT_KINDS,
  getProductShippingOptionAddress,
  getShippingOptionsByCoordinates,
} = await import("@conduit/core")
const { __resetPublicReaderTestState } =
  await import("../packages/core/src/protocol/relay-reader")
const {
  applyProductFulfillmentIntentForPublication,
  getProductPreservedFulfillmentFields,
  SignedProductDeliveryError,
  signAndPublishProductWriteBundle,
} = await import("../apps/merchant/src/lib/product-publishing")
const { prepareOrderStockUpdate } =
  await import("../apps/merchant/src/lib/order-stock-fulfillment")
const { getOrderStockDecisionKey } =
  await import("../apps/merchant/src/lib/productStock")
const {
  MAX_PRODUCT_VARIATION_COUNT,
  buildProductFamilyChangePlan,
  createEmptyProductVariationForm,
  getProductFamilySupplierAllocationRevisionKey,
  getProductVariationFormError,
  getProductVariationFormState,
} = await import("../apps/merchant/src/lib/productVariations")

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

function collectionLevelProduct(dTag = "listing"): ProductSchema {
  const collection = `30405:${ORGANIZER}:${dTag}`
  return product(dTag, {
    collectionRefs: [collection],
    shippingOptionId: collection,
    shippingOptionDTag: dTag,
    shippingOptionRefs: [{ coordinate: collection }],
  })
}

function ordinaryProduct(
  dTag = "listing",
  overrides: Partial<ProductSchema> = {}
): ProductSchema {
  return product(dTag, {
    shippingOptionId: undefined,
    shippingOptionDTag: undefined,
    shippingOptionRefs: undefined,
    canonicalShippingResolved: false,
    shippingOptionLaunchUnsupported: false,
    eventMarketRefs: [`30409:${ORGANIZER}:current-market`],
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
  signedEvents?: SignedPublicNostrEvent[]
  queuedDeliveryCount?: number
}

function installTestBrowserDurability(): () => void {
  // Other test files may load the singleton before this fixture. Dexie snapshots
  // its dependencies at construction, so a global polyfill is insufficient.
  const dependencies = (
    db as unknown as {
      _deps: {
        indexedDB?: IDBFactory
        IDBKeyRange?: typeof IDBKeyRange
      }
    }
  )._deps
  const previousIndexedDB = dependencies.indexedDB
  const previousKeyRange = dependencies.IDBKeyRange
  db.close({ disableAutoOpen: false })
  dependencies.indexedDB = new FakeIDBFactory()
  dependencies.IDBKeyRange = IDBKeyRange
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  )
  const previousStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  )
  const testNavigator = Object.create(
    typeof navigator === "undefined" ? null : navigator
  ) as Navigator
  Object.defineProperty(testNavigator, "locks", {
    configurable: true,
    value: {
      // These cases have one writer; contention belongs to the lock tests.
      request: async <T>(
        name: string,
        operation: (lock: { name: string }) => Promise<T>
      ): Promise<T> => operation({ name }),
    },
  })
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: testNavigator,
  })
  const values = new Map<string, string>()
  const testStorage: Storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: testStorage,
  })
  return () => {
    db.close({ disableAutoOpen: false })
    dependencies.indexedDB = previousIndexedDB
    dependencies.IDBKeyRange = previousKeyRange
    if (previousNavigator) {
      Object.defineProperty(globalThis, "navigator", previousNavigator)
    } else {
      Reflect.deleteProperty(globalThis, "navigator")
    }
    if (previousStorage) {
      Object.defineProperty(globalThis, "localStorage", previousStorage)
    } else {
      Reflect.deleteProperty(globalThis, "localStorage")
    }
  }
}

async function attemptProductPublication(input: {
  listings: readonly ProductListingPublishTarget[]
  durableBaselines?: readonly ProductSchema[]
  stopAfterDurableCommit?: boolean
  getShippingOptions?: ProductPublicationDependencies["getShippingOptions"]
  now?: number
  observed?: PublicationObservation
  assertBeforeSignerRequest?: () => void
}): Promise<void> {
  if (input.stopAfterDurableCommit && !input.durableBaselines) {
    throw new Error("A durable baseline is required to stop after commit")
  }
  const stopAfterCommit = new Error("Stopped after durable test preparation")
  const baselinesByAddress = new Map(
    (input.durableBaselines ?? []).map((baseline) => [baseline.id, baseline])
  )
  const listings = input.listings.map((listing) => {
    const addressId = `${EVENT_KINDS.PRODUCT}:${MERCHANT}:${listing.dTag}`
    const baseline =
      baselinesByAddress.get(addressId) ??
      (listing.fulfillmentIntent.kind === "preserve_existing"
        ? listing.fulfillmentIntent.baseline
        : undefined)
    if (baseline) baselinesByAddress.set(addressId, baseline)
    return {
      ...listing,
      ...(baseline ? { previousEventId: record(baseline).eventId } : {}),
    }
  })
  const relayUrl = input.durableBaselines
    ? "wss://relay.conduit.market"
    : "wss://relay.example"
  setSigner(new NDKPrivateKeySigner(SECRET))
  __setCommerceTestOverrides({
    now: () => input.now ?? START,
    getCachedProducts: async () => [],
    getCachedProductTombstones: async () => [],
    putCachedProducts: async () => {},
  })
  __setRelayPublishTestOverrides({
    publishSignedEventFrameToRelay: fixtureWrite,
    accountNetworkLocalStateRepository: { get: async () => undefined },
    planPublishRelays: async () => ({
      intent: "author_event",
      primaryRelayUrls: ["wss://relay.fixture.conduit.market"],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    }),
  })
  const publish = spyOn(fixturePublisher, "publish").mockImplementation(
    async function (
      this: SignedPublicNostrEvent,
      relaySet: { relayUrls: Set<string> }
    ) {
      input.observed?.publishedKinds.push(this.kind)
      return new Set([...relaySet.relayUrls].map((url) => ({ url }))) as never
    }
  )
  const clock =
    input.now === undefined
      ? undefined
      : spyOn(Date, "now").mockReturnValue(input.now)
  const restoreBrowserDurability = installTestBrowserDurability()
  try {
    if (baselinesByAddress.size > 0) {
      await db.products.bulkPut(
        [...baselinesByAddress.values()].map((baseline) => ({
          ...baseline,
          eventId: record(baseline).eventId,
          eventCreatedAt: record(baseline).eventCreatedAt,
          cachedAt: START,
        }))
      )
    }
    await signAndPublishProductWriteBundle(
      {
        merchantPubkey: MERCHANT,
        listings,
        durableCommit: {},
        waitForSignerVisibility: async () => {},
        onSignerRequest: (progress) => {
          input.assertBeforeSignerRequest?.()
          input.observed?.signerRequests.push(progress)
        },
        onSignedLocal: async ({ events, productListingDeliveryJobId }) => {
          if (input.observed?.queuedDeliveryCount !== undefined) {
            input.observed.queuedDeliveryCount += 1
          }
          if (input.durableBaselines) {
            const intent = (await db.localProductWriteIntents.toArray()).find(
              (row) => row.listingJobId === productListingDeliveryJobId
            )
            expect(intent?.shippingEventIds).toHaveLength(
              input.durableBaselines.length
            )
            expect(intent?.productAddressIds).toEqual(
              input.durableBaselines.map((baseline) => baseline.id)
            )
            expect(
              await db.productListingOutbox.get(productListingDeliveryJobId!)
            ).toBeDefined()
            for (const eventId of intent?.shippingEventIds ?? []) {
              expect(
                (await db.localProductShippingOutbox.get(eventId))?.signedEvent
                  .kind
              ).toBe(EVENT_KINDS.SHIPPING_OPTION)
            }
          }
          if (input.observed) {
            input.observed.signedBundleCount += 1
            input.observed.signedEvents?.push(...events)
          }
          if (input.stopAfterDurableCommit) throw stopAfterCommit
        },
        productListingDeliveryOptions: {
          accountNetworkLocalStateRepository: { get: async () => undefined },
          restoreLocalEvidence: async () => {},
          publisher: async ({ signedEvent }) => {
            if (input.durableBaselines) {
              const intent = (await db.localProductWriteIntents.toArray()).find(
                (row) =>
                  row.productAddressIds.includes(
                    `${EVENT_KINDS.PRODUCT}:${MERCHANT}:${signedEvent.tags.find(([name]) => name === "d")?.[1]}`
                  )
              )
              expect(intent).toBeDefined()
              for (const eventId of intent?.shippingEventIds ?? []) {
                expect(
                  (await db.localProductShippingOutbox.get(eventId))
                    ?.acknowledgedRelayUrls
                ).toContain(relayUrl)
              }
            }
            input.observed?.publishedKinds.push(signedEvent.kind)
            return { status: "acked" }
          },
        },
      },
      {
        getShippingOptions: input.getShippingOptions ?? (async () => []),
        planProductListingRelayTargets: async () => [
          {
            relayUrl,
            ownerSelected: false,
            personalRelay: true,
          },
        ],
      }
    )
  } catch (error) {
    if (
      input.stopAfterDurableCommit &&
      error instanceof SignedProductDeliveryError &&
      error.deliveryCause === stopAfterCommit
    ) {
      return
    }
    throw error
  } finally {
    publish.mockRestore()
    clock?.mockRestore()
    restoreBrowserDurability?.()
  }
}

async function attemptPreservedPublication(input: {
  baseline: ProductSchema
  update: Partial<ProductSchema>
  options?: ParsedShippingOption[]
  getShippingOptions?: ProductPublicationDependencies["getShippingOptions"]
  observed?: PublicationObservation
  durableShippingIntent?: boolean
}): Promise<void> {
  const change = plan(input.baseline, input.update)
  await attemptProductPublication({
    listings: change.publish.map((target) => ({
      ...target,
      previousEventCreatedAt: target.existing!.eventCreatedAt,
    })),
    getShippingOptions:
      input.getShippingOptions ?? (async () => input.options ?? []),
    observed: input.observed,
    ...(input.durableShippingIntent
      ? { durableBaselines: [input.baseline] }
      : {}),
  })
}

afterEach(() => {
  __resetCommerceTestOverrides()
  resetFixturePublishers()
  __resetRelayPublishTestOverrides()
  __resetShippingTestOverrides()
  __resetPublicReaderTestState()
})

describe("merchant-owned product mutation boundary", () => {
  it("stops a stale allocation save before signing or queuing after shipping preparation", async () => {
    const absent = { state: "absent" as const, recipients: [], issues: [] }
    const baseline = canonicalProduct("allocation-frontier", {
      supplierAllocation: absent,
    })
    const family = {
      root: record(baseline),
      variations: [
        record(product("allocation-child", { supplierAllocation: absent })),
      ],
      orphanVariation: false,
    }
    const expectedRevision =
      getProductFamilySupplierAllocationRevisionKey(family)
    let currentFamily = structuredClone(family)
    let releaseShippingRead!: () => void
    let notifyShippingRead!: () => void
    const shippingReadStarted = new Promise<void>((resolve) => {
      notifyShippingRead = resolve
    })
    const shippingReadRelease = new Promise<void>((resolve) => {
      releaseShippingRead = resolve
    })
    const observed: PublicationObservation = {
      signerRequests: [],
      publishedKinds: [],
      signedBundleCount: 0,
      queuedDeliveryCount: 0,
    }
    const change = plan(baseline, { stock: 4 })
    const publication = attemptProductPublication({
      listings: change.publish.map((target) => ({
        ...target,
        previousEventCreatedAt: target.existing!.eventCreatedAt,
      })),
      getShippingOptions: async () => {
        notifyShippingRead()
        await shippingReadRelease
        return [shippingOption(baseline)]
      },
      assertBeforeSignerRequest: () => {
        if (
          getProductFamilySupplierAllocationRevisionKey(currentFamily) !==
          expectedRevision
        ) {
          throw new Error("Products changed while this editor was open.")
        }
      },
      observed,
    })

    await shippingReadStarted
    currentFamily = structuredClone(currentFamily)
    currentFamily.variations[0]!.eventId = "new-child-revision"
    currentFamily.variations[0]!.product.supplierAllocation = {
      state: "valid",
      recipients: [
        { pubkey: MERCHANT, weight: 1, role: "merchant" },
        { pubkey: ORGANIZER, weight: 1, role: "supplier" },
      ],
      issues: [],
    }
    releaseShippingRead()

    await expect(publication).rejects.toThrow(
      "Products changed while this editor was open."
    )
    expect(observed).toEqual({
      signerRequests: [],
      publishedKinds: [],
      signedBundleCount: 0,
      queuedDeliveryCount: 0,
    })

    const route = await Bun.file("apps/merchant/src/routes/products.tsx").text()
    expect(route).toMatch(
      /onSignerRequest:\s*\(progress\)\s*=>\s*{\s*assertCurrentFamilyRevision\?\.\(\)/
    )
    expect(route).toMatch(
      /assertCurrentWriteBaseline:\s*async\s*\(\)\s*=>\s*assertCurrentFamilyRevision\?\.\(\)/
    )
    expect(route).toMatch(
      /additionalExpectedRevisions:\s*\[\s*existing,\s*\.\.\.existing\.variations/
    )
  })

  for (const now of [START - 1, START, START + 1, START + 86_400_000]) {
    it(`signs only the owned stock edit at ${now - START}ms without rediscovering event authority`, async () => {
      const marketCoordinate = `30409:${ORGANIZER}:current-market`
      const baseline = ordinaryProduct("listing", {
        eventMarketRefs: [marketCoordinate],
      })
      const change = plan(baseline, { stock: 4 }, now)
      let shippingReads = 0
      const signed: SignedPublicNostrEvent[] = []
      const observed = {
        signerRequests: [] as ProductSignerRequestProgress[],
        publishedKinds: [] as number[],
        signedBundleCount: 0,
        signedEvents: signed,
      }
      await attemptProductPublication({
        listings: change.publish.map((target) => ({
          ...target,
          previousEventCreatedAt: target.existing!.eventCreatedAt,
        })),
        now,
        getShippingOptions: async () => {
          shippingReads++
          throw new Error(
            "Unchanged noncanonical references require no shipping lookup"
          )
        },
        observed,
      })
      expect(shippingReads).toBe(0)
      expect(observed.publishedKinds).toEqual([30402])
      expect(observed.signedBundleCount).toBe(1)
      expect(signed).toHaveLength(1)
      expect(signed[0]!.pubkey).toBe(MERCHANT)
      expect(signed[0]!.tags).toContainEqual(["stock", "4"])
      expect(signed[0]!.tags).toContainEqual(["a", marketCoordinate])
      expect(signed[0]!.tags).toContainEqual([
        "a",
        baseline.collectionRefs![0]!,
      ])
      expect(
        signed[0]!.tags.filter(([name]) => name === "shipping_option")
      ).toEqual([])
      expect(signed[0]!.tags).toContainEqual(["visibility", "hidden"])
      expect(signed[0]!.created_at).toBeGreaterThan(
        record(baseline).eventCreatedAt
      )
    })
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
      durableShippingIntent: true,
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

  it("stops before signing when rejected fixed-shipping matches saturate the read", async () => {
    const baseline = canonicalProduct("rejected-saturation")
    __setShippingTestOverrides({
      readAccountRelaySettingsPlanningSnapshot: async () => ({
        settings: { version: 1, updatedAt: 1, entries: [] },
        signedRelayListAuthoritative: true,
      }),
      getRelayLists: async (authors) =>
        new Map(
          authors.map((author) => [
            author,
            {
              pubkey: author,
              readRelayUrls: ["wss://shipping.fixture.conduit.market"],
              writeRelayUrls: [],
              eventCreatedAt: 1,
              cachedAt: 1,
            },
          ])
        ),
      fetchSignedEventsFanoutDetailed: async (filter, options) => ({
        events: [],
        relays: (options?.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: 0,
          rejectedEventCount: filter.kinds?.includes(30406) ? 100 : 0,
        })),
        eventsVerified: true,
      }),
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
        getShippingOptions: getShippingOptionsByCoordinates,
        observed,
      })
    ).rejects.toThrow("could not be verified safely")
    expect(observed).toEqual({
      signerRequests: [],
      publishedKinds: [],
      signedBundleCount: 0,
    })
  })

  it("preserves catalog references while republishing canonical shipping", async () => {
    const collectionRefs = [
      `30405:${ORGANIZER}:market`,
      `30405:${ORGANIZER}:secondary-market`,
    ]
    const baseline = canonicalProduct("cataloged", { collectionRefs })
    const signedEvents: SignedPublicNostrEvent[] = []
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
      durableShippingIntent: true,
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
    const signedEvents: SignedPublicNostrEvent[] = []
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
      durableBaselines: baselines,
      // This case covers max-size batch preparation; delivery is exercised
      // with a smaller family below to keep the in-memory IDB test bounded.
      stopAfterDurableCommit: true,
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
    expect(observed.publishedKinds).toEqual([])
  })

  it("acks all shipping options before publishing a canonical family", async () => {
    const baselines = [
      canonicalProduct("paired-root"),
      canonicalProduct("paired-child"),
    ]
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
    }

    await attemptProductPublication({
      listings: baselines.map((baseline) => ({
        product: { ...baseline, stock: 4 },
        dTag: record(baseline).dTag!,
        previousEventCreatedAt: record(baseline).eventCreatedAt,
        fulfillmentIntent: { kind: "preserve_existing", baseline },
      })),
      getShippingOptions: async () =>
        baselines.map((baseline) => shippingOption(baseline)),
      durableBaselines: baselines,
      observed,
    })

    expect(observed.publishedKinds).toEqual([30406, 30406, 30402, 30402])
    expect(observed.signedBundleCount).toBe(1)
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

  it("requires explicit fulfillment change for retired direct or collection pickup references before signing", async () => {
    for (const baseline of [
      product("old-direct"),
      collectionLevelProduct("old-collection"),
    ]) {
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
      ).rejects.toThrow("Choose Change fulfillment")
      expect(observed).toEqual({
        signerRequests: [],
        publishedKinds: [],
        signedBundleCount: 0,
      })
    }
  })

  it("publishes ordinary Products and Orders stock edits while retaining the current event association", async () => {
    const baseline = ordinaryProduct("collection-level")
    const productChange = plan(baseline, { stock: 4 }).publish[0]!
    const orderRecord: CommerceProductRecord = {
      addressId: baseline.id,
      eventId: "e".repeat(64),
      dTag: "collection-level",
      eventCreatedAt: Math.floor(baseline.updatedAt / 1000),
      product: baseline,
    }
    const orderId = "collection-level-order"
    const orderChange = prepareOrderStockUpdate({
      merchantPubkey: MERCHANT,
      orderId,
      items: [{ productId: baseline.id, quantity: 2 }] as OrderSummary["items"],
      adjustment: {
        key: getOrderStockDecisionKey(orderId, baseline.id),
        addressId: baseline.id,
        sourceEventId: "f".repeat(64),
        title: baseline.title,
        quantity: 2,
        currentStock: baseline.stock!,
        nextStock: baseline.stock! - 2,
        shortfall: 0,
      },
      record: orderRecord,
    })
    const targets: Array<{
      label: string
      listing: ProductListingPublishTarget
      expectedStock: number
    }> = [
      {
        label: "Products",
        listing: {
          ...productChange,
          previousEventCreatedAt: productChange.existing!.eventCreatedAt,
        },
        expectedStock: 4,
      },
      {
        label: "Orders",
        listing: {
          product: {
            ...baseline,
            stock: orderChange.adjustment.nextStock,
          },
          dTag: orderRecord.dTag!,
          previousEventCreatedAt: orderRecord.eventCreatedAt,
          fulfillmentIntent: orderChange.fulfillmentIntent,
        },
        expectedStock: orderChange.adjustment.nextStock,
      },
    ]

    for (const target of targets) {
      let shippingReads = 0
      const signedEvents: SignedPublicNostrEvent[] = []
      const observed = {
        signerRequests: [] as ProductSignerRequestProgress[],
        publishedKinds: [] as number[],
        signedBundleCount: 0,
        signedEvents,
      }
      await attemptProductPublication({
        listings: [target.listing],
        getShippingOptions: async () => {
          shippingReads += 1
          throw new Error("Opaque collection references are unchanged")
        },
        observed,
      })

      expect(shippingReads, target.label).toBe(0)
      expect(observed.publishedKinds, target.label).toEqual([30402])
      expect(observed.signerRequests, target.label).toEqual([
        { kind: "product", current: 1, total: 1 },
      ])
      expect(signedEvents[0]!.tags, target.label).toContainEqual([
        "stock",
        String(target.expectedStock),
      ])
      expect(signedEvents[0]!.tags, target.label).toContainEqual([
        "a",
        baseline.eventMarketRefs![0]!,
      ])
      expect(signedEvents[0]!.tags, target.label).toContainEqual([
        "a",
        baseline.collectionRefs![0]!,
      ])
      expect(
        signedEvents[0]!.tags.filter(([name]) => name === "shipping_option"),
        target.label
      ).toEqual([])
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
