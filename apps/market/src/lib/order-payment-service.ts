import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildLightningPaymentProofMessage,
  config,
  fetchLnurlInvoice,
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  getOrderPublicZapSigner,
  getNdk,
  getOrderLifecycle,
  patchOrderLifecycle,
  signNdkEventWithTransientNip07Retry,
  validateLightningInvoiceForPayment,
  waitForZapReceipt,
  type NwcConnection,
  type OrderLifecycle,
} from "@conduit/core"
import {
  getCheckoutZapVisibility,
  requestCheckoutLnurlInvoice,
  type CheckoutPaymentStage,
  type CheckoutZapMode,
  type CheckoutZapRequestDraft,
  type SignedCheckoutZapRequest,
} from "./checkout-payment"
import { signCheckoutZapRequestWithAnonSigner } from "./anon-zap-signer"
import {
  buildPaymentProofRumor,
  getDeliveryNotice,
  publishWrappedToMerchantAndSelf,
} from "./order-publish"
import { payCheckoutInvoice } from "./payment-rails"
import { savePaymentAttempt, updatePaymentAttempt } from "./payment-attempts"

export function getLifecyclePaymentProofAction(
  lifecycle: Pick<OrderLifecycle, "checkoutMode" | "publicZapSigner">
): "zap" | "private_checkout" {
  const publicZapSigner =
    lifecycle.publicZapSigner ?? getOrderPublicZapSigner(lifecycle.checkoutMode)
  return publicZapSigner ? "zap" : "private_checkout"
}

/**
 * Route-independent order payment lifecycle service (CND-122).
 *
 * Owns the *payment half* of fast checkout — LNURL → invoice → pay → proof —
 * for an order that has ALREADY been delivered to the merchant. Because it lives
 * outside React, checkout can publish the order, create the durable lifecycle
 * record, and navigate straight to `/orders?order=<id>` while this service runs
 * the payment to completion in the background. Every transition is written to
 * the durable `orderLifecycles` record, so the Orders page renders live progress
 * (and survives a reload mid-flight).
 *
 * It NEVER publishes an order. Retrying after a post-delivery / pre-payment
 * failure continues the same `orderId` (idempotent), so it cannot create a
 * duplicate merchant order.
 *
 * Privacy: invoice/preimage/payment-hash live only in the local lifecycle
 * record and the proof DM. Nothing here is forwarded to telemetry.
 */

const ZAP_RECEIPT_WAIT_MS = 5_000

/**
 * Build a payment-proof content payload directly (matches the permissive
 * `paymentProofMessageSchema` the merchant parses). Used by the resend and
 * external-wallet paths, where a preimage may be absent and the verified
 * builder (which requires one) does not apply.
 */
function buildProofContentJson(input: {
  orderId: string
  action: "zap" | "private_checkout" | "external_invoice"
  amountSats: number
  amountMsats: number
  invoice: string
  preimage?: string
  paymentHash?: string
  feeMsats?: number
  zapRequestId?: string
  source: string
  note: string
}): string {
  return JSON.stringify({
    version: 1,
    orderId: input.orderId,
    rail: "lightning",
    action: input.action,
    amount: input.amountSats,
    amountMsats: input.amountMsats,
    currency: "SATS",
    invoice: input.invoice,
    ...(input.preimage ? { preimage: input.preimage } : {}),
    ...(input.paymentHash ? { paymentHash: input.paymentHash } : {}),
    ...(typeof input.feeMsats === "number" ? { feeMsats: input.feeMsats } : {}),
    ...(input.zapRequestId ? { zapRequestId: input.zapRequestId } : {}),
    source: input.source,
    proofDeliveryStatus: "pending",
    verification: { state: "buyer_evidence_received", checks: [] },
    note: input.note,
  })
}

