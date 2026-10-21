import {
  db,
  appendConduitClientTag,
  getOrderConversationId,
  getOrderWireFormat,
  openMarketsLocalOrderId,
  type BuyerConversationSummary,
} from "@conduit/core"
import {
  publishBuyerOrderMessage,
  type BuyerOrderPublishDependencies,
} from "./order-publish"

type OrderReplyContext = NonNullable<
  BuyerOrderPublishDependencies["orderContext"]
>
type BuyerOrderReplyInput = {
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
  note: string
  conversation?: BuyerConversationSummary
}
type BuyerOrderReplyDependencies = Omit<
  BuyerOrderPublishDependencies,
  "orderLifecycle"
> & {
  loadOrderContextFn?: (
    orderId: string
  ) => Promise<OrderReplyContext | undefined>
}

/** Both buyer screens use the same persisted choice or authenticated original. */
export async function publishBuyerOrderReply(
  input: BuyerOrderReplyInput,
  dependencies: BuyerOrderReplyDependencies = {}
) {
  if (!input.note.trim()) throw new Error("Message is required")
  if (dependencies.shouldContinue?.() === false)
    throw new Error("Buyer order session ended")
  const { conversation } = input
  if (
    conversation &&
    (conversation.orderId !== input.orderId ||
      conversation.merchantPubkey !== input.merchantPubkey ||
      conversation.id !== getOrderConversationId(input))
  )
    throw new Error("Order conversation belongs to another buyer or merchant")
  const messages = conversation?.messages ?? []
  if (
    messages.some(
      (message) =>
        message.orderId !== input.orderId ||
        !(
          (message.senderPubkey === input.buyerPubkey &&
            message.recipientPubkey === input.merchantPubkey) ||
          (message.senderPubkey === input.merchantPubkey &&
            message.recipientPubkey === input.buyerPubkey)
        )
    )
  )
    throw new Error("Order conversation contains another buyer or merchant")
  const originals = messages.filter((message) => message.type === "order")
  const numericOriginals = originals.filter(
    (message) => message.wireFormat === "open_markets"
  )
  const rawIds = new Set(numericOriginals.map((message) => message.wireOrderId))
  const numericFormats = new Set(
    numericOriginals.map((message) =>
      message.commerceExtensionVersion === 2
        ? "open_markets_v2"
        : "open_markets"
    )
  )
  if (
    rawIds.size > 1 ||
    numericFormats.size > 1 ||
    rawIds.has(undefined) ||
    (numericOriginals.length && numericOriginals.length !== originals.length)
  )
    throw new Error("Order conversation has conflicting commerce formats")
  const orderId = numericOriginals[0]?.wireOrderId ?? input.orderId
  if (
    orderId !== input.orderId &&
    input.orderId !==
      openMarketsLocalOrderId(orderId, input.buyerPubkey, input.merchantPubkey)
  )
    throw new Error("Order conversation has a conflicting wire identity")
  const loadContext =
    dependencies.loadOrderContextFn ??
    (async (id: string) =>
      (await db.orderWireFormats.get(id)) ?? (await db.orderLifecycles.get(id)))
  let saved = dependencies.orderContext
  if (!saved) {
    try {
      const candidate = await loadContext(orderId)
      // An order-only storage key may belong to another participant pair.
      // Such a row is unrelated evidence, not a veto over the selected original.
      if (
        candidate?.orderId === orderId &&
        candidate.buyerPubkey === input.buyerPubkey &&
        candidate.merchantPubkey === input.merchantPubkey
      )
        saved = candidate
    } catch (error) {
      // A verified original still determines the format when local storage is unavailable.
      // The shared publisher reports local history failure after recipient acceptance.
      if (!originals.length) throw error
    }
  }
  if (dependencies.shouldContinue?.() === false)
    throw new Error("Buyer order session ended")
  if (
    saved &&
    (saved.orderId !== orderId ||
      saved.buyerPubkey !== input.buyerPubkey ||
      saved.merchantPubkey !== input.merchantPubkey)
  )
    throw new Error("Saved order format belongs to another buyer or merchant")
  const numericEvidence = messages.some(
    (message) => message.wireFormat === "open_markets"
  )
  if (numericEvidence && !numericOriginals.length && !saved)
    throw new Error(
      "Restore this order's saved format or original order before sending a reply."
    )
  const orderWireFormat = saved
    ? getOrderWireFormat(saved)
    : numericOriginals.length
      ? numericOriginals[0]?.commerceExtensionVersion === 2
        ? "open_markets_v2"
        : "open_markets"
      : "conduit"
  if (
    (numericEvidence && orderWireFormat === "conduit") ||
    (numericFormats.size > 0 &&
      !numericFormats.has(
        orderWireFormat as "open_markets" | "open_markets_v2"
      )) ||
    (originals.some((message) => message.wireFormat !== "open_markets") &&
      orderWireFormat !== "conduit")
  )
    throw new Error(
      "Order conversation conflicts with its saved commerce format"
    )
  return await publishBuyerOrderMessage(
    {
      id: "",
      pubkey: input.buyerPubkey,
      kind: 16,
      created_at: Math.floor(Date.now() / 1000),
      tags: appendConduitClientTag(
        [
          ["p", input.merchantPubkey],
          ["type", "message"],
          ["order", orderId],
        ],
        "market"
      ),
      content: JSON.stringify({
        note: input.note.trim(),
        orderId,
        buyerPubkey: input.buyerPubkey,
        merchantPubkey: input.merchantPubkey,
        createdAt: Date.now(),
      }),
    },
    input.merchantPubkey,
    input.buyerPubkey,
    {
      ...dependencies,
      orderContext: {
        orderId,
        buyerPubkey: input.buyerPubkey,
        merchantPubkey: input.merchantPubkey,
        orderWireFormat,
      },
    }
  )
}
