import { getOrderLifecycle } from "@conduit/core"
import type { OrderPaymentAddressUpdate } from "./order-payment-address"
import { hasCheckoutPaymentProgress } from "./checkout-order-attempt"
import { assertLegacyOrderPaymentAllowed } from "./checkout-spark-order-admission"
import {
  runOrderPayment,
  runOrderPaymentWithUpdatedAddress,
  type OrderPaymentContext,
  type OrderPaymentDependencies,
} from "./order-payment-service"

/** Continue the delivered order through the payment service's durable admission checks. */
export async function runOrderRetryPayment(
  context: OrderPaymentContext,
  update?: OrderPaymentAddressUpdate,
  dependencies: Partial<OrderPaymentDependencies> = {}
) {
  const readOrder = dependencies.getOrderLifecycle ?? getOrderLifecycle
  const lifecycle = await readOrder(context.orderId)
  assertLegacyOrderPaymentAllowed(lifecycle)
  if (
    context.zapMode === "anonymous_public_zap" &&
    lifecycle &&
    hasCheckoutPaymentProgress(lifecycle)
  ) {
    throw new Error(
      "Anonymous public zaps have been retired. Use the private-invoice recovery option for this order."
    )
  }
  // Preserve the saved mode through admission. The payment service converts an
  // unstarted anonymous attempt to a private invoice under its payment claim.
  return update
    ? runOrderPaymentWithUpdatedAddress(context, update, dependencies)
    : runOrderPayment(context, dependencies)
}
