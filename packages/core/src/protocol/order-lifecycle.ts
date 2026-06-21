import { db, type OrderLifecycle, type OrderLifecyclePhase } from "../db"

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
