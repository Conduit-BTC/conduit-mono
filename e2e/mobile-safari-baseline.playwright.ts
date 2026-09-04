import { expect, test, type Locator, type Page } from "@playwright/test"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"

import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  installTestSigner,
  seedTestRelayIdentity,
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

async function expectMobileTouchTarget(
  control: Locator,
  masked = false
): Promise<void> {
  if (masked) await expect(control).toHaveCount(1)
  else await expect(control).toBeVisible()
  const box = masked
    ? await control.evaluate((element) => {
        const { width, height } = element.getBoundingClientRect()
        return { width, height }
      })
    : await control.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(44)
  expect(box?.height).toBeGreaterThanOrEqual(44)
}

async function installInertMobilePairing(page: Page): Promise<void> {
  await page.routeWebSocket(/.*/, () => {})
  await page.addInitScript(() => {
    // Mask before the sign-in surface can automatically prepare a connection.
    // Hidden controls retain their layout and stay out of failure snapshots.
    const mask = document.createElement("style")
    mask.textContent = `
      [aria-label="Nostr Connect connection QR code"],
      [aria-label="Nostr Connect connection URL"],
      a[href^="nostrconnect:"],
      a[href^="intent://"],
      a[href^="https://clave.casa/connect/"] {
        visibility: hidden !important;
      }
    `
    const installMask = () => {
      if (!document.documentElement) return false
      document.documentElement.append(mask)
      return true
    }
    if (!installMask()) {
      const observer = new MutationObserver(() => {
        if (installMask()) observer.disconnect()
      })
      observer.observe(document, { childList: true })
    }

    // Never launch external apps or retain generated connection values in this
    // browser-only test. Real app approval and return require device QA.
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        if (
          target.closest(
            'a[href^="intent://"], a[href^="nostrconnect:"], a[href^="https://clave.casa/connect/"]'
          )
        ) {
          event.preventDefault()
        }
      },
      true
    )
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    })
    // These fixtures never represent a user or reusable signer connection;
    // all relay traffic is intercepted before opening the sign-in surface.
    Object.defineProperty(window.crypto, "getRandomValues", {
      configurable: true,
      value: (array: Uint8Array) => {
        array.fill(7)
        return array
      },
    })
  })
}

async function expectMobileSignerChoices(
  page: Page,
  surface: Locator
): Promise<"Clave" | "Amber"> {
  const ios = await page.evaluate(() =>
    /iphone|ipad|ipod/i.test(navigator.userAgent)
  )
  await expect(surface.getByRole("tab")).toHaveCount(0)
  await expect(surface.locator('a[href*="github.com"]')).toHaveCount(0)
  await expect(surface.locator('a[href^="nostrconnect:"]')).toHaveCount(0)
  await expect(
    surface.getByRole("button", { name: "Other ways to connect", exact: true })
  ).toBeVisible()

  if (ios) {
    const clave = surface.getByRole("link", {
      name: "Connect with Clave",
      exact: true,
      includeHidden: true,
    })
    await expectMobileTouchTarget(clave, true)
    expect(
      await clave.evaluate((element) => {
        const link = element as HTMLAnchorElement
        const url = new URL(link.href)
        return (
          url.origin === "https://clave.casa" &&
          url.pathname === "/connect/" &&
          url.searchParams.get("uri")?.startsWith("nostrconnect://") &&
          link.target === "_self"
        )
      })
    ).toBe(true)
    await expect(surface.getByText(/Primal|Amber/)).toHaveCount(0)
    await expect(surface.locator('a[href^="intent://"]')).toHaveCount(0)
    await expect(
      surface.locator('a[href^="https://apps.apple.com/"]')
    ).toBeVisible()
    return "Clave"
  }

  const choices = [
    ["Use Amber", "com.greenart7c3.nostrsigner"],
    ["Use Primal", "net.primal.android"],
  ] as const
  for (const [name, packageName] of choices) {
    const control = surface.getByRole("link", {
      name,
      exact: true,
      includeHidden: true,
    })
    await expectMobileTouchTarget(control, true)
    expect(
      await control.evaluate((element, expectedPackage) => {
        const href = (element as HTMLAnchorElement).href
        return (
          href.startsWith("intent://") &&
          href.includes(";scheme=nostrconnect;") &&
          href.includes(`;package=${expectedPackage};`)
        )
      }, packageName)
    ).toBe(true)
  }
  const amberBox = await surface
    .getByRole("link", { name: "Use Amber", exact: true, includeHidden: true })
    .evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    }))
  const primalBox = await surface
    .getByRole("link", { name: "Use Primal", exact: true, includeHidden: true })
    .evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    }))
  expect(amberBox?.width).toBe(primalBox?.width)
  expect(amberBox?.height).toBe(primalBox?.height)
  await expect(
    surface.locator('a[href^="https://clave.casa/connect/"]')
  ).toHaveCount(0)
  await expect(surface.locator('a[href^="https://f-droid.org/"]')).toBeVisible()
  await expect(
    surface.locator('a[href^="https://play.google.com/store/apps/details"]')
  ).toBeVisible()
  return "Amber"
}

