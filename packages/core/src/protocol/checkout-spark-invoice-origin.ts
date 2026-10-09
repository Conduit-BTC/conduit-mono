import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  assertCheckoutSparkLnurlInvoiceOrigin,
  CheckoutSparkInvoiceOriginUnavailableError,
  type CheckoutSparkLnurlInvoiceOrigin,
} from "./checkout-spark-lnurl-invoice"
import { decodeLightningInvoiceMetadata } from "./lightning"
import { requireCheckoutSparkSettledExactOutgoingRequest } from "./checkout-spark-settled-outgoing-history"
import type { CheckoutSparkSettledOutgoingTarget } from "./checkout-spark-settled-outgoing"
import type { CheckoutSparkSettledPlan } from "./checkout-spark-settled-router"
import { freezeCheckoutSparkReceiverBinding } from "./checkout-spark-receiver-capability"

/** Private device-local attestation. Never accept this from recovery or Nostr. */
export interface CheckoutSparkInvoiceOriginRecord {
  readonly schemaVersion: 1
  readonly legId: string
  readonly intentDigest: string
  readonly resolvedAt: number
}

function intentDigest(
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget
): string {
  const exact = requireCheckoutSparkSettledExactOutgoingRequest(plan, target)
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          "conduit.checkout-spark.local-invoice-origin.v1",
          plan.checkoutId,
          plan.planDigest,
          target.legId,
          target.recipientId,
          target.allocationSats,
          plan.walletId,
          exact.network,
          exact.transferId,
          exact.paymentRequest,
          target.intent.paymentHash,
          exact.amountSats,
          exact.maxFeeSats,
          target.intent.preparedAt,
          ...(target.intent.publicZap
            ? [
                [
                  "conduit:checkout-spark-public-invoice-origin:v1",
                  target.intent.publicZap,
                ],
              ]
            : []),
          ...(target.intent.receiverBinding
            ? [
                [
                  "conduit:checkout-spark-receiver-binding:v1",
                  freezeCheckoutSparkReceiverBinding(
                    target.intent.receiverBinding
                  ),
                ],
              ]
            : []),
        ])
      )
    )
  )
}

/** Called only while committing a newly prepared exact intent. */
export function createCheckoutSparkInvoiceOriginRecord(
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget,
  origin: CheckoutSparkLnurlInvoiceOrigin
): CheckoutSparkInvoiceOriginRecord {
  const digest = intentDigest(plan, target)
  const recipient = plan.recipients.find((leg) => leg.legId === target.legId)!
  const resolvedAt = assertCheckoutSparkLnurlInvoiceOrigin(origin, {
    lud16: recipient.destination.value,
    network: plan.network,
    amountSats: target.intent.invoiceAmountSats,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    expiresAt: decodeLightningInvoiceMetadata(target.intent.paymentRequest)
      .expiresAt!,
    ...(target.intent.receiverBinding
      ? { receiverBinding: target.intent.receiverBinding }
      : {}),
  })
  if (
    !Number.isSafeInteger(resolvedAt) ||
    resolvedAt > target.intent.preparedAt
  ) {
    throw new CheckoutSparkInvoiceOriginUnavailableError()
  }
  return {
    schemaVersion: 1,
    legId: target.legId,
    intentDigest: digest,
    resolvedAt,
  }
}

export function hasCheckoutSparkInvoiceOrigin(
  record: CheckoutSparkInvoiceOriginRecord | undefined,
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget
): boolean {
  return (
    !!record &&
    record.schemaVersion === 1 &&
    record.legId === target.legId &&
    Number.isSafeInteger(record.resolvedAt) &&
    record.resolvedAt >= 0 &&
    record.resolvedAt <= target.intent.preparedAt &&
    record.intentDigest === intentDigest(plan, target)
  )
}
