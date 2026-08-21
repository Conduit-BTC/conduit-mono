import { afterEach, describe, expect, it } from "bun:test"

import {
  disconnectNdk,
  EVENT_KINDS,
  getNdk,
  removeSigner,
  setSigner,
  type OrderLifecycle,
  type OrderRelayDeliveryRecord,
  type SignedPublicNostrEvent,
} from "@conduit/core"

import {
  buildPaymentProofRumor,
  prepareBuyerRumor,
  publishBuyerOrderMessage,
  submitBuyerOrderMessage,
} from "../apps/market/src/lib/order-publish"

let activeSignerLease: ReturnType<typeof setSigner> | null = null

describe("buyer order rumor preparation", () => {
  it("recreates the same payment-proof rumor id for receipt retries", () => {
    const params = {
      merchantPubkey: "merchant-pubkey",
      orderId: "guest-order",
      amountSats: 12,
      currency: "SATS",
      content: '{"zapReceiptId":"receipt-id"}',
      createdAt: 1_700_000_000,
    }
    const first = buildPaymentProofRumor(params)
    const retry = buildPaymentProofRumor(params)

    prepareBuyerRumor(first, "guest-pubkey")
    prepareBuyerRumor(retry, "guest-pubkey")

    expect(first.created_at).toBe(params.createdAt)
    expect(retry.id).toBe(first.id)
  })
})

function orderRumor(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-rumor",
    kind: EVENT_KINDS.ORDER,
    pubkey: "",
    created_at: 100,
    content: JSON.stringify({
      id: "guest-order",
      merchantPubkey: "merchant-pubkey",
      buyerPubkey: "buyer-pubkey",
      items: [
        {
          productId: "product-id",
          quantity: 1,
          priceAtPurchase: 1,
          currency: "SATS",
        },
      ],
      subtotal: 1,
      currency: "SATS",
      createdAt: 100_000,
    }),
    tags: [
      ["p", "merchant-pubkey"],
      ["type", "order"],
      ["order", "guest-order"],
    ],
    ...overrides,
  } as never
}

