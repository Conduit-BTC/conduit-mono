import {
  verifyCheckoutSparkInvoiceRecipient,
  getCheckoutSparkSettledLegGeneration,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledReconciliation,
  type DexieCheckoutSparkSettledRepository,
} from "@conduit/core"
type RecipientRepository = Pick<
  DexieCheckoutSparkSettledRepository,
  "hasInvoiceRecipient" | "recordInvoiceRecipientVerification"
> &
  Partial<
    Pick<DexieCheckoutSparkSettledRepository, "hasInvoiceRecipientSettlement">
  >

/**
 * Recheck preserved invoices against their receiving provider, not the buyer.
 * This read-only network phase cannot create an invoice or send/claim funds.
 * Unsupported providers stay unverified; they are never guessed or substituted.
 */
export async function verifySavedMerchantCheckoutSparkRecipients(input: {
  state: CheckoutSparkSettledReconciliation
  repository: RecipientRepository
  assertCurrent: () => void
  now: () => number
  verifyInvoice?: typeof verifyCheckoutSparkInvoiceRecipient
}): Promise<"complete" | "unavailable"> {
  const { state, repository, assertCurrent, now } = input
  assertCurrent()
  let unavailable = false
  for (const leg of state.legs) {
    if (!leg.intent || leg.allocationSats === null) continue
    const recipient = state.plan.recipients.find(
      (candidate) => candidate.legId === leg.legId
    )!
    const target: CheckoutSparkSettledOutgoingTarget = {
      walletId: state.plan.walletId,
      network: state.plan.network,
      legId: leg.legId,
      recipientId: recipient.recipientId,
      allocationSats: leg.allocationSats,
      // Attribution is independent of dispatch reservation; no send uses this.
      unpaidAllocationSats: leg.allocationSats,
      intent: leg.intent,
      ...(getCheckoutSparkSettledLegGeneration(leg) === 1
        ? { generation: 1 as const }
        : {}),
    }
    // A preserved bound attempt may become paid during the following Spark
    // read. Recheck receiver settlement until positive, even if its saved
    // origin was verified while unpaid. Neither fact permits another send.
    const verified = target.intent.receiverBinding
      ? (await repository.hasInvoiceRecipientSettlement?.(
          state.plan,
          target,
          assertCurrent
        )) === true
      : await repository.hasInvoiceRecipient(state.plan, target, assertCurrent)
    if (verified) {
      assertCurrent()
      continue
    }
    assertCurrent()
    const result = await (
      input.verifyInvoice ?? verifyCheckoutSparkInvoiceRecipient
    )({ plan: state.plan, target, now: now(), assertCurrent })
    assertCurrent()
    if (result.status === "unavailable") unavailable = true
    if (result.status !== "verified") continue
    await repository.recordInvoiceRecipientVerification(
      state.plan,
      target,
      result.proof,
      assertCurrent
    )
    assertCurrent()
  }
  return unavailable ? "unavailable" : "complete"
}
