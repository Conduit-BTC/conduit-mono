import { createHash, randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"
import { nip19 } from "nostr-tools"
import { getEventHash, verifyEvent, type Event } from "nostr-tools/pure"
import {
  DefaultSparkSigner,
  encodeSparkAddress,
} from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.node.js"
import { openPlaywrightRouterClock } from "../scripts/dev/playwright_router_clock"
import { CONDUIT_CHECKOUT_LOCAL_CANARY_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import {
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  resolveEventMarketEvidence,
} from "../packages/core/src/protocol/event-market"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "../tests/support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "../tests/support/signed-bolt11-fixture"
import {
  publishTestRelayEvents,
  readTestRelayEvents,
  TEST_RELAY_URL,
} from "./helpers/auth"
import {
  createHermeticLnurlFixture,
  type HermeticLnurlIssuedInvoice,
} from "./helpers/hermetic-lnurl"
import {
  createHermeticCommerceNetworkPolicy,
  installHermeticCommerceNetwork,
} from "./helpers/hermetic-network"
import { createHermeticSparkNative } from "./helpers/hermetic-spark-native"
import { installPersistenceReloadBarrier } from "./helpers/persistence-reload-barrier"
import {
  createHermeticSparkTransport,
  installHermeticSparkTransport,
} from "./helpers/hermetic-spark-transport"
import {
  createRuntimeSignerIdentity,
  decryptRuntimeTestPayload,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  readAuthenticatedGiftWraps,
  signRuntimeTestEvent,
  type RuntimeSignerIdentity,
} from "./helpers/real-nip07-signer"

// This file is selected only by playwright.router.config.ts. Ordinary Commerce
// stays on testnet; this SDK-native fixture accepts regtest and nothing else.
const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "5173"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "5174"}`
const imageUrl = "https://cdn.conduit.market/router-native-smoke.svg"
const merchantName = "Isolated Router Merchant"
const pickupMarketTitle = "Isolated Router Pickup Market"
const pickupLocation = "Synthetic market hall, merchant booth 2"
// Exact offline responses only. Reserved example domains are intentionally
// rejected by the real payout URL policy, so use allowed-shaped test targets.
const merchantAddress = "router-merchant@wallet.conduit.market"
const supplierAddress = "router-supplier@wallet.conduit.market"
const merchantProfileRelay = "wss://relay.conduit.market/"
const supplierProfileRelay = "wss://relay.damus.io/"
const networkOptions = {
  appUrls: [marketUrl, merchantUrl],
  relayUrl: TEST_RELAY_URL,
  imageUrl,
}

// Observe local retirement without exposing wallet machinery in the Merchant UI.
// This helper reads only this isolated fixture's persisted state and returns a
// small status. It never writes a tombstone or manufactures provider evidence.
async function merchantWalletState(page: Page, orderId: string | null) {
  const modulePath = `/@fs/${fileURLToPath(new URL("../packages/core/src/db/index.ts", import.meta.url)).replaceAll("\\", "/")}`
  return page.evaluate(
    async ({ modulePath, orderId }) => {
      const { db } = await import(/* @vite-ignore */ modulePath)
      const bindings = await db.checkoutSparkPlanBindings.toArray()
      const binding = bindings.find(
        (row: { orderWitness?: { orderId: string } }) =>
          row.orderWitness?.orderId === orderId
      )
      if (!binding) return "absent"
      const retired = await db.checkoutSparkRetirements.get(binding.checkoutId)
      return retired ? "retired" : "active"
    },
    { modulePath, orderId }
  )
}

test.use({
  screenshot: "off",
  trace: "off",
  video: "off",
  actionTimeout: 15_000,
  navigationTimeout: 45_000,
})

async function seedIdentity(
  identity: RuntimeSignerIdentity,
  name: string,
  lud16?: string
): Promise<void> {
  const createdAt = Math.floor(Date.now() / 1_000)
  await publishTestRelayEvents([
    signRuntimeTestEvent(identity, {
      kind: 0,
      created_at: createdAt,
      tags: [],
      content: JSON.stringify({ name, ...(lud16 ? { lud16 } : {}) }),
    }),
    signRuntimeTestEvent(identity, {
      kind: 10_002,
      created_at: createdAt,
      tags: [["r", TEST_RELAY_URL]],
      content: "",
    }),
    signRuntimeTestEvent(identity, {
      kind: 10_050,
      created_at: createdAt,
      tags: [["relay", TEST_RELAY_URL]],
      content: "",
    }),
  ])
}

async function publishSupplierListing(
  page: Page,
  supplier: RuntimeSignerIdentity,
  productTitle: string,
  onStage: (stage: string) => void
): Promise<void> {
  onStage("merchant product page")
  await page.goto(`${merchantUrl}/products`)
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()
  onStage("opening product form")
  await page.getByRole("button", { name: "Add product" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await expect(dialog).toBeVisible()
  onStage("product title and pricing fields")
  await dialog.getByLabel("Title").fill(productTitle)
  await dialog
    .getByLabel("Summary")
    .fill("Offline supplier settlement rehearsal.")
  await dialog.getByLabel("Price", { exact: true }).fill("1000")
  await dialog.getByLabel("Stock quantity").fill("3")
  onStage("product currency selection")
  await dialog.locator("#product-currency").click()
  await page.getByRole("option", { name: "SATS", exact: true }).click()
  onStage("digital fulfillment selection")
  await dialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: "Digital", exact: true }).click()
  onStage("product image URL")
  await dialog.getByRole("button", { name: "Add by URL", exact: true }).click()
  await dialog.getByLabel("Primary image URL").fill(imageUrl)
  onStage("public zap preference")
  await dialog
    .getByRole("checkbox", { name: /Enable public zaps for purchases/ })
    .uncheck()
  onStage("required product tags")
  const tags = dialog.getByRole("combobox", { name: "Tags" })
  for (const tag of ["commerce", "supplier", "hermetic"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
  onStage("supplier allocation controls")
  await dialog
    .getByRole("checkbox", {
      name: "Share revenue with suppliers",
      exact: true,
    })
    .check()
  await dialog
    .getByRole("button", { name: "Add supplier", exact: true })
    .click()
  await dialog
    .getByLabel("Supplier 1 npub")
    .fill(nip19.npubEncode(supplier.pubkey))
  await dialog.getByLabel("Supplier 1 share (%)", { exact: true }).fill("25")
  await dialog.getByText("Advanced profile discovery", { exact: true }).click()
  await dialog.getByLabel("Your profile relay hint").fill(merchantProfileRelay)
  await dialog
    .getByLabel("Supplier 1 profile relay hint")
    .fill(supplierProfileRelay)
  onStage("product publication submission")
  const publish = dialog.getByRole("button", {
    name: "Publish product",
    exact: true,
  })
  await expect(publish).toBeEnabled()
  await publish.click()
  onStage("product publication completion")
  await expect(dialog).toBeHidden({ timeout: 10_000 })
}

function createMerchantPickupGraph(
  merchant: RuntimeSignerIdentity,
  listing: Event,
  createdAt: number
) {
  const dTags = listing.tags.filter(([name]) => name === "d")
  const productDTag = dTags[0]?.[1]
  if (
    listing.kind !== 30_402 ||
    listing.pubkey !== merchant.pubkey ||
    !verifyEvent(listing) ||
    dTags.length !== 1 ||
    !productDTag ||
    !listing.tags.some(
      ([name, type, format]) =>
        name === "type" && type === "simple" && format === "digital"
    ) ||
    listing.tags.some(([name]) => name === "a" || name === "shipping_option")
  ) {
    throw new Error("Isolated supplier listing was not ready for pickup.")
  }

  // Revise the genuinely UI-authored listing at the external relay boundary.
  // Its supplier weights and other signed terms survive unchanged. No cache,
  // cart, quote, order, recovery, or settlement state is injected into the app.
  const calendarDTag = "isolated-router-calendar"
  const collectionDTag = "isolated-router-collection"
  const pickupDTag = "isolated-router-booth"
  const calendarCoordinate = `31923:${merchant.pubkey}:${calendarDTag}`
  const collectionCoordinate = `30405:${merchant.pubkey}:${collectionDTag}`
  const pickupCoordinate = `30406:${merchant.pubkey}:${pickupDTag}`
  const calendar = signRuntimeTestEvent(merchant, {
    ...buildEventMarketCalendarDraft({
      kind: 31_923,
      dTag: calendarDTag,
      title: pickupMarketTitle,
      start: createdAt - 60,
      end: createdAt + 3_600,
      locations: [pickupLocation],
      image: imageUrl,
    }),
    created_at: createdAt,
  })
  const pickup = signRuntimeTestEvent(merchant, {
    ...buildEventMarketPickupDraft({
      dTag: pickupDTag,
      title: "Merchant booth",
      price: 0,
      currency: "SAT",
      countries: ["US"],
      location: pickupLocation,
      geohash: "dr5ru",
    }),
    created_at: createdAt,
  })
  const collection = signRuntimeTestEvent(merchant, {
    ...buildEventMarketCollectionDraft({
      dTag: collectionDTag,
      title: pickupMarketTitle,
      eventCoordinate: calendarCoordinate,
      productCoordinates: [`30402:${merchant.pubkey}:${productDTag}`],
      image: imageUrl,
      location: pickupLocation,
      // No organizer pickup offer or future event-market activation. The
      // selected merchant-owned option and legacy calendar determine handoff.
    }),
    created_at: createdAt,
  })
  const physicalListing = signRuntimeTestEvent(merchant, {
    kind: listing.kind,
    content: listing.content,
    created_at: createdAt,
    tags: [
      ...listing.tags.filter(([name]) => name !== "type"),
      ["type", "simple", "physical"],
      ["a", collectionCoordinate],
      ["shipping_option", pickupCoordinate],
    ],
  })
  const resolution = resolveEventMarketEvidence({
    reference: collectionCoordinate,
    expectedOrganizerPubkey: merchant.pubkey,
    selectedProductCoordinates: [`30402:${merchant.pubkey}:${productDTag}`],
    events: [calendar, collection, pickup],
    productRequestEvents: [physicalListing],
    nowMs: createdAt * 1_000,
  })
  // Runner-side fixture validity, not a bypass of the browser's independent
  // signed-source resolution. Assert only public-state enums and counts.
  expect({
    state: resolution.state,
    acceptedProducts: resolution.acceptedProductCoordinates.length,
    calendars: Number(!!resolution.calendar),
    collections: Number(!!resolution.collection),
    pickups: resolution.pickups.length,
  }).toEqual({
    state: "active",
    acceptedProducts: 1,
    calendars: 1,
    collections: 1,
    pickups: 1,
  })
  return {
    calendar,
    collection,
    pickup,
    physicalListing,
    productDTag,
    collectionDTag,
  }
}

async function seedMerchantPickup(
  merchant: RuntimeSignerIdentity,
  listing: Event
): Promise<string> {
  const createdAt = Math.max(
    Math.floor(Date.now() / 1_000),
    listing.created_at + 1
  )
  await expect
    .poll(() => Math.floor(Date.now() / 1_000) >= createdAt, {
      timeout: 5_000,
    })
    .toBe(true)
  const {
    calendar,
    collection,
    pickup,
    physicalListing,
    productDTag,
    collectionDTag,
  } = createMerchantPickupGraph(merchant, listing, createdAt)
  await publishTestRelayEvents([calendar, pickup])
  await publishTestRelayEvents([collection, physicalListing])
  await expect
    .poll(async () => {
      const events = await readTestRelayEvents({
        kinds: [30_402],
        authors: [merchant.pubkey],
        "#d": [productDTag],
      })
      return events.some(
        (event) => event.id === physicalListing.id && verifyEvent(event)
      )
    })
    .toBe(true)
  return nip19.naddrEncode({
    kind: 30_405,
    pubkey: merchant.pubkey,
    identifier: collectionDTag,
    relays: [TEST_RELAY_URL],
  })
}

function fundingInvoice(amountSats: number, expirySeconds: number): string {
  const preimage = randomBytes(32)
  const paymentHash = createHash("sha256").update(preimage).digest()
  preimage.fill(0)
  const expiryWords: number[] = []
  for (let value = expirySeconds; value > 0; value = Math.floor(value / 32)) {
    expiryWords.unshift(value % 32)
  }
  return makeSignedBolt11Fixture({
    hrp: `lnbcrt${BigInt(amountSats) * 10n}n`,
    createdAt: Math.floor(Date.now() / 1_000),
    fields: [
      bolt11PaymentHashField(paymentHash),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField("Offline router funding"),
      { tag: "x", words: expiryWords },
    ],
  })
}

async function rehearseRouter(
  browser: Browser,
  fulfillment: "digital" | "pickup",
  continuation: "buyer" | "cold-merchant" | "partial-cold-merchant" = "buyer"
): Promise<void> {
  test.setTimeout(180_000)
  const sharedClock = openPlaywrightRouterClock()
  sharedClock.reset()
  const productTitle =
    fulfillment === "pickup"
      ? "Isolated supplier router pickup"
      : "Isolated supplier router download"
  createHermeticCommerceNetworkPolicy(networkOptions)
  const merchant = createRuntimeSignerIdentity()
  const buyer = createRuntimeSignerIdentity()
  const supplier = createRuntimeSignerIdentity()
  const supplierNoticeCount = async () => {
    const wraps = await readAuthenticatedGiftWraps(
      supplier,
      TEST_RELAY_URL,
      sharedClock.nowMs
    )
    const rumors = new Set<string>()
    for (const wrap of wraps) {
      if (!verifyEvent(wrap)) return -1
      const seal = JSON.parse(
        decryptRuntimeTestPayload(supplier, wrap.pubkey, wrap.content)
      )
      if (
        !verifyEvent(seal) ||
        seal.kind !== 13 ||
        seal.pubkey !== merchant.pubkey
      )
        return -1
      const rumor = JSON.parse(
        decryptRuntimeTestPayload(supplier, seal.pubkey, seal.content)
      )
      if (
        rumor.kind !== 14 ||
        rumor.pubkey !== merchant.pubkey ||
        rumor.id !== getEventHash(rumor) ||
        Object.hasOwn(rumor, "sig") ||
        !rumor.tags.some(
          ([name, value]: string[]) => name === "p" && value === supplier.pubkey
        ) ||
        !rumor.content.startsWith(
          "Your revenue share of 249 sats has been paid"
        ) ||
        [
          merchantAddress,
          supplierAddress,
          CONDUIT_CHECKOUT_LOCAL_CANARY_FEE_RECIPIENT,
        ].some((address) => rumor.content.includes(address))
      )
        return -1
      rumors.add(rumor.id)
    }
    return rumors.size
  }
  const contexts: BrowserContext[] = []
  const beginNetworkTeardown = new Map<BrowserContext, () => void>()
  let identity: string | undefined
  let grossFundingSats: number | undefined
  const native = createHermeticSparkNative({
    encodeAddress: (identityPublicKey) =>
      encodeSparkAddress({ identityPublicKey, network: "REGTEST" }),
    async deriveIdentity(mnemonic, accountNumber) {
      // The runner uses the pinned SDK's local derivation primitive. Do not
      // import browser app modules (or initialize a provider) during discovery.
      const signer = new DefaultSparkSigner()
      const seed = await signer.mnemonicToSeed(mnemonic)
      try {
        return await signer.createSparkWalletFromSeed(seed, accountNumber)
      } finally {
        seed.fill(0)
      }
    },
    issueFundingInvoice: async (request) => {
      identity = request.identityPublicKey
      grossFundingSats = request.amountSats
      return fundingInvoice(request.amountSats, request.expirySeconds)
    },
  })
  const nativeTransport = createHermeticSparkTransport(native)
  let fundingObservations = 0
  const transport = {
    ...nativeTransport,
    async request(command: Parameters<typeof nativeTransport.request>[0]) {
      const result = await nativeTransport.request(command)
      if (
        command.type === "wallet.call" &&
        command.method === "getLightningReceiveRequest"
      ) {
        fundingObservations += 1
      }
      return result
    },
  }
  const issued = new Map<string, HermeticLnurlIssuedInvoice>()
  let conduitInvoiceHeld = false
  let holdConduitInvoice = true
  let resolveConduitInvoice!: () => void
  let conduitInvoiceGate = new Promise<void>((resolve) => {
    resolveConduitInvoice = resolve
  })
  const releaseConduitInvoice = () => {
    holdConduitInvoice = false
    resolveConduitInvoice()
  }
  const control = () => {
    if (!identity) throw new Error("Isolated checkout wallet was not prepared.")
    return native.control.forIdentity(identity)
  }
  const lnurl = createHermeticLnurlFixture({
    recipients: [
      merchantAddress,
      supplierAddress,
      CONDUIT_CHECKOUT_LOCAL_CANARY_FEE_RECIPIENT,
    ].map((lud16) => ({ lud16 })),
    nowSeconds: () => Math.floor(sharedClock.nowMs() / 1_000),
    onInvoiceIssued: async (invoice) => {
      issued.set(invoice.paymentRequest, invoice)
      control().registerPayout(invoice)
      if (
        holdConduitInvoice &&
        invoice.lud16 === CONDUIT_CHECKOUT_LOCAL_CANARY_FEE_RECIPIENT
      ) {
        // Hold an external LNURL response, never application intent or proof
        // state. This makes the two-commerce-paid receipt deterministic.
        conduitInvoiceHeld = true
        await conduitInvoiceGate
      }
    },
  })
  let stage = "isolated setup"
  try {
    await seedIdentity(merchant, merchantName, merchantAddress)
    await seedIdentity(supplier, "Isolated Router Supplier", supplierAddress)
    await seedIdentity(buyer, "Isolated Router Buyer")
    const merchantContext = await browser.newContext({
      serviceWorkers: "block",
    })
    contexts.push(merchantContext)
    await merchantContext.grantPermissions(["local-network-access"], {
      origin: merchantUrl,
    })
    beginNetworkTeardown.set(
      merchantContext,
      await installHermeticCommerceNetwork(merchantContext, {
        ...networkOptions,
        lnurl: lnurl.respond,
      })
    )
    await installHermeticSparkTransport(merchantContext, transport, {
      appUrl: merchantUrl,
    })
    const merchantPage = await merchantContext.newPage()
    await installRealTestSigner(merchantPage, merchant, TEST_RELAY_URL)
    stage = "mounted supplier listing publication"
    await publishSupplierListing(
      merchantPage,
      supplier,
      productTitle,
      (next) => {
        stage = next
      }
    )
    let signedListing: Event | undefined
    await expect
      .poll(async () => {
        const events = await readTestRelayEvents({
          kinds: [30_402],
          authors: [merchant.pubkey],
        })
        const expected = [
          ["conduit_supplier_allocation", "1"],
          ["zap", merchant.pubkey, merchantProfileRelay, "3"],
          ["zap", supplier.pubkey, supplierProfileRelay, "1"],
        ]
        const matches =
          events.length === 1 &&
          verifyEvent(events[0]!) &&
          JSON.stringify(
            events[0]!.tags.filter(
              ([name]) =>
                name === "zap" || name === "conduit_supplier_allocation"
            )
          ) === JSON.stringify(expected)
        if (matches) signedListing = events[0]
        return matches
      })
      .toBe(true)

    let catalogPath = `/${nip19.npubEncode(merchant.pubkey)}`
    if (fulfillment === "pickup") {
      stage = "signed merchant pickup graph publication"
      if (!signedListing)
        throw new Error("Isolated supplier listing was not observed.")
      catalogPath = `/events/${await seedMerchantPickup(merchant, signedListing)}`
    }

    stage = "mounted buyer cart and private order"
    const buyerContext = await browser.newContext({ serviceWorkers: "block" })
    contexts.push(buyerContext)
    await buyerContext.grantPermissions(["local-network-access"], {
      origin: marketUrl,
    })
    beginNetworkTeardown.set(
      buyerContext,
      await installHermeticCommerceNetwork(buyerContext, {
        ...networkOptions,
        lnurl: lnurl.respond,
      })
    )
    await installHermeticSparkTransport(buyerContext, transport, {
      appUrl: marketUrl,
    })
    const page = await buyerContext.newPage()
    const buyerPersistence = installPersistenceReloadBarrier(page, marketUrl)
    await installRealTestSigner(page, buyer, TEST_RELAY_URL)
    stage = "buyer catalog product load"
    await page.goto(`${marketUrl}${catalogPath}`)
    if (fulfillment === "pickup") {
      await expect(
        page.getByRole("heading", { name: pickupMarketTitle, exact: true })
      ).toBeVisible({ timeout: 30_000 })
    }
    stage = "browser SDK module preload without wallet initialization"
    const sdkLoaded = await page.evaluate(async () => {
      try {
        const path = "/src/lib/spark-sdk.ts"
        const { loadFirstPartySparkModule } = await import(
          /* @vite-ignore */ path
        )
        const sdk = await loadFirstPartySparkModule()
        return typeof sdk.initialize === "function"
      } catch {
        return false
      }
    })
    expect(sdkLoaded).toBe(true)
    stage = "buyer catalog product visibility"
    const product = page.getByRole("listitem").filter({ hasText: productTitle })
    await expect(product).toBeVisible({ timeout: 30_000 })
    if (fulfillment === "digital") {
      await expect(product.getByText("~ ₿1,113", { exact: true })).toBeVisible()
      await expect(product.getByText(/Estimated total/)).toBeVisible()
    } else {
      await expect(product.getByText("₿1,000", { exact: true })).toBeVisible()
      await expect(product.getByText(/Estimated total/)).toHaveCount(0)
    }
    stage = "buyer add product to cart"
    await product.getByRole("button", { name: "Add", exact: true }).click()
    stage = "buyer continue to checkout"
    await page
      .getByRole("region", { name: "Cart inventory", exact: true })
      .getByRole("link", { name: "Continue to checkout", exact: true })
      .click()
    const checkoutPrice = page.getByRole("region", {
      name: "Order price",
      exact: true,
    })
    await expect(
      checkoutPrice.getByText("Estimated order total", { exact: true })
    ).toBeVisible()
    await expect(
      checkoutPrice.getByText("₿1,113", { exact: true })
    ).toBeVisible()
    await expect(
      checkoutPrice.getByText("₿1,000", { exact: true })
    ).toBeVisible()
    await expect(page.getByText(supplierAddress, { exact: false })).toHaveCount(
      0
    )
    if (fulfillment === "pickup") {
      stage = "buyer merchant pickup review"
      const summary = page.locator("aside").filter({
        has: page.getByRole("heading", { name: "Order summary", exact: true }),
      })
      await expect(
        summary.getByText(`Pickup from merchant booth · ${pickupLocation}`, {
          exact: true,
        })
      ).toBeVisible()
      await expect(
        summary.getByText(`Handled by ${merchantName}`, { exact: true })
      ).toBeVisible()
      await expect(
        page.getByText(/Organizer release authorization/)
      ).toHaveCount(0)
      await expect(page.getByLabel(/^Street address/)).toHaveCount(0)
    }
    stage = "buyer router prepare eligibility"
    const prepare = page.getByRole("button", {
      name: "Continue to payment",
      exact: true,
    })
    await expect(prepare).toBeEnabled({ timeout: 30_000 })
    stage = "buyer router order submission"
    await prepare.click()
    stage = "buyer order preparation completion"
    await expect
      .poll(
        async () => {
          if (
            await page
              .getByText(/Settled router preparation could not be confirmed/)
              .isVisible()
          )
            throw new Error("Router preparation failed")
          return page
            .getByRole("heading", { name: "Orders", exact: true })
            .isVisible()
        },
        { timeout: 45_000 }
      )
      .toBe(true)
    expect(grossFundingSats).toBe(1_113)
    expect(control().snapshot()).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 0,
      outgoingPaymentCount: 0,
      debitedSats: 0,
    })
    expect(lnurl.snapshot().metadataRequests).toBeGreaterThanOrEqual(2)
    expect(lnurl.snapshot().invoicesIssued).toBe(0)

    stage = "inline price and authorization without a popup"
    const external = page.getByRole("button", {
      name: "Use external wallet",
      exact: true,
    })
    const confirmation = page.getByRole("alertdialog", {
      name: "Approve automatic checkout payments?",
      exact: true,
    })
    await expect(confirmation).toBeHidden()
    const paymentPlan = page.getByRole("region", {
      name: "Order price",
      exact: true,
    })
    await expect(
      paymentPlan.getByText("Order total", { exact: true })
    ).toBeVisible()
    await expect(paymentPlan.getByText("₿1,113", { exact: true })).toBeVisible()
    await expect(
      paymentPlan.getByText("Item subtotal", { exact: true })
    ).toBeVisible()
    await expect(
      paymentPlan.getByText("Shipping subtotal", { exact: true })
    ).toBeVisible()
    await expect(
      paymentPlan.getByText("Coordination fee", { exact: false })
    ).toBeVisible()
    await expect(
      paymentPlan.getByText("111-sat minimum + network estimate", {
        exact: true,
      })
    ).toBeVisible()
    await expect(
      paymentPlan.getByText(/sats base share$/, { exact: false })
    ).toHaveCount(0)
    await expect(paymentPlan.getByText(/\bweight\b/)).toHaveCount(0)
    await expect(page.getByText(supplierAddress, { exact: false })).toHaveCount(
      0
    )
    await expect(page.getByText(/Current payout details/)).toHaveCount(0)
    await expect(page.locator("vite-error-overlay")).toHaveCount(0)
    // Capture only the identity-free payment panel, never order contents,
    // actor identifiers, recovery material, or a revealed funding invoice.
    const paymentPanel = paymentPlan.locator("xpath=ancestor::section[1]")
    await expect(paymentPanel).toHaveCount(1)
    await paymentPanel.screenshot({
      path: test.info().outputPath("buyer-inline-desktop.png"),
      style: "header { visibility: hidden !important; }",
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await external.scrollIntoViewIfNeeded()
    await expect(external).toBeInViewport()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
    await paymentPanel.screenshot({
      path: test.info().outputPath("buyer-inline-mobile.png"),
      style: "header { visibility: hidden !important; }",
    })
    await page.setViewportSize({ width: 1280, height: 720 })
    const beforeConsent = control().snapshot()
    await expect(
      page.getByText(/Pay this invoice only once from your external wallet/)
    ).toHaveCount(0)
    expect(control().snapshot()).toEqual(beforeConsent)
    expect(lnurl.snapshot().invoicesIssued).toBe(0)

    stage = "single consent for external funding and automatic routing"
    await external.click()
    await expect(confirmation).toBeHidden()
    await expect(
      page.getByText(/Pay this invoice only once from your external wallet/)
    ).toBeVisible({ timeout: 30_000 })
    if (continuation !== "buyer") {
      const partialRecovery = continuation === "partial-cold-merchant"
      if (partialRecovery) {
        stage = "buyer completes commerce before disappearing"
        control().completeFunding()
        await expect
          .poll(() => conduitInvoiceHeld, { timeout: 45_000 })
          .toBe(true)
        expect(control().snapshot().sendInvocationCount).toBe(2)
        expect(control().snapshot().outgoingPaymentCount).toBe(2)
      }
      stage = partialRecovery
        ? "buyer disappears after commerce and before the remaining payment"
        : "buyer disappears before any payout preparation"
      const orderId = new URL(page.url()).searchParams.get("order")
      expect(typeof orderId === "string" && orderId.length > 0).toBe(true)
      beginNetworkTeardown.get(buyerContext)?.()
      beginNetworkTeardown.get(merchantContext)?.()
      await buyerContext.close()
      await merchantContext.close()
      if (partialRecovery) {
        releaseConduitInvoice()
        // The interrupted request is not a saved payout intent. Hold the new
        // Merchant request separately, without changing any signed plan/ID.
        conduitInvoiceHeld = false
        holdConduitInvoice = true
        conduitInvoiceGate = new Promise<void>((resolve) => {
          resolveConduitInvoice = resolve
        })
      } else {
        control().completeFunding()
        expect(lnurl.snapshot().invoicesIssued).toBe(0)
        expect(control().snapshot().outgoingPaymentCount).toBe(0)
      }

      // A fresh browser has no buyer or former Merchant IndexedDB/session state.
      // Recovery must come from the real signed private order/inbox messages.
      stage = "cold Merchant discovers the signed recovery"
      const coldContext = await browser.newContext({ serviceWorkers: "block" })
      contexts.push(coldContext)
      await coldContext.grantPermissions(["local-network-access"], {
        origin: merchantUrl,
      })
      beginNetworkTeardown.set(
        coldContext,
        await installHermeticCommerceNetwork(coldContext, {
          ...networkOptions,
          lnurl: lnurl.respond,
        })
      )
      await installHermeticSparkTransport(coldContext, transport, {
        appUrl: merchantUrl,
      })
      const coldPage = await coldContext.newPage()
      const coldPersistence = installPersistenceReloadBarrier(
        coldPage,
        merchantUrl
      )
      await coldPage.clock.install({ time: new Date(sharedClock.nowMs()) })
      await installRealTestSigner(coldPage, merchant, TEST_RELAY_URL)
      await coldPage.goto(`${merchantUrl}/orders?order=${orderId}`)
      const recovery = coldPage.getByRole("region", {
        name: "Order payment",
        exact: true,
      })
      const recoveredOrder = recovery
      await expect(recoveredOrder).toBeVisible({ timeout: 45_000 })
      stage = "Merchant order sorting keeps the selected payment target stable"
      const sort = coldPage.getByRole("combobox", {
        name: "Sort orders",
        exact: true,
      })
      await expect(sort).toHaveText("Newest orders")
      const selectedUrl = coldPage.url()
      for (const label of [
        "Recently updated",
        "Needs attention — oldest first",
        "Newest orders",
      ]) {
        await sort.click()
        await coldPage.getByRole("option", { name: label, exact: true }).click()
        await expect(sort).toHaveText(label)
        await expect(recoveredOrder).toBeVisible()
        expect(coldPage.url() === selectedUrl).toBe(true)
      }
      stage = "cold Merchant respects the frozen shopper handoff"
      await expect(
        recovery.getByRole("button", {
          name: "Pause",
          exact: true,
        })
      ).toBeVisible()
      const beforeHandoff = control().snapshot()
      expect(beforeHandoff.sendInvocationCount).toBe(partialRecovery ? 2 : 0)
      await recovery.getByRole("button", { name: "Pause", exact: true }).click()
      await expect(
        recovery.getByRole("button", {
          name: "Resume payment processing",
          exact: true,
        })
      ).toBeVisible()

      // Move only the isolated clock, not the application's frozen plan,
      // takeover gate or persisted proof. Newly issued fixture invoices use
      // the same time so their actual signed expiry remains meaningful. Reopen
      // after the Date jump instead of firing every in-flight network timeout
      // with fastForward; the worker's real handoff scheduling has unit coverage.
      stage =
        "cold Merchant automatically continues after handoff without a prompt"
      const resumedClockTime = sharedClock.advanceBy(46 * 60_000)
      stage = "cold Merchant browser clock follows the isolated clock advance"
      await coldPage.clock.setSystemTime(resumedClockTime)
      stage = "cold Merchant stays paused across the isolated clock advance"
      await expect(
        recovery.getByRole("button", {
          name: "Resume payment processing",
          exact: true,
        })
      ).toBeVisible()
      stage = "cold Merchant has no sends before reopening"
      expect(control().snapshot()).toEqual(beforeHandoff)
      stage = "cold Merchant reload navigation completes"
      try {
        await coldPersistence.reload()
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === "Persistence reload local request failed.") {
            stage = "cold Merchant reload rejected a failed local request"
          } else if (
            error.message === "Persistence reload work did not settle."
          ) {
            stage = "cold Merchant reload rejected pending local work"
          } else if (
            error.message === "Persistence reload barrier was disposed."
          ) {
            stage = "cold Merchant reload rejected a disposed barrier"
          } else if (error.name === "TimeoutError") {
            stage = "cold Merchant reload navigation timed out"
          }
        }
        throw error
      }
      stage = "cold Merchant enables automatic recovery on reopening"
      await expect(
        recovery.getByRole("button", {
          name: "Pause",
          exact: true,
        })
      ).toBeVisible({ timeout: 30_000 })
      stage = "cold Merchant prepares the remaining invoice"
      await expect
        .poll(() => conduitInvoiceHeld, { timeout: 75_000 })
        .toBe(true)
      if (partialRecovery) {
        await expect(
          recoveredOrder.getByText("Payment needs attention", { exact: true })
        ).toBeVisible({ timeout: 30_000 })
      } else {
        await expect(
          recoveredOrder.getByText("Payment verified", {
            exact: true,
          })
        ).toBeVisible({ timeout: 30_000 })
      }
      expect(control().snapshot()).toEqual({
        fundingInvoiceCount: 1,
        sendInvocationCount: 2,
        outgoingPaymentCount: 2,
        debitedSats: 1_002,
      })

      stage = "cold Merchant preserves recovery while residual funds remain"
      if (!partialRecovery) control().setAdditionalOwnedSats(1)
      releaseConduitInvoice()
      stage = "cold Merchant finishes the remaining payment without replay"
      await expect
        .poll(() => control().snapshot().outgoingPaymentCount, {
          timeout: 75_000,
        })
        .toBe(3)
      stage = "cold Merchant retains accurate recovery verification status"
      await expect(
        recovery.getByRole("heading", {
          name: partialRecovery
            ? "Payment needs attention"
            : "Payment verified",
          exact: true,
        })
      ).toBeVisible({ timeout: 30_000 })
      expect(await merchantWalletState(coldPage, orderId)).toBe("active")
      if (!partialRecovery) {
        await expect(
          recovery.getByText("Payment details", { exact: true })
        ).toHaveCount(0)
        await expect(
          recovery.getByRole("button", {
            name: "Verify recovery key",
            exact: true,
          })
        ).toHaveCount(0)
      }
      stage =
        "cold Merchant payments match the frozen destinations and allocations"
      const expected = [
        { lud16: merchantAddress, amountSats: 751 },
        { lud16: supplierAddress, amountSats: 249 },
        { lud16: CONDUIT_CHECKOUT_LOCAL_CANARY_FEE_RECIPIENT, amountSats: 110 },
      ]
      const sent = control().outgoingInvoices()
      expect(
        sent.length === expected.length &&
          sent.every((invoice, index) => {
            const actual = issued.get(invoice)
            return (
              actual?.lud16 === expected[index]!.lud16 &&
              actual.amountSats === expected[index]!.amountSats &&
              actual.feeSats === 1
            )
          })
      ).toBe(true)
      expect(control().snapshot().debitedSats).toBe(1_113)
      stage = "Merchant sends only the verified supplier's private notification"
      if (partialRecovery) {
        expect(await supplierNoticeCount()).toBe(0)
      } else {
        await expect.poll(supplierNoticeCount, { timeout: 30_000 }).toBe(1)
      }

      if (partialRecovery) {
        // Provider evidence prevents replay, but a new device cannot invent the
        // buyer's local invoice-origin proof. Keep recovery, never claim full
        // recipient verification or retire it from a zero balance alone.
        stage =
          "cold Merchant never replays prior payments or invents recipient proof"
        const completed = control().snapshot()
        await coldPersistence.reload()
        await expect(
          recovery.getByRole("heading", {
            name: "Payment needs attention",
            exact: true,
          })
        ).toBeVisible({ timeout: 45_000 })
        await expect(
          recoveredOrder.getByText("Payment verified", {
            exact: true,
          })
        ).toHaveCount(0)
        expect(await merchantWalletState(coldPage, orderId)).toBe("active")
        expect(control().snapshot()).toEqual(completed)
        expect(completed.sendInvocationCount).toBe(3)
        stage = "recovery access check reports success without moving funds"
        await recovery.getByText("Payment details", { exact: true }).click()
        await recovery
          .getByRole("button", { name: "Check recovery access", exact: true })
          .click()
        await expect(
          recovery.getByText(
            "Recovery access confirmed for this order. Automatic payments are paused. This check did not inspect funds or recipient payments, reveal the recovery phrase, or move money.",
            { exact: true }
          )
        ).toBeVisible()
        await expect(
          recovery.getByRole("button", {
            name: "Resume payment processing",
            exact: true,
          })
        ).toBeVisible()
        expect(control().snapshot()).toEqual(completed)
        expect(
          (await readTestRelayEvents({ kinds: [9_734, 9_735] })).length
        ).toBe(0)
        return
      }

      stage = "cold Merchant retires only after fresh terminal zero evidence"
      control().setAdditionalOwnedSats(0)
      await coldPersistence.reload()
      await expect
        .poll(() => merchantWalletState(coldPage, orderId), { timeout: 45_000 })
        .toBe("retired")
      const completed = control().snapshot()
      stage =
        "cold Merchant reload automatically checks without replaying payouts"
      await coldPersistence.reload()
      await expect(
        recoveredOrder.getByText("Payment verified", { exact: true })
      ).toBeVisible({ timeout: 30_000 })
      // The order row can be visible before the worker loads the persisted
      // retirement tombstone. Wait for that read, not merely a mounted row.
      await expect
        .poll(() => merchantWalletState(coldPage, orderId), { timeout: 45_000 })
        .toBe("retired")
      expect(control().snapshot()).toEqual(completed)
      expect(completed.sendInvocationCount).toBe(3)
      expect(await supplierNoticeCount()).toBe(1)
      expect(
        (await readTestRelayEvents({ kinds: [9_734, 9_735] })).length
      ).toBe(0)
      return
    }
    stage = "external QR remains mounted during funding polls"
    await page
      .getByRole("button", { name: "Show QR code", exact: true })
      .click()
    const qr = page.locator('svg:has(> title:text-is("Lightning invoice"))')
    await expect(qr).toBeVisible()
    const observationsBeforeQr = fundingObservations
    // Observe only visibility of this public-labelled surface, never invoice
    // content. A refetch must not unmount an already-open payment QR.
    const qrStayedVisible = await qr.evaluate(
      (element) =>
        new Promise<boolean>((resolve) => {
          let remained = true
          const inspect = () => {
            const bounds = element.getBoundingClientRect()
            remained &&=
              element.isConnected && bounds.width > 0 && bounds.height > 0
          }
          const observer = new MutationObserver(inspect)
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style", "hidden"],
          })
          const interval = window.setInterval(inspect, 50)
          window.setTimeout(() => {
            inspect()
            window.clearInterval(interval)
            observer.disconnect()
            resolve(remained)
          }, 5_200)
        })
    )
    expect(qrStayedVisible).toBe(true)
    expect(fundingObservations - observationsBeforeQr).toBeGreaterThanOrEqual(2)
    await expect(qr).toBeVisible()
    expect(control().snapshot().outgoingPaymentCount).toBe(0)
    // Simulate only the external provider settlement. The application must read
    // native receive/transfer history and derive its own exact credit proof.
    control().completeFunding()

    stage = "automatic commerce payouts before held Conduit response"
    await expect.poll(() => conduitInvoiceHeld, { timeout: 45_000 }).toBe(true)
    await expect(
      page.getByText("Completing payment", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    const processing = page.getByRole("progressbar", {
      name: "Completing your payment…",
      exact: true,
    })
    await expect(processing).toBeVisible()
    await expect(processing).not.toHaveAttribute("aria-valuenow")
    await expect(
      page.getByText("Completing your payment…", { exact: true })
    ).toBeVisible()
    await expect(
      page.getByText(/Preparing the next payment|Sending and verifying payment/)
    ).toHaveCount(0)
    const playfulLine = processing
      .locator("..")
      .locator('p[aria-hidden="true"]')
    const firstLine = await playfulLine.textContent()
    await expect
      .poll(() => playfulLine.textContent(), { timeout: 8_000 })
      .not.toBe(firstLine)
    await expect(
      page.getByText("Order payment verified", { exact: true }).first()
    ).toBeVisible({ timeout: 30_000 })
    expect(control().snapshot()).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 2,
      outgoingPaymentCount: 2,
      debitedSats: 1_002,
    })
    await expect(confirmation).toBeHidden()

    stage = "partial payout receipt preserves pending fee"
    const partialReceipt = page.getByRole("region", {
      name: "Payment history",
      includeHidden: true,
    })
    await expect(partialReceipt).toBeHidden()
    await page
      .locator("details")
      .filter({ has: partialReceipt })
      .locator("summary")
      .click()
    await expect(partialReceipt).toBeVisible()
    await expect(
      partialReceipt.getByText("Payments are still being completed.", {
        exact: true,
      })
    ).toBeVisible()
    await expect(
      partialReceipt.getByText("Unspent from recorded checkout credit", {
        exact: true,
      })
    ).toHaveCount(0)

    if (fulfillment === "pickup") {
      stage = "pause before Conduit invoice response returns"
      await page
        .getByRole("button", { name: "Pause payment", exact: true })
        .click()
      releaseConduitInvoice()
      await expect(
        page.getByText(/Payment paused\. Resume checks its saved status/)
      ).toBeVisible({ timeout: 30_000 })
      const paused = control().snapshot()
      expect(paused.sendInvocationCount).toBe(2)
      expect(paused.outgoingPaymentCount).toBe(2)
      const resume = page.getByRole("button", {
        name: "Resume payment",
        exact: true,
      })
      await expect(resume).toBeEnabled()
      stage = "paused render cannot authorize another send"
      await expect(confirmation).toBeHidden()
      expect(control().snapshot()).toEqual(paused)
      stage = "explicitly resume saved automatic payments"
      await resume.click()
      await expect(confirmation).toBeHidden()
    } else {
      // This case completes all three recipients from its one approved consent.
      releaseConduitInvoice()
    }

    await expect
      .poll(() => control().snapshot().outgoingPaymentCount, {
        timeout: 30_000,
      })
      .toBe(3)
    await expect(
      page.getByText("Payment recorded", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    stage = "terminal buyer reconciliation without replay"
    await expect(
      page.getByText(
        /Your payment is recorded\. Delivery confirmation is separate/
      )
    ).toBeVisible()
    const settled = control().snapshot()
    expect(settled).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 3,
      outgoingPaymentCount: 3,
      debitedSats: 1_113,
    })
    const expectedPayouts = [
      { lud16: merchantAddress, amountSats: 751, feeSats: 1 },
      { lud16: supplierAddress, amountSats: 249, feeSats: 1 },
      {
        lud16: CONDUIT_CHECKOUT_LOCAL_CANARY_FEE_RECIPIENT,
        amountSats: 110,
        feeSats: 1,
      },
    ]
    const receipt = page.getByRole("region", {
      name: "Payment history",
      includeHidden: true,
    })
    async function assertRecordedReceipt(): Promise<void> {
      if (!(await receipt.isVisible())) {
        await page
          .locator("details")
          .filter({ has: receipt })
          .locator("summary")
          .click()
      }
      await expect(receipt).toBeVisible()
      await expect(
        receipt.getByText("1,110 sats", { exact: true })
      ).toBeVisible()
      await expect(
        receipt.getByText("All checkout payments verified.", { exact: true })
      ).toBeVisible()
      await expect(receipt.getByRole("region", { name: /payout/ })).toHaveCount(
        0
      )
      await expect(receipt.getByText(/Supplier|Allocation/)).toHaveCount(0)
      await expect(receipt.getByText("3 sats", { exact: true })).toBeVisible()
      await expect(receipt.getByText("0 sats", { exact: true })).toBeVisible()
      await expect(receipt.getByText(/not a live wallet balance/)).toBeVisible()
      await expect(receipt.getByRole("button")).toHaveCount(0)
    }
    stage = "actual payout receipt uses provider fees"
    await assertRecordedReceipt()
    const sent = control().outgoingInvoices()
    // Compare native-executed invoices, not all fee-fitting callback attempts.
    // Emit only a boolean, never invoice bytes or endpoint identities.
    expect(
      sent.length === expectedPayouts.length &&
        sent.every((invoice, index) => {
          const actual = issued.get(invoice)
          const expected = expectedPayouts[index]!
          return (
            actual?.lud16 === expected.lud16 &&
            actual.amountSats === expected.amountSats &&
            actual.feeSats === expected.feeSats
          )
        })
    ).toBe(true)
    const refresh = page.getByRole("button", {
      name: "Refresh saved status",
      exact: true,
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await refresh.click()
      await expect(refresh).toBeEnabled()
      await expect(
        page.getByText("Payment recorded", { exact: true })
      ).toBeVisible()
      // Provider idempotency must not hide a repeated application send call.
      expect(control().snapshot().sendInvocationCount).toBe(
        settled.sendInvocationCount
      )
      expect(control().snapshot()).toEqual(settled)
    }

    stage = "explicit buyer cleanup retains residual recovery"
    const cleanup = page.getByRole("button", {
      name: "Check wallet cleanup",
      exact: true,
    })
    await page.getByText("Checkout recovery details", { exact: true }).click()
    await expect(cleanup).toBeEnabled()
    // The runner changes only native owned-funds evidence. It cannot manufacture
    // an application retirement proof or change the persisted checkout state.
    control().setAdditionalOwnedSats(1)
    await cleanup.click()
    await expect(
      page.getByText(
        "Wallet cleanup is still pending. Saved recovery remains available.",
        { exact: true }
      )
    ).toBeVisible()
    await expect(cleanup).toBeEnabled()
    await expect(
      page.getByText("Payment complete", { exact: true })
    ).toHaveCount(0)
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(cleanup).toBeEnabled()
    await expect(
      page.getByText("Payment recorded", { exact: true })
    ).toBeVisible()
    expect(control().snapshot()).toEqual(settled)

    // Historical accounting must not claim fresh wallet balance: the extra
    // native owned-funds observation changes cleanup, not recorded debit totals.
    stage = "recorded receipt remains historical with additional owned funds"
    await assertRecordedReceipt()

    stage = "explicit buyer cleanup verifies terminal zero funds"
    control().setAdditionalOwnedSats(0)
    await cleanup.click()
    await expect(
      page.getByText("Payment complete", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    expect(control().snapshot()).toEqual(settled)
    stage = "retired buyer order survives reload without replay"
    await buyerPersistence.reload()
    await expect(
      page.getByText("Payment complete", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByText("Order payment verified", { exact: true }).first()
    ).toBeVisible()
    stage = "retired payout receipt survives reload"
    await assertRecordedReceipt()
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(
      page.getByText("Payment complete", { exact: true })
    ).toBeVisible()
    expect(control().snapshot().sendInvocationCount).toBe(
      settled.sendInvocationCount
    )
    expect(control().snapshot()).toEqual(settled)
    // Supplier allocation tags are not public zaps. No public zap request or
    // receipt should be emitted by this private router scenario.
    expect((await readTestRelayEvents({ kinds: [9_734, 9_735] })).length).toBe(
      0
    )
    // This buyer-led case is not evidence for cold Merchant takeover, browser
    // suspension, real provider fees, or production funded settlement.
  } catch {
    // Never serialize underlying assertions, DOM, invoices or generated keys.
    throw new Error(`Isolated router smoke failed during ${stage}.`)
  } finally {
    // Fixed authored phase only; no error, DOM, invoice or identity content.
    // The ordinary privacy-safe reporter deliberately omits annotations.
    test.info().annotations.push({ type: "router-phase", description: stage })
    // End owned network work before releasing held fixture responses. This is
    // teardown only, never permission to hide failures during assertions.
    for (const beginTeardown of beginNetworkTeardown.values()) beginTeardown()
    releaseConduitInvoice()
    await Promise.allSettled(
      contexts.map(async (context) => {
        try {
          // Keep the fixture isolated while draining route.fetch/response
          // cleanup; closing first can race a still-running dispose call.
          await context.setOffline(true)
          await context.unrouteAll({ behavior: "wait" })
        } finally {
          await context.close()
        }
      })
    )
    sharedClock.reset()
    await transport.close()
    for (const actor of [merchant, buyer, supplier])
      disposeRuntimeSignerIdentity(actor)
  }
}

test("native router funding settles merchant, supplier and fee then retires without duplicate payouts @commerce", async ({
  browser,
}) => rehearseRouter(browser, "digital"))

test("native router merchant-handoff pickup settles merchant, supplier and fee then retires without duplicate payouts @commerce", async ({
  browser,
}) => rehearseRouter(browser, "pickup"))

test("native router cold Merchant restores a funded checkout and finishes all payouts without the buyer @commerce", async ({
  browser,
}) => rehearseRouter(browser, "digital", "cold-merchant"))

test("native router cold Merchant finishes a partial checkout without replaying paid commerce or inventing recipient proof @commerce", async ({
  browser,
}) => rehearseRouter(browser, "digital", "partial-cold-merchant"))
