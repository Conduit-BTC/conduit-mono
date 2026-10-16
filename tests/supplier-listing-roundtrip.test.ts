import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  allocateProductSupplierShares,
  admitPublicEvent,
  buildProductListingEventDraft,
  buildProductSupplierAllocation,
  deriveCheckoutSparkSignedCommerceObligations,
  parseProductEvent,
  parseProductSupplierAllocationTags,
  type ProductSchema,
} from "@conduit/core"
import {
  loadProductDraft,
  saveProductDraft,
} from "../apps/merchant/src/lib/productDraft"
import {
  getMerchantProductSupplierAllocationFormState,
  validateMerchantProductSupplierAllocationForm,
  type MerchantProductFormValues,
} from "../apps/merchant/src/lib/productForm"
import { createEmptyProductVariationForm } from "../apps/merchant/src/lib/productVariations"

const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const supplier = getPublicKey(generateSecretKey())
const nextSupplier = getPublicKey(generateSecretKey())
const relay = "wss://relay.conduit.market"
const createdAt = 1_800_000_000

function allocation(supplierPubkey = supplier) {
  const result = buildProductSupplierAllocation({
    merchantPubkey: merchant,
    merchantRelayHint: relay,
    merchantWeight: 3,
    suppliers: [{ identity: supplierPubkey, relayHint: relay, weight: 1 }],
  })
  if (!result.ok) throw new Error("Expected valid synthetic supplier terms")
  return result.allocation
}

function product(): ProductSchema {
  return {
    id: `30402:${merchant}:supplier-item`,
    pubkey: merchant,
    title: "Synthetic supplier item",
    summary: "A digital item with signed supplier terms.",
    price: 1_003,
    currency: "SAT",
    type: "simple",
    format: "digital",
    visibility: "public",
    specifications: [],
    images: [],
    tags: ["digital", "supplier", "test"],
    stock: 5,
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    location: "Synthetic listing area",
    geohash: "9q9p",
    eventMarketRefs: [`30409:${merchant}:synthetic-market`],
    supplierAllocation: allocation(),
    createdAt: createdAt * 1_000,
    updatedAt: createdAt * 1_000,
  }
}

function sign(input: ProductSchema, at = createdAt) {
  const draft = buildProductListingEventDraft({
    product: input,
    dTag: "supplier-item",
  })
  const event = finalizeEvent({ ...draft, created_at: at }, merchantSecret)
  return admitSignedProduct(event)
}

async function admitSignedProduct(event: ReturnType<typeof finalizeEvent>) {
  const admission = await admitPublicEvent(event)
  if (admission.status !== "verified")
    throw new Error("Expected verified signed supplier listing fixture")
  return {
    event,
    parsed: { ...parseProductEvent(admission.event), sourceEventId: event.id },
  }
}

