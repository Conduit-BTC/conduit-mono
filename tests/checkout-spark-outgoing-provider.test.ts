import { createHash } from "node:crypto"
import { describe, expect, it } from "bun:test"

import {
  freezeCheckoutSparkPlan,
  type CheckoutSparkOutgoingTarget,
} from "@conduit/core"

import { createCheckoutSparkOutgoingProvider } from "../apps/market/src/lib/checkout-spark-outgoing-provider"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const CREATED_AT = 1_800_000_000_000
const PREIMAGE = "11".repeat(32)
const PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(PREIMAGE, "hex"))
  .digest("hex")
const INVOICE = makeSignedBolt11Fixture({
  hrp: "lnbc10n",
  fields: [
    bolt11PaymentHashField(Buffer.from(PAYMENT_HASH, "hex")),
    bolt11PaymentSecretField(),
    bolt11PlainDescriptionField(),
  ],
})

function fixture() {
  const merchantPubkey = "a".repeat(64)
  const plan = freezeCheckoutSparkPlan({
    checkoutId: "checkout-provider-1",
    orderId: "order-provider-1",
    merchantPubkey,
    walletId: "wallet-provider-1",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    funding: {
      requestId: "receive-provider-1",
      paymentRequest: "lnbc-funding",
      paymentHash: "b".repeat(64),
      requiredNetSats: 1_235,
      grossFundingSats: 1_240,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 60_000,
    },
    obligations: [
      {
        kind: "merchant",
        recipientId: merchantPubkey,
        paymentRequest: INVOICE,
        amountSats: 1_000,
        maxFeeSats: 100,
      },
      {
        kind: "conduit",
        recipientId: "conduit-test-endpoint",
        paymentRequest: "lnbc-conduit",
        amountSats: 111,
        maxFeeSats: 24,
      },
    ],
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${merchantPubkey}:provider-fixture`,
          productEventId: "d".repeat(64),
          merchantPubkey,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
  })
  const target: CheckoutSparkOutgoingTarget = {
    walletId: plan.walletId,
    network: plan.network,
    obligation: plan.obligations[0]!,
    idempotencyKey: plan.obligations[0]!.outgoingId,
  }
  return { plan, target }
}

function manager(
  overrides: Partial<
    Parameters<typeof createCheckoutSparkOutgoingProvider>[0]["manager"]
  > = {}
): Parameters<typeof createCheckoutSparkOutgoingProvider>[0]["manager"] {
  return {
    reconcileInvoiceAttempt: async () => ({ status: "not_found" }),
    preflightCheckoutLightningObligation: async () => "ready",
    sendCheckoutLightningObligation: async () => ({ status: "ambiguous" }),
    ...overrides,
  }
}

describe("Spark checkout outgoing provider adapter", () => {
  it("uses the frozen invoice and transfer ID for every provider operation", async () => {
    const { plan, target } = fixture()
    const attempts: string[] = []
    const provider = createCheckoutSparkOutgoingProvider({
      plan,
      manager: manager({
        reconcileInvoiceAttempt: async (walletId, attempt) => {
          expect(walletId).toBe(plan.walletId)
          expect(attempt.transferId).toBe(target.idempotencyKey)
          expect(attempt.paymentRequest).toBe(INVOICE)
          expect(attempt.amountSats).toBe(1_000)
          attempts.push("reconcile")
          return { status: "not_found" }
        },
        preflightCheckoutLightningObligation: async (walletId, request) => {
          expect(walletId).toBe(plan.walletId)
          expect(request.transferId).toBe(target.idempotencyKey)
          attempts.push("preflight")
          return "ready"
        },
        sendCheckoutLightningObligation: async (walletId, request) => {
          expect(walletId).toBe(plan.walletId)
          expect(request.transferId).toBe(target.idempotencyKey)
          attempts.push("send")
          return { status: "ambiguous" }
        },
      }),
    })

    expect((await provider.reconcile(target)).state).toBe("not_found")
    expect(await provider.preflight(target)).toBe("ready")
    expect((await provider.send(target)).state).toBe("ambiguous")
    expect(attempts).toEqual(["reconcile", "preflight", "send"])
  })

  it("maps exact settled history but never promotes a malformed paid response", async () => {
    const { plan, target } = fixture()
    const paid = {
      id: "provider-request-1",
      status: "completed" as const,
      fees: 4n,
      details: {
        type: "lightning",
        htlcDetails: { preimage: PREIMAGE, paymentHash: PAYMENT_HASH },
      },
    }
    const provider = createCheckoutSparkOutgoingProvider({
      plan,
      manager: manager({
        reconcileInvoiceAttempt: async () => ({
          status: "resolved",
          payment: paid,
        }),
      }),
    })
    expect((await provider.reconcile(target)).state).toBe("paid")

    const badFee = createCheckoutSparkOutgoingProvider({
      plan,
      manager: manager({
        reconcileInvoiceAttempt: async () => ({
          status: "resolved",
          payment: { ...paid, fees: 101n },
        }),
      }),
    })
    expect((await badFee.reconcile(target)).state).toBe("conflicting_evidence")
    const badHash = createCheckoutSparkOutgoingProvider({
      plan,
      manager: manager({
        sendCheckoutLightningObligation: async () => ({
          status: "paid",
          payment: {
            ...paid,
            details: {
              type: "lightning",
              htlcDetails: { preimage: PREIMAGE, paymentHash: "c".repeat(64) },
            },
          },
        }),
      }),
    })
    expect((await badHash.send(target)).state).toBe("conflicting_evidence")

    const badPreimage = createCheckoutSparkOutgoingProvider({
      plan,
      manager: manager({
        reconcileInvoiceAttempt: async () => ({
          status: "resolved",
          payment: {
            ...paid,
            details: {
              type: "lightning",
              htlcDetails: {
                preimage: "22".repeat(32),
                paymentHash: PAYMENT_HASH,
              },
            },
          },
        }),
      }),
    })
    expect((await badPreimage.reconcile(target)).state).toBe(
      "conflicting_evidence"
    )
  })

  it("preserves uncertain and known-not-sent outcomes", async () => {
    const { plan, target } = fixture()
    const unavailable = createCheckoutSparkOutgoingProvider({
      plan,
      manager: manager({
        reconcileInvoiceAttempt: async () => ({
          status: "lookup_unavailable",
        }),
        preflightCheckoutLightningObligation: async () => "unavailable",
        sendCheckoutLightningObligation: async () => ({
          status: "not_sent",
          reason: "fee_over_cap",
        }),
      }),
    })
    expect((await unavailable.reconcile(target)).state).toBe(
      "lookup_unavailable"
    )
    expect(await unavailable.preflight(target)).toBe("unavailable")
    expect(await unavailable.send(target)).toEqual({
      status: "not_sent",
      reason: "fee_over_cap",
    })

    const pending = createCheckoutSparkOutgoingProvider({
      plan,
      manager: manager({
        reconcileInvoiceAttempt: async () => ({
          status: "resolved",
          payment: {
            id: "provider-request-2",
            status: "pending",
            fees: 2n,
            details: { type: "lightning" },
          },
        }),
      }),
    })
    expect((await pending.reconcile(target)).state).toBe("pending")

    const failed = createCheckoutSparkOutgoingProvider({
      plan,
      manager: manager({
        reconcileInvoiceAttempt: async () => ({
          status: "resolved",
          payment: {
            id: "provider-request-3",
            status: "failed",
            fees: 0n,
            details: { type: "lightning" },
          },
        }),
      }),
    })
    expect((await failed.reconcile(target)).state).toBe("terminal_failure")
  })

  it("rejects a replacement invoice or transfer ID before calling Spark", async () => {
    const { plan, target } = fixture()
    let calls = 0
    const provider = createCheckoutSparkOutgoingProvider({
      plan,
      manager: manager({
        reconcileInvoiceAttempt: async () => {
          calls += 1
          return { status: "not_found" }
        },
      }),
    })
    await expect(
      provider.reconcile({ ...target, idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow("frozen plan")
    await expect(
      provider.reconcile({
        ...target,
        obligation: { ...target.obligation, paymentRequest: "lnbc-other" },
      })
    ).rejects.toThrow("frozen plan")
    expect(calls).toBe(0)
  })
})
