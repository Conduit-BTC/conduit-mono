import type { OrderSchema } from "./schemas"

export type CommerceGmvEstimateInput = {
  orderId: string
  orderCreatedAt: number
  invoicedAmountSats: number
}

type CommerceGmvFetch = (input: string, init: RequestInit) => Promise<Response>

type CommerceGmvEstimateOptions = {
  fetchImpl?: CommerceGmvFetch
  hostname?: string
}

export function getCommerceGmvEstimateFromOrder(input: {
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
  order: Pick<
    OrderSchema,
    | "id"
    | "buyerPubkey"
    | "merchantPubkey"
    | "createdAt"
    | "subtotal"
    | "currency"
  >
}): CommerceGmvEstimateInput | null {
  const currency = input.order.currency.trim().toUpperCase()
  if (
    input.order.id !== input.orderId ||
    input.order.buyerPubkey !== input.buyerPubkey ||
    input.order.merchantPubkey !== input.merchantPubkey ||
    (currency !== "SAT" && currency !== "SATS")
  ) {
    return null
  }
  const estimate = {
    orderId: input.orderId,
    orderCreatedAt: input.order.createdAt,
    invoicedAmountSats: input.order.subtotal,
  }
  return isCommerceGmvEstimateInput(estimate) ? estimate : null
}

const ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isCommerceGmvEstimateInput(
  input: CommerceGmvEstimateInput
): boolean {
  const orderDate = new Date(input.orderCreatedAt)
  return (
    ORDER_ID_PATTERN.test(input.orderId) &&
    Number.isSafeInteger(input.orderCreatedAt) &&
    input.orderCreatedAt > 0 &&
    Number.isFinite(orderDate.getTime()) &&
    Number.isSafeInteger(input.invoicedAmountSats) &&
    input.invoicedAmountSats > 0
  )
}

/** Reporting is paused independently of browser configuration and GPC. */
export async function reportCommerceGmvEstimate(
  input: CommerceGmvEstimateInput,
  options: CommerceGmvEstimateOptions = {}
): Promise<boolean> {
  void input
  void options
  return false
}

export function __resetCommerceGmvEstimateSessionForTests(): void {
  // No reporting state remains during the telemetry pause.
}
