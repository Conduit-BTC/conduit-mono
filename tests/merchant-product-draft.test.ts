import { describe, expect, it } from "bun:test"
import {
  clearProductDraft,
  clearProductVariationAuthoringState,
  getProductDraftStorageKey,
  isProductDraftOwnedBySigner,
  isProductDraftPublishAuthorized,
  loadProductVariationAuthoringState,
  loadProductDraft,
  ProductDraftStore,
  saveProductVariationAuthoringState,
  saveProductDraft,
  type ProductDraftTarget,
  type ProductVariationAuthoringTarget,
} from "../apps/merchant/src/lib/productDraft"
import type { MerchantProductFormValues } from "../apps/merchant/src/lib/productForm"
import {
  createProductVariationAxis,
  createEmptyProductVariationForm,
  generateProductVariationRows,
  setProductVariationCombinationIncluded,
  updateProductVariationOverride,
} from "../apps/merchant/src/lib/productVariations"

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class FailingStorage extends MemoryStorage {
  failRemovals = false
  failWrites = false

  override removeItem(key: string): void {
    if (this.failRemovals) throw new Error("remove blocked")
    super.removeItem(key)
  }

  override setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("write blocked")
    super.setItem(key, value)
  }
}

function target(
  overrides: Partial<ProductDraftTarget> = {}
): ProductDraftTarget {
  return {
    merchantPubkey: "a".repeat(64),
    ...overrides,
  }
}

function form(
  overrides: Partial<MerchantProductFormValues> = {}
): MerchantProductFormValues {
  return {
    title: "Pocket Relay",
    summary: "A local-first relay appliance",
    price: "25",
    stock: "12",
    variations: createEmptyProductVariationForm(),
    currency: "USD",
    format: "physical",
    fulfillment: "ship",
    eventMarketReference: "",
    eventHandoffMode: "merchant_handoff",
    merchantPickupTitle: "Merchant booth pickup",
    merchantPickupLocation: "",
    merchantPickupGeohash: "",
    merchantPickupCountry: "US",
    shippingPricingMode: "fixed",
    shippingCost: "5",
    usePresetShippingZone: false,
    customShippingConfig: {
      countries: [
        {
          code: "US",
          name: "United States",
          restrictTo: [],
          exclude: ["995"],
        },
      ],
    },
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    imageUrl: "https://example.com/pocket-relay.png",
    tags: "relay, hardware, nostr",
    ...overrides,
  }
}