function draftForm(): MerchantProductFormValues {
  return {
    title: "Synthetic supplier item",
    summary: "A digital item with signed supplier terms.",
    listingAreaCountry: "",
    listingAreaState: "",
    listingAreaPlaceId: null,
    listingAreaMode: "clear",
    price: "1003",
    stock: "5",
    variations: createEmptyProductVariationForm(),
    currency: "SAT",
    format: "digital",
    fulfillment: "digital",
    eventMarketReference: "",
    futureEventMarketReference: "",
    eventHandoffMode: "merchant_handoff",
    merchantPickupTitle: "Merchant booth pickup",
    merchantPickupLocation: "",
    merchantPickupGeohash: "",
    merchantPickupCountry: "US",
    shippingPricingMode: "fixed",
    shippingCost: "",
    usePresetShippingZone: false,
    customShippingConfig: { countries: [] },
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    images: [],
    tags: "digital, supplier, test",
    ...getMerchantProductSupplierAllocationFormState(allocation()),
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
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
}

describe("supplier listing authoring roundtrip", () => {
  it("retains form terms through draft reload, signed emission and router admission", async () => {
    const storage = memoryStorage()
    const target = { merchantPubkey: merchant }
    expect(saveProductDraft(target, draftForm(), storage)).toBe(true)
    const loaded = loadProductDraft(target, storage)
    expect(loaded.draft).not.toBeNull()
    const validation = validateMerchantProductSupplierAllocationForm(
      loaded.draft!,
      merchant
    )
    expect(validation.canPublish).toBe(true)
    const { event, parsed } = await sign({
      ...product(),
      supplierAllocation: validation.allocation,
      eventMarketRefs: [],
    })
    const obligations = deriveCheckoutSparkSignedCommerceObligations({
      merchantPubkey: merchant,
      quote: {
        commerceTotalSats: 1_003,
        lines: [
          {
            productCoordinate: parsed.id,
            productEventId: event.id,
            merchantPubkey: merchant,
            quantity: 1,
            unitMerchandiseSats: 1_003,
            unitShippingSats: 0,
          },
        ],
      },
      products: [parsed],
    })
    expect(obligations).toEqual([
      { kind: "merchant", recipientId: merchant, amountSats: 753 },
      { kind: "supplier", recipientId: supplier, amountSats: 250 },
    ])
    expect(parsed.publicZapEnabled).toBe(false)
  })

  it("emits exact public terms without enabling public zap payments", async () => {
    const { event, parsed } = await sign(product())
    expect(event.tags).toContainEqual(["conduit_supplier_allocation", "1"])
    expect(event.tags.filter(([tag]) => tag === "zap")).toEqual([
      ["zap", merchant, relay + "/", "3"],
      ["zap", supplier, relay + "/", "1"],
    ])
    expect(event.tags).toContainEqual(["checkout_public_zaps", "false"])
    expect(event.tags).toContainEqual(["location", "Synthetic listing area"])
    expect(event.tags).toContainEqual(["g", "9q9p"])
    expect(event.tags).toContainEqual([
      "a",
      `30409:${merchant}:synthetic-market`,
    ])
    expect(event.content).toBe(product().summary!)
    expect(
      parseProductSupplierAllocationTags({
        merchantPubkey: merchant,
        tags: event.tags,
        signedRevisionEvent: event,
      })
    ).toEqual(parsed.supplierAllocation)
    expect(parsed.supplierAllocation?.revisionEventId).toBe(event.id)
    expect(parsed.publicZapEnabled).toBe(false)
    expect(
      allocateProductSupplierShares(1_003, parsed.supplierAllocation!)
    ).toEqual([
      { pubkey: merchant, role: "merchant", sats: 753 },
      { pubkey: supplier, role: "supplier", sats: 250 },
    ])
  })

  it("preserves allocation when an unrelated stock revision is signed", async () => {
    const initial = await sign(product())
    const revised = await sign({ ...initial.parsed, stock: 4 }, createdAt + 1)
    expect(revised.event.id).not.toBe(initial.event.id)
    expect(revised.event.tags.filter(([tag]) => tag === "zap")).toEqual(
      initial.event.tags.filter(([tag]) => tag === "zap")
    )
    expect(revised.parsed.stock).toBe(4)
    expect(revised.parsed.supplierAllocation?.revisionEventId).toBe(
      revised.event.id
    )
    expect(
      parseProductSupplierAllocationTags({
        merchantPubkey: merchant,
        tags: revised.event.tags,
        signedRevisionEvent: revised.event,
      })
    ).toEqual(revised.parsed.supplierAllocation)
    const tamperedRevision = {
      ...revised.event,
      content: "Changed unsigned supplier listing fields",
    }
    const tamperedAdmission = await admitPublicEvent(tamperedRevision)
    expect(tamperedAdmission.status).not.toBe("verified")
    const tamperedTerms = parseProductSupplierAllocationTags({
      merchantPubkey: merchant,
      tags: tamperedRevision.tags,
      signedRevisionEvent: tamperedRevision,
    })
    expect(tamperedTerms.revisionEvent).toBeUndefined()
    expect(tamperedTerms.revisionEventId).toBeUndefined()
    expect(initial.parsed.supplierAllocation?.revisionEventId).toBe(
      initial.event.id
    )
  })

  it("rejects malformed or mismatched terms before creating an unsigned draft", () => {
    expect(() =>
      sign({
        ...product(),
        supplierAllocation: {
          state: "invalid",
          recipients: [],
          issues: ["missing_merchant"],
        },
      })
    ).toThrow("Product supplier allocation evidence is malformed")
    const wrongAuthor = getPublicKey(generateSecretKey())
    expect(() => sign({ ...product(), pubkey: wrongAuthor })).toThrow(
      "Product supplier allocation merchant must match the product author"
    )
  })

  it("rotation and explicit removal produce new revisions without changing prior terms", async () => {
    const initial = await sign(product())
    const rotated = await sign(
      { ...initial.parsed, supplierAllocation: allocation(nextSupplier) },
      createdAt + 1
    )
    const removed = await sign(
      {
        ...rotated.parsed,
        supplierAllocation: { state: "absent", recipients: [], issues: [] },
      },
      createdAt + 2
    )
    expect(rotated.parsed.supplierAllocation?.recipients[1]?.pubkey).toBe(
      nextSupplier
    )
    expect(initial.parsed.supplierAllocation?.recipients[1]?.pubkey).toBe(
      supplier
    )
    expect(
      removed.event.tags.some(
        ([tag]) => tag === "zap" || tag === "conduit_supplier_allocation"
      )
    ).toBe(false)
    expect(removed.parsed.supplierAllocation?.state).toBe("absent")
    expect(removed.parsed.supplierAllocation?.revisionEventId).toBe(
      removed.event.id
    )
    expect(
      new Set([initial.event.id, rotated.event.id, removed.event.id]).size
    ).toBe(3)
  })

  it("admits the generated signed revision to private router allocation", async () => {
    // Router admission is distinct from publication or payment settlement.
    const { event, parsed } = await sign({ ...product(), eventMarketRefs: [] })
    const result = deriveCheckoutSparkSignedCommerceObligations({
      merchantPubkey: merchant,
      quote: {
        commerceTotalSats: 1_003,
        lines: [
          {
            productCoordinate: parsed.id,
            productEventId: event.id,
            merchantPubkey: merchant,
            quantity: 1,
            unitMerchandiseSats: 1_003,
            unitShippingSats: 0,
          },
        ],
      },
      products: [parsed],
    })
    expect(result).toEqual([
      { kind: "merchant", recipientId: merchant, amountSats: 753 },
      { kind: "supplier", recipientId: supplier, amountSats: 250 },
    ])
  })
})
