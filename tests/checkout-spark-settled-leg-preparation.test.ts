import { describe, expect, it } from "bun:test"

import {
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledPlan,
  recordCheckoutSparkSettledCredit,
  type CheckoutSparkSettledReconciliation,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import {
  decodeLightningInvoiceMetadata,
  isValidLightningInvoice,
} from "../packages/core/src/protocol/lightning"
import { CheckoutSparkSettledRepositoryConflictError } from "../packages/core/src/protocol/checkout-spark-settled-router-repository"
import { prepareCheckoutSparkSettledOutgoingLeg } from "../apps/market/src/lib/checkout-spark-settled-leg-preparation"
import type { CheckoutSparkLnurlInvoiceInput } from "../packages/core/src/protocol/checkout-spark-lnurl-invoice"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import { qualifiedReceiverInvoiceFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const CREATED_AT = 1_800_000_000_000
const MERCHANT = "a".repeat(64)

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

function creditedState(): CheckoutSparkSettledReconciliation {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-1",
    orderId: "order-1",
    merchantPubkey: MERCHANT,
    walletId: "wallet-1",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 45 * 60_000,
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
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@receiver.conduit.cash",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
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
  return recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "funding-transfer-1",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: CREATED_AT + 1,
    }
  )
}

function harness() {
  let state = creditedState()
  let revision = 1
  const saves: CheckoutSparkSettledReconciliation[] = []
  const acknowledgements: CheckoutSparkSettledReconciliation[] = []
  const invoiceAmounts: number[] = []
  const estimateAmounts: number[] = []
  const dependencies = {
    repository: {
      async load() {
        return { status: "active" as const, revision, state }
      },
      async savePreparedWithInvoiceOrigin(
        next: CheckoutSparkSettledReconciliation,
        expected: number
      ) {
        if (revision !== expected) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        state = next
        revision += 1
        saves.push(next)
        return { status: "active" as const, revision, state }
      },
    },
    walletManager: {
      async estimateCheckoutLightningFee(request: { amountSats: number }) {
        estimateAmounts.push(request.amountSats)
        return 5
      },
    },
    async resolveInvoice(request: CheckoutSparkLnurlInvoiceInput) {
      invoiceAmounts.push(request.amountSats)
      const hashByte = invoiceAmounts.length + 3
      return resolveCheckoutSparkFixtureInvoice(
        request,
        qualifiedReceiverInvoiceFixture({
          lud16: request.lud16,
          amountSats: request.amountSats,
          paymentHash: hashByte.toString(16).padStart(2, "0").repeat(32),
          createdAt: CREATED_AT / 1_000,
        })
      )
    },
    async acknowledgeRecoverySnapshot(
      next: CheckoutSparkSettledReconciliation
    ) {
      acknowledgements.push(next)
    },
    nowMs: () => CREATED_AT + 1_000,
  }
  const input = {
    checkoutId: state.plan.checkoutId,
    planDigest: state.plan.planDigest,
    legId: state.plan.recipients[0]!.legId,
    shouldContinue: () => true,
  }
  return {
    input,
    dependencies,
    saves,
    acknowledgements,
    invoiceAmounts,
    estimateAmounts,
    getState: () => state,
  }
}

