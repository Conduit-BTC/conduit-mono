import {
  db,
  type OrderCheckoutMode,
  type OrderLifecycle,
  type OrderLifecyclePhase,
  type OrderPaymentTarget,
  type OrderPublicZapSigner,
  type StoredPaymentAttempt,
} from "../db"
import {
  decodeLightningInvoicePaymentHash,
  normalizeLightningInvoice,
  validateLightningInvoiceForPayment,
} from "./lightning"
import {
  getEffectiveMerchantOrderStatus,
  isMerchantOrderPaid,
} from "./order-status"
import type { ParsedOrderMessage } from "./orders"

export const GUEST_ORDER_LOCAL_RETENTION_MS = 24 * 60 * 60 * 1_000

export function isGuestOrderDataExpired(
  lifecycle: Pick<OrderLifecycle, "buyerIdentityKind" | "createdAt">,
  nowMs = Date.now(),
  retentionMs = GUEST_ORDER_LOCAL_RETENTION_MS
): boolean {
  return (
    lifecycle.buyerIdentityKind === "guest_ephemeral" &&
    lifecycle.createdAt <= nowMs - retentionMs
  )
}

/**
 * Durable buyer-side order lifecycle repository (CND-122).
 *
 * These helpers own all reads/writes to the `orderLifecycles` table. The Orders
 * page renders from these records so an order is visible immediately after
 * checkout — before relay readback and while a fast-zap payment is mid-flight.
 *
 * Privacy: callers must never forward sensitive fields (invoice, preimage,
 * shipping address, contact note) to telemetry. This module performs no logging.
 */

export function getOrderPublicZapSigner(
  mode: OrderCheckoutMode
): OrderPublicZapSigner | null {
  if (mode === "anonymous_public_zap") return "anon"
  if (mode === "public_zap_as_shopper" || mode === "public_zap") {
    return "shopper"
  }
  return null
}

export function isOrderPublicZapMode(mode: OrderCheckoutMode): boolean {
  return getOrderPublicZapSigner(mode) !== null
}

/**
 * Derive the coarse list-filtering bucket from the granular status fields.
 *
 * `failed` only when the order could not progress and no funds moved; once
 * payment has moved we treat the order as in progress (a proof-delivery hiccup
 * is recoverable and the merchant can still reconcile via the zap receipt).
 */
export function deriveOrderLifecyclePhase(
  lifecycle: Pick<
    OrderLifecycle,
    | "orderDeliveryStatus"
    | "invoiceStatus"
    | "paymentStatus"
    | "proofDeliveryStatus"
  > & { phase?: OrderLifecyclePhase }
): OrderLifecyclePhase {
  // A merchant-driven cancellation is sticky once set explicitly.
  if (lifecycle.phase === "cancelled") return "cancelled"
  if (lifecycle.phase === "completed") return "completed"

  if (lifecycle.orderDeliveryStatus === "failed") return "failed"

  if (lifecycle.paymentStatus === "paid") return "in_progress"

  if (
    lifecycle.paymentStatus === "paying" ||
    lifecycle.invoiceStatus === "requesting" ||
    lifecycle.invoiceStatus === "received" ||
    lifecycle.orderDeliveryStatus === "sent"
  ) {
    return "in_progress"
  }

  // A delivered order with moved/paying funds already returned "in_progress"
  // above, so reaching here with a failed payment means nothing landed.
  if (lifecycle.paymentStatus === "failed") return "failed"

  return "pending"
}

type CreateOrderLifecycleInput = Omit<
  OrderLifecycle,
  "createdAt" | "updatedAt" | "phase"
> & {
  createdAt?: number
  phase?: OrderLifecyclePhase
}

/**
 * Insert (or overwrite) a lifecycle record. Idempotent by `orderId`: re-running
 * checkout recovery for the same order updates the existing record rather than
 * creating a duplicate.
 */
export async function createOrderLifecycle(
  input: CreateOrderLifecycleInput
): Promise<OrderLifecycle> {
  const now = Date.now()
  const record: OrderLifecycle = {
    ...input,
    phase: input.phase ?? deriveOrderLifecyclePhase(input),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  }
  await db.orderLifecycles.put(record)
  return record
}

export async function getOrderLifecycle(
  orderId: string
): Promise<OrderLifecycle | undefined> {
  return db.orderLifecycles.get(orderId)
}

export type OrderPaymentClaimInput = {
  orderId: string
  paymentClaimId: string
  buyerPubkey: string
  merchantPubkey: string
  merchantLightningAddress: string | null
  checkoutMode: OrderCheckoutMode
  zapContent: string
  totalSats: number
  totalMsats: number
  items: Array<{ productAddress: string; quantity: number }>
  paymentTarget: OrderPaymentTarget
}

export type OrderPaymentClaimResult =
  | { status: "claimed"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }
  | {
      status: "snapshot_mismatch" | "unsafe_state"
      lifecycle: OrderLifecycle
    }

export type OrderPaymentPreparationFailureResult =
  | { status: "recorded"; lifecycle: OrderLifecycle }
  | Exclude<OrderPaymentClaimResult, { status: "claimed" }>

export type ClaimedOrderLifecyclePatchResult =
  | { status: "patched"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }
  | { status: "claim_mismatch"; lifecycle: OrderLifecycle }

export type ObservedOrderPaymentReceiptResult =
  | {
      status: "recorded"
      lifecycle: OrderLifecycle
      proofDeliveryClaimed: boolean
    }
  | { status: "missing"; lifecycle: null }
  | { status: "request_mismatch"; lifecycle: OrderLifecycle }

export type OrderPaymentReceiptTimeoutResult =
  | { status: "recorded" | "preserved"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }
  | { status: "request_mismatch"; lifecycle: OrderLifecycle }

export type OrderPaymentProofDeliveryResult =
  | { status: "recorded" | "preserved"; lifecycle: OrderLifecycle }
  | { status: "claim_mismatch"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }

export type OrderPaymentProofDeliveryClaimResult =
  | { status: "claimed" | "preserved"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }

export type OrderPaymentWalletSuccessRecoveryInput = {
  proofDeliveryStatus: "pending" | "retry_needed" | "sent"
  proofDeliveryClaimId?: string
  invoice: string
  paymentHash?: string
  preimage: string
  feeMsats?: number
  zapRequestId?: string
}

export type ExternalOrderPaymentProofClaimResult =
  | { status: "claimed" | "preserved"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }

export type MerchantInvoicePaymentBindingResult =
  | { status: "bound" | "preserved"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }

export type MerchantInvoiceReopenEvidence = {
  cancellationEventId: string
  buyerPubkey: string
  merchantPubkey: string
  messages: readonly ParsedOrderMessage[]
}

export type ProjectedMerchantInvoiceClaim = {
  buyerPubkey: string
  merchantPubkey: string
  totalMsats: number
  invoice: string
  paymentHash: string
  expiresAt: number
  reopenEvidence?: MerchantInvoiceReopenEvidence
}

