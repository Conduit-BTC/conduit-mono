import {
  createCheckoutSparkMerchantOrderWitness,
  createCheckoutSparkMerchantSettlementRecord,
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledPlan,
  getSparkCheckoutReceiveFundingTimeAnchor,
  proveSparkCheckoutReceiveCredit,
  recordCheckoutSparkMerchantCredit,
  type CheckoutSparkSettledRecoveryPayload,
  type SparkCheckoutReceiveCreditProofInput,
} from "@conduit/core"
import { CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY } from "@conduit/core/protocol/checkout-spark-commerce-pricing"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "@conduit/core/protocol/checkout-spark-pricing-authority-server"
import { describe, expect, it, spyOn } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { observeMerchantCheckoutSparkOrder } from "../apps/merchant/src/lib/checkout-spark-order-observation"
import { assertCheckoutSparkMerchantPricingAuthority } from "../apps/merchant/src/lib/checkout-spark-pricing-authority"
import { preparedSettledLegState } from "./support/checkout-spark-settled-leg-fixture"
import { settlementInvoice } from "./support/checkout-spark-settlement-model-fixture"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const BUYER = "b".repeat(64)
const RATE_KEY = `${"0".repeat(63)}1`
const TRUST = new Map([
  [
    "merchant-pricing-test",
    getCheckoutSparkPricingAuthorityPublicKey(RATE_KEY)!,
  ],
])
let fixtureSequence = 0
type Dependencies = NonNullable<
  Parameters<typeof observeMerchantCheckoutSparkOrder>[3]
>

