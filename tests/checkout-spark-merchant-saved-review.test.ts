import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  resolveCheckoutSparkLnurlInvoice,
  verifyCheckoutSparkInvoiceRecipient,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledOutgoingTarget,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import { ConduitDB } from "@conduit/core/db"
import { reviewMerchantCheckoutSparkSettledPayout } from "../apps/merchant/src/lib/checkout-spark-settled-continuation"
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

function fixture(qualified = false) {
  const receiver = qualifiedReceiverFixture({ lud16: "merchant@coinos.io" })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "saved-review-checkout",
    orderId: "saved-review-order",
    merchantPubkey: MERCHANT,
    walletId: "saved-review-wallet",
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
      requestId: "receive-saved-review",
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
          value: "merchant@coinos.io",
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
      transferId: "funding-transfer-saved-review",
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
    paymentRequest: qualified ? receiver.paymentRequest : invoice(995, 4),
    paymentHash: qualified ? receiver.paymentHash : "04".repeat(32),
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: NOW + 2,
    ...(qualified ? { receiverBinding: receiver.receiverBinding } : {}),
  })
  const selected: MerchantCheckoutSparkRecoveryCandidate = {
    wrapId: "e".repeat(64),
    schemaVersion: 2,
    checkoutId: plan.checkoutId,
    orderId: plan.orderId,
    planDigest: plan.planDigest,
    takeoverAt: plan.takeoverAt,
    preparedAt: NOW + 2,
  }
  return { plan, credited, state, selected, receiver }
}

async function withRepository(
  state: CheckoutSparkSettledReconciliation,
  run: (repository: DexieCheckoutSparkSettledRepository) => Promise<void>
) {
  const database = new ConduitDB(
    `merchant-saved-review-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  const repository = new DexieCheckoutSparkSettledRepository(database)
  try {
    await repository.importRecoveryState(state, () => {})
    await run(repository)
  } finally {
    await database.delete()
  }
}

describe("Merchant read-only saved payout review", () => {
  it("distinguishes a saved unsubmitted invoice lacking recipient evidence without changing it", async () => {
    const { plan, state, selected } = fixture()
    await withRepository(state, async (repository) => {
      const before = await repository.load(plan.checkoutId, plan.planDigest)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        selected,
        repository
      )
      expect(review?.inspection).toEqual({
        recipientAttribution: "missing",
        savedStatus: "prepared",
        allocationBudget: "fits",
      })
      expect(await repository.load(plan.checkoutId, plan.planDigest)).toEqual(
        before
      )
      expect(review?.intent).toEqual(state.legs[0]!.intent)
    })
  })

  it("recognizes an exact saved local origin without querying a provider", async () => {
    const { plan, credited, state, selected } = fixture()
    const intent = state.legs[0]!.intent!
    const resolved = await resolveCheckoutSparkLnurlInvoice(
      {
        lud16: plan.recipients[0]!.destination.value,
        amountSats: intent.invoiceAmountSats,
        network: plan.network,
        nowSeconds: Math.floor(intent.preparedAt / 1_000),
        shouldContinue: () => true,
      },
      {
        fetchMetadata: async () => ({
          payRequestUrl: "https://coinos.io/.well-known/lnurlp/merchant",
          lnurl: "lnurl1test",
          callback: "https://coinos.io/pay",
          minSendable: 1_000,
          maxSendable: 100_000_000,
          tag: "payRequest",
          allowsNostr: false,
          metadata: "[]",
        }),
        fetchInvoice: async () => ({ invoice: intent.paymentRequest }),
      }
    )
    if (!resolved.origin) throw new Error("Missing fixture origin")
    await withRepository(credited, async (repository) => {
      const saved = await repository.load(plan.checkoutId, plan.planDigest)
      if (saved.status !== "active") throw new Error("Missing fixture state")
      await repository.savePreparedWithInvoiceOrigin(state, saved.revision, {
        legId: intent.legId,
        origin: resolved.origin!,
      })
      const before = await repository.load(plan.checkoutId, plan.planDigest)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        selected,
        repository
      )
      expect(review?.inspection?.recipientAttribution).toBe("local_origin")
      expect(await repository.load(plan.checkoutId, plan.planDigest)).toEqual(
        before
      )
    })
  })

  it("recognizes existing recipient evidence without making another provider lookup", async () => {
    const { plan, state, selected, receiver } = fixture(true)
    const leg = state.legs[0]!
    const intent = leg.intent!
    const target: CheckoutSparkSettledOutgoingTarget = {
      walletId: plan.walletId,
      network: plan.network,
      legId: leg.legId,
      recipientId: plan.recipients[0]!.recipientId,
      allocationSats: leg.allocationSats!,
      unpaidAllocationSats: leg.allocationSats!,
      intent,
    }
    const verified = await verifyCheckoutSparkInvoiceRecipient(
      { plan, target, now: NOW + 3, assertCurrent: () => {} },
      {
        contracts: receiver.contracts,
        fetchMetadata: async () => receiver.metadata,
        fetchVerify: async () => receiver.verifier(),
      }
    )
    if (verified.status !== "verified") throw new Error("Missing fixture proof")
    await withRepository(state, async (repository) => {
      await repository.recordInvoiceRecipientVerification(
        plan,
        target,
        verified.proof
      )
      const before = await repository.load(plan.checkoutId, plan.planDigest)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        selected,
        repository
      )
      expect(review?.inspection?.recipientAttribution).toBe(
        "recipient_verified"
      )
      expect(await repository.load(plan.checkoutId, plan.planDigest)).toEqual(
        before
      )
    })
  })

  it("keeps unavailable local evidence distinct from an observed missing record", async () => {
    const { state, selected } = fixture()
    await withRepository(state, async (repository) => {
      const loadOnly = { load: repository.load.bind(repository) }
      const unavailable = {
        ...loadOnly,
        hasInvoiceOrigin: async () => {
          throw new Error(
            "Synthetic unavailable read; must not escape into presentation"
          )
        },
        hasInvoiceRecipient: repository.hasInvoiceRecipient.bind(repository),
      }
      for (const adapter of [loadOnly, unavailable]) {
        const review = await reviewMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          selected,
          adapter
        )
        expect(review?.inspection?.recipientAttribution).toBe("unavailable")
        expect(JSON.stringify(review?.inspection)).not.toContain("Synthetic")
      }
    })
  })

  it("preserves a saved uncertain attempt rather than describing it as unpaid", async () => {
    const { state, selected } = fixture()
    const intent = state.legs[0]!.intent!
    const uncertain = recordCheckoutSparkSettledLegStatus(state, {
      legId: intent.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: "ambiguous",
      observedAt: NOW + 3,
    })
    await withRepository(uncertain, async (repository) => {
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        selected,
        repository
      )
      expect(review?.inspection?.savedStatus).toBe("ambiguous")
      expect(review?.intent).toEqual(intent)
    })
  })
})
