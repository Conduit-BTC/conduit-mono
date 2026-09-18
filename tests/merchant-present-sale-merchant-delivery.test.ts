import { describe, expect, it } from "bun:test"
import type { NDKSigner } from "@nostr-dev-kit/ndk"

import {
  getMerchantPresentSaleCommerceFingerprintRef,
  type OrderSchema,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  canRenderMerchantPresentSaleDirectWrapQr,
  deliverMerchantPresentSaleAuthorization,
  getMerchantPresentSaleDeliveryMode,
  prepareMerchantPresentSaleAuthorization,
  type MerchantPresentSaleDeliveryDependencies,
} from "../apps/merchant/src/lib/merchant-present-sale-authorization"

const merchantPubkey = "a".repeat(64)
const buyerPubkey = "b".repeat(64)
const organizerPubkey = "c".repeat(64)
const productCoordinate = `30402:${merchantPubkey}:beans`
const calendarCoordinate = `31923:${organizerPubkey}:market-day`
const collectionCoordinate = `30405:${organizerPubkey}:market-day`
const pickupCoordinate = `30406:${merchantPubkey}:market-day-booth`

function boothOrder(
  buyerIdentityKind: "signed_in" | "guest_ephemeral" = "signed_in"
): OrderSchema {
  return {
    id: "booth-order",
    merchantPubkey,
    buyerPubkey,
    buyerIdentityKind,
    items: [
      {
        productId: productCoordinate,
        title: "Coffee beans",
        format: "physical",
        fulfillment: {
          type: "pickup",
          organizerPubkey,
          product: {
            coordinate: productCoordinate,
            eventId: "1".repeat(64),
            createdAt: 100,
            merchantPubkey,
          },
          calendar: {
            coordinate: calendarCoordinate,
            eventId: "2".repeat(64),
            createdAt: 101,
          },
          collection: {
            coordinate: collectionCoordinate,
            eventId: "3".repeat(64),
            createdAt: 102,
          },
          option: {
            coordinate: pickupCoordinate,
            eventId: "4".repeat(64),
            createdAt: 103,
            title: "Merchant booth",
            location: "North hall",
          },
          handoffMode: "merchant_handoff",
          handlerPubkey: merchantPubkey,
          costSats: 0,
          sourceCost: {
            amount: 0,
            currency: "SAT",
            normalizedCurrency: "SAT",
          },
        },
        quantity: 2,
        priceAtPurchase: 21,
        currency: "USD",
        shippingCostSats: 0,
        sourceShippingCost: {
          amount: 0,
          currency: "SAT",
          normalizedCurrency: "SAT",
        },
        shippingOptionId: pickupCoordinate,
        shippingOptionDTag: "market-day-booth",
      },
    ],
    subtotal: 42,
    currency: "USD",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    purchaseContext: {
      type: "merchant_present",
      merchantPubkey,
      collection: {
        coordinate: collectionCoordinate,
        eventId: "3".repeat(64),
        createdAt: 102,
      },
      reviewedCommerceFingerprintRef:
        getMerchantPresentSaleCommerceFingerprintRef("reviewed-terms"),
    },
    createdAt: 1_000_000,
  }
}

const directWrap: SignedPublicNostrEvent = {
  id: "5".repeat(64),
  pubkey: "6".repeat(64),
  created_at: 1_000,
  kind: 1059,
  tags: [["p", buyerPubkey]],
  content: "encrypted",
  sig: "7".repeat(128),
}

function dependencies(
  calls: string[]
): MerchantPresentSaleDeliveryDependencies {
  return {
    prepareGuestWrap: async () => {
      calls.push("guest")
      return directWrap
    },
    publishSignedIn: async () => {
      calls.push("signed")
      return {
        deliveryRoute: "declared_inbox",
        deliveryStatus: "full_success",
        selfCopyError: null,
      }
    },
  }
}

