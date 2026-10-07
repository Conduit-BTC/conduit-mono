import {
  verifyCheckoutSparkInvoiceRecipient,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledOutgoingTarget,
  type DexieCheckoutSparkSettledRepository,
} from "@conduit/core"

export type BuyerCheckoutSparkRecipientRepository = Pick<
  DexieCheckoutSparkSettledRepository,
  "recordInvoiceRecipientVerification" | "hasInvoiceRecipientSettlement"
>

/** Receiver-paid evidence is distinct from the native Spark transfer proof. */
export async function verifyBuyerCheckoutSparkRecipientSettlement(input: {
  plan: CheckoutSparkSettledPlan
  target: CheckoutSparkSettledOutgoingTarget
  repository: Partial<BuyerCheckoutSparkRecipientRepository>
  now: () => number
  assertCurrent: () => void
  verifyInvoice?: typeof verifyCheckoutSparkInvoiceRecipient
}): Promise<boolean> {
  input.assertCurrent()
  if (!input.target.intent.receiverBinding) return true
  const { repository } = input
  if (
    !repository.recordInvoiceRecipientVerification ||
    !repository.hasInvoiceRecipientSettlement
  )
    return false
  if (
    await repository.hasInvoiceRecipientSettlement(
      input.plan,
      input.target,
      input.assertCurrent
    )
  )
    return true
  const result = await (
    input.verifyInvoice ?? verifyCheckoutSparkInvoiceRecipient
  )({
    plan: input.plan,
    target: input.target,
    now: input.now(),
    assertCurrent: input.assertCurrent,
  })
  input.assertCurrent()
  if (result.status !== "verified") return false
  await repository.recordInvoiceRecipientVerification(
    input.plan,
    input.target,
    result.proof,
    input.assertCurrent
  )
  input.assertCurrent()
  return (
    result.settled &&
    (await repository.hasInvoiceRecipientSettlement(
      input.plan,
      input.target,
      input.assertCurrent
    ))
  )
}
