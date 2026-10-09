import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  freezeCheckoutSparkSettledTreasuryPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  createCheckoutSparkMerchantSettlementRecord,
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  type CheckoutSparkMerchantSettlementRecord,
} from "@conduit/core"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./signed-bolt11-fixture"

export const AT = 1_800_000_000_000
export const MERCHANT = "a".repeat(64)
function invoice(amount: number, byte: number) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amount * 10}n`,
    createdAt: AT / 1000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(byte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}
export function nativeTreasuryFixture(
  creditedSats = 1111,
  finalFeeSats = 4,
  merchantPubkey = MERCHANT
) {
  const legacy = freezeCheckoutSparkSettledPlan({
    checkoutId: "native-checkout",
    orderId: "native-order",
    merchantPubkey,
    walletId: "native-wallet",
    network: "mainnet",
    createdAt: AT,
    takeoverAt: AT + 60_000,
    commerceQuote: {
      commerceTotalSats: 1000,
      lines: [
        {
          productCoordinate: `30402:${merchantPubkey}:sku`,
          productEventId: "b".repeat(64),
          merchantPubkey,
          quantity: 1,
          unitMerchandiseSats: 1000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-native",
      paymentRequest: invoice(1113, 1),
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossFundingSats: 1113,
      createdAt: AT,
      expiresAt: AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: merchantPubkey,
        weightSats: 1000,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: AT / 1000,
          },
        },
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        weightSats: 111,
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
      },
    ],
  })
  const identity = {
    checkoutId: legacy.checkoutId,
    orderId: legacy.orderId,
    walletId: legacy.walletId,
    network: legacy.network,
    createdAt: legacy.createdAt,
    sparkAddress: "spark-canonical-treasury-test-fixture",
    receiverIdentityPublicKey: `03${"e".repeat(64)}`,
    senderIdentityPublicKey: legacy.funding.receiverIdentityPublicKey,
  }
  const nativeTreasury = {
    schemaVersion: 1 as const,
    sparkAddress: identity.sparkAddress,
    receiverIdentityPublicKey: identity.receiverIdentityPublicKey,
    senderIdentityPublicKey: identity.senderIdentityPublicKey,
    invoiceId: deriveCheckoutSparkNativeTreasuryInvoiceId(identity),
    invoiceRequest: "canonical-open-amount-native-test-fixture",
    feePolicy: "zero_required" as const,
    residualPolicy: "unused_commerce_reserves" as const,
  }
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    ...legacy,
    nativeTreasury,
  })
  let state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "attributed-credit",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: plan.funding.grossFundingSats,
      creditedSats,
      observedAt: AT + 1,
    }
  )
  const allocation = state.legs[0]!.allocationSats!
  const amount = creditedSats === 2 ? 1 : allocation - 5
  const merchantId = plan.recipients[0]!.legId
  state = prepareCheckoutSparkSettledLeg(state, {
    legId: merchantId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, merchantId),
    paymentRequest: invoice(amount, 2),
    paymentHash: "02".repeat(32),
    invoiceAmountSats: amount,
    maxFeeSats: allocation - amount,
    preparedAt: AT + 2,
  })
  state = recordCheckoutSparkSettledLegStatus(state, {
    legId: merchantId,
    transferId: state.legs[0]!.intent!.transferId,
    paymentHash: "02".repeat(32),
    status: "paid",
    observedAt: AT + 3,
    finalFeeSats,
    finalDebitSats: amount + finalFeeSats,
  })
  const record: CheckoutSparkMerchantSettlementRecord = {
    ...createCheckoutSparkMerchantSettlementRecord(plan),
    credit: {
      transferId: "attributed-credit",
      creditedSats,
      observedAt: AT + 1,
    },
    paidLegs: [
      {
        legId: merchantId,
        transferId: state.legs[0]!.intent!.transferId,
        allocationSats: allocation,
        finalDebitSats: amount + finalFeeSats,
        finalFeeSats,
        observedAt: AT + 3,
        recipientVerified: true,
      },
    ],
  }
  return {
    legacy,
    plan,
    state,
    record,
    identity,
    feeId: plan.recipients[1]!.legId,
  }
}
