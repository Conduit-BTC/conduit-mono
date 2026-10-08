import {
  matchesCheckoutSparkMerchantOrderWitness,
  projectCheckoutSparkMerchantSettlement,
  restoreCheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkMerchantOrderWitness,
  type CheckoutSparkMerchantSettlementProjection,
  type CheckoutSparkMerchantSettlementRecord,
  type MerchantConversationSummary,
} from "@conduit/core"

export interface MerchantOrderSettlementBinding {
  readonly witness: CheckoutSparkMerchantOrderWitness
  readonly settlement: CheckoutSparkMerchantSettlementRecord
  /** UI-only receiver facts; never used as Spark execution/accounting proof. */
  readonly receiverSettlement?: CheckoutSparkMerchantSettlementProjection
}

/**
 * Attach private provider facts only to the exact authenticated buyer order.
 * Conversation lists may include cached rows or a same-ID mixed-buyer bucket;
 * neither is sufficient authority to project a routed order as paid.
 */
export function getCheckoutSparkOrderSettlementRecord(
  conversation: MerchantConversationSummary,
  bindings: readonly MerchantOrderSettlementBinding[]
): CheckoutSparkMerchantSettlementRecord | null {
  const candidates = bindings.filter(
    ({ witness }) => witness.orderId === conversation.orderId
  )
  if (candidates.length !== 1) return null

  const { witness, settlement } = candidates[0]!
  if (
    witness.merchantPubkey !== conversation.merchantPubkey ||
    witness.buyerPubkey !== conversation.buyerPubkey ||
    settlement.merchantPubkey !== witness.merchantPubkey ||
    settlement.orderId !== witness.orderId ||
    settlement.checkoutId !== witness.checkoutId ||
    settlement.planDigest !== witness.planDigest
  ) {
    return null
  }

  const orderMessages = (conversation.messages ?? []).filter(
    (message) => message.type === "order"
  )
  if (
    orderMessages.length === 0 ||
    orderMessages.some(
      (message) => !matchesCheckoutSparkMerchantOrderWitness(witness, message)
    )
  ) {
    return null
  }

  try {
    return restoreCheckoutSparkMerchantSettlementRecord(settlement)
  } catch {
    return null
  }
}

export function getCheckoutSparkOrderSettlement(
  conversation: MerchantConversationSummary,
  bindings: readonly MerchantOrderSettlementBinding[]
): CheckoutSparkMerchantSettlementProjection | null {
  const record = getCheckoutSparkOrderSettlementRecord(conversation, bindings)
  if (!record) return null
  const provider = projectCheckoutSparkMerchantSettlement(record)
  const receiver = bindings.find(
    ({ witness }) => witness.orderId === conversation.orderId
  )?.receiverSettlement
  if (!receiver) return provider
  return {
    ...provider,
    // Receiver settlement cannot prove this checkout paid the invoice. A buyer
    // can replay an old paid invoice in a new plan, even on a fresh device.
    receiverSettlementObserved: receiver.receiverSettlementObserved,
    receiverCommerceObserved: receiver.receiverCommerceObserved,
  }
}

export function projectCheckoutSparkOrderSettlements(
  conversations: readonly MerchantConversationSummary[],
  bindings: readonly MerchantOrderSettlementBinding[]
): ReadonlyMap<string, CheckoutSparkMerchantSettlementProjection> {
  const byConversation = new Map<
    string,
    CheckoutSparkMerchantSettlementProjection
  >()
  for (const conversation of conversations) {
    const projection = getCheckoutSparkOrderSettlement(conversation, bindings)
    if (projection) byConversation.set(conversation.id, projection)
  }
  return byConversation
}