export type ExternalOrderPaymentProofClaimOptions = {
  merchantInvoice?: ProjectedMerchantInvoiceClaim
  nowMs?: number
}

type AdmittedProjectedMerchantInvoice = {
  invoice: string
  paymentHash: string
  expiresAt: number
  alreadyBound: boolean
}

/** Recheck exact participant-bound correction evidence at a payment boundary. */
export function hasEffectiveMerchantInvoiceReopenEvidence(
  lifecycle: Pick<OrderLifecycle, "orderId" | "buyerPubkey" | "merchantPubkey">,
  evidence: MerchantInvoiceReopenEvidence | undefined
): boolean {
  if (
    !evidence ||
    !/^[0-9a-f]{64}$/.test(evidence.cancellationEventId) ||
    evidence.buyerPubkey !== lifecycle.buyerPubkey ||
    evidence.merchantPubkey !== lifecycle.merchantPubkey
  ) {
    return false
  }

  const exactOrderMessages = evidence.messages.filter(
    (message) => message.orderId === lifecycle.orderId
  )
  const projection = getEffectiveMerchantOrderStatus(exactOrderMessages, {
    buyerPubkey: evidence.buyerPubkey,
    merchantPubkey: evidence.merchantPubkey,
  })
  return (
    projection.reopenedCancellationId === evidence.cancellationEventId &&
    projection.knownStatus !== null &&
    projection.knownStatus !== "cancelled" &&
    projection.knownStatus !== "refund_requested" &&
    !isMerchantOrderPaid({ status: projection.knownStatus })
  )
}

function admitProjectedMerchantInvoice(
  lifecycle: OrderLifecycle,
  merchantInvoice: ProjectedMerchantInvoiceClaim,
  nowMs: number,
  allowExpired: boolean
): AdmittedProjectedMerchantInvoice | null {
  const invoice = normalizeLightningInvoice(merchantInvoice.invoice)
  const paymentHash = merchantInvoice.paymentHash.trim().toLowerCase()
  const decodedPaymentHash = decodeLightningInvoicePaymentHash(invoice)
  const invoiceValidation = validateLightningInvoiceForPayment({
    invoice,
    expectedAmountMsats: lifecycle.totalMsats,
    nowSeconds: Math.floor(nowMs / 1_000),
    allowExpired,
  })
  const awaitingMerchantInvoice =
    lifecycle.invoiceStatus === "not_requested" &&
    lifecycle.paymentStatus === "not_started" &&
    !lifecycle.invoice &&
    !lifecycle.paymentHash &&
    lifecycle.invoiceExpiresAt === undefined
  const sameActiveMerchantInvoice =
    lifecycle.invoiceStatus === "manual_required" &&
    lifecycle.paymentStatus === "manual_required" &&
    !!lifecycle.invoice &&
    normalizeLightningInvoice(lifecycle.invoice).toLowerCase() ===
      invoice.toLowerCase() &&
    (!lifecycle.paymentHash ||
      lifecycle.paymentHash.toLowerCase() === paymentHash) &&
    (lifecycle.invoiceExpiresAt === undefined ||
      lifecycle.invoiceExpiresAt === merchantInvoice.expiresAt)
  const exactActiveMerchantInvoice =
    sameActiveMerchantInvoice &&
    lifecycle.paymentHash?.toLowerCase() === paymentHash &&
    lifecycle.invoiceExpiresAt === merchantInvoice.expiresAt
  const publicZapSigner =
    lifecycle.publicZapSigner ?? getOrderPublicZapSigner(lifecycle.checkoutMode)
  const hasReopenEvidence = hasEffectiveMerchantInvoiceReopenEvidence(
    lifecycle,
    merchantInvoice.reopenEvidence
  )

  if (
    publicZapSigner ||
    lifecycle.checkoutMode !== "pay_later" ||
    lifecycle.orderDeliveryStatus !== "sent" ||
    lifecycle.phase === "completed" ||
    (lifecycle.phase === "cancelled" && !hasReopenEvidence) ||
    (merchantInvoice.reopenEvidence !== undefined && !hasReopenEvidence) ||
    lifecycle.proofDeliveryStatus !== "not_started" ||
    !!lifecycle.paymentClaimId ||
    lifecycle.buyerPubkey !== merchantInvoice.buyerPubkey ||
    lifecycle.merchantPubkey !== merchantInvoice.merchantPubkey ||
    lifecycle.totalMsats !== merchantInvoice.totalMsats ||
    !/^[0-9a-f]{64}$/.test(paymentHash) ||
    decodedPaymentHash !== paymentHash ||
    !invoiceValidation.ok ||
    invoiceValidation.metadata.expiresAt !== merchantInvoice.expiresAt ||
    !Number.isSafeInteger(merchantInvoice.expiresAt) ||
    merchantInvoice.expiresAt <= 0 ||
    (!awaitingMerchantInvoice && !sameActiveMerchantInvoice)
  ) {
    return null
  }

  return {
    invoice,
    paymentHash,
    expiresAt: merchantInvoice.expiresAt,
    alreadyBound: exactActiveMerchantInvoice,
  }
}

export type InterruptedOrderPaymentReconciliation =
  | { status: "recovered_before_payment"; lifecycle: OrderLifecycle }
  | { status: "restored_paid"; lifecycle: OrderLifecycle }
  | { status: "marked_ambiguous"; lifecycle: OrderLifecycle }
  | { status: "not_interrupted"; lifecycle: OrderLifecycle }
  | { status: "claim_mismatch"; lifecycle: OrderLifecycle }
  | { status: "claim_active"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }

export type LegacyInterruptedOrderPaymentReconciliation =
  | { status: "recovered_before_payment"; lifecycle: OrderLifecycle }
  | { status: "restored_paid"; lifecycle: OrderLifecycle }
  | { status: "marked_ambiguous"; lifecycle: OrderLifecycle }
  | { status: "not_legacy_interrupted"; lifecycle: OrderLifecycle }
  | { status: "not_stale"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }

export type InterruptedOrderProofDeliveryReconciliation =
  | { status: "recovered"; lifecycle: OrderLifecycle }
  | {
      status: "claim_active" | "claim_mismatch" | "not_interrupted"
      lifecycle: OrderLifecycle
    }
  | { status: "missing"; lifecycle: null }

export const ORDER_PAYMENT_CLAIM_LEASE_MS = 15_000
export const ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS = 30_000
export const LEGACY_ORDER_PAYMENT_RECOVERY_GRACE_MS = 5 * 60_000

export const ORDER_PAYMENT_INTERRUPTED_BEFORE_WALLET_ERROR =
  "Payment setup was interrupted before a wallet request was sent."
export const ORDER_PAYMENT_INTERRUPTED_AFTER_WALLET_ERROR =
  "Payment was interrupted after the invoice reached a wallet. Check that wallet before trying another payment path."

function canonicalPaymentItems(
  items: Array<{ productAddress: string; quantity: number }>
): string {
  return JSON.stringify(
    [...items].sort((left, right) =>
      left.productAddress === right.productAddress
        ? left.quantity - right.quantity
        : left.productAddress.localeCompare(right.productAddress)
    )
  )
}

