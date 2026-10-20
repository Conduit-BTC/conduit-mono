import type { ParsedOrderMessage } from "./orders"

export interface OrderConversationIdentity {
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
}

/** Local projection identity; the signed order ID remains unchanged. */
export function getOrderConversationId(
  identity: OrderConversationIdentity
): string {
  return JSON.stringify([
    identity.orderId,
    identity.buyerPubkey,
    identity.merchantPubkey,
  ])
}

interface OrderConversationGroup extends OrderConversationIdentity {
  id: string
  messages: ParsedOrderMessage[]
}

/** Group authenticated endpoints before deriving previews or action targets. */
export function groupOrderConversationMessages(
  messages: readonly ParsedOrderMessage[],
  principalPubkey: string
): OrderConversationGroup[] {
  const groups = new Map<string, OrderConversationGroup>()
  const unassigned: ParsedOrderMessage[] = []
  for (const message of messages) {
    if (
      message.senderPubkey === message.recipientPubkey ||
      (message.senderPubkey !== principalPubkey &&
        message.recipientPubkey !== principalPubkey)
    )
      continue
    let buyerPubkey: string
    let merchantPubkey: string
    switch (message.type) {
      case "order":
      case "payment_proof":
        buyerPubkey = message.senderPubkey
        merchantPubkey = message.recipientPubkey
        break
      case "payment_request":
      case "status_update":
      case "shipping_update":
      case "receipt":
        buyerPubkey = message.recipientPubkey
        merchantPubkey = message.senderPubkey
        break
      default:
        unassigned.push(message)
        continue
    }
    const identity = { orderId: message.orderId, buyerPubkey, merchantPubkey }
    const id = getOrderConversationId(identity)
    let group = groups.get(id)
    if (!group) {
      group = { ...identity, id, messages: [] }
      groups.set(id, group)
    }
    group.messages.push(message)
  }
  for (const message of unassigned) {
    const forward = groups.get(
      getOrderConversationId({
        orderId: message.orderId,
        buyerPubkey: message.senderPubkey,
        merchantPubkey: message.recipientPubkey,
      })
    )
    const reverse = groups.get(
      getOrderConversationId({
        orderId: message.orderId,
        buyerPubkey: message.recipientPubkey,
        merchantPubkey: message.senderPubkey,
      })
    )
    // Plain replies do not establish roles. Retain the raw inbox evidence, but
    // never assign an ambiguous reply to either of two reversed-role orders.
    if (forward && !reverse) forward.messages.push(message)
    else if (reverse && !forward) reverse.messages.push(message)
  }
  return [...groups.values()].filter((group) => {
    const reverse = groups.get(
      getOrderConversationId({
        orderId: group.orderId,
        buyerPubkey: group.merchantPubkey,
        merchantPubkey: group.buyerPubkey,
      })
    )
    // Contradictory partial history cannot establish roles for the same pair.
    // An authenticated original order anchors its own direction independently.
    return (
      !reverse || group.messages.some((message) => message.type === "order")
    )
  })
}

/** An order-only link is usable only when it names one observed conversation. */
export function findOrderConversation<
  T extends { id: string; orderId: string; messages?: ParsedOrderMessage[] },
>(
  conversations: readonly T[],
  orderId: string,
  conversationId?: string
): T | null {
  const matches = conversations.filter((conversation) => {
    if (
      conversation.orderId === orderId &&
      (!conversationId || conversation.id === conversationId)
    )
      return true
    // Numeric wire links name the signed ID; the inbox uses a party-scoped
    // alias. Resolve only through an authenticated original in this group.
    return (
      conversation.messages?.some((message) => {
        if (
          message.type !== "order" ||
          message.wireFormat !== "open_markets" ||
          message.wireOrderId !== orderId ||
          message.orderId !== conversation.orderId
        )
          return false
        const parties = {
          buyerPubkey: message.senderPubkey,
          merchantPubkey: message.recipientPubkey,
        }
        return (
          conversation.id ===
            getOrderConversationId({ ...parties, orderId: message.orderId }) &&
          (!conversationId ||
            conversationId === getOrderConversationId({ ...parties, orderId }))
        )
      }) ?? false
    )
  })
  return matches.length === 1 ? matches[0]! : null
}
