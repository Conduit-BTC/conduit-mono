import { expect, it } from "bun:test"
import {
  getProductDraftStorageKey,
  loadProductDraft,
  saveProductDraft,
} from "../apps/merchant/src/lib/productDraft"
import {
  validateMerchantProductSupplierAllocationForm,
  type MerchantProductFormValues,
} from "../apps/merchant/src/lib/productForm"
import { createEmptyProductVariationForm } from "../apps/merchant/src/lib/productVariations"

const MERCHANT =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const SUPPLIER =
  "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}
const target = {
  merchantPubkey: MERCHANT,
  productAddressId: `30402:${MERCHANT}:fixture`,
  baseEventId: "synthetic-base",
}
function form(): MerchantProductFormValues {
  return {
    title: "Draft fixture",
    summary: "Synthetic product draft",
    price: "100",
    stock: "1",
    currency: "SATS",
    format: "physical",
    fulfillment: "ship",
    variations: createEmptyProductVariationForm(),
    listingAreaCountry: "CA",
    listingAreaState: "",
    listingAreaPlaceId: 6167865,
    listingAreaMode: "selected",
    futureEventMarketReference: `30409:${MERCHANT}:fixture`,
    shippingPricingMode: "fixed",
    shippingCost: "0",
    usePresetShippingZone: false,
    customShippingConfig: { countries: [] },
    images: [],
    tags: "synthetic",
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    supplierAllocationEnabled: true,
    supplierAllocationRepairRequired: false,
    merchantAllocationWeight: "3",
    merchantAllocationRelayHint: "wss://relay.conduit.market",
    supplierAllocations: [
      {
        identity: SUPPLIER,
        relayHint: "wss://nos.lol",
        weight: "1",
      },
    ],
  }
}
function stored(version: number, values: object) {
  const storage = new MemoryStorage()
  storage.setItem(
    getProductDraftStorageKey(target)!,
    JSON.stringify({
      version,
      baseEventId: target.baseEventId,
      savedAt: 1_800_000_000_000,
      form: values,
    })
  )
  return storage
}

it("preserves explicit supplier-branch v11 terms instead of reinterpreting them as main v11", () => {
  const values = form()
  const storage = stored(11, values)
  const loaded = loadProductDraft(target, storage)
  expect(loaded.supplierAllocationAuthority).toBeUndefined()
  expect(loaded.draft).toEqual(values)
  expect(
    validateMerchantProductSupplierAllocationForm(loaded.draft!, MERCHANT)
      .canPublish
  ).toBe(true)
  expect(saveProductDraft(target, loaded.draft!, storage)).toBe(true)
  expect(
    JSON.parse(storage.getItem(getProductDraftStorageKey(target)!)!).version
  ).toBe(13)
  expect(loadProductDraft(target, storage).draft).toEqual(values)
})

it.each([11, 12])(
  "keeps supplier-free main v%s edit authority unknown through autosave",
  (version) => {
    const values: Record<string, unknown> = { ...form() }
    for (const field of [
      "supplierAllocationEnabled",
      "supplierAllocationRepairRequired",
      "merchantAllocationWeight",
      "merchantAllocationRelayHint",
      "supplierAllocations",
    ])
      delete values[field]
    const storage = stored(version, values)
    const loaded = loadProductDraft(target, storage)
    expect(loaded.supplierAllocationAuthority).toBe("legacy_edit_unknown")
    expect(loaded.draft).toMatchObject({
      listingAreaCountry: "CA",
      listingAreaMode: "selected",
      supplierAllocationEnabled: true,
      supplierAllocationRepairRequired: true,
    })
    expect(
      validateMerchantProductSupplierAllocationForm(loaded.draft!, MERCHANT)
        .canPublish
    ).toBe(false)
    expect(saveProductDraft(target, loaded.draft!, storage)).toBe(true)
    expect(
      loadProductDraft(target, storage).draft?.supplierAllocationRepairRequired
    ).toBe(true)
    expect(
      validateMerchantProductSupplierAllocationForm(
        loadProductDraft(target, storage).draft!,
        MERCHANT
      ).canPublish
    ).toBe(false)
  }
)

it("does not interpret partial v11 supplier fields as explicit supplier absence", () => {
  const values: Record<string, unknown> = { ...form() }
  delete values.merchantAllocationRelayHint
  expect(loadProductDraft(target, stored(11, values)).draft).toBeNull()
})
