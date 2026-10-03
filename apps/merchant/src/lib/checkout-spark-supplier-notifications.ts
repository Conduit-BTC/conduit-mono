import {
  DexieCheckoutSparkSettledRepository,
  DexieCheckoutSparkSupplierNotificationRepository,
  getCheckoutSparkSupplierNotifications,
  captureCheckoutSparkSupplierNotificationSession,
  publishCheckoutSparkSupplierPaymentNotification,
  publishRetainedCheckoutSparkSupplierNotification,
  type CheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkSettledPlan,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"

const RETRY_MS = 60_000

export interface SupplierNotificationInput {
  principal: string
  candidate: MerchantCheckoutSparkRecoveryCandidate
  assertActive: () => void
  plan?: CheckoutSparkSettledPlan
  settlement?: CheckoutSparkMerchantSettlementRecord
}

/** Short-lived delivery coalescing; the durable outbox owns deduplication. */
export function createMerchantSupplierNotificationQueue(
  dispatch: (input: SupplierNotificationInput) => Promise<boolean>,
  schedule: (run: () => void, delayMs: number) => void = (run, delayMs) => {
    setTimeout(run, delayMs)
  }
): (input: SupplierNotificationInput) => void {
  const jobs = new Map<
    string,
    { latest: SupplierNotificationInput; attempts: number }
  >()
  const run = async (
    key: string,
    job: {
      latest: SupplierNotificationInput
      attempts: number
    }
  ) => {
    const input = job.latest
    let retryNeeded: boolean
    try {
      input.assertActive()
      retryNeeded = await dispatch(input)
    } catch {
      // Notification errors are advisory and contain no payment authority.
      retryNeeded = true
    }
    try {
      job.latest.assertActive()
      if (job.latest !== input) {
        // A later verified supplier must not be lost while an earlier notice
        // is awaiting a signer or relay. Existing ACKs are skipped by dispatch.
        void run(key, job)
      } else if (retryNeeded && job.attempts < 2) {
        job.attempts += 1
        schedule(() => void run(key, job), RETRY_MS * job.attempts)
      } else {
        jobs.delete(key)
      }
    } catch {
      jobs.delete(key)
    }
  }
  return (input) => {
    if (input.candidate.schemaVersion === 1) return
    const key = `${input.principal}:${input.candidate.checkoutId}:${input.candidate.planDigest}`
    const previous = jobs.get(key)
    if (previous) {
      // Retirement may occur during wrapping. Keep the already verified frozen
      // plan long enough to stage its notice, but use the current page guard.
      previous.latest = {
        ...input,
        plan: input.plan ?? previous.latest.plan,
        settlement: input.settlement ?? previous.latest.settlement,
      }
      return
    }
    const job = { latest: input, attempts: 0 }
    jobs.set(key, job)
    void run(key, job)
  }
}

async function dispatchSupplierNotifications(
  input: SupplierNotificationInput
): Promise<boolean> {
  const session = captureCheckoutSparkSupplierNotificationSession({
    merchantPubkey: input.principal,
    assertCurrent: input.assertActive,
  })
  if (!session) return true
  const { signer, shouldContinue, transport } = session
  let retryNeeded = false
  const store = new DexieCheckoutSparkSupplierNotificationRepository()
  if (
    !shouldContinue() ||
    (await signer.getPublicKey()).toLowerCase() !== input.principal
  )
    return false
  const snapshot =
    input.plan && input.settlement
      ? await new DexieCheckoutSparkSettledRepository().load(
          input.candidate.checkoutId,
          input.candidate.planDigest
        )
      : null
  if (!shouldContinue()) return false
  if (input.plan && input.settlement && snapshot?.status === "active") {
    for (const notification of getCheckoutSparkSupplierNotifications(
      input.plan,
      input.settlement,
      snapshot.state
    )) {
      if (!shouldContinue()) return false
      try {
        const result = await publishCheckoutSparkSupplierPaymentNotification({
          plan: input.plan,
          settlement: input.settlement,
          generationBinding: snapshot.state,
          supplierLegId: notification.legId,
          signer,
          store,
          shouldContinue,
          transport,
        })
        if (result === "pending") retryNeeded = true
        const staged = await store.load(notification)
        if (staged?.record.signedSenderWrap && !staged.senderAccepted)
          retryNeeded = true
      } catch {
        // A missing inbox or signer response cannot alter payment authority.
        if (!shouldContinue()) return false
        retryNeeded = true
      }
    }
  } else {
    // Retirement does not discard a previously staged notice or its ACK.
    const pending = await store.listIntents(
      input.principal,
      input.candidate.checkoutId,
      input.candidate.planDigest
    )
    for (const notification of pending) {
      if (!shouldContinue()) return false
      const result = await publishRetainedCheckoutSparkSupplierNotification({
        notification,
        signer,
        store,
        shouldContinue,
        transport,
      })
      const saved = await store.load(notification)
      if (
        result === "pending" ||
        (saved?.record.signedSenderWrap && !saved.senderAccepted)
      )
        retryNeeded = true
    }
  }
  return retryNeeded
}

/** Advisory delivery never joins the payment/recovery promise chain. */
export const queueMerchantCheckoutSparkSupplierNotifications =
  createMerchantSupplierNotificationQueue(dispatchSupplierNotifications)
