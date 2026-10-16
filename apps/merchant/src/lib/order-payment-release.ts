import {
  publishMerchantOrderMessage,
  type MerchantOrderDelivery,
  type OrderSchema,
  type PublishMerchantOrderMessageResult,
} from "@conduit/core"

export interface MerchantPaymentConfirmationInput {
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
  delivery: MerchantOrderDelivery
  order: OrderSchema | null
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
}
interface PaymentConfirmationDependencies {
  publishPaid(
    input: MerchantPaymentConfirmationInput
  ): Promise<PublishMerchantOrderMessageResult | void>
}
const defaults: PaymentConfirmationDependencies = {
  async publishPaid(input) {
    return await publishMerchantOrderMessage({
      merchantPubkey: input.merchantPubkey,
      buyerPubkey: input.buyerPubkey,
      orderId: input.orderId,
      type: "status_update",
      tags: [["status", "paid"]],
      payload: { status: "paid" },
      delivery: input.delivery,
      signerInteraction: "external",
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
    })
  },
}
/** Settlement confirmation and physical release are separate explicit actions. */
export async function confirmMerchantPayment(
  input: MerchantPaymentConfirmationInput,
  dependencies: PaymentConfirmationDependencies = defaults
): Promise<{
  payment: "confirmed"
  delivery?: PublishMerchantOrderMessageResult
}> {
  const { shouldContinue, ...snapshot } = input
  const captured: MerchantPaymentConfirmationInput = {
    ...structuredClone(snapshot),
    shouldContinue,
  }
  if (
    captured.order &&
    (captured.order.id !== captured.orderId ||
      captured.order.merchantPubkey !== captured.merchantPubkey ||
      captured.order.buyerPubkey !== captured.buyerPubkey)
  )
    throw new Error(
      "Payment confirmation must refer to the exact captured order."
    )
  const delivery = await dependencies.publishPaid(captured)
  return {
    payment: "confirmed",
    ...(delivery ? { delivery } : {}),
  }
}
