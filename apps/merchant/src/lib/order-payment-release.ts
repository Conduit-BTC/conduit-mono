import {
  getNdk,
  publishMerchantOrderMessage,
  type MerchantOrderDelivery,
  type OrderSchema,
} from "@conduit/core"
import {
  eventMarketHandoffDeliveryNeedsRetry,
  issueOrganizerReadyReceipt,
} from "./event-market-handoff"
import { verifyAndCheckpointMerchantPickupOrderAuthorization } from "./order-pickup-authority-checkpoint"

export interface MerchantPaymentConfirmationInput {
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
  delivery: MerchantOrderDelivery
  order: OrderSchema | null
  /** Separate, explicit readiness and organizer-release consent. */
  authorizeOrganizerRelease: boolean
  /** Active authenticated account; never inferred from merchantPubkey. */
  authenticatedPubkey?: string | null
  /** Live account session authority for pickup-evidence reads. */
  shouldContinue?: () => boolean
}

export type MerchantOrganizerPickupReadyInput = Pick<
  MerchantPaymentConfirmationInput,
  | "merchantPubkey"
  | "buyerPubkey"
  | "orderId"
  | "delivery"
  | "authenticatedPubkey"
  | "shouldContinue"
>

/**
 * Notify the buyer only after the exact organizer receipt has been delivered.
 * This signed merchant status is presentation authority for pickup readiness;
 * it does not replace settlement evidence.
 */
export async function publishMerchantOrganizerPickupReady(
  input: MerchantOrganizerPickupReadyInput,
  publish: typeof publishMerchantOrderMessage = publishMerchantOrderMessage
): Promise<void> {
  await publish({
    merchantPubkey: input.merchantPubkey,
    buyerPubkey: input.buyerPubkey,
    orderId: input.orderId,
    type: "status_update",
    tags: [["status", "ready_for_pickup"]],
    payload: { status: "ready_for_pickup" },
    delivery: input.delivery,
    signerInteraction: "external",
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
  })
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
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
    })
  },
  async release(input) {
    if (!input.order) throw new Error("The authenticated order is unavailable.")
    const authorization =
      await verifyAndCheckpointMerchantPickupOrderAuthorization({
        orderId: input.orderId,
        items: input.order.items,
        merchantPubkey: input.merchantPubkey,
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
      })
    if (authorization.status !== "verified") {
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
      market: authorization.market,
      signer,
      transport: {
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
      },
    })
    if (eventMarketHandoffDeliveryNeedsRetry(delivery)) {
      return "needs_attention"
    }
    await publishMerchantOrganizerPickupReady(input)
    return "delivered"
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
  const { shouldContinue, ...snapshot } = input
  const captured: MerchantPaymentConfirmationInput = {
    ...structuredClone(snapshot),
    shouldContinue,
  }
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
