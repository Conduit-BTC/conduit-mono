import { describe, expect, it } from "bun:test"
import {
  buildProductSupplierAllocation,
  pubkeyToNpub,
  type ProductSupplierAllocation,
} from "@conduit/core"
import {
  clearProductDraft,
  clearProductVariationAuthoringState,
  getProductDraftStorageKey,
  isProductDraftOwnedBySigner,
  isProductDraftPublishAuthorized,
  loadProductVariationAuthoringState,
  loadProductDraft,
  ProductDraftStore,
  restoreProductDraftSupplierAllocation,
  saveProductVariationAuthoringState,
  saveProductDraft,
  type ProductDraftTarget,
  type ProductVariationAuthoringTarget,
} from "../apps/merchant/src/lib/productDraft"
import {
  applyMerchantProductSupplierAllocationFormChange,
  validateMerchantProductSupplierAllocationForm,
  type MerchantProductFormValues,
} from "../apps/merchant/src/lib/productForm"
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

const SUPPLIER_MERCHANT =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const SUPPLIER =
  "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"

it("retains an unfinished supplier percentage and its publish blocker after draft recovery", () => {
  const storage = new MemoryStorage()
  const draftTarget = target({ merchantPubkey: SUPPLIER_MERCHANT })
  const values = form({
    supplierAllocationEnabled: true,
    merchantAllocationWeight: "3",
    merchantAllocationRelayHint: "",
    supplierAllocations: [
      {
        identity: SUPPLIER,
        relayHint: "",
        weight: "1",
        percentageInput: "12.",
        percentageError: "Enter a percentage with at most two decimal places.",
      },
    ],
  })
  expect(saveProductDraft(draftTarget, values, storage)).toBe(true)
  const recovered = loadProductDraft(draftTarget, storage).draft!
  expect(recovered.supplierAllocations).toEqual(values.supplierAllocations)
  expect(
    validateMerchantProductSupplierAllocationForm(recovered, SUPPLIER_MERCHANT)
      .canPublish
  ).toBe(false)
})

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
    listingAreaCountry: "",
    listingAreaState: "",
    listingAreaPlaceId: null,
    listingAreaMode: "clear",
    price: "25",
    stock: "12",
    variations: createEmptyProductVariationForm(),
    currency: "USD",
    format: "physical",
    fulfillment: "ship",
    futureEventMarketReference: "",
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
    supplierAllocationEnabled: false,
    supplierAllocationRepairRequired: false,
    merchantAllocationWeight: "1",
    merchantAllocationRelayHint: "",
    supplierAllocations: [],
    images: [
      { url: "https://example.com/pocket-relay.png", alt: "Pocket Relay" },
      { url: "https://example.com/pocket-relay-side.png" },
    ],
    tags: "relay, hardware, nostr",
    ...overrides,
  }
}

function legacyForm(
  overrides: Partial<MerchantProductFormValues> = {}
): Record<string, unknown> {
  const current = form(overrides)
  const stored: Record<string, unknown> = {
    ...current,
    imageUrl: current.images[0]?.url ?? "",
  }
  delete stored.images
  return stored
}