export function buildLifecyclePaymentProofContentJson(
  lifecycle: Pick<
    OrderLifecycle,
    | "orderId"
    | "checkoutMode"
    | "publicZapSigner"
    | "totalSats"
    | "totalMsats"
    | "invoice"
    | "preimage"
    | "paymentHash"
    | "feeMsats"
    | "zapRequestId"
  >,
  input: { source: string; note: string }
): string {
  return buildProofContentJson({
    orderId: lifecycle.orderId,
    action: getLifecyclePaymentProofAction(lifecycle),
    amountSats: lifecycle.totalSats,
    amountMsats: lifecycle.totalMsats,
    invoice: lifecycle.invoice ?? "",
    preimage: lifecycle.preimage,
    paymentHash: lifecycle.paymentHash,
    feeMsats: lifecycle.feeMsats,
    zapRequestId: lifecycle.zapRequestId,
    source: input.source,
    note: input.note,
  })
}

export interface OrderPaymentContext {
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
  merchantLud16: string | null
  zapMode: CheckoutZapMode
  zapContent: string
  totalSats: number
  totalMsats: number
  walletConnection: NwcConnection | null
  tryNwc: boolean
}

export interface OrderPaymentRuntimeState {
  orderId: string
  running: boolean
  stage: CheckoutPaymentStage | null
  error: string | null
  lifecycle: OrderLifecycle | null
}

function isAmbiguousPaymentError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /Check your wallet before trying another payment path\./i.test(
    error.message
  )
}

type Listener = (state: OrderPaymentRuntimeState) => void

const runtimeStates = new Map<string, OrderPaymentRuntimeState>()
const listeners = new Map<string, Set<Listener>>()
/** Guards against concurrent payment attempts for the same order. */
const inFlight = new Set<string>()

function emit(orderId: string, partial: Partial<OrderPaymentRuntimeState>) {
  const prev =
    runtimeStates.get(orderId) ??
    ({
      orderId,
      running: false,
      stage: null,
      error: null,
      lifecycle: null,
    } satisfies OrderPaymentRuntimeState)
  const next: OrderPaymentRuntimeState = { ...prev, ...partial, orderId }
  runtimeStates.set(orderId, next)
  const set = listeners.get(orderId)
  if (set) for (const fn of set) fn(next)
}

async function patchAndEmit(
  orderId: string,
  patch: Parameters<typeof patchOrderLifecycle>[1],
  runtime?: Partial<OrderPaymentRuntimeState>
) {
  const lifecycle = await patchOrderLifecycle(orderId, patch)
  emit(orderId, { ...runtime, lifecycle: lifecycle ?? null })
}

export function getOrderPaymentState(
  orderId: string
): OrderPaymentRuntimeState | undefined {
  return runtimeStates.get(orderId)
}

export function isOrderPaymentRunning(orderId: string): boolean {
  return inFlight.has(orderId)
}

