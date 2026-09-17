import {
  consumeMerchantPresentSaleAuthorization,
  db,
  getMerchantPresentSaleAuthorizationUseRef,
  getMerchantPresentSaleCommerceFingerprintRef,
  isValidSignedPublicNostrEvent,
  orderSchema,
  validateMerchantPresentSaleAuthorization,
  type MerchantPresentSaleAuthorizationSchema,
  type MerchantPresentSaleAuthorizationUse,
  type OrderSchema,
  type ParsedOrderMessage,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const REVIEW_STORAGE_KEY = "conduit:merchant-present-order-reviews:v1"
const USE_STORAGE_KEY = "conduit:merchant-present-authorization-uses:v1"
const USE_LOCK_NAME = "conduit:merchant-present-authorization-uses"

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

export interface MerchantPresentOrderReview {
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
  /**
   * Exact session-bound booth order sent to the merchant. Guest orders have no
   * self-copy or durable inbox, so this snapshot is the only local evidence
   * used to match the merchant's later authorization. It is intentionally
   * session-scoped and never shared with the organizer.
   */
  order: OrderSchema
  reviewedCommerceFingerprint: string
  reviewedCommerceFingerprintRef: string
  storedAt: number
}

type MerchantPresentOrderReviewRegistry = Record<
  string,
  MerchantPresentOrderReview
>

export type MerchantPresentOrderContext =
  | { status: "remote" }
  | {
      status: "unavailable"
      reason: string
    }
  | {
      status: "merchant_present"
      order: OrderSchema
      reviewedCommerceFingerprint: string
    }

export type MerchantPresentAuthorizationState =
  | { status: "remote" }
  | {
      status: "unavailable"
      reason: string
    }
  | {
      status: "waiting"
      order: OrderSchema
      reviewedCommerceFingerprint: string
    }
  | {
      status: "invalid"
      reason: string
      order: OrderSchema
      reviewedCommerceFingerprint: string
    }
  | {
      status: "ready"
      authorization: MerchantPresentSaleAuthorizationSchema
      order: OrderSchema
      reviewedCommerceFingerprint: string
      useRef: string
    }

export interface MerchantPresentAuthorizationLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => T | Promise<T>
  ): Promise<T>
}

function getSessionStorage(): StorageLike | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function getLocalStorage(): StorageLike | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function getLockManager(): MerchantPresentAuthorizationLockManager | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null
  return navigator.locks
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
}

function isReview(value: unknown): value is MerchantPresentOrderReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const review = value as Partial<MerchantPresentOrderReview>
  const order = orderSchema.safeParse(review.order)
  return (
    typeof review.orderId === "string" &&
    review.orderId.length > 0 &&
    isHex64(review.buyerPubkey) &&
    isHex64(review.merchantPubkey) &&
    typeof review.reviewedCommerceFingerprint === "string" &&
    review.reviewedCommerceFingerprint.length > 0 &&
    isHex64(review.reviewedCommerceFingerprintRef) &&
    order.success &&
    order.data.id === review.orderId &&
    order.data.buyerPubkey.toLowerCase() ===
      review.buyerPubkey?.toLowerCase() &&
    order.data.merchantPubkey.toLowerCase() ===
      review.merchantPubkey?.toLowerCase() &&
    order.data.purchaseContext?.type === "merchant_present" &&
    order.data.purchaseContext.reviewedCommerceFingerprintRef ===
      review.reviewedCommerceFingerprintRef &&
    Number.isSafeInteger(review.storedAt) &&
    (review.storedAt ?? 0) > 0
  )
}

function readReviewRegistry(
  storage: StorageLike | null = getSessionStorage()
): MerchantPresentOrderReviewRegistry {
  if (!storage) return {}
  try {
    const raw = storage.getItem(REVIEW_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      storage.removeItem(REVIEW_STORAGE_KEY)
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => isReview(value))
    )
  } catch {
    return {}
  }
}

/**
 * Persist the exact reviewed terms needed to revalidate a booth capability.
 * The record is session-scoped and must be written only after the exact order
 * payload has been constructed. It contains no signer key, invoice, preimage,
 * payment proof, or plaintext authorization.
 */