describe("merchant booth authorization delivery", () => {
  it("exposes only explicit authenticated merchant-present orders", () => {
    const signedIn = boothOrder("signed_in")
    const guest = boothOrder("guest_ephemeral")
    const remote = boothOrder()
    delete remote.purchaseContext

    expect(getMerchantPresentSaleDeliveryMode(signedIn, merchantPubkey)).toBe(
      "signed_in_private"
    )
    expect(getMerchantPresentSaleDeliveryMode(guest, merchantPubkey)).toBe(
      "guest_direct"
    )
    expect(
      getMerchantPresentSaleDeliveryMode(remote, merchantPubkey)
    ).toBeNull()
    expect(
      getMerchantPresentSaleDeliveryMode(signedIn, "d".repeat(64))
    ).toBeNull()
  })

  it("reuses one exact capability for delivery retries and replaces it after expiry", () => {
    const order = boothOrder()
    const first = prepareMerchantPresentSaleAuthorization({
      order,
      merchantPubkey,
      now: 1_000,
      createNonce: () => "8".repeat(64),
    })
    const retry = prepareMerchantPresentSaleAuthorization({
      order,
      merchantPubkey,
      previous: first,
      now: 1_100,
      createNonce: () => "9".repeat(64),
    })
    const expired = prepareMerchantPresentSaleAuthorization({
      order,
      merchantPubkey,
      previous: first,
      now: first.expiresAt,
      createNonce: () => "9".repeat(64),
    })

    expect(retry).toBe(first)
    expect(expired.nonce).toBe("9".repeat(64))
    expect(expired).not.toEqual(first)
  })

  it("does not reuse a capability after exact quantities change", () => {
    const firstOrder = boothOrder()
    const first = prepareMerchantPresentSaleAuthorization({
      order: firstOrder,
      merchantPubkey,
      now: 1_000,
      createNonce: () => "8".repeat(64),
    })
    const changedOrder = boothOrder()
    changedOrder.items[0]!.quantity = 3
    changedOrder.subtotal = 63
    const changed = prepareMerchantPresentSaleAuthorization({
      order: changedOrder,
      merchantPubkey,
      previous: first,
      now: 1_100,
      createNonce: () => "9".repeat(64),
    })

    expect(changed.nonce).toBe("9".repeat(64))
    expect(changed.items[0]?.quantity).toBe(3)
  })

  it("uses the private order channel for signed-in buyers only", async () => {
    const calls: string[] = []
    const order = boothOrder("signed_in")
    const authorization = prepareMerchantPresentSaleAuthorization({
      order,
      merchantPubkey,
      now: 1_000,
      createNonce: () => "8".repeat(64),
    })
    const result = await deliverMerchantPresentSaleAuthorization(
      {
        authorization,
        order,
        merchantPubkey,
        signer: {} as NDKSigner,
        authenticatedPubkey: merchantPubkey,
        shouldContinue: () => true,
      },
      dependencies(calls)
    )

    expect(calls).toEqual(["signed"])
    expect(result).toMatchObject({
      mode: "signed_in_private",
      deliveryRoute: "declared_inbox",
      deliveryStatus: "full_success",
    })
  })

  it("prepares one exact direct wrap for a guest without publishing", async () => {
    const calls: string[] = []
    const order = boothOrder("guest_ephemeral")
    const authorization = prepareMerchantPresentSaleAuthorization({
      order,
      merchantPubkey,
      now: 1_000,
      createNonce: () => "8".repeat(64),
    })
    const result = await deliverMerchantPresentSaleAuthorization(
      {
        authorization,
        order,
        merchantPubkey,
        signer: {} as NDKSigner,
        authenticatedPubkey: merchantPubkey,
        shouldContinue: () => true,
      },
      dependencies(calls)
    )

    expect(calls).toEqual(["guest"])
    expect(result.mode).toBe("guest_direct")
    if (result.mode !== "guest_direct") throw new Error("Expected guest wrap")
    expect(JSON.parse(result.transferValue)).toEqual(directWrap)
  })

  it("renders a single QR only when the exact encrypted wrap safely fits", () => {
    expect(canRenderMerchantPresentSaleDirectWrapQr("a".repeat(2_800))).toBe(
      true
    )
    expect(canRenderMerchantPresentSaleDirectWrapQr("a".repeat(2_801))).toBe(
      false
    )
  })
})
