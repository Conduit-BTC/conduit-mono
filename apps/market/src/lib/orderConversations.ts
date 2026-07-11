import type { NDKSigner } from "@nostr-dev-kit/ndk"
import {
  type CommerceResult,
  getCachedBuyerConversationList,
  getBuyerConversationList,
  type BuyerConversationSummary,
} from "@conduit/core"

export type BuyerConversation = BuyerConversationSummary

export async function fetchBuyerConversations(
  buyerPubkey: string,
  options: {
    signer?: NDKSigner
    expectedOrderId?: string
    expectedCounterpartyPubkey?: string
  } = {}
): Promise<CommerceResult<BuyerConversation[]>> {
  return await getBuyerConversationList({
    principalPubkey: buyerPubkey,
    limit: 200,
    signer: options.signer,
    expectedOrderId: options.expectedOrderId,
    expectedCounterpartyPubkey: options.expectedCounterpartyPubkey,
  })
}

export async function fetchCachedBuyerConversations(
  buyerPubkey: string,
  options: {
    expectedOrderId?: string
    expectedCounterpartyPubkey?: string
  } = {}
): Promise<CommerceResult<BuyerConversation[]>> {
  return await getCachedBuyerConversationList({
    principalPubkey: buyerPubkey,
    limit: 200,
    expectedOrderId: options.expectedOrderId,
    expectedCounterpartyPubkey: options.expectedCounterpartyPubkey,
  })
}