export function persistMerchantPresentOrderReview(
  input: {
    order: OrderSchema
    reviewedCommerceFingerprint: string
    storedAt?: number
  },
  storage: StorageLike | null = getSessionStorage()
): MerchantPresentOrderReview {
  const order = orderSchema.parse(input.order)
  const purchaseContext = order.purchaseContext
  if (purchaseContext?.type !== "merchant_present") {
    throw new Error("Only merchant-present orders have booth review context.")
  }
  const reviewedCommerceFingerprintRef =
    getMerchantPresentSaleCommerceFingerprintRef(
      input.reviewedCommerceFingerprint
    )
  if (
    reviewedCommerceFingerprintRef !==
    purchaseContext.reviewedCommerceFingerprintRef
  ) {
    throw new Error(
      "Reviewed booth terms do not match the signed order purchase context."
    )
  }
  if (!storage) {
    throw new Error(
      "This browser cannot retain the booth review for payment. Keep the order open in a supported browser."
    )
  }
  const review: MerchantPresentOrderReview = {
    orderId: order.id,
    buyerPubkey: order.buyerPubkey.toLowerCase(),
    merchantPubkey: order.merchantPubkey.toLowerCase(),
    order,
    reviewedCommerceFingerprint: input.reviewedCommerceFingerprint,
    reviewedCommerceFingerprintRef,
    storedAt: input.storedAt ?? Date.now(),
  }
  const registry = readReviewRegistry(storage)
  registry[order.id] = review
  storage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(registry))
  return review
}

export function getMerchantPresentOrderReview(
  orderId: string,
  storage: StorageLike | null = getSessionStorage()
): MerchantPresentOrderReview | null {
  return readReviewRegistry(storage)[orderId] ?? null
}

export function clearMerchantPresentOrderReview(
  orderId: string,
  storage: StorageLike | null = getSessionStorage()
): void {
  if (!storage) return
  const registry = readReviewRegistry(storage)
  if (!registry[orderId]) return
  delete registry[orderId]
  if (Object.keys(registry).length === 0) {
    storage.removeItem(REVIEW_STORAGE_KEY)
  } else {
    storage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(registry))
  }
}

function parseCachedOrderMessage(
  rawContent: string
): ParsedOrderMessage | null {
  try {
    const parsed = JSON.parse(rawContent) as Partial<ParsedOrderMessage>
    if (
      parsed.type !== "order" ||
      typeof parsed.id !== "string" ||
      typeof parsed.orderId !== "string" ||
      typeof parsed.senderPubkey !== "string" ||
      typeof parsed.recipientPubkey !== "string"
    ) {
      return null
    }
    const order = orderSchema.safeParse(parsed.payload)
    return order.success
      ? ({ ...parsed, payload: order.data } as ParsedOrderMessage)
      : null
  } catch {
    return null
  }
}

async function readCachedOrderMessages(
  orderId: string
): Promise<ParsedOrderMessage[]> {
  const rows = await db.orderMessages.where("orderId").equals(orderId).toArray()
  return rows.flatMap((row) => {
    const message = parseCachedOrderMessage(row.rawContent)
    return message ? [message] : []
  })
}

function exactOrderMessages(input: {
  messages: readonly ParsedOrderMessage[]
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
}): Array<Extract<ParsedOrderMessage, { type: "order" }>> {
  const buyerPubkey = input.buyerPubkey.toLowerCase()
  const merchantPubkey = input.merchantPubkey.toLowerCase()
  return input.messages.filter(
    (message): message is Extract<ParsedOrderMessage, { type: "order" }> =>
      message.type === "order" &&
      message.orderId === input.orderId &&
      message.payload.id === input.orderId &&
      message.senderPubkey.toLowerCase() === buyerPubkey &&
      message.recipientPubkey.toLowerCase() === merchantPubkey &&
      message.payload.buyerPubkey.toLowerCase() === buyerPubkey &&
      message.payload.merchantPubkey.toLowerCase() === merchantPubkey
  )
}

