import { afterEach, describe, expect, it, spyOn } from "bun:test"
import {
  NDKEvent,
  NDKPrivateKeySigner,
  type NDKFilter,
} from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetShippingTestOverrides,
  __resetRelayPublishTestOverrides,
  __setCommerceTestOverrides,
  __setShippingTestOverrides,
  __setRelayPublishTestOverrides,
  buildProductListingEventDraft,
  EVENT_KINDS,
  getEventMarketPickupsByCoordinates,
  getProductShippingOptionAddress,
  getShippingOptionsByCoordinates,
  parseEventMarketPickupEvent,
  selectEventMarketEvidenceForRetention,
  setSigner,
  type CachedEventMarketEvidence,
  type CommerceProductRecord,
  type OrderSummary,
  type ParsedEventMarketPickup,
  type ParsedShippingOption,
  type ProductListingDeliveryJob,
  type ProductListingOutboxRepository,
  type ProductSchema,
  type SignedPublicNostrEvent,
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
import { prepareOrderStockUpdate } from "../apps/merchant/src/lib/order-stock-fulfillment"
import { getOrderStockDecisionKey } from "../apps/merchant/src/lib/productStock"
import {
  MAX_PRODUCT_VARIATION_COUNT,
  buildProductFamilyChangePlan,
  createEmptyProductVariationForm,
  getProductFamilySupplierAllocationRevisionKey,
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

function collectionLevelProduct(dTag = "listing"): ProductSchema {
  const collection = `30405:${ORGANIZER}:${dTag}`
  return product(dTag, {
    collectionRefs: [collection],
    shippingOptionId: collection,
    shippingOptionDTag: dTag,
    shippingOptionRefs: [{ coordinate: collection }],
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

function pickupOption(
  baseline: ProductSchema,
  overrides: Partial<ParsedEventMarketPickup> = {}
): ParsedEventMarketPickup {
  const coordinate = baseline.shippingOptionId!
  return {
    eventId: "d".repeat(64),
    coordinate,
    authorPubkey: coordinate.split(":")[1]!,
    dTag: coordinate.split(":").slice(2).join(":"),
    title: "Event pickup",
    content: "",
    currency: "SATS",
    price: 0,
    countries: ["US"],
    location: "Public event pickup desk",
    createdAt: baseline.updatedAt - 1,
    ...overrides,
  }
}

function retainEventPickupEvidenceRows(
  retainedRows: CachedEventMarketEvidence[],
  organizerPubkey: string,
  events: readonly SignedPublicNostrEvent[]
): void {
  for (const event of events) {
    const row: CachedEventMarketEvidence = {
      id: event.id,
      organizerPubkey,
      kind: event.kind,
      addressId:
        event.kind === 30406
          ? `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""}`
          : undefined,
      signedEvent: event,
      sourceRelayUrls: [],
      cachedAt: START,
    }
    const existingIndex = retainedRows.findIndex(
      (existing) =>
        existing.organizerPubkey === organizerPubkey && existing.id === event.id
    )
    if (existingIndex === -1) retainedRows.push(row)
    else retainedRows[existingIndex] = row
  }
}

function installEventPickupReadHarness(
  events: readonly SignedPublicNostrEvent[],
  harnessOptions: {
    failedStatusKinds?: readonly number[]
    omittedStatusKinds?: readonly number[]
    partialSaturatedKinds?: readonly number[]
    rejectedSaturatedKinds?: readonly number[]
    relayUrls?: readonly string[]
    retainedRows?: CachedEventMarketEvidence[]
    saturatedKinds?: readonly number[]
  } = {}
): void {
  const relayUrls = harnessOptions.relayUrls ?? ["wss://pickup.example"]
  const retainedRows = harnessOptions.retainedRows ?? []
  __setEventMarketTestOverrides({
    getActiveOrderCollectionEvidencePins: async () => ({
      status: "ready",
      eventIds: [],
    }),
    loadCachedEvidence: async (organizerPubkey) =>
      retainedRows.filter((row) => row.organizerPubkey === organizerPubkey),
    loadCachedPickupEvidence: async () => retainedRows,
    persistCachedEvidence: async ({ organizerPubkey, events }) => {
      retainEventPickupEvidenceRows(retainedRows, organizerPubkey, events)
    },
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
            readRelayUrls: [...relayUrls],
            writeRelayUrls: [],
            eventCreatedAt: 1,
            cachedAt: 1,
          },
        ])
      ),
    fetchEventsFanoutDetailed: async (filter, fetchOptions) => {
      const tagFilter = filter as NDKFilter & {
        "#a"?: string[]
        "#d"?: string[]
        "#e"?: string[]
      }
      const matching = events.filter(
        (event) =>
          (!filter.kinds || filter.kinds.includes(event.kind as never)) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          (!tagFilter["#a"] ||
            event.tags.some(
              (tag) => tag[0] === "a" && tagFilter["#a"]!.includes(tag[1] ?? "")
            )) &&
          (!tagFilter["#d"] ||
            event.tags.some(
              (tag) => tag[0] === "d" && tagFilter["#d"]!.includes(tag[1] ?? "")
            )) &&
          (!tagFilter["#e"] ||
            event.tags.some(
              (tag) => tag[0] === "e" && tagFilter["#e"]!.includes(tag[1] ?? "")
            ))
      )
      const matches =
        typeof filter.limit === "number"
          ? matching.slice(0, filter.limit)
          : matching
      const saturated = filter.kinds?.some((kind) =>
        harnessOptions.saturatedKinds?.includes(kind)
      )
      const rejectedSaturated = filter.kinds?.some((kind) =>
        harnessOptions.rejectedSaturatedKinds?.includes(kind)
      )
      const failedStatus = filter.kinds?.some((kind) =>
        harnessOptions.failedStatusKinds?.includes(kind)
      )
      const partialSaturated = filter.kinds?.some((kind) =>
        harnessOptions.partialSaturatedKinds?.includes(kind)
      )
      const omitStatus = filter.kinds?.some((kind) =>
        harnessOptions.omittedStatusKinds?.includes(kind)
      )
      const plannedRelayUrls = fetchOptions.relayUrls ?? []
      return {
        events: matches.map((event) => new NDKEvent(undefined, event)),
        relays: (omitStatus
          ? plannedRelayUrls.slice(0, -1)
          : plannedRelayUrls
        ).map((url, index, statuses) => ({
          relayUrl: url,
          status:
            index === statuses.length - 1 && failedStatus
              ? ("failed" as const)
              : partialSaturated
                ? ("partial" as const)
                : ("success" as const),
          eventCount:
            (saturated || partialSaturated) && typeof filter.limit === "number"
              ? filter.limit
              : matches.length,
          rejectedEventCount:
            rejectedSaturated && typeof filter.limit === "number"
              ? Math.max(0, filter.limit - matches.length)
              : 0,
        })),
        eventsVerified: true,
      }
    },
  })
}

