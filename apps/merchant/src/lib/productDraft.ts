import type { MerchantProductFormValues } from "./productForm"
import { parseShippingConfig } from "./readiness"

const PRODUCT_DRAFT_STORAGE_PREFIX = "conduit:merchant:product_draft:v1"
const PRODUCT_DRAFT_VERSION = 1
const CLEARED_PRODUCT_DRAFT_MARKER = "conduit:product-draft-cleared:v1"

export interface ProductDraftTarget {
  merchantPubkey: string
  productAddressId?: string | null
  baseEventId?: string | null
}

interface StoredProductDraft {
  version: typeof PRODUCT_DRAFT_VERSION
  baseEventId: string | null
  savedAt: number
  form: MerchantProductFormValues
}

export interface ProductDraftLoadResult {
  draft: MerchantProductFormValues | null
  storageAvailable: boolean
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function normalizeTargetPart(value: string): string {
  return encodeURIComponent(value.trim())
}

export function getProductDraftStorageKey(
  target: ProductDraftTarget
): string | null {
  const merchantPubkey = target.merchantPubkey.trim()
  if (!merchantPubkey) return null

  const draftScope = target.productAddressId?.trim()
    ? `edit:${normalizeTargetPart(target.productAddressId)}`
    : "create"
  return `${PRODUCT_DRAFT_STORAGE_PREFIX}:${normalizeTargetPart(merchantPubkey)}:${draftScope}`
}

function parseStoredProductDraft(raw: string): StoredProductDraft | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return null

    const candidate = parsed as {
      version?: unknown
      baseEventId?: unknown
      savedAt?: unknown
      form?: unknown
    }
    if (
      candidate.version !== PRODUCT_DRAFT_VERSION ||
      typeof candidate.savedAt !== "number" ||
      !Number.isFinite(candidate.savedAt) ||
      (candidate.baseEventId !== null &&
        typeof candidate.baseEventId !== "string") ||
      !candidate.form ||
      typeof candidate.form !== "object"
    ) {
      return null
    }

    const form = candidate.form as Record<string, unknown>
    const stringFields = [
      "title",
      "summary",
      "price",
      "currency",
      "shippingCost",
      "imageUrl",
      "tags",
    ] as const
    if (stringFields.some((field) => typeof form[field] !== "string")) {
      return null
    }
    if (
      (form.format !== "physical" && form.format !== "digital") ||
      typeof form.usePresetShippingZone !== "boolean" ||
      typeof form.publicZapEnabled !== "boolean" ||
      (form.zapMessagePolicy !== "generic_only" &&
        form.zapMessagePolicy !== "custom")
    ) {
      return null
    }

    return {
      version: PRODUCT_DRAFT_VERSION,
      baseEventId: candidate.baseEventId,
      savedAt: candidate.savedAt,
      form: {
        title: form.title as string,
        summary: form.summary as string,
        price: form.price as string,
        currency: form.currency as string,
        format: form.format,
        shippingCost: form.shippingCost as string,
        usePresetShippingZone: form.usePresetShippingZone,
        customShippingConfig: parseShippingConfig(
          JSON.stringify(form.customShippingConfig ?? null)
        ),
        publicZapEnabled: form.publicZapEnabled,
        zapMessagePolicy: form.zapMessagePolicy,
        imageUrl: form.imageUrl as string,
        tags: form.tags as string,
      },
    }
  } catch {
    return null
  }
}

export function loadProductDraft(
  target: ProductDraftTarget,
  storage: Storage | null = getBrowserStorage()
): ProductDraftLoadResult {
  const storageKey = getProductDraftStorageKey(target)
  if (!storageKey || !storage) {
    return { draft: null, storageAvailable: false }
  }

  try {
    const raw = storage.getItem(storageKey)
    if (!raw) return { draft: null, storageAvailable: true }
    if (raw === CLEARED_PRODUCT_DRAFT_MARKER) {
      return { draft: null, storageAvailable: true }
    }

    const stored = parseStoredProductDraft(raw)
    const expectedBaseEventId = target.productAddressId?.trim()
      ? (target.baseEventId?.trim() ?? null)
      : null
    if (!stored || stored.baseEventId !== expectedBaseEventId) {
      storage.removeItem(storageKey)
      return { draft: null, storageAvailable: true }
    }

    return { draft: stored.form, storageAvailable: true }
  } catch {
    return { draft: null, storageAvailable: false }
  }
}

export function saveProductDraft(
  target: ProductDraftTarget,
  form: MerchantProductFormValues,
  storage: Storage | null = getBrowserStorage()
): boolean {
  const storageKey = getProductDraftStorageKey(target)
  if (!storageKey || !storage) return false

  try {
    const stored: StoredProductDraft = {
      version: PRODUCT_DRAFT_VERSION,
      baseEventId: target.productAddressId?.trim()
        ? (target.baseEventId?.trim() ?? null)
        : null,
      savedAt: Date.now(),
      form,
    }
    storage.setItem(storageKey, JSON.stringify(stored))
    return true
  } catch {
    return false
  }
}

export function clearProductDraft(
  target: ProductDraftTarget,
  storage: Storage | null = getBrowserStorage()
): boolean {
  const storageKey = getProductDraftStorageKey(target)
  if (!storageKey || !storage) return false

  try {
    storage.removeItem(storageKey)
    return true
  } catch {
    try {
      storage.setItem(storageKey, CLEARED_PRODUCT_DRAFT_MARKER)
      return true
    } catch {
      return false
    }
  }
}

export class ProductDraftStore {
  private readonly suppressedStorageKeys = new Set<string>()

  constructor(private readonly storage?: Storage | null) {}

  load(target: ProductDraftTarget): ProductDraftLoadResult {
    const storageKey = getProductDraftStorageKey(target)
    if (storageKey && this.suppressedStorageKeys.has(storageKey)) {
      const cleared = clearProductDraft(target, this.storage)
      if (cleared) this.suppressedStorageKeys.delete(storageKey)
      return { draft: null, storageAvailable: cleared }
    }

    return loadProductDraft(target, this.storage)
  }

  save(target: ProductDraftTarget, form: MerchantProductFormValues): boolean {
    const saved = saveProductDraft(target, form, this.storage)
    const storageKey = getProductDraftStorageKey(target)
    if (saved && storageKey) this.suppressedStorageKeys.delete(storageKey)
    return saved
  }

  clear(target: ProductDraftTarget): boolean {
    const cleared = clearProductDraft(target, this.storage)
    const storageKey = getProductDraftStorageKey(target)
    if (storageKey) {
      if (cleared) {
        this.suppressedStorageKeys.delete(storageKey)
      } else {
        this.suppressedStorageKeys.add(storageKey)
      }
    }
    return cleared
  }
}
