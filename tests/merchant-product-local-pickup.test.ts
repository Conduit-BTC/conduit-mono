import { describe, expect, it } from "bun:test"
import {
  buildProductListingEventDraft,
  canonicalizeProductPrice,
  type ProductSchema,
} from "@conduit/core"
import type { MerchantOrganizerEventMarket } from "../apps/merchant/src/lib/event-market"
import { canUseZeroProductPrice } from "../apps/merchant/src/lib/productForm"
import {
  buildProductLocalPickupMetadata,
  getProductEventMarketReference,
  getProductEventParticipationState,
  getProductFulfillmentIntent,
  getProductFulfillmentProjection,
  getProductLocalPickupEvidenceError,
  getMerchantBoothPickupFormError,
} from "../apps/merchant/src/lib/product-local-pickup"
import { normalizePublishableProductPrice } from "../apps/merchant/src/lib/productPriceForm"

const ORGANIZER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const OTHER_MERCHANT = "c".repeat(64)
const COLLECTION = `30405:${ORGANIZER}:community-market`
const CALENDAR = `31923:${ORGANIZER}:community-market-calendar`
const PICKUP = `30406:${ORGANIZER}:community-market-pickup`
const PRODUCT = `30402:${MERCHANT}:bread`

function market(
  overrides: Partial<MerchantOrganizerEventMarket> = {}
): MerchantOrganizerEventMarket {
  return {
    state: "active",
    organizerPubkey: ORGANIZER,
    collectionCoordinate: COLLECTION,
    calendarCoordinate: CALENDAR,
    pickupCoordinate: PICKUP,
    pickupCoordinates: [PICKUP],
    naddr: "naddr1communitymarket",
    title: "Community market",
    summary: "Public market",
    eventLocation: "Public Hall",
    calendarKind: 31923,
    start: 1_786_798_800,
    end: 1_786_816_800,
    timezone: "America/New_York",
    pickupTitle: "Event pickup",
    pickupLocation: "Public Hall",
    pickupCountry: "US",
    pickupPrice: "0",
    pickupCurrency: "SAT",
    productCoordinates: [],
    participation: [],
    source: {
      organizerPubkey: ORGANIZER,
      collection: {
        coordinate: COLLECTION,
        pickupCoordinates: [PICKUP],
      },
      pickup: {
        coordinate: PICKUP,
        authorPubkey: ORGANIZER,
        price: 0,
        currency: "SAT",
      },
      pickups: [
        {
          coordinate: PICKUP,
          authorPubkey: ORGANIZER,
          price: 0,
          currency: "SAT",
        },
      ],
    },
    ...overrides,
  }
}