interface PublicationObservation {
  signerRequests: ProductSignerRequestProgress[]
  publishedKinds: number[]
  signedBundleCount: number
  signedEvents?: NDKEvent[]
  queuedDeliveryCount?: number
}

class MemoryProductListingOutbox implements ProductListingOutboxRepository {
  private readonly jobs = new Map<string, ProductListingDeliveryJob>()

  constructor(private readonly onAdd?: () => void) {}

  async add(job: ProductListingDeliveryJob): Promise<void> {
    if (this.jobs.has(job.id)) throw new Error("duplicate")
    this.jobs.set(job.id, structuredClone(job))
    this.onAdd?.()
  }

  async get(id: string): Promise<ProductListingDeliveryJob | undefined> {
    const job = this.jobs.get(id)
    return job ? structuredClone(job) : undefined
  }

  async listUndelivered(): Promise<ProductListingDeliveryJob[]> {
    return Array.from(this.jobs.values()).map((job) => structuredClone(job))
  }

  async update(
    id: string,
    updater: (current: ProductListingDeliveryJob) => ProductListingDeliveryJob
  ): Promise<ProductListingDeliveryJob> {
    const current = this.jobs.get(id)
    if (!current) throw new Error("missing")
    const next = updater(structuredClone(current))
    this.jobs.set(id, structuredClone(next))
    return structuredClone(next)
  }
}