function sameOrder(left: OrderSchema, right: OrderSchema): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Resolve the exact signed/cached order and its session-bound reviewed terms. */
export async function resolveMerchantPresentOrderContext(input: {
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
  messages?: readonly ParsedOrderMessage[]
  storage?: StorageLike | null
  readCachedMessages?: (orderId: string) => Promise<ParsedOrderMessage[]>
}): Promise<MerchantPresentOrderContext> {
  const review = getMerchantPresentOrderReview(
    input.orderId,
    input.storage === undefined ? getSessionStorage() : input.storage
  )
  const suppliedMessages = input.messages ?? []
  let cachedMessages: ParsedOrderMessage[]
  try {
    cachedMessages = await (
      input.readCachedMessages ?? readCachedOrderMessages
    )(input.orderId)
  } catch {
    cachedMessages = []
  }
  const byId = new Map<string, ParsedOrderMessage>()
  for (const message of [...cachedMessages, ...suppliedMessages]) {
    byId.set(message.id, message)
  }
  const orders = exactOrderMessages({
    ...input,
    messages: Array.from(byId.values()),
  }).sort((left, right) => left.createdAt - right.createdAt)
  const first = orders[0]?.payload ?? review?.order

  if (!first) {
    return review
      ? {
          status: "unavailable",
          reason:
            "The exact signed booth order is not available on this device. Return to the booth checkout or ask the merchant to restart this sale; payment remains blocked.",
        }
      : { status: "remote" }
  }
  if (
    orders.some((message) => !sameOrder(first, message.payload)) ||
    (review && !sameOrder(first, review.order))
  ) {
    return {
      status: "unavailable",
      reason:
        "Conflicting signed order snapshots were found. Do not pay; ask the merchant to restart this sale.",
    }
  }

  if (first.purchaseContext?.type !== "merchant_present") {
    return review
      ? {
          status: "unavailable",
          reason:
            "The saved booth review does not match this signed order. Do not pay; return to the merchant booth and start again.",
        }
      : { status: "remote" }
  }
  if (
    !review ||
    review.buyerPubkey.toLowerCase() !== input.buyerPubkey.toLowerCase() ||
    review.merchantPubkey.toLowerCase() !==
      input.merchantPubkey.toLowerCase() ||
    review.reviewedCommerceFingerprintRef !==
      first.purchaseContext.reviewedCommerceFingerprintRef ||
    getMerchantPresentSaleCommerceFingerprintRef(
      review.reviewedCommerceFingerprint
    ) !== first.purchaseContext.reviewedCommerceFingerprintRef
  ) {
    return {
      status: "unavailable",
      reason:
        "This tab no longer has the exact price, payment destination, and pickup terms reviewed for the booth order. Payment remains blocked; review the sale with the merchant again.",
    }
  }
  return {
    status: "merchant_present",
    order: first,
    reviewedCommerceFingerprint: review.reviewedCommerceFingerprint,
  }
}

function getLatestAuthorizationMessage(
  messages: readonly ParsedOrderMessage[],
  order: OrderSchema
): Extract<
  ParsedOrderMessage,
  { type: "merchant_present_sale_authorization" }
> | null {
  return (
    messages
      .filter(
        (
          message
        ): message is Extract<
          ParsedOrderMessage,
          { type: "merchant_present_sale_authorization" }
        > =>
          message.type === "merchant_present_sale_authorization" &&
          message.orderId === order.id &&
          message.senderPubkey.toLowerCase() ===
            order.merchantPubkey.toLowerCase() &&
          message.recipientPubkey.toLowerCase() ===
            order.buyerPubkey.toLowerCase()
      )
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  )
}

/**
 * Derive the booth payment gate from an exact order and the latest
 * merchant-authored capability in its encrypted conversation.
 */
