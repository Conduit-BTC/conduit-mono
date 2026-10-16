import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { matchFilter } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __resetShippingTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  __setShippingTestOverrides,
  buildShippingPolicyEventDraft,
  resolveProductFulfillment,
  type CachedProduct,
  type CachedProductTombstone,
  type CachedShippingOptionFrontier,
} from "@conduit/core"
import { fetchMerchantProducts } from "../apps/merchant/src/lib/merchant-products"
import {
  loadProductDraft,
  saveProductDraft,
} from "../apps/merchant/src/lib/productDraft"
import {
  buildProductFamilyChangePlan,
  getProductVariationFormError,
  getProductVariationFormState,
  groupProductVariationRecords,
  reconcileProductVariationDraftResolution,
  updateProductVariationOverride,
} from "../apps/merchant/src/lib/productVariations"
import {
  reconcileProductFormFulfillmentResolution,
  type MerchantProductFormValues,
} from "../apps/merchant/src/lib/productForm"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const createdAt = Math.floor(Date.now() / 1000) - 20
const shipping = ["shoes", "shoes-small"].map((dTag, index) =>
  finalizeEvent(
    {
      kind: 30406,
      created_at: createdAt,
      content: "Synthetic signed shipping terms",
      tags: [
        ["d", `${dTag}-shipping-standard`],
        ["title", "Standard Shipping"],
        ["price", index ? "7" : "5", "USD"],
        ["country", "US"],
        ["service", "standard"],
      ],
    },
    secret
  )
)
const products = ["shoes", "shoes-small"].map((dTag, index) =>
  finalizeEvent(
    {
      kind: 30402,
      created_at: createdAt + 1,
      content: "Synthetic signed family",
      tags: [
        ["d", dTag],
        ["title", index ? "3 Men/4.5 Women" : "Shoes"],
        ["price", "20", "USD"],
        ["type", index ? "variation" : "variable", "physical"],
        ["shipping_option", `30406:${merchant}:${dTag}-shipping-standard`],
        ["image", "https://example.com/shoes.png"],
        ["stock", "4"],
        ["t", "shoes"],
        ["t", "test"],
        ["t", "synthetic"],
        ...(index
          ? [
              ["a", `30402:${merchant}:shoes`],
              ["spec", "Size", "3 Men/4.5 Women"],
            ]
          : []),
      ],
    },
    secret
  )
)
let shippingReads = 0
let productEvents = products
let shippingEvents = shipping
let deletionEvents: typeof shipping = []
let coverage: "complete" | "partial" | "unavailable" = "complete"
let beforeShippingRead: (() => void | Promise<void>) | undefined
const accountPolicy = { get: async () => undefined }
const warning =
  "3 Men/4.5 Women shipping could not be verified from the current relay read. Refresh products before saving this family."

async function readFamily(
  shouldContinue?: () => boolean,
  signal?: AbortSignal
) {
  const result = await fetchMerchantProducts(merchant, {
    accountPubkey: merchant,
    authenticatedPubkey: null,
    shouldContinue,
    signal,
    accountNetworkLocalStateRepository: accountPolicy,
  })
  const family = groupProductVariationRecords(result.data)[0]!
  const form = getProductVariationFormState(family.root, family.variations)
  return { result, family, form }
}

function editorForm(
  read: Awaited<ReturnType<typeof readFamily>>
): MerchantProductFormValues {
  const product = read.family.root.product
  return {
    title: product.title,
    summary: "",
    price: "20",
    stock: "4",
    currency: "USD",
    format: product.format,
    fulfillment: "ship",
    shippingPricingMode: "fixed",
    shippingCost: product.sourceShippingCost
      ? String(product.sourceShippingCost.amount)
      : "",
    usePresetShippingZone: false,
    customShippingConfig: {
      countries: (product.shippingCountries ?? []).map((code) => ({
        code,
        name: code,
        restrictTo: [],
        exclude: [],
      })),
    },
    images: product.images,
    tags: "shoes, test, synthetic",
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    listingAreaCountry: "",
    listingAreaState: "",
    listingAreaPlaceId: null,
    listingAreaMode: "clear",
    variations: read.form.state,
  }
}

