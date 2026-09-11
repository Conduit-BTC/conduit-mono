import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { getEventHash, nip19 } from "nostr-tools"
import { verifyEvent, type Event } from "nostr-tools/pure"

import {
  publishTestRelayEvents,
  readTestRelayEvents,
  TEST_RELAY_URL,
} from "./helpers/auth"
import {
  createDeterministicNwcWallet,
  type DeterministicNwcWallet,
} from "./helpers/deterministic-nwc-wallet"
import {
  createRuntimeSignerIdentity,
  decryptRuntimeTestPayload,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  readAuthenticatedGiftWraps,
  signRuntimeTestEvent,
  type RuntimeSignerIdentity,
} from "./helpers/real-nip07-signer"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
const merchantUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
}`
const merchantName = "Hermetic Merchant"
const merchantLud16 = "merchant@commerce-smoke.invalid"
const productImageUrl = "https://cdn.conduit.market/commerce-smoke-product.svg"

type PrivateRumor = {
  content: string
  created_at: number
  id: string
  kind: number
  pubkey: string
  tags: string[][]
}

test.use({ screenshot: "off", trace: "off", video: "off" })

async function installHermeticRoutes(context: BrowserContext): Promise<void> {
  await context.route("https://cdn.conduit.market/**", (route) => {
    if (route.request().url() === productImageUrl) {
      return route.fulfill({
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#7c3aed"/></svg>',
        contentType: "image/svg+xml",
        status: 200,
      })
    }
    return route.fulfill({ body: "", status: 404 })
  })
}

async function seedPublicIdentity(
  identity: RuntimeSignerIdentity,
  profile: Record<string, string>
): Promise<void> {
  const createdAt = Math.floor(Date.now() / 1_000)
  await publishTestRelayEvents([
    signRuntimeTestEvent(identity, {
      content: JSON.stringify(profile),
      created_at: createdAt,
      kind: 0,
      tags: [],
    }),
    signRuntimeTestEvent(identity, {
      content: "",
      created_at: createdAt,
      kind: 10_002,
      tags: [["r", TEST_RELAY_URL]],
    }),
  ])
}

async function publishPrivateInbox(
  page: Page,
  appUrl: string,
  identity: RuntimeSignerIdentity
): Promise<void> {
  await page.goto(`${appUrl}/network`)
  await expect(page.getByRole("heading", { name: "Network" })).toBeVisible()
  const relaySettings = page.getByRole("region", { name: "Relays" })
  const enablePrivateInbox = relaySettings.getByRole("button", {
    name: `Enable Private inbox for ${TEST_RELAY_URL}`,
  })
  await expect(enablePrivateInbox).toBeEnabled({ timeout: 20_000 })
  await enablePrivateInbox.click()
  const review = relaySettings.getByRole("button", {
    name: "Review and publish",
  })
  await expect(review).toBeEnabled()
  await review.click()
  const confirmation = page.getByRole("alertdialog")
  await expect(
    confirmation.getByRole("heading", {
      name: "Publish these Network changes?",
    })
  ).toBeVisible()
  await confirmation.getByRole("button", { name: "Sign and publish" }).click()
  await expect(
    page.getByText(
      "The exact signed preferences were confirmed on the planned relays.",
      { exact: true }
    )
  ).toBeVisible({ timeout: 20_000 })

  await expect
    .poll(async () => {
      const declarations = await readTestRelayEvents({
        authors: [identity.pubkey],
        kinds: [10_050],
      })
      return declarations.some(
        (event) =>
          verifyEvent(event) &&
          event.tags.some(
            ([name, value]) => name === "relay" && value === TEST_RELAY_URL
          )
      )
    })
    .toBe(true)
}

function parsePrivateRumor(
  recipient: RuntimeSignerIdentity,
  sender: RuntimeSignerIdentity,
  wrap: Event
): PrivateRumor | null {
  try {
    if (wrap.kind !== 1059 || !verifyEvent(wrap)) return null
    const wrapRecipients = wrap.tags.filter(([name]) => name === "p")
    if (
      wrapRecipients.length !== 1 ||
      wrapRecipients[0]?.[1] !== recipient.pubkey
    ) {
      return null
    }
    const seal = JSON.parse(
      decryptRuntimeTestPayload(recipient, wrap.pubkey, wrap.content)
    ) as Event
    if (
      seal.kind !== 13 ||
      !verifyEvent(seal) ||
      seal.pubkey !== sender.pubkey
    ) {
      return null
    }
    const rumor = JSON.parse(
      decryptRuntimeTestPayload(recipient, seal.pubkey, seal.content)
    ) as PrivateRumor
    if (
      !rumor ||
      typeof rumor.id !== "string" ||
      typeof rumor.pubkey !== "string" ||
      typeof rumor.created_at !== "number" ||
      typeof rumor.kind !== "number" ||
      typeof rumor.content !== "string" ||
      !Array.isArray(rumor.tags)
    ) {
      return null
    }
    const rumorRecipients = rumor.tags.filter(([name]) => name === "p")
    if (
      rumor.kind !== 16 ||
      rumor.pubkey !== sender.pubkey ||
      rumor.pubkey !== seal.pubkey ||
      rumorRecipients.length !== 1 ||
      rumorRecipients[0]?.[1] !== recipient.pubkey ||
      rumor.id !== getEventHash(rumor)
    ) {
      return null
    }
    return rumor
  } catch {
    return null
  }
}

async function privateRumorCount(input: {
  orderId: string
  recipient: RuntimeSignerIdentity
  sender: RuntimeSignerIdentity
  status?: string
  type: string
}): Promise<number> {
  const wraps = await readAuthenticatedGiftWraps(
    input.recipient,
    TEST_RELAY_URL
  )
  const rumorIds = new Set<string>()

  for (const wrap of wraps) {
    const rumor = parsePrivateRumor(input.recipient, input.sender, wrap)
    if (!rumor) continue
    if (
      !rumor.tags.some(
        ([name, value]) => name === "type" && value === input.type
      )
    ) {
      continue
    }
    const rumorOrderId = rumor.tags.find(([name]) => name === "order")?.[1]
    if (rumorOrderId !== input.orderId) continue
    const rumorStatus = rumor.tags.find(([name]) => name === "status")?.[1]
    if (input.status && rumorStatus !== input.status) continue
    rumorIds.add(rumor.id)
  }

  return rumorIds.size
}

async function privateRumorDiagnostics(input: {
  orderId: string
  recipient: RuntimeSignerIdentity
  sender: RuntimeSignerIdentity
  status?: string
  type: string
}): Promise<Record<string, number>> {
  const health = (await (
    await fetch(TEST_RELAY_URL.replace("ws://", "http://") + "/health")
  ).json()) as {
    counters?: { eventAccepted?: number; eventRejected?: number }
    storedEventCount?: number
  }
  const wraps = await readAuthenticatedGiftWraps(
    input.recipient,
    TEST_RELAY_URL
  )
  const counts = {
    accepted: health.counters?.eventAccepted ?? -1,
    rejected: health.counters?.eventRejected ?? -1,
    stored: health.storedEventCount ?? -1,
    recipientWraps: wraps.length,
    parsed: 0,
    bound: 0,
    type: 0,
    order: 0,
  }

  for (const wrap of wraps) {
    const rumor = parsePrivateRumor(input.recipient, input.sender, wrap)
    if (!rumor) continue
    counts.parsed += 1
    counts.bound += 1
    if (
      !rumor.tags.some(
        ([name, value]) => name === "type" && value === input.type
      )
    ) {
      continue
    }
    counts.type += 1
    if (
      !rumor.tags.some(
        ([name, value]) => name === "order" && value === input.orderId
      )
    ) {
      continue
    }
    if (
      input.status &&
      !rumor.tags.some(
        ([name, value]) => name === "status" && value === input.status
      )
    ) {
      continue
    }
    counts.order += 1
  }

  return counts
}

async function waitForPrivateRumor(input: {
  orderId: string
  recipient: RuntimeSignerIdentity
  sender: RuntimeSignerIdentity
  status?: string
  type: string
}): Promise<void> {
  try {
    await expect
      .poll(async () => (await privateRumorCount(input)) >= 1, {
        timeout: 30_000,
      })
      .toBe(true)
  } catch {
    const counts = await privateRumorDiagnostics(input)
    throw new Error(`E2E_COM_PRIVATE_RUMOR_MISSING ${JSON.stringify(counts)}`)
  }
}

async function publishProduct(page: Page, title: string): Promise<void> {
  await page.goto(`${merchantUrl}/products`)
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Add product" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Title").fill(title)
  await dialog
    .getByLabel("Summary")
    .fill("Deterministic local commerce smoke fixture.")
  await dialog.getByLabel("Price").fill("21")
  await dialog.getByLabel("Stock quantity").fill("3")
  await dialog.locator("#product-currency").click()
  await page.getByRole("option", { name: "SATS", exact: true }).click()
  await dialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: "Digital", exact: true }).click()
  await dialog.getByLabel("Image URL").fill(productImageUrl)
  const publicZaps = dialog.getByRole("checkbox", {
    name: /Enable public zaps for purchases/,
  })
  if (await publicZaps.isChecked()) await publicZaps.uncheck()
  const tags = dialog.getByRole("combobox", { name: "Tags" })
  for (const tag of ["commerce", "smoke", "hermetic"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
  const publish = dialog.getByRole("button", {
    name: "Publish product",
    exact: true,
  })
  await expect(publish).toBeEnabled()
  await publish.click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

test("E2E-COM-01..06 buyer and merchant settle once across reload @commerce", async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const buyer = createRuntimeSignerIdentity()
  const merchant = createRuntimeSignerIdentity()
  const productTitle = `Hermetic commerce ${Date.now().toString(36)}`
  let wallet: DeterministicNwcWallet | null = null
  let buyerContext: BrowserContext | null = null
  let merchantContext: BrowserContext | null = null

  try {
    await seedPublicIdentity(buyer, {
      display_name: "Hermetic Buyer",
      name: "hermetic-buyer",
    })
    await seedPublicIdentity(merchant, {
      display_name: merchantName,
      lud16: merchantLud16,
      name: "hermetic-merchant",
    })

    wallet = createDeterministicNwcWallet({
      lud16: merchantLud16,
      relayUrl: TEST_RELAY_URL,
    })
    await wallet.start()

    buyerContext = await browser.newContext()
    merchantContext = await browser.newContext()
    await Promise.all([
      installHermeticRoutes(buyerContext),
      installHermeticRoutes(merchantContext),
    ])
    const buyerPage = await buyerContext.newPage()
    const merchantPage = await merchantContext.newPage()
    await installRealTestSigner(buyerPage, buyer, TEST_RELAY_URL)
    await installRealTestSigner(merchantPage, merchant, TEST_RELAY_URL)

    await publishPrivateInbox(buyerPage, marketUrl, buyer)
    await publishPrivateInbox(merchantPage, merchantUrl, merchant)

    await merchantPage.goto(`${merchantUrl}/payments`)
    await expect(
      merchantPage.getByRole("heading", { name: "Payments", exact: true })
    ).toBeVisible()
    await wallet.configureMerchantConnection(async (connectionString) => {
      await merchantPage.getByLabel("Connection string").fill(connectionString)
    })
    await merchantPage
      .getByRole("button", { name: "Connect wallet", exact: true })
      .click()
    await expect(
      merchantPage.getByText("Verification ready", { exact: true })
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      merchantPage.getByText("Receiving address matches", { exact: true })
    ).toBeVisible()

    await publishProduct(merchantPage, productTitle)
    await expect
      .poll(async () => {
        const products = await readTestRelayEvents({
          authors: [merchant.pubkey],
          kinds: [30_402],
        })
        return products.some(
          (event) =>
            verifyEvent(event) &&
            event.tags.some(
              ([name, value]) => name === "title" && value === productTitle
            ) &&
            event.tags.some(
              ([name, amount, currency]) =>
                name === "price" && amount === "21" && currency === "SATS"
            )
        )
      })
      .toBe(true)

    const merchantNpub = nip19.npubEncode(merchant.pubkey)
    await buyerPage.goto(`${marketUrl}/store/${merchantNpub}`)
    await expect(
      buyerPage.getByRole("heading", { name: merchantName, exact: true })
    ).toBeVisible({ timeout: 30_000 })
    const search = buyerPage.getByPlaceholder("Search items in this store")
    await search.fill(productTitle)
    await search.press("Enter")
    const product = buyerPage
      .getByRole("listitem")
      .filter({ hasText: productTitle })
    await expect(product).toBeVisible({ timeout: 30_000 })
    const add = product.getByRole("button", { name: "Add", exact: true })
    await expect(add).toBeEnabled({ timeout: 30_000 })
    await add.click()

    const cartHud = buyerPage.getByRole("region", {
      name: "Cart inventory",
      exact: true,
    })
    const checkout = cartHud.getByRole("link", {
      name: "Continue to checkout",
      exact: true,
    })
    await expect(checkout).toBeVisible()
    await checkout.click()
    const continueToOrder = buyerPage.getByRole("button", {
      name: "Continue to Send Order",
      exact: true,
    })
    await expect
      .poll(async () => {
        if (await continueToOrder.isVisible()) return "continue"
        if (
          await buyerPage
            .getByRole("heading", { name: "Send Order", exact: true })
            .isVisible()
        ) {
          return "ready"
        }
        return "pending"
      })
      .not.toBe("pending")
    if (await continueToOrder.isVisible()) await continueToOrder.click()
    await expect(
      buyerPage.getByRole("heading", { name: "Send Order", exact: true })
    ).toBeVisible({ timeout: 30_000 })
    const sendOrder = buyerPage.getByRole("button", {
      name: "Send order",
      exact: true,
    })
    await expect(sendOrder).toBeEnabled({ timeout: 30_000 })
    await sendOrder.click()
    await expect
      .poll(() => {
        const url = new URL(buyerPage.url())
        return url.pathname === "/orders" && !!url.searchParams.get("order")
      })
      .toBe(true)
    const buyerOrderUrl = new URL(buyerPage.url())
    const orderId = buyerOrderUrl.searchParams.get("order")
    if (!orderId) throw new Error("The buyer order route has no order ID.")
    const buyerOrderPath = `${buyerOrderUrl.pathname}${buyerOrderUrl.search}`

    await waitForPrivateRumor({
      orderId,
      recipient: merchant,
      sender: buyer,
      type: "order",
    })

    const merchantOrderPath = `/orders?order=${encodeURIComponent(orderId)}`
    await merchantPage.goto(`${merchantUrl}${merchantOrderPath}`)
    await expect(
      merchantPage.getByRole("heading", { name: "Orders", exact: true })
    ).toBeVisible()
    await expect(
      merchantPage
        .getByText(productTitle, { exact: true })
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 30_000 })
    const acceptOrder = merchantPage.getByRole("button", {
      name: "Accept order",
      exact: true,
    })
    await expect(acceptOrder).toBeEnabled({ timeout: 30_000 })
    await acceptOrder.click()
    await expect(
      merchantPage.getByText("Status update sent to buyer", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await waitForPrivateRumor({
      orderId,
      recipient: buyer,
      sender: merchant,
      status: "accepted",
      type: "status_update",
    })

    await buyerPage.goto(`${marketUrl}${buyerOrderPath}`)
    await buyerPage
      .getByRole("button", { name: "Open messages", exact: true })
      .click()
    await expect(
      buyerPage.getByText("Status: Accepted", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await buyerPage
      .getByRole("dialog", { name: "Messages", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click()

    const invoiceSource = merchantPage.locator("#invoice-source")
    await expect(invoiceSource).toBeVisible({ timeout: 30_000 })
    await invoiceSource.click()
    const nwcOption = merchantPage.getByRole("option", {
      name: "Connected wallet (NWC)",
      exact: true,
    })
    await expect(nwcOption).toBeEnabled({ timeout: 20_000 })
    await nwcOption.click()
    await expect(
      merchantPage.getByLabel("Amount", { exact: true })
    ).toHaveValue("21")
    await expect(merchantPage.locator("#invoice-currency")).toContainText(
      "SATS"
    )
    const generateInvoice = merchantPage.getByRole("button", {
      name: "Generate & send invoice",
      exact: true,
    })
    await expect(generateInvoice).toBeEnabled({ timeout: 20_000 })
    await generateInvoice.click()
    await expect(
      merchantPage.getByText(
        "Invoice generated and sent to the buyer's relay",
        { exact: true }
      )
    ).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => {
        const snapshot = wallet!.snapshot()
        return (
          snapshot.counters.makeInvoice === 1 &&
          snapshot.invoiceState === "pending"
        )
      })
      .toBe(true)
    await waitForPrivateRumor({
      orderId,
      recipient: buyer,
      sender: merchant,
      type: "payment_request",
    })

    await buyerPage.goto(`${marketUrl}${buyerOrderPath}`)
    await expect(
      buyerPage.getByRole("heading", {
        name: "Merchant invoice ready",
        exact: true,
      })
    ).toBeVisible({ timeout: 30_000 })
    await buyerPage
      .getByRole("button", { name: "Use merchant invoice", exact: true })
      .click()
    await expect(
      buyerPage.getByRole("heading", {
        name: "Pay merchant invoice",
        exact: true,
      })
    ).toBeVisible()
    await wallet.payLastInvoice()
    await expect
      .poll(() => {
        const snapshot = wallet!.snapshot()
        return (
          snapshot.counters.payInvoice === 1 &&
          snapshot.invoiceState === "settled"
        )
      })
      .toBe(true)
    await buyerPage
      .getByRole("button", {
        name: "Report payment to merchant",
        exact: true,
      })
      .click()
    await expect(
      buyerPage.getByText("Payment proof was delivered over Nostr.", {
        exact: true,
      })
    ).toBeVisible({ timeout: 30_000 })
    await waitForPrivateRumor({
      orderId,
      recipient: merchant,
      sender: buyer,
      type: "payment_proof",
    })

    await expect
      .poll(() => wallet!.snapshot().counters.lookupInvoice >= 1, {
        timeout: 60_000,
      })
      .toBe(true)
    await waitForPrivateRumor({
      orderId,
      recipient: buyer,
      sender: merchant,
      status: "paid",
      type: "status_update",
    })

    await merchantPage.goto(`${merchantUrl}${merchantOrderPath}`)
    const merchantProgress = merchantPage.getByRole("list", {
      name: "Order progress",
    })
    await expect(
      merchantProgress.getByText("Payment confirmed", { exact: true })
    ).toBeVisible({ timeout: 30_000 })

    await buyerPage.goto(`${marketUrl}${buyerOrderPath}`)
    await buyerPage
      .getByRole("button", { name: "Open messages", exact: true })
      .click()
    await expect(
      buyerPage.getByText("Status: Paid", { exact: true })
    ).toBeVisible({ timeout: 30_000 })

    await Promise.all([merchantPage.reload(), buyerPage.reload()])
    await expect(
      merchantPage
        .getByRole("list", { name: "Order progress" })
        .getByText("Payment confirmed", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await buyerPage
      .getByRole("button", { name: "Open messages", exact: true })
      .click()
    await expect(
      buyerPage.getByText("Status: Paid", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      merchantPage.getByRole("button", {
        name: "Generate & send invoice",
        exact: true,
      })
    ).toHaveCount(0)
    await expect(
      buyerPage.getByRole("button", {
        name: "Report payment to merchant",
        exact: true,
      })
    ).toHaveCount(0)
    expect(
      wallet.snapshot().counters.makeInvoice === 1 &&
        wallet.snapshot().counters.payInvoice === 1 &&
        wallet.snapshot().counters.lookupInvoice >= 1
    ).toBe(true)
    expect(
      (await privateRumorCount({
        orderId,
        recipient: merchant,
        sender: buyer,
        type: "order",
      })) === 1 &&
        (await privateRumorCount({
          orderId,
          recipient: buyer,
          sender: merchant,
          type: "payment_request",
        })) === 1 &&
        (await privateRumorCount({
          orderId,
          recipient: merchant,
          sender: buyer,
          type: "payment_proof",
        })) === 1 &&
        (await privateRumorCount({
          orderId,
          recipient: buyer,
          sender: merchant,
          status: "paid",
          type: "status_update",
        })) === 1
    ).toBe(true)
  } finally {
    await Promise.allSettled([
      buyerContext?.close(),
      merchantContext?.close(),
      wallet?.close(),
    ])
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
  }
})