function checkoutModesMatchForPayment(
  lifecycle: OrderLifecycle,
  requestedMode: OrderCheckoutMode
): boolean {
  const storedSigner =
    lifecycle.publicZapSigner ?? getOrderPublicZapSigner(lifecycle.checkoutMode)
  const requestedSigner = getOrderPublicZapSigner(requestedMode)
  if (storedSigner || requestedSigner) return storedSigner === requestedSigner
  return (
    requestedMode === "private_checkout" &&
    (lifecycle.checkoutMode === "private_checkout" ||
      lifecycle.checkoutMode === "external_wallet")
  )
}

function paymentClaimMatchesLifecycle(
  lifecycle: OrderLifecycle,
  input: OrderPaymentClaimInput
): boolean {
  return (
    paymentClaimIdentityMatchesLifecycle(lifecycle, input) &&
    checkoutModesMatchForPayment(lifecycle, input.checkoutMode) &&
    (lifecycle.zapContent ?? "") === input.zapContent
  )
}

function paymentClaimIdentityMatchesLifecycle(
  lifecycle: OrderLifecycle,
  input: OrderPaymentClaimInput
): boolean {
  return (
    lifecycle.orderId === input.orderId &&
    lifecycle.buyerPubkey === input.buyerPubkey &&
    lifecycle.merchantPubkey === input.merchantPubkey &&
    (lifecycle.merchantLightningAddress ?? null) ===
      input.merchantLightningAddress &&
    lifecycle.totalSats === input.totalSats &&
    lifecycle.totalMsats === input.totalMsats &&
    paymentTargetsEqual(lifecycle.paymentTarget, input.paymentTarget) &&
    canonicalPaymentItems(
      lifecycle.items.map((item) => ({
        productAddress: item.productId,
        quantity: item.quantity,
      }))
    ) === canonicalPaymentItems(input.items)
  )
}

function paymentTargetsEqual(
  stored: OrderPaymentTarget | undefined,
  requested: OrderPaymentTarget
): boolean {
  if (!stored || stored.type !== requested.type) return false
  if (stored.type !== "wallet" || requested.type !== "wallet") return true
  return (
    stored.walletId === requested.walletId &&
    stored.providerId === requested.providerId
  )
}

function createWalletPaymentAttemptId(): string {
  return globalThis.crypto.randomUUID()
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function getWalletPaymentAttemptId(lifecycle: OrderLifecycle): string {
  const existing = lifecycle.walletPaymentAttemptId
  return existing &&
    existing !== lifecycle.orderId &&
    UUID_V4_PATTERN.test(existing)
    ? existing
    : createWalletPaymentAttemptId()
}

type ClaimedOrderLifecycleOverrides = Partial<
  Pick<
    OrderLifecycle,
    | "merchantLightningAddress"
    | "checkoutMode"
    | "publicZapSigner"
    | "publicZapFallback"
    | "zapContent"
    | "walletPaymentAttemptId"
  >
>

function buildClaimedOrderLifecycle(
  lifecycle: OrderLifecycle,
  input: OrderPaymentClaimInput,
  now: number,
  overrides: ClaimedOrderLifecycleOverrides = {}
): OrderLifecycle {
  const walletPaymentAttemptId = Object.prototype.hasOwnProperty.call(
    overrides,
    "walletPaymentAttemptId"
  )
    ? overrides.walletPaymentAttemptId
    : input.paymentTarget.type === "wallet"
      ? getWalletPaymentAttemptId(lifecycle)
      : undefined

  return mergeOrderLifecyclePatch(
    lifecycle,
    {
      paymentClaimId: input.paymentClaimId,
      paymentClaimedAt: now,
      paymentClaimLeaseExpiresAt: now + ORDER_PAYMENT_CLAIM_LEASE_MS,
      walletPaymentAttemptId,
      invoiceStatus: "requesting",
      paymentStatus: "not_started",
      proofDeliveryStatus: "not_started",
      zapReceiptStatus: "not_applicable",
      invoice: undefined,
      paymentHash: undefined,
      preimage: undefined,
      feeMsats: undefined,
      zapRequestId: undefined,
      zapRequestCreatedAt: undefined,
      zapReceiptId: undefined,
      zapReceiptRelayUrls: undefined,
      zapLnurl: undefined,
      zapReceiptPubkey: undefined,
      invoiceExpiresAt: undefined,
      zapReceiptObservationDeadline: undefined,
      lastError: undefined,
      ...overrides,
    },
    now
  )
}

function canStartOrReplaceOrderPayment(lifecycle: OrderLifecycle): boolean {
  if (
    lifecycle.orderDeliveryStatus !== "sent" ||
    lifecycle.phase === "completed" ||
    lifecycle.phase === "cancelled"
  ) {
    return false
  }
  return (
    (lifecycle.paymentStatus === "not_started" &&
      lifecycle.invoiceStatus === "not_requested") ||
    lifecycle.paymentStatus === "failed"
  )
}

export function getOrderLifecyclePaymentAdmission(
  lifecycle: OrderLifecycle | undefined,
  input: OrderPaymentClaimInput
): "admissible" | "missing" | "snapshot_mismatch" | "unsafe_state" {
  if (!lifecycle) return "missing"
  if (lifecycle.paymentClaimId) return "unsafe_state"
  if (!paymentClaimMatchesLifecycle(lifecycle, input)) {
    return "snapshot_mismatch"
  }
  return canStartOrReplaceOrderPayment(lifecycle)
    ? "admissible"
    : "unsafe_state"
}

/**
 * Atomically admits one payment attempt for a delivered order.
 *
 * The durable lifecycle is the payment authority. Snapshot disagreement and
 * states where an invoice may already be payable or paid are rejected before
 * signer, LNURL, or wallet work begins. The transaction serializes competing
 * tabs against the same IndexedDB record.
 */
export async function claimOrderLifecyclePayment(
  input: OrderPaymentClaimInput
): Promise<OrderPaymentClaimResult> {
  if (!input.paymentClaimId.trim()) {
    throw new Error("Payment claim ID is required.")
  }

  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(input.orderId)
    const admission = getOrderLifecyclePaymentAdmission(lifecycle, input)
    if (!lifecycle || admission === "missing") {
      return { status: "missing", lifecycle: null }
    }
    if (admission !== "admissible") {
      return { status: admission, lifecycle }
    }

    const now = Date.now()
    const claimed = buildClaimedOrderLifecycle(lifecycle, input, now)
    await db.orderLifecycles.put(claimed)
    return { status: "claimed", lifecycle: claimed }
  })
}

export type OrderPaymentTargetReplacementAdmission =
  "replaceable" | "missing" | "unsafe_state"

export function getOrderPaymentTargetReplacementAdmission(
  lifecycle: OrderLifecycle | undefined
): OrderPaymentTargetReplacementAdmission {
  if (!lifecycle) return "missing"
  return canStartOrReplaceOrderPayment(lifecycle)
    ? "replaceable"
    : "unsafe_state"
}

