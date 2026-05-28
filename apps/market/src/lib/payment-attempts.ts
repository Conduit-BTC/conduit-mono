import { db, type StoredPaymentAttempt } from "@conduit/core"

export async function savePaymentAttempt(
  attempt: StoredPaymentAttempt
): Promise<void> {
  await db.paymentAttempts.put(attempt)
}

export async function updatePaymentAttempt(
  id: string,
  patch: Partial<Omit<StoredPaymentAttempt, "id" | "createdAt">>
): Promise<void> {
  await db.paymentAttempts.update(id, {
    ...patch,
    updatedAt: Date.now(),
  })
}
