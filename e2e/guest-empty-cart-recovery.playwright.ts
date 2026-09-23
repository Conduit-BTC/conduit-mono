import path from "node:path"
import { expect, test } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

test("accepted guest order reopens after an empty-cart reload @market", async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.goto(`${marketUrl}/checkout`)
  await expect(
    page.getByRole("heading", { name: "Cart is empty" })
  ).toBeVisible()

  const orderId = await page.evaluate(async (rootPath) => {
    const { db } = await import(`/@fs${rootPath}/packages/core/src/index.ts`)
    const modulePath = "/src/lib/guest-order-identity.ts"
    const { createSessionGuestOrderSigningIdentity } = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import("../apps/market/src/lib/guest-order-identity")
    const cartRepositoryPath = "/src/lib/cart-repository.ts"
    const cartModelPath = "/src/lib/cart-model.ts"
    const cartRepository = (await import(
      /* @vite-ignore */ cartRepositoryPath
    )) as typeof import("../apps/market/src/lib/cart-repository")
    const { groupCartPurchases } = (await import(
      /* @vite-ignore */ cartModelPath
    )) as typeof import("../apps/market/src/lib/cart-model")
    const orderId = crypto.randomUUID()
    const merchantPubkey = "a".repeat(64)
    await cartRepository.initializeCartRepository()
    await cartRepository.addCartRepositoryItem({
      productId: `30402:${merchantPubkey}:guest-recovery`,
      merchantPubkey,
      title: "Guest recovery fixture",
      price: 1_000,
      priceSats: 1_000,
      currency: "SATS",
      format: "digital",
      fulfillment: { type: "digital" },
    })
    const purchase = groupCartPurchases(
      cartRepository.getCartRepositorySnapshot().items
    )[0]!
    const claim = await cartRepository.captureCartPurchase(
      purchase.id,
      purchase.items
    )
    await cartRepository.consumeCartPurchase(claim)
    if (cartRepository.getCartRepositorySnapshot().items.length !== 0) {
      throw new Error("The checkout fixture did not consume its cart purchase.")
    }
    const guest = createSessionGuestOrderSigningIdentity(
      orderId,
      merchantPubkey
    )
    const now = Date.now()
    await db.orderLifecycles.put({
      orderId,
      buyerPubkey: guest.pubkey,
      buyerIdentityKind: "guest_ephemeral",
      merchantPubkey,
      checkoutMode: "external_wallet",
      paymentTarget: { type: "manual" },
      merchantLightningAddress: "merchant@merchant-fixture.dev",
      items: [
        {
          productId: `30402:${merchantPubkey}:guest-recovery`,
          title: "Guest recovery fixture",
          format: "digital",
          quantity: 1,
          priceAtPurchase: 1_000,
          currency: "SATS",
        },
      ],
      itemSubtotalSats: 1_000,
      shippingCostSats: 0,
      totalSats: 1_000,
      totalMsats: 1_000_000,
      currency: "SATS",
      addressValidity: "not_required",
      shippingZoneEligibility: "not_required",
      orderDeliveryStatus: "sent",
      orderDeliveryRoute: "declared_inbox",
      orderRelayDelivery: {
        rumorId: "f".repeat(64),
        signedRecipientWrap: {
          id: "e".repeat(64),
          sig: "d".repeat(128),
          pubkey: "c".repeat(64),
          kind: 1059,
          created_at: Math.floor(now / 1_000),
          tags: [["p", merchantPubkey]],
          content: "synthetic encrypted wrap",
        },
        route: "declared_inbox",
        relayDelivery: [
          {
            relayUrl: "ws://127.0.0.1:7777",
            source: "declared",
            status: "acked",
            attemptCount: 1,
            acknowledgedAt: now,
          },
        ],
        deliveryAttemptCount: 1,
        retryCount: 0,
        nextRetryAt: now + 10 * 60_000,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 10 * 60_000,
      },
      checkoutRecoveryPending: true,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
      proofDeliveryStatus: "not_started",
      zapReceiptStatus: "not_applicable",
      phase: "in_progress",
      createdAt: now,
      updatedAt: now,
    })
    return orderId
  }, path.resolve(process.cwd()))

  await page.reload()
  await expect(page).toHaveURL(new RegExp(`/orders\\?order=${orderId}$`))
  await expect(
    page.getByRole("heading", { name: "Orders", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Order accepted; payment has not started", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Continue payment" })
  ).toBeEnabled()
})