export type ReplaceOrderPaymentTargetResult =
  | { status: "updated"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }
  | { status: "unsafe_state"; lifecycle: OrderLifecycle }

/**
 * Atomically replaces a definite pre-payment target.
 *
 * This is intentionally unavailable once an invoice may be in-flight, payable,
 * paid, or ambiguous. The transaction serializes an explicit target change
 * against a competing payment claim in another tab.
 */
export async function replaceOrderPaymentTarget(
  orderId: string,
  paymentTarget: OrderPaymentTarget
): Promise<ReplaceOrderPaymentTargetResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(orderId)
    const admission = getOrderPaymentTargetReplacementAdmission(lifecycle)
    if (!lifecycle || admission === "missing") {
      return { status: "missing", lifecycle: null }
    }
    if (admission !== "replaceable") {
      return { status: "unsafe_state", lifecycle }
    }
    const updated: OrderLifecycle = {
      ...lifecycle,
      paymentTarget,
      walletPaymentAttemptId:
        paymentTargetsEqual(lifecycle.paymentTarget, paymentTarget) &&
        paymentTarget.type === "wallet"
          ? lifecycle.walletPaymentAttemptId
          : undefined,
      updatedAt: Date.now(),
    }
    await db.orderLifecycles.put(updated)
    return { status: "updated", lifecycle: updated }
  })
}

/**
 * Atomically move a legacy failed anonymous zap into a private payment claim.
 * No intermediate retryable state is exposed for another tab to overwrite.
 */
export async function claimOrderLifecyclePrivateFallbackPayment(
  input: OrderPaymentClaimInput
): Promise<OrderPaymentClaimResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(input.orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }
    if (
      input.checkoutMode !== "private_checkout" ||
      !paymentClaimIdentityMatchesLifecycle(lifecycle, input)
    ) {
      return { status: "snapshot_mismatch", lifecycle }
    }
    const publicZapSigner =
      lifecycle.publicZapSigner ??
      getOrderPublicZapSigner(lifecycle.checkoutMode)
    if (
      lifecycle.paymentClaimId ||
      publicZapSigner !== "anon" ||
      lifecycle.orderDeliveryStatus !== "sent" ||
      lifecycle.phase === "completed" ||
      lifecycle.phase === "cancelled" ||
      lifecycle.invoiceStatus !== "failed" ||
      lifecycle.paymentStatus !== "failed"
    ) {
      return { status: "unsafe_state", lifecycle }
    }

    const now = Date.now()
    const claimed = buildClaimedOrderLifecycle(lifecycle, input, now, {
      merchantLightningAddress: input.merchantLightningAddress ?? undefined,
      checkoutMode: "private_checkout",
      publicZapSigner: undefined,
      publicZapFallback: true,
      zapContent: "",
      walletPaymentAttemptId:
        input.paymentTarget.type === "wallet"
          ? createWalletPaymentAttemptId()
          : undefined,
    })
    await db.orderLifecycles.put(claimed)
    return { status: "claimed", lifecycle: claimed }
  })
}

/**
 * Persist a retryable preparation failure without ever owning a payment claim.
 * This is used when the browser cannot retain the content-free recovery token;
 * the same admission transaction prevents overwriting another tab's attempt.
 */
export async function recordOrderPaymentPreparationFailure(
  input: OrderPaymentClaimInput,
  lastError: string
): Promise<OrderPaymentPreparationFailureResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(input.orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }
    const admission = getOrderLifecyclePaymentAdmission(lifecycle, input)
    if (admission === "snapshot_mismatch" || admission === "unsafe_state") {
      return { status: admission, lifecycle }
    }

    const recorded = mergeOrderLifecyclePatch(lifecycle, {
      paymentClaimId: undefined,
      invoiceStatus: "failed",
      paymentStatus: "failed",
      proofDeliveryStatus: "not_started",
      zapReceiptStatus: "not_applicable",
      lastError,
    })
    await db.orderLifecycles.put(recorded)
    return { status: "recorded", lifecycle: recorded }
  })
}

type FencedOrderLifecyclePatch = Partial<
  Omit<
    OrderLifecycle,
    | "orderId"
    | "createdAt"
    | "paymentClaimId"
    | "paymentClaimedAt"
    | "paymentClaimLeaseExpiresAt"
  >
> & { paymentClaimId?: undefined }

function mergeOrderLifecyclePatch(
  existing: OrderLifecycle,
  patch: Partial<Omit<OrderLifecycle, "orderId" | "createdAt">>,
  now = Date.now()
): OrderLifecycle {
  const merged: OrderLifecycle = {
    ...existing,
    ...patch,
    orderId: existing.orderId,
    createdAt: existing.createdAt,
    updatedAt: now,
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, "paymentClaimId") &&
    patch.paymentClaimId === undefined
  ) {
    merged.paymentClaimedAt = undefined
    merged.paymentClaimLeaseExpiresAt = undefined
  }
  if (
    (Object.prototype.hasOwnProperty.call(patch, "proofDeliveryClaimId") &&
      patch.proofDeliveryClaimId === undefined) ||
    (Object.prototype.hasOwnProperty.call(patch, "proofDeliveryStatus") &&
      patch.proofDeliveryStatus !== "pending")
  ) {
    merged.proofDeliveryClaimId = undefined
    merged.proofDeliveryClaimedAt = undefined
    merged.proofDeliveryClaimLeaseExpiresAt = undefined
  }
  merged.phase = patch.phase ?? deriveOrderLifecyclePhase(merged)
  if (merged.phase === "completed" && !merged.completedAt) {
    merged.completedAt = merged.updatedAt
  }
  return merged
}

/**
 * Patch a claimed payment flow only while its durable owner token still
 * matches. Payment-service callers use this fence for every pre-wallet write,
 * especially the invoice-received/payment-paying handoff. A stale document
 * therefore cannot resume across that boundary after recovery supersedes it.
 */
export async function patchClaimedOrderLifecyclePayment(
  orderId: string,
  paymentClaimId: string,
  patch: FencedOrderLifecyclePatch
): Promise<ClaimedOrderLifecyclePatchResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }
    if (
      !paymentClaimId ||
      !lifecycle.paymentClaimId ||
      lifecycle.paymentClaimId !== paymentClaimId
    ) {
      return { status: "claim_mismatch", lifecycle }
    }

    const now = Date.now()
    const releasesClaim =
      Object.prototype.hasOwnProperty.call(patch, "paymentClaimId") &&
      patch.paymentClaimId === undefined
    const updated = mergeOrderLifecyclePatch(
      lifecycle,
      {
        ...patch,
        ...(releasesClaim
          ? {}
          : {
              paymentClaimLeaseExpiresAt: now + ORDER_PAYMENT_CLAIM_LEASE_MS,
            }),
      },
      now
    )
    await db.orderLifecycles.put(updated)
    return { status: "patched", lifecycle: updated }
  })
}