beforeEach(() => {
  let cachedProducts: CachedProduct[] = []
  let frontiers: CachedShippingOptionFrontier[] = []
  let tombstones: CachedProductTombstone[] = []
  shippingReads = 0
  productEvents = products
  shippingEvents = shipping
  deletionEvents = []
  coverage = "complete"
  beforeShippingRead = undefined
  __setRelayListTestOverrides({
    loadCached: async (pubkey) => ({
      pubkey,
      readRelayUrls: ["wss://fixture.example"],
      writeRelayUrls: ["wss://fixture.example"],
      eventCreatedAt: createdAt,
      cachedAt: Date.now(),
    }),
  })
  __setCommerceTestOverrides({
    fetchPublicEvents: async (filter) =>
      productEvents.filter((event) => matchFilter(filter, event)),
    getCachedProducts: async () => cachedProducts,
    putCachedProducts: async (rows) => {
      cachedProducts = rows
    },
    getCachedProductTombstones: async () => [],
    putCachedProductTombstones: async () => undefined,
  })
  __setShippingTestOverrides({
    getRelayLists: async (pubkeys) =>
      new Map(
        pubkeys.map((pubkey) => [
          pubkey,
          {
            pubkey,
            readRelayUrls: ["wss://fixture.example", "wss://second.example"],
            writeRelayUrls: ["wss://fixture.example", "wss://second.example"],
            eventCreatedAt: createdAt,
            cachedAt: Date.now(),
          },
        ])
      ),
    getCachedOptionFrontiers: async (coordinates) =>
      frontiers.filter((row) => coordinates.includes(row.coordinate)),
    putCachedOptionFrontiers: async (rows) => {
      frontiers = [
        ...frontiers.filter(
          (old) => !rows.some((row) => row.coordinate === old.coordinate)
        ),
        ...rows,
      ]
    },
    getCachedDeletionTombstones: async (ids) =>
      tombstones.filter((row) => ids.includes(row.id)),
    putCachedDeletionTombstones: async (rows) => {
      tombstones = [
        ...tombstones.filter((old) => !rows.some((row) => row.id === old.id)),
        ...rows,
      ]
    },
    deletionFallbackStorage: null,
    fetchSignedEventsFanoutDetailed: async (filter, options) => {
      if (filter.kinds?.includes(30406)) {
        shippingReads++
        await beforeShippingRead?.()
      }
      const events =
        coverage === "unavailable"
          ? []
          : [...shippingEvents, ...deletionEvents].filter((event) =>
              matchFilter(filter, event)
            )
      return {
        events,
        relays: (options?.relayUrls ?? []).map((relayUrl, index) => ({
          relayUrl,
          status:
            coverage === "unavailable" || (coverage === "partial" && index > 0)
              ? ("failed" as const)
              : ("success" as const),
          eventCount: events.length,
        })),
      }
    },
  })
})

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetShippingTestOverrides()
})

