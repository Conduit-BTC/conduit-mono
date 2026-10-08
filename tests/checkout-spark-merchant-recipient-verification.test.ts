import { describe, expect, it } from "bun:test"
import { verifySavedMerchantCheckoutSparkRecipients } from "../apps/merchant/src/lib/checkout-spark-invoice-recipient"
import {
  createCheckoutSparkInvoiceRecipientRecord,
  hasCheckoutSparkInvoiceRecipient,
  hasCheckoutSparkInvoiceRecipientSettlement,
  verifyCheckoutSparkInvoiceRecipient,
  projectCheckoutSparkMerchantRecipientSettlement,
  type CheckoutSparkInvoiceRecipientRecord,
} from "../packages/core/src/protocol/checkout-spark-invoice-recipient"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { qualifiedReceiverFixture } from "./support/checkout-spark-qualified-receiver-fixture"

const NOW = 1_800_000_000_000
const MERCHANT = "a".repeat(64)
type VerificationInput = Parameters<
  typeof verifySavedMerchantCheckoutSparkRecipients
>[0]

function invoice(amount: number, byte: number) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amount * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(byte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function fixture(address = "merchant@receiver.conduit.cash") {
  const receiver = qualifiedReceiverFixture({ lud16: address })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "merchant-recipient-checkout",
    orderId: "merchant-recipient-order",
    merchantPubkey: MERCHANT,
    walletId: "merchant-recipient-wallet",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 60_000,
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
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: address,
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
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
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: NOW + 1,
    }
  )
  const legId = plan.recipients[0]!.legId
  const state = prepareCheckoutSparkSettledLeg(credited, {
    legId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
    paymentRequest: receiver.paymentRequest,
    paymentHash: receiver.paymentHash,
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: NOW + 2,
    receiverBinding: receiver.receiverBinding,
  })
  const canonical = receiver.verifier()
  const records: CheckoutSparkInvoiceRecipientRecord[] = []
  let current = true
  let fetches = 0
  const assertCurrent = () => {
    if (!current) throw new Error("Session inactive")
  }
  const repository: VerificationInput["repository"] = {
    async hasInvoiceRecipient(savedPlan, target, guard) {
      guard?.()
      return records.some((record) =>
        hasCheckoutSparkInvoiceRecipient(record, savedPlan, target)
      )
    },
    async hasInvoiceRecipientSettlement(savedPlan, target, guard) {
      guard?.()
      return records.some((record) =>
        hasCheckoutSparkInvoiceRecipientSettlement(record, savedPlan, target)
      )
    },
    async recordInvoiceRecipientVerification(savedPlan, target, proof, guard) {
      guard?.()
      // This real proof boundary rejects unbranded evidence and persists only
      // the bound attribution record, never a raw provider account response.
      expect(Object.keys(proof)).toEqual([])
      const record = createCheckoutSparkInvoiceRecipientRecord(
        savedPlan,
        target,
        proof
      )
      records.push(structuredClone(record))
    },
  }
  const fetchVerify = async (url: string) => {
    fetches += 1
    // No provider invoice-creation endpoint is used in this read-only phase.
    expect(url === receiver.receiverBinding.verifyUrl).toBe(true)
    return canonical
  }
  const verificationDependencies = {
    contracts:
      address === "merchant@unsupported.conduit.cash" ? [] : receiver.contracts,
    fetchMetadata: async () => receiver.metadata,
    fetchVerify,
  }
  const input: VerificationInput = {
    state,
    repository,
    assertCurrent,
    now: () => NOW + 3,
    allowProviderCompatibility: true,
    verifyInvoice: (request) =>
      verifyCheckoutSparkInvoiceRecipient(request, verificationDependencies),
  }
  return {
    input,
    records,
    canonical,
    verificationDependencies,
    fetches: () => fetches,
    deactivate: () => {
      current = false
    },
  }
}

