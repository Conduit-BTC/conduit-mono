import { db, type StoredPaymentAttempt } from "@conduit/core"

export async function savePaymentAttempt(
  attempt: StoredPaymentAttempt
): Promise<void> {
  await db.transaction("rw", db.paymentAttempts, async () => {
    const existing = await db.paymentAttempts.get(attempt.id)
    if (!existing) {
      await db.paymentAttempts.put(attempt)
      return
    }
    await db.paymentAttempts.put({
      ...existing,
      ...attempt,
      createdAt: existing.createdAt,
      proofDeliveryStatus:
        existing.proofDeliveryStatus === "sent" ||
        attempt.proofDeliveryStatus === "sent"
          ? "sent"
          : attempt.proofDeliveryStatus,
      invoice: attempt.invoice || existing.invoice,
      paymentHash: attempt.paymentHash ?? existing.paymentHash,
      preimage: attempt.preimage ?? existing.preimage,
      feeMsats: attempt.feeMsats ?? existing.feeMsats,
      zapRequestId: attempt.zapRequestId ?? existing.zapRequestId,
      zapReceiptId: attempt.zapReceiptId ?? existing.zapReceiptId,
      updatedAt: Math.max(existing.updatedAt, attempt.updatedAt),
    })
  })
}

export async function updatePaymentAttempt(
  id: string,
  patch: Partial<Omit<StoredPaymentAttempt, "id" | "createdAt">>
): Promise<void> {
  await db.transaction("rw", db.paymentAttempts, async () => {
    const existing = await db.paymentAttempts.get(id)
    if (!existing) return
    const next = { ...patch }
    if (
      existing.proofDeliveryStatus === "sent" &&
      next.proofDeliveryStatus !== "sent"
    ) {
      delete next.proofDeliveryStatus
    }
    await db.paymentAttempts.update(id, {
      ...next,
      updatedAt: Date.now(),
    })
  })
}
