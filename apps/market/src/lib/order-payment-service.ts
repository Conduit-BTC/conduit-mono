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
  isGuestOrderDataExpired,
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
import {
  isAnonZapAuthorizationError,
  signCheckoutZapRequestWithAnonSigner,
} from "./anon-zap-signer"
import {
  buildPaymentProofRumor,
  getDeliveryNotice,
  publishBuyerOrderMessage,
  type BuyerOrderSigningIdentity,
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

export function shouldFallbackAnonZapToPrivate(input: {
  visibility: "public_zap" | "private_checkout"
  publicZapSigner: "anon" | "shopper" | null
  lnurlAllowsNostr: boolean
  error?: unknown
}): boolean {
  if (input.visibility !== "public_zap" || input.publicZapSigner !== "anon") {
    return false
  }
  if (!input.lnurlAllowsNostr) return true
  return isAnonZapAuthorizationError(input.error)
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

const ZAP_RECEIPT_SCAN_MS = 5_000
const ZAP_RECEIPT_RESCAN_DELAY_MS = 10_000
const ZAP_RECEIPT_EXPIRY_GRACE_SECONDS = 10 * 60
const DEFAULT_INVOICE_EXPIRY_SECONDS = 60 * 60

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
  zapReceiptId?: string
  source: string
  note: string
  verificationState?:
    "buyer_evidence_received" | "needs_merchant_verification" | "verified"
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
    ...(input.zapReceiptId ? { zapReceiptId: input.zapReceiptId } : {}),
    source: input.source,
    proofDeliveryStatus: "pending",
    verification: {
      state: input.verificationState ?? "buyer_evidence_received",
      checks: [],
    },
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
    | "zapReceiptId"
  >,
  input: {
    source: string
    note: string
    action?: "zap" | "private_checkout" | "external_invoice"
    verificationState?:
      "buyer_evidence_received" | "needs_merchant_verification" | "verified"
  }
): string {
  return buildProofContentJson({
    orderId: lifecycle.orderId,
    action: input.action ?? getLifecyclePaymentProofAction(lifecycle),
    amountSats: lifecycle.totalSats,
    amountMsats: lifecycle.totalMsats,
    invoice: lifecycle.invoice ?? "",
    preimage: lifecycle.preimage,
    paymentHash: lifecycle.paymentHash,
    feeMsats: lifecycle.feeMsats,
    zapRequestId: lifecycle.zapRequestId,
    zapReceiptId: lifecycle.zapReceiptId,
    source: input.source,
    note: input.note,
    verificationState: input.verificationState,
  })
}

export function buildLifecycleResendProofContentJson(
  lifecycle: Parameters<typeof buildLifecyclePaymentProofContentJson>[0]
): string {
  const isExternalWalletReport = lifecycle.checkoutMode === "external_wallet"
  const isReceiptLinkedZap = !!(
    lifecycle.zapRequestId && lifecycle.zapReceiptId
  )

  return buildLifecyclePaymentProofContentJson(lifecycle, {
    ...(isReceiptLinkedZap
      ? {
          action: "zap" as const,
          source: "external",
          verificationState: "verified" as const,
          note: `Public zap receipt observed for order ${lifecycle.orderId}`,
        }
      : isExternalWalletReport
        ? {
            action: "external_invoice" as const,
            source: "external",
            verificationState: "needs_merchant_verification" as const,
            note: `External wallet payment for order ${lifecycle.orderId}`,
          }
        : {
            source: "buyer",
            note: `Payment for order ${lifecycle.orderId}`,
          }),
  })
}

export interface OrderPaymentContext {
  orderId: string
  buyerPubkey: string
  buyerIdentity?: BuyerOrderSigningIdentity
  merchantPubkey: string
  merchantLud16: string | null
  zapMode: CheckoutZapMode
  zapContent: string
  totalSats: number
  totalMsats: number
  items: Array<{ productAddress: string; quantity: number }>
  walletConnection: NwcConnection | null
  tryNwc: boolean
  tryWebln?: boolean
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
const receiptObservers = new Set<string>()
const receiptRescanTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function canSubmitExternalPaymentReport(
  lifecycle: OrderLifecycle | null | undefined
): lifecycle is OrderLifecycle {
  return (
    lifecycle?.checkoutMode === "external_wallet" &&
    !!lifecycle.invoice &&
    lifecycle.paymentStatus === "manual_required" &&
    lifecycle.proofDeliveryStatus === "not_started"
  )
}

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

function clearReceiptRescan(orderId: string): void {
  const timer = receiptRescanTimers.get(orderId)
  if (timer) clearTimeout(timer)
  receiptRescanTimers.delete(orderId)
}

function hasPublicReceiptContext(
  lifecycle: OrderLifecycle
): lifecycle is OrderLifecycle & {
  invoice: string
  zapRequestId: string
  zapRequestCreatedAt: number
  zapLnurl: string
  zapReceiptPubkey: string
  zapReceiptRelayUrls: string[]
  zapReceiptObservationDeadline: number
} {
  const publicZapSigner =
    lifecycle.publicZapSigner ?? getOrderPublicZapSigner(lifecycle.checkoutMode)
  return (
    publicZapSigner === "anon" &&
    !!lifecycle.invoice &&
    !!lifecycle.zapRequestId &&
    Number.isSafeInteger(lifecycle.zapRequestCreatedAt) &&
    lifecycle.zapRequestCreatedAt! > 0 &&
    !!lifecycle.zapLnurl &&
    !!lifecycle.zapReceiptPubkey &&
    Array.isArray(lifecycle.zapReceiptRelayUrls) &&
    lifecycle.zapReceiptRelayUrls.length > 0 &&
    Number.isSafeInteger(lifecycle.zapReceiptObservationDeadline) &&
    lifecycle.zapReceiptObservationDeadline! > 0
  )
}

export function canObserveOrderPublicZapReceipt(
  lifecycle: OrderLifecycle,
  nowMs = Date.now()
): boolean {
  if (!hasPublicReceiptContext(lifecycle)) return false
  if (isGuestOrderDataExpired(lifecycle, nowMs)) return false
  if (
    lifecycle.zapReceiptStatus === "observed" &&
    lifecycle.proofDeliveryStatus === "sent"
  ) {
    return false
  }
  return (
    lifecycle.zapReceiptStatus === "waiting" ||
    lifecycle.zapReceiptStatus === "receipt_not_observed" ||
    lifecycle.zapReceiptStatus === "observed"
  )
}

async function deliverReceiptLinkedProof(
  lifecycle: OrderLifecycle & {
    invoice: string
    zapRequestId: string
    zapRequestCreatedAt: number
    zapReceiptId: string
  },
  buyerIdentity?: BuyerOrderSigningIdentity
): Promise<void> {
  if (lifecycle.proofDeliveryStatus === "sent") return

  const locked = await patchOrderLifecycle(lifecycle.orderId, {
    proofDeliveryStatus: "pending",
  })
  if (!locked || locked.proofDeliveryStatus !== "pending") return

  const content = buildLifecyclePaymentProofContentJson(locked, {
    action: "zap",
    source: "external",
    verificationState: "verified",
    note: `Public zap receipt observed for order ${lifecycle.orderId}`,
  })
  const ndk = getNdk()
  const proofRumor = buildPaymentProofRumor({
    merchantPubkey: locked.merchantPubkey,
    orderId: locked.orderId,
    amountSats: locked.totalSats,
    currency: "SATS",
    content,
    createdAt: locked.zapRequestCreatedAt,
  })

  try {
    await publishBuyerOrderMessage(
      proofRumor,
      ndk,
      locked.merchantPubkey,
      buyerIdentity ?? locked.buyerPubkey
    )
    await updatePaymentAttempt(locked.orderId, {
      proofDeliveryStatus: "sent",
    }).catch(() => {})
    await patchAndEmit(locked.orderId, {
      proofDeliveryStatus: "sent",
    })
  } catch {
    await updatePaymentAttempt(locked.orderId, {
      proofDeliveryStatus: "retry_needed",
    }).catch(() => {})
    await patchAndEmit(locked.orderId, {
      proofDeliveryStatus: "retry_needed",
    })
  }
}

export async function observeOrderPublicZapReceipt(
  orderId: string,
  buyerIdentity?: BuyerOrderSigningIdentity
): Promise<void> {
  if (receiptObservers.has(orderId)) return
  receiptObservers.add(orderId)
  clearReceiptRescan(orderId)
  let scheduleRescan = false

  try {
    const lifecycle = await getOrderLifecycle(orderId)
    if (!lifecycle || !canObserveOrderPublicZapReceipt(lifecycle)) return
    if (!hasPublicReceiptContext(lifecycle)) return

    if (lifecycle.zapReceiptStatus === "observed" && lifecycle.zapReceiptId) {
      await deliverReceiptLinkedProof(
        lifecycle as typeof lifecycle & {
          invoice: string
          zapRequestId: string
          zapReceiptId: string
        },
        buyerIdentity
      )
      return
    }

    const nowMs = Date.now()
    const beforeDeadline = nowMs < lifecycle.zapReceiptObservationDeadline
    const timeoutMs = beforeDeadline
      ? Math.min(
          ZAP_RECEIPT_SCAN_MS,
          lifecycle.zapReceiptObservationDeadline - nowMs
        )
      : 0
    const receipt = await waitForZapReceipt({
      zapRequestId: lifecycle.zapRequestId,
      requestCreatedAt: lifecycle.zapRequestCreatedAt,
      recipientPubkey: lifecycle.merchantPubkey,
      expectedAmountMsats: lifecycle.totalMsats,
      expectedLnurl: lifecycle.zapLnurl,
      expectedInvoice: lifecycle.invoice,
      lnurlNostrPubkey: lifecycle.zapReceiptPubkey,
      relayUrls: lifecycle.zapReceiptRelayUrls,
      receiptNotAfterSeconds: Math.floor(
        lifecycle.zapReceiptObservationDeadline / 1000
      ),
      timeoutMs,
    }).catch(() => null)

    if (receipt) {
      const shouldDeliverProof = lifecycle.proofDeliveryStatus !== "sent"
      try {
        await savePaymentAttempt({
          id: orderId,
          orderId,
          buyerPubkey: lifecycle.buyerPubkey,
          merchantPubkey: lifecycle.merchantPubkey,
          amountMsats: lifecycle.totalMsats,
          currency: "SATS",
          invoice: lifecycle.invoice,
          zapRequestId: lifecycle.zapRequestId,
          zapReceiptId: receipt.id,
          proofDeliveryStatus: shouldDeliverProof ? "pending" : "sent",
          createdAt: lifecycle.createdAt,
          updatedAt: Date.now(),
        })
      } catch {
        // Lifecycle persistence remains authoritative for this local flow.
      }
      const updated = await patchOrderLifecycle(orderId, {
        invoiceStatus: "received",
        paymentStatus: "paid",
        zapReceiptStatus: "observed",
        zapReceiptId: receipt.id,
        lastError: undefined,
      })
      emit(orderId, { lifecycle: updated ?? null })
      if (updated && shouldDeliverProof && hasPublicReceiptContext(updated)) {
        await deliverReceiptLinkedProof(
          updated as typeof updated & {
            zapReceiptId: string
          },
          buyerIdentity
        )
      }
      return
    }

    if (Date.now() >= lifecycle.zapReceiptObservationDeadline) {
      await patchAndEmit(orderId, {
        ...(lifecycle.paymentStatus === "paid"
          ? {}
          : { paymentStatus: "ambiguous" as const }),
        zapReceiptStatus: "receipt_not_observed",
        ...(lifecycle.paymentStatus === "paid"
          ? {}
          : {
              lastError:
                "A matching public receipt was not observed. Do not pay again if your wallet shows payment.",
            }),
      })
      return
    }
    scheduleRescan = true
  } catch {
    scheduleRescan = true
  } finally {
    receiptObservers.delete(orderId)
    if (
      scheduleRescan &&
      typeof window !== "undefined" &&
      !receiptRescanTimers.has(orderId)
    ) {
      const timer = setTimeout(() => {
        receiptRescanTimers.delete(orderId)
        void observeOrderPublicZapReceipt(orderId, buyerIdentity)
      }, ZAP_RECEIPT_RESCAN_DELAY_MS)
      receiptRescanTimers.set(orderId, timer)
    }
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
      let visibility = getCheckoutZapVisibility(ctx.zapMode)
      const publicZapSigner = getOrderPublicZapSigner(ctx.zapMode)
      if (
        ctx.totalMsats < lnurlMeta.minSendable ||
        ctx.totalMsats > lnurlMeta.maxSendable
      ) {
        throw new Error(
          `Order amount (${ctx.totalMsats} msats) is outside merchant's accepted range ` +
            `(${lnurlMeta.minSendable}-${lnurlMeta.maxSendable} msats).`
        )
      }

      const requestInvoice = (requestedVisibility: typeof visibility) =>
        requestCheckoutLnurlInvoice(
          {
            visibility: requestedVisibility,
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
                return signCheckoutZapRequestWithAnonSigner(draft, {
                  merchantPubkey: ctx.merchantPubkey,
                  amountMsats: ctx.totalMsats,
                  items: ctx.items,
                })
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

      let publicZapFallback = false
      let invoiceRequest: Awaited<
        ReturnType<typeof requestCheckoutLnurlInvoice>
      >
      if (
        shouldFallbackAnonZapToPrivate({
          visibility,
          publicZapSigner,
          lnurlAllowsNostr: lnurlMeta.allowsNostr,
        })
      ) {
        visibility = "private_checkout"
        publicZapFallback = true
        invoiceRequest = await requestInvoice(visibility)
      } else {
        try {
          invoiceRequest = await requestInvoice(visibility)
        } catch (error) {
          if (
            !shouldFallbackAnonZapToPrivate({
              visibility,
              publicZapSigner,
              lnurlAllowsNostr: lnurlMeta.allowsNostr,
              error,
            })
          ) {
            throw error
          }
          visibility = "private_checkout"
          publicZapFallback = true
          invoiceRequest = await requestInvoice(visibility)
        }
      }
      if (publicZapFallback) {
        await patchAndEmit(orderId, {
          checkoutMode: "external_wallet",
          publicZapSigner: undefined,
          publicZapFallback: true,
          zapReceiptStatus: "not_applicable",
        })
      }
      const isPublicZap = visibility === "public_zap"
      const {
        invoice,
        zapRelayUrls,
        zapRequestId,
        zapRequestCreatedAt,
        expectedLnurl,
        lnurlNostrPubkey,
      } = invoiceRequest

      const invoiceValidation = validateLightningInvoiceForPayment({
        invoice,
        expectedAmountMsats: ctx.totalMsats,
      })
      if (!invoiceValidation.ok) throw new Error(invoiceValidation.reason)
      const nowSeconds = Math.floor(Date.now() / 1000)
      const invoiceExpiresAt =
        invoiceValidation.metadata.expiresAt ??
        nowSeconds + DEFAULT_INVOICE_EXPIRY_SECONDS
      const zapReceiptObservationDeadline =
        (invoiceExpiresAt + ZAP_RECEIPT_EXPIRY_GRACE_SECONDS) * 1000

      await patchAndEmit(
        orderId,
        {
          invoiceStatus: "received",
          invoice,
          zapRequestId,
          ...(isPublicZap
            ? {
                zapRequestCreatedAt,
                zapReceiptRelayUrls: zapRelayUrls,
                zapLnurl: expectedLnurl,
                zapReceiptPubkey: lnurlNostrPubkey,
                invoiceExpiresAt,
                zapReceiptObservationDeadline,
                zapReceiptStatus: "waiting" as const,
              }
            : {}),
        },
        { stage: "paying_invoice" }
      )

      const payResult = await payCheckoutInvoice({
        invoice,
        amountMsats: ctx.totalMsats,
        walletConnection: ctx.walletConnection,
        tryNwc: ctx.tryNwc,
        tryWebln: ctx.tryWebln,
        timeoutMs: 60_000,
        appId: "market",
        metadata: {
          app: "conduit-market",
          action: isPublicZap ? "checkout-zap" : "private-checkout",
          amountMsats: ctx.totalMsats,
        },
      })

      if (payResult.status === "manual_required") {
        // No automatic rail. Private invoices retain the buyer-attested report
        // flow. Public anon-zap invoices are observed by exact NIP-57 receipt
        // context instead, so the buyer never needs a manual confirmation step.
        await patchAndEmit(
          orderId,
          {
            invoiceStatus: "manual_required",
            paymentStatus: "manual_required",
            invoice,
            zapReceiptStatus: isPublicZap ? "waiting" : "not_applicable",
            lastError: isPublicZap ? undefined : payResult.reason,
          },
          { running: false, stage: null }
        )
        if (isPublicZap && zapRequestId) {
          void observeOrderPublicZapReceipt(orderId, ctx.buyerIdentity)
        }
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
        const proofDelivery = await publishBuyerOrderMessage(
          proofRumor,
          ndk,
          ctx.merchantPubkey,
          ctx.buyerIdentity ?? ctx.buyerPubkey
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
        void observeOrderPublicZapReceipt(orderId, ctx.buyerIdentity)
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
  orderId: string,
  buyerIdentity?: BuyerOrderSigningIdentity
): Promise<OrderPaymentRuntimeState | undefined> {
  const lifecycle = await getOrderLifecycle(orderId)
  if (!lifecycle || lifecycle.paymentStatus !== "paid" || !lifecycle.invoice) {
    return runtimeStates.get(orderId)
  }
  const content = buildLifecycleResendProofContentJson(lifecycle)
  const ndk = getNdk()
  const proofRumor = buildPaymentProofRumor({
    merchantPubkey: lifecycle.merchantPubkey,
    orderId,
    amountSats: lifecycle.totalSats,
    currency: "SATS",
    content,
    createdAt:
      lifecycle.zapRequestId && lifecycle.zapReceiptId
        ? lifecycle.zapRequestCreatedAt
        : undefined,
  })
  await patchAndEmit(orderId, { proofDeliveryStatus: "pending" })
  try {
    await publishBuyerOrderMessage(
      proofRumor,
      ndk,
      lifecycle.merchantPubkey,
      buyerIdentity ?? lifecycle.buyerPubkey
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
  orderId: string,
  buyerIdentity?: BuyerOrderSigningIdentity
): Promise<OrderPaymentRuntimeState | undefined> {
  if (inFlight.has(orderId)) return runtimeStates.get(orderId)
  inFlight.add(orderId)
  try {
    const lifecycle = await getOrderLifecycle(orderId)
    if (!canSubmitExternalPaymentReport(lifecycle)) {
      return runtimeStates.get(orderId)
    }

    await patchAndEmit(orderId, {
      paymentStatus: "paid",
      proofDeliveryStatus: "pending",
    })

    const content = buildLifecyclePaymentProofContentJson(lifecycle, {
      action: "external_invoice",
      source: "external",
      verificationState: "needs_merchant_verification",
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
      await publishBuyerOrderMessage(
        proofRumor,
        ndk,
        lifecycle.merchantPubkey,
        buyerIdentity ?? lifecycle.buyerPubkey
      )
      await patchAndEmit(orderId, { proofDeliveryStatus: "sent" })
    } catch (e) {
      await patchAndEmit(orderId, {
        proofDeliveryStatus: "retry_needed",
        lastError: e instanceof Error ? e.message : "Proof delivery failed",
      })
    }
    return runtimeStates.get(orderId)
  } finally {
    inFlight.delete(orderId)
  }
}