function fixture(version: 1 | 2 = 2) {
  const base = preparedSettledLegState().plan
  // Distinct provider precision prevents one case borrowing the historical cache.
  const acceptedAtMs = base.createdAt + ++fixtureSequence
  const product = finalizeEvent(
    {
      kind: 30_402,
      created_at: base.createdAt / 1_000,
      tags: [
        ["d", "merchant-pricing"],
        ["title", "Synthetic fiat product"],
        ["price", "1", "EUR"],
        ["type", "simple", "digital"],
      ],
      content: "Synthetic merchant pricing fixture",
    },
    MERCHANT_SECRET
  )
  const profile = finalizeEvent(
    {
      kind: 0,
      created_at: base.createdAt / 1_000,
      tags: [],
      content: JSON.stringify({ lud16: "merchant@example.test" }),
    },
    MERCHANT_SECRET
  )
  const rate = {
    rate: 110_000,
    source: "coinbase" as const,
    fetchedAt: base.createdAt,
    fiatUsdRates: { EUR: 1.1 },
    fiatSource: "ecb" as const,
    fiatSources: { EUR: "ecb" as const },
  }
  const pricing =
    version === 2
      ? {
          version: 2 as const,
          policy: CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY,
          rate,
        }
      : { version: 1 as const, rate }
  const plan = freezeCheckoutSparkSettledPlan({
    ...base,
    merchantPubkey: MERCHANT,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:merchant-pricing`,
          productEventId: product.id,
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
          sourcePrice: {
            amount: 1,
            currency: "EUR",
            normalizedCurrency: "EUR",
          },
        },
      ],
      pricing,
      ...(version === 1
        ? {
            pricingAuthority: createCheckoutSparkPricingRateAttestation({
              rate,
              keyId: "merchant-pricing-test",
              privateKeyHex: RATE_KEY,
              issuedAtMs: base.createdAt,
            }),
          }
        : {}),
    },
    recipients: base.recipients.map((recipient) =>
      recipient.kind !== "merchant"
        ? recipient
        : {
            ...recipient,
            recipientId: MERCHANT,
            destination: {
              type: "lightning_address",
              value: "merchant@example.test",
              source: {
                type: "signed_profile",
                profileEventId: profile.id,
                profileEventCreatedAt: profile.created_at,
              },
            },
          }
    ),
  })
  const sources = [product, profile]
  const witness = createCheckoutSparkMerchantOrderWitness(
    plan,
    {
      buyerPubkey: BUYER,
      merchantPubkey: MERCHANT,
      orderId: plan.orderId,
      rumorId: "c".repeat(64),
      contentHash: "d".repeat(64),
      orderCreatedAt: plan.createdAt,
      commerceTotalSats: plan.commerceQuote.commerceTotalSats,
      pricing: plan.commerceQuote.pricing,
      pricingAuthority: plan.commerceQuote.pricingAuthority,
      lines: plan.commerceQuote.lines.map((line) => ({
        ...line,
        sourcePriceAmount: line.sourcePrice!.amount,
        sourcePriceCurrency: line.sourcePrice!.normalizedCurrency,
      })),
    },
    BUYER,
    sources
  )
  if (!witness)
    throw new Error("Synthetic merchant order witness was not admitted")
  const proofInput: SparkCheckoutReceiveCreditProofInput = {
    expectedRequest: {
      id: plan.funding.requestId,
      network: plan.network,
      ...plan.funding,
    },
    expectedReceive: { mode: "ordinary_v3" },
    walletIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    receive: {
      id: plan.funding.requestId,
      status: "TRANSFER_COMPLETED",
      network: "MAINNET",
      invoice: {
        encodedInvoice: plan.funding.paymentRequest,
        bitcoinNetwork: "MAINNET",
        paymentHash: plan.funding.paymentHash,
        amount: {
          originalValue: plan.funding.grossFundingSats,
          originalUnit: "SATOSHI",
        },
        createdAt: new Date(acceptedAtMs).toISOString(),
        expiresAt: new Date(
          acceptedAtMs + plan.funding.expiresAt - plan.createdAt
        ).toISOString(),
      },
      transfer: {
        sparkId: "merchant-funding-transfer",
        userRequestId: plan.funding.requestId,
        totalAmount: { originalValue: 1_111, originalUnit: "SATOSHI" },
      },
    },
    transfer: {
      id: "merchant-funding-transfer",
      status: "TRANSFER_STATUS_COMPLETED",
      totalValue: 1_111,
      transferDirection: "INCOMING",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      userRequest: { id: plan.funding.requestId },
    },
  }
  const proof = proveSparkCheckoutReceiveCredit(proofInput)
  const state = createCheckoutSparkSettledReconciliation(plan)
  const payload: CheckoutSparkSettledRecoveryPayload = {
    schemaVersion: 2,
    type: "checkout_spark_recovery",
    handoffId: "e".repeat(64),
    senderPubkey: BUYER,
    merchantPubkey: MERCHANT,
    preparedAt: plan.createdAt + 1_000,
    plan,
    state,
    sourceEvents: sources,
    wallet: {
      providerId: "spark",
      walletId: plan.walletId,
      network: plan.network,
      accountNumber: 0,
      mnemonic: "unused synthetic query-only fixture",
    },
  }
  const candidate = {
    wrapId: "f".repeat(64),
    schemaVersion: 2 as const,
    checkoutId: plan.checkoutId,
    orderId: plan.orderId,
    planDigest: plan.planDigest,
    takeoverAt: plan.takeoverAt,
    preparedAt: payload.preparedAt,
  }
  const calls = { credit: 0, payout: 0, receive: 0, transfer: 0, cleanup: 0 }
  let active = true
  const assertActive = () => {
    if (!active) throw new Error("Synthetic merchant session revoked")
  }
  let settlement = createCheckoutSparkMerchantSettlementRecord(plan)
  const dependencies: Dependencies = {
    now: () => plan.takeoverAt + 1_000,
    repository: {
      load: async () => ({ status: "active", revision: 1, state }),
      loadMerchantOrderWitness: async () => witness,
      loadMerchantPlanSourceEvents: async () => sources,
      recordMerchantCredit: async (currentPlan, currentProof, at) => {
        calls.credit++
        settlement = recordCheckoutSparkMerchantCredit(
          settlement,
          currentPlan,
          currentProof,
          at
        )
        return settlement
      },
      recordMerchantPayout: async () => {
        calls.payout++
        throw new Error("Unexpected payout mutation")
      },
      loadMerchantSettlement: async () => settlement,
    },
    consumeRecovery: async (_principal, selected, adapter) => {
      await adapter.consume(payload, assertActive)
      return {
        status: "consumed",
        coverage: "complete",
        discoveryCoverage: "complete",
        declarationState: "declared",
        candidate: selected,
      }
    },
    openObservationWallet: async () => ({
      getIdentityPublicKey: async () => plan.funding.receiverIdentityPublicKey,
      getLightningReceiveRequest: async () => {
        calls.receive++
        return proofInput.receive
      },
      getTransfer: async () => {
        calls.transfer++
        return proofInput.transfer
      },
      cleanup: async () => {
        calls.cleanup++
      },
    }),
  }
  return {
    plan,
    proof,
    acceptedAtMs,
    calls,
    revoke: () => {
      active = false
    },
    observe: () =>
      observeMerchantCheckoutSparkOrder(
        MERCHANT,
        candidate,
        assertActive,
        dependencies
      ),
  }
}

function historicalHttp(
  options: { unavailable?: boolean; gate?: Promise<void> } = {}
) {
  const hosts: string[] = []
  let started!: () => void
  const requested = new Promise<void>((resolve) => {
    started = resolve
  })
  const mock = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    hosts.push(url.hostname)
    started()
    await options.gate
    if (options.unavailable) return new Response(null, { status: 503 })
    if (url.hostname === "api.exchange.coinbase.com")
      return Response.json([
        [
          Date.parse(url.searchParams.get("start")!) / 1_000,
          109_000,
          111_000,
          110_000,
          110_000,
          1,
        ],
      ])
    if (url.hostname === "api.frankfurter.dev")
      return Response.json([
        {
          date: url.searchParams.get("date"),
          base: "EUR",
          quote: "USD",
          rate: 1.1,
        },
      ])
    throw new Error("Unexpected merchant pricing HTTP")
  })
  return { hosts, requested, restore: () => mock.mockRestore() }
}

describe("merchant invoice-anchored pricing", () => {
  it("records independently verified historical credit through the query-only observer", async () => {
    const f = fixture()
    const http = historicalHttp()
    try {
      expect(
        getSparkCheckoutReceiveFundingTimeAnchor(f.proof)?.createdAtMs
      ).toBe(f.acceptedAtMs)
      expect(await f.observe()).toBe("pending")
      expect(http.hosts.sort()).toEqual([
        "api.exchange.coinbase.com",
        "api.frankfurter.dev",
      ])
      expect(f.calls).toEqual({
        credit: 1,
        payout: 0,
        receive: 1,
        transfer: 1,
        cleanup: 1,
      })
    } finally {
      http.restore()
    }
  })

  it("keeps merchant observation unavailable without credit or payout writes when historical providers fail", async () => {
    const f = fixture()
    const http = historicalHttp({ unavailable: true })
    try {
      const status = await f.observe()
      expect(f.calls).toEqual({
        credit: 0,
        payout: 0,
        receive: 1,
        transfer: 1,
        cleanup: 1,
      })
      expect(status).toBe("unavailable")
      expect(http.hosts.sort()).toEqual([
        "api.exchange.coinbase.com",
        "api.frankfurter.dev",
      ])
    } finally {
      http.restore()
    }
  })

  it("prevents merchant writes after session revocation during a successful historical HTTP read", async () => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const http = historicalHttp({ gate })
    try {
      const observing = f.observe()
      await http.requested
      f.revoke()
      release()
      await expect(observing).rejects.toThrow("session revoked")
      expect(http.hosts.sort()).toEqual([
        "api.exchange.coinbase.com",
        "api.frankfurter.dev",
      ])
      expect(f.calls).toEqual({
        credit: 0,
        payout: 0,
        receive: 1,
        transfer: 1,
        cleanup: 1,
      })
    } finally {
      release()
      http.restore()
    }
  })

  it("verifies the original signed-v1 merchant quote with retained keys and no Worker or historical HTTP", async () => {
    const f = fixture(1)
    const http = historicalHttp({ unavailable: true })
    try {
      await assertCheckoutSparkMerchantPricingAuthority({
        plan: f.plan,
        fundingProof: f.proof,
        trustedPublicKeys: TRUST,
      })
      expect(http.hosts).toEqual([])
    } finally {
      http.restore()
    }
  })

  it.each(["request", "invoice_time"] as const)(
    "rejects a valid receive proof bound to a different %s before HTTP",
    async (binding) => {
      const f = fixture()
      const shiftedAt = f.plan.createdAt + 1_000
      const plan = freezeCheckoutSparkSettledPlan({
        ...f.plan,
        ...(binding === "invoice_time" ? { createdAt: shiftedAt } : {}),
        funding: {
          ...f.plan.funding,
          ...(binding === "request"
            ? { requestId: "other-receive" }
            : {
                createdAt: shiftedAt,
                expiresAt: f.plan.funding.expiresAt + 1_000,
                paymentRequest: settlementInvoice(
                  f.plan.funding.grossFundingSats,
                  new Uint8Array(32).fill(3),
                  shiftedAt
                ),
              }),
        },
      })
      const http = historicalHttp()
      try {
        await expect(
          assertCheckoutSparkMerchantPricingAuthority({
            plan,
            fundingProof: f.proof,
          })
        ).rejects.toThrow("Payment remains paused")
        expect(http.hosts).toEqual([])
      } finally {
        http.restore()
      }
    }
  )
})
