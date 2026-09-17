import { getOfficialProductTelemetryApp } from "./telemetry-contract"
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

const COMMERCE_GMV_ENDPOINT = "https://e.conduit.market/gmv"
const ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const reportedOrders = new Set<string>()
const inFlightReports = new Map<string, Promise<boolean>>()

export function isCommerceGmvEstimateInput(
  input: CommerceGmvEstimateInput
): boolean {
  return (
    ORDER_ID_PATTERN.test(input.orderId) &&
    Number.isSafeInteger(input.orderCreatedAt) &&
    input.orderCreatedAt > 0 &&
    Number.isSafeInteger(input.invoicedAmountSats) &&
    input.invoicedAmountSats > 0
  )
}

/**
 * Best-effort, aggregate-only GMV reporting. Every qualifying commerce signal
 * may call this function; the Worker turns the shared order UUID into the one
 * opaque PostHog event UUID that deduplicates those attempts.
 */
export async function reportCommerceGmvEstimate(
  input: CommerceGmvEstimateInput,
  options: CommerceGmvEstimateOptions = {}
): Promise<boolean> {
  if (!isCommerceGmvEstimateInput(input)) return false
  const hostname =
    options.hostname ??
    (typeof window === "undefined" ? "" : window.location.hostname)
  if (!getOfficialProductTelemetryApp(hostname)) return false

  const orderId = input.orderId.toLowerCase()
  if (reportedOrders.has(orderId)) return true
  const existing = inFlightReports.get(orderId)
  if (existing) return existing

  const fetchImpl =
    options.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init))
  const request = (async () => {
    try {
      const response = await fetchImpl(COMMERCE_GMV_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          orderId,
          orderCreatedAt: input.orderCreatedAt,
          invoicedAmountSats: input.invoicedAmountSats,
        }),
        cache: "no-store",
        credentials: "omit",
        keepalive: true,
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(5_500),
      })
      const accepted = response.ok
      await response.body?.cancel()
      if (accepted) reportedOrders.add(orderId)
      return accepted
    } catch {
      return false
    } finally {
      inFlightReports.delete(orderId)
    }
  })()

  inFlightReports.set(orderId, request)
  return request
}

export function __resetCommerceGmvEstimateSessionForTests(): void {
  reportedOrders.clear()
  inFlightReports.clear()
}
