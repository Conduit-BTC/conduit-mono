import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  checkoutSparkConduitFeeRecipient,
  createCheckoutSparkInvoiceOriginRecord,
  createCheckoutSparkMerchantSettlementRecord,
  createCheckoutSparkRetiredSettlementSummary,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  recordCheckoutSparkMerchantPayout,
  recordCheckoutSparkSettledCredit,
  type CheckoutSparkBuyerOrderBinding,
  type CheckoutSparkBuyerSettlementRepositorySnapshot,
  type CheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkRetiredSettlementSummary,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledRepositorySnapshot,
  type OrderLifecycle,
} from "@conduit/core"
import {
  NO_BUYER_CHECKOUT_SPARK_SETTLEMENTS,
  assessCheckoutSparkBuyerSettlement,
  assessCheckoutSparkRetiredBuyerSettlement,
  getCheckoutSparkBuyerSettlementQueryOptions,
} from "../src/lib/checkout-spark-buyer-settlement"
import {
  GUEST_ORDER_SESSION_TTL_MS,
  type GuestOrderSigningIdentity,
} from "../src/lib/guest-order-identity"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "../../../tests/support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "../../../tests/support/signed-bolt11-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "../../../tests/support/checkout-spark-invoice-origin"

const NOW = 1_800_000_000_000
const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const SUPPLIER = "c".repeat(64)
const RECEIVER = `02${"d".repeat(64)}`
type RecipientKind = "merchant" | "supplier" | "conduit"
type PaidLeg = CheckoutSparkMerchantSettlementRecord["paidLegs"][number]
const paidFixtures = new Map<
  RecipientKind,
  { verified: PaidLeg; unverified: PaidLeg }
>()

const FUNDING_INVOICE = makeSignedBolt11Fixture({
  hrp: "lnbc11130n",
  createdAt: NOW / 1_000,
  fields: [
    bolt11PaymentHashField(new Uint8Array(32).fill(1)),
    bolt11PaymentSecretField(),
    bolt11PlainDescriptionField(),
  ],
})

