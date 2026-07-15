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
  type OrderPaymentDependencies,
  type OrderPaymentContext,
} from "../apps/market/src/lib/order-payment-service"
import type { OrderLifecycle } from "../packages/core/src/db"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const ANON_SIGNER_SECRET = Uint8Array.from([...new Uint8Array(31), 13])
const ANON_SIGNER_PUBKEY = getPublicKey(ANON_SIGNER_SECRET)

function privateInvoice(amountHrp = "lnbc10n"): string {
  return makeBolt11Fixture({
    hrp: amountHrp,
    createdAt: Math.floor(Date.now() / 1000),
    fields: [bolt11PaymentHashField(), bolt11PlainDescriptionField()],
  })
}

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

function paymentDependencies(
  overrides: Partial<OrderPaymentDependencies> = {}
): Partial<OrderPaymentDependencies> {
  const claimOrderLifecyclePayment: OrderPaymentDependencies["claimOrderLifecyclePayment"] =
    async (input) => {
      const lifecycle = await db.orderLifecycles.get(input.orderId)
      if (!lifecycle) return { status: "missing", lifecycle: null }
      const claimed: OrderLifecycle = {
        ...lifecycle,
        buyerPubkey: input.buyerPubkey,
        merchantPubkey: input.merchantPubkey,
        merchantLightningAddress: input.merchantLightningAddress ?? undefined,
        checkoutMode: input.checkoutMode,
        zapContent: input.zapContent,
        totalSats: input.totalSats,
        totalMsats: input.totalMsats,
        invoiceStatus: "requesting",
        paymentStatus: "paying",
        proofDeliveryStatus: "not_started",
        zapReceiptStatus: "not_applicable",
        phase: "in_progress",
        updatedAt: Date.now(),
      }
      await db.orderLifecycles.put(claimed)
      return { status: "claimed", lifecycle: claimed }
    }

  return { claimOrderLifecyclePayment, ...overrides }
}