describe("merchant product drafts", () => {
  it("round-trips version 13 supplier terms with listing-area and future-event snapshots", () => {
    const storage = new MemoryStorage()
    const draftTarget = target({ merchantPubkey: SUPPLIER_MERCHANT })
    const values = form({
      listingAreaCountry: "US",
      listingAreaState: "CA",
      listingAreaPlaceId: 5378538,
      listingAreaMode: "selected",
      listingAreaDefault: { location: "Oakland, California", geohash: "9q9p" },
      futureEventMarketReference: `30409:${"b".repeat(64)}:future-market`,
      supplierAllocationEnabled: true,
      merchantAllocationWeight: "3",
      merchantAllocationRelayHint: "wss://relay.conduit.market",
      supplierAllocations: [
        {
          identity: pubkeyToNpub(SUPPLIER),
          relayHint: "wss://nos.lol",
          weight: "1",
        },
      ],
    })
    const expectedTerms = validateMerchantProductSupplierAllocationForm(
      values,
      SUPPLIER_MERCHANT
    )
    expect(expectedTerms.canPublish).toBe(true)
    expect(saveProductDraft(draftTarget, values, storage)).toBe(true)
    expect(
      JSON.parse(storage.getItem(getProductDraftStorageKey(draftTarget)!)!)
        .version
    ).toBe(13)
    const loaded = loadProductDraft(draftTarget, storage)
    expect(loaded).toEqual({ draft: values, storageAvailable: true })
    expect(
      validateMerchantProductSupplierAllocationForm(
        loaded.draft!,
        SUPPLIER_MERCHANT
      )
    ).toEqual(expectedTerms)
    expect(loaded.draft!.supplierAllocations).not.toBe(
      values.supplierAllocations
    )
    expect(
      saveProductDraft(
        draftTarget,
        { ...loaded.draft!, title: "Copy title" },
        storage
      )
    ).toBe(true)
    expect(loadProductDraft(draftTarget, storage).draft).toEqual({
      ...values,
      title: "Copy title",
    })
    expect(
      validateMerchantProductSupplierAllocationForm(
        loadProductDraft(draftTarget, storage).draft!,
        SUPPLIER_MERCHANT
      )
    ).toEqual(expectedTerms)
  })

  it("retains explicit repair requirements across unrelated draft edits and reloads", () => {
    const storage = new MemoryStorage()
    const editTarget = target({
      productAddressId: `30402:${"a".repeat(64)}:item`,
      baseEventId: "revision-1",
    })
    const values = form({
      supplierAllocationEnabled: true,
      supplierAllocationRepairRequired: true,
    })
    expect(saveProductDraft(editTarget, values, storage)).toBe(true)
    const loaded = loadProductDraft(editTarget, storage).draft!
    expect(
      saveProductDraft(
        editTarget,
        { ...loaded, title: "Revised title" },
        storage
      )
    ).toBe(true)
    const reloaded = loadProductDraft(editTarget, storage).draft!
    expect(reloaded.supplierAllocationRepairRequired).toBe(true)
    expect(
      validateMerchantProductSupplierAllocationForm(
        reloaded,
        editTarget.merchantPubkey
      ).canPublish
    ).toBe(false)
    const removed = applyMerchantProductSupplierAllocationFormChange(reloaded, {
      enabled: false,
      merchantWeight: "1",
      merchantRelayHint: "",
      suppliers: [],
    })
    expect(saveProductDraft(editTarget, removed, storage)).toBe(true)
    expect(
      validateMerchantProductSupplierAllocationForm(
        loadProductDraft(editTarget, storage).draft!,
        editTarget.merchantPubkey
      ).canPublish
    ).toBe(true)
  })

  for (const version of [8, 9, 10, 11, 12]) {
    it(`migrates version ${version} listing-area drafts without inventing supplier absence for edits`, () => {
      const storage = new MemoryStorage()
      const values = form({
        listingAreaCountry: "CA",
        listingAreaPlaceId: 6167865,
        listingAreaMode: "selected",
        futureEventMarketReference: `30409:${"b".repeat(64)}:future-market`,
      })
      const legacy: Record<string, unknown> = { ...values }
      for (const field of [
        "supplierAllocationEnabled",
        "supplierAllocationRepairRequired",
        "merchantAllocationWeight",
        "merchantAllocationRelayHint",
        "supplierAllocations",
      ])
        delete legacy[field]
      for (const editing of [false, true]) {
        const draftTarget = target(
          editing
            ? {
                productAddressId: `30402:${"a".repeat(64)}:item`,
                baseEventId: "revision-1",
              }
            : {}
        )
        storage.setItem(
          getProductDraftStorageKey(draftTarget)!,
          JSON.stringify({
            version,
            savedAt: 1_700_000_000_000,
            baseEventId: editing ? "revision-1" : null,
            form: legacy,
          })
        )
        const loaded = loadProductDraft(draftTarget, storage)
        expect(loaded.draft).toMatchObject({
          title: values.title,
          listingAreaCountry: "CA",
          listingAreaPlaceId: 6167865,
          listingAreaMode: "selected",
          futureEventMarketReference: values.futureEventMarketReference,
          supplierAllocationEnabled: editing,
          supplierAllocationRepairRequired: editing,
        })
        expect(loaded.supplierAllocationAuthority).toBe(
          editing ? "legacy_edit_unknown" : undefined
        )
        expect(
          validateMerchantProductSupplierAllocationForm(
            loaded.draft!,
            draftTarget.merchantPubkey
          ).canPublish
        ).toBe(!editing)
        // Unknown supplier authority cannot become permission after autosave.
        expect(saveProductDraft(draftTarget, loaded.draft!, storage)).toBe(true)
        expect(
          loadProductDraft(draftTarget, storage).draft
            ?.supplierAllocationRepairRequired
        ).toBe(editing)
      }
    })
  }

  it("recovers explicit shared measurements and independent variation fields", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const variations = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      shareShippingMeasurements: true,
      axes: [createProductVariationAxis("Size", "Small, Large")],
    })
    variations.rows[0] = {
      ...variations.rows[0]!,
      shippingWeightGrams: "250",
      shippingLengthCm: "12",
      shippingWidthCm: "8",
      shippingHeightCm: "2",
      shippingWeightAllowanceGrams: "30",
      shippingHandling: "1.25",
      shippingWeightUnit: "lb",
    }
    const values = form({ shippingPricingMode: "weight_table", variations })
    expect(saveProductDraft(draftTarget, values, storage)).toBe(true)
    expect(loadProductDraft(draftTarget, storage).draft?.variations).toEqual(
      variations
    )
    const authoringTarget = {
      merchantPubkey: draftTarget.merchantPubkey,
      productAddressId: `30402:${draftTarget.merchantPubkey}:one`,
      rootEventId: "root-one",
    }
    expect(
      saveProductVariationAuthoringState(authoringTarget, variations, storage)
    ).toBe(true)
    expect(
      loadProductVariationAuthoringState(authoringTarget, storage).state
    ).toEqual(variations)
  })

  it("recovers product packing adjustments and imperial units without changing canonical grams", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const values = form({
      shippingPricingMode: "weight_table",
      shippingWeightGrams: "454",
      shippingWeightUnit: "lb",
      shippingWeightAllowanceGrams: "29",
      shippingHandling: "1.25",
    })
    expect(saveProductDraft(draftTarget, values, storage)).toBe(true)
    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject(values)
    const key = getProductDraftStorageKey(draftTarget)!
    const stored = JSON.parse(storage.getItem(key)!)
    stored.version = 11
    delete stored.form.shippingWeightUnit
    delete stored.form.shippingWeightAllowanceGrams
    delete stored.form.shippingHandling
    storage.setItem(key, JSON.stringify(stored))
    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      shippingWeightGrams: "454",
      shippingPricingMode: "weight_table",
    })
  })
  for (const draftTarget of [
    target(),
    target({
      productAddressId: `30402:${"a".repeat(64)}:event-product`,
      baseEventId: "b".repeat(64),
    }),
  ]) {
    it(`restores contact-free handoff in ${draftTarget.productAddressId ? "edit" : "create"} drafts`, () => {
      const storage = new MemoryStorage()
      for (const eventGuestContactOptional of [true, false, undefined]) {
        const selected = form({ eventGuestContactOptional })
        expect(saveProductDraft(draftTarget, selected, storage)).toBe(true)
        const restored = loadProductDraft(draftTarget, storage).draft
        expect(restored).not.toBeNull()
        expect(restored?.eventGuestContactOptional).toBe(
          eventGuestContactOptional
        )
      }
    })
  }

  for (const version of [8, 9]) {
    it(`retains independently versioned supplier-branch v${version} draft terms`, () => {
      const storage = new MemoryStorage()
      const draftTarget = target({
        productAddressId: `30402:${"a".repeat(64)}:item`,
        baseEventId: "revision-1",
      })
      const supplierAllocations = [
        {
          identity: pubkeyToNpub(SUPPLIER),
          relayHint: "wss://nos.lol",
          weight: "1",
        },
      ]
      const legacy: Record<string, unknown> = {
        ...form(),
        supplierAllocationEnabled: true,
        merchantAllocationWeight: "3",
        merchantAllocationRelayHint: "wss://relay.conduit.market",
        supplierAllocations,
      }
      for (const field of [
        "listingAreaCountry",
        "listingAreaState",
        "listingAreaPlaceId",
        "listingAreaMode",
        "listingAreaDefault",
      ])
        delete legacy[field]
      if (version === 8) delete legacy.supplierAllocationRepairRequired
      storage.setItem(
        getProductDraftStorageKey(draftTarget)!,
        JSON.stringify({
          version,
          savedAt: 1_700_000_000_000,
          baseEventId: "revision-1",
          form: legacy,
        })
      )
      const loaded = loadProductDraft(draftTarget, storage)
      expect(loaded.supplierAllocationAuthority).toBeUndefined()
      expect(loaded.draft).toMatchObject({
        supplierAllocationEnabled: true,
        supplierAllocationRepairRequired: version === 8,
        merchantAllocationWeight: "3",
        merchantAllocationRelayHint: "wss://relay.conduit.market",
        supplierAllocations,
        listingAreaCountry: "",
        listingAreaPlaceId: null,
        listingAreaMode: "unchanged",
      })
      expect(saveProductDraft(draftTarget, loaded.draft!, storage)).toBe(true)
      expect(loadProductDraft(draftTarget, storage).draft).toEqual(loaded.draft)
    })
  }

  it("restores unknown legacy edit terms only from present matching baseline evidence", () => {
    const storage = new MemoryStorage()
    const draftTarget = target({
      merchantPubkey: SUPPLIER_MERCHANT,
      productAddressId: `30402:${SUPPLIER_MERCHANT}:item`,
      baseEventId: "revision-1",
    })
    const legacy: Record<string, unknown> = {
      ...form({ title: "Draft title" }),
    }
    for (const field of [
      "supplierAllocationEnabled",
      "supplierAllocationRepairRequired",
      "merchantAllocationWeight",
      "merchantAllocationRelayHint",
      "supplierAllocations",
    ])
      delete legacy[field]
    storage.setItem(
      getProductDraftStorageKey(draftTarget)!,
      JSON.stringify({
        version: 10,
        savedAt: 1_700_000_000_000,
        baseEventId: "revision-1",
        form: legacy,
      })
    )
    const store = new ProductDraftStore(storage)
    const loaded = store.load(draftTarget)
    const missing = restoreProductDraftSupplierAllocation(loaded, undefined)
    expect(missing).toBe(loaded.draft)
    expect(missing).toMatchObject({
      supplierAllocationEnabled: true,
      supplierAllocationRepairRequired: true,
    })
    expect(
      validateMerchantProductSupplierAllocationForm(missing!, SUPPLIER_MERCHANT)
        .canPublish
    ).toBe(false)

    const built = buildProductSupplierAllocation({
      merchantPubkey: SUPPLIER_MERCHANT,
      merchantWeight: "3",
      merchantRelayHint: "wss://relay.conduit.market",
      suppliers: [
        { identity: SUPPLIER, relayHint: "wss://nos.lol", weight: "1" },
      ],
    })
    if (!built.ok) throw new Error("Expected normal supplier terms")
    const baselines: ProductSupplierAllocation[] = [
      built.allocation,
      { state: "absent", recipients: [], issues: [] },
      { ...built.allocation, state: "invalid", issues: ["invalid_version"] },
    ]
    for (const baseline of baselines) {
      const restored = restoreProductDraftSupplierAllocation(loaded, baseline)!
      expect(restored.title).toBe("Draft title")
      expect(restored.supplierAllocationEnabled).toBe(
        baseline.state !== "absent"
      )
      expect(restored.supplierAllocationRepairRequired).toBe(
        baseline.state === "invalid"
      )
      const validation = validateMerchantProductSupplierAllocationForm(
        restored,
        SUPPLIER_MERCHANT
      )
      expect(validation.canPublish).toBe(baseline.state !== "invalid")
      if (baseline.state === "valid")
        expect(validation.allocation).toEqual(baseline)
    }
    // Once saved in v11, the user's explicit form state takes precedence.
    expect(store.save(draftTarget, missing!)).toBe(true)
    const current = store.load(draftTarget)
    expect(
      restoreProductDraftSupplierAllocation(current, built.allocation)
    ).toBe(current.draft)
    expect(current.draft?.supplierAllocationRepairRequired).toBe(true)
    // The existing loader still refuses a different source revision first.
    const changedRevision = store.load({
      ...draftTarget,
      baseEventId: "revision-2",
    })
    expect(
      restoreProductDraftSupplierAllocation(changedRevision, built.allocation)
    ).toBeNull()
  })

  it("rejects malformed contact-free handoff settings", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    saveProductDraft(draftTarget, form(), storage)
    const key = getProductDraftStorageKey(draftTarget)!
    const stored = JSON.parse(storage.getItem(key)!)
    for (const setting of ["true", "false", 1, null]) {
      stored.form.eventGuestContactOptional = setting
      const raw = JSON.stringify(stored)
      storage.setItem(key, raw)
      expect(loadProductDraft(draftTarget, storage).draft).toBeNull()
    }
  })

  it("rejects retired event pickup drafts explicitly without deleting or reinterpreting them", () => {
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      const storage = new MemoryStorage()
      const draftTarget = target()
      const storageKey = getProductDraftStorageKey(draftTarget)!
      const raw = JSON.stringify({
        version,
        baseEventId: null,
        savedAt: 100,
        form: {
          ...form(),
          fulfillment: "local_pickup",
          eventMarketReference: `30405:${"b".repeat(64)}:old-event`,
        },
      })
      storage.setItem(storageKey, raw)
      const loaded = loadProductDraft(draftTarget, storage)
      expect(loaded.draft).toBeNull()
      expect(loaded.storageAvailable).toBe(true)
      expect(loaded.error).toContain("retired event model")
      expect(storage.getItem(storageKey)).toBe(raw)
    }
  })

  it("keeps the ships from default as a draft snapshot", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const selected = form({
      listingAreaMode: "default",
      listingAreaDefault: {
        location: "Oakland, Alameda County, California, United States",
        geohash: "9q9p",
      },
    })
    expect(saveProductDraft(draftTarget, selected, storage)).toBe(true)
    expect(loadProductDraft(draftTarget, storage).draft).toEqual(selected)
  })

  it("retains a selected listing-area ID and rejects unsupported country drafts", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const selected = form({
      listingAreaCountry: "US",
      listingAreaState: "CA",
      listingAreaPlaceId: 5378538,
      listingAreaMode: "selected",
    })
    expect(saveProductDraft(draftTarget, selected, storage)).toBe(true)
    expect(loadProductDraft(draftTarget, storage).draft).toEqual(selected)
    const key = getProductDraftStorageKey(draftTarget)!
    const tampered = JSON.parse(storage.getItem(key)!)
    tampered.form.listingAreaCountry = "RU"
    storage.setItem(key, JSON.stringify(tampered))
    expect(loadProductDraft(draftTarget, storage).draft).toBeNull()
    tampered.form.listingAreaCountry = "US"
    tampered.form.listingAreaState = "XX"
    storage.setItem(key, JSON.stringify(tampered))
    expect(loadProductDraft(draftTarget, storage).draft).toBeNull()
  })

  it("clears a version 8 US place that has no state partition", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const selected = form({
      listingAreaCountry: "US",
      listingAreaState: "CA",
      listingAreaPlaceId: 5378538,
      listingAreaMode: "selected",
    })
    saveProductDraft(draftTarget, selected, storage)
    const key = getProductDraftStorageKey(draftTarget)!
    const stored = JSON.parse(storage.getItem(key)!)
    stored.version = 8
    delete stored.form.listingAreaState
    storage.setItem(key, JSON.stringify(stored))
    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      listingAreaCountry: "US",
      listingAreaState: "",
      listingAreaPlaceId: null,
      listingAreaMode: "clear",
    })
  })
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

  it("migrates legacy comma-delimited variation image drafts once", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)
    if (!storageKey) throw new Error("Expected a product draft storage key")
    const variations = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("size", "S")],
    })
    variations.rows[0]!.imageUrls =
      "https://example.com/front.png, https://example.com/back.png"
    variations.rows[0]!.inheritImages = false
    const storedForm = legacyForm({ variations })

    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 6,
        baseEventId: null,
        savedAt: Date.now(),
        form: storedForm,
      })
    )

    expect(
      loadProductDraft(draftTarget, storage).draft?.variations.rows[0]
        ?.imageUrls
    ).toBe("https://example.com/front.png\nhttps://example.com/back.png")
  })

  it("retains a current Event Market association without changing shop shipping", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const reference = `30409:${"b".repeat(64)}:future-market`
    expect(
      saveProductDraft(
        draftTarget,
        form({
          fulfillment: "ship",
          futureEventMarketReference: reference,
        }),
        storage
      )
    ).toBe(true)
    expect(loadProductDraft(draftTarget, storage).draft).toMatchObject({
      fulfillment: "ship",
      futureEventMarketReference: reference,
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
    const storedForm = legacyForm({ format: "digital", variations })
    delete storedForm.fulfillment

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
    const storedForm = legacyForm({
      format: "digital",
      variations: generated,
    })
    delete storedForm.fulfillment
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
      variations: generated,
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
    const storedForm = legacyForm({ shippingCost: "" })
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
    const storedForm = legacyForm({ price: "1e3", shippingCost: "5e-1" })
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
    const storedForm = legacyForm()
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
    const storedForm = legacyForm()
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
    const storedForm = legacyForm()
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

  it("treats malformed JSON as an invalid draft without misreporting unavailable storage", () => {
    const storage = new MemoryStorage()
    const draftTarget = target()
    const storageKey = getProductDraftStorageKey(draftTarget)!
    storage.setItem(storageKey, "{invalid-json")
    expect(loadProductDraft(draftTarget, storage)).toEqual({
      draft: null,
      storageAvailable: true,
    })
    expect(storage.getItem(storageKey)).toBeNull()
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

describe("preserved fulfillment drafts", () => {
  it("restores an unchanged association only for its exact existing product revision", () => {
    const storage = new MemoryStorage()
    const edit = target({
      productAddressId: `30402:${"a".repeat(64)}:product`,
      baseEventId: "revision-one",
    })
    const values = form({ fulfillment: "preserve", stock: "3" })
    expect(saveProductDraft(edit, values, storage)).toBe(true)
    expect(loadProductDraft(edit, storage).draft).toEqual(values)
    expect(
      loadProductDraft({ ...edit, baseEventId: "revision-two" }, storage).draft
    ).toBeNull()
  })

  it("does not restore preserve mode into a new-product draft", () => {
    const storage = new MemoryStorage()
    saveProductDraft(target(), form({ fulfillment: "preserve" }), storage)
    expect(loadProductDraft(target(), storage).draft).toBeNull()
  })
})
