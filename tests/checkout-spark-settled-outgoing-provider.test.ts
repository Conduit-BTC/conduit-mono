import { createHash } from "node:crypto"
import { describe, expect, it } from "bun:test"

import {
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import type { CheckoutSparkSettledOutgoingTarget } from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import {
  classifyCheckoutSparkSettledExactOutgoingHistory,
  requireCheckoutSparkSettledExactOutgoingRequest,
} from "../packages/core/src/protocol/checkout-spark-settled-outgoing-history"
import { createCheckoutSparkSettledOutgoingProvider } from "../apps/market/src/lib/checkout-spark-settled-outgoing-provider"
import { CheckoutSparkInvoiceOriginUnavailableError } from "../packages/core/src/protocol/checkout-spark-lnurl-invoice"
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

function invoice(amountSats: number, paymentHash: string): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(Buffer.from(paymentHash, "hex")),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function fixture() {
  const merchant = "a".repeat(64)
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "settled-provider-checkout",
    orderId: "settled-provider-order",
    merchantPubkey: merchant,
    walletId: "settled-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 60_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${merchant}:provider-fixture`,
          productEventId: "b".repeat(64),
          merchantPubkey: merchant,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-provider",
      paymentRequest: invoice(1_113, "03".repeat(32)),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: merchant,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
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
  const legId = plan.recipients[0]!.legId
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: plan.walletId,
    network: plan.network,
    legId,
    recipientId: merchant,
    allocationSats: 1_000,
    unpaidAllocationSats: 1_111,
    intent: {
      legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
      paymentRequest: invoice(995, PAYMENT_HASH),
      paymentHash: PAYMENT_HASH,
      invoiceAmountSats: 995,
      maxFeeSats: 5,
      preparedAt: CREATED_AT + 2,
    },
  }
  return { plan, target }
}

function manager(
  overrides: Partial<
    Parameters<typeof createCheckoutSparkSettledOutgoingProvider>[0]["manager"]
  > = {}
): Parameters<typeof createCheckoutSparkSettledOutgoingProvider>[0]["manager"] {
  return {
    reconcileInvoiceAttempt: async () => ({ status: "not_found" }),
    preflightCheckoutLightningObligation: async () => "ready",
    getFundsState: async () => ({
      availableSats: 1_111,
      ownedSats: 1_111,
      incomingSats: 0,
      observedAt: CREATED_AT + 1,
    }),
    sendCheckoutLightningObligation: async () => ({ status: "ambiguous" }),
    ...overrides,
  }
}

