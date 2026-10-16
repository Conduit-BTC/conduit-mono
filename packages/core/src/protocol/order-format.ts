import { db, type ConduitDB, type OrderLifecycle } from "../db"
import type { ParsedOrderMessage } from "./orders"
import { openMarketsLocalOrderId } from "./open-markets-orders"
import { GUEST_ORDER_LOCAL_RETENTION_MS } from "./order-lifecycle"

export type OrderWireFormat = "conduit" | "open_markets"

/** Absence is the deployed named contract, never inferred peer capability. */
export function getOrderWireFormat(order: {
  orderWireFormat?: OrderWireFormat
}): OrderWireFormat {
  const format = order.orderWireFormat ?? "conduit"
  if (format !== "conduit" && format !== "open_markets")
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

/** Bind incoming numeric evidence to a locally staged buyer order, not a brand tag. */
export function projectOwnedNumericOrderMessages(
  messages: readonly ParsedOrderMessage[],
  orders: readonly Pick<
    OrderLifecycle,
    "orderId" | "buyerPubkey" | "merchantPubkey" | "orderWireFormat"
  >[],
  principal: string
): ParsedOrderMessage[] {
  const bindings = new Map(
    orders
      .filter(
        (order) =>
          order.buyerPubkey === principal &&
          order.orderWireFormat === "open_markets"
      )
      .map(
        (order) =>
          [
            openMarketsLocalOrderId(
              order.orderId,
              principal,
              order.merchantPubkey
            ),
            order,
          ] as const
      )
  )
  return messages.map((message) => {
    if (message.wireFormat !== "open_markets") return message
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
    if (message.type === "order")
      return {
        ...message,
        orderId: order.orderId,
        payload: { ...message.payload, id: order.orderId },
      }
    if (message.type === "payment_proof")
      return {
        ...message,
        orderId: order.orderId,
        payload: { ...message.payload, orderId: order.orderId },
      }
    if (
      message.type === "status_update" &&
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