async function attemptProductPublication(input: {
  listings: readonly ProductListingPublishTarget[]
  getEventMarketPickups?: ProductPublicationDependencies["getEventMarketPickups"]
  getShippingOptions?: ProductPublicationDependencies["getShippingOptions"]
  now?: number
  observed?: PublicationObservation
  assertBeforeSignerRequest?: () => void
}): Promise<void> {
  setSigner(new NDKPrivateKeySigner(SECRET))
  __setCommerceTestOverrides({
    now: () => input.now ?? START,
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
  const clock =
    input.now === undefined
      ? undefined
      : spyOn(Date, "now").mockReturnValue(input.now)
  try {
    await signAndPublishProductWriteBundle(
      {
        merchantPubkey: MERCHANT,
        listings: input.listings,
        waitForSignerVisibility: async () => {},
        onSignerRequest: (progress) => {
          input.assertBeforeSignerRequest?.()
          input.observed?.signerRequests.push(progress)
        },
        onSignedLocal: async ({ events }) => {
          if (input.observed) {
            input.observed.signedBundleCount += 1
            input.observed.signedEvents?.push(...events)
          }
        },
        productListingDeliveryOptions: {
          repository: new MemoryProductListingOutbox(() => {
            if (input.observed?.queuedDeliveryCount !== undefined) {
              input.observed.queuedDeliveryCount += 1
            }
          }),
          accountNetworkLocalStateRepository: { get: async () => undefined },
          restoreLocalEvidence: async () => {},
          publisher: async ({ signedEvent }) => {
            input.observed?.publishedKinds.push(signedEvent.kind)
            return { status: "acked" }
          },
        },
      },
      {
        getEventMarketPickups: input.getEventMarketPickups ?? (async () => []),
        getShippingOptions: input.getShippingOptions ?? (async () => []),
        planProductListingRelayTargets: async () => [
          {
            relayUrl: "wss://relay.example",
            ownerSelected: false,
            personalRelay: true,
          },
        ],
      }
    )
  } finally {
    publish.mockRestore()
    clock?.mockRestore()
  }
}

async function attemptPreservedPublication(input: {
  baseline: ProductSchema
  update: Partial<ProductSchema>
  options?: ParsedShippingOption[]
  eventPickups?: ParsedEventMarketPickup[]
  getEventMarketPickups?: ProductPublicationDependencies["getEventMarketPickups"]
  getShippingOptions?: ProductPublicationDependencies["getShippingOptions"]
  observed?: PublicationObservation
}): Promise<void> {
  const change = plan(input.baseline, input.update)
  await attemptProductPublication({
    listings: change.publish.map((target) => ({
      ...target,
      previousEventCreatedAt: target.existing!.eventCreatedAt,
    })),
    getEventMarketPickups:
      input.getEventMarketPickups ?? (async () => input.eventPickups ?? []),
    getShippingOptions:
      input.getShippingOptions ?? (async () => input.options ?? []),
    observed: input.observed,
  })
}

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayPublishTestOverrides()
  __resetEventMarketTestOverrides()
  __resetShippingTestOverrides()
  __resetNdkTestState()
})