export async function renewOrderLifecyclePaymentClaim(
  orderId: string,
  paymentClaimId: string
): Promise<ClaimedOrderLifecyclePatchResult> {
  return patchClaimedOrderLifecyclePayment(orderId, paymentClaimId, {})
}

/** Exact NIP-57 evidence is authoritative and supersedes any in-flight owner. */
export async function recordObservedOrderPaymentReceipt(
  orderId: string,
  input: {
    zapRequestId: string
    zapReceiptId: string
    proofDeliveryStatus: "pending" | "sent"
    proofDeliveryClaimId?: string
  }
): Promise<ObservedOrderPaymentReceiptResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }
    if (!input.zapRequestId || lifecycle.zapRequestId !== input.zapRequestId) {
      return { status: "request_mismatch", lifecycle }
    }

    const now = Date.now()
    const proofDeliveryClaimId = input.proofDeliveryClaimId?.trim()
    const proofLeaseIsAvailable =
      lifecycle.proofDeliveryStatus !== "pending" ||
      !lifecycle.proofDeliveryClaimId ||
      (lifecycle.proofDeliveryClaimLeaseExpiresAt ?? 0) <= now

    // Exact receipt evidence fences the payment owner below, so atomically
    // transfer its proof work without stealing another live proof lease.
    const proofDeliveryClaimed =
      lifecycle.proofDeliveryStatus !== "sent" &&
      input.proofDeliveryStatus === "pending" &&
      !!proofDeliveryClaimId &&
      proofLeaseIsAvailable

    const recorded = mergeOrderLifecyclePatch(
      lifecycle,
      {
        paymentClaimId: undefined,
        invoiceStatus: "received",
        paymentStatus: "paid",
        proofDeliveryStatus:
          lifecycle.proofDeliveryStatus === "sent"
            ? "sent"
            : input.proofDeliveryStatus,
        ...(proofDeliveryClaimed
          ? {
              proofDeliveryClaimId,
              proofDeliveryClaimedAt: now,
              proofDeliveryClaimLeaseExpiresAt:
                now + ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS,
            }
          : {}),
        zapReceiptStatus: "observed",
        zapReceiptId: input.zapReceiptId,
        lastError: undefined,
      },
      now
    )
    await db.orderLifecycles.put(recorded)
    return { status: "recorded", lifecycle: recorded, proofDeliveryClaimed }
  })
}

/**
 * Record the end of an exact-receipt observation window without allowing a
 * stale observer to overwrite payment or receipt evidence recorded elsewhere.
 */
export async function recordOrderPaymentReceiptTimeout(
  orderId: string,
  zapRequestId: string
): Promise<OrderPaymentReceiptTimeoutResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }
    if (!zapRequestId || lifecycle.zapRequestId !== zapRequestId) {
      return { status: "request_mismatch", lifecycle }
    }
    if (lifecycle.zapReceiptStatus === "observed" || !!lifecycle.zapReceiptId) {
      return { status: "preserved", lifecycle }
    }

    if (lifecycle.paymentStatus === "paid") {
      const recorded = mergeOrderLifecyclePatch(lifecycle, {
        zapReceiptStatus: "receipt_not_observed",
      })
      await db.orderLifecycles.put(recorded)
      return { status: "recorded", lifecycle: recorded }
    }

    const recorded = mergeOrderLifecyclePatch(lifecycle, {
      paymentStatus: "ambiguous",
      zapReceiptStatus: "receipt_not_observed",
      lastError:
        "A matching public receipt was not observed. Do not pay again if your wallet shows payment.",
    })
    await db.orderLifecycles.put(recorded)
    return { status: "recorded", lifecycle: recorded }
  })
}

/** Proof delivery is monotonic: once sent, a stale retry cannot downgrade it. */
export async function recordOrderPaymentProofDelivery(
  orderId: string,
  proofDeliveryStatus: "pending" | "retry_needed" | "sent",
  patch: Pick<OrderLifecycle, "deliveryNotice" | "lastError"> = {},
  proofDeliveryClaimId?: string
): Promise<OrderPaymentProofDeliveryResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }
    if (
      lifecycle.proofDeliveryStatus === "sent" &&
      proofDeliveryStatus !== "sent"
    ) {
      return { status: "preserved", lifecycle }
    }
    if (
      proofDeliveryStatus !== "sent" &&
      lifecycle.proofDeliveryClaimId &&
      lifecycle.proofDeliveryClaimId !== proofDeliveryClaimId
    ) {
      return { status: "claim_mismatch", lifecycle }
    }

    const recorded = mergeOrderLifecyclePatch(lifecycle, {
      ...patch,
      proofDeliveryStatus,
    })
    await db.orderLifecycles.put(recorded)
    return { status: "recorded", lifecycle: recorded }
  })
}

/** Atomically acquire proof publication work across browser documents. */
export async function claimOrderPaymentProofDelivery(
  orderId: string,
  proofDeliveryClaimId: string,
  now = Date.now()
): Promise<OrderPaymentProofDeliveryClaimResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }
    const normalizedClaimId = proofDeliveryClaimId.trim()
    if (
      !normalizedClaimId ||
      lifecycle.proofDeliveryStatus === "sent" ||
      (lifecycle.proofDeliveryStatus === "pending" &&
        lifecycle.proofDeliveryClaimId !== normalizedClaimId &&
        (lifecycle.proofDeliveryClaimLeaseExpiresAt ?? 0) > now)
    ) {
      return { status: "preserved", lifecycle }
    }
    const claimed = mergeOrderLifecyclePatch(
      lifecycle,
      {
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: normalizedClaimId,
        proofDeliveryClaimedAt:
          lifecycle.proofDeliveryClaimId === normalizedClaimId
            ? (lifecycle.proofDeliveryClaimedAt ?? now)
            : now,
        proofDeliveryClaimLeaseExpiresAt:
          now + ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS,
      },
      now
    )
    await db.orderLifecycles.put(claimed)
    return { status: "claimed", lifecycle: claimed }
  })
}

export async function renewOrderPaymentProofDeliveryClaim(
  orderId: string,
  proofDeliveryClaimId: string
): Promise<OrderPaymentProofDeliveryClaimResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }
    const normalizedClaimId = proofDeliveryClaimId.trim()
    if (
      !normalizedClaimId ||
      lifecycle.proofDeliveryStatus !== "pending" ||
      lifecycle.proofDeliveryClaimId !== normalizedClaimId
    ) {
      return { status: "preserved", lifecycle }
    }

    const now = Date.now()
    const renewed = mergeOrderLifecyclePatch(
      lifecycle,
      {
        proofDeliveryClaimLeaseExpiresAt:
          now + ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS,
      },
      now
    )
    await db.orderLifecycles.put(renewed)
    return { status: "claimed", lifecycle: renewed }
  })
}

