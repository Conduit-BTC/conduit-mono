import { describe, expect, it } from "bun:test"

import { db } from "../packages/core/src/db"
import {
  buildLifecyclePaymentProofContentJson,
  buildLifecycleResendProofContentJson,
  canObserveOrderPublicZapReceipt,
  canSubmitExternalPaymentReport,
  getLifecyclePaymentProofAction,
  isOrderPaymentRunning,
  runOrderPayment,
  shouldFallbackAnonZapToPrivate,
  type OrderPaymentContext,
} from "../apps/market/src/lib/order-payment-service"
import { AnonZapAuthorizationError } from "../apps/market/src/lib/anon-zap-signer"
import type { OrderLifecycle } from "../packages/core/src/db"

function basePaymentContext(
  overrides: Partial<OrderPaymentContext> = {}
): OrderPaymentContext {
  return {
    orderId: "order-payment-lock-test",
    buyerPubkey: "buyer",
    merchantPubkey: "merchant",
    merchantLud16: null,
    zapMode: "public_zap_as_shopper",
    zapContent: "",
    totalSats: 1,
    totalMsats: 1_000,
    items: [],
    walletConnection: null,
    tryNwc: false,
    ...overrides,
  }
}

function lifecycle(overrides: Partial<OrderLifecycle> = {}): OrderLifecycle {
  return {
    orderId: "external-wallet-proof-test",
    buyerPubkey: "buyer",
    merchantPubkey: "merchant",
    checkoutMode: "external_wallet",
    publicZapSigner: "anon",
    items: [],
    itemSubtotalSats: 1,
    shippingCostSats: 0,
    totalSats: 1,
    totalMsats: 1_000,
    currency: "SATS",
    invoice: "lnbc1test",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "sent",
    invoiceStatus: "manual_required",
    paymentStatus: "manual_required",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "in_progress",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe("runOrderPayment", () => {
  it("only accepts the first manual external-wallet payment report", () => {
    expect(canSubmitExternalPaymentReport(lifecycle())).toBe(true)
    expect(
      canSubmitExternalPaymentReport(
        lifecycle({ proofDeliveryStatus: "pending" })
      )
    ).toBe(false)
    expect(
      canSubmitExternalPaymentReport(lifecycle({ paymentStatus: "paid" }))
    ).toBe(false)
    expect(
      canSubmitExternalPaymentReport(
        lifecycle({ checkoutMode: "private_checkout" })
      )
    ).toBe(false)
  })

  it("keeps public zap proof retries public for external-wallet fallback orders", () => {
    expect(
      getLifecyclePaymentProofAction({
        checkoutMode: "external_wallet",
        publicZapSigner: "anon",
      })
    ).toBe("zap")
    expect(
      getLifecyclePaymentProofAction({
        checkoutMode: "external_wallet",
        publicZapSigner: "shopper",
      })
    ).toBe("zap")
    expect(
      getLifecyclePaymentProofAction({
        checkoutMode: "external_wallet",
      })
    ).toBe("private_checkout")
  })

  it("keeps first external-wallet public zap proof linked to the zap request", () => {
    const content = JSON.parse(
      buildLifecyclePaymentProofContentJson(
        lifecycle({ publicZapSigner: "anon", zapRequestId: "zap-request-id" }),
        {
          source: "external",
          note: "External wallet payment for order external-wallet-proof-test",
        }
      )
    )

    expect(content).toMatchObject({
      action: "zap",
      source: "external",
      zapRequestId: "zap-request-id",
    })
  })

  it("keeps first external-wallet private proof private when no public signer exists", () => {
    const content = JSON.parse(
      buildLifecyclePaymentProofContentJson(
        lifecycle({ publicZapSigner: undefined, zapRequestId: undefined }),
        {
          source: "external",
          note: "External wallet payment for order external-wallet-proof-test",
        }
      )
    )

    expect(content.action).toBe("private_checkout")
    expect(content.zapRequestId).toBeUndefined()
  })

  it("marks manual external-wallet payment reports for merchant verification", () => {
    const content = JSON.parse(
      buildLifecyclePaymentProofContentJson(
        lifecycle({ publicZapSigner: undefined, zapRequestId: undefined }),
        {
          action: "external_invoice",
          source: "external",
          verificationState: "needs_merchant_verification",
          note: "External wallet payment for order external-wallet-proof-test",
        }
      )
    )

    expect(content).toMatchObject({
      action: "external_invoice",
      source: "external",
      verification: {
        state: "needs_merchant_verification",
        checks: [],
      },
    })
    expect(content.preimage).toBeUndefined()
  })

  it("preserves external payment-report semantics when resending", () => {
    const content = JSON.parse(
      buildLifecycleResendProofContentJson(
        lifecycle({ publicZapSigner: undefined, zapRequestId: undefined })
      )
    )

    expect(content).toMatchObject({
      action: "external_invoice",
      source: "external",
      verification: {
        state: "needs_merchant_verification",
        checks: [],
      },
    })
    expect(content.preimage).toBeUndefined()
  })

  it("builds receipt-linked zap reports without fabricating wallet evidence", () => {
    const receiptLifecycle = lifecycle({
      checkoutMode: "anonymous_public_zap",
      zapRequestId: "zap-request-id",
      zapReceiptId: "zap-receipt-id",
    })
    const resendContent = buildLifecycleResendProofContentJson(receiptLifecycle)
    const initialContent = buildLifecyclePaymentProofContentJson(
      receiptLifecycle,
      {
        action: "zap",
        source: "external",
        verificationState: "verified",
        note: `Public zap receipt observed for order ${receiptLifecycle.orderId}`,
      }
    )
    const content = JSON.parse(resendContent)

    expect(resendContent).toBe(initialContent)
    expect(content).toMatchObject({
      action: "zap",
      source: "external",
      zapRequestId: "zap-request-id",
      zapReceiptId: "zap-receipt-id",
      verification: { state: "verified" },
    })
    expect(content.preimage).toBeUndefined()
    expect(content.paymentHash).toBeUndefined()
  })

  it("only falls back for anon public failures before invoice issuance", () => {
    expect(
      shouldFallbackAnonZapToPrivate({
        visibility: "public_zap",
        publicZapSigner: "anon",
        lnurlAllowsNostr: false,
      })
    ).toBe(true)
    expect(
      shouldFallbackAnonZapToPrivate({
        visibility: "public_zap",
        publicZapSigner: "anon",
        lnurlAllowsNostr: true,
        error: new AnonZapAuthorizationError("signer unavailable"),
      })
    ).toBe(true)
    expect(
      shouldFallbackAnonZapToPrivate({
        visibility: "public_zap",
        publicZapSigner: "anon",
        lnurlAllowsNostr: true,
        error: new Error("invoice callback timed out"),
      })
    ).toBe(false)
    expect(
      shouldFallbackAnonZapToPrivate({
        visibility: "public_zap",
        publicZapSigner: "shopper",
        lnurlAllowsNostr: false,
      })
    ).toBe(false)
  })

  it("resumes only complete, unexpired anon receipt contexts", () => {
    const now = Date.now()
    const observable = lifecycle({
      checkoutMode: "anonymous_public_zap",
      zapReceiptStatus: "waiting",
      zapRequestId: "zap-request-id",
      zapRequestCreatedAt: Math.floor(now / 1000) - 10,
      zapLnurl: "lnurl1test",
      zapReceiptPubkey: "a".repeat(64),
      zapReceiptRelayUrls: ["wss://relay.example"],
      zapReceiptObservationDeadline: now + 60_000,
    })

    expect(canObserveOrderPublicZapReceipt(observable, now)).toBe(true)
    expect(
      canObserveOrderPublicZapReceipt(
        { ...observable, zapReceiptRelayUrls: [] },
        now
      )
    ).toBe(false)
    expect(
      canObserveOrderPublicZapReceipt(
        {
          ...observable,
          buyerIdentityKind: "guest_ephemeral",
          createdAt: now - 24 * 60 * 60 * 1_000 - 1,
        },
        now
      )
    ).toBe(false)
    for (const proofDeliveryStatus of [
      "not_started",
      "pending",
      "retry_needed",
      "failed",
    ] as const) {
      expect(
        canObserveOrderPublicZapReceipt(
          {
            ...observable,
            zapReceiptStatus: "observed",
            zapReceiptId: "zap-receipt-id",
            proofDeliveryStatus,
          },
          now
        )
      ).toBe(true)
    }
    expect(
      canObserveOrderPublicZapReceipt(
        {
          ...observable,
          zapReceiptStatus: "observed",
          proofDeliveryStatus: "sent",
        },
        now
      )
    ).toBe(false)
  })

  it("releases the order in-flight lock when lifecycle patching fails", async () => {
    const ctx = basePaymentContext({
      orderId: "order-payment-lock-test-patch-failure",
    })
    const table = db.orderLifecycles as typeof db.orderLifecycles & {
      get: typeof db.orderLifecycles.get
    }
    const originalGet = table.get

    table.get = (async () => {
      throw new Error("IndexedDB unavailable")
    }) as typeof table.get

    try {
      await expect(runOrderPayment(ctx)).rejects.toThrow(
        "IndexedDB unavailable"
      )
      expect(isOrderPaymentRunning(ctx.orderId)).toBe(false)
    } finally {
      table.get = originalGet
    }
  })
})
