import { expect, test, type Locator, type Page } from "@playwright/test"

import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  installTestSigner,
  seedMarketCart,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

test.setTimeout(60_000)
test.use({ trace: "off", screenshot: "off", video: "off" })

async function assertMobileViewport(page: Page): Promise<void> {
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /width=device-width/
  )
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1)
}

async function expectMobileSafeFont(control: Locator): Promise<void> {
  await expect(control).toBeVisible()
  const fontSize = await control.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize)
  )
  expect(fontSize).toBeGreaterThanOrEqual(16)
}

async function expectMobileTouchTarget(control: Locator): Promise<void> {
  await expect(control).toBeVisible()
  const box = await control.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(44)
  expect(box?.height).toBeGreaterThanOrEqual(44)
}

async function seedInterruptedPayment(
  page: Page,
  input: {
    orderId: string
    paymentClaimId: string
    invoice?: string
    preimage?: string
    storeMarker?: boolean
  }
): Promise<void> {
  await page.evaluate(
    async ({
      buyerPubkey,
      merchantPubkey,
      orderId,
      paymentClaimId,
      invoice,
      preimage,
      storeMarker,
    }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result)
      })
      if (!database.objectStoreNames.contains("orderLifecycles")) {
        database.close()
        throw new Error("orderLifecycles store is unavailable")
      }

      const now = Date.now()
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("orderLifecycles", "readwrite")
        transaction.objectStore("orderLifecycles").put({
          orderId,
          paymentClaimId,
          paymentClaimedAt: now - 20_000,
          paymentClaimLeaseExpiresAt: now - 1,
          buyerPubkey,
          buyerIdentityKind: "signed_in",
          merchantPubkey,
          merchantLightningAddress: "merchant@example.test",
          checkoutMode: "private_checkout",
          items: [
            {
              productId: "30402:fixture:mobile-recovery",
              displayTitle: "Mobile recovery fixture",
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
          orderDeliveryStatus: "sent",
          invoiceStatus: invoice ? "received" : "requesting",
          paymentStatus: preimage ? "paid" : invoice ? "paying" : "not_started",
          proofDeliveryStatus: preimage ? "pending" : "not_started",
          zapReceiptStatus: "not_applicable",
          phase: "in_progress",
          ...(invoice ? { invoice } : {}),
          ...(preimage
            ? { preimage, paymentHash: "fixture-payment-hash" }
            : {}),
          createdAt: now,
          updatedAt: now,
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      database.close()
      if (storeMarker !== false) {
        sessionStorage.setItem(
          "conduit:order-payment-claims",
          JSON.stringify({ [orderId]: paymentClaimId })
        )
      }
    },
    {
      buyerPubkey: TEST_BUYER_PUBKEY,
      merchantPubkey: TEST_MERCHANT_PUBKEY,
      ...input,
    }
  )
}

async function readRecoveredPayment(
  page: Page,
  orderId: string
): Promise<{
  paymentStatus?: string
  proofDeliveryStatus?: string
  paymentClaimId?: string
  marker: string | null
}> {
  return page.evaluate(async (paymentOrderId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const lifecycle = await new Promise<Record<string, unknown> | undefined>(
      (resolve, reject) => {
        const transaction = database.transaction("orderLifecycles", "readonly")
        const request = transaction
          .objectStore("orderLifecycles")
          .get(paymentOrderId)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }
    )
    database.close()
    return {
      paymentStatus: lifecycle?.paymentStatus as string | undefined,
      proofDeliveryStatus: lifecycle?.proofDeliveryStatus as string | undefined,
      paymentClaimId: lifecycle?.paymentClaimId as string | undefined,
      marker: sessionStorage.getItem("conduit:order-payment-claims"),
    }
  }, orderId)
}

test.describe("CND-162 mobile browser baseline", () => {
  test("market viewport, touch navigation, and cart survive history and refresh", async ({
    page,
  }) => {
    await page.goto(`${marketUrl}/products`)
    await assertMobileViewport(page)

    const search = page.getByRole("textbox", { name: "Search products" })
    await expectMobileSafeFont(search)
    await search.tap()
    await search.fill("relay")
    await search.press("Enter")
    await expect(page).toHaveURL(/\/products\?q=relay/)

    await seedMarketCart(page)
    await page.reload()
    await page.locator('button[title="Cart"]').tap()
    await expect(page).toHaveURL(/\/cart$/)
    await expect(page.getByText("E2E Smoke Product")).toBeVisible()
    await assertMobileViewport(page)

    await page.goBack()
    await expect(page).toHaveURL(/\/products\?q=relay/)
    await page.goForward()
    await expect(page).toHaveURL(/\/cart$/)

    await page.reload()
    await expect(page.getByText("E2E Smoke Product")).toBeVisible()

    const portrait = page.viewportSize()
    expect(portrait).not.toBeNull()
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${marketUrl}/products?q=relay`)
    await assertMobileViewport(page)
    await expectMobileSafeFont(
      page.getByRole("textbox", { name: "Search products" })
    )

    await page.setViewportSize({
      width: portrait!.height,
      height: portrait!.width,
    })
    await page.goto(`${marketUrl}/products?q=relay`)
    await assertMobileViewport(page)
    await expectMobileSafeFont(
      page.getByRole("textbox", { name: "Search products" })
    )
    await expectMobileTouchTarget(page.locator('button[title="Cart"]'))
  })

  test("market checkout keeps form semantics and draft values after refresh", async ({
    page,
  }) => {
    await page.goto(`${marketUrl}/products`)
    await seedMarketCart(page)
    await page.goto(`${marketUrl}/checkout`)

    await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()
    await assertMobileViewport(page)

    const firstName = page.locator("#ship-first-name")
    const street = page.locator("#ship-street")
    const phone = page.locator("#ship-phone")
    const email = page.locator("#ship-email")

    for (const control of [firstName, street, phone, email]) {
      await expectMobileSafeFont(control)
    }
    await expect(firstName).toHaveAttribute("autocomplete", "given-name")
    await expect(street).toHaveAttribute("autocomplete", "address-line1")
    await expect(phone).toHaveAttribute("inputmode", "tel")
    await expect(phone).toHaveAttribute("autocomplete", "tel")
    await expect(email).toHaveAttribute("type", "email")
    await expect(email).toHaveAttribute("autocomplete", "email")

    await firstName.tap()
    await firstName.fill("Mobile")
    await street.tap()
    await street.fill("1 Test Way")
    await phone.tap()
    await phone.fill("+1 555 010 0100")
    await email.tap()
    await email.fill("mobile@example.test")

    await page.reload()
    await expect(firstName).toHaveValue("Mobile")
    await expect(street).toHaveValue("1 Test Way")
    await expect(phone).toHaveValue("+1 555 010 0100")
    await expect(email).toHaveValue("mobile@example.test")
    await assertMobileViewport(page)
  })

  test.describe("signer handoff without retained connection artifacts", () => {
    test("market mobile signer exposes NIP-46 handoff and cancel recovery", async ({
      page,
    }) => {
      await page.routeWebSocket(/.*/, () => {})
      await page.addInitScript(() => {
        // Keep any failure artifact inert and reproducible: this known fixture
        // material never represents a user or reusable signer connection.
        Object.defineProperty(window.crypto, "getRandomValues", {
          configurable: true,
          value: (array: Uint8Array) => {
            array.fill(7)
            return array
          },
        })
      })
      await page.goto(`${marketUrl}/products`)
      await page
        .getByRole("button", { name: /^Connect$/ })
        .first()
        .tap()

      const dialog = page.getByRole("dialog")
      await expect(dialog).toBeVisible()
      await expect(
        dialog.getByRole("button", { name: /Connect Extension \(NIP-07\)/ })
      ).toHaveCount(0)
      const amberLink = dialog.getByRole("link", { name: "Amber" })
      const claveLink = dialog.getByRole("link", { name: "Clave" })
      await expect(amberLink).toHaveAttribute("href", /Amber/)
      await expect(claveLink).toHaveAttribute("href", /clave/)
      await expectMobileTouchTarget(amberLink)
      await expectMobileTouchTarget(claveLink)

      await dialog.getByRole("tab", { name: "Bunker URL" }).click()
      const bunker = dialog.getByRole("textbox", {
        name: "Remote signer bunker URL",
      })
      await expectMobileSafeFont(bunker)
      await bunker.tap()
      await expect(bunker).toBeFocused()

      await dialog.getByRole("tab", { name: "QR code" }).click()
      const closeButton = dialog.getByRole("button", { name: "Close" })
      await expectMobileTouchTarget(closeButton)

      await page.addStyleTag({
        content: `
        [aria-label="Nostr Connect connection QR code"],
        [aria-label="Nostr Connect connection URL"],
        a[href^="nostrconnect:"] {
          visibility: hidden !important;
        }
      `,
      })
      await dialog.getByRole("button", { name: "Create connection" }).tap()
      await expect(
        dialog.locator('[aria-label="Nostr Connect connection QR code"]')
      ).toHaveCount(1)

      await dialog.getByRole("tab", { name: "Connection URL" }).click()
      const connectionUrl = dialog.locator(
        '[aria-label="Nostr Connect connection URL"]'
      )
      await expect(connectionUrl).toHaveCount(1)
      expect(
        await connectionUrl.evaluate((element) =>
          /^nostrconnect:/.test((element as HTMLTextAreaElement).value)
        )
      ).toBe(true)
      expect(
        await connectionUrl.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize)
        )
      ).toBeGreaterThanOrEqual(16)
      await expect(dialog.locator('a[href^="nostrconnect:"]')).toHaveCount(1)

      const cancelPairing = dialog.getByRole("button", {
        name: "Cancel pairing",
      })
      await expect(cancelPairing).toBeVisible()
      await cancelPairing.tap({ force: true })
      await expect(dialog).not.toBeVisible()

      await page
        .getByRole("button", { name: /^Connect$/ })
        .first()
        .tap()
      await expect(
        dialog.getByRole("button", { name: "Create connection" })
      ).toBeVisible()
      await dialog.getByRole("button", { name: "Close" }).tap()
      await expect(dialog).not.toBeVisible()
    })
  })

  test("market wallet route keeps mobile-safe input and recoverable validation", async ({
    page,
  }) => {
    await installTestSigner(page, TEST_BUYER_PUBKEY)
    await page.goto(`${marketUrl}/wallet`)

    await expect(
      page.getByRole("heading", { name: "Wallet", exact: true })
    ).toBeVisible()
    await assertMobileViewport(page)

    const connectionString = page.getByPlaceholder("nostr+walletconnect://...")
    await expectMobileSafeFont(connectionString)
    await expect(connectionString).toHaveAttribute("type", "password")
    await expect(connectionString).toHaveAttribute("autocomplete", "off")

    await page.getByRole("button", { name: "Connect wallet" }).tap()
    await expect(
      page.getByText("Paste a nostr+walletconnect:// connection string.")
    ).toBeVisible()

    await page.reload()
    await expect(
      page.getByRole("heading", { name: "Wallet", exact: true })
    ).toBeVisible()
    await expect(connectionString).toBeVisible()
  })

  test("market reload safely recovers an expired tokenless pre-wallet payment", async ({
    page,
  }) => {
    const orderId = "mobile-pre-wallet-recovery"
    await installTestSigner(page, TEST_BUYER_PUBKEY)
    await page.goto(`${marketUrl}/orders`)
    await expect(
      page.getByRole("heading", { name: "Orders", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "No orders yet" })
    ).toBeVisible()
    await seedInterruptedPayment(page, {
      orderId,
      paymentClaimId: "pre-wallet-claim",
      storeMarker: false,
    })

    await page.goto(`${marketUrl}/orders?order=${orderId}`)
    await expect(
      page.getByRole("button", { name: "Continue payment" })
    ).toBeVisible()
    await expect(
      page.getByText(/before the invoice reached a wallet/i)
    ).toBeVisible()
    await assertMobileViewport(page)

    expect(await readRecoveredPayment(page, orderId)).toEqual({
      paymentStatus: "failed",
      proofDeliveryStatus: "not_started",
      paymentClaimId: undefined,
      marker: null,
    })
  })

  test("market reload blocks repayment after an unproven wallet handoff", async ({
    page,
  }) => {
    const orderId = "mobile-wallet-handoff-recovery"
    await installTestSigner(page, TEST_BUYER_PUBKEY)
    await page.goto(`${marketUrl}/orders`)
    await expect(
      page.getByRole("heading", { name: "Orders", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "No orders yet" })
    ).toBeVisible()
    await seedInterruptedPayment(page, {
      orderId,
      paymentClaimId: "wallet-handoff-claim",
      invoice: "lnbc1mobilefixture",
    })

    await page.goto(`${marketUrl}/orders?order=${orderId}`)
    await expect(page.getByText("Payment unclear").last()).toBeVisible()
    await expect(
      page.getByText(/check your wallet and merchant messages/i)
    ).toBeVisible()
    await expect(
      page.getByRole("button", {
        name: /^(?:Continue payment|Try payment again)$/,
      })
    ).toHaveCount(0)

    expect(await readRecoveredPayment(page, orderId)).toEqual({
      paymentStatus: "ambiguous",
      proofDeliveryStatus: "not_started",
      paymentClaimId: undefined,
      marker: null,
    })
  })

  test("market reload restores paid state and receipt retry without repaying", async ({
    page,
  }) => {
    const orderId = "mobile-paid-proof-recovery"
    await installTestSigner(page, TEST_BUYER_PUBKEY)
    await page.goto(`${marketUrl}/orders`)
    await expect(
      page.getByRole("heading", { name: "No orders yet" })
    ).toBeVisible()
    await seedInterruptedPayment(page, {
      orderId,
      paymentClaimId: "paid-proof-claim",
      invoice: "lnbc1paidmobilefixture",
      preimage: "fixture-payment-preimage",
    })

    await page.goto(`${marketUrl}/orders?order=${orderId}`)
    await expect(
      page.getByRole("button", { name: "Resend receipt" })
    ).toBeVisible()
    await expect(
      page.getByRole("button", {
        name: /^(?:Continue payment|Try payment again)$/,
      })
    ).toHaveCount(0)

    expect(await readRecoveredPayment(page, orderId)).toEqual({
      paymentStatus: "paid",
      proofDeliveryStatus: "retry_needed",
      paymentClaimId: undefined,
      marker: null,
    })
  })

  test("merchant current auth metadata restores through protected navigation and refresh", async ({
    page,
  }) => {
    await installTestSigner(page, TEST_BUYER_PUBKEY, { rememberAuth: false })
    await page.goto(`${merchantUrl}/`)
    await expect(
      page.getByRole("heading", { name: "Connect a signer" })
    ).toBeVisible()

    await page.evaluate((pubkey) => {
      localStorage.setItem(
        "conduit:auth",
        JSON.stringify({ version: 1, type: "nip07", userPubkey: pubkey })
      )
    }, TEST_BUYER_PUBKEY)
    await page.reload()

    await page.goto(`${merchantUrl}/products`)
    await expect(
      page.getByRole("heading", { name: "Products", exact: true })
    ).toBeVisible()
    await assertMobileViewport(page)

    await page.goto(`${merchantUrl}/shipping`)
    await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()
    await page.goBack()
    await expect(
      page.getByRole("heading", { name: "Products", exact: true })
    ).toBeVisible()
    await page.goForward()
    await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()
  })

  test("merchant mobile signer gate remains touch-safe without NIP-07", async ({
    page,
  }) => {
    await page.goto(`${merchantUrl}/`)
    await assertMobileViewport(page)
    await expect(
      page.getByRole("button", { name: /Connect Extension \(NIP-07\)/ })
    ).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Amber" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Clave" })).toBeVisible()

    await page.getByRole("tab", { name: "Bunker URL" }).click()
    const bunker = page.getByRole("textbox", {
      name: "Remote signer bunker URL",
    })
    await expectMobileSafeFont(bunker)
    await bunker.tap()
    await expect(bunker).toBeFocused()
  })
})
