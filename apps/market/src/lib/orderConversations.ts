import {
  type CommerceResult,
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
