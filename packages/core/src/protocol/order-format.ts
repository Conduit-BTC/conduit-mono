import { db, type ConduitDB, type OrderLifecycle } from "../db"
import type { ParsedOrderMessage } from "./orders"
import { openMarketsLocalOrderId } from "./open-markets-orders"
import { GUEST_ORDER_LOCAL_RETENTION_MS } from "./order-lifecycle"

export type OrderWireFormat = "conduit" | "open_markets" | "open_markets_v2"

/** Absence is the deployed named contract, never inferred peer capability. */
export function getOrderWireFormat(order: {
  orderWireFormat?: OrderWireFormat
}): OrderWireFormat {
  const format = order.orderWireFormat ?? "conduit"
  if (
    format !== "conduit" &&
    format !== "open_markets" &&
    format !== "open_markets_v2"
  )
    throw new Error("Unsupported saved order format")
  return format
}

/** Durable, immutable choice before constructing/staging any encrypted bytes. */
export async function pinOrderWireFormat(
  order: Pick<
    OrderLifecycle,
    "orderId" | "buyerPubkey" | "merchantPubkey" | "orderWireFormat"
  > &
    Partial<
      Pick<
        OrderLifecycle,
        "buyerIdentityKind" | "createdAt" | "guestSessionExpiresAt"
      >
    >,
  options: { database?: ConduitDB; shouldContinue?: () => boolean } = {}
): Promise<OrderWireFormat> {
  const database = options.database ?? db
  const format = getOrderWireFormat(order)
  const assertCurrent = () => {
    if (options.shouldContinue?.() === false)
      throw new Error("Order format selection session ended")
  }
  assertCurrent()
  return await database.transaction(
    "rw",
    [database.orderWireFormats, database.orderLifecycles],
    async () => {
      const [previous, lifecycle] = await Promise.all([
        database.orderWireFormats.get(order.orderId),
        database.orderLifecycles.get(order.orderId),
      ])
      assertCurrent()
      if (
        lifecycle &&
        (lifecycle.buyerPubkey !== order.buyerPubkey ||
          lifecycle.merchantPubkey !== order.merchantPubkey ||
          getOrderWireFormat(lifecycle) !== format)
      )
        throw new Error(
          "A staged order cannot change its party pair or commerce format"
        )
      if (
        previous &&
        (previous.buyerPubkey !== order.buyerPubkey ||
          previous.merchantPubkey !== order.merchantPubkey ||
          previous.orderWireFormat !== format)
      )
        throw new Error(
          "A saved order cannot change its party pair or commerce format"
        )
      if (!previous)
        await database.orderWireFormats.add({
          orderId: order.orderId,
          buyerPubkey: order.buyerPubkey,
          merchantPubkey: order.merchantPubkey,
          orderWireFormat: format,
          createdAt: Date.now(),
          ...(order.buyerIdentityKind === "guest_ephemeral"
            ? {
                expiresAt: Math.min(
                  (order.createdAt ?? Date.now()) +
                    GUEST_ORDER_LOCAL_RETENTION_MS,
                  order.guestSessionExpiresAt ?? Number.POSITIVE_INFINITY
                ),
              }
            : {}),
        })
      assertCurrent()
      return format
    }
  )
}

/** Join installed-version named replies without rewriting signed events or operation keys. */
export function correlateLegacyNumericOrderHistory(
  messages: readonly ParsedOrderMessage[]
): ParsedOrderMessage[] {
  const namedOrders = new Set(
    messages
      .filter(
        (message) =>
          message.type === "order" && message.wireFormat !== "open_markets"
      )
      .map((message) =>
        openMarketsLocalOrderId(
          message.orderId,
          message.senderPubkey,
          message.recipientPubkey
        )
      )
  )
  const bindings = new Map(
    messages
      .filter(
        (message) =>
          message.type === "order" &&
          message.wireFormat === "open_markets" &&
          message.conduitExtension &&
          message.wireOrderId
      )
      .map((message) => [message.orderId, message.wireOrderId!] as const)
  )
  return messages.map((message) => {
    if (message.type === "order" || message.wireFormat === "open_markets")
      return message
    const orderId = openMarketsLocalOrderId(
      message.orderId,
      message.senderPubkey,
      message.recipientPubkey
    )
    if (namedOrders.has(orderId) || bindings.get(orderId) !== message.orderId)
      return message
    return {
      ...message,
      orderId,
      wireOrderId: message.orderId,
      legacyNumericOrder: true,
      ...(message.type === "payment_proof"
        ? { payload: { ...message.payload, orderId } }
        : {}),
    } as ParsedOrderMessage
  })
}