describe("runOrderPayment", () => {
  it("only accepts the first private manual-wallet payment report", () => {
    expect(
      canSubmitExternalPaymentReport(lifecycle({ publicZapSigner: undefined }))
    ).toBe(true)
    expect(
      canSubmitExternalPaymentReport(
        lifecycle({
          publicZapSigner: undefined,
          proofDeliveryStatus: "pending",
        })
      )
    ).toBe(false)
    expect(
      canSubmitExternalPaymentReport(
        lifecycle({ publicZapSigner: undefined, paymentStatus: "paid" })
      )
    ).toBe(false)
    expect(
      canSubmitExternalPaymentReport(
        lifecycle({
          checkoutMode: "private_checkout",
          publicZapSigner: undefined,
        })
      )
    ).toBe(true)
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

  it("does no external work when payment context disagrees with the delivered order", async () => {
    let externalCalls = 0
    const existing = lifecycle({
      orderId: "payment-snapshot-mismatch",
      invoice: undefined,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
    })
    const state = await runOrderPayment(
      basePaymentContext({
        orderId: existing.orderId,
        merchantLud16: "merchant@wallet.example",
      }),
      {
        claimOrderLifecyclePayment: async () => ({
          status: "snapshot_mismatch",
          lifecycle: existing,
        }),
        prepareAnonZapCheckout: async () => {
          externalCalls += 1
          throw new Error("must not prepare")
        },
        fetchLnurlPayMetadata: async () => {
          externalCalls += 1
          throw new Error("must not fetch")
        },
        requestCheckoutLnurlInvoice: async () => {
          externalCalls += 1
          throw new Error("must not request")
        },
        payCheckoutInvoice: async () => {
          externalCalls += 1
          throw new Error("must not pay")
        },
      }
    )

    expect(externalCalls).toBe(0)
    expect(state.error).toBe(
      "Payment details no longer match the delivered order."
    )
  })

  it("does no invoice or wallet work for persisted unsafe payment states", async () => {
    for (const paymentStatus of [
      "paying",
      "paid",
      "manual_required",
      "ambiguous",
    ] as const) {
      let externalCalls = 0
      const existing = lifecycle({
        orderId: `unsafe-payment-${paymentStatus}`,
        invoiceStatus:
          paymentStatus === "manual_required" ? "manual_required" : "received",
        paymentStatus,
      })
      const state = await runOrderPayment(
        basePaymentContext({
          orderId: existing.orderId,
          merchantLud16: "merchant@wallet.example",
        }),
        {
          claimOrderLifecyclePayment: async () => ({
            status: "unsafe_state",
            lifecycle: existing,
          }),
          fetchLnurlPayMetadata: async () => {
            externalCalls += 1
            throw new Error("must not fetch")
          },
          requestCheckoutLnurlInvoice: async () => {
            externalCalls += 1
            throw new Error("must not request")
          },
          payCheckoutInvoice: async () => {
            externalCalls += 1
            throw new Error("must not pay")
          },
        }
      )

      expect(externalCalls).toBe(0)
      expect(state.error).toBe(
        "This order already has an active or completed payment state."
      )
    }
  })

  it("falls back to one private invoice when an anonymous zap was not prepared", async () => {
    const orderId = "anon-zap-private-fallback"
    const invoice = privateInvoice()
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
    let preparationCalls = 0

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
          anonZapPreparation: {
            localPricing: {
              status: "ok",
              itemSubtotalSats: 1,
              totalSats: 1,
              totalMsats: 1_000,
              items: [],
              shippingCost: {
                status: "not_required",
                totalSats: 0,
                missingProductIds: [],
              },
              approximate: false,
            },
            destination: { country: "US", postalCode: "94107" },
          },
        }),
        paymentDependencies({
          anonZapSignerPubkey: ANON_SIGNER_PUBKEY,
          prepareAnonZapCheckout: async () => {
            preparationCalls += 1
            throw new Error(
              "Anon zap signer host allow-list is not configured."
            )
          },
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
            return {
              invoice,
              zapRelayUrls: [],
              shouldWaitForZapReceipt: false,
            }
          },
          payCheckoutInvoice: async () => {
            paymentCalls += 1
            return {
              status: "manual_required",
              reason: "Open the invoice in a Lightning wallet.",
            }
          },
        })
      )

      expect(requestedVisibilities).toEqual(["private_checkout"])
      expect(preparationCalls).toBe(1)
      expect(paymentCalls).toBe(1)
      expect(state.lifecycle?.checkoutMode).toBe("private_checkout")
      expect(state.lifecycle?.publicZapSigner).toBeUndefined()
      expect(state.lifecycle?.publicZapFallback).toBe(true)
      expect(state.lifecycle?.zapReceiptStatus).toBe("not_applicable")
      expect(state.lifecycle?.invoice).toBe(invoice)
      expect(state.lifecycle?.invoiceStatus).toBe("manual_required")
      expect(state.lifecycle?.paymentStatus).toBe("manual_required")
      expect(canSubmitExternalPaymentReport(state.lifecycle)).toBe(true)
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("falls back privately when public zap invoice issuance fails before payment", async () => {
    const orderId = "anon-zap-prepared-before-order"
    const merchantPubkey = "b".repeat(64)
    const zapContent = "Zapped out 1 item at https://shop.conduit.market/"
    const invoice = privateInvoice()
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
          merchantPubkey,
          merchantLud16: "merchant@wallet.example",
          zapMode: "anonymous_public_zap",
          zapContent,
          preparedAnonZap,
        }),
        paymentDependencies({
          anonZapSignerPubkey: ANON_SIGNER_PUBKEY,
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async (params, requestDependencies) => {
            requestedVisibilities.push(params.visibility)
            if (params.visibility === "public_zap") {
              const signed = await requestDependencies.signZapRequest({
                kind: 9734,
                createdAt: rawEvent.created_at,
                content: params.zapContent,
                tags: rawEvent.tags,
              })
              expect(signed).toEqual(preparedAnonZap)
              throw new Error("zap invoice callback unavailable")
            }
            return {
              invoice,
              zapRelayUrls: [],
              shouldWaitForZapReceipt: false,
            }
          },
          payCheckoutInvoice: async () => {
            paymentCalls += 1
            return {
              status: "manual_required",
              reason: "Open the invoice in a Lightning wallet.",
            }
          },
        })
      )

      expect(requestedVisibilities).toEqual(["public_zap", "private_checkout"])
      expect(paymentCalls).toBe(1)
      expect(state.lifecycle?.checkoutMode).toBe("private_checkout")
      expect(state.lifecycle?.publicZapSigner).toBeUndefined()
      expect(state.lifecycle?.publicZapFallback).toBe(true)
      expect(state.lifecycle?.zapReceiptStatus).toBe("not_applicable")
      expect(state.lifecycle?.invoice).toBe(invoice)
      expect(state.lifecycle?.invoiceStatus).toBe("manual_required")
      expect(state.lifecycle?.paymentStatus).toBe("manual_required")
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("falls back privately when the public zap invoice fails payment validation", async () => {
    const orderId = "anon-zap-invalid-public-invoice"
    const privateFallbackInvoice = privateInvoice()
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
          preparedAnonZap: { id: "prepared-zap", rawEvent: {} },
        }),
        paymentDependencies({
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async (params) => {
            requestedVisibilities.push(params.visibility)
            return {
              invoice:
                params.visibility === "public_zap"
                  ? privateInvoice("lnbc20n")
                  : privateFallbackInvoice,
              zapRelayUrls: [],
              shouldWaitForZapReceipt: false,
            }
          },
          payCheckoutInvoice: async () => ({
            status: "manual_required",
            reason: "Open the invoice in a Lightning wallet.",
          }),
        })
      )

      expect(requestedVisibilities).toEqual(["public_zap", "private_checkout"])
      expect(state.lifecycle?.checkoutMode).toBe("private_checkout")
      expect(state.lifecycle?.publicZapFallback).toBe(true)
      expect(state.lifecycle?.invoice).toBe(privateFallbackInvoice)
      expect(state.lifecycle?.invoiceStatus).toBe("manual_required")
      expect(state.lifecycle?.paymentStatus).toBe("manual_required")
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("does not switch invoices after a public invoice reaches the payment rail", async () => {
    const orderId = "anon-zap-payment-ambiguous"
    const merchantPubkey = "b".repeat(64)
    const zapContent = "Zapped out 1 item at https://shop.conduit.market/"
    const rawEvent = finalizeEvent(
      {
        kind: 9734,
        created_at: 1_800_000_000,
        content: zapContent,
        tags: [
          ["p", merchantPubkey],
          ["amount", "50000"],
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
      totalSats: 50,
      totalMsats: 50_000,
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
          totalSats: 50,
          totalMsats: 50_000,
          preparedAnonZap,
        }),
        paymentDependencies({
          anonZapSignerPubkey: ANON_SIGNER_PUBKEY,
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async (params) => {
            requestedVisibilities.push(params.visibility)
            return {
              invoice: privateInvoice("lnbc500n"),
              zapRelayUrls: ["wss://relay.example"],
              zapRequestId: rawEvent.id,
              zapRequestCreatedAt: rawEvent.created_at,
              expectedLnurl: "lnurl1test",
              lnurlNostrPubkey: ANON_SIGNER_PUBKEY,
              shouldWaitForZapReceipt: true,
            }
          },
          payCheckoutInvoice: async () => {
            throw new Error(
              "Payment confirmation was interrupted. Check your wallet before trying another payment path."
            )
          },
        })
      )

      expect(requestedVisibilities).toEqual(["public_zap"])
      expect(state.lifecycle?.checkoutMode).toBe("anonymous_public_zap")
      expect(state.lifecycle?.publicZapFallback).not.toBe(true)
      expect(state.lifecycle?.invoiceStatus).toBe("received")
      expect(state.lifecycle?.paymentStatus).toBe("ambiguous")
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("uses a private invoice when the merchant LNURL endpoint does not support zaps", async () => {
    const orderId = "anon-zap-lnurl-not-ready"
    const invoice = privateInvoice()
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
        paymentDependencies({
          fetchLnurlPayMetadata: async () => lnurlMetadata(false),
          requestCheckoutLnurlInvoice: async (params) => {
            requestedVisibilities.push(params.visibility)
            return {
              invoice,
              zapRelayUrls: [],
              shouldWaitForZapReceipt: false,
            }
          },
          payCheckoutInvoice: async () => {
            paymentCalls += 1
            return {
              status: "manual_required",
              reason: "Open the invoice in a Lightning wallet.",
            }
          },
        })
      )

      expect(requestedVisibilities).toEqual(["private_checkout"])
      expect(paymentCalls).toBe(1)
      expect(state.lifecycle?.checkoutMode).toBe("private_checkout")
      expect(state.lifecycle?.publicZapSigner).toBeUndefined()
      expect(state.lifecycle?.publicZapFallback).toBe(true)
      expect(state.lifecycle?.invoice).toBe(invoice)
      expect(state.lifecycle?.invoiceStatus).toBe("manual_required")
      expect(state.lifecycle?.paymentStatus).toBe("manual_required")
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("does not reach the wallet when the private fallback invoice is invalid", async () => {
    const orderId = "anon-zap-invalid-private-fallback"
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
        paymentDependencies({
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async (params) => {
            requestedVisibilities.push(params.visibility)
            return {
              invoice: privateInvoice("lnbc20n"),
              zapRelayUrls: [],
              shouldWaitForZapReceipt: false,
            }
          },
          payCheckoutInvoice: async () => {
            paymentCalls += 1
            throw new Error("must not pay")
          },
        })
      )

      expect(requestedVisibilities).toEqual(["private_checkout"])
      expect(paymentCalls).toBe(0)
      expect(state.lifecycle?.checkoutMode).toBe("private_checkout")
      expect(state.lifecycle?.invoiceStatus).toBe("failed")
      expect(state.lifecycle?.paymentStatus).toBe("failed")
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("retains explicit private recovery for older failed lifecycle records", async () => {
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
        paymentDependencies({
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async (params) => {
            requestedVisibilities.push(params.visibility)
            throw new Error("private invoice unavailable")
          },
        })
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
        paymentDependencies({
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async (params) => {
            requestedVisibilities.push(params.visibility)
            throw new Error("private invoice unavailable")
          },
        })
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
      await expect(runOrderPayment(ctx, paymentDependencies())).rejects.toThrow(
        "IndexedDB unavailable"
      )
      expect(isOrderPaymentRunning(ctx.orderId)).toBe(false)
    } finally {
      table.get = originalGet
    }
  })
})