/** Atomically bind one projected merchant invoice before wallet handoff. */
export async function bindMerchantInvoiceForPayment(
  orderId: string,
  merchantInvoice: ProjectedMerchantInvoiceClaim,
  nowMs = Date.now()
): Promise<MerchantInvoicePaymentBindingResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }

    const admitted = admitProjectedMerchantInvoice(
      lifecycle,
      merchantInvoice,
      nowMs,
      false
    )
    if (!admitted) return { status: "preserved", lifecycle }
    if (admitted.alreadyBound) return { status: "bound", lifecycle }

    const bound = mergeOrderLifecyclePatch(
      lifecycle,
      {
        invoiceStatus: "manual_required",
        paymentStatus: "manual_required",
        invoice: admitted.invoice,
        paymentHash: admitted.paymentHash,
        invoiceExpiresAt: admitted.expiresAt,
        lastError: undefined,
      },
      nowMs
    )
    await db.orderLifecycles.put(bound)
    return { status: "bound", lifecycle: bound }
  })
}

/** Atomically turn one manual external-payment attestation into proof work. */
export async function claimExternalOrderPaymentProof(
  orderId: string,
  proofDeliveryClaimId: string,
  options: ExternalOrderPaymentProofClaimOptions = {}
): Promise<ExternalOrderPaymentProofClaimResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }
    const now = options.nowMs ?? Date.now()
    const publicZapSigner =
      lifecycle.publicZapSigner ??
      getOrderPublicZapSigner(lifecycle.checkoutMode)
    const normalizedClaimId = proofDeliveryClaimId.trim()
    const merchantInvoice = options.merchantInvoice
    const admittedMerchantInvoice = merchantInvoice
      ? admitProjectedMerchantInvoice(lifecycle, merchantInvoice, now, true)
      : null
    const existingManualInvoiceIsAdmissible =
      !merchantInvoice &&
      !!lifecycle.invoice &&
      lifecycle.paymentStatus === "manual_required"

    if (
      !normalizedClaimId ||
      publicZapSigner ||
      lifecycle.proofDeliveryStatus !== "not_started" ||
      (!admittedMerchantInvoice && !existingManualInvoiceIsAdmissible)
    ) {
      return { status: "preserved", lifecycle }
    }
    const claimed = mergeOrderLifecyclePatch(
      lifecycle,
      {
        ...(admittedMerchantInvoice
          ? {
              invoiceStatus: "manual_required" as const,
              invoice: admittedMerchantInvoice.invoice,
              paymentHash: admittedMerchantInvoice.paymentHash,
              invoiceExpiresAt: admittedMerchantInvoice.expiresAt,
            }
          : {}),
        paymentStatus: "paid",
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: normalizedClaimId,
        proofDeliveryClaimedAt: now,
        proofDeliveryClaimLeaseExpiresAt:
          now + ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS,
        lastError: undefined,
      },
      now
    )
    await db.orderLifecycles.put(claimed)
    return { status: "claimed", lifecycle: claimed }
  })
}

/**
 * Recover after a wallet has returned success but a later local write failed.
 * The payment remains paid, its claim is released, and sent proof evidence is
 * never downgraded by the recovery path.
 */
export async function recordOrderPaymentWalletSuccessRecovery(
  orderId: string,
  input: OrderPaymentWalletSuccessRecoveryInput
): Promise<OrderPaymentProofDeliveryResult> {
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(orderId)
    if (!lifecycle) return { status: "missing", lifecycle: null }
    const now = Date.now()
    const hasLiveProofDeliveryClaim =
      !!lifecycle.proofDeliveryClaimId &&
      (lifecycle.proofDeliveryClaimLeaseExpiresAt ?? 0) > now
    const proofDeliveryClaimMatches =
      !lifecycle.proofDeliveryClaimId ||
      lifecycle.proofDeliveryClaimId === input.proofDeliveryClaimId
    const recorded = mergeOrderLifecyclePatch(
      lifecycle,
      {
        paymentClaimId: undefined,
        invoiceStatus: "received",
        paymentStatus: "paid",
        proofDeliveryStatus:
          lifecycle.proofDeliveryStatus === "sent" ||
          input.proofDeliveryStatus === "sent"
            ? "sent"
            : !proofDeliveryClaimMatches
              ? lifecycle.proofDeliveryStatus
              : input.proofDeliveryStatus === "pending" &&
                  lifecycle.proofDeliveryStatus === "pending" &&
                  lifecycle.zapReceiptStatus === "observed" &&
                  hasLiveProofDeliveryClaim
                ? "pending"
                : "retry_needed",
        invoice: input.invoice,
        paymentHash: input.paymentHash,
        preimage: input.preimage,
        feeMsats: input.feeMsats,
        zapRequestId: input.zapRequestId,
        lastError: undefined,
      },
      now
    )
    await db.orderLifecycles.put(recorded)
    return { status: "recorded", lifecycle: recorded }
  })
}

function isMatchingPaymentAttemptForLifecycle(
  attempt: StoredPaymentAttempt | undefined,
  lifecycle: OrderLifecycle
): attempt is StoredPaymentAttempt & { invoice: string } {
  if (
    !attempt ||
    !lifecycle.invoice ||
    attempt.orderId !== lifecycle.orderId ||
    attempt.buyerPubkey !== lifecycle.buyerPubkey ||
    attempt.merchantPubkey !== lifecycle.merchantPubkey ||
    attempt.amountMsats !== lifecycle.totalMsats ||
    attempt.currency !== "SATS" ||
    attempt.invoice !== lifecycle.invoice
  ) {
    return false
  }

  return true
}

function isConclusivePaymentAttemptForLifecycle(
  attempt: StoredPaymentAttempt | undefined,
  lifecycle: OrderLifecycle
): attempt is StoredPaymentAttempt & { invoice: string } {
  if (!isMatchingPaymentAttemptForLifecycle(attempt, lifecycle)) return false

  const hasPreimage =
    typeof attempt.preimage === "string" && attempt.preimage.length > 0
  const hasExactZapReceipt =
    typeof attempt.zapReceiptId === "string" &&
    attempt.zapReceiptId.length > 0 &&
    typeof attempt.zapRequestId === "string" &&
    attempt.zapRequestId.length > 0 &&
    attempt.zapRequestId === lifecycle.zapRequestId
  return hasPreimage || hasExactZapReceipt
}

function hasConclusiveLifecyclePaymentProof(
  lifecycle: OrderLifecycle
): lifecycle is OrderLifecycle & { invoice: string } {
  if (!lifecycle.invoice) return false
  const hasPreimage =
    typeof lifecycle.preimage === "string" && lifecycle.preimage.length > 0
  const hasExactZapReceipt =
    typeof lifecycle.zapReceiptId === "string" &&
    lifecycle.zapReceiptId.length > 0 &&
    typeof lifecycle.zapRequestId === "string" &&
    lifecycle.zapRequestId.length > 0
  return hasPreimage || hasExactZapReceipt
}

/**
 * Reconcile a payment claim left behind when its owning browser document was
 * destroyed. Any local observer may supply the durable claim ID; the
 * transaction refuses recovery while its renewable lease remains active.
 * Callers should also avoid reconciling an attempt running in their own realm.
 *
 * The transaction distinguishes three safety boundaries:
 * - no invoice/proof: the wallet was not called, so the same order may retry;
 * - durable payment proof: restore paid and expose proof delivery retry;
 * - invoice without proof: funds may have moved, so preserve it as ambiguous.
 */