export function subscribeOrderPayment(
  orderId: string,
  listener: Listener
): () => void {
  const set = listeners.get(orderId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(orderId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(orderId)
  }
}

/**
 * Run (or retry) payment for an already-delivered order. Resolves when the flow
 * reaches a terminal state — paid (+proof attempt), manual/external required, or
 * pre-payment failure. Safe to call again after a failure: it continues the same
 * order and never republishes it.
 */
export async function runOrderPayment(
  ctx: OrderPaymentContext
): Promise<OrderPaymentRuntimeState> {
  const { orderId } = ctx
  if (inFlight.has(orderId)) {
    return (
      runtimeStates.get(orderId) ?? {
        orderId,
        running: true,
        stage: null,
        error: null,
        lifecycle: null,
      }
    )
  }
  inFlight.add(orderId)

  try {
    if (!ctx.merchantLud16) {
      await patchAndEmit(
        orderId,
        {
          paymentStatus: "failed",
          lastError: "Merchant does not have a Lightning address.",
        },
        {
          running: false,
          stage: null,
          error: "Merchant does not have a Lightning address.",
        }
      )
      return runtimeStates.get(orderId)!
    }

    const currency = "SATS"
    let paymentMoved = false

    emit(orderId, { running: true, error: null, stage: "requesting_invoice" })
    await patchAndEmit(orderId, {
      invoiceStatus: "requesting",
      paymentStatus: "paying",
      lastError: undefined,
    })

    try {
      const ndk = getNdk()
      const lnurlMeta = await fetchLnurlPayMetadata(ctx.merchantLud16)
      const visibility = getCheckoutZapVisibility(ctx.zapMode)
      const publicZapSigner = getOrderPublicZapSigner(ctx.zapMode)
      const isPublicZap = visibility === "public_zap"
      if (isPublicZap && !lnurlMeta.allowsNostr) {
        throw new Error(
          "Merchant Lightning Address does not advertise Nostr zap support."
        )
      }
      if (
        ctx.totalMsats < lnurlMeta.minSendable ||
        ctx.totalMsats > lnurlMeta.maxSendable
      ) {
        throw new Error(
          `Order amount (${ctx.totalMsats} msats) is outside merchant's accepted range ` +
            `(${lnurlMeta.minSendable}-${lnurlMeta.maxSendable} msats).`
        )
      }

      const invoiceRequest = await requestCheckoutLnurlInvoice(
        {
          visibility,
          lnurlCallback: lnurlMeta.callback,
          amountMsats: ctx.totalMsats,
          lnurl: lnurlMeta.lnurl,
          recipientPubkey: ctx.merchantPubkey,
          zapContent: ctx.zapContent,
          explicitRelayUrls: ndk.explicitRelayUrls ?? [],
          zapRelayUrls: config.zapRelayUrls,
        },
        {
          fetchLnurlInvoice,
          fetchZapInvoice,
          signZapRequest: async (
            draft: CheckoutZapRequestDraft
          ): Promise<SignedCheckoutZapRequest> => {
            if (publicZapSigner === "anon") {
              return signCheckoutZapRequestWithAnonSigner(draft)
            }
            if (publicZapSigner !== "shopper") {
              throw new Error("Public zap signer was not selected.")
            }
            const zapRequest = new NDKEvent(ndk)
            zapRequest.kind = draft.kind
            zapRequest.created_at = draft.createdAt
            zapRequest.content = draft.content
            zapRequest.tags = draft.tags
            await signNdkEventWithTransientNip07Retry(zapRequest, ndk.signer)
            return { id: zapRequest.id, rawEvent: zapRequest.rawEvent() }
          },
        }
      )
      const { invoice, zapRelayUrls, zapRequestId } = invoiceRequest

      const invoiceValidation = validateLightningInvoiceForPayment({
        invoice,
        expectedAmountMsats: ctx.totalMsats,
      })
      if (!invoiceValidation.ok) throw new Error(invoiceValidation.reason)

      await patchAndEmit(
        orderId,
        { invoiceStatus: "received", invoice, zapRequestId },
        { stage: "paying_invoice" }
      )

      const payResult = await payCheckoutInvoice({
        invoice,
        amountMsats: ctx.totalMsats,
        walletConnection: ctx.walletConnection,
        tryNwc: ctx.tryNwc,
        timeoutMs: 60_000,
        appId: "market",
        metadata: {
          app: "conduit-market",
          action: isPublicZap ? "checkout-zap" : "private-checkout",
          amountMsats: ctx.totalMsats,
        },
      })

      if (payResult.status === "manual_required") {
        // No automatic rail. Surface the invoice on Orders for an external wallet
        // (CND-120). The order stays put; the buyer pays externally and sends a
        // receipt afterwards.
        await patchAndEmit(
          orderId,
          {
            invoiceStatus: "manual_required",
            paymentStatus: "manual_required",
            invoice,
            // We won't watch for a zap receipt on the external-wallet path, so
            // don't leave a public_zap order stuck in "waiting" (CND-120).
            zapReceiptStatus: "not_applicable",
            lastError: payResult.reason,
          },
          { running: false, stage: null }
        )
        return runtimeStates.get(orderId)!
      }

      paymentMoved = true
      try {
        await savePaymentAttempt({
          id: orderId,
          orderId,
          buyerPubkey: ctx.buyerPubkey,
          merchantPubkey: ctx.merchantPubkey,
          amountMsats: ctx.totalMsats,
          currency: "SATS",
          invoice,
          paymentHash: payResult.paymentHash,
          preimage: payResult.preimage,
          feeMsats: payResult.feeMsats,
          zapRequestId,
          proofDeliveryStatus: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      } catch (e) {
        console.warn("Failed to persist payment attempt", e)
      }

      await patchAndEmit(
        orderId,
        {
          paymentStatus: "paid",
          proofDeliveryStatus: "pending",
          invoice,
          paymentHash: payResult.paymentHash,
          preimage: payResult.preimage,
          feeMsats: payResult.feeMsats,
          zapRequestId,
        },
        { stage: "sending_receipt" }
      )

      const proofPayload = buildLightningPaymentProofMessage({
        orderId,
        action: isPublicZap ? "zap" : "private_checkout",
        amount: ctx.totalSats,
        amountMsats: ctx.totalMsats,
        currency,
        invoice,
        preimage: payResult.preimage,
        paymentHash: payResult.paymentHash,
        feeMsats: payResult.feeMsats,
        ...(zapRequestId ? { zapRequestId } : {}),
        source: payResult.rail,
        proofDeliveryStatus: "pending",
        note: `Payment for order ${orderId}`,
      })
      const proofRumor = buildPaymentProofRumor({
        merchantPubkey: ctx.merchantPubkey,
        orderId,
        amountSats: ctx.totalSats,
        currency,
        content: JSON.stringify(proofPayload),
      })

      let deliveryNotice: string | null = null
      try {
        const proofDelivery = await publishWrappedToMerchantAndSelf(
          proofRumor,
          ndk,
          ctx.merchantPubkey,
          ctx.buyerPubkey
        )
        deliveryNotice = getDeliveryNotice(proofDelivery, "Payment proof")
        await updatePaymentAttempt(orderId, {
          proofDeliveryStatus: "sent",
        }).catch((e) => console.warn("Failed to update proof status", e))
        await patchAndEmit(orderId, {
          proofDeliveryStatus: "sent",
          deliveryNotice: deliveryNotice ?? undefined,
        })
      } catch {
        await updatePaymentAttempt(orderId, {
          proofDeliveryStatus: "retry_needed",
        }).catch((e) => console.warn("Failed to mark proof retry", e))
        await patchAndEmit(orderId, { proofDeliveryStatus: "retry_needed" })
      }

      if (invoiceRequest.shouldWaitForZapReceipt && zapRequestId) {
        emit(orderId, { stage: "checking_receipt" })
        const receipt = await waitForZapReceipt({
          zapRequestId,
          recipientPubkey: ctx.merchantPubkey,
          expectedAmountMsats: ctx.totalMsats,
          expectedLnurl: lnurlMeta.lnurl,
          lnurlNostrPubkey: lnurlMeta.nostrPubkey,
          relayUrls: zapRelayUrls,
          timeoutMs: ZAP_RECEIPT_WAIT_MS,
        }).catch((e) => {
          console.warn("Failed to observe zap receipt", e)
          return null
        })
        if (receipt) {
          await updatePaymentAttempt(orderId, {
            zapReceiptId: receipt.id,
          }).catch((e) => console.warn("Failed to persist zap receipt id", e))
          await patchAndEmit(orderId, {
            zapReceiptStatus: "observed",
            zapReceiptId: receipt.id,
          })
        } else {
          await patchAndEmit(orderId, { zapReceiptStatus: "timed_out" })
        }
      }

      emit(orderId, { running: false, stage: null })
      return runtimeStates.get(orderId)!
    } catch (e) {
      const message = e instanceof Error ? e.message : "Payment failed"
      if (paymentMoved) {
        // Funds moved but a tail step threw — still terminal success for the
        // buyer; only the best-effort proof needs retry.
        await patchAndEmit(
          orderId,
          { paymentStatus: "paid", proofDeliveryStatus: "retry_needed" },
          { running: false, stage: null }
        )
      } else if (isAmbiguousPaymentError(e)) {
        await patchAndEmit(
          orderId,
          { paymentStatus: "ambiguous", lastError: message },
          { running: false, stage: null, error: message }
        )
      } else {
        await patchAndEmit(
          orderId,
          { paymentStatus: "failed", lastError: message },
          { running: false, stage: null, error: message }
        )
      }
      return runtimeStates.get(orderId)!
    }
  } finally {
    inFlight.delete(orderId)
  }
}

/**
 * Re-publish the payment proof for an order whose proof delivery is
 * `retry_needed`. Only valid after funds have moved (a stored payment attempt
 * exists); never re-pays.
 */
export async function resendOrderProof(
  orderId: string
): Promise<OrderPaymentRuntimeState | undefined> {
  const lifecycle = await getOrderLifecycle(orderId)
  if (!lifecycle || lifecycle.paymentStatus !== "paid" || !lifecycle.invoice) {
    return runtimeStates.get(orderId)
  }
  const content = buildLifecyclePaymentProofContentJson(lifecycle, {
    source: "buyer",
    note: `Payment for order ${orderId}`,
  })
  const ndk = getNdk()
  const proofRumor = buildPaymentProofRumor({
    merchantPubkey: lifecycle.merchantPubkey,
    orderId,
    amountSats: lifecycle.totalSats,
    currency: "SATS",
    content,
  })
  await patchAndEmit(orderId, { proofDeliveryStatus: "pending" })
  try {
    await publishWrappedToMerchantAndSelf(
      proofRumor,
      ndk,
      lifecycle.merchantPubkey,
      lifecycle.buyerPubkey
    )
    await updatePaymentAttempt(orderId, { proofDeliveryStatus: "sent" }).catch(
      () => {}
    )
    await patchAndEmit(orderId, { proofDeliveryStatus: "sent" })
  } catch (e) {
    await patchAndEmit(orderId, {
      proofDeliveryStatus: "retry_needed",
      lastError: e instanceof Error ? e.message : "Proof delivery failed",
    })
  }
  return runtimeStates.get(orderId)
}

/**
 * External-wallet path (CND-120): the buyer paid an invoice in an outside wallet
 * and reports it. We can't verify a preimage, so this records a buyer-attested
 * proof (`external_invoice`) and marks payment moved. The merchant verifies.
 */
export async function submitExternalPaymentProof(
  orderId: string
): Promise<OrderPaymentRuntimeState | undefined> {
  const lifecycle = await getOrderLifecycle(orderId)
  if (!lifecycle || !lifecycle.invoice) return runtimeStates.get(orderId)

  await patchAndEmit(orderId, {
    paymentStatus: "paid",
    proofDeliveryStatus: "pending",
  })

  const content = buildLifecyclePaymentProofContentJson(lifecycle, {
    source: "external",
    note: `External wallet payment for order ${orderId}`,
  })
  const ndk = getNdk()
  const proofRumor = buildPaymentProofRumor({
    merchantPubkey: lifecycle.merchantPubkey,
    orderId,
    amountSats: lifecycle.totalSats,
    currency: "SATS",
    content,
  })
  try {
    await publishWrappedToMerchantAndSelf(
      proofRumor,
      ndk,
      lifecycle.merchantPubkey,
      lifecycle.buyerPubkey
    )
    await patchAndEmit(orderId, { proofDeliveryStatus: "sent" })
  } catch (e) {
    await patchAndEmit(orderId, {
      proofDeliveryStatus: "retry_needed",
      lastError: e instanceof Error ? e.message : "Proof delivery failed",
    })
  }
  return runtimeStates.get(orderId)
}