describe("settled Spark payout invoice preparation", () => {
  it("obtains a fresh smaller invoice after exact credit and ACKs the persisted intent", async () => {
    const test = harness()
    const result = await prepareCheckoutSparkSettledOutgoingLeg(
      test.input,
      test.dependencies
    )
    expect(test.invoiceAmounts).toEqual([999, 995])
    expect(test.estimateAmounts).toEqual([999, 995])
    expect(test.saves).toHaveLength(1)
    expect(result.state.legs[0]?.intent?.invoiceAmountSats).toBe(995)
    expect(result.state.legs[0]?.intent?.maxFeeSats).toBe(5)
    expect(test.acknowledgements).toEqual([result.state])
  })

  it("reuses a prepared invoice after refresh without asking LNURL again", async () => {
    const test = harness()
    const first = await prepareCheckoutSparkSettledOutgoingLeg(
      test.input,
      test.dependencies
    )
    const second = await prepareCheckoutSparkSettledOutgoingLeg(
      test.input,
      test.dependencies
    )
    expect(second.state.legs[0]?.intent).toEqual(first.state.legs[0]?.intent)
    expect(test.invoiceAmounts).toEqual([999, 995])
    expect(test.saves).toHaveLength(1)
    expect(test.acknowledgements).toHaveLength(2)
  })

  it("re-ACKs the same intent after buyer takeover without requesting another invoice", async () => {
    const test = harness()
    const first = await prepareCheckoutSparkSettledOutgoingLeg(
      test.input,
      test.dependencies
    )
    const replayed = await prepareCheckoutSparkSettledOutgoingLeg(test.input, {
      ...test.dependencies,
      nowMs: () => first.state.plan.takeoverAt + 1,
      walletManager: null,
    })
    expect(replayed.state.legs[0]?.intent).toEqual(first.state.legs[0]?.intent)
    expect(test.invoiceAmounts).toEqual([999, 995])
    expect(test.saves).toHaveLength(1)
    expect(test.acknowledgements).toHaveLength(2)
  })

  it("does not request a fresh invoice when its wallet is unavailable", async () => {
    const test = harness()
    await expect(
      prepareCheckoutSparkSettledOutgoingLeg(test.input, {
        ...test.dependencies,
        walletManager: null,
      })
    ).rejects.toThrow("wallet is unavailable")
    expect(test.invoiceAmounts).toHaveLength(0)
    expect(test.estimateAmounts).toHaveLength(0)
    expect(test.saves).toHaveLength(0)
  })

  it("does not return a routable leg when recovery ACK fails, then re-ACKs the same intent", async () => {
    const test = harness()
    let fail = true
    const dependencies = {
      ...test.dependencies,
      async acknowledgeRecoverySnapshot(
        next: CheckoutSparkSettledReconciliation
      ) {
        test.acknowledgements.push(next)
        if (fail) throw new Error("relay unavailable")
      },
    }
    await expect(
      prepareCheckoutSparkSettledOutgoingLeg(test.input, dependencies)
    ).rejects.toThrow("relay unavailable")
    expect(test.saves).toHaveLength(1)
    fail = false
    const replayed = await prepareCheckoutSparkSettledOutgoingLeg(
      test.input,
      dependencies
    )
    expect(replayed.state.legs[0]?.intent).toEqual(
      test.saves[0]?.legs[0]?.intent
    )
    expect(test.invoiceAmounts).toEqual([999, 995])
  })

  it("does not prepare or fetch an invoice before exact credit", async () => {
    const test = harness()
    const noCredit = createCheckoutSparkSettledReconciliation(
      test.getState().plan
    )
    test.dependencies.repository.load = async () => ({
      status: "active" as const,
      revision: 1,
      state: noCredit,
    })
    await expect(
      prepareCheckoutSparkSettledOutgoingLeg(test.input, test.dependencies)
    ).rejects.toThrow("not settled")
    expect(test.invoiceAmounts).toHaveLength(0)
    expect(test.saves).toHaveLength(0)
  })

  it("does not freeze a new buyer invoice after the takeover window", async () => {
    const test = harness()
    let clock = CREATED_AT + 1_000
    const dependencies = {
      ...test.dependencies,
      nowMs: () => clock,
      async resolveInvoice(request: CheckoutSparkLnurlInvoiceInput) {
        clock = CREATED_AT + 45 * 60_000
        return test.dependencies.resolveInvoice(request)
      },
    }
    await expect(
      prepareCheckoutSparkSettledOutgoingLeg(test.input, dependencies)
    ).rejects.toThrow("buyer payout authority has ended")
    expect(test.saves).toHaveLength(0)
  })

  it("leaves the leg unprepared if the fee cannot fit its allocation", async () => {
    const test = harness()
    test.dependencies.walletManager.estimateCheckoutLightningFee = async () =>
      1_000
    await expect(
      prepareCheckoutSparkSettledOutgoingLeg(test.input, test.dependencies)
    ).rejects.toThrow("fee estimate is unavailable")
    expect(test.saves).toHaveLength(0)
    expect(test.acknowledgements).toHaveLength(0)
  })

  it("prepares a production Conduit 59-second invoice within its unchanged allocation", async () => {
    const test = harness()
    const plan = test.getState().plan
    const conduit = plan.recipients[1]!
    const shortPaymentRequest = qualifiedReceiverInvoiceFixture({
      lud16: conduit.destination.value,
      amountSats: 110,
      paymentHash: "06".repeat(32),
      createdAt: CREATED_AT / 1_000,
      expiresSeconds: 59,
    })
    let invoiceCalls = 0
    const dependencies = {
      ...test.dependencies,
      walletManager: {
        async estimateCheckoutLightningFee(request: { amountSats: number }) {
          test.estimateAmounts.push(request.amountSats)
          return 1
        },
      },
      async resolveInvoice(request: CheckoutSparkLnurlInvoiceInput) {
        invoiceCalls += 1
        expect(request.lud16).toBe(CONDUIT_CHECKOUT_FEE_RECIPIENT)
        expect(request.amountSats).toBe(110)
        expect(request.network).toBe("mainnet")
        return resolveCheckoutSparkFixtureInvoice(request, shortPaymentRequest)
      },
    }

    expect(isValidLightningInvoice(shortPaymentRequest)).toBe(true)
    expect(decodeLightningInvoiceMetadata(shortPaymentRequest).expiresAt).toBe(
      CREATED_AT / 1_000 + 59
    )
    expect(conduit.destination).toMatchObject({
      value: CONDUIT_CHECKOUT_FEE_RECIPIENT,
      source: { type: "conduit_allowlist", policy: "production" },
    })
    const prepared = await prepareCheckoutSparkSettledOutgoingLeg(
      { ...test.input, legId: conduit.legId },
      dependencies
    )
    expect(invoiceCalls).toBe(1)
    expect(test.estimateAmounts).toEqual([110])
    expect(test.saves).toHaveLength(1)
    expect(test.acknowledgements).toEqual([prepared.state])
    expect(test.getState().plan).toEqual(plan)
    expect(test.getState().legs[1]!.status).toBe("prepared")
    expect(test.getState().legs[1]!.intent).toMatchObject({
      paymentRequest: shortPaymentRequest,
      paymentHash: "06".repeat(32),
      invoiceAmountSats: 110,
      maxFeeSats: 1,
    })
  })
})
