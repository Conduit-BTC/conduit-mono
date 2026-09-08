import {
  getNdk,
  publishMerchantOrderMessage,
  type EventMarketResolution,
  type MerchantOrderDelivery,
  type OrderSchema,
} from "@conduit/core"
import {
  eventMarketHandoffDeliveryNeedsRetry,
  issueOrganizerReadyReceipt,
} from "./event-market-handoff"
import { verifyMerchantPickupOrderAuthorization } from "./order-pickup-authorization"

export interface MerchantPaymentConfirmationInput {
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
  delivery: MerchantOrderDelivery
  order: OrderSchema | null
  /** Separate, explicit readiness and organizer-release consent. */
  authorizeOrganizerRelease: boolean
}

type ReleaseResult = "delivered" | "needs_attention"
interface PaymentConfirmationDependencies {
  publishPaid(input: MerchantPaymentConfirmationInput): Promise<void>
  release(input: MerchantPaymentConfirmationInput): Promise<ReleaseResult>
}

const defaults: PaymentConfirmationDependencies = {
  async publishPaid(input) {
    await publishMerchantOrderMessage({
      merchantPubkey: input.merchantPubkey,
      buyerPubkey: input.buyerPubkey,
      orderId: input.orderId,
      type: "status_update",
      tags: [["status", "paid"]],
      payload: { status: "paid" },
      delivery: input.delivery,
      signerInteraction: "external",
    })
  },
  async release(input) {
    if (!input.order) throw new Error("The authenticated order is unavailable.")
    let market: EventMarketResolution | null = null
    const authorization = await verifyMerchantPickupOrderAuthorization({
      items: input.order.items,
      merchantPubkey: input.merchantPubkey,
      onVerifiedMarket: (verified) => {
        market = verified
      },
    })
    if (authorization.status !== "verified" || !market) {
      throw new Error("Current signed pickup evidence is unavailable.")
    }
    const signer = getNdk().signer
    if (!signer) throw new Error("Merchant signer is not connected.")
    const delivery = await issueOrganizerReadyReceipt({
      merchantPubkey: input.merchantPubkey,
      order: input.order,
      // The paid transition succeeded, and readiness consent was captured
      // separately. Do not depend on a not-yet-refreshed UI payment projection.
      paymentAuthenticated: true,
      authorizationConfirmed: input.authorizeOrganizerRelease,
      market,
      signer,
    })
    return eventMarketHandoffDeliveryNeedsRetry(delivery)
      ? "needs_attention"
      : "delivered"
  },
}

/** Confirm settlement; optionally release an explicitly prepared order.
 * These are separate signed operations, not an atomic transaction. A receipt
 * failure must not erase payment confirmation or invite payment to be repeated.
 */
export async function confirmMerchantPayment(
  input: MerchantPaymentConfirmationInput,
  dependencies: PaymentConfirmationDependencies = defaults
): Promise<{
  payment: "confirmed"
  release: "not_requested" | ReleaseResult
}> {
  const captured = structuredClone(input)
  if (
    captured.authorizeOrganizerRelease &&
    (!captured.order ||
      captured.order.id !== captured.orderId ||
      captured.order.merchantPubkey !== captured.merchantPubkey ||
      captured.order.buyerPubkey !== captured.buyerPubkey)
  ) {
    throw new Error("Release must refer to the exact captured order.")
  }
  await dependencies.publishPaid(captured)
  if (!captured.authorizeOrganizerRelease) {
    return { payment: "confirmed", release: "not_requested" }
  }
  try {
    return {
      payment: "confirmed",
      release: await dependencies.release(captured),
    }
  } catch {
    // The existing receipt outbox preserves any signed wraps for exact retry.
    // Do not expose transport errors/private data or roll back the paid state.
    return { payment: "confirmed", release: "needs_attention" }
  }
}
