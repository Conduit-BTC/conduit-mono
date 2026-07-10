import { describe, expect, it } from "bun:test"
import {
  clearProductDraft,
  getProductDraftStorageKey,
  loadProductDraft,
  ProductDraftStore,
  saveProductDraft,
  type ProductDraftTarget,
} from "../apps/merchant/src/lib/productDraft"
import type { MerchantProductFormValues } from "../apps/merchant/src/lib/productForm"

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
    currency: "USD",
    format: "physical",
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
      shippingPricingMode: "fixed",
      shippingCost: "0.5",
    })
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