describe("settled Spark outgoing provider", () => {
  it("keeps history readable but stops a new send when local invoice origin is unavailable", async () => {
    const { plan, target } = fixture()
    let historyReads = 0
    let feeReads = 0
    let sends = 0
    const provider = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async (exactTarget) => {
        expect(exactTarget).toBe(target)
        throw new CheckoutSparkInvoiceOriginUnavailableError()
      },
      manager: manager({
        reconcileInvoiceAttempt: async () => {
          historyReads += 1
          return { status: "not_found" }
        },
        preflightCheckoutLightningObligation: async () => {
          feeReads += 1
          return "ready"
        },
        sendCheckoutLightningObligation: async (_walletId, request) => {
          await request.assertBeforeSend()
          sends += 1
          return { status: "ambiguous" }
        },
      }),
    })
    expect((await provider.reconcile(target)).status).toBe("not_found")
    expect(await provider.preflight(target)).toBe("recipient_unverified")
    expect(await provider.send(target)).toEqual({ status: "not_sent" })
    expect(historyReads).toBe(1)
    expect(feeReads).toBe(0)
    expect(sends).toBe(0)
  })

  it("shares the frozen plan binding and fail-closed history mapping with Merchant", async () => {
    const { plan, target } = fixture()
    expect(
      requireCheckoutSparkSettledExactOutgoingRequest(plan, target)
    ).toEqual({
      network: plan.network,
      transferId: target.intent.transferId,
      paymentRequest: target.intent.paymentRequest,
      amountSats: 995,
      maxFeeSats: 5,
    })
    expect(() =>
      requireCheckoutSparkSettledExactOutgoingRequest(plan, {
        ...target,
        recipientId: "other",
      })
    ).toThrow(/differs from its plan/)
    expect(() =>
      requireCheckoutSparkSettledExactOutgoingRequest(plan, {
        ...target,
        intent: { ...target.intent, transferId: "other" },
      })
    ).toThrow(/differs from its plan/)
    expect(
      (
        await classifyCheckoutSparkSettledExactOutgoingHistory(target, {
          status: "lookup_unavailable",
        })
      ).status
    ).toBe("lookup_unavailable")
    expect(
      (
        await classifyCheckoutSparkSettledExactOutgoingHistory(target, {
          status: "not_found",
        })
      ).status
    ).toBe("not_found")
    expect(
      (
        await classifyCheckoutSparkSettledExactOutgoingHistory(target, {
          status: "resolved",
          payment: {
            status: "completed",
            fees: 1n,
            details: {
              type: "lightning",
              htlcDetails: { paymentHash: PAYMENT_HASH, preimage: PREIMAGE },
            },
          },
          verifiedTransferTotalSats: 997,
        })
      ).status
    ).toBe("conflicting_evidence")
  })

  it("passes the exact frozen invoice and transfer ID to every SDK boundary", async () => {
    const { plan, target } = fixture()
    const calls: string[] = []
    const provider = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {},
      manager: manager({
        reconcileInvoiceAttempt: async (walletId, attempt) => {
          expect(walletId).toBe(plan.walletId)
          expect(attempt.transferId).toBe(target.intent.transferId)
          expect(attempt.paymentRequest).toBe(target.intent.paymentRequest)
          calls.push("reconcile")
          return { status: "not_found" }
        },
        preflightCheckoutLightningObligation: async (walletId, request) => {
          expect(walletId).toBe(plan.walletId)
          expect(request.maxFeeSats).toBe(5)
          calls.push("preflight")
          return "ready"
        },
        getFundsState: async (walletId) => {
          expect(walletId).toBe(plan.walletId)
          calls.push("funds")
          return {
            availableSats: 1_111,
            ownedSats: 1_111,
            incomingSats: 0,
            observedAt: CREATED_AT + 1,
          }
        },
        sendCheckoutLightningObligation: async (walletId, request) => {
          expect(walletId).toBe(plan.walletId)
          expect(request.amountSats).toBe(995)
          calls.push("send")
          return { status: "ambiguous" }
        },
      }),
    })
    expect((await provider.reconcile(target)).status).toBe("not_found")
    expect(await provider.preflight(target)).toBe("ready")
    expect((await provider.send(target)).status).toBe("pending")
    expect(calls).toEqual([
      "reconcile",
      "funds",
      "preflight",
      "send",
      "reconcile",
    ])
  })

  it("refuses to preflight when current spendable sats cannot reserve sibling allocations", async () => {
    const { plan, target } = fixture()
    let feePreflightCalled = false
    const provider = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {},
      manager: manager({
        getFundsState: async () => ({
          availableSats: 1_100,
          ownedSats: 1_100,
          incomingSats: 0,
          observedAt: CREATED_AT + 1,
        }),
        preflightCheckoutLightningObligation: async () => {
          feePreflightCalled = true
          return "ready"
        },
      }),
    })
    expect(await provider.preflight(target)).toBe("insufficient_funds")
    expect(feePreflightCalled).toBe(false)
  })

  it("rechecks sibling reserves at the final app-owned send boundary", async () => {
    const { plan, target } = fixture()
    let availableSats = 1_111
    let irreversibleSends = 0
    const provider = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {},
      manager: manager({
        getFundsState: async () => ({
          availableSats,
          ownedSats: availableSats,
          incomingSats: 0,
          observedAt: CREATED_AT + 1,
        }),
        sendCheckoutLightningObligation: async (_walletId, request) => {
          await request.assertBeforeSend()
          irreversibleSends += 1
          return { status: "ambiguous" }
        },
      }),
    })

    expect(await provider.preflight(target)).toBe("ready")
    // A different spend settles during exact-history and fee reads.
    availableSats = 1_000
    expect(await provider.send(target)).toEqual({ status: "not_sent" })
    expect(irreversibleSends).toBe(0)
  })

  it("does not send if the final reserve read becomes unavailable", async () => {
    const { plan, target } = fixture()
    let reads = 0
    let irreversibleSends = 0
    const provider = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {},
      manager: manager({
        getFundsState: async () => {
          reads += 1
          if (reads > 1) throw new Error("wallet balance unavailable")
          return {
            availableSats: 1_111,
            ownedSats: 1_111,
            incomingSats: 0,
            observedAt: CREATED_AT + 1,
          }
        },
        sendCheckoutLightningObligation: async (_walletId, request) => {
          await request.assertBeforeSend()
          irreversibleSends += 1
          return { status: "ambiguous" }
        },
      }),
    })

    expect(await provider.preflight(target)).toBe("ready")
    expect(await provider.send(target)).toEqual({ status: "not_sent" })
    expect(reads).toBe(2)
    expect(irreversibleSends).toBe(0)
  })

  it("carries the live actor guard into the final SDK send", async () => {
    const { plan, target } = fixture()
    let currentBuyer = true
    let irreversibleSends = 0
    const provider = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {
        if (!currentBuyer) throw new Error("shopper authority changed")
      },
      manager: manager({
        sendCheckoutLightningObligation: async (_walletId, request) => {
          currentBuyer = false
          await request.assertBeforeSend()
          irreversibleSends += 1
          return { status: "ambiguous" }
        },
      }),
    })
    await expect(provider.send(target)).rejects.toThrow(
      "shopper authority changed"
    )
    expect(irreversibleSends).toBe(0)
  })

  it("rechecks actor authority after the final reserve read", async () => {
    const { plan, target } = fixture()
    let currentBuyer = true
    let irreversibleSends = 0
    const provider = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {
        if (!currentBuyer) throw new Error("shopper authority changed")
      },
      manager: manager({
        getFundsState: async () => {
          currentBuyer = false
          return {
            availableSats: 1_111,
            ownedSats: 1_111,
            incomingSats: 0,
            observedAt: CREATED_AT + 1,
          }
        },
        sendCheckoutLightningObligation: async (_walletId, request) => {
          await request.assertBeforeSend()
          irreversibleSends += 1
          return { status: "ambiguous" }
        },
      }),
    })

    await expect(provider.send(target)).rejects.toThrow(
      "shopper authority changed"
    )
    expect(irreversibleSends).toBe(0)
  })

  it("fails closed when current Spark funds cannot be read", async () => {
    const { plan, target } = fixture()
    const provider = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {},
      manager: manager({
        getFundsState: async () => {
          throw new Error("wallet unavailable")
        },
      }),
    })
    expect(await provider.preflight(target)).toBe("unavailable")
  })

  it("requires a matching preimage and a final fee inside the allocation", async () => {
    const { plan, target } = fixture()
    const payment = {
      id: "provider-request",
      status: "completed" as const,
      fees: 4n,
      details: {
        type: "lightning",
        htlcDetails: { preimage: PREIMAGE, paymentHash: PAYMENT_HASH },
      },
    }
    const paid = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {},
      manager: manager({
        reconcileInvoiceAttempt: async () => ({
          status: "resolved",
          payment,
          verifiedTransferTotalSats: 999,
        }),
      }),
    })
    expect(await paid.reconcile(target)).toMatchObject({
      status: "paid",
      finalFeeSats: 4,
      finalDebitSats: 999,
    })
    const withoutTransferProof = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {},
      manager: manager({
        reconcileInvoiceAttempt: async () => ({ status: "resolved", payment }),
      }),
    })
    expect((await withoutTransferProof.reconcile(target)).status).toBe(
      "conflicting_evidence"
    )
    const overBudget = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {},
      manager: manager({
        reconcileInvoiceAttempt: async () => ({
          status: "resolved",
          payment: { ...payment, fees: 6n },
          verifiedTransferTotalSats: 1_001,
        }),
      }),
    })
    expect((await overBudget.reconcile(target)).status).toBe(
      "conflicting_evidence"
    )
    const badHash = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {},
      manager: manager({
        reconcileInvoiceAttempt: async () => ({
          status: "resolved",
          verifiedTransferTotalSats: 999,
          payment: {
            ...payment,
            details: {
              type: "lightning",
              htlcDetails: {
                preimage: PREIMAGE,
                paymentHash: "ff".repeat(32),
              },
            },
          },
        }),
      }),
    })
    expect((await badHash.reconcile(target)).status).toBe(
      "conflicting_evidence"
    )
  })

  it("rejects a target that changes the recipient or spends another allocation", async () => {
    const { plan, target } = fixture()
    const provider = createCheckoutSparkSettledOutgoingProvider({
      plan,
      assertBeforeSend: async () => {},
      manager: manager(),
    })
    await expect(
      provider.reconcile({ ...target, recipientId: "other" })
    ).rejects.toThrow("differs from its plan")
    await expect(
      provider.reconcile({ ...target, allocationSats: 999 })
    ).rejects.toThrow("differs from its plan")
  })
})