describe("buyer order publishing", () => {
  afterEach(() => {
    if (activeSignerLease) {
      removeSigner(activeSignerLease)
      activeSignerLease = null
    }
    disconnectNdk()
  })

  it("delegates signed-in delivery and self-copy to the shared boundary", async () => {
    const signer = { id: "connected-signer" }
    let captured: Record<string, unknown> | undefined
    let cached = false

    const result = await publishBuyerOrderMessage(
      orderRumor(),
      { signer } as never,
      "merchant-pubkey",
      "buyer-pubkey",
      {
        publishPrivateMessageFn: async (input) => {
          captured = input as unknown as Record<string, unknown>
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: { id: "self-wrap" } as never,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => {
          cached = true
          return null
        },
      }
    )

    expect(captured?.senderPubkey).toBe("buyer-pubkey")
    expect(captured?.recipientPubkey).toBe("merchant-pubkey")
    expect(captured?.signer).toBe(signer)
    expect(captured?.rumorKind).toBe(EVENT_KINDS.ORDER)
    expect(captured?.selfCopy).toBe(true)
    expect(captured?.validatedOrderScope).toMatchObject({
      rumorId: "order-rumor",
      orderId: "guest-order",
      senderPubkey: "buyer-pubkey",
      recipientPubkey: "merchant-pubkey",
    })
    expect(cached).toBe(true)
    expect(result).toEqual({
      buyerSelfCopyError: null,
      localCacheError: null,
      deliveryRoute: "declared_inbox",
    })
  })

  it("uses the scoped guest signer without a self-copy or durable cache", async () => {
    const guestSigner = { id: "guest-signer" }
    let captured: Record<string, unknown> | undefined
    let cacheAttempts = 0

    await publishBuyerOrderMessage(
      orderRumor(),
      { signer: { id: "connected-signer" } } as never,
      "merchant-pubkey",
      {
        kind: "guest_ephemeral",
        pubkey: "guest-pubkey",
        signer: guestSigner as never,
        orderId: "guest-order",
        merchantPubkey: "merchant-pubkey",
      },
      {
        publishPrivateMessageFn: async (input) => {
          captured = input as unknown as Record<string, unknown>
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "compatibility_order" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => {
          cacheAttempts += 1
          return null
        },
      }
    )

    expect(captured?.senderPubkey).toBe("guest-pubkey")
    expect(captured?.signer).toBe(guestSigner)
    expect(captured?.selfCopy).toBe(false)
    expect(captured?.validatedOrderScope).toMatchObject({
      rumorId: "order-rumor",
      orderId: "guest-order",
      senderPubkey: "guest-pubkey",
      recipientPubkey: "merchant-pubkey",
    })
    expect(cacheAttempts).toBe(0)
  })

  it("rejects guest messages outside the bound order", async () => {
    let publishAttempts = 0
    await expect(
      publishBuyerOrderMessage(
        orderRumor({
          tags: [
            ["p", "merchant-pubkey"],
            ["type", "payment_proof"],
            ["order", "other-order"],
          ],
        }),
        {} as never,
        "merchant-pubkey",
        {
          kind: "guest_ephemeral",
          pubkey: "guest-pubkey",
          signer: {} as never,
          orderId: "expected-order",
          merchantPubkey: "merchant-pubkey",
        },
        {
          publishPrivateMessageFn: async () => {
            publishAttempts += 1
            throw new Error("unexpected publish")
          },
        }
      )
    ).rejects.toThrow("Guest order message is outside its signer scope.")
    expect(publishAttempts).toBe(0)
  })

  it("fails before publishing when no buyer signer is available", async () => {
    let publishAttempts = 0
    await expect(
      publishBuyerOrderMessage(
        orderRumor(),
        {} as never,
        "merchant-pubkey",
        "buyer-pubkey",
        {
          publishPrivateMessageFn: async () => {
            publishAttempts += 1
            throw new Error("unexpected publish")
          },
        }
      )
    ).rejects.toThrow("Buyer order signer is not connected.")
    expect(publishAttempts).toBe(0)
  })

  it("preserves connected buyer signing across an NDK transport reset", async () => {
    const buyerPubkey = "b".repeat(64)
    const signer = {
      pubkey: buyerPubkey,
      user: async () => ({ pubkey: buyerPubkey }),
    }
    let publishAttempts = 0

    activeSignerLease = setSigner(signer as never)
    const originalNdk = getNdk()
    disconnectNdk()
    const replacementNdk = getNdk()

    expect(replacementNdk).not.toBe(originalNdk)
    expect(replacementNdk.signer).toBe(signer)

    await publishBuyerOrderMessage(
      orderRumor(),
      replacementNdk,
      "merchant-pubkey",
      {
        kind: "signed_in",
        pubkey: buyerPubkey,
        signer: signer as never,
      },
      {
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: { id: "self-wrap" } as never,
            selfCopyError: null,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    expect(publishAttempts).toBe(1)
  })
})

const signedRecipientWrap: SignedPublicNostrEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1_700_000_000,
  kind: EVENT_KINDS.GIFT_WRAP,
  tags: [["p", "merchant-pubkey"]],
  content: "encrypted-gift-wrap",
  sig: "c".repeat(128),
}

function stagedDelivery(): OrderRelayDeliveryRecord {
  return {
    signedRecipientWrap,
    route: "declared_inbox",
    relayDelivery: [
      {
        relayUrl: "wss://merchant.inbox.conduit.market",
        source: "declared",
        status: "pending",
        attemptCount: 0,
      },
    ],
    deliveryAttemptCount: 0,
    retryCount: 0,
    createdAt: 100,
    updatedAt: 100,
    expiresAt: 86_400_100,
  }
}

function lifecycleDraft() {
  return {
    orderId: "guest-order",
    createdAt: 100_000,
    buyerPubkey: "buyer-pubkey",
    buyerIdentityKind: "signed_in" as const,
    merchantPubkey: "merchant-pubkey",
    checkoutMode: "pay_later" as const,
    items: [],
    itemSubtotalSats: 1,
    shippingCostSats: 0,
    totalSats: 1,
    totalMsats: 1_000,
    currency: "SATS",
    addressValidity: "not_required" as const,
    shippingZoneEligibility: "not_required" as const,
    invoiceStatus: "not_requested" as const,
    paymentStatus: "not_started" as const,
    proofDeliveryStatus: "not_started" as const,
    zapReceiptStatus: "not_applicable" as const,
  }
}

function lifecycleStore() {
  let value: OrderLifecycle | undefined
  return {
    create: async (input: Record<string, unknown>) => {
      value = {
        ...input,
        phase: "pending",
        updatedAt: 100,
      } as OrderLifecycle
      return structuredClone(value)
    },
    record: async (_orderId: string, delivery: OrderRelayDeliveryRecord) => {
      if (!value) throw new Error("missing staged lifecycle")
      value = {
        ...value,
        orderDeliveryStatus: delivery.relayDelivery.some(
          (target) => target.status === "acked"
        )
          ? "sent"
          : "pending",
        orderRelayDelivery: structuredClone(delivery),
      }
      return structuredClone(value)
    },
    read: () => structuredClone(value),
  }
}

describe("durable buyer order submission", () => {
  it("stores the lifecycle checkpoint before the first network call", async () => {
    const store = lifecycleStore()
    const steps: string[] = []
    const staged = stagedDelivery()
    const settled: OrderRelayDeliveryRecord = {
      ...staged,
      relayDelivery: [
        {
          ...staged.relayDelivery[0]!,
          status: "acked",
          attemptCount: 1,
          acknowledgedAt: 110,
        },
      ],
      deliveryAttemptCount: 1,
      updatedAt: 110,
    }

    const result = await submitBuyerOrderMessage(
      {
        rumor: orderRumor(),
        ndk: { signer: { id: "connected-signer" } } as never,
        merchantPubkey: "merchant-pubkey",
        buyer: "buyer-pubkey",
        lifecycle: lifecycleDraft(),
      },
      {
        createOrderLifecycleFn: async (input) => {
          steps.push("persist")
          return store.create(input)
        },
        recordOrderRelayDeliveryUpdateFn: store.record as never,
        cacheBuyerOrderRumorFn: async () => null,
        publishPrivateMessageFn: async (input) => {
          await input.onWrapped?.({
            rumorId: "order-rumor",
            wrappedToRecipient: { id: signedRecipientWrap.id } as never,
            wrappedToSelf: null,
            orderRelayDelivery: staged,
          })
          steps.push("publish")
          expect(store.read()?.orderRelayDelivery).toEqual(staged)
          await input.onOrderRelayDeliveryUpdated?.(settled)
          return {
            wrappedToRecipient: { id: signedRecipientWrap.id } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
            orderRelayDelivery: settled,
          } as never
        },
      }
    )

    expect(steps).toEqual(["persist", "publish"])
    expect(result.orderDeliveryStatus).toBe("sent")
    expect(store.read()?.orderDeliveryStatus).toBe("sent")
  })

  it("returns a restart-safe queued order after zero ACK", async () => {
    const store = lifecycleStore()
    const staged = stagedDelivery()
    const timedOut: OrderRelayDeliveryRecord = {
      ...staged,
      relayDelivery: [
        {
          ...staged.relayDelivery[0]!,
          status: "timed_out",
          attemptCount: 1,
          timedOutAt: 110,
        },
      ],
      deliveryAttemptCount: 1,
      nextRetryAt: 1_000,
      updatedAt: 110,
    }

    const result = await submitBuyerOrderMessage(
      {
        rumor: orderRumor(),
        ndk: { signer: { id: "connected-signer" } } as never,
        merchantPubkey: "merchant-pubkey",
        buyer: "buyer-pubkey",
        lifecycle: lifecycleDraft(),
      },
      {
        createOrderLifecycleFn: store.create as never,
        recordOrderRelayDeliveryUpdateFn: store.record as never,
        publishPrivateMessageFn: async (input) => {
          await input.onWrapped?.({
            rumorId: "order-rumor",
            wrappedToRecipient: { id: signedRecipientWrap.id } as never,
            wrappedToSelf: null,
            orderRelayDelivery: staged,
          })
          await input.onOrderRelayDeliveryUpdated?.(timedOut)
          throw new Error("No relay accepted the order")
        },
      }
    )

    expect(result.orderDeliveryStatus).toBe("pending")
    expect(result.deliveryRoute).toBe("declared_inbox")
    expect(store.read()?.orderDeliveryStatus).toBe("pending")
    expect(store.read()?.orderRelayDelivery).toEqual(timedOut)
  })

  it("does no network work when the pre-publish checkpoint fails", async () => {
    let networkCalls = 0
    await expect(
      submitBuyerOrderMessage(
        {
          rumor: orderRumor(),
          ndk: { signer: { id: "connected-signer" } } as never,
          merchantPubkey: "merchant-pubkey",
          buyer: "buyer-pubkey",
          lifecycle: lifecycleDraft(),
        },
        {
          createOrderLifecycleFn: async () => {
            throw new Error("IndexedDB unavailable")
          },
          publishPrivateMessageFn: async (input) => {
            await input.onWrapped?.({
              rumorId: "order-rumor",
              wrappedToRecipient: { id: signedRecipientWrap.id } as never,
              wrappedToSelf: null,
              orderRelayDelivery: stagedDelivery(),
            })
            networkCalls += 1
            throw new Error("unexpected publish")
          },
        }
      )
    ).rejects.toThrow("IndexedDB unavailable")
    expect(networkCalls).toBe(0)
  })

  it("rejects a guest submission mislabeled as a signed-in lifecycle", async () => {
    let publishAttempts = 0

    await expect(
      submitBuyerOrderMessage(
        {
          rumor: orderRumor(),
          ndk: { signer: undefined } as never,
          merchantPubkey: "merchant-pubkey",
          buyer: {
            kind: "guest_ephemeral",
            pubkey: "buyer-pubkey",
            signer: { id: "guest-signer" } as never,
            orderId: "guest-order",
            merchantPubkey: "merchant-pubkey",
          },
          lifecycle: lifecycleDraft(),
        },
        {
          publishPrivateMessageFn: async () => {
            publishAttempts += 1
            throw new Error("unexpected publish")
          },
        }
      )
    ).rejects.toThrow("identity does not match")
    expect(publishAttempts).toBe(0)
  })
})