export function deriveMerchantPresentAuthorizationState(input: {
  context: MerchantPresentOrderContext
  messages?: readonly ParsedOrderMessage[]
  importedAuthorization?: MerchantPresentSaleAuthorizationSchema | null
  now?: number
}): MerchantPresentAuthorizationState {
  if (input.context.status !== "merchant_present") return input.context
  const message = getLatestAuthorizationMessage(
    input.messages ?? [],
    input.context.order
  )
  const authorization = input.importedAuthorization ?? message?.payload ?? null
  if (!authorization) {
    return {
      status: "waiting",
      order: input.context.order,
      reviewedCommerceFingerprint: input.context.reviewedCommerceFingerprint,
    }
  }
  try {
    const validated = validateMerchantPresentSaleAuthorization({
      authorization,
      order: input.context.order,
      reviewedCommerceFingerprint: input.context.reviewedCommerceFingerprint,
      now: input.now,
    })
    return {
      status: "ready",
      authorization: validated,
      order: input.context.order,
      reviewedCommerceFingerprint: input.context.reviewedCommerceFingerprint,
      useRef: getMerchantPresentSaleAuthorizationUseRef(validated),
    }
  } catch (error) {
    return {
      status: "invalid",
      reason:
        error instanceof Error
          ? error.message
          : "Merchant confirmation could not be verified.",
      order: input.context.order,
      reviewedCommerceFingerprint: input.context.reviewedCommerceFingerprint,
    }
  }
}

type AuthorizationUseRegistry = Record<string, number>

function readUseRegistry(storage: StorageLike): AuthorizationUseRegistry {
  try {
    const raw = storage.getItem(USE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([useRef, expiresAt]) =>
          isHex64(useRef) && Number.isSafeInteger(expiresAt) && expiresAt > 0
      )
    )
  } catch {
    return {}
  }
}

/**
 * Claim one opaque use reference under the browser's exclusive Web Lock.
 * There is deliberately no non-atomic fallback: unsupported storage blocks
 * payment instead of allowing two tabs to reuse one capability.
 */
export async function consumeMerchantPresentAuthorizationUseAtomically(
  use: MerchantPresentSaleAuthorizationUse,
  options: {
    storage?: StorageLike | null
    locks?: MerchantPresentAuthorizationLockManager | null
    now?: number
  } = {}
): Promise<boolean> {
  const storage =
    options.storage === undefined ? getLocalStorage() : options.storage
  const locks = options.locks === undefined ? getLockManager() : options.locks
  if (!storage || !locks) {
    throw new Error(
      "This browser cannot safely reserve a one-time booth confirmation. Use a supported browser or ask the merchant to complete the sale another way."
    )
  }
  if (!isHex64(use.useRef) || !Number.isSafeInteger(use.expiresAt)) {
    throw new Error("Booth confirmation use reference is invalid.")
  }
  return locks.request(USE_LOCK_NAME, { mode: "exclusive" }, async () => {
    const now = options.now ?? Math.floor(Date.now() / 1_000)
    const registry = Object.fromEntries(
      Object.entries(readUseRegistry(storage)).filter(
        ([, expiresAt]) => expiresAt > now
      )
    ) as AuthorizationUseRegistry
    if (registry[use.useRef]) return false
    registry[use.useRef] = use.expiresAt
    storage.setItem(USE_STORAGE_KEY, JSON.stringify(registry))
    return true
  })
}

/** Revalidate at click time and atomically consume the capability before pay. */
export async function consumeReadyMerchantPresentAuthorization(
  state: Extract<MerchantPresentAuthorizationState, { status: "ready" }>,
  options: {
    storage?: StorageLike | null
    locks?: MerchantPresentAuthorizationLockManager | null
    now?: number
  } = {}
): Promise<MerchantPresentSaleAuthorizationSchema> {
  return consumeMerchantPresentSaleAuthorization({
    authorization: state.authorization,
    order: state.order,
    reviewedCommerceFingerprint: state.reviewedCommerceFingerprint,
    now: options.now,
    consumeNonce: (use) =>
      consumeMerchantPresentAuthorizationUseAtomically(use, options),
  })
}

export function parseMerchantPresentDirectWrapText(
  text: string
): SignedPublicNostrEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      "Paste the complete signed booth confirmation from the merchant."
    )
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !isValidSignedPublicNostrEvent(parsed as SignedPublicNostrEvent)
  ) {
    throw new Error(
      "The pasted booth confirmation is not a valid signed event."
    )
  }
  return parsed as SignedPublicNostrEvent
}
