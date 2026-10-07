import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  createCheckoutSparkInvoiceRecipientRecord,
  hasCheckoutSparkInvoiceRecipient,
  hasCheckoutSparkInvoiceRecipientSettlement,
  verifyCheckoutSparkInvoiceRecipient,
} from "../packages/core/src/protocol/checkout-spark-invoice-recipient"
import {
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  createCheckoutSparkSettledReconciliation,
  recordCheckoutSparkSettledCredit,
  prepareCheckoutSparkSettledLeg,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { DexieCheckoutSparkSettledRepository } from "../packages/core/src/protocol/checkout-spark-settled-router-repository"
import { verifySavedMerchantCheckoutSparkRecipients } from "../apps/merchant/src/lib/checkout-spark-invoice-recipient"
import { verifyBuyerCheckoutSparkRecipientSettlement } from "../apps/market/src/lib/checkout-spark-invoice-recipient"
import type { CheckoutSparkSettledOutgoingTarget } from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import { qualifiedReceiverFixture } from "./support/checkout-spark-qualified-receiver-fixture"

const NOW = 1_800_000_000_000
const MERCHANT = "a".repeat(64)

function fixture() {
  const provider = qualifiedReceiverFixture()
  const funding = qualifiedReceiverFixture({
    amountSats: 1_113,
    preimageByte: 3,
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-1",
    orderId: "order-1",
    merchantPubkey: MERCHANT,
    walletId: "wallet-1",
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
      paymentRequest: funding.paymentRequest,
      paymentHash: funding.paymentHash,
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
          value: provider.lud16,
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
  const recipient = plan.recipients[0]!
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: plan.walletId,
    network: plan.network,
    legId: recipient.legId,
    recipientId: recipient.recipientId,
    allocationSats: 1_000,
    unpaidAllocationSats: 1_111,
    intent: {
      legId: recipient.legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, recipient.legId),
      paymentRequest: provider.paymentRequest,
      paymentHash: provider.paymentHash,
      invoiceAmountSats: 995,
      maxFeeSats: 5,
      preparedAt: NOW + 2,
      receiverBinding: provider.receiverBinding,
    },
  }
  return {
    plan,
    target,
    now: NOW + 3,
    assertCurrent: () => undefined,
    provider,
  }
}

describe("qualified provider invoice recipient attribution", () => {
  it("continues buyer verification when delayed receiver settlement becomes available", async () => {
    const input = fixture()
    const state = prepareCheckoutSparkSettledLeg(
      recordCheckoutSparkSettledCredit(
        createCheckoutSparkSettledReconciliation(input.plan),
        {
          requestId: input.plan.funding.requestId,
          paymentHash: input.plan.funding.paymentHash,
          transferId: "synthetic-credit",
          receiverIdentityPublicKey:
            input.plan.funding.receiverIdentityPublicKey,
          grossSats: 1_113,
          creditedSats: 1_111,
          observedAt: NOW + 1,
        }
      ),
      input.target.intent
    )
    const database = new ConduitDB(`buyer-receiver-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      let repository = new DexieCheckoutSparkSettledRepository(database)
      await repository.importRecoveryState(state, input.assertCurrent)
      let settled = false
      let reads = 0
      const observe = () =>
        verifyBuyerCheckoutSparkRecipientSettlement({
          plan: input.plan,
          target: input.target,
          repository,
          now: () => NOW + 3,
          assertCurrent: input.assertCurrent,
          verifyInvoice: (request) =>
            verifyCheckoutSparkInvoiceRecipient(request, {
              contracts: input.provider.contracts,
              fetchMetadata: async () => input.provider.metadata,
              fetchVerify: async () => {
                reads += 1
                return input.provider.verifier(settled)
              },
            }),
        })
      expect(await observe()).toBe(false)
      expect(
        await repository.hasInvoiceRecipient(input.plan, input.target)
      ).toBe(true)
      expect(
        await repository.hasInvoiceRecipientSettlement(input.plan, input.target)
      ).toBe(false)
      repository = new DexieCheckoutSparkSettledRepository(database)
      settled = true
      expect(await observe()).toBe(true)
      expect(reads).toBe(2)
      expect(await observe()).toBe(true)
      expect(reads).toBe(2)
      // Receiver proof alone does not manufacture a native Spark payout ledger.
      expect(
        (await repository.loadMerchantSettlement(
          input.plan.merchantPubkey,
          input.plan.checkoutId,
          input.plan.planDigest
        )) === null
      ).toBe(true)
    } finally {
      await database.delete()
    }
  })

  it("persists opaque exact origin and settled facts without creating a Spark payment claim", async () => {
    const input = fixture()
    let reads = 0
    const result = await verifyCheckoutSparkInvoiceRecipient(input, {
      contracts: input.provider.contracts,
      fetchMetadata: async () => input.provider.metadata,
      fetchVerify: async (url) => {
        reads += 1
        expect(url === input.provider.receiverBinding.verifyUrl).toBe(true)
        return input.provider.verifier()
      },
    })
    expect(result.status).toBe("verified")
    if (result.status !== "verified") throw new Error("Expected verification")
    const record = createCheckoutSparkInvoiceRecipientRecord(
      input.plan,
      input.target,
      result.proof
    )
    expect(Object.keys(result.proof).length).toBe(0)
    expect(Object.keys(record).sort().join(",")).toBe(
      "intentDigest,legId,providerSettled,schemaVersion,source,verifiedAt"
    )
    expect(record.source).toBe("qualified_receiver_v1")
    expect(record.providerSettled).toBe(true)
    expect(
      hasCheckoutSparkInvoiceRecipient(record, input.plan, input.target)
    ).toBe(true)
    expect(
      hasCheckoutSparkInvoiceRecipientSettlement(
        record,
        input.plan,
        input.target
      )
    ).toBe(true)
    expect(reads).toBe(1)
  })

  it("allows exact origin-only observation but never upgrades it to settled proof", async () => {
    const input = fixture()
    const result = await verifyCheckoutSparkInvoiceRecipient(input, {
      contracts: input.provider.contracts,
      fetchMetadata: async () => input.provider.metadata,
      fetchVerify: async () => input.provider.verifier(false),
    })
    if (result.status !== "verified") throw new Error("Expected verification")
    const record = createCheckoutSparkInvoiceRecipientRecord(
      input.plan,
      input.target,
      result.proof
    )
    expect(result.settled).toBe(false)
    expect(
      hasCheckoutSparkInvoiceRecipient(record, input.plan, input.target)
    ).toBe(true)
    expect(
      hasCheckoutSparkInvoiceRecipientSettlement(
        record,
        input.plan,
        input.target
      )
    ).toBe(false)
  })

  it("attributes the original paid invoice after expiry without refreshing or replacing it", async () => {
    const input = fixture()
    const result = await verifyCheckoutSparkInvoiceRecipient(
      { ...input, now: NOW + 7_200_000 },
      {
        contracts: input.provider.contracts,
        fetchMetadata: async () => input.provider.metadata,
        fetchVerify: async () => input.provider.verifier(),
      }
    )
    expect(result.status === "verified" && result.settled).toBe(true)
  })

  it("keeps unbound historical invoices unsupported with zero provider reads", async () => {
    const input = fixture()
    const historic = { ...input.target.intent }
    delete historic.receiverBinding
    let reads = 0
    const result = await verifyCheckoutSparkInvoiceRecipient(
      { ...input, target: { ...input.target, intent: historic } },
      {
        contracts: input.provider.contracts,
        fetchMetadata: async () => {
          reads += 1
          return input.provider.metadata
        },
        fetchVerify: async () => {
          reads += 1
          return input.provider.verifier()
        },
      }
    )
    expect(result.status).toBe("unsupported")
    expect(reads).toBe(0)
  })

  it("leaves a normal provider outage unavailable without minting a record", async () => {
    const input = fixture()
    const result = await verifyCheckoutSparkInvoiceRecipient(input, {
      contracts: input.provider.contracts,
      fetchMetadata: async () => input.provider.metadata,
      fetchVerify: async () => {
        throw new Error("Unavailable")
      },
    })
    expect(result.status).toBe("unavailable")
  })

  it("rejects a late provider observation after the exact checkout session stops", async () => {
    const input = fixture()
    let current = true
    await expect(
      verifyCheckoutSparkInvoiceRecipient(
        {
          ...input,
          assertCurrent: () => {
            if (!current) throw new Error("Session changed")
          },
        },
        {
          contracts: input.provider.contracts,
          fetchMetadata: async () => input.provider.metadata,
          fetchVerify: async () => {
            current = false
            return input.provider.verifier()
          },
        }
      )
    ).rejects.toThrow("Session changed")
  })

  it("reopens exact portable recovery, rechecks unpaid origin, and monotonically records receiver settlement", async () => {
    const input = fixture()
    const credited = recordCheckoutSparkSettledCredit(
      createCheckoutSparkSettledReconciliation(input.plan),
      {
        requestId: input.plan.funding.requestId,
        paymentHash: input.plan.funding.paymentHash,
        transferId: "synthetic-credit",
        receiverIdentityPublicKey: input.plan.funding.receiverIdentityPublicKey,
        grossSats: 1_113,
        creditedSats: 1_111,
        observedAt: NOW + 1,
      }
    )
    const state = prepareCheckoutSparkSettledLeg(credited, input.target.intent)
    const database = new ConduitDB(
      `qualified-receiver-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      let repository = new DexieCheckoutSparkSettledRepository(database)
      await repository.importRecoveryState(state, input.assertCurrent)
      expect(await repository.hasInvoiceOrigin(input.plan, input.target)).toBe(
        false
      )
      expect(
        await repository.hasInvoiceRecipient(input.plan, input.target)
      ).toBe(false)
      let settled = false
      let reads = 0
      const verifyInvoice = (
        request: Parameters<typeof verifyCheckoutSparkInvoiceRecipient>[0]
      ) =>
        verifyCheckoutSparkInvoiceRecipient(request, {
          contracts: input.provider.contracts,
          fetchMetadata: async () => input.provider.metadata,
          fetchVerify: async () => {
            reads += 1
            return input.provider.verifier(settled)
          },
        })
      const observe = () =>
        verifySavedMerchantCheckoutSparkRecipients({
          state,
          repository,
          assertCurrent: input.assertCurrent,
          now: () => NOW + 3,
          verifyInvoice,
        })
      expect(await observe()).toBe("complete")
      expect(
        await repository.hasInvoiceRecipient(input.plan, input.target)
      ).toBe(true)
      expect(
        await repository.hasInvoiceRecipientSettlement(input.plan, input.target)
      ).toBe(false)
      repository = new DexieCheckoutSparkSettledRepository(database)
      settled = true
      expect(await observe()).toBe("complete")
      expect(reads).toBe(2)
      expect(
        await repository.hasInvoiceRecipientSettlement(input.plan, input.target)
      ).toBe(true)
      expect(await observe()).toBe("complete")
      expect(reads).toBe(2)
      const unpaid = await verifyCheckoutSparkInvoiceRecipient(input, {
        contracts: input.provider.contracts,
        fetchMetadata: async () => input.provider.metadata,
        fetchVerify: async () => input.provider.verifier(false),
      })
      if (unpaid.status !== "verified") throw new Error("Expected verification")
      await repository.recordInvoiceRecipientVerification(
        input.plan,
        input.target,
        unpaid.proof
      )
      expect(
        await repository.hasInvoiceRecipientSettlement(input.plan, input.target)
      ).toBe(true)
      const saved = await repository.load(
        input.plan.checkoutId,
        input.plan.planDigest
      )
      expect(
        saved.status === "active" && saved.state.legs[0]!.status === "prepared"
      ).toBe(true)
      expect(
        (await repository.loadMerchantSettlement(
          input.plan.merchantPubkey,
          input.plan.checkoutId,
          input.plan.planDigest
        )) === null
      ).toBe(true)
    } finally {
      await database.delete()
    }
  })
})
