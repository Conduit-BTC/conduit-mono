const PRODUCT_DRAFT_RETURN_STORAGE_PREFIX =
  "conduit:merchant:product_draft_return:v1"
const PRODUCT_DRAFT_RETURN_VERSION = 1

export type ProductDraftReturnState =
  "awaiting_inbox_setup" | "resume_requested"

export interface ProductDraftReturnIntent {
  version: typeof PRODUCT_DRAFT_RETURN_VERSION
  route: "/products"
  draftTarget: "create"
  state: ProductDraftReturnState
}

export interface ProductDraftReturnLoadResult {
  intent: ProductDraftReturnIntent | null
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

export function getProductDraftReturnStorageKey(
  merchantPubkey: string
): string | null {
  const normalizedPubkey = merchantPubkey.trim()
  if (!normalizedPubkey) return null

  return `${PRODUCT_DRAFT_RETURN_STORAGE_PREFIX}:${normalizeTargetPart(normalizedPubkey)}`
}

function parseProductDraftReturnIntent(
  raw: string
): ProductDraftReturnIntent | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return null

    const candidate = parsed as {
      version?: unknown
      route?: unknown
      draftTarget?: unknown
      state?: unknown
    }
    if (
      candidate.version !== PRODUCT_DRAFT_RETURN_VERSION ||
      candidate.route !== "/products" ||
      candidate.draftTarget !== "create" ||
      (candidate.state !== "awaiting_inbox_setup" &&
        candidate.state !== "resume_requested")
    ) {
      return null
    }

    return {
      version: PRODUCT_DRAFT_RETURN_VERSION,
      route: "/products",
      draftTarget: "create",
      state: candidate.state,
    }
  } catch {
    return null
  }
}

export function loadProductDraftReturnIntent(
  merchantPubkey: string,
  storage: Storage | null = getBrowserStorage()
): ProductDraftReturnLoadResult {
  const storageKey = getProductDraftReturnStorageKey(merchantPubkey)
  if (!storageKey || !storage) {
    return { intent: null, storageAvailable: false }
  }

  try {
    const raw = storage.getItem(storageKey)
    if (!raw) return { intent: null, storageAvailable: true }

    const intent = parseProductDraftReturnIntent(raw)
    if (!intent) storage.removeItem(storageKey)
    return { intent, storageAvailable: true }
  } catch {
    return { intent: null, storageAvailable: false }
  }
}

export function saveProductDraftReturnIntent(
  merchantPubkey: string,
  state: ProductDraftReturnState = "awaiting_inbox_setup",
  storage: Storage | null = getBrowserStorage()
): boolean {
  const storageKey = getProductDraftReturnStorageKey(merchantPubkey)
  if (!storageKey || !storage) return false

  const intent: ProductDraftReturnIntent = {
    version: PRODUCT_DRAFT_RETURN_VERSION,
    route: "/products",
    draftTarget: "create",
    state,
  }

  try {
    storage.setItem(storageKey, JSON.stringify(intent))
    return true
  } catch {
    return false
  }
}

export function requestProductDraftResume(
  merchantPubkey: string,
  storage: Storage | null = getBrowserStorage()
): boolean {
  const loaded = loadProductDraftReturnIntent(merchantPubkey, storage)
  if (!loaded.intent) return false

  return saveProductDraftReturnIntent(
    merchantPubkey,
    "resume_requested",
    storage
  )
}

export function clearProductDraftReturnIntent(
  merchantPubkey: string,
  storage: Storage | null = getBrowserStorage()
): boolean {
  const storageKey = getProductDraftReturnStorageKey(merchantPubkey)
  if (!storageKey || !storage) return false

  try {
    storage.removeItem(storageKey)
    return true
  } catch {
    return false
  }
}

export function consumeProductDraftResumeRequest(
  merchantPubkey: string,
  storage: Storage | null = getBrowserStorage()
): boolean {
  const loaded = loadProductDraftReturnIntent(merchantPubkey, storage)
  if (!loaded.intent || loaded.intent.state !== "resume_requested") return false

  return clearProductDraftReturnIntent(merchantPubkey, storage)
}
