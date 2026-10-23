import {
  type CommerceResult,
  type OrderLifecycle,
  getOrderConversationId,
  getCachedBuyerConversationList,
  getBuyerConversationList,
  type BuyerConversationSummary,
} from "@conduit/core"

export type BuyerConversation = BuyerConversationSummary

export async function fetchBuyerConversations(
  buyerPubkey: string
): Promise<CommerceResult<BuyerConversation[]>> {
  return await getBuyerConversationList({
    principalPubkey: buyerPubkey,
    limit: 200,
  })
}

export async function fetchCachedBuyerConversations(
  buyerPubkey: string
): Promise<CommerceResult<BuyerConversation[]>> {
  return await getCachedBuyerConversationList({
    principalPubkey: buyerPubkey,
    limit: 200,
  })
}

export interface BuyerOrderEntry {
  id: string
  orderId: string
  merchantPubkey: string
  lifecycle?: OrderLifecycle
  conversation?: BuyerConversation
}

export function mergeBuyerOrderConversations(
  buyerPubkey: string,
  lifecycles: readonly OrderLifecycle[],
  conversations: readonly BuyerConversation[]
): BuyerOrderEntry[] {
  const entries = new Map<string, BuyerOrderEntry>()
  for (const lifecycle of lifecycles) {
    if (lifecycle.buyerPubkey !== buyerPubkey) continue
    const id = getOrderConversationId(lifecycle)
    entries.set(id, {
      id,
      orderId: lifecycle.orderId,
      merchantPubkey: lifecycle.merchantPubkey,
      lifecycle,
    })
  }
  for (const conversation of conversations) {
    const id = getOrderConversationId({
      orderId: conversation.orderId,
      buyerPubkey,
      merchantPubkey: conversation.merchantPubkey,
    })
    entries.set(id, {
      ...entries.get(id),
      id,
      orderId: conversation.orderId,
      merchantPubkey: conversation.merchantPubkey,
      conversation,
    })
  }
  return [...entries.values()]
}