function fixture() {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "buyer-checkout",
    orderId: "buyer-order",
    merchantPubkey: MERCHANT,
    walletId: "buyer-wallet",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 120_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:item`,
          productEventId: "e".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "buyer-receive",
      paymentRequest: FUNDING_INVOICE,
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: RECEIVER,
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
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "f".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
          },
        },
        weightSats: 700,
      },
      {
        kind: "supplier",
        recipientId: SUPPLIER,
        destination: {
          type: "lightning_address",
          value: "supplier@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "9".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
          },
        },
        weightSats: 300,
      },
      {
        kind: "conduit",
        recipientId: checkoutSparkConduitFeeRecipient("production"),
        destination: {
          type: "lightning_address",
          value: checkoutSparkConduitFeeRecipient("production"),
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
      transferId: "buyer-funding-transfer",
      receiverIdentityPublicKey: RECEIVER,
      grossSats: 1_113,
      creditedSats: 1_113,
      observedAt: NOW + 1_000,
    }
  )
  const snapshot: CheckoutSparkSettledRepositorySnapshot = {
    status: "active",
    revision: 2,
    state: credited,
  }
  const lifecycle = {
    orderId: plan.orderId,
    merchantPubkey: MERCHANT,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    checkoutMode: "private_checkout",
    orderDeliveryStatus: "sent",
    phase: "placed",
    paymentStatus: "unpaid",
    currency: "SATS",
    totalSats: 1_000,
    checkoutSparkRouterBinding: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      walletId: plan.walletId,
    },
  } as OrderLifecycle
  const initial = createCheckoutSparkMerchantSettlementRecord(plan)
  const settlement: CheckoutSparkMerchantSettlementRecord = {
    ...initial,
    credit: {
      transferId: credited.credit!.transferId,
      creditedSats: credited.credit!.creditedSats,
      observedAt: NOW + 1_000,
    },
  }
  const paid = (kind: RecipientKind) => ({
    ...paidFixtures.get(kind)!.verified,
  })
  const unverifiedPaid = (kind: RecipientKind) => ({
    ...paidFixtures.get(kind)!.unverified,
  })
  const buyerBinding: CheckoutSparkBuyerOrderBinding = {
    schemaVersion: 1,
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
    orderId: plan.orderId,
    merchantPubkey: MERCHANT,
    buyerPubkey: BUYER,
    walletId: plan.walletId,
    commerceTotalSats: lifecycle.totalSats,
  }
  const summary = createCheckoutSparkRetiredSettlementSummary(credited)
  const active: CheckoutSparkBuyerSettlementRepositorySnapshot = {
    status: "active",
    state: credited,
    settlement,
    buyerBinding: null,
  }
  return {
    plan,
    lifecycle,
    snapshot,
    settlement,
    paid,
    unverifiedPaid,
    buyerBinding,
    summary,
    active,
  }
}

function expectedReceipt(
  summary: CheckoutSparkRetiredSettlementSummary,
  paidKinds: readonly RecipientKind[],
  recipientVerified = true
) {
  const amounts = { merchant: 702, supplier: 300, conduit: 111 }
  const recorded = paidKinds.reduce((total, kind) => total + amounts[kind], 0)
  return {
    creditedSats: 1_113,
    rows: summary.legs.map((leg) => ({
      legId: leg.legId,
      kind: leg.kind,
      allocationSats: amounts[leg.kind as RecipientKind],
      payment: paidKinds.includes(leg.kind as RecipientKind)
        ? {
            invoiceAmountSats: amounts[leg.kind as RecipientKind],
            feeSats: 0,
            debitSats: amounts[leg.kind as RecipientKind],
            recipientVerified,
            observedAt: NOW + 2_000,
          }
        : null,
    })),
    recordedPaidSats: recorded,
    recordedFeeSats: 0,
    recordedDebitSats: recorded,
    recordedUnspentSats: paidKinds.length === 3 ? 0 : null,
    allPayoutsRecorded: paidKinds.length === 3,
  }
}

// Build ordinary provider facts using the real offline resolver. The verified
// fixture gets origin evidence; the legacy/imported fixture retains only debit.
const source = fixture()
for (const [index, recipient] of source.plan.recipients.entries()) {
  const allocationSats =
    source.snapshot.status === "active"
      ? source.snapshot.state.legs.find((leg) => leg.legId === recipient.legId)!
          .allocationSats!
      : 0
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: `lnbc${allocationSats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(index + 2)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const resolved = await resolveCheckoutSparkFixtureInvoice(
    {
      lud16: recipient.destination.value,
      amountSats: allocationSats,
      network: source.plan.network,
      nowSeconds: NOW / 1_000 + 1,
      shouldContinue: () => true,
    },
    paymentRequest
  )
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: source.plan.walletId,
    network: source.plan.network,
    legId: recipient.legId,
    recipientId: recipient.recipientId,
    allocationSats,
    unpaidAllocationSats: source.settlement.credit!.creditedSats,
    intent: {
      legId: recipient.legId,
      transferId: deriveCheckoutSparkSettledTransferId(
        source.plan,
        recipient.legId
      ),
      paymentRequest: resolved.paymentRequest,
      paymentHash: resolved.paymentHash,
      invoiceAmountSats: allocationSats,
      maxFeeSats: 0,
      preparedAt: NOW + 1_500,
    },
  }
  const observation = {
    ...target.intent,
    status: "paid" as const,
    finalDebitSats: allocationSats,
    finalFeeSats: 0,
  }
  const origin = createCheckoutSparkInvoiceOriginRecord(
    source.plan,
    target,
    resolved.origin!
  )
  paidFixtures.set(recipient.kind as RecipientKind, {
    verified: recordCheckoutSparkMerchantPayout(
      source.settlement,
      source.plan,
      target,
      observation,
      NOW + 2_000,
      origin
    ).paidLegs[0]!,
    unverified: recordCheckoutSparkMerchantPayout(
      source.settlement,
      source.plan,
      target,
      observation,
      NOW + 2_000
    ).paidLegs[0]!,
  })
}

