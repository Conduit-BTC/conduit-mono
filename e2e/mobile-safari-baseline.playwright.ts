import { expect, test, type Locator, type Page } from "@playwright/test"
import {
  createECDH,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure"

import {
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  encodeEventMarketNaddr,
} from "@conduit/core/protocol/event-market"
import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  TEST_RELAY_URL,
  installTestSigner,
  publishTestRelayEvents,
  seedTestRelayIdentity,
  seedMarketCart,
} from "./helpers/auth"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  bytesToBolt11Words,
  encodeBolt11FixtureField,
  makeBolt11Fixture,
} from "../tests/support/bolt11-fixture"

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

async function seedPaymentLifecycle(
  page: Page,
  input: {
    orderId: string
    buyerPubkey?: string
    paymentClaimId: string
    invoice?: string
    preimage?: string
    storeMarker?: boolean
    failedPayment?: {
      merchantPubkey: string
      address: string
      checkoutMode?: "public_zap_as_shopper" | "external_wallet"
    }
    preparationError?: string
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
      failedPayment,
      preparationError,
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
          ...(preparationError
            ? {}
            : {
                paymentClaimId,
                paymentClaimedAt: now - 20_000,
                paymentClaimLeaseExpiresAt: now - 1,
              }),
          buyerPubkey,
          buyerIdentityKind: "signed_in",
          merchantPubkey,
          merchantLightningAddress: preparationError
            ? "merchant@merchant-fixture.dev"
            : "merchant@example.test",
          checkoutMode: preparationError
            ? "public_zap_as_shopper"
            : "private_checkout",
          ...(preparationError
            ? { paymentTarget: { type: "manual" }, lastError: preparationError }
            : {}),
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
          invoiceStatus: preparationError
            ? "failed"
            : invoice
              ? "received"
              : "requesting",
          paymentStatus: preparationError
            ? "failed"
            : preimage
              ? "paid"
              : invoice
                ? "paying"
                : "not_started",
          proofDeliveryStatus: preimage ? "pending" : "not_started",
          zapReceiptStatus: "not_applicable",
          phase: "in_progress",
          ...(invoice ? { invoice } : {}),
          ...(preimage
            ? { preimage, paymentHash: "fixture-payment-hash" }
            : {}),
          createdAt: now,
          updatedAt: now,
          ...(failedPayment
            ? {
                paymentClaimId: undefined,
                paymentClaimedAt: undefined,
                paymentClaimLeaseExpiresAt: undefined,
                merchantPubkey: failedPayment.merchantPubkey,
                merchantLightningAddress: failedPayment.address,
                checkoutMode:
                  failedPayment.checkoutMode ?? "public_zap_as_shopper",
                paymentTarget: { type: "manual" },
                invoiceStatus: "failed",
                paymentStatus: "failed",
              }
            : {}),
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      database.close()
      if (storeMarker !== false && !failedPayment && !preparationError) {
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

function signedManualInvoice(description: string): string {
  const secret = generateSecretKey()
  const curve = createECDH("secp256k1")
  curve.setPrivateKey(secret)
  const publicKey = curve.getPublicKey(undefined, "uncompressed")
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "secp256k1",
      d: Buffer.from(secret).toString("base64url"),
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33).toString("base64url"),
    },
  })
  const createdAt = Math.floor(Date.now() / 1000)
  const hrp = "lnbc10n"
  const fields = [
    bolt11PaymentHashField(),
    bolt11DescriptionHashField(description),
    { tag: "s", words: bytesToBolt11Words(new Uint8Array(32).fill(8)) },
    {
      tag: "n",
      words: bytesToBolt11Words(curve.getPublicKey(undefined, "compressed")),
    },
  ]
  const words = [
    ...Array.from({ length: 7 }, (_, index) =>
      Number((BigInt(createdAt) >> BigInt((6 - index) * 5)) & 31n)
    ),
    ...fields.flatMap(encodeBolt11FixtureField),
  ]
  const data: number[] = []
  let value = 0
  let bits = 0
  for (const word of words) {
    value = (value << 5) | word
    bits += 5
    if (bits >= 8) {
      bits -= 8
      data.push((value >> bits) & 255)
    }
  }
  if (bits) data.push((value << (8 - bits)) & 255)
  const payload = Buffer.concat([Buffer.from(hrp), Buffer.from(data)])
  const signature = sign("sha256", payload, { key, dsaEncoding: "ieee-p1363" })
  const order = BigInt(
    "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
  )
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`)
  if (s > order / 2n) {
    Buffer.from((order - s).toString(16).padStart(64, "0"), "hex").copy(
      signature,
      32
    )
  }
  expect(
    verify(
      "sha256",
      payload,
      { key: createPublicKey(key), dsaEncoding: "ieee-p1363" },
      signature
    )
  ).toBe(true)
  // The explicit n field supplies the signing key; recovery is unnecessary.
  return makeBolt11Fixture({
    hrp,
    createdAt,
    fields,
    signatureWords: bytesToBolt11Words(
      Buffer.concat([signature, Buffer.from([0])])
    ),
  })
}

const savedPaymentAddress = "merchant@old-payment-fixture.dev"
const updatedPaymentAddress = "merchant@new-payment-fixture.dev"

async function prepareUpdatedPaymentAddress(
  page: Page,
  orderId: string,
  wrongHash = false,
  initialAddress = updatedPaymentAddress,
  checkoutMode:
    "public_zap_as_shopper" | "external_wallet" = "public_zap_as_shopper"
) {
  const buyerSecret = generateSecretKey()
  const buyerPubkey = getPublicKey(buyerSecret)
  const merchantSecret = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecret)
  let profileTimestamp = Math.floor(Date.now() / 1000)
  const publishAddress = async (address?: string) => {
    await publishTestRelayEvents([
      finalizeEvent(
        {
          kind: 0,
          created_at: profileTimestamp++,
          tags: [],
          content: JSON.stringify({
            name: "Recovery merchant",
            ...(address ? { lud16: address } : {}),
          }),
        },
        merchantSecret
      ),
    ])
  }
  const providerRequests: string[] = []
  const metadata = JSON.stringify([
    ["text/plain", "Synthetic recovery merchant"],
  ])
  await page.route("https://*-payment-fixture.dev/**", async (route) => {
    const url = new URL(route.request().url())
    providerRequests.push(`${url.hostname}${url.pathname}`)
    if (url.pathname === "/callback") {
      expect(url.searchParams.get("amount")).toBe("1000")
      let description = metadata
      if (checkoutMode === "external_wallet") {
        expect(url.searchParams.has("nostr")).toBe(false)
        if (url.hostname === "old-payment-fixture.dev") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              status: "ERROR",
              reason: "Synthetic old provider unavailable",
            }),
          })
          return
        }
      } else {
        description = url.searchParams.get("nostr") ?? ""
        const event = JSON.parse(description)
        expect(verifyEvent(event)).toBe(true)
        expect(event.kind).toBe(9734)
        expect(event.pubkey).toBe(buyerPubkey)
        expect(event.tags).toContainEqual(["p", merchantPubkey])
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          pr: signedManualInvoice(
            wrongHash || url.hostname === "old-payment-fixture.dev"
              ? "unrelated synthetic request"
              : description
          ),
          routes: [],
        }),
      })
      return
    }
    expect(url.pathname).toBe("/.well-known/lnurlp/merchant")
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tag: "payRequest",
        callback: `${url.origin}/callback`,
        minSendable: 1000,
        maxSendable: 100000,
        allowsNostr: true,
        nostrPubkey: merchantPubkey,
        metadata,
      }),
    })
  })
  await seedTestRelayIdentity(buyerSecret)
  await publishTestRelayEvents([
    finalizeEvent(
      {
        kind: 10002,
        created_at: profileTimestamp,
        tags: [["r", TEST_RELAY_URL]],
        content: "",
      },
      merchantSecret
    ),
  ])
  await publishAddress(initialAddress)
  await installTestSigner(page, buyerPubkey, { secretKey: buyerSecret })
  await page.goto(`${marketUrl}/orders`)
  await expect(
    page.getByRole("heading", { name: "No orders yet" })
  ).toBeVisible()
  await seedPaymentLifecycle(page, {
    orderId,
    buyerPubkey,
    paymentClaimId: "unused-failed-payment-claim",
    failedPayment: {
      merchantPubkey,
      address: savedPaymentAddress,
      checkoutMode,
    },
  })
  await page.goto(`${marketUrl}/orders?order=${orderId}`)
  await expect(
    page.getByRole("button", { name: "Try payment again" })
  ).toBeVisible()
  return { providerRequests, publishAddress }
}

async function readPaymentAddressRecovery(page: Page, orderId: string) {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const records = await new Promise<Array<Record<string, unknown>>>(
      (resolve, reject) => {
        const request = database
          .transaction("orderLifecycles", "readonly")
          .objectStore("orderLifecycles")
          .getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }
    )
    database.close()
    const row = records.find((record) => record.orderId === id)
    return {
      count: records.length,
      orderId: row?.orderId,
      address: row?.merchantLightningAddress,
      checkoutMode: row?.checkoutMode,
      paymentTarget: row?.paymentTarget,
      paymentStatus: row?.paymentStatus,
      invoiceStatus: row?.invoiceStatus,
      hasInvoice: !!row?.invoice,
      lastError: row?.lastError,
    }
  }, orderId)
}

test.describe("CND-162 mobile browser baseline", () => {
  test("event catalog stays mounted during an unresolved profile refresh @market", async ({
    page,
  }) => {
    const organizerSecret = generateSecretKey()
    const organizerPubkey = getPublicKey(organizerSecret)
    const shopperSecret = generateSecretKey()
    const shopperPubkey = getPublicKey(shopperSecret)
    const createdAt = Math.floor(Date.now() / 1_000)
    const calendarDTag = "mobile-profile-refresh-calendar"
    const calendarDraft = buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: calendarDTag,
      title: "Stable mobile event catalog",
      start: createdAt + 60,
      end: createdAt + 3_600,
      locations: ["Synthetic venue"],
    })
    const calendar = finalizeEvent(
      { ...calendarDraft, created_at: createdAt },
      organizerSecret
    )
    const calendarCoordinate = `${calendar.kind}:${organizerPubkey}:${calendarDTag}`
    const collectionDTag = "mobile-profile-refresh-collection"
    const collectionDraft = buildEventMarketCollectionDraft({
      dTag: collectionDTag,
      title: "Stable mobile event catalog",
      eventCoordinate: calendarCoordinate,
    })
    const collection = finalizeEvent(
      { ...collectionDraft, created_at: createdAt },
      organizerSecret
    )
    const collectionRef = encodeEventMarketNaddr(
      `${collection.kind}:${organizerPubkey}:${collectionDTag}`,
      [TEST_RELAY_URL]
    )

    await publishTestRelayEvents([calendar, collection])
    await seedTestRelayIdentity(shopperSecret)
    await installTestSigner(page, shopperPubkey, { secretKey: shopperSecret })

    let holdShopperProfileReads = false
    let backgroundProfileReadObserved = false
    const heldProfileReads: Array<() => void> = []
    await page.routeWebSocket(TEST_RELAY_URL, (socket) => {
      const server = socket.connectToServer()
      socket.onMessage((message) => {
        if (typeof message !== "string") {
          server.send(message)
          return
        }

        let frame: unknown
        try {
          frame = JSON.parse(message)
        } catch {
          server.send(message)
          return
        }
        const filters =
          Array.isArray(frame) && frame[0] === "REQ" ? frame.slice(2) : []
        const readsShopperProfile = filters.some((filter) => {
          if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
            return false
          }
          const candidate = filter as {
            authors?: unknown
            kinds?: unknown
          }
          return (
            Array.isArray(candidate.kinds) &&
            candidate.kinds.includes(0) &&
            Array.isArray(candidate.authors) &&
            candidate.authors.includes(shopperPubkey)
          )
        })
        if (holdShopperProfileReads && readsShopperProfile) {
          backgroundProfileReadObserved = true
          heldProfileReads.push(() => server.send(message))
          return
        }
        server.send(message)
      })
    })

    await page.goto(`${marketUrl}/events/${collectionRef}`)
    const heading = page.getByRole("heading", {
      name: "Stable mobile event catalog",
      exact: true,
    })
    await expect(heading).toBeVisible({ timeout: 20_000 })
    await assertMobileViewport(page)

    holdShopperProfileReads = true
    try {
      await expect
        .poll(() => backgroundProfileReadObserved, { timeout: 7_000 })
        .toBe(true)
      const catalogStayedMounted = await page.evaluate(async (title) => {
        const deadline = performance.now() + 500
        while (performance.now() < deadline) {
          if (document.querySelector("h1")?.textContent?.trim() !== title) {
            return false
          }
          await new Promise(requestAnimationFrame)
        }
        return true
      }, "Stable mobile event catalog")
      expect(catalogStayedMounted).toBe(true)
      await expect(page.locator("main .animate-pulse")).toHaveCount(0)
    } finally {
      holdShopperProfileReads = false
      for (const release of heldProfileReads.splice(0)) release()
    }
  })

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

  test("network status and disclosure controls stay compact in stacked mobile headers @market", async ({
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
    await expect(page.getByRole("heading", { name: "Network" })).toBeVisible()

    const relaySettings = page.getByRole("region", { name: "Relays" })
    const publishedPreferences = relaySettings
      .locator("summary")
      .filter({ hasText: "Published preferences" })
    await expect(publishedPreferences).toBeVisible({ timeout: 20_000 })
    await expect(publishedPreferences).toHaveCSS("min-height", "44px")
    const disclosureIcon = publishedPreferences.locator("svg")
    await expect(disclosureIcon).toBeVisible()
    await expect(disclosureIcon).toHaveCSS("width", "16px")
    await expect(disclosureIcon).toHaveCSS("height", "16px")
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
      await dialog.getByRole("tab", { name: "Paste bunker", exact: true }).tap()
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

      await dialog.getByRole("tab", { name: "Scan QR", exact: true }).tap()
      const closeButton = dialog.getByRole("button", { name: "Close" })
      await expectMobileTouchTarget(closeButton)
      await dialog
        .getByRole("button", { name: "Start new connection", exact: true })
        .first()
        .tap()
      await expect(
        dialog.locator('[aria-label="Nostr Connect connection QR code"]')
      ).toHaveCount(1)

      await dialog.getByRole("tab", { name: "Copy link", exact: true }).tap()
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

  test("market reviews an updated payment address before retrying the same order @market", async ({
    page,
  }) => {
    const orderId = "mobile-updated-payment-address"
    const { providerRequests, publishAddress } =
      await prepareUpdatedPaymentAddress(
        page,
        orderId,
        false,
        savedPaymentAddress
      )
    const dialog = page.getByRole("alertdialog", {
      name: "Merchant updated their payment address",
    })
    await page.getByRole("button", { name: "Try payment again" }).tap()
    await expect
      .poll(() => readPaymentAddressRecovery(page, orderId))
      .toMatchObject({
        address: savedPaymentAddress,
        paymentStatus: "failed",
        invoiceStatus: "failed",
        hasInvoice: false,
        lastError:
          "The zap invoice is not bound to the signed NIP-57 request sent to the callback.",
      })
    expect(providerRequests).toEqual([
      "old-payment-fixture.dev/.well-known/lnurlp/merchant",
      "old-payment-fixture.dev/callback",
    ])
    await publishAddress(updatedPaymentAddress)
    await page.getByRole("button", { name: "Try payment again" }).tap()
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText(savedPaymentAddress, { exact: true })
    ).toBeVisible()
    await expect(
      dialog.getByText(updatedPaymentAddress, { exact: true })
    ).toBeVisible()
    expect(providerRequests).toHaveLength(2)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).tap()
    await expect(dialog).not.toBeVisible()
    expect(await readPaymentAddressRecovery(page, orderId)).toMatchObject({
      count: 1,
      orderId,
      address: savedPaymentAddress,
      paymentStatus: "failed",
      hasInvoice: false,
    })
    expect(providerRequests).toHaveLength(2)

    await page.getByRole("button", { name: "Try payment again" }).tap()
    await expect(dialog).toBeVisible()
    await dialog
      .getByRole("button", { name: "Use updated address and retry" })
      .tap()
    await expect(
      page.getByRole("button", { name: "Copy invoice", exact: true })
    ).toBeVisible()
    expect(await readPaymentAddressRecovery(page, orderId)).toMatchObject({
      count: 1,
      orderId,
      address: updatedPaymentAddress,
      paymentStatus: "manual_required",
      invoiceStatus: "manual_required",
      hasInvoice: true,
    })
    expect(providerRequests).toEqual([
      "old-payment-fixture.dev/.well-known/lnurlp/merchant",
      "old-payment-fixture.dev/callback",
      "new-payment-fixture.dev/.well-known/lnurlp/merchant",
      "new-payment-fixture.dev/callback",
    ])
    await assertMobileViewport(page)
    await page.reload()
    await expect(
      page.getByRole("button", { name: "Copy invoice", exact: true })
    ).toBeVisible()
    expect(await readPaymentAddressRecovery(page, orderId)).toMatchObject({
      count: 1,
      orderId,
      address: updatedPaymentAddress,
      paymentStatus: "manual_required",
      hasInvoice: true,
    })
    expect(providerRequests).toHaveLength(4)
  })

  test("market recovers a stored private manual order with an updated payment address @market", async ({
    page,
  }) => {
    const orderId = "mobile-private-updated-payment-address"
    const { providerRequests, publishAddress } =
      await prepareUpdatedPaymentAddress(
        page,
        orderId,
        false,
        savedPaymentAddress,
        "external_wallet"
      )
    await page.getByRole("button", { name: "Try payment again" }).tap()
    await expect
      .poll(() => readPaymentAddressRecovery(page, orderId))
      .toMatchObject({
        count: 1,
        orderId,
        address: savedPaymentAddress,
        checkoutMode: "external_wallet",
        paymentTarget: { type: "manual" },
        paymentStatus: "failed",
        invoiceStatus: "failed",
        hasInvoice: false,
        lastError: "LNURL error: Synthetic old provider unavailable",
      })
    expect(providerRequests).toEqual([
      "old-payment-fixture.dev/.well-known/lnurlp/merchant",
      "old-payment-fixture.dev/callback",
    ])
    await publishAddress(updatedPaymentAddress)
    await page.getByRole("button", { name: "Try payment again" }).tap()
    const dialog = page.getByRole("alertdialog", {
      name: "Merchant updated their payment address",
    })
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText(savedPaymentAddress, { exact: true })
    ).toBeVisible()
    await expect(
      dialog.getByText(updatedPaymentAddress, { exact: true })
    ).toBeVisible()
    expect(providerRequests).toHaveLength(2)
    await dialog
      .getByRole("button", { name: "Use updated address and retry" })
      .tap()
    await expect(
      page.getByRole("button", { name: "Copy invoice", exact: true })
    ).toBeVisible()
    expect(await readPaymentAddressRecovery(page, orderId)).toMatchObject({
      count: 1,
      orderId,
      address: updatedPaymentAddress,
      checkoutMode: "external_wallet",
      paymentTarget: { type: "manual" },
      paymentStatus: "manual_required",
      invoiceStatus: "manual_required",
      hasInvoice: true,
    })
    expect(providerRequests).toEqual([
      "old-payment-fixture.dev/.well-known/lnurlp/merchant",
      "old-payment-fixture.dev/callback",
      "new-payment-fixture.dev/.well-known/lnurlp/merchant",
      "new-payment-fixture.dev/callback",
    ])
    await page.reload()
    await expect(
      page.getByRole("button", { name: "Copy invoice", exact: true })
    ).toBeVisible()
    expect(await readPaymentAddressRecovery(page, orderId)).toMatchObject({
      count: 1,
      orderId,
      address: updatedPaymentAddress,
      checkoutMode: "external_wallet",
      paymentTarget: { type: "manual" },
      paymentStatus: "manual_required",
      hasInvoice: true,
    })
    expect(providerRequests).toHaveLength(4)
  })

  test("market blocks retry when the current signed profile removes its payment address @market", async ({
    page,
  }) => {
    const orderId = "mobile-removed-payment-address"
    const { providerRequests, publishAddress } =
      await prepareUpdatedPaymentAddress(
        page,
        orderId,
        false,
        savedPaymentAddress
      )
    await publishAddress()

    await page.getByRole("button", { name: "Try payment again" }).tap()
    await expect(
      page.getByRole("alert").filter({
        hasText:
          "The merchant's current profile no longer has a usable Lightning address. No invoice was requested.",
      })
    ).toBeVisible()
    expect(providerRequests).toEqual([])
    expect(await readPaymentAddressRecovery(page, orderId)).toMatchObject({
      count: 1,
      orderId,
      address: savedPaymentAddress,
      paymentStatus: "failed",
      invoiceStatus: "failed",
      hasInvoice: false,
    })
    await assertMobileViewport(page)
  })

  test("market rejects an updated payment address that changes after review @market", async ({
    page,
  }) => {
    const orderId = "mobile-changed-payment-address"
    const { providerRequests, publishAddress } =
      await prepareUpdatedPaymentAddress(page, orderId)
    await page.getByRole("button", { name: "Try payment again" }).tap()
    const dialog = page.getByRole("alertdialog", {
      name: "Merchant updated their payment address",
    })
    await expect(dialog).toBeVisible()
    await publishAddress("merchant@later-payment-fixture.dev")
    await dialog
      .getByRole("button", { name: "Use updated address and retry" })
      .tap()
    await expect(
      page.getByText(
        "The merchant's updated payment address could not be confirmed. Check it again before retrying.",
        { exact: true }
      )
    ).toBeVisible()
    expect(await readPaymentAddressRecovery(page, orderId)).toMatchObject({
      count: 1,
      orderId,
      address: savedPaymentAddress,
      paymentStatus: "failed",
      hasInvoice: false,
    })
    expect(providerRequests).toEqual([])
  })

  test("market still rejects a mismatched zap invoice after updating the payment address @market", async ({
    page,
  }) => {
    const orderId = "mobile-updated-address-wrong-invoice"
    const { providerRequests } = await prepareUpdatedPaymentAddress(
      page,
      orderId,
      true
    )
    await page.getByRole("button", { name: "Try payment again" }).tap()
    const dialog = page.getByRole("alertdialog", {
      name: "Merchant updated their payment address",
    })
    await expect(dialog).toBeVisible()
    await dialog
      .getByRole("button", { name: "Use updated address and retry" })
      .tap()
    await expect
      .poll(() => readPaymentAddressRecovery(page, orderId))
      .toMatchObject({
        count: 1,
        orderId,
        address: updatedPaymentAddress,
        paymentStatus: "failed",
        invoiceStatus: "failed",
        hasInvoice: false,
        lastError:
          "The zap invoice is not bound to the signed NIP-57 request sent to the callback.",
      })
    await expect(
      page.getByRole("button", { name: "Try payment again" })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Copy invoice", exact: true })
    ).toHaveCount(0)
    expect(providerRequests).toEqual([
      "new-payment-fixture.dev/.well-known/lnurlp/merchant",
      "new-payment-fixture.dev/callback",
    ])
    await page.getByRole("button", { name: "Try payment again" }).tap()
    await expect.poll(() => providerRequests.length).toBe(4)
    await expect(dialog).not.toBeVisible()
    await expect
      .poll(() => readPaymentAddressRecovery(page, orderId))
      .toMatchObject({
        count: 1,
        orderId,
        address: updatedPaymentAddress,
        paymentStatus: "failed",
        invoiceStatus: "failed",
        hasInvoice: false,
        lastError:
          "The zap invoice is not bound to the signed NIP-57 request sent to the callback.",
      })
    expect(providerRequests).toEqual([
      "new-payment-fixture.dev/.well-known/lnurlp/merchant",
      "new-payment-fixture.dev/callback",
      "new-payment-fixture.dev/.well-known/lnurlp/merchant",
      "new-payment-fixture.dev/callback",
    ])
  })

  test("market shows invoice binding failures after manual retry and reload @market", async ({
    page,
  }) => {
    const orderId = "mobile-invoice-binding-failure"
    const secretKey = generateSecretKey()
    const buyerPubkey = getPublicKey(secretKey)
    const failureDetail =
      "The merchant's payment provider returned an invoice that does not match this public zap request. Contact the merchant if this keeps happening."
    const failureAlert = page
      .getByRole("alert")
      .filter({ hasText: failureDetail })
    const invoice = makeBolt11Fixture({
      hrp: "lnbc10n",
      createdAt: Math.floor(Date.now() / 1000),
      fields: [
        bolt11PaymentHashField(),
        bolt11DescriptionHashField("unrelated synthetic description"),
      ],
    })
    let callbackRequests = 0
    let releaseCallback!: () => void
    const callbackReleased = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })
    await page.route("https://merchant-fixture.dev/**", async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/callback") {
        callbackRequests += 1
        expect(url.searchParams.get("amount")).toBe("1000")
        const zapRequest = JSON.parse(url.searchParams.get("nostr") ?? "null")
        expect(zapRequest?.kind).toBe(9734)
        expect(zapRequest?.pubkey).toBe(buyerPubkey)
        await callbackReleased
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ pr: invoice, routes: [] }),
        })
        return
      }
      expect(url.pathname).toBe("/.well-known/lnurlp/merchant")
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          tag: "payRequest",
          callback: "https://merchant-fixture.dev/callback",
          minSendable: 1_000,
          maxSendable: 100_000,
          allowsNostr: true,
          nostrPubkey: TEST_MERCHANT_PUBKEY,
          metadata: JSON.stringify([["text/plain", "Synthetic merchant"]]),
        }),
      })
    })
    await seedTestRelayIdentity(secretKey)
    await installTestSigner(page, buyerPubkey, { secretKey })
    await page.goto(`${marketUrl}/orders`)
    await expect(
      page.getByRole("heading", { name: "No orders yet" })
    ).toBeVisible()
    await seedPaymentLifecycle(page, {
      orderId,
      buyerPubkey,
      paymentClaimId: "unused-failed-preparation-claim",
      preparationError:
        "The zap invoice is not bound to the signed NIP-57 request sent to the callback.",
    })
    await page.goto(`${marketUrl}/orders?order=${orderId}`)
    await expect(failureAlert).toBeVisible()
    await page.reload()
    await expect(failureAlert).toBeVisible()

    try {
      await page.getByRole("button", { name: "Try payment again" }).tap()
      await expect.poll(() => callbackRequests).toBe(1)
      await expect(failureAlert).toHaveCount(0)
    } finally {
      releaseCallback()
    }

    // The real service catches the callback's binding error and resolves with
    // failed state. Orders must still show its actionable error to the buyer.
    await expect(failureAlert).toBeVisible()
    expect(await readRecoveredPayment(page, orderId)).toEqual({
      paymentStatus: "failed",
      proofDeliveryStatus: "not_started",
      paymentClaimId: undefined,
      marker: null,
    })
    await assertMobileViewport(page)
    await page.reload()
    await expect(failureAlert).toBeVisible()
    expect(callbackRequests).toBe(1)
  })

  test("market hides a saved payment failure after cancellation @market", async ({
    page,
  }) => {
    const orderId = "cancelled-payment-error"
    const secretKey = generateSecretKey()
    const buyerPubkey = getPublicKey(secretKey)
    const failureAlert = page.getByRole("alert").filter({
      hasText:
        "Payment could not be completed. Try again or contact the merchant if it keeps failing.",
    })
    await seedTestRelayIdentity(secretKey)
    await installTestSigner(page, buyerPubkey, { secretKey })
    await page.goto(`${marketUrl}/orders`)
    await expect(
      page.getByRole("heading", { name: "No orders yet" })
    ).toBeVisible()
    await seedPaymentLifecycle(page, {
      orderId,
      buyerPubkey,
      paymentClaimId: "unused-preparation-claim",
      preparationError: "Synthetic preparation failure",
    })
    await page.goto(`${marketUrl}/orders?order=${orderId}`)
    await expect(failureAlert).toBeVisible()

    // Keep the old failed payment and error intact while the effective order
    // becomes terminal. Reload must render cancellation without saved advice.
    await page.evaluate(async (id) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("orderLifecycles", "readwrite")
        const store = transaction.objectStore("orderLifecycles")
        const request = store.get(id)
        request.onsuccess = () => {
          if (!request.result) {
            transaction.abort()
            return
          }
          store.put({ ...request.result, phase: "cancelled" })
        }
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(new Error("Fixture update failed"))
      })
      database.close()
    }, orderId)
    await page.reload()
    await expect(
      page.getByText("Order cancelled", { exact: true })
    ).toBeVisible()
    await expect(failureAlert).toHaveCount(0)
    expect(await readRecoveredPayment(page, orderId)).toMatchObject({
      paymentStatus: "failed",
      proofDeliveryStatus: "not_started",
    })
    await assertMobileViewport(page)
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
    await seedPaymentLifecycle(page, {
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
    await seedPaymentLifecycle(page, {
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
    await seedPaymentLifecycle(page, {
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
    await gate.getByRole("tab", { name: "Paste bunker", exact: true }).tap()
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