function product(overrides: Partial<ProductSchema> = {}): ProductSchema {
  return {
    id: PRODUCT,
    pubkey: MERCHANT,
    title: "Bread",
    price: 10,
    currency: "USD",
    type: "simple",
    format: "physical",
    visibility: "public",
    images: [{ url: "https://example.com/bread.jpg" }],
    tags: ["bread", "food", "local"],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("merchant product local-pickup workflow", () => {
  it("emits a canonical zero price tag only through verified BTC-native pickup authoring", () => {
    const metadata = buildProductLocalPickupMetadata(market(), {
      handoffMode: "organizer_handoff",
    })
    const pickupPrice = normalizePublishableProductPrice(0, "SATS", {
      allowZero: canUseZeroProductPrice({
        fulfillment: "local_pickup",
        handoffMode: "organizer_handoff",
        evidenceVerified: true,
      }),
    })
    const draft = buildProductListingEventDraft({
      product: canonicalizeProductPrice(
        product({
          ...metadata,
          price: pickupPrice,
          currency: "SATS",
        })
      ),
      dTag: "bread",
    })

    expect(draft.tags).toContainEqual(["price", "0", "SATS"])
    expect(draft.tags).toContainEqual(["a", COLLECTION])
    expect(draft.tags).toContainEqual(["shipping_option", PICKUP])

    for (const candidate of [
      {
        fulfillment: "ship",
        handoffMode: "merchant_handoff",
        evidenceVerified: false,
        currency: "SATS",
      },
      {
        fulfillment: "digital",
        handoffMode: "merchant_handoff",
        evidenceVerified: false,
        currency: "SATS",
      },
      {
        fulfillment: "local_pickup",
        handoffMode: "organizer_handoff",
        evidenceVerified: true,
        currency: "USD",
      },
    ]) {
      expect(() => {
        const price = normalizePublishableProductPrice(0, candidate.currency, {
          allowZero: canUseZeroProductPrice(candidate),
        })
        return buildProductListingEventDraft({
          product: canonicalizeProductPrice(
            product({ price, currency: candidate.currency })
          ),
          dTag: "blocked-zero",
        })
      }).toThrow()
    }
  })

  it("emits the exact organizer collection and pickup coordinates without shipping rules", () => {
    const metadata = buildProductLocalPickupMetadata(market(), {
      handoffMode: "organizer_handoff",
    })
    const draft = buildProductListingEventDraft({
      product: product(metadata),
      dTag: "bread",
    })

    expect(metadata).toEqual({
      format: "physical",
      collectionRefs: [COLLECTION],
      shippingOptionId: PICKUP,
      shippingOptionRefs: [{ coordinate: PICKUP }],
    })
    expect(draft.tags).toContainEqual(["a", COLLECTION])
    expect(draft.tags).toContainEqual(["shipping_option", PICKUP])
    expect(draft.tags.some((tag) => tag[0] === "shipping_cost")).toBe(false)
    expect(draft.tags.some((tag) => tag[0] === "shipping_country")).toBe(false)
    expect(draft.tags.some((tag) => tag[0] === "destination")).toBe(false)
  })

  it("emits an exact merchant booth pickup without granting organizer receipt access", () => {
    const merchantPickup = `30406:${MERCHANT}:coffee-event-pickup`
    const metadata = buildProductLocalPickupMetadata(market(), {
      handoffMode: "merchant_handoff",
      merchantPickupCoordinate: merchantPickup,
    })

    expect(metadata.shippingOptionId).toBe(merchantPickup)
    expect(metadata.collectionRefs).toEqual([COLLECTION])
    expect(metadata.shippingOptionRefs).toEqual([
      { coordinate: merchantPickup },
    ])
  })

  it("allows merchant handoff when the organizer does not offer handoff", () => {
    const eventWithoutOrganizerPickup = market({
      pickupCoordinate: undefined,
      pickupCoordinates: [],
      pickupTitle: undefined,
    })
    expect(
      getProductLocalPickupEvidenceError({
        reference: COLLECTION,
        market: eventWithoutOrganizerPickup,
        handoffMode: "merchant_handoff",
      })
    ).toBeNull()
    expect(
      getProductLocalPickupEvidenceError({
        reference: COLLECTION,
        market: eventWithoutOrganizerPickup,
        handoffMode: "organizer_handoff",
      })
    ).toContain("not offering organizer handoff")
  })

  it("requires a bounded public merchant booth location and country", () => {
    expect(
      getMerchantBoothPickupFormError({
        title: "Merchant booth pickup",
        location: "",
        geohash: "",
        country: "US",
      })
    ).toContain("location or geohash")
    expect(
      getMerchantBoothPickupFormError({
        title: "Merchant booth pickup",
        location: "Public Hall, Booth 12",
        geohash: "",
        country: "US",
      })
    ).toBeNull()
  })

  it("fails closed for ended and degraded organizer evidence", () => {
    for (const state of [
      "ended",
      "stale",
      "deleted",
      "malformed",
      "conflicting",
      "unsupported",
      "unavailable",
    ] as const) {
      const evidence = market({ state })
      expect(
        getProductLocalPickupEvidenceError({
          reference: COLLECTION,
          market: evidence,
        })
      ).not.toBeNull()
      expect(() =>
        buildProductLocalPickupMetadata(evidence, {
          handoffMode: "organizer_handoff",
        })
      ).toThrow()
    }

    expect(
      getProductLocalPickupEvidenceError({
        reference: COLLECTION,
        market: market({ state: "partial" }),
      })
    ).toBeNull()
  })

  it("distinguishes a merchant request from exact organizer acceptance", () => {
    const request = product({
      collectionRefs: [COLLECTION],
      shippingOptionRefs: [{ coordinate: PICKUP }],
    })

    expect(getProductEventParticipationState(request, market())).toBe("pending")
    expect(
      getProductEventParticipationState(
        request,
        market({
          productCoordinates: [PRODUCT],
          participation: [{ productCoordinate: PRODUCT, status: "accepted" }],
        })
      )
    ).toBe("accepted")
    expect(
      getProductEventParticipationState(
        request,
        market({
          productCoordinates: [`30402:${OTHER_MERCHANT}:bread`],
        })
      )
    ).toBe("pending")

    expect(
      getProductEventParticipationState(
        request,
        market({
          productCoordinates: [PRODUCT],
          participation: [
            { productCoordinate: PRODUCT, status: "organizer_only" },
          ],
        })
      )
    ).toBe("pending")

    const throughCollection = product({
      collectionRefs: [COLLECTION],
      shippingOptionId: COLLECTION,
      shippingOptionRefs: [{ coordinate: COLLECTION }],
    })
    expect(
      getProductEventParticipationState(
        throughCollection,
        market({
          productCoordinates: [PRODUCT],
          participation: [{ productCoordinate: PRODUCT, status: "accepted" }],
        })
      )
    ).toBe("accepted")
  })

  it("requires current exact pickup evidence instead of inferring from coordinate kinds", () => {
    const exactPickup = product({
      collectionRefs: [COLLECTION],
      shippingOptionId: PICKUP,
      shippingOptionRefs: [{ coordinate: PICKUP }],
    })
    const throughCollectionPickup = product({
      collectionRefs: [COLLECTION],
      shippingOptionId: COLLECTION,
      shippingOptionRefs: [{ coordinate: COLLECTION }],
    })
    const ordinaryShipping = product({
      collectionRefs: [COLLECTION],
      shippingOptionId: `30406:${MERCHANT}:regional-shipping`,
      shippingOptionRefs: [
        { coordinate: `30406:${MERCHANT}:regional-shipping` },
      ],
    })

    expect(getProductFulfillmentProjection(exactPickup)).toEqual({
      intent: "ship",
      eventMarketReference: COLLECTION,
      verification: "required",
    })
    expect(getProductFulfillmentIntent(exactPickup)).toBe("ship")
    expect(getProductEventMarketReference(exactPickup)).toBe("")
    expect(getProductFulfillmentIntent(exactPickup, market())).toBe(
      "local_pickup"
    )
    expect(getProductEventMarketReference(exactPickup, market())).toBe(
      COLLECTION
    )
    expect(
      getProductFulfillmentProjection(exactPickup, market({ state: "stale" }))
    ).toMatchObject({ intent: "ship", verification: "required" })

    expect(getProductFulfillmentIntent(throughCollectionPickup)).toBe("ship")
    expect(getProductFulfillmentIntent(throughCollectionPickup, market())).toBe(
      "local_pickup"
    )
    expect(
      getProductEventMarketReference(throughCollectionPickup, market())
    ).toBe(COLLECTION)

    expect(getProductFulfillmentIntent(ordinaryShipping)).toBe("ship")
    expect(getProductFulfillmentIntent(ordinaryShipping, market())).toBe("ship")
    expect(
      getProductFulfillmentProjection(ordinaryShipping, market()).verification
    ).toBe("ambiguous")
  })

  it("does not silently select one reference from ambiguous repeated evidence", () => {
    const ambiguous = product({
      collectionRefs: [COLLECTION, `30405:${ORGANIZER}:second-market`],
      shippingOptionId: PICKUP,
      shippingOptionRefs: [{ coordinate: PICKUP }],
    })

    expect(getProductFulfillmentProjection(ambiguous).verification).toBe(
      "ambiguous"
    )
    expect(getProductFulfillmentIntent(ambiguous)).toBe("ship")
    expect(getProductEventMarketReference(ambiguous)).toBe("")
  })

  it("guards unrelated edits until existing fulfillment is resolved explicitly", async () => {
    const route = await Bun.file("apps/merchant/src/routes/products.tsx").text()

    expect(route).toContain('projection.verification === "required"')
    expect(route).toContain("editFulfillmentChoiceRequired")
    expect(route).toContain('setEditFulfillmentResolution("verifying_pickup")')
    expect(route).toContain("restoredForm.fulfillment !== hydrated.intent")
    expect(route).toContain(
      "const hydrated = getProductFulfillmentProjection(item.product, market)"
    )
    expect(route).toContain("fulfillment: hydrated.intent")
    expect(route).toContain(
      'data-testid="product-fulfillment-resolution-guard"'
    )
    expect(route).toContain("Use shipping")
    expect(route).toContain("Verify local pickup")
  })

  it("authorizes zero price only after exact local-pickup evidence and before signing", async () => {
    const route = await Bun.file("apps/merchant/src/routes/products.tsx").text()
    const publishStart = route.indexOf("async function publishProduct(")
    const publishEnd = route.indexOf("async function deleteProduct(")
    const publish = route.slice(publishStart, publishEnd)
    const evidence = publish.indexOf("localPickupEvidenceVerified = true")
    const zeroAuthorization = publish.indexOf(
      "const zeroPriceAuthorized = canUseZeroProductPrice"
    )
    const normalization = publish.indexOf("allowZero: zeroPriceAuthorized")
    const boothPublish = publish.indexOf("await ensureMerchantBoothPickup")
    const signing = publish.indexOf("return signAndPublishProductWriteBundle")

    expect(publish).toContain("allowZeroPrice:")
    expect(publish).toContain('form.fulfillment === "local_pickup"')
    expect(evidence).toBeGreaterThan(-1)
    expect(zeroAuthorization).toBeGreaterThan(evidence)
    expect(normalization).toBeGreaterThan(zeroAuthorization)
    expect(boothPublish).toBeGreaterThan(normalization)
    expect(signing).toBeGreaterThan(normalization)

    expect(route).toContain("evidenceVerified:")
    expect(route).toContain("!productFulfillmentError")
  })

  it("hides explicit event-pickup listings without hiding ordinary products", async () => {
    const route = await Bun.file("apps/merchant/src/routes/products.tsx").text()
    const publish = route.slice(
      route.indexOf("async function publishProduct("),
      route.indexOf("async function deleteProduct(")
    )

    expect(publish).toContain('visibility: localPickup ? "private" : "public"')
  })

  it("links local-pickup merchants to the external-signer event creator", async () => {
    const source = await Bun.file(
      "apps/merchant/src/components/ProductFulfillmentEditor.tsx"
    ).text()

    expect(source).toContain('href="/events"')
    expect(source).toContain("Create or manage event")
  })
})