describe("buyer-local Spark provider settlement", () => {
  it("requires separate exact provider facts for commerce, not funding or generic paid status", () => {
    const value = fixture()
    const input = {
      lifecycle: value.lifecycle,
      buyerPubkey: BUYER,
      snapshot: value.snapshot,
      settlement: value.settlement,
    }
    expect(assessCheckoutSparkBuyerSettlement(input)).toEqual({
      commerceVerified: false,
      merchantVerified: false,
      feePending: true,
      recipientUnverified: false,
      receipt: expectedReceipt(value.summary, []),
    })
    expect(
      assessCheckoutSparkBuyerSettlement({
        ...input,
        lifecycle: { ...value.lifecycle, paymentStatus: "paid" },
      })?.commerceVerified
    ).toBe(false)
    const merchant = {
      ...value.settlement,
      paidLegs: [value.paid("merchant")],
    }
    expect(
      assessCheckoutSparkBuyerSettlement({ ...input, settlement: merchant })
    ).toEqual({
      commerceVerified: false,
      merchantVerified: true,
      feePending: true,
      recipientUnverified: false,
      receipt: expectedReceipt(value.summary, ["merchant"]),
    })
    const commerce = {
      ...merchant,
      paidLegs: [...merchant.paidLegs, value.paid("supplier")],
    }
    expect(
      assessCheckoutSparkBuyerSettlement({ ...input, settlement: commerce })
    ).toEqual({
      commerceVerified: true,
      merchantVerified: true,
      feePending: true,
      recipientUnverified: false,
      receipt: expectedReceipt(value.summary, ["merchant", "supplier"]),
    })
    expect(
      assessCheckoutSparkBuyerSettlement({
        ...input,
        settlement: {
          ...commerce,
          paidLegs: [...commerce.paidLegs, value.paid("conduit")],
        },
      })
    ).toEqual({
      commerceVerified: true,
      merchantVerified: true,
      feePending: false,
      recipientUnverified: false,
      receipt: expectedReceipt(value.summary, [
        "merchant",
        "supplier",
        "conduit",
      ]),
    })
  })

  it("keeps provider-paid history without local invoice origin unverified", () => {
    const value = fixture()
    const input = {
      ...value,
      buyerPubkey: BUYER,
      settlement: {
        ...value.settlement,
        paidLegs: [
          value.unverifiedPaid("merchant"),
          value.unverifiedPaid("supplier"),
        ],
      },
    }
    for (const assess of [
      assessCheckoutSparkBuyerSettlement,
      assessCheckoutSparkRetiredBuyerSettlement,
    ]) {
      expect(assess(input)).toEqual({
        commerceVerified: false,
        merchantVerified: false,
        feePending: true,
        recipientUnverified: true,
        receipt: expectedReceipt(
          value.summary,
          ["merchant", "supplier"],
          false
        ),
      })
    }
    expect(input.settlement.paidLegs).toHaveLength(2)
  })

  it("rejects mismatched account, plan, funding, and unavailable history", () => {
    const value = fixture()
    const input = {
      lifecycle: value.lifecycle,
      buyerPubkey: BUYER,
      snapshot: value.snapshot,
      settlement: value.settlement,
    }
    expect(
      assessCheckoutSparkBuyerSettlement({ ...input, buyerPubkey: MERCHANT })
    ).toBeNull()
    expect(
      assessCheckoutSparkBuyerSettlement({
        ...input,
        lifecycle: {
          ...value.lifecycle,
          buyerIdentityKind: "guest_ephemeral",
        },
      })
    ).toBeNull()
    expect(
      assessCheckoutSparkBuyerSettlement({
        ...input,
        lifecycle: {
          ...value.lifecycle,
          checkoutSparkRouterBinding: {
            ...value.lifecycle.checkoutSparkRouterBinding!,
            walletId: "other-wallet",
          },
        },
      })
    ).toBeNull()
    expect(
      assessCheckoutSparkBuyerSettlement({
        ...input,
        lifecycle: {
          ...value.lifecycle,
          totalSats: 999,
        },
      })
    ).toBeNull()
    expect(
      assessCheckoutSparkBuyerSettlement({
        ...input,
        settlement: {
          ...value.settlement,
          planDigest: "f".repeat(64),
        },
      })
    ).toBeNull()
    expect(
      assessCheckoutSparkBuyerSettlement({
        ...input,
        settlement: {
          ...value.settlement,
          credit: null,
        },
      })
    ).toBeNull()
    expect(
      assessCheckoutSparkBuyerSettlement({
        ...input,
        snapshot: {
          status: "retired",
          planDigest: value.plan.planDigest,
          retiredAt: NOW + 10_000,
        },
      })
    ).toBeNull()
  })

  it("keys one atomic legacy-active read by exact account and bindings", async () => {
    const value = fixture()
    let loads = 0
    const repository = {
      loadBuyerSettlement: async (
        checkoutId: string,
        planDigest: string,
        buyerPubkey: string
      ) => {
        loads += 1
        expect([checkoutId, planDigest, buyerPubkey]).toEqual([
          value.plan.checkoutId,
          value.plan.planDigest,
          BUYER,
        ])
        return value.active
      },
    }
    const input = {
      enabled: true,
      lifecycles: [value.lifecycle],
      buyerPubkey: BUYER,
      authGeneration: 3,
      isAuthGenerationCurrent: (generation: number) => generation === 3,
      repository,
    }
    const options = getCheckoutSparkBuyerSettlementQueryOptions(input)
    const control = new AbortController()
    const data = await options.queryFn({ signal: control.signal } as Parameters<
      typeof options.queryFn
    >[0])
    expect(data.get(value.plan.orderId)?.commerceVerified).toBe(false)
    expect(loads).toBe(1)
    expect(NO_BUYER_CHECKOUT_SPARK_SETTLEMENTS.size).toBe(0)
    expect(
      getCheckoutSparkBuyerSettlementQueryOptions({
        ...input,
        lifecycles: [{ ...value.lifecycle, totalSats: 999 }],
      }).queryKey
    ).not.toEqual(options.queryKey)
    expect(
      getCheckoutSparkBuyerSettlementQueryOptions({
        ...input,
        buyerPubkey: null,
      }).enabled
    ).toBe(false)
  })

  it("cancels an atomic read on account switch before publishing its result", async () => {
    const value = fixture()
    let finish!: (
      snapshot: CheckoutSparkBuyerSettlementRepositorySnapshot
    ) => void
    let current = true
    let reads = 0
    const held = new Promise<CheckoutSparkBuyerSettlementRepositorySnapshot>(
      (resolve) => {
        finish = resolve
      }
    )
    const options = getCheckoutSparkBuyerSettlementQueryOptions({
      enabled: true,
      lifecycles: [value.lifecycle],
      buyerPubkey: BUYER,
      authGeneration: 1,
      isAuthGenerationCurrent: () => current,
      repository: {
        loadBuyerSettlement: () => {
          reads += 1
          return held
        },
      },
    })
    const control = new AbortController()
    const pending = options.queryFn({ signal: control.signal } as Parameters<
      typeof options.queryFn
    >[0])
    current = false
    finish(value.active)
    await expect(pending).rejects.toHaveProperty("name", "AbortError")
    expect(reads).toBe(1)

    const aborted = new AbortController()
    aborted.abort()
    await expect(
      options.queryFn({ signal: aborted.signal } as Parameters<
        typeof options.queryFn
      >[0])
    ).rejects.toHaveProperty("name", "AbortError")
    expect(reads).toBe(1)
  })

  it("does not read on a manual refetch when disabled or already switched", async () => {
    const value = fixture()
    let reads = 0
    const input = {
      enabled: false,
      lifecycles: [value.lifecycle],
      buyerPubkey: BUYER,
      authGeneration: 1,
      isAuthGenerationCurrent: () => true,
      repository: {
        loadBuyerSettlement: async () => {
          reads += 1
          return value.active
        },
      },
    }
    const disabled = getCheckoutSparkBuyerSettlementQueryOptions(input)
    expect(disabled.enabled).toBe(false)
    await expect(
      disabled.queryFn({ signal: new AbortController().signal } as Parameters<
        typeof disabled.queryFn
      >[0])
    ).rejects.toHaveProperty("name", "AbortError")
    const switched = getCheckoutSparkBuyerSettlementQueryOptions({
      ...input,
      enabled: true,
      isAuthGenerationCurrent: () => false,
    })
    expect(switched.enabled).toBe(false)
    await expect(
      switched.queryFn({ signal: new AbortController().signal } as Parameters<
        typeof switched.queryFn
      >[0])
    ).rejects.toHaveProperty("name", "AbortError")
    expect(reads).toBe(0)
  })

  it("drops a cancelled settlement read before publishing its result", async () => {
    const value = fixture()
    let finish!: (
      snapshot: CheckoutSparkBuyerSettlementRepositorySnapshot
    ) => void
    const held = new Promise<CheckoutSparkBuyerSettlementRepositorySnapshot>(
      (resolve) => {
        finish = resolve
      }
    )
    const options = getCheckoutSparkBuyerSettlementQueryOptions({
      enabled: true,
      lifecycles: [value.lifecycle],
      buyerPubkey: BUYER,
      authGeneration: 1,
      isAuthGenerationCurrent: () => true,
      repository: {
        loadBuyerSettlement: () => held,
      },
    })
    const controller = new AbortController()
    const pending = options.queryFn({ signal: controller.signal } as Parameters<
      typeof options.queryFn
    >[0])
    await Promise.resolve()
    controller.abort()
    finish(value.active)
    await expect(pending).rejects.toHaveProperty("name", "AbortError")
  })
})

