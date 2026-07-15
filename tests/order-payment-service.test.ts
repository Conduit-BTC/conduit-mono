import { describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"

import { db } from "../packages/core/src/db"
import {
  buildLifecyclePaymentProofContentJson,
  buildLifecycleResendProofContentJson,
  canObserveOrderPublicZapReceipt,
  canSubmitExternalPaymentReport,
  getLifecyclePaymentProofAction,
  isOrderPaymentRunning,
  runOrderPayment,
  runOrderPrivateFallback,
  type OrderPaymentContext,
} from "../apps/market/src/lib/order-payment-service"
import type { OrderLifecycle } from "../packages/core/src/db"

const ANON_SIGNER_SECRET = Uint8Array.from([...new Uint8Array(31), 13])
const ANON_SIGNER_PUBKEY = getPublicKey(ANON_SIGNER_SECRET)

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

function lnurlMetadata(allowsNostr = true) {
  return {
    payRequestUrl: "https://wallet.example/.well-known/lnurlp/merchant",
    lnurl: "lnurl1test",
    callback: "https://wallet.example/callback",
    minSendable: 1_000,
    maxSendable: 1_000_000,
    tag: "payRequest" as const,
    allowsNostr,
    nostrPubkey: "a".repeat(64),
    metadata: "[]",
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

  it("never retries an anonymous zap failure as a private invoice", async () => {
    const orderId = "anon-zap-fail-closed"
    let stored = lifecycle({
      orderId,
      checkoutMode: "anonymous_public_zap",
      publicZapSigner: "anon",
      invoice: undefined,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
    })
    const table = db.orderLifecycles as typeof db.orderLifecycles & {
      get: typeof db.orderLifecycles.get
      put: typeof db.orderLifecycles.put
    }
    const originalGet = table.get
    const originalPut = table.put
    const requestedVisibilities: string[] = []
    let paymentCalls = 0

    table.get = (async () => stored) as typeof table.get
    table.put = (async (next: OrderLifecycle) => {
      stored = next
      return next.orderId
    }) as typeof table.put

    try {
      const state = await runOrderPayment(
        basePaymentContext({
          orderId,
          merchantLud16: "merchant@wallet.example",
          zapMode: "anonymous_public_zap",
        }),
        {
          anonZapSignerPubkey: ANON_SIGNER_PUBKEY,
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async (params, requestDependencies) => {
            requestedVisibilities.push(params.visibility)
            if (params.visibility === "public_zap") {
              await requestDependencies.signZapRequest({
                kind: 9734,
                createdAt: 1_800_000_000,
                content: params.zapContent,
                tags: [
                  ["p", "a".repeat(64)],
                  ["amount", String(params.amountMsats)],
                  ["lnurl", params.lnurl],
                  ["relays", "wss://relay.example"],
                ],
              })
            }
            throw new Error("invoice request should not continue")
          },
          payCheckoutInvoice: async () => {
            paymentCalls += 1
            return {
              status: "paid",
              rail: "nwc",
              preimage: "preimage",
            }
          },
        }
      )

      expect(requestedVisibilities).toEqual(["public_zap"])
      expect(paymentCalls).toBe(0)
      expect(state.lifecycle?.checkoutMode).toBe("anonymous_public_zap")
      expect(state.lifecycle?.publicZapSigner).toBe("anon")
      expect(state.lifecycle?.invoiceStatus).toBe("failed")
      expect(state.lifecycle?.paymentStatus).toBe("failed")
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("uses a matching pre-order anonymous zap and fails closed if invoice issuance fails", async () => {
    const orderId = "anon-zap-prepared-before-order"
    const merchantPubkey = "b".repeat(64)
    const zapContent = "Zapped out 1 item at https://shop.conduit.market/"
    const rawEvent = finalizeEvent(
      {
        kind: 9734,
        created_at: 1_800_000_000,
        content: zapContent,
        tags: [
          ["p", merchantPubkey],
          ["amount", "1000"],
          ["lnurl", "lnurl1test"],
          ["relays", "wss://relay.example"],
          ["omf", "zapout"],
          ["client", "conduit-market"],
        ],
      },
      ANON_SIGNER_SECRET
    )
    const preparedAnonZap = {
      id: rawEvent.id,
      rawEvent,
      requestCreatedAt: rawEvent.created_at,
      lnurlCallback: "https://wallet.example/callback",
      lnurl: "lnurl1test",
      lnurlNostrPubkey: ANON_SIGNER_PUBKEY,
      relayUrls: ["wss://relay.example"],
    }
    let stored = lifecycle({
      orderId,
      merchantPubkey,
      checkoutMode: "anonymous_public_zap",
      publicZapSigner: "anon",
      invoice: undefined,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
    })
    const table = db.orderLifecycles as typeof db.orderLifecycles & {
      get: typeof db.orderLifecycles.get
      put: typeof db.orderLifecycles.put
    }
    const originalGet = table.get
    const originalPut = table.put
    let paymentCalls = 0

    table.get = (async () => stored) as typeof table.get
    table.put = (async (next: OrderLifecycle) => {
      stored = next
      return next.orderId
    }) as typeof table.put

    try {
      const state = await runOrderPayment(
        basePaymentContext({
          orderId,
          merchantPubkey,
          merchantLud16: "merchant@wallet.example",
          zapMode: "anonymous_public_zap",
          zapContent,
          preparedAnonZap,
        }),
        {
          anonZapSignerPubkey: ANON_SIGNER_PUBKEY,
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async (params, requestDependencies) => {
            const signed = await requestDependencies.signZapRequest({
              kind: 9734,
              createdAt: rawEvent.created_at,
              content: params.zapContent,
              tags: rawEvent.tags,
            })
            expect(signed).toEqual(preparedAnonZap)
            throw new Error("zap invoice callback unavailable")
          },
          payCheckoutInvoice: async () => {
            paymentCalls += 1
            return {
              status: "paid",
              rail: "nwc",
              preimage: "preimage",
            }
          },
        }
      )

      expect(paymentCalls).toBe(0)
      expect(state.lifecycle?.checkoutMode).toBe("anonymous_public_zap")
      expect(state.lifecycle?.invoiceStatus).toBe("failed")
      expect(state.lifecycle?.paymentStatus).toBe("failed")
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("fails closed when the merchant LNURL endpoint does not support zaps", async () => {
    const orderId = "anon-zap-lnurl-not-ready"
    let stored = lifecycle({
      orderId,
      checkoutMode: "anonymous_public_zap",
      publicZapSigner: "anon",
      invoice: undefined,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
    })
    const table = db.orderLifecycles as typeof db.orderLifecycles & {
      get: typeof db.orderLifecycles.get
      put: typeof db.orderLifecycles.put
    }
    const originalGet = table.get
    const originalPut = table.put
    let invoiceRequests = 0
    let paymentCalls = 0

    table.get = (async () => stored) as typeof table.get
    table.put = (async (next: OrderLifecycle) => {
      stored = next
      return next.orderId
    }) as typeof table.put

    try {
      const state = await runOrderPayment(
        basePaymentContext({
          orderId,
          merchantLud16: "merchant@wallet.example",
          zapMode: "anonymous_public_zap",
        }),
        {
          fetchLnurlPayMetadata: async () => lnurlMetadata(false),
          requestCheckoutLnurlInvoice: async () => {
            invoiceRequests += 1
            throw new Error("invoice request should not run")
          },
          payCheckoutInvoice: async () => {
            paymentCalls += 1
            return {
              status: "paid",
              rail: "nwc",
              preimage: "preimage",
            }
          },
        }
      )

      expect(invoiceRequests).toBe(0)
      expect(paymentCalls).toBe(0)
      expect(state.lifecycle?.checkoutMode).toBe("anonymous_public_zap")
      expect(state.lifecycle?.invoiceStatus).toBe("failed")
      expect(state.lifecycle?.paymentStatus).toBe("failed")
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("uses a private invoice only through the explicit recovery transition", async () => {
    const orderId = "anon-zap-explicit-private-recovery"
    let stored = lifecycle({
      orderId,
      checkoutMode: "anonymous_public_zap",
      publicZapSigner: "anon",
      invoice: undefined,
      invoiceStatus: "failed",
      paymentStatus: "failed",
      lastError: "Anonymous zap signer unavailable.",
    })
    const table = db.orderLifecycles as typeof db.orderLifecycles & {
      get: typeof db.orderLifecycles.get
      put: typeof db.orderLifecycles.put
    }
    const originalGet = table.get
    const originalPut = table.put
    const requestedVisibilities: string[] = []

    table.get = (async () => stored) as typeof table.get
    table.put = (async (next: OrderLifecycle) => {
      stored = next
      return next.orderId
    }) as typeof table.put

    try {
      const state = await runOrderPrivateFallback(
        basePaymentContext({
          orderId,
          merchantLud16: "merchant@wallet.example",
          zapMode: "anonymous_public_zap",
        }),
        {
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async (params) => {
            requestedVisibilities.push(params.visibility)
            throw new Error("private invoice unavailable")
          },
        }
      )

      expect(requestedVisibilities).toEqual(["private_checkout"])
      expect(state.lifecycle?.orderId).toBe(orderId)
      expect(state.lifecycle?.checkoutMode).toBe("private_checkout")
      expect(state.lifecycle?.publicZapSigner).toBeUndefined()
      expect(state.lifecycle?.publicZapFallback).toBe(true)
      expect(state.lifecycle?.zapReceiptStatus).toBe("not_applicable")
      expect(state.lifecycle?.invoiceStatus).toBe("failed")
      expect(state.lifecycle?.paymentStatus).toBe("failed")
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("accepts explicit private recovery for legacy anonymous lifecycle records", async () => {
    const orderId = "legacy-anon-explicit-private-recovery"
    let stored = lifecycle({
      orderId,
      checkoutMode: "external_wallet",
      publicZapSigner: "anon",
      invoice: undefined,
      invoiceStatus: "failed",
      paymentStatus: "failed",
      lastError: "Legacy anonymous zap failed.",
    })
    const table = db.orderLifecycles as typeof db.orderLifecycles & {
      get: typeof db.orderLifecycles.get
      put: typeof db.orderLifecycles.put
    }
    const originalGet = table.get
    const originalPut = table.put
    const requestedVisibilities: string[] = []

    table.get = (async () => stored) as typeof table.get
    table.put = (async (next: OrderLifecycle) => {
      stored = next
      return next.orderId
    }) as typeof table.put

    try {
      const state = await runOrderPrivateFallback(
        basePaymentContext({
          orderId,
          merchantLud16: "merchant@wallet.example",
          zapMode: "anonymous_public_zap",
        }),
        {
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async (params) => {
            requestedVisibilities.push(params.visibility)
            throw new Error("private invoice unavailable")
          },
        }
      )

      expect(requestedVisibilities).toEqual(["private_checkout"])
      expect(state.lifecycle?.checkoutMode).toBe("private_checkout")
      expect(state.lifecycle?.publicZapSigner).toBeUndefined()
      expect(state.lifecycle?.publicZapFallback).toBe(true)
      expect(state.lifecycle?.invoiceStatus).toBe("failed")
      expect(state.lifecycle?.paymentStatus).toBe("failed")
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
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