describe("merchant-owned product mutation boundary", () => {
  it("stops a stale allocation save before signing or queuing after pickup preparation", async () => {
    const absent = { state: "absent" as const, recipients: [], issues: [] }
    const baseline = product("allocation-frontier", {
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
    let releasePickupRead!: () => void
    let notifyPickupRead!: () => void
    const pickupReadStarted = new Promise<void>((resolve) => {
      notifyPickupRead = resolve
    })
    const pickupReadRelease = new Promise<void>((resolve) => {
      releasePickupRead = resolve
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
      getEventMarketPickups: async () => {
        notifyPickupRead()
        await pickupReadRelease
        return [pickupOption(baseline)]
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

    await pickupReadStarted
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
    releasePickupRead()

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
      /onSignerRequest:\s*\(\)\s*=>\s*{\s*assertCurrentFamilyRevision\?\.\(\)/
    )
    expect(route).toMatch(
      /shouldContinue:\s*\(\)\s*=>\s*{\s*assertCurrentFamilyRevision\?\.\(\)\s*return shouldContinue\?\.\(\) !== false/
    )
  })

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
        const baseline = product()
        const change = plan(baseline, { stock: 4 }, now)
        let pickupReads = 0
        const signed: NDKEvent[] = []
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
          getEventMarketPickups: async (coordinates) => {
            pickupReads += 1
            expect(coordinates).toEqual([baseline.shippingOptionId!])
            return [pickupOption(baseline)]
          },
          observed,
        })
        expect(graphReads).toBe(0)
        expect(pickupReads).toBe(1)
        expect(observed.publishedKinds).toEqual([30402])
        expect(observed.signedBundleCount).toBe(1)
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
              readRelayUrls: ["wss://shipping.example"],
              writeRelayUrls: [],
              eventCreatedAt: 1,
              cachedAt: 1,
            },
          ])
        ),
      fetchEventsFanoutDetailed: async (filter, options) => ({
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
      eventPickups: [pickupOption(baseline)],
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

  it("publishes collection-level Products and Orders stock edits without requesting pickup evidence", async () => {
    const baseline = collectionLevelProduct("collection-level")
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
      let pickupReads = 0
      const signedEvents: NDKEvent[] = []
      const observed = {
        signerRequests: [] as ProductSignerRequestProgress[],
        publishedKinds: [] as number[],
        signedBundleCount: 0,
        signedEvents,
      }
      await attemptProductPublication({
        listings: [target.listing],
        getEventMarketPickups: async () => {
          pickupReads += 1
          throw new Error("Collection-level fulfillment is not kind 30406")
        },
        observed,
      })

      expect(pickupReads, target.label).toBe(0)
      expect(observed.publishedKinds, target.label).toEqual([30402])
      expect(observed.signerRequests, target.label).toEqual([
        { kind: "product", current: 1, total: 1 },
      ])
      expect(signedEvents[0]!.tags, target.label).toContainEqual([
        "stock",
        String(target.expectedStock),
      ])
      expect(signedEvents[0]!.tags, target.label).toContainEqual([
        "shipping_option",
        baseline.shippingOptionId!,
      ])
    }
  })

  it("preserves a valid event-pickup extra cost after an exact pickup read", async () => {
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
    const change = plan(baseline, { stock: 4 })
    const signed: NDKEvent[] = []
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
      getEventMarketPickups: async () => {
        shippingReads += 1
        return [pickupOption(baseline)]
      },
      observed,
    })
    expect(shippingReads).toBe(1)
    expect(observed.publishedKinds).toEqual([30402])
    expect(observed.signedBundleCount).toBe(1)
    expect(signed).toHaveLength(1)
    expect(signed[0]!.tags).toContainEqual([
      "shipping_option",
      baseline.shippingOptionId!,
      "0",
    ])
  })

  it("stops before signing when exact event-pickup evidence is unresolved, deleted, or unavailable", async () => {
    const baseline = product("pickup-evidence")
    const failures: Array<{
      state: string
      getEventMarketPickups: ProductPublicationDependencies["getEventMarketPickups"]
    }> = [
      { state: "unresolved", getEventMarketPickups: async () => [] },
      { state: "deleted", getEventMarketPickups: async () => [] },
      {
        state: "unavailable",
        getEventMarketPickups: async () => {
          throw new Error("Pickup relays unavailable")
        },
      },
    ]

    for (const failure of failures) {
      const observed = {
        signerRequests: [] as ProductSignerRequestProgress[],
        publishedKinds: [] as number[],
        signedBundleCount: 0,
      }
      await expect(
        attemptPreservedPublication({
          baseline,
          update: { stock: 4 },
          getEventMarketPickups: failure.getEventMarketPickups,
          observed,
        })
      ).rejects.toThrow("Event pickup could not be verified safely")
      expect(observed, failure.state).toEqual({
        signerRequests: [],
        publishedKinds: [],
        signedBundleCount: 0,
      })
    }
  })

  it("publishes only after the shared exact reader validates a complete live event pickup frontier", async () => {
    const pickupSecret = generateSecretKey()
    const pickupPubkey = getPublicKey(pickupSecret)
    const dTag = "live-pickup"
    const coordinate = `30406:${pickupPubkey}:${dTag}`
    const baseline = product(dTag, {
      collectionRefs: [`30405:${pickupPubkey}:market`],
      shippingOptionId: coordinate,
      shippingOptionDTag: dTag,
      shippingOptionRefs: [{ coordinate }],
    })
    const pickup = finalizeEvent(
      {
        kind: 30406,
        created_at: Math.floor((baseline.updatedAt - 1) / 1000),
        content: "",
        tags: [
          ["d", dTag],
          ["title", "Public pickup"],
          ["price", "0", "SATS"],
          ["country", "US"],
          ["service", "pickup"],
          ["location", "Public pickup desk"],
        ],
      },
      pickupSecret
    )
    installEventPickupReadHarness([pickup])
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
    }

    await attemptPreservedPublication({
      baseline,
      update: { stock: 4 },
      getEventMarketPickups: getEventMarketPickupsByCoordinates,
      observed,
    })

    expect(observed).toEqual({
      signerRequests: [{ kind: "product", current: 1, total: 1 }],
      publishedKinds: [30402],
      signedBundleCount: 1,
    })

    installEventPickupReadHarness([pickup], {
      failedStatusKinds: [30406],
      relayUrls: ["wss://pickup-a.example", "wss://pickup-b.example"],
    })
    const partialCoverage = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
    }
    await attemptPreservedPublication({
      baseline,
      update: { stock: 4 },
      getEventMarketPickups: getEventMarketPickupsByCoordinates,
      observed: partialCoverage,
    })
    expect(partialCoverage).toEqual({
      signerRequests: [{ kind: "product", current: 1, total: 1 }],
      publishedKinds: [30402],
      signedBundleCount: 1,
    })

    for (const saturation of [
      { label: "pickup", kind: 30406 },
      { label: "deletion", kind: 5 },
    ]) {
      installEventPickupReadHarness([pickup], {
        saturatedKinds: [saturation.kind],
      })
      const blocked = {
        signerRequests: [] as ProductSignerRequestProgress[],
        publishedKinds: [] as number[],
        signedBundleCount: 0,
      }
      await expect(
        attemptPreservedPublication({
          baseline,
          update: { stock: 4 },
          getEventMarketPickups: getEventMarketPickupsByCoordinates,
          observed: blocked,
        }),
        `${saturation.label} frontier`
      ).rejects.toThrow("Event pickup could not be verified safely")
      expect(blocked, `${saturation.label} frontier`).toEqual({
        signerRequests: [],
        publishedKinds: [],
        signedBundleCount: 0,
      })
    }

    for (const incomplete of [
      {
        label: "pickup missing relay status",
        options: {
          omittedStatusKinds: [30406],
          relayUrls: ["wss://pickup-a.example", "wss://pickup-b.example"],
        },
      },
      {
        label: "deletion missing relay status",
        options: {
          omittedStatusKinds: [5],
          relayUrls: ["wss://pickup-a.example", "wss://pickup-b.example"],
        },
      },
      {
        label: "pickup rejected-match saturation",
        options: { rejectedSaturatedKinds: [30406] },
      },
      {
        label: "deletion rejected-match saturation",
        options: { rejectedSaturatedKinds: [5] },
      },
      {
        label: "partial pickup saturation",
        options: { partialSaturatedKinds: [30406] },
      },
    ]) {
      installEventPickupReadHarness([pickup], incomplete.options)
      const blocked = {
        signerRequests: [] as ProductSignerRequestProgress[],
        publishedKinds: [] as number[],
        signedBundleCount: 0,
      }
      await expect(
        attemptPreservedPublication({
          baseline,
          update: { stock: 4 },
          getEventMarketPickups: getEventMarketPickupsByCoordinates,
          observed: blocked,
        }),
        incomplete.label
      ).rejects.toThrow("Event pickup could not be verified safely")
      expect(blocked, incomplete.label).toEqual({
        signerRequests: [],
        publishedKinds: [],
        signedBundleCount: 0,
      })
    }
  })

  it("stops before signing when raw event-pickup evidence violates the public handoff contract", async () => {
    const pickupSecret = generateSecretKey()
    const pickupPubkey = getPublicKey(pickupSecret)
    const dTag = "pickup-contract"
    const coordinate = `30406:${pickupPubkey}:${dTag}`
    const baseline = product(dTag, {
      collectionRefs: [`30405:${pickupPubkey}:market`],
      shippingOptionId: coordinate,
      shippingOptionDTag: dTag,
      shippingOptionRefs: [{ coordinate }],
    })
    const commonTags = [
      ["d", dTag],
      ["title", "Public pickup"],
      ["price", "0", "SATS"],
      ["country", "US"],
      ["service", "pickup"],
    ]
    const malformedCases = [
      { label: "missing public location", tags: commonTags },
      {
        label: "proposal-only destination predicate",
        tags: [
          ...commonTags,
          ["location", "Public pickup desk"],
          ["destination_schema", "postal"],
        ],
      },
    ]

    for (const malformed of malformedCases) {
      const event = finalizeEvent(
        {
          kind: 30406,
          created_at: Math.floor((baseline.updatedAt - 1) / 1000),
          content: "",
          tags: malformed.tags,
        },
        pickupSecret
      )
      const parsed = parseEventMarketPickupEvent(event)
      expect(parsed, malformed.label).toBeNull()
      installEventPickupReadHarness([event])
      const observed = {
        signerRequests: [] as ProductSignerRequestProgress[],
        publishedKinds: [] as number[],
        signedBundleCount: 0,
      }

      await expect(
        attemptPreservedPublication({
          baseline,
          update: { stock: 4 },
          getEventMarketPickups: getEventMarketPickupsByCoordinates,
          observed,
        })
      ).rejects.toThrow("Event pickup could not be verified safely")
      expect(observed, malformed.label).toEqual({
        signerRequests: [],
        publishedKinds: [],
        signedBundleCount: 0,
      })
    }

    const validPickup = finalizeEvent(
      {
        kind: 30406,
        created_at: Math.floor((baseline.updatedAt - 1) / 1000),
        content: "",
        tags: [...commonTags, ["location", "Public pickup desk"]],
      },
      pickupSecret
    )
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: validPickup.created_at + 1,
        content: "",
        tags: [["a", coordinate]],
      },
      pickupSecret
    )
    installEventPickupReadHarness([validPickup, deletion])
    const deletedObservation = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
    }
    await expect(
      attemptPreservedPublication({
        baseline,
        update: { stock: 4 },
        getEventMarketPickups: getEventMarketPickupsByCoordinates,
        observed: deletedObservation,
      })
    ).rejects.toThrow("Event pickup could not be verified safely")
    expect(deletedObservation).toEqual({
      signerRequests: [],
      publishedKinds: [],
      signedBundleCount: 0,
    })
  })

  for (const deletionTarget of ["a", "e"] as const) {
    it(`keeps retained pickup ${deletionTarget}-deletions authoritative without promoting cached positives`, async () => {
      const pickupSecret = SECRET
      const pickupPubkey = MERCHANT
      const dTag = `retained-pickup-${deletionTarget}-deletion`
      const coordinate = `30406:${pickupPubkey}:${dTag}`
      const baseline = product(dTag, {
        collectionRefs: [`30405:${ORGANIZER}:market`],
        shippingOptionId: coordinate,
        shippingOptionDTag: dTag,
        shippingOptionRefs: [{ coordinate }],
      })
      const pickup = finalizeEvent(
        {
          kind: 30406,
          created_at: Math.floor((baseline.updatedAt - 1) / 1000),
          content: "",
          tags: [
            ["d", dTag],
            ["title", "Public pickup"],
            ["price", "0", "SATS"],
            ["country", "US"],
            ["service", "pickup"],
            ["location", "Public pickup desk"],
          ],
        },
        pickupSecret
      )
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: pickup.created_at + 1,
          content: "",
          tags: [
            [deletionTarget, deletionTarget === "a" ? coordinate : pickup.id],
          ],
        },
        pickupSecret
      )
      const retainedRows: CachedEventMarketEvidence[] = []

      installEventPickupReadHarness([pickup, deletion], {
        retainedRows,
        ...(deletionTarget === "e"
          ? {
              omittedStatusKinds: [5],
              relayUrls: ["wss://pickup-a.example", "wss://pickup-b.example"],
            }
          : {}),
      })
      await expect(
        attemptPreservedPublication({
          baseline,
          update: { stock: 4 },
          getEventMarketPickups: getEventMarketPickupsByCoordinates,
        })
      ).rejects.toThrow("Event pickup could not be verified safely")
      expect(retainedRows.map((row) => row.signedEvent.id).sort()).toEqual(
        [pickup.id, deletion.id].sort()
      )
      for (const row of retainedRows) {
        row.organizerPubkey = ORGANIZER
        row.id = `${ORGANIZER}:${row.signedEvent.id}`
      }

      __resetEventMarketTestOverrides()
      installEventPickupReadHarness([pickup], {
        failedStatusKinds: [30406],
        relayUrls: ["wss://pickup-a.example", "wss://pickup-b.example"],
        retainedRows,
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
          getEventMarketPickups: getEventMarketPickupsByCoordinates,
          observed,
        })
      ).rejects.toThrow("Event pickup could not be verified safely")
      expect(observed).toEqual({
        signerRequests: [],
        publishedKinds: [],
        signedBundleCount: 0,
      })

      retainedRows.splice(
        0,
        retainedRows.length,
        ...retainedRows.filter((row) => row.kind === 30406)
      )
      __resetEventMarketTestOverrides()
      installEventPickupReadHarness([], { retainedRows })
      const cachedOnlyObservation = {
        signerRequests: [] as ProductSignerRequestProgress[],
        publishedKinds: [] as number[],
        signedBundleCount: 0,
      }
      await expect(
        attemptPreservedPublication({
          baseline,
          update: { stock: 4 },
          getEventMarketPickups: getEventMarketPickupsByCoordinates,
          observed: cachedOnlyObservation,
        })
      ).rejects.toThrow("Event pickup could not be verified safely")
      expect(cachedOnlyObservation).toEqual({
        signerRequests: [],
        publishedKinds: [],
        signedBundleCount: 0,
      })
    })
  }

  it("keeps a retained pickup tombstone through capped persistence and restart", async () => {
    const pickupSecret = generateSecretKey()
    const pickupPubkey = getPublicKey(pickupSecret)
    const dTag = "capped-retained-pickup-deletion"
    const coordinate = `30406:${pickupPubkey}:${dTag}`
    const baseline = product(dTag, {
      collectionRefs: [`30405:${pickupPubkey}:market`],
      shippingOptionId: coordinate,
      shippingOptionDTag: dTag,
      shippingOptionRefs: [{ coordinate }],
    })
    const pickup = finalizeEvent(
      {
        kind: 30406,
        created_at: Math.floor((baseline.updatedAt - 1) / 1000),
        content: "",
        tags: [
          ["d", dTag],
          ["title", "Public pickup"],
          ["price", "0", "SATS"],
          ["country", "US"],
          ["service", "pickup"],
          ["location", "Public pickup desk"],
        ],
      },
      pickupSecret
    )
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: pickup.created_at + 1,
        content: "",
        tags: [["e", pickup.id]],
      },
      pickupSecret
    )
    const retainedRows: CachedEventMarketEvidence[] = []
    retainEventPickupEvidenceRows(retainedRows, pickupPubkey, [
      pickup,
      deletion,
    ])

    const installCappedPersistence = () => {
      installEventPickupReadHarness([pickup], { retainedRows })
      __setEventMarketTestOverrides({
        maxCachedEvidencePerOrganizer: 1,
        persistCachedEvidence: async ({
          organizerPubkey,
          events,
          requiredRetainedEventIds,
        }) => {
          expect(requiredRetainedEventIds).toContain(deletion.id)
          retainEventPickupEvidenceRows(retainedRows, organizerPubkey, events)
          const incomingIds = new Set(events.map((event) => event.id))
          for (const row of retainedRows) {
            if (!incomingIds.has(row.signedEvent.id)) continue
            row.cachedAt =
              row.kind === EVENT_KINDS.DELETION ? START + 2 : START + 1
          }
          retainedRows.splice(
            0,
            retainedRows.length,
            ...selectEventMarketEvidenceForRetention(
              retainedRows,
              1,
              [],
              requiredRetainedEventIds
            )
          )
        },
      })
    }
    const expectPublicationBlocked = async () => {
      const observed = {
        signerRequests: [] as ProductSignerRequestProgress[],
        publishedKinds: [] as number[],
        signedBundleCount: 0,
      }
      await expect(
        attemptPreservedPublication({
          baseline,
          update: { stock: 4 },
          getEventMarketPickups: getEventMarketPickupsByCoordinates,
          observed,
        })
      ).rejects.toThrow("Event pickup could not be verified safely")
      expect(observed).toEqual({
        signerRequests: [],
        publishedKinds: [],
        signedBundleCount: 0,
      })
      expect(retainedRows.map((row) => row.signedEvent.id)).toEqual([
        deletion.id,
      ])
    }

    installCappedPersistence()
    await expectPublicationBlocked()

    __resetEventMarketTestOverrides()
    installCappedPersistence()
    await expectPublicationBlocked()
  })

  it("does not mutate bounded pickup persistence when retained evidence cannot be loaded", async () => {
    const pickupSecret = generateSecretKey()
    const pickupPubkey = getPublicKey(pickupSecret)
    const dTag = "unavailable-retained-pickup"
    const coordinate = `30406:${pickupPubkey}:${dTag}`
    const pickup = finalizeEvent(
      {
        kind: 30406,
        created_at: Math.floor(START / 1000),
        content: "",
        tags: [
          ["d", dTag],
          ["title", "Public pickup"],
          ["price", "0", "SATS"],
          ["country", "US"],
          ["service", "pickup"],
          ["location", "Public pickup desk"],
        ],
      },
      pickupSecret
    )
    let persistenceRequests = 0
    installEventPickupReadHarness([pickup])
    __setEventMarketTestOverrides({
      loadCachedPickupEvidence: async () => {
        throw new Error("IndexedDB unavailable")
      },
      persistCachedEvidence: async () => {
        persistenceRequests += 1
      },
    })

    await expect(
      getEventMarketPickupsByCoordinates([coordinate])
    ).rejects.toThrow("Event pickup retained evidence is unavailable")
    expect(persistenceRequests).toBe(0)
  })

  it("retains pickup deletion evidence after a durable write failure", async () => {
    const pickupSecret = generateSecretKey()
    const pickupPubkey = getPublicKey(pickupSecret)
    const dTag = "volatile-pickup-deletion"
    const coordinate = `30406:${pickupPubkey}:${dTag}`
    const baseline = product(dTag, {
      collectionRefs: [`30405:${pickupPubkey}:market`],
      shippingOptionId: coordinate,
      shippingOptionDTag: dTag,
      shippingOptionRefs: [{ coordinate }],
    })
    const pickup = finalizeEvent(
      {
        kind: 30406,
        created_at: Math.floor((baseline.updatedAt - 1) / 1000),
        content: "",
        tags: [
          ["d", dTag],
          ["title", "Public pickup"],
          ["price", "0", "SATS"],
          ["country", "US"],
          ["service", "pickup"],
          ["location", "Public pickup desk"],
        ],
      },
      pickupSecret
    )
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: pickup.created_at + 1,
        content: "",
        tags: [["a", coordinate]],
      },
      pickupSecret
    )
    const retainedRows: CachedEventMarketEvidence[] = []

    installEventPickupReadHarness([pickup, deletion], { retainedRows })
    __setEventMarketTestOverrides({
      persistCachedEvidence: async () => {
        throw new Error("IndexedDB unavailable")
      },
    })
    await expect(
      attemptPreservedPublication({
        baseline,
        update: { stock: 4 },
        getEventMarketPickups: getEventMarketPickupsByCoordinates,
      })
    ).rejects.toThrow("Event pickup could not be verified safely")
    expect(retainedRows).toEqual([])

    installEventPickupReadHarness([pickup], { retainedRows })
    const observed = {
      signerRequests: [] as ProductSignerRequestProgress[],
      publishedKinds: [] as number[],
      signedBundleCount: 0,
    }
    await expect(
      attemptPreservedPublication({
        baseline,
        update: { stock: 4 },
        getEventMarketPickups: getEventMarketPickupsByCoordinates,
        observed,
      })
    ).rejects.toThrow("Event pickup could not be verified safely")
    expect(observed).toEqual({
      signerRequests: [],
      publishedKinds: [],
      signedBundleCount: 0,
    })
  })

  it("rechecks retained deletion evidence after an overlapping stale pickup read", async () => {
    const pickupSecret = generateSecretKey()
    const pickupPubkey = getPublicKey(pickupSecret)
    const dTag = "overlapping-pickup-deletion"
    const coordinate = `30406:${pickupPubkey}:${dTag}`
    const pickup = finalizeEvent(
      {
        kind: 30406,
        created_at: Math.floor((START - 1) / 1000),
        content: "",
        tags: [
          ["d", dTag],
          ["title", "Public pickup"],
          ["price", "0", "SATS"],
          ["country", "US"],
          ["service", "pickup"],
          ["location", "Public pickup desk"],
        ],
      },
      pickupSecret
    )
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: pickup.created_at + 1,
        content: "",
        tags: [["e", pickup.id]],
      },
      pickupSecret
    )
    const retainedRows: CachedEventMarketEvidence[] = []
    const relayEvents: SignedPublicNostrEvent[] = [pickup]
    let markStalePersistStarted!: () => void
    let releaseStalePersist!: () => void
    let markDeletionPersistStarted!: () => void
    let releaseDeletionPersist!: () => void
    const stalePersistStarted = new Promise<void>((resolve) => {
      markStalePersistStarted = resolve
    })
    const stalePersistRelease = new Promise<void>((resolve) => {
      releaseStalePersist = resolve
    })
    const deletionPersistStarted = new Promise<void>((resolve) => {
      markDeletionPersistStarted = resolve
    })
    const deletionPersistRelease = new Promise<void>((resolve) => {
      releaseDeletionPersist = resolve
    })
    let staleRead: Promise<ParsedEventMarketPickup[]> | undefined
    let deletionRead: Promise<ParsedEventMarketPickup[]> | undefined

    installEventPickupReadHarness(relayEvents, { retainedRows })
    __setEventMarketTestOverrides({
      persistCachedEvidence: async ({ organizerPubkey, events }) => {
        if (events.some((event) => event.kind === 5)) {
          markDeletionPersistStarted()
          await deletionPersistRelease
        } else {
          markStalePersistStarted()
          await stalePersistRelease
        }
        retainEventPickupEvidenceRows(retainedRows, organizerPubkey, events)
      },
    })
    try {
      staleRead = getEventMarketPickupsByCoordinates([coordinate])
      await stalePersistStarted

      relayEvents.splice(0, relayEvents.length, pickup, deletion)
      deletionRead = getEventMarketPickupsByCoordinates([coordinate])
      await deletionPersistStarted

      releaseStalePersist()
      await expect(staleRead).resolves.toEqual([])

      releaseDeletionPersist()
      await expect(deletionRead).resolves.toEqual([])
      expect(retainedRows.map((row) => row.signedEvent.id).sort()).toEqual(
        [pickup.id, deletion.id].sort()
      )
    } finally {
      releaseStalePersist()
      releaseDeletionPersist()
      await Promise.allSettled(
        [staleRead, deletionRead].filter(
          (read): read is Promise<ParsedEventMarketPickup[]> =>
            read !== undefined
        )
      )
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
