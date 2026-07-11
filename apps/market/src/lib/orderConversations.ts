import {
  type CommerceResult,
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