async function seedInterruptedPayment(
  page: Page,
  input: {
    orderId: string
    buyerPubkey?: string
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
          `conduit:order-payment-claim:${orderId}`,
          paymentClaimId
        )
      }
    },
    {
      ...input,
      buyerPubkey: input.buyerPubkey ?? TEST_BUYER_PUBKEY,
      merchantPubkey: TEST_MERCHANT_PUBKEY,
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
      marker: sessionStorage.getItem(
        `conduit:order-payment-claim:${paymentOrderId}`
      ),
    }
  }, orderId)
}

test.describe("CND-162 mobile browser baseline", () => {
  test("market viewport, touch navigation, and cart survive history and refresh @market", async ({
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
    const cartProduct = page
      .getByRole("main")
      .getByRole("link", { name: "E2E Smoke Product" })
    await expect(cartProduct).toBeVisible()
    await assertMobileViewport(page)

    await page.goBack()
    await expect(page).toHaveURL(/\/products\?q=relay/)
    await page.goForward()
    await expect(page).toHaveURL(/\/cart$/)

    await page.reload()
    await expect(cartProduct).toBeVisible()

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

  test("network status pills stay compact in stacked mobile headers @market", async ({
    page,
  }) => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    await seedTestRelayIdentity(secretKey)
    await installTestSigner(page, pubkey, { secretKey })

    await page.goto(`${marketUrl}/products`)
    await expect(
      page.getByRole("button", { name: "Open account menu" })
    ).toBeVisible({ timeout: 15_000 })

    await page.goto(`${marketUrl}/preferences`)
    await expect(
      page.getByRole("heading", { name: "Preferences" })
    ).toBeVisible()
    await assertMobileViewport(page)

    const preferencesHeader = page.locator("header").filter({
      has: page.getByRole("heading", { name: "Preferences" }),
    })
    const preferencesStatusPill = preferencesHeader.getByRole("status")
    await expect(preferencesStatusPill).toHaveText(
      /Encrypted on relays|Relay ready/,
      { timeout: 20_000 }
    )
    const [headerBox, preferencesPillBox, iconBox] = await Promise.all([
      preferencesHeader.boundingBox(),
      preferencesStatusPill.boundingBox(),
      preferencesStatusPill.locator("svg").boundingBox(),
    ])
    expect(headerBox).not.toBeNull()
    expect(preferencesPillBox).not.toBeNull()
    expect(iconBox).not.toBeNull()
    expect(preferencesPillBox!.width).toBeLessThan(headerBox!.width * 0.75)
    expect(preferencesPillBox!.height).toBeLessThanOrEqual(32)
    expect(iconBox!.width).toBeGreaterThanOrEqual(11)
    expect(iconBox!.width).toBeLessThanOrEqual(13)
    expect(iconBox!.height).toBeGreaterThanOrEqual(11)
    expect(iconBox!.height).toBeLessThanOrEqual(13)

    await page.goto(`${marketUrl}/network`)
    await expect(
      page.getByRole("heading", { name: "Network Settings" })
    ).toBeVisible()

    const mediaServers = page.getByRole("region", { name: "Media servers" })
    const mediaStatusPill = mediaServers.getByText("No list observed", {
      exact: true,
    })
    await expect(mediaStatusPill).toBeVisible({ timeout: 20_000 })

    const [sectionBox, mediaPillBox] = await Promise.all([
      mediaServers.boundingBox(),
      mediaStatusPill.boundingBox(),
    ])
    expect(sectionBox).not.toBeNull()
    expect(mediaPillBox).not.toBeNull()
    expect(mediaPillBox!.width).toBeLessThan(sectionBox!.width * 0.75)
    expect(mediaPillBox!.height).toBeLessThanOrEqual(32)
  })

  test("market checkout keeps form semantics and draft values after refresh @market", async ({
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
    test("market mobile signer starts with platform apps and preserves manual recovery @market", async ({
      page,
    }) => {
      await installInertMobilePairing(page)
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
      const primaryApp = await expectMobileSignerChoices(page, dialog)
      await assertMobileViewport(page)
      const firstClick = dialog.getByRole("link", {
        name: primaryApp === "Clave" ? "Connect with Clave" : "Use Amber",
        exact: true,
        includeHidden: true,
      })
      await firstClick.dispatchEvent("click")
      await expect(
        dialog.getByRole("link", {
          name: `Open ${primaryApp} again`,
          exact: true,
          includeHidden: true,
        })
      ).toHaveCount(1)
      await dialog
        .getByRole("button", { name: "Copy connection link", exact: true })
        .tap()
      await expect(
        dialog.getByRole("button", {
          name: "Connection link copied",
          exact: true,
        })
      ).toBeVisible()

      if (primaryApp === "Amber") {
        await expect(
          dialog.getByRole("link", {
            name: "Use Primal",
            exact: true,
            includeHidden: true,
          })
        ).toHaveCount(0)
        await dialog
          .getByRole("button", { name: "Choose another app", exact: true })
          .tap()
        await expect(dialog.locator('a[href^="intent://"]')).toHaveCount(0)
        await expect(
          dialog.getByRole("button", { name: "Use Primal", exact: true })
        ).toBeDisabled()
        await dialog
          .getByRole("button", { name: "Start new connection", exact: true })
          .tap()
        await dialog
          .getByRole("link", {
            name: "Use Primal",
            exact: true,
            includeHidden: true,
          })
          .dispatchEvent("click")
        await expect(
          dialog.getByRole("link", {
            name: "Open Primal again",
            exact: true,
            includeHidden: true,
          })
        ).toHaveCount(1)
        await expect(
          dialog.getByRole("link", {
            name: "Use Amber",
            exact: true,
            includeHidden: true,
          })
        ).toHaveCount(0)
      }

      await dialog
        .getByRole("button", { name: "Other ways to connect", exact: true })
        .tap()
      await expect(dialog.getByRole("tab")).toHaveCount(3)
      await dialog.getByRole("tab", { name: "Bunker URL" }).tap()
      const bunker = dialog.getByRole("textbox", {
        name: "Remote signer bunker URL",
      })
      await expectMobileSafeFont(bunker)
      await bunker.tap()
      await expect(bunker).toBeFocused()
      await expect(dialog.locator('a[href^="intent://"]')).toHaveCount(0)
      await expect(
        dialog.locator('a[href^="https://clave.casa/connect/"]')
      ).toHaveCount(0)
      await expect(dialog).toBeVisible()

      await dialog.getByRole("tab", { name: "QR code" }).tap()
      const closeButton = dialog.getByRole("button", { name: "Close" })
      await expectMobileTouchTarget(closeButton)
      await dialog
        .getByRole("button", { name: "Start new connection", exact: true })
        .first()
        .tap()
      await expect(
        dialog.locator('[aria-label="Nostr Connect connection QR code"]')
      ).toHaveCount(1)

      await dialog.getByRole("tab", { name: "Connection URL" }).tap()
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
      await expect(dialog.locator('a[href^="nostrconnect:"]')).toHaveCount(0)

      const cancelPairing = dialog.getByRole("button", {
        name: "Cancel pairing",
      })
      await expect(cancelPairing).toBeVisible()
      await cancelPairing.tap()
      await expect(dialog).toBeVisible()
      await expect(connectionUrl).toHaveCount(0)
      await expect(
        dialog
          .getByRole("button", { name: "Start new connection", exact: true })
          .first()
      ).toBeVisible()
      await expect(
        dialog.getByRole("button", {
          name: primaryApp === "Clave" ? "Connect with Clave" : "Use Amber",
          exact: true,
        })
      ).toBeDisabled()
      await closeButton.tap()
      await expect(dialog).not.toBeVisible()

      await page
        .getByRole("button", { name: /^Connect$/ })
        .first()
        .tap()
      await expectMobileSignerChoices(page, dialog)
      await dialog.getByRole("button", { name: "Close" }).tap()
      await expect(dialog).not.toBeVisible()
    })
  })

  test("market wallet route keeps mobile-safe input and recoverable validation @market", async ({
    page,
  }) => {
    await installTestSigner(page, TEST_BUYER_PUBKEY)
    await page.goto(`${marketUrl}/wallet`)

    await expect(
      page.getByRole("heading", { name: "Wallets", exact: true })
    ).toBeVisible()
    await assertMobileViewport(page)

    await page.getByRole("button", { name: "Connect wallet" }).tap()
    const dialog = page.getByRole("dialog", { name: "Connect wallet" })
    const connectionString = dialog.getByPlaceholder(
      "nostr+walletconnect://..."
    )
    await expectMobileSafeFont(connectionString)
    await expect(connectionString).toHaveAttribute("type", "password")
    await expect(connectionString).toHaveAttribute("autocomplete", "off")

    await connectionString.fill("not-a-wallet-connection")
    await dialog.getByRole("button", { name: "Connect", exact: true }).tap()
    await expect(dialog.getByRole("alert")).toBeVisible()

    await page.reload()
    await expect(
      page.getByRole("heading", { name: "Wallets", exact: true })
    ).toBeVisible()
    await page.getByRole("button", { name: "Connect wallet" }).tap()
    await expect(connectionString).toBeVisible()
  })

  test("market reload safely recovers an expired tokenless pre-wallet payment @market", async ({
    page,
  }) => {
    const orderId = "mobile-pre-wallet-recovery"
    const secretKey = generateSecretKey()
    const buyerPubkey = getPublicKey(secretKey)
    await seedTestRelayIdentity(secretKey)
    await installTestSigner(page, buyerPubkey, { secretKey })
    await page.goto(`${marketUrl}/orders`)
    await expect(
      page.getByRole("heading", { name: "Orders", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "No orders yet" })
    ).toBeVisible()
    await seedInterruptedPayment(page, {
      orderId,
      buyerPubkey,
      paymentClaimId: "pre-wallet-claim",
      storeMarker: false,
    })

    await page.goto(`${marketUrl}/orders?order=${orderId}`)
    await expect(
      page.getByRole("button", { name: "Continue payment" })
    ).toBeVisible()
    await expect(
      page.getByText(/choose the exact wallet or manual payment path/i)
    ).toBeVisible()
    await assertMobileViewport(page)

    expect(await readRecoveredPayment(page, orderId)).toEqual({
      paymentStatus: "failed",
      proofDeliveryStatus: "not_started",
      paymentClaimId: undefined,
      marker: null,
    })
  })

  test("market reload blocks repayment after an unproven wallet handoff @market", async ({
    page,
  }) => {
    const orderId = "mobile-wallet-handoff-recovery"
    const secretKey = generateSecretKey()
    const buyerPubkey = getPublicKey(secretKey)
    await seedTestRelayIdentity(secretKey)
    await installTestSigner(page, buyerPubkey, { secretKey })
    await page.goto(`${marketUrl}/orders`)
    await expect(
      page.getByRole("heading", { name: "Orders", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "No orders yet" })
    ).toBeVisible()
    await seedInterruptedPayment(page, {
      orderId,
      buyerPubkey,
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

  test("market reload restores paid state and receipt retry without repaying @market", async ({
    page,
  }) => {
    const orderId = "mobile-paid-proof-recovery"
    const secretKey = generateSecretKey()
    const buyerPubkey = getPublicKey(secretKey)
    await seedTestRelayIdentity(secretKey)
    await installTestSigner(page, buyerPubkey, { secretKey })
    await page.goto(`${marketUrl}/orders`)
    await expect(
      page.getByRole("heading", { name: "No orders yet" })
    ).toBeVisible()
    await seedInterruptedPayment(page, {
      orderId,
      buyerPubkey,
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

  test("merchant current auth metadata restores through protected navigation and refresh @merchant", async ({
    page,
  }) => {
    await installTestSigner(page, TEST_BUYER_PUBKEY, { rememberAuth: false })
    await page.goto(`${merchantUrl}/`)
    await expect(
      page.getByRole("heading", { name: "Sign in to Conduit" })
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

  test("merchant mobile signer gate remains touch-safe without NIP-07 @merchant", async ({
    page,
  }) => {
    await installInertMobilePairing(page)
    await page.goto(`${merchantUrl}/`)
    await assertMobileViewport(page)
    await expect(
      page.getByRole("button", { name: /Connect Extension \(NIP-07\)/ })
    ).toHaveCount(0)
    const gate = page.getByRole("region", { name: "Sign in to Conduit" })
    await expectMobileSignerChoices(page, gate)

    await gate
      .getByRole("button", { name: "Other ways to connect", exact: true })
      .tap()
    await gate.getByRole("tab", { name: "Bunker URL" }).tap()
    const bunker = page.getByRole("textbox", {
      name: "Remote signer bunker URL",
    })
    await expectMobileSafeFont(bunker)
    await bunker.tap()
    await expect(bunker).toBeFocused()
    await expect(gate.locator('a[href^="intent://"]')).toHaveCount(0)
    await expect(
      gate.locator('a[href^="https://clave.casa/connect/"]')
    ).toHaveCount(0)
    await expect(
      page.getByRole("heading", { name: "Sign in to Conduit" })
    ).toBeVisible()
  })
})