describe("Merchant storefront shipping preparation", () => {
  it("reopens a signed fixed-shipping family through the real storefront/editor path", async () => {
    const result = await fetchMerchantProducts(merchant, {
      accountPubkey: merchant,
      authenticatedPubkey: null,
      accountNetworkLocalStateRepository: accountPolicy,
    })
    const family = groupProductVariationRecords(result.data)[0]!
    const form = getProductVariationFormState(family.root, family.variations)
    expect(form.supported).toBe(true)
    expect(getProductVariationFormError(form.state, "USD")).toBeNull()
    expect(shippingReads).toBeGreaterThan(0)
    expect(family.root.product.sourceShippingCost?.amount).toBe(5)
    expect(form.state.rows[0]?.shippingCost).toBe("7")
    expect(result.shippingRead.coverage).toBe("complete")
    expect(
      result.shippingRead.signedEvents.map((event) => event.id).sort()
    ).toEqual(shipping.map((event) => event.id).sort())
    const plan = buildProductFamilyChangePlan({
      parentDTag: "shoes",
      baseProduct: {
        ...family.root.product,
        title: "Changed shoes",
        sourceShippingCost: {
          amount: 6,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      },
      variations: form.state,
      currency: "USD",
      fulfillmentIntent: {
        kind: "fixed_standard",
        amount: 6,
        currency: "USD",
        countries: ["US"],
      },
      authoringCountries: ["US"],
      existing: family,
    })
    expect(plan.desired[0]?.fulfillmentIntent).toMatchObject({
      kind: "fixed_standard",
      amount: 6,
    })
    expect(plan.desired[1]?.fulfillmentIntent).toMatchObject({
      kind: "fixed_standard",
      amount: 7,
    })
  })

  for (const state of ["complete", "unavailable"] as const) {
    it(`keeps ${state === "complete" ? "missing" : "unavailable"} terms unresolved and permits unchanged fulfillment maintenance`, async () => {
      coverage = state
      shippingEvents = []
      const { result, family, form } = await readFamily()
      expect(result.shippingRead.coverage).toBe(state)
      expect(result.shippingRead.signedEvents).toEqual([])
      expect(getProductVariationFormError(form.state, "USD")).toBe(warning)
      expect(
        getProductVariationFormError(form.state, "USD", {
          preserveExistingFulfillment: true,
        })
      ).toBeNull()
      const plan = buildProductFamilyChangePlan({
        parentDTag: "shoes",
        baseProduct: { ...family.root.product, title: "Ordinary title edit" },
        variations: form.state,
        currency: "USD",
        fulfillmentIntent: {
          kind: "preserve_existing",
          baseline: family.root.product,
        },
        authoringCountries: [],
        existing: family,
      })
      expect(
        plan.desired.map(({ product }) => product.shippingOptionRefs)
      ).toEqual(
        [family.root, ...family.variations].map(
          ({ product }) => product.shippingOptionRefs
        )
      )
      expect(plan.publish[0]?.fulfillmentIntent.kind).toBe("preserve_existing")
      expect(family.variations[0]?.product.sourceShippingCost).toBeUndefined()
    })
  }

  it("uses positive signed terms under partial reads without reporting complete coverage", async () => {
    coverage = "partial"
    const { result, form } = await readFamily()
    expect(result.shippingRead.coverage).toBe("partial")
    expect(
      result.shippingRead.options.every(
        (option) =>
          option.readSource === "relay" && option.readCoverage === "partial"
      )
    ).toBe(true)
    expect(getProductVariationFormError(form.state, "USD")).toBeNull()
  })

  it("retains exact signed terms through unavailable and empty refreshes", async () => {
    await readFamily()
    shippingEvents = []
    for (const state of ["unavailable", "complete"] as const) {
      coverage = state
      const { result, family, form } = await readFamily()
      expect(result.shippingRead.coverage).toBe(state)
      expect(
        result.shippingRead.options.every(
          (option) => option.readSource === "retained"
        )
      ).toBe(true)
      expect(
        result.shippingRead.signedEvents.map((event) => event.id).sort()
      ).toEqual(shipping.map((event) => event.id).sort())
      expect(family.root.product.sourceShippingCost?.amount).toBe(5)
      expect(form.state.rows[0]?.shippingCost).toBe("7")
      expect(getProductVariationFormError(form.state, "USD")).toBeNull()
    }
  })

  it("does not resurrect retained terms after a signed withdrawal", async () => {
    await readFamily()
    const withdrawal = finalizeEvent(
      {
        kind: 5,
        created_at: createdAt + 2,
        content: "",
        tags: [
          ["a", `30406:${merchant}:shoes-small-shipping-standard`],
          ["k", "30406"],
        ],
      },
      secret
    )
    deletionEvents = [withdrawal]
    const withdrawn = await readFamily()
    expect(
      withdrawn.result.shippingRead.deletionEvents.map((event) => event.id)
    ).toContain(withdrawal.id)
    expect(
      withdrawn.result.shippingRead.signedEvents.map((event) => event.id)
    ).toContain(shipping[1]!.id)
    expect(getProductVariationFormError(withdrawn.form.state, "USD")).toBe(
      warning
    )
    shippingEvents = []
    deletionEvents = []
    coverage = "unavailable"
    expect(
      getProductVariationFormError((await readFamily()).form.state, "USD")
    ).toBe(warning)
  })

  for (const reason of ["conflicting", "unsupported", "stale"] as const) {
    it(`keeps ${reason} signed terms distinct from a missing read`, async () => {
      const child = shipping[1]!
      const changed = finalizeEvent(
        {
          kind: child.kind,
          created_at: reason === "stale" ? createdAt + 2 : child.created_at,
          content: child.content,
          tags:
            reason === "unsupported"
              ? [...child.tags, ["carrier", "Synthetic carrier"]]
              : child.tags.map((tag) =>
                  tag[0] === "price" ? ["price", "9", "USD"] : tag
                ),
        },
        secret
      )
      shippingEvents =
        reason === "conflicting"
          ? [...shipping, changed]
          : [shipping[0]!, changed]
      const { result, family, form } = await readFamily()
      expect(result.shippingRead.coverage).toBe("complete")
      expect(
        resolveProductFulfillment(
          family.variations[0]!.product,
          result.shippingRead.options
        ).reason
      ).toBe(reason === "conflicting" ? "unresolved" : reason)
      if (reason === "conflicting") {
        expect(
          result.shippingRead.signedEvents.filter((event) =>
            event.tags.some(
              ([key, value]) =>
                key === "d" && value === "shoes-small-shipping-standard"
            )
          )
        ).toHaveLength(2)
        expect(
          result.shippingRead.options.some((option) =>
            option.id.endsWith(":shoes-small-shipping-standard")
          )
        ).toBe(false)
      }
      expect(getProductVariationFormError(form.state, "USD")).toBe(warning)
    })
  }

  it("rejects forged exact terms rather than projecting shipping prices", async () => {
    shippingEvents = [shipping[0]!, { ...shipping[1]!, sig: "0".repeat(128) }]
    const { result, family, form } = await readFamily()
    expect(
      result.shippingRead.signedEvents.map((event) => event.id)
    ).not.toContain(shipping[1]!.id)
    expect(family.variations[0]!.product.sourceShippingCost).toBeUndefined()
    expect(getProductVariationFormError(form.state, "USD")).toBe(warning)
  })

  it("prepares table-shipping families without inventing fixed child prices", async () => {
    const coordinate = `30406:${merchant}:conduit-shipping-policy`
    shippingEvents = [
      finalizeEvent(
        {
          ...buildShippingPolicyEventDraft({
            policy: {
              version: 2,
              title: "Synthetic rates",
              originCountry: "US",
              currency: "USD",
              domestic: {
                rules: [
                  {
                    country: "US",
                    bands: [{ maxWeightGrams: 1000, priceMinor: 500 }],
                  },
                ],
              },
              international: null,
            },
          }),
          created_at: createdAt,
        },
        secret
      ),
    ]
    productEvents = products.map((event) =>
      finalizeEvent(
        {
          kind: event.kind,
          created_at: event.created_at,
          content: event.content,
          tags: [
            ...event.tags.filter(([name]) => name !== "shipping_option"),
            ["shipping_option", coordinate],
            ["weight", "250", "g"],
          ],
        },
        secret
      )
    )
    const { result, family, form } = await readFamily()
    expect(result.shippingRead.options[0]?.shippingPolicy?.version).toBe(2)
    expect(family.root.product.shippingOptionId).toBe(coordinate)
    expect(form.state.rows[0]).toMatchObject({
      inheritShipping: true,
      shippingCost: "",
      shippingWeightGrams: "250",
    })
    expect(form.state.rows[0]?.shippingResolution).toBeUndefined()
    expect(
      getProductVariationFormError(form.state, "USD", {
        shippingPricingMode: "weight_table",
        baseFormat: "physical",
      })
    ).toBeNull()
  })

  it("refreshes and restores a draft without overwriting unrelated or replacement edits", async () => {
    shippingEvents = []
    coverage = "unavailable"
    const unresolved = await readFamily()
    const previous = editorForm(unresolved)
    const draft = {
      ...previous,
      title: "Unsaved shoes",
      summary: "Unsaved description",
      variations: updateProductVariationOverride(
        previous.variations,
        previous.variations.rows[0]!.identity,
        "price",
        "29"
      ),
    }
    const stored = new Map<string, string>()
    const storage: Storage = {
      get length() {
        return stored.size
      },
      clear: () => stored.clear(),
      getItem: (key) => stored.get(key) ?? null,
      key: (index) => [...stored.keys()][index] ?? null,
      removeItem: (key) => {
        stored.delete(key)
      },
      setItem: (key, value) => {
        stored.set(key, value)
      },
    }
    const target = {
      merchantPubkey: merchant,
      productAddressId: unresolved.family.root.addressId,
      baseEventId: unresolved.family.root.eventId,
    }
    expect(saveProductDraft(target, draft, storage)).toBe(true)
    const loaded = loadProductDraft(target, storage)
    expect(loaded.draft).not.toBeNull()
    shippingEvents = shipping
    coverage = "complete"
    const refreshed = await readFamily()
    const prepared = editorForm(refreshed)
    const restored = reconcileProductFormFulfillmentResolution(
      loaded.draft!,
      previous,
      prepared
    )
    expect(restored.title).toBe("Unsaved shoes")
    expect(restored.summary).toBe("Unsaved description")
    expect(restored.shippingCost).toBe("5")
    expect(restored.variations.rows[0]).toMatchObject({
      price: "29",
      shippingCost: "7",
      inheritShipping: false,
    })
    expect(getProductVariationFormError(restored.variations, "USD")).toBeNull()
    const replacement = {
      ...draft,
      shippingCost: "11",
      variations: updateProductVariationOverride(
        draft.variations,
        draft.variations.rows[0]!.identity,
        "shippingCost",
        "13"
      ),
    }
    const kept = reconcileProductFormFulfillmentResolution(
      replacement,
      previous,
      prepared
    )
    expect(kept.shippingCost).toBe("11")
    expect(kept.variations.rows[0]).toMatchObject({
      shippingCost: "13",
      shippingResolution: "replacement",
    })
    expect(
      reconcileProductVariationDraftResolution(refreshed.form, draft.variations)
        .rows[0]
    ).toMatchObject({ price: "29", shippingCost: "7" })
  })

  for (const cancel of ["account", "signal"] as const) {
    it(`discards preparation when the ${cancel} changes during the shipping read`, async () => {
      let active = true
      const controller = new AbortController()
      beforeShippingRead = () => {
        if (cancel === "account") active = false
        else controller.abort()
      }
      await expect(
        readFamily(() => active, controller.signal)
      ).rejects.toThrow()
    })
  }

  it("does not start shipping I/O after cancellation", async () => {
    await expect(readFamily(() => false)).rejects.toThrow(
      "Product read was cancelled."
    )
    expect(shippingReads).toBe(0)
  })
})
