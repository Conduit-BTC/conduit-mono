import type { OrderViewModel } from "./order-view"

export interface CheckoutSparkSettledRouteSession {
  readonly enabled: boolean
  readonly mounted: boolean
  readonly visible: boolean
  readonly actionsReady: boolean
  readonly identityCurrent: boolean
  readonly orderId: string
  readonly view: Pick<
    OrderViewModel,
    "orderId" | "phase" | "merchantStatus" | "checkoutSparkRouted"
  >
}

/**
 * Foreground permission only; completed commerce is not router completion.
 * The runner reloads exact payout authority, including the native-only exception.
 */
export function canContinueCheckoutSparkSettledRouteSession(
  input: CheckoutSparkSettledRouteSession
): boolean {
  return (
    input.enabled &&
    input.mounted &&
    input.visible &&
    input.actionsReady &&
    input.identityCurrent &&
    input.view.orderId === input.orderId &&
    input.view.phase !== "cancelled" &&
    input.view.merchantStatus !== "cancelled" &&
    input.view.merchantStatus !== "refund_requested" &&
    input.view.checkoutSparkRouted === true
  )
}
