import type { MerchantCompletionBasis } from "../schemas"
import { getCommerceInbox } from "./commerce-inbox"
import {
  getEffectiveMerchantOrderStatus,
  type MerchantOrderState,
} from "./order-status"
import { extractOrderSummary } from "./order-summary"
import {
  publishMerchantOrderMessage,
  type PublishMerchantOrderMessageInput,
} from "./merchant-order-publish"
import type { ParsedOrderMessage } from "./orders"

export function getMerchantManualCompletionMethods(
  state: MerchantOrderState
): MerchantCompletionBasis[] {
  if (
    state.paid !== true ||
    state.pickupClaimed ||
    state.fulfillmentMode === "pickup" ||
    !["pending", "accepted", "paid", "processing", "invoiced"].includes(
      state.status ?? "pending"
    )
  )
    return []
  if (state.fulfillmentMode === "digital" || state.requiresShipping === false)
    return []
  return state.fulfillmentMode === "shipping"
    ? ["delivered_without_tracking"]
    : ["delivered_without_tracking", "historical_handoff"]
}

/** A status completion attests to fulfillment without rewriting the buyer's terms. */
export function prepareMerchantManualCompletion(
  state: MerchantOrderState,
  basis: MerchantCompletionBasis,
  note = ""
) {
  if (!getMerchantManualCompletionMethods(state).includes(basis))
    throw new Error("This order is no longer eligible for manual completion.")
  const trimmed = note.trim()
  if (trimmed.length > 2000)
    throw new Error("Completion note must be 2000 characters or fewer.")
  return {
    tags: [["status", "complete"]],
    payload: {
      status: "complete",
      completionBasis: basis,
      ...(trimmed ? { note: trimmed } : {}),
    },
  }
}

export async function completeMerchantOrder(
  input: Pick<
    PublishMerchantOrderMessageInput,
    | "merchantPubkey"
    | "buyerPubkey"
    | "orderId"
    | "delivery"
    | "authenticatedPubkey"
    | "shouldContinue"
  > & {
    messages: ParsedOrderMessage[]
    basis: MerchantCompletionBasis
    note?: string
  }
) {
  if (
    input.authenticatedPubkey !== input.merchantPubkey ||
    input.shouldContinue?.() === false
  )
    throw new Error("Connect the intended merchant to record completion.")
  const owner = getCommerceInbox(input.merchantPubkey)
  await owner.initialize()
  await owner.refresh()
  if (input.shouldContinue?.() === false)
    throw new Error("Merchant signer session changed")
  const retained = owner.getSnapshot().orderMessages
  const messages = [
    ...new Map(
      [...input.messages, ...retained].map((message) => [message.id, message])
    ).values(),
  ]
    .filter((message) => message.orderId === input.orderId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const participants = {
    buyerPubkey: input.buyerPubkey,
    merchantPubkey: input.merchantPubkey,
  }
  const summary = extractOrderSummary(messages, participants)
  const status = getEffectiveMerchantOrderStatus(messages, participants).status
  if (status === "complete" || status === "delivered")
    return { alreadyCompleted: true }
  const pickupClaimed = summary.items.some(
    (item) => item.fulfillment?.type === "event_market_pickup"
  )
  const shipping =
    summary.items.length > 0 &&
    summary.items.every(
      (item) =>
        item.fulfillment?.type === "shipping" || item.format === "digital"
    )
  const digital =
    summary.items.length > 0 &&
    summary.items.every((item) => item.format === "digital")
  const transition = prepareMerchantManualCompletion(
    {
      status,
      paid: summary.paymentConfirmed,
      pickupClaimed,
      fulfillmentMode: digital ? "digital" : shipping ? "shipping" : "unknown",
    },
    input.basis,
    input.note
  )
  await publishMerchantOrderMessage({
    ...input,
    ...transition,
    type: "status_update",
    persistCompletion: true,
    signerInteraction: "external",
  })
  return { alreadyCompleted: false }
}
