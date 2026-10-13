import { openWalletSetup } from "./helpers/wallet-fixture"
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test"
import { nip19 } from "nostr-tools"
import { verifyEvent } from "nostr-tools/pure"

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
  countDistinctMatchingRuntimePrivateWraps,
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  parseCanonicalRuntimePrivateRumor,
  readAuthenticatedGiftWraps,
  signRuntimeTestEvent,
  type RuntimeSignerIdentity,
} from "./helpers/real-nip07-signer"
import { inspectCommerceUi } from "./helpers/shared-ui-evidence"
import { prepareEmptyMerchantCatalog } from "./helpers/merchant-catalog"
import {
  recordSmokeDiagnostic,
  type CommerceJourneyPhase,
} from "./helpers/smoke-diagnostics"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
const merchantUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
}`
const merchantName = "Hermetic Merchant"
const merchantLud16 = "merchant@commerce-smoke.invalid"
const productImageUrl = "https://cdn.conduit.market/commerce-smoke-product.svg"

test.use({ screenshot: "off", trace: "off", video: "off" })

type BuyerLifecycleCompletion = {
  lifecycleFound: boolean
  paymentPaid: boolean
  proofSent: boolean
}

async function readBuyerLifecycleCompletion(
  page: Page,
  orderId: string
): Promise<BuyerLifecycleCompletion> {
  return page.evaluate(async (expectedOrderId) => {
    const incomplete: BuyerLifecycleCompletion = {
      lifecycleFound: false,
      paymentPaid: false,
      proofSent: false,
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(new Error("The buyer lifecycle database could not be opened."))
    })

    try {
      if (!database.objectStoreNames.contains("orderLifecycles")) {
        return incomplete
      }
      const lifecycle = await new Promise<
        { paymentStatus?: unknown; proofDeliveryStatus?: unknown } | undefined
      >((resolve, reject) => {
        const request = database
          .transaction("orderLifecycles", "readonly")
          .objectStore("orderLifecycles")
          .get(expectedOrderId)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () =>
          reject(new Error("The buyer lifecycle status could not be read."))
      })

      return {
        lifecycleFound: lifecycle !== undefined,
        paymentPaid: lifecycle?.paymentStatus === "paid",
        proofSent: lifecycle?.proofDeliveryStatus === "sent",
      }
    } finally {
      database.close()
    }
  }, orderId)
}

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

async function privateRumorCount(input: {
  orderId: string
  recipient: RuntimeSignerIdentity
  sender: RuntimeSignerIdentity
  status?: string
  type: string
  wrapperKeyAssignments: Map<string, string>
}): Promise<number> {
  const wraps = await readAuthenticatedGiftWraps(
    input.recipient,
    TEST_RELAY_URL
  )
  const observations: Array<{
    rumor: ReturnType<typeof parseCanonicalRuntimePrivateRumor>
    wrapId: string
  }> = []

  for (const wrap of wraps) {
    const rumor = parseCanonicalRuntimePrivateRumor({
      inboxOwner: input.recipient,
      recipient: input.recipient,
      sender: input.sender,
      wrapperKeyAssignments: input.wrapperKeyAssignments,
      wrap,
    })
    observations.push({ rumor, wrapId: wrap.id })
  }

  return countDistinctMatchingRuntimePrivateWraps({
    observations,
    orderId: input.orderId,
    status: input.status,
    type: input.type,
  })
}

async function privateRumorDiagnostics(input: {
  orderId: string
  recipient: RuntimeSignerIdentity
  sender: RuntimeSignerIdentity
  status?: string
  type: string
  wrapperKeyAssignments: Map<string, string>
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
    const rumor = parseCanonicalRuntimePrivateRumor({
      inboxOwner: input.recipient,
      recipient: input.recipient,
      sender: input.sender,
      wrapperKeyAssignments: input.wrapperKeyAssignments,
      wrap,
    })
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
  wrapperKeyAssignments: Map<string, string>
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

async function expectPrivateInvoiceHasNoWalletRouting(
  input: Parameters<typeof waitForPrivateRumor>[0]
): Promise<void> {
  const wraps = await readAuthenticatedGiftWraps(
    input.recipient,
    TEST_RELAY_URL
  )
  let matched = 0
  let exposed = 0
  for (const wrap of wraps) {
    const rumor = parseCanonicalRuntimePrivateRumor({
      ...input,
      inboxOwner: input.recipient,
      wrap,
    })
    if (
      !rumor ||
      !rumor.tags.some(
        ([name, value]) => name === "type" && value === "payment_request"
      ) ||
      !rumor.tags.some(
        ([name, value]) => name === "order" && value === input.orderId
      )
    )
      continue
    matched += 1
    const payload = JSON.parse(rumor.content) as Record<string, unknown>
    if (
      [
        "receivingWallet",
        "walletId",
        "providerId",
        "network",
        "requestId",
      ].some((key) => Object.hasOwn(payload, key))
    )
      exposed += 1
  }
  // Keep decrypted content and local routing identifiers out of test diagnostics.
  expect({ received: matched > 0, exposedRoutingFields: exposed }).toEqual({
    received: true,
    exposedRoutingFields: 0,
  })
}

async function publishProduct(
  page: Page,
  title: string,
  testInfo: TestInfo
): Promise<void> {
  const trigger = await prepareEmptyMerchantCatalog(
    page,
    `${merchantUrl}/products`
  )
  // Record event delivery and mount state, never fixture/account contents.
  const diagnosticHandle = await trigger.evaluateHandle((element) => {
    const observations = {
      pointerDownOnTrigger: false,
      pointerUpOnTrigger: false,
      clickOnTrigger: false,
      dialogMounted: false,
      dialogRemoved: false,
      fontsAtClick: "unknown",
      triggerStartY: element.getBoundingClientRect().y,
      triggerDownY: 0,
      triggerUpY: 0,
    }
    const listeners = ["pointerdown", "pointerup", "click"].map((type) => {
      const listener = (event: Event) => {
        const onTrigger =
          event.target instanceof Node && element.contains(event.target)
        if (type === "pointerdown") {
          observations.pointerDownOnTrigger = onTrigger
          observations.triggerDownY = element.getBoundingClientRect().y
        }
        if (type === "pointerup") {
          observations.pointerUpOnTrigger = onTrigger
          observations.triggerUpY = element.getBoundingClientRect().y
        }
        if (type === "click") {
          observations.clickOnTrigger = onTrigger
          observations.fontsAtClick = document.fonts.status
        }
      }
      document.addEventListener(type, listener, true)
      return { type, listener }
    })
    const containsDialog = (node: Node) =>
      node instanceof Element &&
      (node.matches('[role="dialog"]') ||
        !!node.querySelector('[role="dialog"]'))
    const observer = new MutationObserver((changes) => {
      for (const change of changes) {
        if ([...change.addedNodes].some(containsDialog))
          observations.dialogMounted = true
        if ([...change.removedNodes].some(containsDialog))
          observations.dialogRemoved = true
      }
    })
    observer.observe(document, { childList: true, subtree: true })
    return {
      read() {
        const rect = element.getBoundingClientRect()
        return {
          ...observations,
          dialogPresent: !!document.querySelector('[role="dialog"]'),
          triggerEnabled:
            element.isConnected && !element.hasAttribute("disabled"),
          triggerX: rect.x,
          triggerY: rect.y,
          triggerWidth: rect.width,
          triggerHeight: rect.height,
        }
      },
      dispose() {
        observer.disconnect()
        for (const { type, listener } of listeners)
          document.removeEventListener(type, listener, true)
      },
    }
  })
  const dialog = page.getByRole("dialog", { name: "Add product" })
  try {
    await trigger.click()
    await expect(dialog).toBeVisible()
  } catch (error) {
    recordSmokeDiagnostic(
      testInfo,
      "product-dialog-open",
      await diagnosticHandle.evaluate((probe) => probe.read())
    )
    throw error
  } finally {
    await diagnosticHandle.evaluate((probe) => probe.dispose())
    await diagnosticHandle.dispose()
  }
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
  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await dialog.getByLabel("Primary image URL").fill(productImageUrl)
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

test("public identity keeps self actions and legacy links usable @commerce", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const viewer = createRuntimeSignerIdentity()
  const other = createRuntimeSignerIdentity()
  try {
    await seedPublicIdentity(viewer, { name: "Identity Viewer" })
    await seedPublicIdentity(other, { name: "Other Identity" })
    await installRealTestSigner(page, viewer, TEST_RELAY_URL)
    const viewerNpub = nip19.npubEncode(viewer.pubkey)
    const otherNpub = nip19.npubEncode(other.pubkey)

    await page.goto(`${marketUrl}/${viewerNpub}`)
    await expect(
      page.getByRole("heading", { name: "Identity Viewer", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Follow Identity Viewer", exact: true })
    ).toHaveCount(0)

    for (const reference of [
      other.pubkey,
      nip19.nprofileEncode({ pubkey: other.pubkey }),
    ]) {
      await page.goto(`${marketUrl}/u/${reference}`)
      await expect(page).toHaveURL(`${marketUrl}/${otherNpub}`)
      await expect(
        page.getByRole("heading", { name: "Other Identity", exact: true })
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Follow Other Identity", exact: true })
      ).toBeEnabled()
    }

    await page.goto(
      `${marketUrl}/store/${otherNpub}?q=coffee&sort=price_asc&tag=coffee`
    )
    await expect
      .poll(() => {
        const url = new URL(page.url())
        return [
          url.pathname,
          url.searchParams.get("q"),
          url.searchParams.get("sort"),
          url.searchParams.get("tag"),
        ]
      })
      .toEqual([`/${otherNpub}`, "coffee", "price_asc", '["coffee"]'])
    await expect(
      page.getByRole("textbox", { name: "Search listings", exact: true })
    ).toHaveValue("coffee")
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click()
    await expect
      .poll(() => {
        const url = new URL(page.url())
        return [
          url.pathname,
          url.searchParams.get("tab"),
          url.searchParams.get("merchant"),
        ]
      })
      .toEqual(["/messages", "dms", other.pubkey])
  } finally {
    disposeRuntimeSignerIdentity(viewer)
    disposeRuntimeSignerIdentity(other)
  }
})

test("E2E-COM-01..06 buyer and merchant settle once across reload @commerce", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const buyer = createRuntimeSignerIdentity()
  const merchant = createRuntimeSignerIdentity()
  const wrapperKeyAssignments = new Map<string, string>()
  const productTitle = `Hermetic commerce ${Date.now().toString(36)}`
  let wallet: DeterministicNwcWallet | null = null
  let foreignWallet: DeterministicNwcWallet | null = null
  let buyerContext: BrowserContext | null = null
  let merchantContext: BrowserContext | null = null

  const started = performance.now()
  let phaseStarted = started
  let currentPhase: CommerceJourneyPhase = "seed_profiles"
  let slowestPhase: CommerceJourneyPhase = currentPhase
  let slowestSeconds = 0
  let cleanupStarted = false
  let cleanupComplete = false
  let buyerPaidObservation: Record<string, number | boolean> = {}
  let foreignMenuObservation: Record<string, number | boolean> = {}
  const recordJourney = () =>
    recordSmokeDiagnostic(testInfo, "commerce-journey", {
      ...buyerPaidObservation,
      ...foreignMenuObservation,
      phase: currentPhase,
      elapsedSeconds: (performance.now() - started) / 1000,
      phaseSeconds: (performance.now() - phaseStarted) / 1000,
      slowestPhase,
      slowestSeconds,
      cleanupStarted,
      cleanupComplete,
      makeInvoice: wallet?.snapshot().counters.makeInvoice ?? 0,
      payInvoice: wallet?.snapshot().counters.payInvoice ?? 0,
      lookupInvoice: wallet?.snapshot().counters.lookupInvoice ?? 0,
      foreignMakeInvoice: foreignWallet?.snapshot().counters.makeInvoice ?? 0,
    })
  const phase = (next: CommerceJourneyPhase) => {
    const seconds = (performance.now() - phaseStarted) / 1000
    if (seconds > slowestSeconds) {
      slowestSeconds = seconds
      slowestPhase = currentPhase
    }
    currentPhase = next
    phaseStarted = performance.now()
    recordJourney()
  }

  try {
    recordJourney()
    await seedPublicIdentity(buyer, {
      display_name: "Hermetic Buyer",
      name: "hermetic-buyer",
    })
    await seedPublicIdentity(merchant, {
      display_name: merchantName,
      lud16: merchantLud16,
      name: "hermetic-merchant",
    })

    phase("start_wallets")
    wallet = createDeterministicNwcWallet({
      lud16: merchantLud16,
      relayUrl: TEST_RELAY_URL,
    })
    await wallet.start()
    foreignWallet = createDeterministicNwcWallet({
      lud16: "foreign@commerce.example",
      network: "mainnet",
      relayUrl: TEST_RELAY_URL,
    })
    await foreignWallet.start()

    phase("create_contexts")
    const contextOptions = {
      viewport: testInfo.project.use.viewport,
      isMobile: testInfo.project.use.isMobile,
      hasTouch: testInfo.project.use.hasTouch,
      userAgent: testInfo.project.use.userAgent,
    }
    buyerContext = await browser.newContext(contextOptions)
    merchantContext = await browser.newContext(contextOptions)
    await Promise.all([
      installHermeticRoutes(buyerContext),
      installHermeticRoutes(merchantContext),
    ])
    // Keep the live service outside this hermetic journey. Exercise the real
    // route and listing reads, observing whether its presence scope stays open.
    await buyerContext.route("**/src/hooks/useLivePresenceCount.ts*", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `
          export function useLivePresenceCount({ canonicalId }) {
            document.documentElement.dataset.storePresenceConnected = canonicalId ? "true" : "false"
            return canonicalId ? 2 : undefined
          }
          export function useProductLivePresenceCount() { return undefined }
        `,
      })
    )
    const buyerPage = await buyerContext.newPage()
    const merchantPage = await merchantContext.newPage()
    phase("install_signers")
    await installRealTestSigner(buyerPage, buyer, TEST_RELAY_URL)
    await installRealTestSigner(merchantPage, merchant, TEST_RELAY_URL)

    phase("buyer_inbox")
    await publishPrivateInbox(buyerPage, marketUrl, buyer)
    phase("merchant_inbox")
    await publishPrivateInbox(merchantPage, merchantUrl, merchant)

    phase("wallet_route")
    await merchantPage.goto(`${merchantUrl}/wallet`)
    await expect(
      merchantPage.getByRole("heading", { name: "Wallets", exact: true })
    ).toBeVisible()
    // Retain an older mainnet default while this app creates testnet invoices.
    phase("foreign_wallet")
    await foreignWallet.configureMerchantConnection(
      async (connectionString) => {
        phase("foreign_open_dialog")
        await openWalletSetup(merchantPage, "Connect wallet")
        phase("foreign_connection_form")
        await merchantPage
          .getByLabel("Wallet label", { exact: true })
          .fill("Foreign NWC")
        await merchantPage
          .getByLabel("NWC connection string", { exact: true })
          .fill(connectionString)
        phase("foreign_connection_submit")
        await merchantPage
          .getByRole("button", { name: "Connect", exact: true })
          .click()
      }
    )
    phase("foreign_connected")
    await expect(
      merchantPage.getByRole("heading", { name: "Foreign NWC", exact: true })
    ).toBeVisible()
    // Retain a valid older device registry with the foreign wallet first;
    // random opaque IDs must not decide whether this regression passes.
    phase("foreign_registry_order")
    const oldForeignTrigger = await merchantPage
      .getByRole("button", { name: "Manage Foreign NWC", exact: true })
      .elementHandle()
    if (!oldForeignTrigger) {
      throw new Error("Foreign wallet manage control is missing.")
    }
    const foreignRegistryState = await merchantPage.evaluate(
      async (moduleUrl) => {
        const { db } = await import(moduleUrl)
        return db.transaction(
          "rw",
          [db.wallets, db.walletCredentials],
          async () => {
            const descriptor = (await db.wallets.toArray()).find(
              (wallet: { label: string }) => wallet.label === "Foreign NWC"
            )
            const credential = await db.walletCredentials.get(descriptor.id)
            await db.wallets.delete(descriptor.id)
            await db.walletCredentials.delete(descriptor.id)
            await db.wallets.put({
              ...descriptor,
              id: "0000-foreign-network",
              createdAt: 1,
            })
            await db.walletCredentials.put({
              ...credential,
              walletId: "0000-foreign-network",
            })
            return {
              receiveCapable: descriptor.capabilities.includes("receive"),
              alreadyReceiving: descriptor.defaultIntents.includes("receive"),
            }
          }
        )
      },
      "/@fs" + process.cwd() + "/packages/core/src/index.ts"
    )
    foreignMenuObservation = {
      foreignReceiveCapable: foreignRegistryState.receiveCapable,
      foreignAlreadyReceiving: foreignRegistryState.alreadyReceiving,
    }
    phase("foreign_registry_refresh")
    await expect
      .poll(() => oldForeignTrigger.evaluate((element) => element.isConnected))
      .toBe(false)
    foreignMenuObservation.foreignRegistryRefreshObserved = true
    phase("foreign_manage")
    await merchantPage
      .getByRole("button", { name: "Manage Foreign NWC", exact: true })
      .click()
    const foreignMenuItem = merchantPage.getByRole("menuitem", {
      name: "Make default for merchant invoices",
      exact: true,
    })
    foreignMenuObservation.foreignMenuVisibleBeforeClick =
      await foreignMenuItem.isVisible()
    recordJourney()
    await expect(foreignMenuItem).toBeVisible()
    foreignMenuObservation.foreignMenuVisibleBeforeClick = true
    foreignMenuObservation.foreignMenuEnabledBeforeClick =
      await foreignMenuItem.isEnabled()
    foreignMenuObservation.foreignMenuHitTargetBeforeClick =
      await foreignMenuItem.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const target = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2
        )
        return target !== null && element.contains(target)
      })
    recordJourney()
    await foreignMenuItem.click()
    phase("foreign_default_committed")
    await merchantPage
      .getByRole("button", { name: "Manage Foreign NWC", exact: true })
      .click()
    await expect(
      merchantPage.getByText("Default for merchant invoices", { exact: true })
    ).toBeVisible()
    await merchantPage.keyboard.press("Escape")
    phase("receiving_wallet")
    await wallet.configureMerchantConnection(async (connectionString) => {
      phase("receiving_open_dialog")
      await openWalletSetup(merchantPage, "Connect wallet")
      phase("receiving_connection_form")
      await merchantPage
        .getByLabel("Wallet label", { exact: true })
        .fill("Commerce NWC")
      await merchantPage
        .getByLabel("NWC connection string", { exact: true })
        .fill(connectionString)
      phase("receiving_connection_submit")
      await merchantPage
        .getByRole("button", { name: "Connect", exact: true })
        .click()
    })
    phase("receiving_connected")
    await expect(
      merchantPage.getByText("Commerce NWC", { exact: true })
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      merchantPage.getByText("Connected via NWC", { exact: true })
    ).toHaveCount(2, { timeout: 20_000 })
    await expect(merchantPage.getByRole("article")).toHaveCount(2)
    await expect(
      merchantPage
        .getByRole("region", { name: "Nostr profile receiving address" })
        .locator("[data-wallet-address]")
    ).toHaveText(merchantLud16)
    await expect(
      merchantPage.getByText(
        "Payments are checked automatically against the original invoice in its receiving wallet.",
        { exact: false }
      )
    ).toBeVisible({ timeout: 20_000 })
    phase("receiving_manage")
    await merchantPage
      .getByRole("button", { name: "Manage Commerce NWC", exact: true })
      .click()
    phase("receiving_select_default")
    await merchantPage
      .getByRole("menuitem", {
        name: "Make default for merchant invoices",
        exact: true,
      })
      .click()
    phase("receiving_default_committed")
    await merchantPage
      .getByRole("button", { name: "Manage Commerce NWC", exact: true })
      .click()
    await expect(
      merchantPage.getByText("Default for merchant invoices", { exact: true })
    ).toBeVisible()
    await merchantPage.keyboard.press("Escape")

    phase("publish_product")
    await publishProduct(merchantPage, productTitle, testInfo)
    phase("verify_product")
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

    phase("store_discovery")
    await buyerPage.goto(`${marketUrl}/${nip19.npubEncode(buyer.pubkey)}`)
    await expect(
      buyerPage.getByRole("heading", { name: "Hermetic Buyer", exact: true })
    ).toBeVisible()
    await expect(buyerPage.locator("html")).toHaveAttribute(
      "data-store-presence-connected",
      "false"
    )
    const merchantNpub = nip19.npubEncode(merchant.pubkey)
    const presence = buyerPage.getByRole("status").filter({
      hasText: "2 visitors are browsing this merchant",
    })
    phase("filtered_store")
    await buyerPage.goto(
      `${marketUrl}/${merchantNpub}?q=no-match-for-presence-regression`
    )
    // A filtered zero count also renders while the catalog is loading. Require
    // positive catalog evidence before presence, using the same bounded product
    // discovery wait as the add-to-cart step below.
    phase("store_catalog")
    await expect(
      buyerPage.getByText("1 listings", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      buyerPage.getByText("0 listings", { exact: true })
    ).toBeVisible()
    phase("store_presence")
    await expect(presence).toBeVisible()
    phase("legacy_redirect")
    await buyerPage.goto(
      `${marketUrl}/store/${merchantNpub}?q=${encodeURIComponent(productTitle)}`
    )
    await expect
      .poll(() => {
        const url = new URL(buyerPage.url())
        return `${url.pathname}?q=${url.searchParams.get("q")}`
      })
      .toBe(`/${merchantNpub}?q=${productTitle}`)
    phase("store_ready")
    await buyerPage.goto(`${marketUrl}/${merchantNpub}`)
    await expect(
      buyerPage.getByRole("heading", { name: merchantName, exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(presence).toBeVisible()
    const search = buyerPage.getByPlaceholder("Search listings")
    phase("empty_search")
    await search.fill("no-match-for-presence-regression")
    await search.press("Enter")
    await expect(
      buyerPage.getByText("0 listings", { exact: true })
    ).toBeVisible()
    await expect(presence).toBeVisible()
    await expect(buyerPage.locator("html")).toHaveAttribute(
      "data-store-presence-connected",
      "true"
    )
    phase("product_search")
    await search.fill(productTitle)
    await search.press("Enter")
    const product = buyerPage
      .getByRole("listitem")
      .filter({ hasText: productTitle })
    await expect(product).toBeVisible({ timeout: 30_000 })
    const add = product.getByRole("button", { name: /^Add .+ to cart$/ })
    await expect(add).toBeEnabled({ timeout: 30_000 })
    phase("cart_add")
    await add.click()

    phase("checkout")
    const cartHud = buyerPage.getByRole("region", {
      name: "Cart inventory",
      exact: true,
    })
    await expect(cartHud).toBeVisible()
    // Mobile keyboard/viewport changes can collapse the dock after a search.
    // Verify the add committed, then explicitly open this purchase for checkout.
    const purchase = cartHud.getByRole("button", {
      name: new RegExp(`^${merchantName}, 1 cart item,`),
    })
    await expect(purchase).toBeVisible()
    await purchase.click()
    const checkout = cartHud.getByRole("link", {
      name: "Continue to checkout",
      exact: true,
    })
    await expect(checkout).toBeVisible()
    await checkout.click()
    await expect(
      buyerPage.getByRole("heading", { name: "Checkout", exact: true })
    ).toBeVisible({ timeout: 30_000 })
    const sendOrder = buyerPage.getByRole("button", {
      name: "Send order",
      exact: true,
    })
    await expect(sendOrder).toBeEnabled({ timeout: 30_000 })
    phase("send_order")
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

    phase("merchant_delivery")
    await waitForPrivateRumor({
      orderId,
      recipient: merchant,
      sender: buyer,
      type: "order",
      wrapperKeyAssignments,
    })

    phase("merchant_order")
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
    phase("accept_order")
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
      wrapperKeyAssignments,
    })

    phase("buyer_status")
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

    phase("generate_invoice")
    const invoiceSource = merchantPage.locator("#invoice-source")
    await expect(invoiceSource).toBeVisible({ timeout: 30_000 })
    await invoiceSource.click()
    const receivingWalletOption = merchantPage.getByRole("option", {
      name: "My receiving wallet",
      exact: true,
    })
    await expect(receivingWalletOption).toBeEnabled({ timeout: 20_000 })
    await receivingWalletOption.click()
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
    await expect
      .poll(() => ({
        active: wallet!.snapshot().counters.makeInvoice,
        foreign: foreignWallet!.snapshot().counters.makeInvoice,
      }))
      .toEqual({ active: 1, foreign: 0 })
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
    phase("invoice_delivery")
    await waitForPrivateRumor({
      orderId,
      recipient: buyer,
      sender: merchant,
      type: "payment_request",
      wrapperKeyAssignments,
    })
    await expectPrivateInvoiceHasNoWalletRouting({
      orderId,
      recipient: buyer,
      sender: merchant,
      type: "payment_request",
      wrapperKeyAssignments,
    })

    await buyerPage.goto(`${marketUrl}${buyerOrderPath}`)
    await expect(
      buyerPage.getByRole("heading", {
        name: "Pay merchant invoice",
        exact: true,
      })
    ).toBeVisible({ timeout: 30_000 })
    phase("pay_invoice")
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
    phase("payment_proof")
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
      wrapperKeyAssignments,
    })

    phase("merchant_settlement")
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
      wrapperKeyAssignments,
    })

    phase("merchant_paid")
    await merchantPage.goto(`${merchantUrl}${merchantOrderPath}`)
    const merchantProgress = merchantPage.getByRole("list", {
      name: "Order progress",
    })
    await expect(
      merchantProgress.getByText("Payment confirmed", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await inspectCommerceUi(merchantPage, testInfo, "merchant-settled")

    phase("buyer_paid")
    await buyerPage.goto(`${marketUrl}${buyerOrderPath}`)
    const openPaidMessages = async () => {
      await buyerPage.evaluate(() => document.fonts.ready)
      const trigger = buyerPage.getByRole("button", {
        name: "Open messages",
        exact: true,
      })
      if (testInfo.project.use.isMobile) await trigger.tap()
      else await trigger.click()
      await expect(
        buyerPage.getByRole("dialog", { name: "Messages", exact: true })
      ).toBeVisible()
    }
    const expectPaidMessages = async () => {
      try {
        await expect(
          buyerPage.getByText("Status: Paid", { exact: true })
        ).toBeVisible({ timeout: 30_000 })
      } catch (error) {
        try {
          const completion = await readBuyerLifecycleCompletion(
            buyerPage,
            orderId
          )
          buyerPaidObservation = {
            buyerObservationAvailable: true,
            buyerLifecyclePaid: completion.paymentPaid,
            buyerProofSent: completion.proofSent,
            buyerPaidMessages: await buyerPage
              .getByText("Status: Paid", { exact: true })
              .count(),
            buyerMessageDialogVisible: await buyerPage
              .getByRole("dialog", { name: "Messages", exact: true })
              .isVisible(),
          }
        } catch {
          // Diagnostic reads must not replace the original assertion failure.
          buyerPaidObservation = { buyerObservationAvailable: false }
        }
        recordJourney()
        throw error
      }
    }
    await openPaidMessages()
    await expectPaidMessages()

    phase("reload")
    await Promise.all([merchantPage.reload(), buyerPage.reload()])
    await expect(
      merchantPage
        .getByRole("list", { name: "Order progress" })
        .getByText("Payment confirmed", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await openPaidMessages()
    await expectPaidMessages()
    await expect
      .poll(() => readBuyerLifecycleCompletion(buyerPage, orderId), {
        timeout: 30_000,
      })
      .toEqual({
        lifecycleFound: true,
        paymentPaid: true,
        proofSent: true,
      })
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
    phase("exactly_once")
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
        wrapperKeyAssignments,
      })) === 1 &&
        (await privateRumorCount({
          orderId,
          recipient: buyer,
          sender: merchant,
          type: "payment_request",
          wrapperKeyAssignments,
        })) === 1 &&
        (await privateRumorCount({
          orderId,
          recipient: merchant,
          sender: buyer,
          type: "payment_proof",
          wrapperKeyAssignments,
        })) === 1 &&
        (await privateRumorCount({
          orderId,
          recipient: buyer,
          sender: merchant,
          status: "paid",
          type: "status_update",
          wrapperKeyAssignments,
        })) === 1
    ).toBe(true)
    expect(foreignWallet.snapshot().counters.makeInvoice).toBe(0)
    phase("complete")
  } finally {
    // Preserve the last journey phase even if cleanup follows a hard timeout.
    cleanupStarted = true
    recordJourney()
    await Promise.allSettled([
      buyerContext?.close(),
      merchantContext?.close(),
      wallet?.close(),
      foreignWallet?.close(),
    ])
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
    cleanupComplete = true
    recordJourney()
  }
})