describe("buyer-local retained Spark settlement", () => {
  function retiredFixture() {
    const value = fixture()
    const settlement = {
      ...value.settlement,
      paidLegs: [value.paid("merchant"), value.paid("supplier")],
    }
    return {
      ...value,
      input: {
        lifecycle: value.lifecycle,
        buyerPubkey: BUYER,
        buyerBinding: value.buyerBinding,
        summary: value.summary,
        settlement,
      },
    }
  }

  it("verifies retained required payouts without needing the optional fee", () => {
    const { input, paid } = retiredFixture()
    expect(assessCheckoutSparkRetiredBuyerSettlement(input)).toEqual({
      commerceVerified: true,
      merchantVerified: true,
      feePending: true,
      recipientUnverified: false,
      receipt: expectedReceipt(input.summary, ["merchant", "supplier"]),
    })
    expect(
      assessCheckoutSparkRetiredBuyerSettlement({
        ...input,
        settlement: {
          ...input.settlement,
          paidLegs: [...input.settlement.paidLegs, paid("conduit")],
        },
      })
    ).toEqual({
      commerceVerified: true,
      merchantVerified: true,
      feePending: false,
      recipientUnverified: false,
      receipt: expectedReceipt(input.summary, [
        "merchant",
        "supplier",
        "conduit",
      ]),
    })
  })

  it("does not promote a summary, generic paid label, or incomplete provider facts", () => {
    const { input, paid } = retiredFixture()
    for (const missing of [
      { summary: null },
      { buyerBinding: null },
      { settlement: null },
    ]) {
      expect(
        assessCheckoutSparkRetiredBuyerSettlement({
          ...input,
          lifecycle: { ...input.lifecycle, paymentStatus: "paid" },
          ...missing,
        })
      ).toBeNull()
    }
    for (const settlement of [
      { ...input.settlement, paidLegs: [] },
      { ...input.settlement, paidLegs: [paid("merchant")] },
      { ...input.settlement, credit: null },
    ]) {
      expect(
        assessCheckoutSparkRetiredBuyerSettlement({
          ...input,
          settlement,
        })?.commerceVerified
      ).toBe(false)
    }
    expect(
      assessCheckoutSparkRetiredBuyerSettlement({
        ...input,
        settlement: { ...input.settlement, credit: null },
      })
    ).toEqual({
      commerceVerified: false,
      merchantVerified: true,
      feePending: false,
      recipientUnverified: false,
      receipt: null,
    })
    expect(
      assessCheckoutSparkRetiredBuyerSettlement({
        ...input,
        settlement: {
          ...input.settlement,
          credit: null,
          paidLegs: [{ ...paid("merchant"), transferId: "different-transfer" }],
        },
      })
    ).toBeNull()
  })

  it("requires the current signed-in delivered private SATS order and every lifecycle identity", () => {
    const { input } = retiredFixture()
    for (const buyerPubkey of [null, MERCHANT, "invalid"]) {
      expect(
        assessCheckoutSparkRetiredBuyerSettlement({ ...input, buyerPubkey })
      ).toBeNull()
    }
    for (const lifecycle of [
      null,
      { ...input.lifecycle, buyerPubkey: MERCHANT },
      { ...input.lifecycle, buyerIdentityKind: "guest_ephemeral" as const },
      { ...input.lifecycle, checkoutMode: "pay_later" as const },
      { ...input.lifecycle, orderDeliveryStatus: "pending" as const },
      { ...input.lifecycle, currency: "USD" },
      { ...input.lifecycle, orderId: "other-order" },
      { ...input.lifecycle, merchantPubkey: SUPPLIER },
      { ...input.lifecycle, totalSats: 999 },
      { ...input.lifecycle, checkoutSparkRouterBinding: undefined },
      ...[
        { checkoutId: "other-checkout" },
        { planDigest: "f".repeat(64) },
        { walletId: "other-wallet" },
      ].map((change) => ({
        ...input.lifecycle,
        checkoutSparkRouterBinding: {
          ...input.lifecycle.checkoutSparkRouterBinding!,
          ...change,
        },
      })),
    ]) {
      expect(
        assessCheckoutSparkRetiredBuyerSettlement({ ...input, lifecycle })
      ).toBeNull()
    }
  })

  it("rejects every retained buyer-binding or summary identity mismatch", () => {
    const { input } = retiredFixture()
    const identityChanges = [
      { checkoutId: "other-checkout" },
      { planDigest: "f".repeat(64) },
      { orderId: "other-order" },
      { merchantPubkey: SUPPLIER },
      { walletId: "other-wallet" },
      { commerceTotalSats: 999 },
    ]
    for (const change of [...identityChanges, { buyerPubkey: MERCHANT }]) {
      expect(
        assessCheckoutSparkRetiredBuyerSettlement({
          ...input,
          buyerBinding: { ...input.buyerBinding, ...change },
        })
      ).toBeNull()
    }
    for (const change of identityChanges) {
      expect(
        assessCheckoutSparkRetiredBuyerSettlement({
          ...input,
          summary: { ...input.summary, ...change },
        })
      ).toBeNull()
    }
  })

  it("rejects record identity, credit, leg, and frozen-allocation mismatches", () => {
    const { input } = retiredFixture()
    for (const change of [
      { checkoutId: "other-checkout" },
      { planDigest: "f".repeat(64) },
      { orderId: "other-order" },
      { merchantPubkey: SUPPLIER },
      { merchantLegId: input.settlement.feeLegId },
      { feeLegId: input.settlement.merchantLegId },
      { requiredCommerceLegIds: [input.settlement.merchantLegId] },
      { credit: { ...input.settlement.credit!, transferId: "other-transfer" } },
      { credit: { ...input.settlement.credit!, creditedSats: 1_112 } },
      {
        paidLegs: [{ ...input.settlement.paidLegs[0]!, allocationSats: 9_999 }],
      },
      {
        paidLegs: [
          { ...input.settlement.paidLegs[0]!, transferId: "other-transfer" },
        ],
      },
      {
        paidLegs: [{ ...input.settlement.paidLegs[0]!, legId: "f".repeat(64) }],
      },
    ]) {
      expect(
        assessCheckoutSparkRetiredBuyerSettlement({
          ...input,
          settlement: { ...input.settlement, ...change },
        })
      ).toBeNull()
    }
    expect(
      assessCheckoutSparkRetiredBuyerSettlement({
        ...input,
        summary: { ...input.summary, credit: null },
      })
    ).toBeNull()
    expect(
      assessCheckoutSparkRetiredBuyerSettlement({
        ...input,
        summary: { ...input.summary, legs: [input.summary.legs[0]!] },
      })
    ).toBeNull()
  })

  it("projects an atomic retired result and ignores missing legacy history", async () => {
    const { input } = retiredFixture()
    let snapshot: CheckoutSparkBuyerSettlementRepositorySnapshot = {
      status: "retired",
      buyerBinding: input.buyerBinding,
      summary: input.summary,
      settlement: input.settlement,
    }
    const options = getCheckoutSparkBuyerSettlementQueryOptions({
      enabled: true,
      lifecycles: [input.lifecycle],
      buyerPubkey: BUYER,
      authGeneration: 1,
      isAuthGenerationCurrent: () => true,
      repository: { loadBuyerSettlement: async () => snapshot },
    })
    const context = { signal: new AbortController().signal } as Parameters<
      typeof options.queryFn
    >[0]
    expect(
      (await options.queryFn(context)).get(input.lifecycle.orderId)
    ).toEqual({
      commerceVerified: true,
      merchantVerified: true,
      feePending: true,
      recipientUnverified: false,
      receipt: expectedReceipt(input.summary, ["merchant", "supplier"]),
    })
    snapshot = { status: "absent" }
    expect((await options.queryFn(context)).size).toBe(0)
  })
})

