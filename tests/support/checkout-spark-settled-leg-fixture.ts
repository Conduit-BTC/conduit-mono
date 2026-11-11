import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../../packages/core/src/protocol/checkout-spark-router-obligations"
import type { CheckoutSparkSettledOutgoingTarget } from "../../packages/core/src/protocol/checkout-spark-settled-outgoing"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  type CheckoutSparkSettledReconciliation,
} from "../../packages/core/src/protocol/checkout-spark-settled-router"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./signed-bolt11-fixture"

export const LEG_FIXTURE_CREATED_AT = 1_800_000_000_000
const MERCHANT = "a".repeat(64)

function invoice(amountSats: number, hashByte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: LEG_FIXTURE_CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

/** Offline frozen settled plan with the merchant leg prepared (995 + 5 fee cap). */
export function preparedSettledLegState(): CheckoutSparkSettledReconciliation {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-1",
    orderId: "order-1",
    merchantPubkey: MERCHANT,
    walletId: "wallet-1",
    network: "mainnet",
    createdAt: LEG_FIXTURE_CREATED_AT,
    takeoverAt: LEG_FIXTURE_CREATED_AT + 60_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:item`,
          productEventId: "b".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-1",
      paymentRequest: invoice(1_113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: LEG_FIXTURE_CREATED_AT,
      expiresAt: LEG_FIXTURE_CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: LEG_FIXTURE_CREATED_AT / 1_000,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
        destination: {
          type: "lightning_address",
          value: CONDUIT_CHECKOUT_FEE_RECIPIENT,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: 111,
      },
    ],
  })
  const credited = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "funding-transfer-1",
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: LEG_FIXTURE_CREATED_AT + 1,
    }
  )
  const legId = plan.recipients[0]!.legId
  return prepareCheckoutSparkSettledLeg(credited, {
    legId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
    paymentRequest: invoice(995, 4),
    paymentHash: "04".repeat(32),
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: LEG_FIXTURE_CREATED_AT + 2,
  })
}

export function outgoingTargetFor(
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkSettledOutgoingTarget {
  const leg = state.legs[0]!
  return {
    walletId: state.plan.walletId,
    network: state.plan.network,
    legId: leg.legId,
    recipientId: state.plan.recipients[0]!.recipientId,
    allocationSats: 1_000,
    unpaidAllocationSats: 1_000,
    intent: leg.intent!,
  }
}
