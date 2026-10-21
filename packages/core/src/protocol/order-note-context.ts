import type { ParsedDirectMessage } from "./private-message-primitives"
import { openMarketsLocalOrderId } from "./open-markets-orders"

export interface OrderNoteContext {
  orderId: string
  wireOrderId: string
}

/** Read exact references from an authenticated rumor, not a room's latest topic. */
export function readDirectMessageReferences(tags: string[][]): {
  subject?: string
  orderReference?: string | null
  replyTo?: string
} {
  const subject = tags.filter((tag) => tag[0] === "subject")
  const order = tags.filter((tag) => tag[0] === "order")
  const reply = tags.filter((tag) => tag[0] === "e")
  const ambiguous =
    [subject, order, reply].some((rows) => rows.length > 1) ||
    [...subject, ...order].some((tag) => tag.length !== 2 || !tag[1]) ||
    reply.some((tag) => !tag[1])
  return {
    ...(subject.length === 1 ? { subject: subject[0]![1] } : {}),
    ...(ambiguous
      ? { orderReference: null }
      : order.length === 1
        ? { orderReference: order[0]![1] }
        : {}),
    ...(reply.length === 1 ? { replyTo: reply[0]![1] } : {}),
  }
}

/** Non-authoritative transcript association, anchored by retained order evidence. */
export function resolveOrderNoteContexts(
  messages: readonly ParsedDirectMessage[],
  orders: readonly {
    wireOrderId: string
    buyerPubkey: string
    merchantPubkey: string
  }[]
): Map<string, OrderNoteContext> {
  const known = new Map<
    string,
    { context: OrderNoteContext; buyer: string } | null
  >()
  for (const order of orders) {
    const orderId = openMarketsLocalOrderId(
      order.wireOrderId,
      order.buyerPubkey,
      order.merchantPubkey
    )
    const previous = known.get(orderId)
    // Opposite-direction orders with the same raw ID are not an unambiguous note target.
    known.set(
      orderId,
      previous === null || (previous && previous.buyer !== order.buyerPubkey)
        ? null
        : {
            context: { orderId, wireOrderId: order.wireOrderId },
            buyer: order.buyerPubkey,
          }
    )
  }
  const byId = new Map(messages.map((message) => [message.id, message]))
  const resolved = new Map<string, OrderNoteContext>()
  const visited = new Set<string>()
  const pair = (message: ParsedDirectMessage) =>
    [message.senderPubkey, message.recipientPubkey].sort().join(":")
  const eligible = (message: ParsedDirectMessage) =>
    message.transport === "nip17" &&
    !message.file &&
    !message.orderCompanionIdentity &&
    message.orderReference !== null &&
    message.senderPubkey !== message.recipientPubkey &&
    (!message.participants ||
      (message.participants.length === 2 &&
        [...message.participants].sort().join(":") === pair(message)))
  const lookup = (message: ParsedDirectMessage, wireOrderId: string) =>
    known.get(
      openMarketsLocalOrderId(
        wireOrderId,
        message.senderPubkey,
        message.recipientPubkey
      )
    )?.context

  for (const start of messages) {
    if (visited.has(start.id)) continue
    const chain: ParsedDirectMessage[] = []
    const visiting = new Set<string>()
    let current: ParsedDirectMessage | undefined = start
    // Iterative traversal keeps long or adversarial histories off the call stack.
    while (current && !visited.has(current.id) && !visiting.has(current.id)) {
      visiting.add(current.id)
      chain.push(current)
      if (!eligible(current)) break
      const parent: ParsedDirectMessage | undefined = current.replyTo
        ? byId.get(current.replyTo)
        : undefined
      current = parent && pair(parent) === pair(current) ? parent : undefined
    }
    const cycle = Boolean(
      current && eligible(current) && visiting.has(current.id)
    )
    for (const message of chain.reverse()) {
      visited.add(message.id)
      if (cycle || !eligible(message)) continue
      const parent = message.replyTo ? byId.get(message.replyTo) : undefined
      const inherited =
        parent && pair(parent) === pair(message)
          ? resolved.get(parent.id)
          : undefined
      const explicit = message.orderReference
        ? lookup(message, message.orderReference)
        : undefined
      const subject = message.subject
        ? lookup(message, message.subject)
        : undefined
      if (message.orderReference && !explicit) continue
      if (explicit && subject && explicit.orderId !== subject.orderId) continue
      // An explicit new topic ends implicit order ancestry. An order tag can still bind it.
      if (!explicit && message.subject && !subject) continue
      const reference = explicit ?? subject
      if (reference && inherited && reference.orderId !== inherited.orderId)
        continue
      const context = reference ?? inherited
      if (context) resolved.set(message.id, context)
    }
  }
  return resolved
}