describe("same-tab guest Spark provider settlement", () => {
  function guestFixture() {
    const value = fixture()
    const signer = NDKPrivateKeySigner.generate()
    const guestIdentity: GuestOrderSigningIdentity = {
      kind: "guest_ephemeral",
      orderId: value.plan.orderId,
      merchantPubkey: MERCHANT,
      pubkey: signer.pubkey,
      signer,
      createdAt: NOW - 1_000,
      expiresAt: NOW - 1_000 + GUEST_ORDER_SESSION_TTL_MS,
    }
    const lifecycle: OrderLifecycle = {
      ...value.lifecycle,
      buyerPubkey: guestIdentity.pubkey,
      buyerIdentityKind: "guest_ephemeral",
      createdAt: NOW + 1,
      guestSessionExpiresAt: guestIdentity.expiresAt,
    }
    const settlement = {
      ...value.settlement,
      paidLegs: [value.paid("merchant"), value.paid("supplier")],
    }
    const buyerBinding = {
      ...value.buyerBinding,
      buyerPubkey: guestIdentity.pubkey,
    }
    const input = {
      lifecycle,
      buyerPubkey: guestIdentity.pubkey,
      guestIdentity,
      now: NOW + 2,
      snapshot: value.snapshot,
      settlement,
      buyerBinding,
      summary: value.summary,
    }
    const active: CheckoutSparkBuyerSettlementRepositorySnapshot = {
      ...value.active,
      status: "active",
      state:
        value.snapshot.status === "active"
          ? value.snapshot.state
          : neverActive(),
      settlement,
      buyerBinding,
    }
    return { ...value, input, active, guestIdentity }
  }

  function neverActive(): never {
    throw new Error("Expected active fixture")
  }

  it("projects active and retired exact provider facts only for the current guest order", () => {
    const { input, paid } = guestFixture()
    for (const assess of [
      assessCheckoutSparkBuyerSettlement,
      assessCheckoutSparkRetiredBuyerSettlement,
    ]) {
      expect(assess(input)).toEqual({
        commerceVerified: true,
        merchantVerified: true,
        feePending: true,
        recipientUnverified: false,
        receipt: expectedReceipt(input.summary, ["merchant", "supplier"]),
      })
      expect(assess({ ...input, settlement: null })).toBeNull()
      expect(
        assess({
          ...input,
          lifecycle: { ...input.lifecycle, paymentStatus: "paid" },
          settlement: { ...input.settlement, paidLegs: [paid("merchant")] },
        })?.commerceVerified
      ).toBe(false)
    }
  })

  it.each([
    "missing_identity",
    "order",
    "merchant",
    "pubkey",
    "signer",
    "future",
    "expired",
    "extended",
    "deadline",
    "missing_deadline",
    "future_order",
    "order_before_key",
    "shipping",
    "contact",
    "guest_contact",
    "signed_in",
  ] as const)(
    "rejects %s guest authority for active and retired projection",
    (change) => {
      const { input } = guestFixture()
      const changed = {
        ...input,
        lifecycle: { ...input.lifecycle },
        guestIdentity: {
          ...input.guestIdentity,
        } as GuestOrderSigningIdentity | null,
      }
      if (change === "missing_identity") changed.guestIdentity = null
      else if (change === "order")
        changed.guestIdentity!.orderId = "other-order"
      else if (change === "merchant")
        changed.guestIdentity!.merchantPubkey = SUPPLIER
      else if (change === "pubkey") changed.guestIdentity!.pubkey = BUYER
      else if (change === "signer")
        changed.guestIdentity!.signer = NDKPrivateKeySigner.generate()
      else if (change === "future") {
        changed.guestIdentity!.createdAt = NOW + 3
        changed.guestIdentity!.expiresAt = NOW + 3 + GUEST_ORDER_SESSION_TTL_MS
        changed.lifecycle.guestSessionExpiresAt =
          changed.guestIdentity!.expiresAt
      } else if (change === "expired")
        changed.now = input.guestIdentity.expiresAt
      else if (change === "extended") {
        changed.guestIdentity!.expiresAt += 1
        changed.lifecycle.guestSessionExpiresAt =
          changed.guestIdentity!.expiresAt
      } else if (change === "deadline")
        changed.lifecycle.guestSessionExpiresAt! += 1
      else if (change === "missing_deadline")
        delete changed.lifecycle.guestSessionExpiresAt
      else if (change === "future_order") changed.lifecycle.createdAt = NOW + 3
      else if (change === "order_before_key")
        changed.lifecycle.createdAt = input.guestIdentity.createdAt - 1
      else if (change === "shipping")
        Object.assign(changed.lifecycle, { shippingAddress: {} })
      else if (change === "contact")
        changed.lifecycle.contactNote = "synthetic note"
      else if (change === "guest_contact")
        Object.assign(changed.lifecycle, { guestContact: {} })
      else changed.lifecycle.buyerIdentityKind = "signed_in"
      expect(assessCheckoutSparkBuyerSettlement(changed)).toBeNull()
      expect(assessCheckoutSparkRetiredBuyerSettlement(changed)).toBeNull()
    }
  )

  it("reads only the exact guest order and keeps signer material out of the query key", async () => {
    const value = guestFixture()
    let reads = 0
    const options = getCheckoutSparkBuyerSettlementQueryOptions({
      enabled: true,
      buyerPubkey: value.guestIdentity.pubkey,
      guestIdentity: value.guestIdentity,
      currentGuestIdentity: () => value.guestIdentity,
      now: () => NOW + 2,
      authGeneration: 1,
      isAuthGenerationCurrent: () => true,
      lifecycles: [
        value.input.lifecycle,
        { ...value.input.lifecycle, orderId: "other-order" },
        {
          ...value.input.lifecycle,
          orderId: "signed-order",
          buyerIdentityKind: "signed_in",
        },
      ],
      repository: {
        loadBuyerSettlement: async () => {
          reads += 1
          return value.active
        },
      },
    })
    expect(options.enabled).toBe(true)
    const result = await options.queryFn({
      signal: new AbortController().signal,
    } as Parameters<typeof options.queryFn>[0])
    expect(reads).toBe(1)
    expect(result.size).toBe(1)
    expect(result.get(value.plan.orderId)?.commerceVerified).toBe(true)
    expect(JSON.stringify(options.queryKey)).not.toContain("signer")
  })

  it.each(["missing_registry", "expired", "wrong_order", "signed_in"] as const)(
    "does not read for %s guest query authority",
    async (change) => {
      const value = guestFixture()
      let reads = 0
      const options = getCheckoutSparkBuyerSettlementQueryOptions({
        enabled: true,
        buyerPubkey: value.guestIdentity.pubkey,
        guestIdentity: value.guestIdentity,
        currentGuestIdentity:
          change === "missing_registry" ? undefined : () => value.guestIdentity,
        now: () =>
          change === "expired" ? value.guestIdentity.expiresAt : NOW + 2,
        authGeneration: 1,
        isAuthGenerationCurrent: () => true,
        lifecycles: [
          {
            ...value.input.lifecycle,
            ...(change === "wrong_order" ? { orderId: "other-order" } : {}),
            ...(change === "signed_in"
              ? { buyerIdentityKind: "signed_in" as const }
              : {}),
          },
        ],
        repository: {
          loadBuyerSettlement: async () => {
            reads += 1
            return value.active
          },
        },
      })
      expect(options.enabled).toBe(false)
      await expect(
        options.queryFn({ signal: new AbortController().signal } as Parameters<
          typeof options.queryFn
        >[0])
      ).rejects.toHaveProperty("name", "AbortError")
      expect(reads).toBe(0)
    }
  )

  it.each(["expired", "revoked", "replaced", "generation"] as const)(
    "discards a held guest result after authority is %s",
    async (change) => {
      const value = guestFixture()
      let current: GuestOrderSigningIdentity | null = value.guestIdentity
      let now = NOW + 2
      let generationCurrent = true
      let finish!: (
        snapshot: CheckoutSparkBuyerSettlementRepositorySnapshot
      ) => void
      const held = new Promise<CheckoutSparkBuyerSettlementRepositorySnapshot>(
        (resolve) => {
          finish = resolve
        }
      )
      const options = getCheckoutSparkBuyerSettlementQueryOptions({
        enabled: true,
        buyerPubkey: value.guestIdentity.pubkey,
        guestIdentity: value.guestIdentity,
        currentGuestIdentity: () => current,
        now: () => now,
        authGeneration: 1,
        isAuthGenerationCurrent: () => generationCurrent,
        lifecycles: [value.input.lifecycle],
        repository: { loadBuyerSettlement: () => held },
      })
      const pending = options.queryFn({
        signal: new AbortController().signal,
      } as Parameters<typeof options.queryFn>[0])
      if (change === "expired") now = value.guestIdentity.expiresAt
      else if (change === "revoked") current = null
      else if (change === "generation") generationCurrent = false
      else
        current = {
          ...value.guestIdentity,
          createdAt: value.guestIdentity.createdAt + 1,
          expiresAt: value.guestIdentity.expiresAt + 1,
        }
      finish(value.active)
      await expect(pending).rejects.toHaveProperty("name", "AbortError")
    }
  )
})