export async function reconcileInterruptedOrderPayment(
  orderId: string,
  paymentClaimId: string
): Promise<InterruptedOrderPaymentReconciliation> {
  return db.transaction(
    "rw",
    [db.orderLifecycles, db.paymentAttempts],
    async () => {
      const lifecycle = await db.orderLifecycles.get(orderId)
      if (!lifecycle) return { status: "missing", lifecycle: null }
      if (
        !paymentClaimId ||
        !lifecycle.paymentClaimId ||
        lifecycle.paymentClaimId !== paymentClaimId
      ) {
        return { status: "claim_mismatch", lifecycle }
      }

      const now = Date.now()
      if (
        typeof lifecycle.paymentClaimLeaseExpiresAt === "number" &&
        lifecycle.paymentClaimLeaseExpiresAt > now
      ) {
        return { status: "claim_active", lifecycle }
      }

      const attempt = await db.paymentAttempts.get(orderId)

      if (isConclusivePaymentAttemptForLifecycle(attempt, lifecycle)) {
        const proofDeliveryStatus =
          attempt.proofDeliveryStatus === "sent" ? "sent" : "retry_needed"
        const restored = mergeOrderLifecyclePatch(
          lifecycle,
          {
            paymentClaimId: undefined,
            invoiceStatus: "received",
            paymentStatus: "paid",
            proofDeliveryStatus,
            invoice: attempt.invoice,
            paymentHash: attempt.paymentHash,
            preimage: attempt.preimage,
            feeMsats: attempt.feeMsats,
            zapRequestId: attempt.zapRequestId,
            ...(attempt.zapReceiptId
              ? {
                  zapReceiptId: attempt.zapReceiptId,
                  zapReceiptStatus: "observed" as const,
                }
              : {}),
            lastError: undefined,
          },
          now
        )
        await Promise.all([
          db.orderLifecycles.put(restored),
          db.paymentAttempts.put({
            ...attempt,
            proofDeliveryStatus,
            updatedAt: now,
          }),
        ])
        return { status: "restored_paid", lifecycle: restored }
      }

      if (hasConclusiveLifecyclePaymentProof(lifecycle)) {
        const restored = mergeOrderLifecyclePatch(
          lifecycle,
          {
            paymentClaimId: undefined,
            invoiceStatus: "received",
            paymentStatus: "paid",
            proofDeliveryStatus:
              lifecycle.proofDeliveryStatus === "sent"
                ? "sent"
                : "retry_needed",
            lastError: undefined,
          },
          now
        )
        await db.orderLifecycles.put(restored)
        return { status: "restored_paid", lifecycle: restored }
      }

      const invoiceRequestWasInterrupted =
        lifecycle.invoiceStatus === "requesting" &&
        (lifecycle.paymentStatus === "not_started" ||
          lifecycle.paymentStatus === "paying") &&
        !lifecycle.invoice &&
        !lifecycle.preimage &&
        !lifecycle.paymentHash &&
        !lifecycle.zapReceiptId &&
        !attempt

      if (invoiceRequestWasInterrupted) {
        const recovered = mergeOrderLifecyclePatch(
          lifecycle,
          {
            paymentClaimId: undefined,
            invoiceStatus: "failed",
            paymentStatus: "failed",
            proofDeliveryStatus: "not_started",
            zapReceiptStatus: "not_applicable",
            invoice: undefined,
            paymentHash: undefined,
            preimage: undefined,
            feeMsats: undefined,
            zapRequestId: undefined,
            zapRequestCreatedAt: undefined,
            zapReceiptId: undefined,
            zapReceiptRelayUrls: undefined,
            zapLnurl: undefined,
            zapReceiptPubkey: undefined,
            invoiceExpiresAt: undefined,
            zapReceiptObservationDeadline: undefined,
            lastError: ORDER_PAYMENT_INTERRUPTED_BEFORE_WALLET_ERROR,
          },
          now
        )
        await db.orderLifecycles.put(recovered)
        return { status: "recovered_before_payment", lifecycle: recovered }
      }

      const invoiceMayHaveReachedWallet =
        typeof lifecycle.invoice === "string" &&
        lifecycle.invoice.length > 0 &&
        (lifecycle.invoiceStatus === "requesting" ||
          lifecycle.invoiceStatus === "received") &&
        (lifecycle.paymentStatus === "not_started" ||
          lifecycle.paymentStatus === "paying")

      if (invoiceMayHaveReachedWallet) {
        const ambiguous = mergeOrderLifecyclePatch(
          lifecycle,
          {
            paymentClaimId: undefined,
            invoiceStatus: "received",
            paymentStatus: "ambiguous",
            lastError: ORDER_PAYMENT_INTERRUPTED_AFTER_WALLET_ERROR,
          },
          now
        )
        await db.orderLifecycles.put(ambiguous)
        return { status: "marked_ambiguous", lifecycle: ambiguous }
      }

      return { status: "not_interrupted", lifecycle }
    }
  )
}

/** Recover proof publication abandoned after its renewable lease expires. */
export async function reconcileInterruptedOrderProofDelivery(
  orderId: string,
  proofDeliveryClaimId: string,
  now = Date.now()
): Promise<InterruptedOrderProofDeliveryReconciliation> {
  return db.transaction(
    "rw",
    [db.orderLifecycles, db.paymentAttempts],
    async () => {
      const lifecycle = await db.orderLifecycles.get(orderId)
      if (!lifecycle) return { status: "missing", lifecycle: null }
      if (
        lifecycle.paymentStatus !== "paid" ||
        lifecycle.proofDeliveryStatus !== "pending" ||
        !lifecycle.proofDeliveryClaimId
      ) {
        return { status: "not_interrupted", lifecycle }
      }
      if (
        !proofDeliveryClaimId ||
        lifecycle.proofDeliveryClaimId !== proofDeliveryClaimId
      ) {
        return { status: "claim_mismatch", lifecycle }
      }
      if ((lifecycle.proofDeliveryClaimLeaseExpiresAt ?? 0) > now) {
        return { status: "claim_active", lifecycle }
      }
      if (
        lifecycle.paymentClaimId === lifecycle.proofDeliveryClaimId &&
        (lifecycle.paymentClaimLeaseExpiresAt ?? 0) > now
      ) {
        return { status: "claim_active", lifecycle }
      }

      const attempt = await db.paymentAttempts.get(orderId)
      const proofWasSent =
        isMatchingPaymentAttemptForLifecycle(attempt, lifecycle) &&
        attempt.proofDeliveryStatus === "sent"
      const recovered = mergeOrderLifecyclePatch(
        lifecycle,
        {
          paymentClaimId: undefined,
          proofDeliveryClaimId: undefined,
          proofDeliveryStatus: proofWasSent ? "sent" : "retry_needed",
        },
        now
      )
      await db.orderLifecycles.put(recovered)
      return { status: "recovered", lifecycle: recovered }
    }
  )
}

