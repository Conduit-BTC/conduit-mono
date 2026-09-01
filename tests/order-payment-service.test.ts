import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools"

import { db } from "../packages/core/src/db"
import {
  buildLifecyclePaymentProofContentJson,
  buildLifecycleResendProofContentJson,
  canObserveOrderPublicZapReceipt,
  canSubmitExternalPaymentReport,
  getLifecyclePaymentProofAction,
  isOrderPaymentRunning,
  observeOrderPublicZapReceipt,
  runOrderPayment,
  runOrderPrivateFallback,
  signShopperCheckoutZapRequest,
  type OrderPaymentDependencies,
  type OrderPaymentContext,
} from "../apps/market/src/lib/order-payment-service"
import { AMBIGUOUS_PAYMENT_WARNING } from "../apps/market/src/lib/payment-rails"
import type { OrderLifecycle } from "../packages/core/src/db"
import {
  bolt11PlainDescriptionField,
  bytesToBolt11Words,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const ANON_SIGNER_SECRET = Uint8Array.from([...new Uint8Array(31), 13])
const ANON_SIGNER_PUBKEY = getPublicKey(ANON_SIGNER_SECRET)

function privateInvoice(amountHrp = "lnbc10n", paymentHashByte = 7): string {
  return makeBolt11Fixture({
    hrp: amountHrp,
    createdAt: Math.floor(Date.now() / 1000),
    fields: [
      {
        tag: "p",
        words: bytesToBolt11Words(new Uint8Array(32).fill(paymentHashByte)),
      },
      bolt11PlainDescriptionField(),
    ],
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
    paymentTarget: { type: "manual" },
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
    paymentTarget: { type: "manual" },
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
        paymentClaimId: input.paymentClaimId,
        buyerPubkey: input.buyerPubkey,
        merchantPubkey: input.merchantPubkey,
        merchantLightningAddress: input.merchantLightningAddress ?? undefined,
        checkoutMode: input.checkoutMode,
        zapContent: input.zapContent,
        totalSats: input.totalSats,
        totalMsats: input.totalMsats,
        walletPaymentAttemptId:
          input.paymentTarget.type === "wallet"
            ? lifecycle.walletPaymentAttemptId &&
              lifecycle.walletPaymentAttemptId !== lifecycle.orderId
              ? lifecycle.walletPaymentAttemptId
              : crypto.randomUUID()
            : undefined,
        invoiceStatus: "requesting",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
        zapReceiptStatus: "not_applicable",
        phase: "in_progress",
        updatedAt: Date.now(),
      }
      await db.orderLifecycles.put(claimed)
      return { status: "claimed", lifecycle: claimed }
    }

  const patchClaimedOrderLifecyclePayment: OrderPaymentDependencies["patchClaimedOrderLifecyclePayment"] =
    async (orderId, paymentClaimId, patch) => {
      const lifecycle = await db.orderLifecycles.get(orderId)
      if (!lifecycle) return { status: "missing", lifecycle: null }
      if (lifecycle.paymentClaimId !== paymentClaimId) {
        return { status: "claim_mismatch", lifecycle }
      }
      const updated: OrderLifecycle = {
        ...lifecycle,
        ...patch,
        updatedAt: Date.now(),
      }
      await db.orderLifecycles.put(updated)
      return { status: "patched", lifecycle: updated }
    }
  const renewOrderLifecyclePaymentClaim: OrderPaymentDependencies["renewOrderLifecyclePaymentClaim"] =
    (orderId, paymentClaimId) =>
      patchClaimedOrderLifecyclePayment(orderId, paymentClaimId, {})
  const claimOrderLifecyclePrivateFallbackPayment: OrderPaymentDependencies["claimOrderLifecyclePrivateFallbackPayment"] =
    async (input) => {
      const lifecycle = await db.orderLifecycles.get(input.orderId)
      if (!lifecycle) return { status: "missing", lifecycle: null }
      if (
        lifecycle.paymentClaimId ||
        lifecycle.publicZapSigner !== "anon" ||
        lifecycle.invoiceStatus !== "failed" ||
        lifecycle.paymentStatus !== "failed"
      ) {
        return { status: "unsafe_state", lifecycle }
      }
      const claimed: OrderLifecycle = {
        ...lifecycle,
        paymentClaimId: input.paymentClaimId,
        merchantLightningAddress: input.merchantLightningAddress ?? undefined,
        checkoutMode: "private_checkout",
        publicZapSigner: undefined,
        publicZapFallback: true,
        zapContent: "",
        walletPaymentAttemptId:
          input.paymentTarget.type === "wallet"
            ? crypto.randomUUID()
            : undefined,
        invoiceStatus: "requesting",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
        zapReceiptStatus: "not_applicable",
        invoice: undefined,
        lastError: undefined,
        updatedAt: Date.now(),
      }
      await db.orderLifecycles.put(claimed)
      return { status: "claimed", lifecycle: claimed }
    }

  return {
    claimOrderLifecyclePayment,
    claimOrderLifecyclePrivateFallbackPayment,
    patchClaimedOrderLifecyclePayment,
    recordOrderPaymentPreparationFailure: async () => ({
      status: "missing",
      lifecycle: null,
    }),
    renewOrderLifecyclePaymentClaim,
    rememberOrderPaymentClaim: () => true,
    clearOrderPaymentClaim: () => true,
    ...overrides,
  }
}

describe("shopper zap signing authority", () => {
  const draft = {
    kind: 9734,
    createdAt: 1_800_000_000,
    content: "",
    tags: [
      ["p", "a".repeat(64)],
      ["amount", "1000"],
      ["relays", "wss://relay.example"],
    ],
  }

  it("returns a cryptographically valid request from the expected shopper", async () => {
    const signer = NDKPrivateKeySigner.generate()
    const shopper = await signer.user()

    const signed = await signShopperCheckoutZapRequest(
      draft,
      shopper.pubkey,
      signer
    )

    expect(signed.rawEvent.pubkey).toBe(shopper.pubkey)
    expect(signed.id).toBe(signed.rawEvent.id)
  })

  it("rejects a checkout account mismatch before signing", async () => {
    const signer = NDKPrivateKeySigner.generate()
    const other = await NDKPrivateKeySigner.generate().user()

    await expect(
      signShopperCheckoutZapRequest(draft, other.pubkey, signer)
    ).rejects.toThrow("does not match this checkout account")
  })

  it("rejects an invalid signature returned for the expected shopper", async () => {
    const signer = NDKPrivateKeySigner.generate()
    const shopper = await signer.user()

    await expect(
      signShopperCheckoutZapRequest(draft, shopper.pubkey, {
        user: async () => shopper,
        sign: async () => "0".repeat(128),
      } as never)
    ).rejects.toThrow("invalid public zap request")
  })

  it("does not repeat shopper zap signing after an ambiguous bridge error", async () => {
    const delegate = NDKPrivateKeySigner.generate()
    const shopper = await delegate.user()
    let signCalls = 0

    await expect(
      signShopperCheckoutZapRequest(draft, shopper.pubkey, {
        user: async () => shopper,
        sign: async () => {
          signCalls += 1
          throw new Error(
            "The message port closed before a response was received."
          )
        },
      } as never)
    ).rejects.toThrow("message port closed")

    expect(signCalls).toBe(1)
  })
})

function mockImmediateOrderLifecycleTransaction(): () => void {
  const database = db as typeof db & {
    transaction: typeof db.transaction
  }
  const originalTransaction = database.transaction
  database.transaction = (async (
    _mode: string,
    _table: unknown,
    callback: () => Promise<unknown>
  ) => callback()) as typeof database.transaction
  return () => {
    database.transaction = originalTransaction
  }
}

describe("runOrderPayment", () => {
  it("does not claim or request payment when recovery ownership cannot be stored", async () => {
    const orderId = "payment-session-storage-blocked"
    let claimCalls = 0
    let invoiceCalls = 0
    let preparationFailureCalls = 0

    const state = await runOrderPayment(
      basePaymentContext({
        orderId,
        merchantLud16: "merchant@wallet.example",
      }),
      paymentDependencies({
        rememberOrderPaymentClaim: () => false,
        recordOrderPaymentPreparationFailure: async (_input, lastError) => {
          preparationFailureCalls += 1
          return {
            status: "recorded",
            lifecycle: lifecycle({
              orderId,
              invoice: undefined,
              invoiceStatus: "failed",
              paymentStatus: "failed",
              lastError,
            }),
          }
        },
        claimOrderLifecyclePayment: async () => {
          claimCalls += 1
          return { status: "missing", lifecycle: null }
        },
        requestCheckoutLnurlInvoice: async () => {
          invoiceCalls += 1
          throw new Error("must not request")
        },
      })
    )

    expect(claimCalls).toBe(0)
    expect(invoiceCalls).toBe(0)
    expect(preparationFailureCalls).toBe(1)
    expect(isOrderPaymentRunning(orderId)).toBe(false)
    expect(state.error).toBe("Recoverable payment storage is unavailable.")
    expect(state.lifecycle?.paymentStatus).toBe("failed")
  })

  it("renews and cancels the payment claim heartbeat during long work", async () => {
    const orderId = "payment-heartbeat"
    let stored = lifecycle({
      orderId,
      checkoutMode: "private_checkout",
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
    let heartbeat: (() => void) | null = null
    let cancelCalls = 0
    let renewCalls = 0
    let renewalErrors = 0
    let rejectMetadata!: (error: Error) => void
    const metadata = new Promise<ReturnType<typeof lnurlMetadata>>(
      (_resolve, reject) => {
        rejectMetadata = reject
      }
    )

    table.get = (async () => stored) as typeof table.get
    table.put = (async (next: OrderLifecycle) => {
      stored = next
      return next.orderId
    }) as typeof table.put

    try {
      const payment = runOrderPayment(
        basePaymentContext({
          orderId,
          merchantLud16: "merchant@wallet.example",
          zapMode: "private_checkout",
        }),
        paymentDependencies({
          fetchLnurlPayMetadata: async () => metadata,
          renewOrderLifecyclePaymentClaim: async () => {
            renewCalls += 1
            if (renewCalls === 1) throw new Error("IndexedDB unavailable")
            return { status: "patched", lifecycle: stored }
          },
          reportPaymentClaimHeartbeatError: () => {
            renewalErrors += 1
          },
          schedulePaymentClaimHeartbeat: (handler) => {
            heartbeat = handler
            return 77 as unknown as ReturnType<typeof setInterval>
          },
          cancelPaymentClaimHeartbeat: () => {
            cancelCalls += 1
          },
        })
      )

      for (let index = 0; index < 5 && !heartbeat; index += 1) {
        await Promise.resolve()
      }
      expect(heartbeat).not.toBeNull()
      heartbeat!()
      await Promise.resolve()
      expect(renewCalls).toBe(1)
      expect(renewalErrors).toBe(1)
      heartbeat!()
      await Promise.resolve()
      expect(renewCalls).toBe(2)

      rejectMetadata(new Error("metadata unavailable"))
      await payment
      expect(cancelCalls).toBe(1)
      expect(isOrderPaymentRunning(orderId)).toBe(false)
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

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
      paymentDependencies({
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
      })
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
        paymentDependencies({
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
        })
      )

      expect(externalCalls).toBe(0)
      expect(state.error).toBe(
        "This order already has an active or completed payment state."
      )
    }
  })

  it("keeps a confirmed no-send wallet failure retryable", async () => {
    const orderId = "provider-pre-publish-failure"
    const invoice = privateInvoice()
    const paymentRequests: Array<
      Parameters<OrderPaymentDependencies["payCheckoutInvoice"]>[0]
    > = []
    const paymentTarget = {
      type: "wallet" as const,
      walletId: "wallet-spark",
      providerId: "spark" as const,
    }
    let stored = lifecycle({
      orderId,
      checkoutMode: "private_checkout",
      publicZapSigner: undefined,
      paymentTarget,
      invoice: undefined,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
      phase: "pending",
    })
    const table = db.orderLifecycles as typeof db.orderLifecycles & {
      get: typeof db.orderLifecycles.get
      put: typeof db.orderLifecycles.put
    }
    const originalGet = table.get
    const originalPut = table.put

    table.get = (async () => stored) as typeof table.get
    table.put = (async (next: OrderLifecycle) => {
      stored = next
      return next.orderId
    }) as typeof table.put

    try {
      const context = basePaymentContext({
        orderId,
        merchantLud16: "merchant@wallet.example",
        zapMode: "private_checkout",
        paymentTarget,
      })
      const dependencies = paymentDependencies({
        fetchLnurlPayMetadata: async () => lnurlMetadata(),
        requestCheckoutLnurlInvoice: async () => ({
          invoice,
          zapRelayUrls: [],
          shouldWaitForZapReceipt: false,
        }),
        payCheckoutInvoice: async (request) => {
          paymentRequests.push(request)
          return {
            status: "retryable_failure",
            reason: "Spark payment was not approved.",
          }
        },
      })
      const state = await runOrderPayment(context, dependencies)
      const retryState = await runOrderPayment(context, dependencies)

      expect(state.lifecycle?.invoiceStatus).toBe("failed")
      expect(state.lifecycle?.paymentStatus).toBe("failed")
      expect(state.lifecycle?.lastError).toBe("Spark payment was not approved.")
      expect(state.error).toBe("Spark payment was not approved.")
      expect(canSubmitExternalPaymentReport(state.lifecycle)).toBe(false)
      expect(retryState.lifecycle?.paymentStatus).toBe("failed")
      expect(paymentRequests).toHaveLength(2)
      expect(paymentRequests[0]?.paymentTarget).toEqual(paymentTarget)
      expect(paymentRequests[1]?.paymentTarget).toEqual(paymentTarget)
      expect(paymentRequests[0]?.walletPaymentAttemptId).not.toBe(orderId)
      expect(paymentRequests[0]?.walletPaymentAttemptId).not.toContain(orderId)
      expect(paymentRequests[1]?.walletPaymentAttemptId).toBe(
        paymentRequests[0]?.walletPaymentAttemptId
      )
    } finally {
      table.get = originalGet
      table.put = originalPut
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

  it("blocks payment when authorized pricing requires buyer review", async () => {
    const orderId = "anon-zap-pricing-review"
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
    let invoiceCalls = 0
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
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          prepareAnonZapCheckout: async () => ({
            status: "review_required",
            authorization: {} as never,
            checkoutPricing: {
              status: "ok",
              itemSubtotalSats: 2,
              totalSats: 2,
              totalMsats: 2_000,
              items: [],
              shippingCost: {
                status: "not_required",
                totalSats: 0,
                missingProductIds: [],
              },
              approximate: false,
            },
          }),
          requestCheckoutLnurlInvoice: async () => {
            invoiceCalls += 1
            throw new Error("must not request")
          },
          payCheckoutInvoice: async () => {
            paymentCalls += 1
            throw new Error("must not pay")
          },
        })
      )

      expect(invoiceCalls).toBe(0)
      expect(paymentCalls).toBe(0)
      expect(state.error).toContain(
        "Current signed listing pricing changed from 1 to 2 sats."
      )
      expect(state.lifecycle?.checkoutMode).toBe("anonymous_public_zap")
      expect(state.lifecycle?.publicZapFallback).not.toBe(true)
      expect(state.lifecycle?.invoiceStatus).toBe("failed")
      expect(state.lifecycle?.paymentStatus).toBe("failed")
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
              `Payment confirmation was interrupted. ${AMBIGUOUS_PAYMENT_WARNING}`
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

  it("keeps successful proof delivery sent when a receipt supersedes its claim", async () => {
    const orderId = "receipt-proof-delivery-race"
    const merchantPubkey = "b".repeat(64)
    const zapContent = "Zapped out 1 item at https://shop.conduit.market/"
    const invoice = privateInvoice("lnbc500n")
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
          requestCheckoutLnurlInvoice: async () => ({
            invoice,
            zapRelayUrls: ["wss://relay.example"],
            zapRequestId: rawEvent.id,
            zapRequestCreatedAt: rawEvent.created_at,
            expectedLnurl: "lnurl1test",
            lnurlNostrPubkey: ANON_SIGNER_PUBKEY,
            shouldWaitForZapReceipt: false,
          }),
          payCheckoutInvoice: async () => ({
            status: "paid",
            rail: "nwc",
            preimage: "11".repeat(32),
            paymentHash: "22".repeat(32),
          }),
          savePaymentAttempt: async () => {},
          updatePaymentAttempt: async () => {},
          publishBuyerOrderMessage: async () => {
            stored = {
              ...stored,
              paymentClaimId: undefined,
              paymentClaimedAt: undefined,
              paymentClaimLeaseExpiresAt: undefined,
              paymentStatus: "paid",
              proofDeliveryStatus: "pending",
              zapReceiptStatus: "observed",
              zapReceiptId: "zap-receipt-current",
            }
            return {
              buyerSelfCopyError: null,
              localCacheError: null,
              deliveryRoute: "nip17",
            } as never
          },
          recordOrderPaymentProofDelivery: async (
            _recordOrderId,
            proofDeliveryStatus,
            patch = {}
          ) => {
            if (
              stored.proofDeliveryStatus === "sent" &&
              proofDeliveryStatus !== "sent"
            ) {
              return { status: "preserved", lifecycle: stored }
            }
            stored = {
              ...stored,
              ...patch,
              proofDeliveryStatus,
              updatedAt: Date.now(),
            }
            return { status: "recorded", lifecycle: stored }
          },
        })
      )

      expect(state.lifecycle).toMatchObject({
        paymentStatus: "paid",
        proofDeliveryStatus: "sent",
        zapReceiptStatus: "observed",
        zapReceiptId: "zap-receipt-current",
      })
      expect(state.lifecycle?.paymentClaimId).toBeUndefined()
      expect(state.error).toBeNull()
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })

  it("restores wallet evidence when recovery supersedes the paid checkpoint", async () => {
    const orderId = "wallet-success-checkpoint-race"
    const invoice = privateInvoice()
    let stored = lifecycle({
      orderId,
      checkoutMode: "private_checkout",
      publicZapSigner: undefined,
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
    let publishCalls = 0

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
          zapMode: "private_checkout",
        }),
        paymentDependencies({
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async () => ({
            invoice,
            zapRelayUrls: [],
            shouldWaitForZapReceipt: false,
          }),
          payCheckoutInvoice: async () => ({
            status: "paid",
            rail: "nwc",
            preimage: "11".repeat(32),
            paymentHash: "22".repeat(32),
            feeMsats: 21,
          }),
          savePaymentAttempt: async () => {},
          updatePaymentAttempt: async () => {},
          publishBuyerOrderMessage: async () => {
            publishCalls += 1
            throw new Error("must not publish before the paid checkpoint")
          },
          patchClaimedOrderLifecyclePayment: async (
            _patchOrderId,
            paymentClaimId,
            patch
          ) => {
            if (stored.paymentClaimId !== paymentClaimId) {
              return { status: "claim_mismatch", lifecycle: stored }
            }
            if (patch.paymentStatus === "paid") {
              stored = {
                ...stored,
                paymentClaimId: undefined,
                paymentClaimedAt: undefined,
                paymentClaimLeaseExpiresAt: undefined,
                lastError: "A stale interruption warning.",
              }
              return { status: "claim_mismatch", lifecycle: stored }
            }
            stored = { ...stored, ...patch, updatedAt: Date.now() }
            return { status: "patched", lifecycle: stored }
          },
          recordOrderPaymentWalletSuccessRecovery: async (
            _recoveryOrderId,
            input
          ) => {
            stored = {
              ...stored,
              paymentClaimId: undefined,
              invoiceStatus: "received",
              paymentStatus: "paid",
              proofDeliveryStatus:
                input.proofDeliveryStatus === "sent" ? "sent" : "retry_needed",
              invoice: input.invoice,
              paymentHash: input.paymentHash,
              preimage: input.preimage,
              feeMsats: input.feeMsats,
              zapRequestId: input.zapRequestId,
              lastError: undefined,
              updatedAt: Date.now(),
            }
            return { status: "recorded", lifecycle: stored }
          },
        })
      )

      expect(publishCalls).toBe(0)
      expect(state.lifecycle).toMatchObject({
        paymentStatus: "paid",
        proofDeliveryStatus: "retry_needed",
        paymentHash: "22".repeat(32),
        preimage: "11".repeat(32),
        feeMsats: 21,
      })
      expect(state.lifecycle?.lastError).toBeUndefined()
      const resend = JSON.parse(
        buildLifecycleResendProofContentJson(state.lifecycle!)
      )
      expect(resend).toMatchObject({
        paymentHash: "22".repeat(32),
        preimage: "11".repeat(32),
        feeMsats: 21,
      })
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
    const restoreTransaction = mockImmediateOrderLifecycleTransaction()
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
      restoreTransaction()
    }
  })

  it("rotates the wallet attempt when private recovery requests a new invoice", async () => {
    const orderId = "anon-zap-private-wallet-attempt-rotation"
    const previousWalletPaymentAttemptId =
      "11111111-1111-4111-8111-111111111111"
    const paymentTarget = {
      type: "wallet" as const,
      walletId: "wallet-spark",
      providerId: "spark" as const,
    }
    let stored = lifecycle({
      orderId,
      checkoutMode: "anonymous_public_zap",
      publicZapSigner: "anon",
      paymentTarget,
      walletPaymentAttemptId: previousWalletPaymentAttemptId,
      invoice: privateInvoice("lnbc10n", 7),
      invoiceStatus: "failed",
      paymentStatus: "failed",
      lastError: "Anonymous zap payment failed.",
    })
    const table = db.orderLifecycles as typeof db.orderLifecycles & {
      get: typeof db.orderLifecycles.get
      put: typeof db.orderLifecycles.put
    }
    const originalGet = table.get
    const originalPut = table.put
    const restoreTransaction = mockImmediateOrderLifecycleTransaction()
    const walletPaymentAttemptIds: string[] = []

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
          paymentTarget,
        }),
        paymentDependencies({
          fetchLnurlPayMetadata: async () => lnurlMetadata(),
          requestCheckoutLnurlInvoice: async () => ({
            invoice: privateInvoice("lnbc10n", 8),
            zapRelayUrls: [],
            shouldWaitForZapReceipt: false,
          }),
          payCheckoutInvoice: async (request) => {
            walletPaymentAttemptIds.push(request.walletPaymentAttemptId ?? "")
            return {
              status: "retryable_failure",
              reason: "Payment declined.",
            }
          },
        })
      )

      expect(walletPaymentAttemptIds).toHaveLength(1)
      expect(walletPaymentAttemptIds[0]).not.toBe(
        previousWalletPaymentAttemptId
      )
      expect(walletPaymentAttemptIds[0]).toBeTruthy()
      expect(state.lifecycle?.checkoutMode).toBe("private_checkout")
      expect(state.lifecycle?.walletPaymentAttemptId).toBe(
        walletPaymentAttemptIds[0]
      )
    } finally {
      table.get = originalGet
      table.put = originalPut
      restoreTransaction()
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
    const restoreTransaction = mockImmediateOrderLifecycleTransaction()
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
      restoreTransaction()
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

  it("uses current durable truth after a receipt observer wait", async () => {
    const orderId = "deferred-receipt-timeout-race"
    let current = lifecycle({
      orderId,
      checkoutMode: "anonymous_public_zap",
      publicZapSigner: "anon",
      invoice: privateInvoice(),
      invoiceStatus: "received",
      paymentStatus: "paying",
      proofDeliveryStatus: "pending",
      zapReceiptStatus: "waiting",
      zapRequestId: "zap-request-current",
      zapRequestCreatedAt: Math.floor(Date.now() / 1_000) - 5,
      zapLnurl: "lnurl1test",
      zapReceiptPubkey: "a".repeat(64),
      zapReceiptRelayUrls: ["wss://relay.example"],
      zapReceiptObservationDeadline: Date.now() - 1,
    })
    let releaseWait!: (receipt: null) => void
    let waitStarted = false
    let timeoutCalls = 0
    const receiptWait = new Promise<null>((resolve) => {
      releaseWait = resolve
    })

    const observation = observeOrderPublicZapReceipt(orderId, undefined, {
      getOrderLifecycle: async () => current,
      waitForZapReceipt: async () => {
        waitStarted = true
        return receiptWait
      },
      recordOrderPaymentReceiptTimeout: async () => {
        timeoutCalls += 1
        if (
          current.paymentStatus === "paid" ||
          current.zapReceiptStatus === "observed"
        ) {
          return { status: "preserved", lifecycle: current }
        }
        throw new Error("must preserve stronger evidence")
      },
    })

    for (let index = 0; index < 5 && !waitStarted; index += 1) {
      await Promise.resolve()
    }
    expect(waitStarted).toBe(true)
    current = {
      ...current,
      paymentStatus: "paid",
      proofDeliveryStatus: "sent",
      zapReceiptStatus: "observed",
      zapReceiptId: "zap-receipt-current",
      lastError: undefined,
    }
    releaseWait(null)
    await observation

    expect(timeoutCalls).toBe(1)
    expect(current).toMatchObject({
      paymentStatus: "paid",
      proofDeliveryStatus: "sent",
      zapReceiptStatus: "observed",
      zapReceiptId: "zap-receipt-current",
    })
    expect(current.lastError).toBeUndefined()
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

  it("retains the recovery marker after a claimed write fails indeterminately", async () => {
    const orderId = "order-payment-claimed-patch-failure"
    let stored = lifecycle({
      orderId,
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
    let clearCalls = 0

    table.get = (async () => stored) as typeof table.get
    table.put = (async (next: OrderLifecycle) => {
      stored = next
      return next.orderId
    }) as typeof table.put

    try {
      await expect(
        runOrderPayment(
          basePaymentContext({ orderId }),
          paymentDependencies({
            patchClaimedOrderLifecyclePayment: async () => {
              throw new Error("IndexedDB patch unavailable")
            },
            clearOrderPaymentClaim: () => {
              clearCalls += 1
              return true
            },
          })
        )
      ).rejects.toThrow("IndexedDB patch unavailable")
      expect(stored.paymentClaimId).toBeTruthy()
      expect(clearCalls).toBe(0)
      expect(isOrderPaymentRunning(orderId)).toBe(false)
    } finally {
      table.get = originalGet
      table.put = originalPut
    }
  })
})
