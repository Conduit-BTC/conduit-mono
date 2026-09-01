import { EVENT_KINDS, type OrderRelayDeliveryRecord } from "@conduit/core"

import {
  CART_STORAGE_KEY,
  reconcilePendingOrderCartRetirements,
} from "../hooks/useCart"
import { buildOrderCartRetirement, parsePersistedCart } from "../lib/cart-model"
import type { ShippingFormState } from "../lib/checkout-validation"
import {
  clearCheckoutShippingSessionForOrderDelivery,
  reconcileCheckoutShippingSessionForOrderDelivery,
} from "../lib/checkout-session"
import { submitBuyerOrderMessage } from "../lib/order-publish"

function getPersistedCartRetirement(
  merchantPubkey: string,
  productId: string,
  now: number
) {
  const raw = window.localStorage.getItem(CART_STORAGE_KEY)
  if (!raw) throw new Error("Checkpoint harness cart is unavailable")
  const current = parsePersistedCart(JSON.parse(raw)).state
  const item = current.items.find(
    (candidate) =>
      candidate.merchantPubkey === merchantPubkey &&
      candidate.productId === productId
  )
  if (!item) throw new Error("Checkpoint harness cart item is unavailable")
  return buildOrderCartRetirement([item], now)
}

/**
 * Browser-only harness for the crash boundary between lifecycle persistence
 * and the first relay result. The returned promise resolves at the durable
 * checkpoint while the mocked relay publication remains intentionally open.
 */
export async function startInterruptedOrderCheckpoint(input: {
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
  productId: string
  buyerIdentityKind?: "guest_ephemeral" | "signed_in"
  shippingDraft?: ShippingFormState
  firstAttemptAck?: boolean
  skipImmediateCartReconciliation?: boolean
}): Promise<void> {
  const now = Date.now()
  const buyerIdentityKind = input.buyerIdentityKind ?? "signed_in"
  const cartRetirement = getPersistedCartRetirement(
    input.merchantPubkey,
    input.productId,
    now
  )
  const signedRecipientWrap = {
    id: "c".repeat(64),
    pubkey: "d".repeat(64),
    created_at: Math.floor(now / 1_000),
    kind: EVENT_KINDS.GIFT_WRAP,
    tags: [["p", input.merchantPubkey]],
    content: "encrypted-checkpoint-wrap",
    sig: "e".repeat(128),
  }
  const stagedDelivery: OrderRelayDeliveryRecord = {
    signedRecipientWrap,
    route: "declared_inbox",
    relayDelivery: [
      {
        relayUrl: "wss://checkpoint.conduit.market",
        source: "declared",
        status: "pending",
        attemptCount: 0,
      },
    ],
    deliveryAttemptCount: 0,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 86_400_000,
  }
  let resolveCheckpoint!: () => void
  let rejectCheckpoint!: (error: unknown) => void
  const checkpoint = new Promise<void>((resolve, reject) => {
    resolveCheckpoint = resolve
    rejectCheckpoint = reject
  })
  const signer = { pubkey: input.buyerPubkey }

  const submission = submitBuyerOrderMessage(
    {
      rumor: {
        id: "f".repeat(64),
        kind: EVENT_KINDS.ORDER,
        pubkey: input.buyerPubkey,
        created_at: Math.floor(now / 1_000),
        tags: [
          ["p", input.merchantPubkey],
          ["type", "order"],
          ["order", input.orderId],
          ["client", "Conduit Market"],
        ],
        content: JSON.stringify({
          id: input.orderId,
          merchantPubkey: input.merchantPubkey,
          buyerPubkey: input.buyerPubkey,
          buyerIdentityKind,
          items: [
            {
              productId: input.productId,
              title: "Checkpoint product",
              format: "digital",
              quantity: 1,
              priceAtPurchase: 1,
              currency: "SATS",
            },
          ],
          subtotal: 1,
          currency: "SATS",
          shippingCostStatus: "not_required",
          guestContact:
            buyerIdentityKind === "guest_ephemeral"
              ? {
                  email: "guest@example.invalid",
                  phone: "+1-555-0100",
                }
              : undefined,
          createdAt: now,
        }),
      } as never,
      ndk: { signer } as never,
      merchantPubkey: input.merchantPubkey,
      buyer:
        buyerIdentityKind === "guest_ephemeral"
          ? ({
              kind: "guest_ephemeral",
              orderId: input.orderId,
              merchantPubkey: input.merchantPubkey,
              createdAt: now,
              expiresAt: now + 86_400_000,
              pubkey: input.buyerPubkey,
              signer: signer as never,
            } as never)
          : {
              kind: "signed_in",
              pubkey: input.buyerPubkey,
              signer: signer as never,
            },
      lifecycle: {
        orderId: input.orderId,
        createdAt: now,
        buyerPubkey: input.buyerPubkey,
        buyerIdentityKind,
        merchantPubkey: input.merchantPubkey,
        cartRetirement,
        checkoutMode: "pay_later",
        items: [
          {
            productId: input.productId,
            title: "Checkpoint product",
            format: "digital",
            quantity: 1,
            priceAtPurchase: 1,
            currency: "SATS",
          },
        ],
        itemSubtotalSats: 1,
        shippingCostSats: 0,
        totalSats: 1,
        totalMsats: 1_000,
        currency: "SATS",
        addressValidity: "not_required",
        shippingZoneEligibility: "not_required",
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
        zapReceiptStatus: "not_applicable",
      },
      onLifecycleCheckpointed: () => {
        void (async () => {
          if (input.shippingDraft) {
            reconcileCheckoutShippingSessionForOrderDelivery(
              {
                orderId: input.orderId,
                buyerIdentityKind,
                orderDeliveryStatus: "pending",
                value: input.shippingDraft,
              },
              undefined,
              now
            )
          }
          if (!input.skipImmediateCartReconciliation) {
            await reconcilePendingOrderCartRetirements()
          }
          if (!input.firstAttemptAck) resolveCheckpoint()
        })().catch((error) => {
          rejectCheckpoint(error)
        })
      },
      onOrderDeliveryCommitted: ({ orderDeliveryStatus }) => {
        if (!input.firstAttemptAck || orderDeliveryStatus !== "sent") return
        try {
          clearCheckoutShippingSessionForOrderDelivery(input.orderId)
          resolveCheckpoint()
        } catch (error) {
          rejectCheckpoint(error)
        }
      },
    },
    {
      cacheBuyerOrderRumorFn: async () => null,
      publishPrivateMessageFn: async (publishInput) => {
        await publishInput.onWrapped?.({
          rumorId: "f".repeat(64),
          wrappedToRecipient: signedRecipientWrap as never,
          wrappedToSelf: null,
          orderRelayDelivery: stagedDelivery,
        })
        if (input.firstAttemptAck) {
          const acknowledgedAt = Date.now()
          await publishInput.onOrderRelayDeliveryUpdated?.({
            ...stagedDelivery,
            relayDelivery: stagedDelivery.relayDelivery.map((target) => ({
              ...target,
              status: "acked" as const,
              attemptCount: 1,
              acknowledgedAt,
            })),
            deliveryAttemptCount: 1,
            updatedAt: acknowledgedAt,
          })
        }
        return await new Promise<never>(() => {})
      },
    }
  )
  void submission.catch(rejectCheckpoint)
  await checkpoint
}
