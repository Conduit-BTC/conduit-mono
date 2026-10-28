import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  canonicalizeProductPrice,
  evaluateListingAvailability,
  type ProductSchema,
} from "@conduit/core"
import { ListingAvailabilitySummary } from "../apps/merchant/src/components/ListingAvailabilitySummary"
import { ProductEventOnlyField } from "../apps/merchant/src/components/ProductEventOnlyField"
import {
  applyProductFulfillmentIntentForPublication,
  getProductPreservedFulfillmentFields,
  projectProductEventOnlyChoice,
} from "../apps/merchant/src/lib/product-publishing"
import {
  buildProductFamilyChangePlan,
  createEmptyProductVariationForm,
  createProductVariationAxis,
  generateProductVariationRows,
  getProductVariationFormState,
  type ProductListingRecordLike,
} from "../apps/merchant/src/lib/productVariations"
import {
  validateProductPublishForm,
  type MerchantProductFormValues,
} from "../apps/merchant/src/lib/productForm"
import {
  loadProductDraft,
  saveProductDraft,
} from "../apps/merchant/src/lib/productDraft"

const merchant = "a".repeat(64)
function product(overrides: Partial<ProductSchema> = {}): ProductSchema {
  return canonicalizeProductPrice({
    id: `30402:${merchant}:mug`,
    pubkey: merchant,
    title: "Mug",
    price: 300,
    currency: "SATS",
    type: "simple",
    specifications: [],
    format: "physical",
    visibility: "public",
    stock: 3,
    images: [{ url: "https://cdn.conduit.market/conduit-test/mug.svg" }],
    tags: ["mug", "maker", "fair"],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    ...overrides,
  })
}
function form(): MerchantProductFormValues {
  return {
    title: "Mug",
    summary: "A mug",
    price: "300",
    currency: "SATS",
    stock: "3",
    format: "physical",
    fulfillment: "ship",
    shippingPricingMode: "coordinate_after_order",
    shippingCost: "",
    usePresetShippingZone: false,
    customShippingConfig: { countries: [] },
    images: [{ url: "https://cdn.conduit.market/conduit-test/mug.svg" }],
    tags: "mug,maker,fair",
    listingAreaCountry: "",
    listingAreaState: "",
    listingAreaPlaceId: null,
    listingAreaMode: "clear",
    variations: createEmptyProductVariationForm(),
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    supplierAllocationEnabled: false,
    supplierAllocationRepairRequired: false,
    merchantAllocationWeight: "1",
    merchantAllocationRelayHint: "",
    supplierAllocations: [],
  }
}
function record(
  target: { dTag: string; product: ProductSchema },
  index: number
): ProductListingRecordLike {
  return {
    ...target,
    eventId: String(index).padStart(64, "0"),
    addressId: target.product.id,
    eventCreatedAt: 100 + index,
  }
}