/**
 * Bounded migration for payment rows created before durable claim tokens were
 * introduced. Only stale states that the previous payment service could leave
 * mid-flight are eligible; current claimed rows use renewable leases above.
 */
export function isLegacyInterruptedOrderPayment(
  lifecycle: Pick<
    OrderLifecycle,
    | "paymentStatus"
    | "invoiceStatus"
    | "proofDeliveryStatus"
    | "proofDeliveryClaimId"
  >
): boolean {
  return (
    (lifecycle.paymentStatus === "paying" &&
      (lifecycle.invoiceStatus === "requesting" ||
        lifecycle.invoiceStatus === "received")) ||
    (lifecycle.paymentStatus === "paid" &&
      lifecycle.proofDeliveryStatus === "pending" &&
      !lifecycle.proofDeliveryClaimId)
  )
}

export async function reconcileLegacyInterruptedOrderPayment(
  orderId: string,
  now = Date.now()
): Promise<LegacyInterruptedOrderPaymentReconciliation> {
  return db.transaction(
    "rw",
    [db.orderLifecycles, db.paymentAttempts],
    async () => {
      const lifecycle = await db.orderLifecycles.get(orderId)
      if (!lifecycle) return { status: "missing", lifecycle: null }
      if (lifecycle.paymentClaimId) {
        return { status: "not_legacy_interrupted", lifecycle }
      }
      if (lifecycle.proofDeliveryClaimId) {
        return { status: "not_legacy_interrupted", lifecycle }
      }

      if (!isLegacyInterruptedOrderPayment(lifecycle)) {
        return { status: "not_legacy_interrupted", lifecycle }
      }
      if (now - lifecycle.updatedAt < LEGACY_ORDER_PAYMENT_RECOVERY_GRACE_MS) {
        return { status: "not_stale", lifecycle }
      }

      const attempt = await db.paymentAttempts.get(orderId)
      if (isConclusivePaymentAttemptForLifecycle(attempt, lifecycle)) {
        const proofDeliveryStatus =
          attempt.proofDeliveryStatus === "sent" ? "sent" : "retry_needed"
        const restored = mergeOrderLifecyclePatch(
          lifecycle,
          {
            invoiceStatus: "received",
            paymentStatus: "paid",
            proofDeliveryStatus,
            invoice: attempt.invoice,
            paymentHash: attempt.paymentHash,
            preimage: attempt.preimage,
            feeMsats: attempt.feeMsats,
            zapRequestId: attempt.zapRequestId,
            lastError: undefined,
          },
          now
        )
        await Promise.all([
          db.orderLifecycles.put(restored),
          db.paymentAttempts.put({
            ...attempt,
            proofDeliveryStatus,
            updatedAt: now,
          }),
        ])
        return { status: "restored_paid", lifecycle: restored }
      }

      if (hasConclusiveLifecyclePaymentProof(lifecycle)) {
        const restored = mergeOrderLifecyclePatch(
          lifecycle,
          {
            invoiceStatus: "received",
            paymentStatus: "paid",
            proofDeliveryStatus: "retry_needed",
            lastError: undefined,
          },
          now
        )
        await db.orderLifecycles.put(restored)
        return { status: "restored_paid", lifecycle: restored }
      }

      const publicZapSigner =
        lifecycle.publicZapSigner ??
        getOrderPublicZapSigner(lifecycle.checkoutMode)
      if (
        lifecycle.paymentStatus === "paid" &&
        lifecycle.proofDeliveryStatus === "pending" &&
        !!lifecycle.invoice &&
        !publicZapSigner
      ) {
        const restored = mergeOrderLifecyclePatch(
          lifecycle,
          {
            invoiceStatus: "received",
            paymentStatus: "paid",
            proofDeliveryStatus: "retry_needed",
            lastError: undefined,
          },
          now
        )
        await db.orderLifecycles.put(restored)
        return { status: "restored_paid", lifecycle: restored }
      }

      if (!lifecycle.invoice) {
        const recovered = mergeOrderLifecyclePatch(
          lifecycle,
          {
            invoiceStatus: "failed",
            paymentStatus: "failed",
            proofDeliveryStatus: "not_started",
            lastError: ORDER_PAYMENT_INTERRUPTED_BEFORE_WALLET_ERROR,
          },
          now
        )
        await db.orderLifecycles.put(recovered)
        return { status: "recovered_before_payment", lifecycle: recovered }
      }

      const ambiguous = mergeOrderLifecyclePatch(
        lifecycle,
        {
          invoiceStatus: "received",
          paymentStatus: "ambiguous",
          lastError: ORDER_PAYMENT_INTERRUPTED_AFTER_WALLET_ERROR,
        },
        now
      )
      await db.orderLifecycles.put(ambiguous)
      return { status: "marked_ambiguous", lifecycle: ambiguous }
    }
  )
}

/**
 * Patch an existing lifecycle record. Recomputes `phase` from the merged status
 * fields unless the caller pins it explicitly (e.g. a `cancelled` transition).
 * No-op when the order is unknown locally.
 */
export async function patchOrderLifecycle(
  orderId: string,
  patch: Partial<Omit<OrderLifecycle, "orderId" | "createdAt">>
): Promise<OrderLifecycle | undefined> {
  const existing = await db.orderLifecycles.get(orderId)
  if (!existing) return undefined

  const merged = mergeOrderLifecyclePatch(existing, patch)

  await db.orderLifecycles.put(merged)
  return merged
}

/**
 * All lifecycle records for a buyer, newest activity first. Drives the Orders
 * list before (and alongside) relay readback.
 */
export async function listOrderLifecycles(
  buyerPubkey: string
): Promise<OrderLifecycle[]> {
  const rows = await db.orderLifecycles
    .where("buyerPubkey")
    .equals(buyerPubkey)
    .toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Guest checkout is intentionally recoverable only for a short browser session.
 * Remove the matching local lifecycle, payment attempt, and decrypted message
 * cache once that window has elapsed so checkout secrets do not become an
 * indefinite browser-profile record.
 */
export async function pruneExpiredGuestOrderData(
  nowMs = Date.now(),
  retentionMs = GUEST_ORDER_LOCAL_RETENTION_MS
): Promise<number> {
  const expired = await db.orderLifecycles
    .filter((lifecycle) =>
      isGuestOrderDataExpired(lifecycle, nowMs, retentionMs)
    )
    .toArray()
  if (expired.length === 0) return 0

  const orderIds = expired.map((lifecycle) => lifecycle.orderId)
  await db.transaction(
    "rw",
    [db.orderLifecycles, db.paymentAttempts, db.orderMessages],
    async () => {
      await Promise.all([
        db.orderLifecycles.bulkDelete(orderIds),
        db.paymentAttempts.where("orderId").anyOf(orderIds).delete(),
        db.orderMessages.where("orderId").anyOf(orderIds).delete(),
      ])
    }
  )
  return orderIds.length
}