describe("merchant product drafts", () => {
  it("keeps draft publication bound to the original merchant", () => {
    const accountA = "a".repeat(64)
    const accountB = "b".repeat(64)
    const accountATarget = target({ merchantPubkey: accountA })

    expect(isProductDraftOwnedBySigner(accountATarget, accountA)).toBe(true)
    expect(isProductDraftOwnedBySigner(accountATarget, accountB)).toBe(false)
    expect(
      isProductDraftPublishAuthorized(accountATarget, accountA, accountA)
    ).toBe(true)
    expect(
      isProductDraftPublishAuthorized(accountATarget, accountB, accountB)
    ).toBe(false)
    expect(
      isProductDraftPublishAuthorized(accountATarget, accountA, accountB)
    ).toBe(false)
  })

  it("isolates create and edit drafts by merchant and product", () => {
    expect(getProductDraftStorageKey(target())).not.toBe(
      getProductDraftStorageKey(
        target({
          productAddressId: `30402:${"a".repeat(64)}:pocket-relay`,
          baseEventId: "event-1",
        })
      )
    )
    expect(getProductDraftStorageKey(target())).not.toBe(
      getProductDraftStorageKey(
        target({
          merchantPubkey: "b".repeat(64),
        })
      )
    )
  })

  it("round-trips a create draft and clears it explicitly", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const values = form()

    expect(saveProductDraft(draftTarget, values, storage)).toBe(true)
    expect(loadProductDraft(draftTarget, storage)).toEqual({
      draft: values,
      storageAvailable: true,
    })

    expect(clearProductDraft(draftTarget, storage)).toBe(true)
    expect(loadProductDraft(draftTarget, storage).draft).toBeNull()
  })

  it("round-trips constrained variation options and overrides", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const generated = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("size", "S, M, L, XL")],
    })
    const medium = generated.rows.find(
      (row) => row.specifications[0]?.value === "M"
    )
    if (!medium) throw new Error("Expected M row")
    const customized = updateProductVariationOverride(
      updateProductVariationOverride(generated, medium.identity, "price", "30"),
      medium.identity,
      "stock",
      "4"
    )
    const variations = setProductVariationCombinationIncluded(
      customized,
      medium.identity,
      false
    )
    const values = form({ variations })

    expect(saveProductDraft(draftTarget, values, storage)).toBe(true)
    expect(loadProductDraft(draftTarget, storage).draft?.variations).toEqual(
      variations
    )
  })

  it("round-trips an exact local-pickup catalog reference", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const reference = `30405:${"b".repeat(64)}:community-market`
    const values = form({
      format: "physical",
      fulfillment: "local_pickup",
      eventMarketReference: reference,
    })

    expect(saveProductDraft(draftTarget, values, storage)).toBe(true)
    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      fulfillment: "local_pickup",
      eventMarketReference: reference,
      eventHandoffMode: "merchant_handoff",
    })
  })

  it("migrates pre-handoff local-pickup drafts without opting into organizer sharing", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const storedForm: Record<string, unknown> = {
      ...form({
        fulfillment: "local_pickup",
        eventMarketReference: `30405:${"b".repeat(64)}:community-market`,
      }),
    }
    delete storedForm.eventHandoffMode
    delete storedForm.merchantPickupTitle
    delete storedForm.merchantPickupLocation
    delete storedForm.merchantPickupGeohash
    delete storedForm.merchantPickupCountry

    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 4,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      fulfillment: "local_pickup",
      eventHandoffMode: "merchant_handoff",
      merchantPickupTitle: "Merchant booth pickup",
    })
  })

  it("preserves a version 5 organizer handoff and merchant pickup fields", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const reference = `30405:${"b".repeat(64)}:community-market`
    const storedForm: Record<string, unknown> = {
      ...form({
        fulfillment: "local_pickup",
        eventMarketReference: reference,
        eventHandoffMode: "organizer_handoff",
        merchantPickupTitle: "Saved booth",
        merchantPickupLocation: "Hall B",
        merchantPickupGeohash: "dr5ru",
        merchantPickupCountry: "CA",
      }),
    }
    delete storedForm.variations
    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 5,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      fulfillment: "local_pickup",
      eventMarketReference: reference,
      eventHandoffMode: "organizer_handoff",
      merchantPickupTitle: "Saved booth",
      merchantPickupLocation: "Hall B",
      merchantPickupGeohash: "dr5ru",
      merchantPickupCountry: "CA",
      variations: createEmptyProductVariationForm(),
    })
  })

  it("migrates the main version 5 availability shape without event fields", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const variations = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("size", "S, M")],
    })
    const storedForm: Record<string, unknown> = {
      ...form({ format: "digital", variations }),
    }
    delete storedForm.fulfillment
    delete storedForm.eventMarketReference
    delete storedForm.eventHandoffMode
    delete storedForm.merchantPickupTitle
    delete storedForm.merchantPickupLocation
    delete storedForm.merchantPickupGeohash
    delete storedForm.merchantPickupCountry

    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 5,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      format: "digital",
      fulfillment: "digital",
      eventMarketReference: "",
      eventHandoffMode: "merchant_handoff",
      variations,
    })
  })

  it("migrates the main version 4 variation shape without trusting event fields", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const generated = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("size", "S, M")],
    })
    const storedForm: Record<string, unknown> = {
      ...form({ format: "digital", variations: generated }),
    }
    delete storedForm.fulfillment
    delete storedForm.eventMarketReference
    delete storedForm.eventHandoffMode
    delete storedForm.merchantPickupTitle
    delete storedForm.merchantPickupLocation
    delete storedForm.merchantPickupGeohash
    delete storedForm.merchantPickupCountry
    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 4,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      format: "digital",
      fulfillment: "digital",
      eventMarketReference: "",
      eventHandoffMode: "merchant_handoff",
      variations: generated,
    })
  })

  it("does not infer local pickup while migrating a legacy physical draft", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const storedForm = form({
      format: "physical",
      fulfillment: "local_pickup",
      eventMarketReference: `30405:${"b".repeat(64)}:community-market`,
    })

    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 3,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      format: "physical",
      fulfillment: "ship",
      eventMarketReference: "",
    })
  })

  it("keeps published option authoring state separate and root-scoped", () => {
    const storage = new MemoryStorage()
    const authoringTarget: ProductVariationAuthoringTarget = {
      merchantPubkey: "a".repeat(64),
      productAddressId: `30402:${"a".repeat(64)}:pocket-relay`,
      rootEventId: "root-event-1",
    }
    const state = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("size", "S, M")],
    })
    const sparse = setProductVariationCombinationIncluded(
      state,
      state.rows[0]!.identity,
      false
    )

    expect(
      saveProductVariationAuthoringState(authoringTarget, sparse, storage)
    ).toBe(true)
    expect(
      loadProductVariationAuthoringState(authoringTarget, storage)
    ).toEqual({ state: sparse, storageAvailable: true })
    expect(
      loadProductVariationAuthoringState(
        { ...authoringTarget, rootEventId: "root-event-2" },
        storage
      )
    ).toEqual({ state: null, storageAvailable: true })
    expect(clearProductVariationAuthoringState(authoringTarget, storage)).toBe(
      true
    )
    expect(
      loadProductVariationAuthoringState(authoringTarget, storage).state
    ).toBeNull()
  })

  it("migrates legacy blank shipping drafts to explicit coordination", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const legacyForm = form({ shippingCost: "" })
    const storedForm: Record<string, unknown> = { ...legacyForm }
    delete storedForm.shippingPricingMode

    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      shippingPricingMode: "coordinate_after_order",
      shippingCost: "",
    })
  })

  it("migrates legacy exponent amounts to plain decimal input", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const legacyForm = form({ price: "1e3", shippingCost: "5e-1" })
    const storedForm: Record<string, unknown> = { ...legacyForm }
    delete storedForm.shippingPricingMode

    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      price: "1000",
      stock: "",
      shippingPricingMode: "fixed",
      shippingCost: "0.5",
    })
  })

  it("adds untracked stock to version 2 drafts without discarding them", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const storedForm: Record<string, unknown> = { ...form() }
    delete storedForm.stock

    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 2,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      title: "Pocket Relay",
      stock: "",
    })
  })

  it("adds disabled product options to version 3 drafts", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const storedForm: Record<string, unknown> = { ...form() }
    delete storedForm.variations

    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 3,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    expect(loadProductDraft(draftTarget, storage).draft?.variations).toEqual(
      createEmptyProductVariationForm()
    )
  })

  it("migrates version 4 variation rows as included", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const variations = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("option", "one, two")],
    })
    const legacyRows: Array<Record<string, unknown>> = variations.rows.map(
      (row) => ({ ...row })
    )
    for (const row of legacyRows) delete row.included
    const storedForm: Record<string, unknown> = { ...form() }
    storedForm.variations = { ...variations, rows: legacyRows }

    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 4,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    const restored = loadProductDraft(draftTarget, storage).draft?.variations
    expect(restored?.rows).toHaveLength(2)
    expect(restored?.rows.every(({ included }) => included)).toBe(true)
  })

  it("does not restore an edit draft after the source event changes", () => {
    const storage = new MemoryStorage()
    const addressId = `30402:${"a".repeat(64)}:pocket-relay`
    const originalTarget = target({
      productAddressId: addressId,
      baseEventId: "event-1",
    })
    const updatedTarget = target({
      productAddressId: addressId,
      baseEventId: "event-2",
    })

    expect(saveProductDraft(originalTarget, form(), storage)).toBe(true)
    expect(loadProductDraft(updatedTarget, storage)).toEqual({
      draft: null,
      storageAvailable: true,
    })
    expect(storage.length).toBe(0)
  })

  it("drops malformed drafts instead of trusting local storage", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        baseEventId: null,
        savedAt: Date.now(),
        form: { title: "Incomplete" },
      })
    )

    expect(loadProductDraft(draftTarget, storage)).toEqual({
      draft: null,
      storageAvailable: true,
    })
    expect(storage.length).toBe(0)
  })

  it("reports unavailable storage without throwing", () => {
    const draftTarget = target()

    expect(saveProductDraft(draftTarget, form(), null)).toBe(false)
    expect(clearProductDraft(draftTarget, null)).toBe(false)
    expect(loadProductDraft(draftTarget, null)).toEqual({
      draft: null,
      storageAvailable: false,
    })
  })

  it("writes a durable cleared marker when removal fails", () => {
    const storage = new FailingStorage()
    const draftTarget = target()

    expect(saveProductDraft(draftTarget, form(), storage)).toBe(true)
    storage.failRemovals = true

    expect(clearProductDraft(draftTarget, storage)).toBe(true)
    expect(loadProductDraft(draftTarget, storage)).toEqual({
      draft: null,
      storageAvailable: true,
    })
  })

  it("reports cleanup failure when neither removal nor marking works", () => {
    const storage = new FailingStorage()
    const draftTarget = target()
    const values = form()

    expect(saveProductDraft(draftTarget, values, storage)).toBe(true)
    storage.failRemovals = true
    storage.failWrites = true

    expect(clearProductDraft(draftTarget, storage)).toBe(false)
    expect(loadProductDraft(draftTarget, storage)).toEqual({
      draft: values,
      storageAvailable: true,
    })
  })

  it("suppresses a stale draft in memory until failed cleanup recovers", () => {
    const storage = new FailingStorage()
    const draftTarget = target()
    const store = new ProductDraftStore(storage)

    expect(store.save(draftTarget, form())).toBe(true)
    storage.failRemovals = true
    storage.failWrites = true

    expect(store.clear(draftTarget)).toBe(false)
    expect(store.load(draftTarget)).toEqual({
      draft: null,
      storageAvailable: false,
    })

    storage.failRemovals = false
    storage.failWrites = false
    expect(store.load(draftTarget)).toEqual({
      draft: null,
      storageAvailable: true,
    })
    expect(storage.length).toBe(0)
  })
})
