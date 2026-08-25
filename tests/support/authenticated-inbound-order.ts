import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  EVENT_KINDS,
  getMerchantConversationList,
  type ParsedOrderMessage,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"
import { authorizeGiftUnwrapTestOverride } from "../../packages/core/src/internal/inbound-order-provenance"

type ParsedInboundOrder = Extract<ParsedOrderMessage, { type: "order" }>

/** Obtain lifecycle authority through the same inbox unwrap path as production. */
export async function loadAuthenticatedInboundOrderFromInbox(
  order: ParsedInboundOrder
): Promise<ParsedInboundOrder> {
  const relayUrl = "wss://authenticated-order-fixture.example"
  const wrap = new NDKEvent()
  wrap.id = `wrap-${order.id}`
  wrap.kind = EVENT_KINDS.GIFT_WRAP
  wrap.pubkey = `ephemeral-${order.id}`
  wrap.created_at = Math.floor(order.createdAt / 1_000)
  wrap.tags = [["p", order.recipientPubkey]]
  wrap.content = "wrapped"
  attachEventSourceRelayUrl(wrap, relayUrl)

  const rumor = new NDKEvent()
  rumor.id = order.id
  rumor.kind = EVENT_KINDS.ORDER
  rumor.pubkey = order.senderPubkey
  rumor.created_at = Math.floor(order.createdAt / 1_000)
  rumor.tags = [
    ["p", order.recipientPubkey],
    ["type", "order"],
    ["order", order.orderId],
  ]
  rumor.content = JSON.stringify(order.payload)

  __resetCommerceTestOverrides()
  try {
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [relayUrl],
      fetchEventsFanoutWithDiagnostics: async (_filter, options) => ({
        events: [wrap],
        attemptedRelayUrls: [...(options?.relayUrls ?? [])],
        successfulRelayUrls: [...(options?.relayUrls ?? [])],
        failedRelayUrls: [],
      }),
      getCachedOrderMessages: async () => [],
      putCachedOrderMessages: async () => undefined,
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: authorizeGiftUnwrapTestOverride(async () => rumor),
    })

    const result = await getMerchantConversationList({
      principalPubkey: order.recipientPubkey,
    })
    const authenticated = result.data
      .flatMap((conversation) => conversation.messages)
      .find((message) => message.id === order.id)
    if (!authenticated || authenticated.type !== "order") {
      throw new Error("Expected an authenticated inbound order fixture")
    }
    return authenticated
  } finally {
    __resetCommerceTestOverrides()
  }
}
