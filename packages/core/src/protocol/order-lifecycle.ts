import {
  db,
  type OrderCheckoutMode,
  type OrderLifecycle,
  type OrderLifecyclePhase,
  type OrderPublicZapSigner,
} from "../db"

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
  buyerPubkey: string
  merchantPubkey: string
  merchantLightningAddress: string | null
  checkoutMode: OrderCheckoutMode
  zapContent: string
  totalSats: number
  totalMsats: number
  items: Array<{ productAddress: string; quantity: number }>
}

export type OrderPaymentClaimResult =
  | { status: "claimed"; lifecycle: OrderLifecycle }
  | { status: "missing"; lifecycle: null }
  | {
      status: "snapshot_mismatch" | "unsafe_state"
      lifecycle: OrderLifecycle
    }

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
    lifecycle.orderId === input.orderId &&
    lifecycle.buyerPubkey === input.buyerPubkey &&
    lifecycle.merchantPubkey === input.merchantPubkey &&
    (lifecycle.merchantLightningAddress ?? null) ===
      input.merchantLightningAddress &&
    checkoutModesMatchForPayment(lifecycle, input.checkoutMode) &&
    (lifecycle.zapContent ?? "") === input.zapContent &&
    lifecycle.totalSats === input.totalSats &&
    lifecycle.totalMsats === input.totalMsats &&
    canonicalPaymentItems(
      lifecycle.items.map((item) => ({
        productAddress: item.productId,
        quantity: item.quantity,
      }))
    ) === canonicalPaymentItems(input.items)
  )
}

export function getOrderLifecyclePaymentAdmission(
  lifecycle: OrderLifecycle | undefined,
  input: OrderPaymentClaimInput
): "admissible" | "missing" | "snapshot_mismatch" | "unsafe_state" {
  if (!lifecycle) return "missing"
  if (!paymentClaimMatchesLifecycle(lifecycle, input)) {
    return "snapshot_mismatch"
  }
  if (
    lifecycle.orderDeliveryStatus !== "sent" ||
    lifecycle.phase === "completed" ||
    lifecycle.phase === "cancelled"
  ) {
    return "unsafe_state"
  }
  return (lifecycle.paymentStatus === "not_started" &&
    lifecycle.invoiceStatus === "not_requested") ||
    lifecycle.paymentStatus === "failed"
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
  return db.transaction("rw", db.orderLifecycles, async () => {
    const lifecycle = await db.orderLifecycles.get(input.orderId)
    const admission = getOrderLifecyclePaymentAdmission(lifecycle, input)
    if (!lifecycle || admission === "missing") {
      return { status: "missing", lifecycle: null }
    }
    if (admission !== "admissible") {
      return { status: admission, lifecycle }
    }

    const claimed: OrderLifecycle = {
      ...lifecycle,
      invoiceStatus: "requesting",
      paymentStatus: "paying",
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
      phase: deriveOrderLifecyclePhase({
        ...lifecycle,
        invoiceStatus: "requesting",
        paymentStatus: "paying",
      }),
      updatedAt: Date.now(),
    }
    await db.orderLifecycles.put(claimed)
    return { status: "claimed", lifecycle: claimed }
  })
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

  const merged: OrderLifecycle = {
    ...existing,
    ...patch,
    orderId: existing.orderId,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  }
  merged.phase = patch.phase ?? deriveOrderLifecyclePhase(merged)
  if (merged.phase === "completed" && !merged.completedAt) {
    merged.completedAt = merged.updatedAt
  }

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
