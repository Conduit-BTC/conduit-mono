import { describe, expect, it } from "bun:test"

import {
  createCheckoutSparkSettledRecoveryPayload,
  type CheckoutSparkSettledRecoveryPayload,
} from "@conduit/core/protocol/checkout-spark-recovery"
import { createCheckoutSparkMerchantProgress } from "@conduit/core/protocol/checkout-spark-merchant-progress"
import { selectCheckoutSparkMerchantProgress } from "@conduit/core/protocol/checkout-spark-merchant-progress-selection"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type CheckoutSparkSettledReconciliation,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const MNEMONIC = createRuntimeMnemonic()

const CREATED_AT = 1_800_000_000_000
const TAKEOVER_AT = CREATED_AT + 120_000
const MERCHANT = "a".repeat(64)
const BUYER = "b".repeat(64)

function invoice(amountSats: number, hashByte: number) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function fixture() {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "selection-checkout",
    orderId: "selection-order",
    merchantPubkey: MERCHANT,
    walletId: "selection-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: TAKEOVER_AT,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:selection-fixture`,
          productEventId: "c".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "selection-receive",
      paymentRequest: invoice(1_113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"d".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        weightSats: 1_000,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "e".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
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
  const initialState = createCheckoutSparkSettledReconciliation(plan)
  const initial = createCheckoutSparkSettledRecoveryPayload({
    state: initialState,
    senderPubkey: BUYER,
    mnemonic: MNEMONIC,
    accountNumber: 0,
    preparedAt: CREATED_AT + 1_000,
  })
  const buyerState = recordCheckoutSparkSettledCredit(initialState, {
    requestId: plan.funding.requestId,
    paymentHash: plan.funding.paymentHash,
    transferId: "selection-funding-transfer",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: 1_113,
    creditedSats: 1_111,
    observedAt: CREATED_AT + 2_000,
  })
  const firstLeg = buyerState.legs[0]!
  const transferId = deriveCheckoutSparkSettledTransferId(plan, firstLeg.legId)
  const prepared = prepareCheckoutSparkSettledLeg(buyerState, {
    legId: firstLeg.legId,
    transferId,
    paymentRequest: invoice(995, 8),
    paymentHash: "08".repeat(32),
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: TAKEOVER_AT,
  })
  return { initial, buyerState, prepared, firstLeg, transferId }
}

function entry(
  initial: CheckoutSparkSettledRecoveryPayload,
  state: CheckoutSparkSettledReconciliation,
  wrapId: string
) {
  return {
    wrapId,
    payload: createCheckoutSparkMerchantProgress({
      initialHandoffId: initial.handoffId,
      state,
    }),
  }
}

describe("Merchant progress selection", () => {
  it("selects the newest monotonic snapshot independent of relay order", () => {
    const { initial, buyerState, prepared, firstLeg, transferId } = fixture()
    const submitted = recordCheckoutSparkSettledLegStatus(prepared, {
      legId: firstLeg.legId,
      transferId,
      paymentHash: "08".repeat(32),
      status: "submitted",
      observedAt: TAKEOVER_AT + 1,
    })
    const first = entry(initial, prepared, "1".repeat(64))
    const second = entry(initial, submitted, "2".repeat(64))
    for (const entries of [
      [first, second],
      [second, first],
    ]) {
      expect(
        selectCheckoutSparkMerchantProgress({
          initial,
          latestBuyerState: buyerState,
          entries,
        })
      ).toEqual({ status: "selected", entry: second })
    }
  })

  it("deduplicates identical snapshots and chooses the stable wrap ID", () => {
    const { initial, buyerState, prepared } = fixture()
    const higher = entry(initial, prepared, "f".repeat(64))
    const lower = entry(initial, prepared, "1".repeat(64))
    expect(
      selectCheckoutSparkMerchantProgress({
        initial,
        latestBuyerState: buyerState,
        entries: [higher, lower, higher],
      })
    ).toEqual({ status: "selected", entry: lower })
    expect(
      selectCheckoutSparkMerchantProgress({
        initial,
        latestBuyerState: buyerState,
        entries: [],
      })
    ).toEqual({ status: "none" })
  })

  it("does not import Merchant progress already subsumed by a newer buyer state", () => {
    const { initial, prepared, firstLeg, transferId } = fixture()
    const submitted = recordCheckoutSparkSettledLegStatus(prepared, {
      legId: firstLeg.legId,
      transferId,
      paymentHash: "08".repeat(32),
      status: "submitted",
      observedAt: TAKEOVER_AT + 1,
    })
    for (const latestBuyerState of [prepared, submitted]) {
      expect(
        selectCheckoutSparkMerchantProgress({
          initial,
          latestBuyerState,
          entries: [entry(initial, prepared, "1".repeat(64))],
        })
      ).toEqual({ status: "none" })
    }
  })

  it("rejects two different frozen intents at the same time", () => {
    const { initial, buyerState, prepared, firstLeg, transferId } = fixture()
    const competing = prepareCheckoutSparkSettledLeg(buyerState, {
      legId: firstLeg.legId,
      transferId,
      paymentRequest: invoice(994, 9),
      paymentHash: "09".repeat(32),
      invoiceAmountSats: 994,
      maxFeeSats: 6,
      preparedAt: TAKEOVER_AT,
    })
    expect(
      selectCheckoutSparkMerchantProgress({
        initial,
        latestBuyerState: buyerState,
        entries: [
          entry(initial, prepared, "1".repeat(64)),
          entry(initial, competing, "2".repeat(64)),
        ],
      })
    ).toEqual({ status: "conflict" })
  })

  it("rejects paid-to-uncertain regression and changed handoff", () => {
    const { initial, buyerState, prepared, firstLeg, transferId } = fixture()
    const submitted = recordCheckoutSparkSettledLegStatus(prepared, {
      legId: firstLeg.legId,
      transferId,
      paymentHash: "08".repeat(32),
      status: "submitted",
      observedAt: TAKEOVER_AT + 1,
    })
    const paid = recordCheckoutSparkSettledLegStatus(submitted, {
      legId: firstLeg.legId,
      transferId,
      paymentHash: "08".repeat(32),
      status: "paid",
      finalFeeSats: 5,
      finalDebitSats: 1_000,
      observedAt: TAKEOVER_AT + 2,
    })
    const ambiguous = recordCheckoutSparkSettledLegStatus(submitted, {
      legId: firstLeg.legId,
      transferId,
      paymentHash: "08".repeat(32),
      status: "ambiguous",
      observedAt: TAKEOVER_AT + 3,
    })
    expect(
      selectCheckoutSparkMerchantProgress({
        initial,
        latestBuyerState: buyerState,
        entries: [
          entry(initial, paid, "1".repeat(64)),
          entry(initial, ambiguous, "2".repeat(64)),
        ],
      })
    ).toEqual({ status: "conflict" })
    expect(
      selectCheckoutSparkMerchantProgress({
        initial,
        latestBuyerState: buyerState,
        entries: [
          {
            wrapId: "3".repeat(64),
            payload: createCheckoutSparkMerchantProgress({
              initialHandoffId: "4".repeat(64),
              state: prepared,
            }),
          },
        ],
      })
    ).toEqual({ status: "conflict" })
  })

  it("rejects a buyer state that does not advance its signed initial state", () => {
    const { initial, buyerState, prepared } = fixture()
    const advancedInitial = createCheckoutSparkSettledRecoveryPayload({
      state: buyerState,
      senderPubkey: BUYER,
      mnemonic: MNEMONIC,
      accountNumber: 0,
      preparedAt: CREATED_AT + 3_000,
    })
    expect(
      selectCheckoutSparkMerchantProgress({
        initial: advancedInitial,
        latestBuyerState: initial.state,
        entries: [entry(advancedInitial, prepared, "1".repeat(64))],
      })
    ).toEqual({ status: "conflict" })
  })
})