describe("merchant saved invoice recipient verification", () => {
  it("projects exact settled receiver evidence before takeover without inferring Spark credit or debits", async () => {
    const context = fixture()
    const original = JSON.stringify(context.input.state)
    expect(context.input.now()).toBeLessThan(
      context.input.state.plan.takeoverAt
    )
    expect(
      projectCheckoutSparkMerchantRecipientSettlement(context.input.state, [])
        .commerceVerified
    ).toBe(false)
    await verifySavedMerchantCheckoutSparkRecipients(context.input)
    expect(
      projectCheckoutSparkMerchantRecipientSettlement(
        context.input.state,
        context.records
      )
    ).toEqual({
      creditVerified: false,
      merchantVerified: false,
      commerceVerified: false,
      feePending: false,
      recipientUnverified: false,
      receiverSettlementObserved: true,
      receiverCommerceObserved: true,
    })
    expect(JSON.stringify(context.input.state)).toBe(original)
    expect(
      projectCheckoutSparkMerchantRecipientSettlement(context.input.state, [
        { ...context.records[0]!, providerSettled: false },
      ]).receiverSettlementObserved
    ).toBe(false)
    expect(
      projectCheckoutSparkMerchantRecipientSettlement(context.input.state, [
        { ...context.records[0]!, intentDigest: "f".repeat(64) },
      ]).receiverSettlementObserved
    ).toBe(false)
  })

  it("verifies an approved ordinary receiver without the retired compatibility flag", async () => {
    const context = fixture()
    context.input.allowProviderCompatibility = false
    const original = JSON.stringify(context.input.state)
    expect(
      await verifySavedMerchantCheckoutSparkRecipients(context.input)
    ).toBe("complete")
    expect(context.fetches()).toBe(1)
    expect(context.records).toHaveLength(1)
    expect(JSON.stringify(context.input.state)).toBe(original)
  })

  it("verifies an approved ordinary receiver when the retired compatibility flag is omitted", async () => {
    const context = fixture()
    delete context.input.allowProviderCompatibility
    expect(
      await verifySavedMerchantCheckoutSparkRecipients(context.input)
    ).toBe("complete")
    expect(context.fetches()).toBe(1)
    expect(context.records).toHaveLength(1)
  })

  it("preserves trusted local recipient records when compatibility lookup is disabled", async () => {
    const context = fixture()
    await verifySavedMerchantCheckoutSparkRecipients(context.input)
    context.input.allowProviderCompatibility = false
    expect(
      await verifySavedMerchantCheckoutSparkRecipients(context.input)
    ).toBe("complete")
    expect(context.fetches()).toBe(1)
    expect(context.records).toHaveLength(1)
  })

  it("independently attributes the existing invoice without changing payment state", async () => {
    const context = fixture()
    const original = JSON.stringify(context.input.state)

    expect(
      await verifySavedMerchantCheckoutSparkRecipients(context.input)
    ).toBe("complete")
    expect(context.fetches()).toBe(1)
    expect(context.records).toHaveLength(1)
    expect(Object.keys(context.records[0]!).sort()).toEqual([
      "intentDigest",
      "legId",
      "providerSettled",
      "schemaVersion",
      "source",
      "verifiedAt",
    ])
    expect(context.records[0]!.source).toBe("qualified_receiver_v1")
    expect(context.records[0]!.verifiedAt).toBe(NOW + 3)
    expect(JSON.stringify(context.input.state) === original).toBe(true)
    expect(context.input.state.legs.every((leg) => leg.status !== "paid")).toBe(
      true
    )
  })

  it("skips an already persisted exact recipient proof", async () => {
    const context = fixture()
    await verifySavedMerchantCheckoutSparkRecipients(context.input)
    context.input.verifyInvoice = async () => {
      throw new Error("A locally verified invoice needs no provider lookup")
    }

    expect(
      await verifySavedMerchantCheckoutSparkRecipients(context.input)
    ).toBe("complete")
    expect(context.fetches()).toBe(1)
    expect(context.records).toHaveLength(1)
  })

  it("keeps unsupported recipients unverified without substituting a provider", async () => {
    const context = fixture("merchant@unsupported.conduit.cash")

    expect(
      await verifySavedMerchantCheckoutSparkRecipients(context.input)
    ).toBe("complete")
    expect(context.fetches()).toBe(0)
    expect(context.records).toHaveLength(0)
  })

  it("leaves transient provider failures retryable without changing the saved intent", async () => {
    const context = fixture()
    const original = JSON.stringify(context.input.state)
    const retry = context.input.verifyInvoice
    context.input.verifyInvoice = (request) =>
      verifyCheckoutSparkInvoiceRecipient(request, {
        ...context.verificationDependencies,
        fetchVerify: async () => {
          throw new Error("Provider temporarily unavailable")
        },
      })

    expect(
      await verifySavedMerchantCheckoutSparkRecipients(context.input)
    ).toBe("unavailable")
    expect(context.records).toHaveLength(0)
    expect(JSON.stringify(context.input.state) === original).toBe(true)

    context.input.verifyInvoice = retry
    expect(
      await verifySavedMerchantCheckoutSparkRecipients(context.input)
    ).toBe("complete")
    expect(context.records).toHaveLength(1)
  })

  it.each(["account changes", "page becomes inactive"])(
    "does not persist a recipient proof when the %s before the lookup finishes",
    async () => {
      const context = fixture()
      context.input.verifyInvoice = (request) =>
        verifyCheckoutSparkInvoiceRecipient(request, {
          ...context.verificationDependencies,
          fetchVerify: async () => {
            context.deactivate()
            return context.canonical
          },
        })

      await expect(
        verifySavedMerchantCheckoutSparkRecipients(context.input)
      ).rejects.toThrow("Session inactive")
      expect(context.records).toHaveLength(0)
    }
  )

  it("checks the active session again after an existing-proof read", async () => {
    const context = fixture()
    context.input.repository.hasInvoiceRecipientSettlement = async () => {
      context.deactivate()
      return false
    }

    await expect(
      verifySavedMerchantCheckoutSparkRecipients(context.input)
    ).rejects.toThrow("Session inactive")
    expect(context.fetches()).toBe(0)
    expect(context.records).toHaveLength(0)
  })

  it("does not persist a completed proof after the active session changes", async () => {
    const context = fixture()
    context.input.verifyInvoice = async (request) => {
      const result = await verifyCheckoutSparkInvoiceRecipient(request, {
        ...context.verificationDependencies,
        fetchVerify: async () => context.canonical,
      })
      expect(result.status).toBe("verified")
      context.deactivate()
      return result
    }

    await expect(
      verifySavedMerchantCheckoutSparkRecipients(context.input)
    ).rejects.toThrow("Session inactive")
    expect(context.records).toHaveLength(0)
  })
})
