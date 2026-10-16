import {
  installPrivateInboxTestRead,
  cleanupPrivateInboxTestReads,
} from "./helpers/private-inbox"
import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetCommerceTestOverrides,
  __resetFutureMarketHandoffTestState,
  buildFutureMarketPrivateRumor,
  buildFutureMarketReadyReceipt,
  orderSchema,
  readFutureMarketMerchantClaim,
  verifyEventMarketOrderEvidence,
  admitEmbeddedEventMarketOrderEvidence,
} from "@conduit/core"
import { getMerchantOrderFulfillment } from "../apps/merchant/src/lib/order-phase"
import { verifyFutureEventMarketOrderAuthorization } from "../apps/merchant/src/lib/order-pickup-authorization"
import { assertCreatedEventMarketPickupTerms } from "../apps/market/src/lib/order-pickup-retry"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

afterEach(async () => {
  await cleanupPrivateInboxTestReads()
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
    expect(
      verifyEventMarketOrderEvidence({
        order,
        events: await admitEmbeddedEventMarketOrderEvidence(order),
      }).status
    ).toBe("verified")
    expect(
      await verifyFutureEventMarketOrderAuthorization({
        order,
        merchantPubkey: merchant,
      })
    ).toMatchObject({ status: "verified" })
    await expect(
      assertCreatedEventMarketPickupTerms(order)
    ).resolves.toBeUndefined()
    expect(getMerchantOrderFulfillment(order.items)).toMatchObject({
      mode: "pickup",
      requiresShipping: false,
      hasPickupClaim: true,
    })
    const receipt = await buildFutureMarketReadyReceipt({
      order,
      signedOrderEvidence: [],
      paymentAuthenticated: true,
      releaseConfirmed: true,
    })
    expect(receipt.items).toHaveLength(1)
    expect(receipt.items[0]?.product.coordinate).toBe(order.items[1]?.productId)
    expect(JSON.stringify(receipt)).not.toContain(digital.productId)
  })

  it("still requires payment for a priced digital extra", async () => {
    const { order } = mixedOrder()
    await expect(
      (async () =>
        await buildFutureMarketReadyReceipt({
          order,
          signedOrderEvidence: [],
          paymentAuthenticated: false,
          releaseConfirmed: true,
        }))()
    ).rejects.toThrow("Payment")
  })

  it("recovers the exact physical receipt when a digital line comes first", async () => {
    const { order, merchant, merchantSecret } = mixedOrder()
    const receipt = await buildFutureMarketReadyReceipt({
      order,
      signedOrderEvidence: [],
      paymentAuthenticated: true,
      releaseConfirmed: true,
    })
    const ready = buildFutureMarketPrivateRumor(receipt)
    installPrivateInboxTestRead({
      principalSecret: merchantSecret,
      authorSecrets: [merchantSecret],
      rumors: [ready],
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