describe("explicit Merchant event-only selling", () => {
  it("presents valid Event-only listings as a neutral editing choice, not a repair or public offer", () => {
    const p = product({ visibility: "private", eventOnly: true })
    const availability = evaluateListingAvailability(p)
    const html = renderToStaticMarkup(
      <ListingAvailabilitySummary
        item={{
          product: p,
          availability,
          variationForm: { supported: true },
          variations: [],
        }}
        onEdit={() => undefined}
      />
    )
    expect(html).toContain("Events only")
    expect(html).toContain(">Edit</button>")
    expect(html).not.toContain("Fix listing")
    expect(html).not.toContain("warning")
    expect(availability.marketVisible).toBe(false)
    expect(availability.purchasable).toBe(false)
    for (const p of [
      product({ visibility: "private" }),
      product({ visibility: "private", eventOnlyMalformed: true }),
      product({ visibility: "private", eventOnly: true, images: [] }),
    ]) {
      const html = renderToStaticMarkup(
        <ListingAvailabilitySummary
          item={{
            product: p,
            availability: evaluateListingAvailability(p),
            variationForm: { supported: true },
            variations: [],
          }}
          onEdit={() => undefined}
        />
      )
      expect(html).toContain("Fix listing")
    }
    const readOnly = renderToStaticMarkup(
      <ListingAvailabilitySummary
        item={{
          product: p,
          availability,
          variationForm: { supported: false },
          variations: [],
        }}
        onEdit={() => undefined}
      />
    )
    expect(readOnly).toContain("Read-only")
    expect(readOnly).not.toContain(">Edit</button>")
  })
  it("preserves untouched public, legacy hidden, malformed and existing event-only settings", () => {
    for (const baseline of [
      product(),
      product({ visibility: "private" }),
      product({ visibility: "private", eventOnly: true }),
      product({ visibility: "private", eventOnlyMalformed: true }),
    ]) {
      expect(projectProductEventOnlyChoice(baseline, undefined)).toEqual({
        visibility: baseline.visibility,
        eventOnly: baseline.eventOnly,
        eventOnlyMalformed: baseline.eventOnlyMalformed,
      })
    }
    expect(projectProductEventOnlyChoice(product(), true)).toEqual({
      visibility: "private",
      eventOnly: true,
      eventOnlyMalformed: false,
    })
    expect(
      projectProductEventOnlyChoice(
        product({ visibility: "private", eventOnly: true }),
        false
      ).visibility
    ).toBe("public")
    expect(
      projectProductEventOnlyChoice(product({ visibility: "private" }), false)
        .visibility
    ).toBe("private")
    expect(
      projectProductEventOnlyChoice(
        product({ visibility: "private", eventOnlyMalformed: true }),
        true
      ).eventOnlyMalformed
    ).toBe(false)
    expect(() =>
      projectProductEventOnlyChoice(product({ format: "digital" }), true)
    ).toThrow("physical product")
  })

  it("permits only the explicit marker/visibility choice while retaining existing shipping guards", () => {
    const baseline = product({ visibility: "private" })
    const changed = {
      ...baseline,
      ...projectProductEventOnlyChoice(baseline, true),
    }
    const input = {
      product: changed,
      merchantPubkey: merchant,
      productDTag: "mug",
      intent: { kind: "preserve_existing" as const, baseline },
    }
    expect(() => applyProductFulfillmentIntentForPublication(input)).toThrow(
      "change fulfillment"
    )
    expect(
      applyProductFulfillmentIntentForPublication({
        ...input,
        intent: { ...input.intent, eventOnlyChange: true },
      }).eventOnly
    ).toBe(true)
    expect(() =>
      applyProductFulfillmentIntentForPublication({
        ...input,
        product: { ...changed, shippingCostSats: 100 },
        intent: { ...input.intent, eventOnlyChange: true },
      })
    ).toThrow("change fulfillment")
    expect(() =>
      applyProductFulfillmentIntentForPublication({
        ...input,
        product: { ...changed, visibility: "public" },
        intent: { ...input.intent, eventOnlyChange: true },
      })
    ).toThrow("change fulfillment")
    expect(getProductPreservedFulfillmentFields(changed).eventOnly).toBe(true)
  })

  it("blocks a digital conversion until the event-only choice is deliberately disabled", () => {
    const digital = { ...form(), format: "digital" as const, eventOnly: true }
    const result = validateProductPublishForm(digital, {
      hasPresetShippingZone: false,
    })
    expect(result.canPublish).toBe(false)
    expect(result.errors.eventOnly).toContain("physical product")
    expect(
      validateProductPublishForm(
        { ...digital, eventOnly: false },
        { hasPresetShippingZone: false }
      ).canPublish
    ).toBe(true)
  })

  it("keeps the digital conversion and malformed repair controls visible without promising admission", () => {
    const render = (
      format: "physical" | "digital",
      checked: boolean,
      malformed = false
    ) =>
      renderToStaticMarkup(
        <ProductEventOnlyField
          checked={checked}
          format={format}
          malformed={malformed}
          onChange={() => undefined}
        />
      )
    expect(render("physical", false)).toContain("Sell only at events")
    expect(render("physical", true)).toContain("approved product assignment")
    expect(render("digital", false)).toBe("")
    expect(render("digital", true)).toContain('role="alert"')
    expect(render("digital", false, true)).toContain(
      "other edits keep the existing setting"
    )
  })

  it("retains absent versus explicit false draft choices across reload", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    } as Storage
    const target = { merchantPubkey: merchant }
    for (const extra of [
      {},
      { eventOnly: false, eventOnlyEdited: false },
      { eventOnly: false, eventOnlyEdited: true },
      { eventOnly: true, eventOnlyEdited: true },
    ]) {
      expect(saveProductDraft(target, { ...form(), ...extra }, storage)).toBe(
        true
      )
      const saved = loadProductDraft(target, storage).draft!
      expect(saved.eventOnly).toBe(extra.eventOnly)
      expect(saved.eventOnlyEdited).toBe(extra.eventOnlyEdited)
    }
  })

  it("copies the opt-in to new variations and preserves each signed baseline during explicit edits", () => {
    const variations = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("size", "S, M", 0)],
    })
    const initial = buildProductFamilyChangePlan({
      parentDTag: "mug",
      baseProduct: product({ visibility: "private", eventOnly: true }),
      variations,
      currency: "SATS",
      fulfillmentIntent: { kind: "coordinate_after_order" },
      authoringCountries: [],
      now: 1_800_000_000_000,
    })
    expect(initial.desired).toHaveLength(3)
    expect(
      initial.desired.every(
        (row) => row.product.eventOnly && row.product.visibility === "private"
      )
    ).toBe(true)
    const records = initial.desired.map(record)
    const existing = { root: records[0]!, variations: records.slice(1) }
    const editedVariations = getProductVariationFormState(
      existing.root,
      existing.variations
    ).state
    const next = buildProductFamilyChangePlan({
      parentDTag: "mug",
      baseProduct: {
        ...existing.root.product,
        ...projectProductEventOnlyChoice(existing.root.product, false),
      },
      variations: editedVariations,
      currency: "SATS",
      fulfillmentIntent: {
        kind: "preserve_existing",
        baseline: existing.root.product,
        eventOnlyChange: false,
      },
      authoringCountries: [],
      existing,
      now: 1_800_000_001_000,
    })
    expect(next.publish).toHaveLength(3)
    expect(
      next.desired.every(
        (row) =>
          row.product.eventOnly === false && row.product.visibility === "public"
      )
    ).toBe(true)
    expect(
      next.desired.every(
        (row, index) =>
          row.fulfillmentIntent.kind === "preserve_existing" &&
          row.fulfillmentIntent.baseline === records[index]!.product
      )
    ).toBe(true)
  })
})