/** Bind merchant status to an exact buyer-owned order, never to a brand tag.
 * Local choices survive lifecycle loss; authenticated buyer originals support
 * recovery on another device. This does not turn a buyer payment report into
 * settlement evidence for the merchant.
 */
export function projectOwnedNumericOrderMessages(
  messages: readonly ParsedOrderMessage[],
  orders: readonly Pick<
    OrderLifecycle,
    "orderId" | "buyerPubkey" | "merchantPubkey" | "orderWireFormat"
  >[],
  principal: string
): ParsedOrderMessage[] {
  type Binding = { orderId: string; merchantPubkey: string }
  const bindings = new Map<string, Binding | null>()
  const bind = (order: (typeof orders)[number]) => {
    if (order.buyerPubkey !== principal) return
    const alias = openMarketsLocalOrderId(
      order.orderId,
      principal,
      order.merchantPubkey
    )
    // Conflicting named/numeric evidence for this exact pair fails closed.
    if (getOrderWireFormat(order) === "conduit") bindings.set(alias, null)
    else if (bindings.get(alias) !== null) bindings.set(alias, order)
  }
  for (const order of orders) bind(order)
  for (const message of messages) {
    if (
      message.type !== "order" ||
      message.senderPubkey !== principal ||
      message.payload.buyerPubkey !== principal ||
      message.payload.merchantPubkey !== message.recipientPubkey
    )
      continue
    const numeric = message.wireFormat === "open_markets"
    const orderId = numeric ? message.wireOrderId : message.orderId
    if (
      !orderId ||
      (numeric &&
        message.orderId !==
          openMarketsLocalOrderId(orderId, principal, message.recipientPubkey))
    )
      continue
    bind({
      orderId,
      buyerPubkey: principal,
      merchantPubkey: message.recipientPubkey,
      orderWireFormat: numeric
        ? message.commerceExtensionVersion === 2
          ? "open_markets_v2"
          : "open_markets"
        : "conduit",
    })
  }
  return messages.map((message) => {
    if (message.wireFormat !== "open_markets" && !message.legacyNumericOrder)
      return message
    const order = bindings.get(message.orderId)
    if (
      !order ||
      message.wireOrderId !== order.orderId ||
      !(
        (message.senderPubkey === principal &&
          message.recipientPubkey === order.merchantPubkey) ||
        (message.senderPubkey === order.merchantPubkey &&
          message.recipientPubkey === principal)
      )
    )
      return message
    if (message.type === "order") {
      if (message.wireFormat !== "open_markets") return message
      return {
        ...message,
        orderId: order.orderId,
        payload: { ...message.payload, id: order.orderId },
      }
    }
    if (message.type === "payment_proof")
      return {
        ...message,
        orderId: order.orderId,
        payload: { ...message.payload, orderId: order.orderId },
      }
    if (
      message.type === "status_update" &&
      message.wireFormat === "open_markets" &&
      message.senderPubkey === order.merchantPubkey
    ) {
      const statuses: Record<string, string> = {
        pending: "accepted",
        payment_reported: "paid",
        fulfillment_reported: "complete",
        cancellation_requested: "cancelled",
        fulfillment_processing_reported: "processing",
        fulfillment_delivered_reported: "delivered",
      }
      return {
        ...message,
        orderId: order.orderId,
        payload: {
          ...message.payload,
          status: statuses[message.payload.status] ?? message.payload.status,
        },
      }
    }
    return { ...message, orderId: order.orderId }
  })
}
