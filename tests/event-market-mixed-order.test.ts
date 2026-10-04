import { NDKEvent } from "@nostr-dev-kit/ndk"
import { afterEach, describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetFutureMarketHandoffTestState,
  __setCommerceTestOverrides,
  buildFutureMarketPrivateRumor,
  buildFutureMarketReadyReceipt,
  orderSchema,
  readFutureMarketMerchantClaim,
  verifyEventMarketOrderEvidence,
} from "@conduit/core"
import { getMerchantOrderFulfillment } from "../apps/merchant/src/lib/order-phase"
import { verifyFutureEventMarketOrderAuthorization } from "../apps/merchant/src/lib/order-pickup-authorization"
import { assertCreatedEventMarketPickupTerms } from "../apps/market/src/lib/order-pickup-retry"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"
import { plainTestSigner } from "./helpers/plain-signer"

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetFutureMarketHandoffTestState()
})

function mixedOrder() {
  const fixture = createEventMarketOrderFixture()
  const digital = {
    productId: `30402:${fixture.merchant}:download`,
    title: "Digital guide",
    format: "digital" as const,
    fulfillment: { type: "digital" as const },
    quantity: 1,
    priceAtPurchase: 50,
    currency: "SATS",
    shippingCostSats: 0,
  }
  const order = orderSchema.parse({
    ...fixture.order,
    items: [digital, ...fixture.order.items],
    subtotal: fixture.order.subtotal + digital.priceAtPurchase,
  })
  return { ...fixture, order, digital }
}

describe("Event Market pickup with a digital order line", () => {
  it("accepts the full paid order while releasing only physical pickup items", async () => {
    const { order, merchant, digital } = mixedOrder()
    expect(verifyEventMarketOrderEvidence({ order, events: [] }).status).toBe(
      "verified"
    )
    expect(
      await verifyFutureEventMarketOrderAuthorization({
        order,
        merchantPubkey: merchant,
      })
    ).toMatchObject({ status: "verified" })
    expect(() => assertCreatedEventMarketPickupTerms(order)).not.toThrow()
    expect(getMerchantOrderFulfillment(order.items)).toMatchObject({
      mode: "pickup",
      requiresShipping: false,
      hasPickupClaim: true,
    })
    const receipt = buildFutureMarketReadyReceipt({
      order,
      signedOrderEvidence: [],
      paymentAuthenticated: true,
      releaseConfirmed: true,
    })
    expect(receipt.items).toHaveLength(1)
    expect(receipt.items[0]?.product.coordinate).toBe(order.items[1]?.productId)
    expect(JSON.stringify(receipt)).not.toContain(digital.productId)
  })

  it("still requires payment for a priced digital extra", () => {
    const { order } = mixedOrder()
    expect(() =>
      buildFutureMarketReadyReceipt({
        order,
        signedOrderEvidence: [],
        paymentAuthenticated: false,
        releaseConfirmed: true,
      })
    ).toThrow("Payment")
  })

  it("recovers the exact physical receipt when a digital line comes first", async () => {
    const { order, merchant } = mixedOrder()
    const receipt = buildFutureMarketReadyReceipt({
      order,
      signedOrderEvidence: [],
      paymentAuthenticated: true,
      releaseConfirmed: true,
    })
    const ready = buildFutureMarketPrivateRumor(receipt)
    const relaySecret = generateSecretKey()
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getAccountSigner: () =>
        plainTestSigner({
          user: async () => ({ pubkey: merchant }),
          sign: async () => "",
        } as never),
      resolveInboxRelayUrls: async () => ["wss://mixed-order.inbox.test"],
      fetchEventsFanoutWithDiagnostics: async (_filter, options) => ({
        events: [
          new NDKEvent(
            undefined,
            finalizeEvent(
              {
                kind: 1059,
                created_at: 250,
                tags: [["p", merchant]],
                content: ready.id!,
              },
              relaySecret
            )
          ),
        ],
        attemptedRelayUrls: [...(options?.relayUrls ?? [])],
        successfulRelayUrls: [...(options?.relayUrls ?? [])],
        failedRelayUrls: [],
        cappedRelayUrls: [],
      }),
      giftUnwrap: async () => ready,
    })
    const recovered = await readFutureMarketMerchantClaim({
      order,
      merchantPubkey: merchant,
    })
    expect(recovered.claim?.state).toBe("ready_for_pickup")
    expect(recovered.claim?.receipt.payload.items).toHaveLength(1)
  })

  it("rejects shipping mixed into a pickup order", () => {
    const { order } = mixedOrder()
    expect(
      orderSchema.safeParse({
        ...order,
        items: [
          ...order.items,
          {
            ...order.items[0],
            format: "physical",
            fulfillment: { type: "shipping" },
          },
        ],
      }).success
    ).toBe(false)
  })
})
