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
import { getEventHash, verifyEvent } from "nostr-tools/pure"
import { CANONICAL_COMMERCE_DISCOVERY_RELAYS } from "../packages/core/src/config"
import {
  decodeSparkAddress,
  DefaultSparkSigner,
  encodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
  UUID,
} from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.node.js"
import { openPlaywrightRouterClock } from "../scripts/dev/playwright_router_clock"
import {
  createRouterSmokeRecorder,
  type RouterSmokePhase,
} from "../scripts/ci/router_smoke_diagnostic"
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
  HERMETIC_NETWORK_DIAGNOSTIC_ANNOTATIONS,
  createHermeticCommerceNetworkPolicy,
  installHermeticCommerceNetwork,
  type HermeticNetworkFailureDiagnostic,
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
// Exact offline responses only. Reserved example domains are intentionally
// rejected by the real payout URL policy, so use allowed-shaped test targets.
const merchantProfileRelay = new URL(CANONICAL_COMMERCE_DISCOVERY_RELAYS[0]!)
  .href
const supplierProfileRelay = merchantProfileRelay
const treasuryIdentityPublicKey =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const networkOptions = {
  appUrls: [marketUrl, merchantUrl],
  relayUrl: TEST_RELAY_URL,
  imageUrl,
  // API-request socket pooling differs from the browser's resource transport.
  // Use fresh loopback sockets across cold/reloaded module graphs; never retry
  // a reset or suppress a current-document request failure.
  closeLocalConnections: true,
}

// Mutate only the shared module in this isolated synthetic browser. This is not
// a product switch, deployment override or authorization for an unbound plan.
async function setIsolatedRouterCapabilities(
  page: Page,
  admission: boolean,
  execution: boolean
): Promise<void> {
  const modulePath = `/@fs/${fileURLToPath(new URL("../packages/core/src/config.ts", import.meta.url)).replaceAll("\\", "/")}`
  await page.evaluate(
    async ({ modulePath, admission, execution }) => {
      const { config } = await import(/* @vite-ignore */ modulePath)
      config.quantumRouterEnabled = admission
      config.quantumRouterExecutionEnabled = execution
    },
    { modulePath, admission, execution }
  )
}

async function selectIsolatedOrder(page: Page, orderId: string): Promise<void> {
  // Exercise the actual browser-history/router selection path without a full
  // reload resetting the intentionally isolated in-memory capability matrix.
  await page.evaluate((orderId) => {
    const next = new URL(window.location.href)
    next.searchParams.set("order", orderId)
    next.searchParams.set("focus", "payment")
    window.history.pushState(null, "", next)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }, orderId)
}

async function remountIsolatedSavedOrder(page: Page): Promise<void> {
  const originalOrderId = new URL(page.url()).searchParams.get("order")
  if (!originalOrderId)
    throw new Error("The saved router order is unavailable.")
  const receipt = page.getByRole("region", {
    name: "Payment history",
    includeHidden: true,
  })
  // Compiled capabilities are immutable in a real document. Observe each
  // isolated profile on a fresh keyed OrderDetail mount, not as a reactive
  // flag API. The unknown focused order must first remove the old receipt.
  await selectIsolatedOrder(
    page,
    await page.evaluate(() => crypto.randomUUID())
  )
  await expect(receipt).toHaveCount(0)
  await selectIsolatedOrder(page, originalOrderId)
  await expect(receipt).toHaveCount(1)
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

// Observe the real repository's validated local receipt. The fixture never
// writes attribution or settlement rows, and only content-free facts leave it.
async function merchantRecordedCompletion(
  page: Page,
  merchantPubkey: string,
  orderId: string | null
) {
  const repositoryPath = `/@fs/${fileURLToPath(new URL("../packages/core/src/protocol/checkout-spark-settled-router-repository.ts", import.meta.url)).replaceAll("\\", "/")}`
  const projectionPath = `/@fs/${fileURLToPath(new URL("../packages/core/src/protocol/checkout-spark-merchant-settlement.ts", import.meta.url)).replaceAll("\\", "/")}`
  return page.evaluate(
    async ({ repositoryPath, projectionPath, merchantPubkey, orderId }) => {
      const [{ DexieCheckoutSparkSettledRepository }, projection] =
        await Promise.all([
          import(/* @vite-ignore */ repositoryPath),
          import(/* @vite-ignore */ projectionPath),
        ])
      if (!orderId) return null
      const records =
        await new DexieCheckoutSparkSettledRepository().loadMerchantOrderSettlements(
          merchantPubkey,
          [orderId]
        )
      if (records.length !== 1) return null
      const record = records[0].settlement
      return {
        ...projection.projectCheckoutSparkMerchantSettlement(record),
        creditedSats: record.credit?.creditedSats ?? null,
        paidCommerceCount: record.paidLegs.length,
        commerceDebitSats: record.paidLegs.reduce(
          (sum: number, leg: { finalDebitSats: number }) =>
            sum + leg.finalDebitSats,
          0
        ),
        nativePrincipalSats: record.nativeTreasury?.principalSats ?? null,
        nativeDebitSats: record.nativeTreasury?.finalDebitSats ?? null,
        nativeFeeSats: record.nativeTreasury?.finalFeeSats ?? null,
      }
    },
    { repositoryPath, projectionPath, merchantPubkey, orderId }
  )
}

// Admission diagnostics are booleans only. They distinguish absent local
// evidence from a projection/UI lag without importing or manufacturing proof.
async function merchantRecoveryAdmission(page: Page, orderId: string | null) {
  const modulePath = `/@fs/${fileURLToPath(new URL("../packages/core/src/db/index.ts", import.meta.url)).replaceAll("\\", "/")}`
  return page.evaluate(
    async ({ modulePath, orderId }) => {
      const { db } = await import(/* @vite-ignore */ modulePath)
      const bindings = await db.checkoutSparkPlanBindings.toArray()
      const matching = bindings.filter(
        (row: { orderWitness?: { orderId: string } }) =>
          row.orderWitness?.orderId === orderId
      )
      const binding = matching.length === 1 ? matching[0] : null
      return {
        uniqueWitness: binding !== null,
        sourcesValidated: binding?.sourceValidation != null,
        settlementPresent: binding?.merchantSettlement != null,
        creditPresent: binding?.merchantSettlement?.credit != null,
      }
    },
    { modulePath, orderId }
  )
}

// Read-only terminal-state check: receipt truth must not strand a submitted
// exact request behind the retirement gate. No provider or order data leaves
// this isolated browser; the reporter emits only the fixed assertion phase.
async function merchantTerminalReconciliation(
  page: Page,
  orderId: string | null
) {
  const modulePath = `/@fs/${fileURLToPath(new URL("../packages/core/src/db/index.ts", import.meta.url)).replaceAll("\\", "/")}`
  return page.evaluate(
    async ({ modulePath, orderId }) => {
      const { db } = await import(/* @vite-ignore */ modulePath)
      const rows = await db.checkoutSparkReconciliations.toArray()
      const matching = rows.filter(
        (row: { state: { plan: { orderId: string } } }) =>
          row.state.plan.orderId === orderId
      )
      if (matching.length !== 1) return null
      const state = matching[0].state
      return {
        treasuryPaid: state.treasuryFinalization?.status === "paid",
        allLegsPaid: state.legs.every(
          (leg: { status: string }) => leg.status === "paid"
        ),
      }
    },
    { modulePath, orderId }
  )
}

// Read only the isolated checkout's frozen clock facts. No invoice, wallet,
// identity or order content leaves the page, and this helper never alters the
// saved deadlines or produces payment authority.
async function frozenRouterTiming(page: Page, orderId: string | null) {
  const dbPath = `/@fs/${fileURLToPath(new URL("../packages/core/src/db/index.ts", import.meta.url)).replaceAll("\\", "/")}`
  const lightningPath = `/@fs/${fileURLToPath(new URL("../packages/core/src/protocol/lightning.ts", import.meta.url)).replaceAll("\\", "/")}`
  const timingPath = `/@fs/${fileURLToPath(new URL("../apps/market/src/lib/checkout-spark-local-router-canary.ts", import.meta.url)).replaceAll("\\", "/")}`
  return page.evaluate(
    async ({ dbPath, lightningPath, timingPath, orderId }) => {
      const [{ db }, { decodeLightningInvoiceMetadata }, timing] =
        await Promise.all([
          import(/* @vite-ignore */ dbPath),
          import(/* @vite-ignore */ lightningPath),
          import(/* @vite-ignore */ timingPath),
        ])
      const rows = await db.checkoutSparkReconciliations.toArray()
      const matching = rows.filter(
        (row: { state: { plan: { orderId: string } } }) =>
          row.state.plan.orderId === orderId
      )
      if (matching.length !== 1) return null
      const plan = matching[0].state.plan
      const invoice = decodeLightningInvoiceMetadata(
        plan.funding.paymentRequest
      )
      return {
        createdAt: plan.createdAt as number,
        takeoverAt: plan.takeoverAt as number,
        fundingCreatedAt: plan.funding.createdAt as number,
        fundingExpiresAt: plan.funding.expiresAt as number,
        signedFundingCreatedAt: invoice.createdAt as number | null,
        signedFundingExpiresAt: invoice.expiresAt as number | null,
        configuredTakeoverAfterMs: timing.getCheckoutSparkSettledTiming()
          .takeoverAfterMs as number,
      }
    },
    { dbPath, lightningPath, timingPath, orderId }
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
  onStage: (stage: RouterSmokePhase) => void
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
    .setChecked(true)
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
  await expect(
    dialog.getByText("Advanced profile discovery", { exact: true })
  ).toHaveCount(0)
  await expect(dialog.getByLabel("Your profile relay hint")).toHaveCount(0)
  await expect(dialog.getByLabel("Supplier 1 profile relay hint")).toHaveCount(
    0
  )
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
  continuation: "buyer" | "cold-merchant" | "partial-cold-merchant" = "buyer",
  buyerMode: "signed-in" | "guest" = "signed-in",
  receiverAdmission:
    | "supported-setup"
    | "unsupported-merchant"
    | "unsupported-supplier"
    | null = null,
  capabilityRegression = false
): Promise<void> {
  test.setTimeout(240_000)
  const phaseRecorder = createRouterSmokeRecorder(test.info().annotations)
  const sharedClock = openPlaywrightRouterClock()
  sharedClock.reset()
  const productTitle = "Isolated supplier router download"
  createHermeticCommerceNetworkPolicy(networkOptions)
  const merchant = createRuntimeSignerIdentity()
  const buyer = createRuntimeSignerIdentity()
  const supplier = createRuntimeSignerIdentity()
  // These are the legitimate original signed account profiles for admission
  // checks, not replacement invoices or alternate recipients after funding.
  const merchantAddress =
    receiverAdmission === "unsupported-merchant"
      ? "router-merchant@unsupported.wallet.conduit.market"
      : "router-merchant@wallet.conduit.market"
  const supplierAddress =
    receiverAdmission === "unsupported-supplier"
      ? "router-supplier@unsupported.wallet.conduit.market"
      : "router-supplier@wallet.conduit.market"
  let webLnSends = 0
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
        [merchantAddress, supplierAddress].some((address) =>
          rumor.content.includes(address)
        )
      )
        return -1
      rumors.add(rumor.id)
    }
    return rumors.size
  }
  const contexts: BrowserContext[] = []
  const beginNetworkTeardown = new Map<BrowserContext, () => void>()
  let recordedNetworkFailure = false
  const recordNetworkFailure = (
    diagnostic: HermeticNetworkFailureDiagnostic
  ) => {
    if (recordedNetworkFailure) return
    recordedNetworkFailure = true
    test.info().annotations.push(
      {
        type: HERMETIC_NETWORK_DIAGNOSTIC_ANNOTATIONS.operation,
        description: diagnostic.operation,
      },
      {
        type: HERMETIC_NETWORK_DIAGNOSTIC_ANNOTATIONS.source,
        description: diagnostic.source,
      },
      {
        type: HERMETIC_NETWORK_DIAGNOSTIC_ANNOTATIONS.category,
        description: diagnostic.category,
      }
    )
  }
  let identity: string | undefined
  let grossFundingSats: number | undefined
  let walletInitializations = 0
  const issued = new Map<string, HermeticLnurlIssuedInvoice>()
  const native = createHermeticSparkNative({
    encodeAddress: (identityPublicKey) =>
      encodeSparkAddress({ identityPublicKey, network: "REGTEST" }),
    nativeInvoiceCodec: {
      parseTransferId: (value) => UUID.parse(value),
      encodeSparkAddress,
      decodeSparkAddress,
      isValidSparkAddress,
      getNetworkFromSparkAddress,
    },
    async deriveIdentity(mnemonic, accountNumber) {
      walletInitializations += 1
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
      // Callback issuance may precede the funding account's creation. Preserve
      // legitimate provider records; registration itself never pays an invoice.
      for (const invoice of issued.values())
        native.control.forIdentity(identity).registerPayout(invoice)
      return fundingInvoice(request.amountSats, request.expirySeconds)
    },
  })
  const nativeTransport = createHermeticSparkTransport(native)
  let fundingObservations = 0
  let observationOpenAttempts = 0
  let observationOpenSuccesses = 0
  let nativeWalletOpenSuccesses = 0
  let completedFundingReads = 0
  const transport = {
    ...nativeTransport,
    async request(command: Parameters<typeof nativeTransport.request>[0]) {
      if (command.type === "observation.open") observationOpenAttempts += 1
      const result = await nativeTransport.request(command)
      if (command.type === "observation.open") observationOpenSuccesses += 1
      if (command.type === "wallet.open") nativeWalletOpenSuccesses += 1
      if (
        command.type === "wallet.call" &&
        command.method === "getLightningReceiveRequest"
      ) {
        fundingObservations += 1
      }
      if (
        (command.type === "wallet.call" ||
          command.type === "observation.call") &&
        command.method === "getLightningReceiveRequest" &&
        (result as { status?: unknown } | undefined)?.status ===
          "TRANSFER_COMPLETED"
      )
        completedFundingReads += 1
      return result
    },
  }
  const control = () => {
    if (!identity) throw new Error("Isolated checkout wallet was not prepared.")
    return native.control.forIdentity(identity)
  }
  const lnurl = createHermeticLnurlFixture({
    recipients: [merchantAddress, supplierAddress].map((lud16) => ({
      lud16,
    })),
    nowSeconds: () => Math.floor(sharedClock.nowMs() / 1_000),
    // Preparation reserves one sat per commerce leg. A zero final fee proves
    // the exact two-sat unused reserve is carried into the native treasury leg.
    feeSats: 0,
    verification: {
      isInvoiceSettled: (paymentRequest) =>
        identity !== undefined &&
        control().snapshot().outgoingPaymentCount ===
          control().outgoingInvoices().length &&
        control().outgoingInvoices().includes(paymentRequest),
    },
    onInvoiceIssued: async (invoice) => {
      issued.set(invoice.paymentRequest, invoice)
      if (identity !== undefined) control().registerPayout(invoice)
    },
  })
  let stage: RouterSmokePhase = "isolated setup"
  let bodyCompleted = false
  const setStage = (next: RouterSmokePhase) => {
    stage = next
    phaseRecorder.phase(next)
  }
  try {
    await seedIdentity(
      merchant,
      merchantName,
      receiverAdmission === "supported-setup" ? undefined : merchantAddress
    )
    await seedIdentity(supplier, "Isolated Router Supplier", supplierAddress)
    await seedIdentity(buyer, "Isolated Router Buyer")
    const merchantContext = await browser.newContext({
      serviceWorkers: "block",
    })
    contexts.push(merchantContext)
    await merchantContext.grantPermissions(["local-network-access"], {
      origin: merchantUrl,
    })
    const merchantNetwork = await installHermeticCommerceNetwork(
      merchantContext,
      {
        ...networkOptions,
        lnurl: lnurl.respond,
        onLocalFailure: recordNetworkFailure,
      }
    )
    beginNetworkTeardown.set(merchantContext, merchantNetwork)
    await installHermeticSparkTransport(merchantContext, transport, {
      appUrl: merchantUrl,
    })
    const merchantPage = await merchantContext.newPage()
    await installRealTestSigner(merchantPage, merchant, TEST_RELAY_URL)
    if (receiverAdmission === "supported-setup") {
      const persistence = installPersistenceReloadBarrier(
        merchantPage,
        merchantUrl,
        {
          isAbandonedCompletedRequest:
            merchantNetwork.isAbandonedCompletedRequest,
        }
      )
      setStage("Merchant setup checks a supported receiver before signing")
      await merchantPage.goto(`${merchantUrl}/payments`)
      await expect(
        merchantPage.getByRole("heading", { name: "Payments", exact: true })
      ).toBeVisible()
      await merchantPage
        .getByRole("button", { name: "Add", exact: true })
        .click()
      await merchantPage
        .getByLabel("Lightning Address", { exact: true })
        .fill(merchantAddress)
      const save = merchantPage.getByRole("button", {
        name: "Save changes",
        exact: true,
      })
      await expect(save).toBeEnabled()
      await save.click()
      await expect(
        merchantPage.getByText("Lightning Address signed and saved.", {
          exact: true,
        })
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        merchantPage.getByText("Checkout routing ready", { exact: true })
      ).toBeVisible({ timeout: 30_000 })
      setStage("Merchant setup reads back its genuine signed receiving profile")
      await expect
        .poll(async () => {
          const events = await readTestRelayEvents({
            kinds: [0],
            authors: [merchant.pubkey],
          })
          return events.some((event) => {
            if (!verifyEvent(event)) return false
            try {
              return JSON.parse(event.content).lud16 === merchantAddress
            } catch {
              return false
            }
          })
        })
        .toBe(true)
      await persistence.reload()
      await expect(
        merchantPage.getByText("Checkout routing ready", { exact: true })
      ).toBeVisible({ timeout: 30_000 })
      expect(walletInitializations).toBe(0)
      expect(identity === undefined && grossFundingSats === undefined).toBe(
        true
      )
      expect(lnurl.snapshot().invoicesIssued).toBe(0)
      expect(lnurl.verificationSnapshot().verificationRequests).toBe(0)
      expect(webLnSends).toBe(0)
      bodyCompleted = true
      return
    }
    setStage("mounted supplier listing publication")
    await publishSupplierListing(
      merchantPage,
      supplier,
      productTitle,
      (next) => {
        setStage(next)
      }
    )
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
        return matches
      })
      .toBe(true)

    const catalogPath = `/${nip19.npubEncode(merchant.pubkey)}`

    setStage("mounted buyer cart and private order")
    const buyerContext = await browser.newContext({ serviceWorkers: "block" })
    contexts.push(buyerContext)
    await buyerContext.grantPermissions(["local-network-access"], {
      origin: marketUrl,
    })
    const buyerNetwork = await installHermeticCommerceNetwork(buyerContext, {
      ...networkOptions,
      lnurl: lnurl.respond,
      onLocalFailure: recordNetworkFailure,
    })
    beginNetworkTeardown.set(buyerContext, buyerNetwork)
    await installHermeticSparkTransport(buyerContext, transport, {
      appUrl: marketUrl,
    })
    const page = await buyerContext.newPage()
    const buyerPersistence = installPersistenceReloadBarrier(page, marketUrl, {
      isAbandonedCompletedRequest: buyerNetwork.isAbandonedCompletedRequest,
    })
    if (buyerMode !== "guest")
      await installRealTestSigner(page, buyer, TEST_RELAY_URL)
    {
      // External wallet capability only. HUD intent and explicit QR approval
      // must never make this runner-owned WebLN provider send a payment.
      await page.exposeFunction("__routerWeblnSend", () => {
        webLnSends += 1
        throw new Error("Unexpected synthetic WebLN payment")
      })
      await page.addInitScript(() => {
        const runner = window as typeof window & {
          __routerWeblnSend: () => Promise<never>
        }
        window.webln = {
          async enable() {},
          async makeInvoice() {
            throw new Error("Unexpected synthetic WebLN invoice")
          },
          async sendPayment() {
            return runner.__routerWeblnSend()
          },
        }
      })
    }
    setStage("buyer catalog product load")
    await page.goto(`${marketUrl}${catalogPath}`)
    setStage("browser SDK module preload without wallet initialization")
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
    setStage("buyer catalog product visibility")
    const product = page.getByRole("listitem").filter({ hasText: productTitle })
    await expect(product).toBeVisible({ timeout: 30_000 })
    await expect(product.getByText("~ ₿1,113", { exact: true })).toBeVisible()
    await expect(product.getByText(/Estimated total/)).toBeVisible()
    setStage("buyer add product to cart")
    await product.getByRole("button", { name: "Add", exact: true }).click()
    setStage("buyer continue to checkout")
    const cart = page.getByRole("region", {
      name: "Cart inventory",
      exact: true,
    })
    await expect(
      cart.getByRole("button", { name: "Continue to Zap Out", exact: true })
    ).toHaveCount(0)
    const continueFromHud = cart.getByRole("link", {
      name: "Continue to checkout",
      exact: true,
    })
    await expect(continueFromHud).toBeVisible()
    if (buyerMode === "guest") {
      // Cover the full-cart entry point as well as the compact HUD; neither
      // may offer public Zapout for a coordinated V1 purchase.
      await cart
        .getByRole("link", { name: "View full cart", exact: true })
        .click()
      await expect(
        page.getByRole("button", { name: "Zap out", exact: true })
      ).toHaveCount(0)
      await page.getByRole("button", { name: "Order", exact: true }).click()
    } else {
      await continueFromHud.click()
    }
    await expect(
      page.getByRole("region", { name: "Payment visibility", exact: true })
    ).toHaveCount(0)
    if (buyerMode === "guest") {
      // Ordinary guest contact is private order data, entered via the real form.
      await page.locator("#ship-email").fill("guest@offline.conduit.market")
      await page.locator("#ship-phone").fill("+1 202 555 0123")
    }
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
    const approvalNote = page.getByText(
      "Your fixed total of 1,113 sats includes a best-effort 111 sats Conduit fee estimate and payment reserves; Conduit is paid last, including unused authorized reserves, with no increase to your total.",
      { exact: true }
    )
    await expect(approvalNote).toBeVisible()
    await expect(page.getByText(supplierAddress, { exact: false })).toHaveCount(
      0
    )
    setStage("buyer router prepare eligibility")
    const prepare = page.getByRole("button", {
      name: "Continue to payment",
      exact: true,
    })
    await expect(prepare).toBeEnabled({ timeout: 30_000 })
    setStage("buyer router order submission")
    await prepare.click()
    if (receiverAdmission !== null) {
      setStage(
        "unsupported required recipient blocks before wallet funding or disclosure"
      )
      await expect(
        page.getByText(
          /A required recipient's payout setup could not be verified\. No checkout wallet or order was created/
        )
      ).toBeVisible({ timeout: 45_000 })
      expect(walletInitializations).toBe(0)
      expect(identity === undefined && grossFundingSats === undefined).toBe(
        true
      )
      expect(webLnSends).toBe(0)
      expect(lnurl.snapshot().invoicesIssued).toBe(0)
      expect(lnurl.verificationSnapshot().verificationRequests).toBe(0)
      expect(new URL(page.url()).pathname).toBe("/checkout")
      await expect(
        page.getByRole("heading", { name: "Orders", exact: true })
      ).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: "Copy invoice", exact: true })
      ).toHaveCount(0)
      await expect(
        page.locator('svg:has(> title:text-is("Lightning invoice"))')
      ).toHaveCount(0)
      expect((await readTestRelayEvents({ kinds: [1059] })).length).toBe(0)
      bodyCompleted = true
      return
    }
    setStage("buyer order preparation completion")
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

    if (buyerMode === "guest") {
      const dbPath = `/@fs/${fileURLToPath(new URL("../packages/core/src/db/index.ts", import.meta.url)).replaceAll("\\", "/")}`
      const orderId = new URL(page.url()).searchParams.get("order")
      const genuinePrivateGuest = await page.evaluate(
        async ({ dbPath, orderId }) => {
          const { db } = await import(/* @vite-ignore */ dbPath)
          const order = await db.orderLifecycles.get(orderId)
          return (
            order?.buyerIdentityKind === "guest_ephemeral" &&
            order.orderRelayDelivery?.signedRecipientWrap?.kind === 1059
          )
        },
        { dbPath, orderId }
      )
      expect(genuinePrivateGuest).toBe(true)
    }

    setStage("inline price and authorization without a popup")
    const external = page.getByRole("button", {
      name: "Show QR code",
      exact: true,
    })
    await expect(external).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Open Lightning wallet", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Copy invoice", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Use external wallet", exact: true })
    ).toHaveCount(0)
    // Regtest is not a Cash App destination. Mainnet presentation is covered
    // separately without enabling any external transport in this fixture.
    await expect(
      page.getByText("Pay with Cash App", { exact: true })
    ).toHaveCount(0)
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
    ).toHaveCount(0)
    await expect(
      page.getByRole("region", {
        name: "Native Spark treasury authorization",
        exact: true,
      })
    ).toHaveCount(0)
    await expect(approvalNote).toHaveCount(0)
    await expect(
      paymentPlan.getByText(/sats base share$/, { exact: false })
    ).toHaveCount(0)
    await expect(paymentPlan.getByText(/\bweight\b/)).toHaveCount(0)
    await expect(page.getByText(supplierAddress, { exact: false })).toHaveCount(
      0
    )
    await expect(page.getByText(/Current payout details/)).toHaveCount(0)
    await expect(page.locator("vite-error-overlay")).toHaveCount(0)
    // Responsive assertions stay content-free; do not capture payment panels.
    await page.setViewportSize({ width: 390, height: 844 })
    await external.scrollIntoViewIfNeeded()
    await expect(external).toBeInViewport()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
    await page.setViewportSize({ width: 1280, height: 720 })
    const beforeConsent = control().snapshot()
    if (capabilityRegression) {
      setStage("bound buyer continues while new router admission is disabled")
      await setIsolatedRouterCapabilities(page, false, true)
    }
    await expect(
      page.getByText(/Pay once, then return here to check progress/)
    ).toHaveCount(0)
    expect(control().snapshot()).toEqual(beforeConsent)
    expect(lnurl.snapshot().invoicesIssued).toBe(0)

    setStage("single consent for external funding and automatic routing")
    await external.click()
    // Hold only the synthetic provider's final native transfer status. The
    // application still prepares, submits, persists, and later reconciles its
    // exact transfer ID through the public Spark wallet surface.
    control().setNativeCompletion(false)
    await expect(confirmation).toBeHidden()
    await expect(
      page.getByText(/Pay once, then return here to check progress/)
    ).toBeVisible({ timeout: 30_000 })
    if (continuation !== "buyer") {
      const partialRecovery = continuation === "partial-cold-merchant"
      if (partialRecovery) {
        setStage("buyer completes commerce before disappearing")
        control().completeFunding()
        await expect
          .poll(() => control().nativeSnapshot().nativePaymentCount, {
            timeout: 45_000,
          })
          .toBe(1)
        expect(control().snapshot().sendInvocationCount).toBe(2)
        expect(control().snapshot().outgoingPaymentCount).toBe(2)
      }
      setStage(
        partialRecovery
          ? "buyer disappears after commerce and before the remaining payment"
          : "buyer disappears before any payout preparation"
      )
      const orderId = new URL(page.url()).searchParams.get("order")
      expect(typeof orderId === "string" && orderId.length > 0).toBe(true)
      setStage("buyer freezes independent funding and handoff deadlines")
      const frozenTiming = await frozenRouterTiming(page, orderId)
      expect(frozenTiming !== null).toBe(true)
      expect(frozenTiming!.configuredTakeoverAfterMs).toBe(120_000)
      // The handoff starts at the original entry time. Provider invoice
      // creation happens later and is floored to seconds, so those saved times
      // do not imply an exact millisecond interval from provider creation.
      expect(
        frozenTiming!.takeoverAt - frozenTiming!.createdAt
      ).toBeGreaterThan(0)
      expect(
        frozenTiming!.takeoverAt - frozenTiming!.createdAt
      ).toBeLessThanOrEqual(120_999)
      expect(frozenTiming!.fundingCreatedAt).toBe(frozenTiming!.createdAt)
      expect(frozenTiming!.signedFundingCreatedAt !== null).toBe(true)
      expect(frozenTiming!.signedFundingExpiresAt !== null).toBe(true)
      expect(
        frozenTiming!.signedFundingExpiresAt! -
          frozenTiming!.signedFundingCreatedAt!
      ).toBe(900)
      expect(frozenTiming!.fundingCreatedAt).toBe(
        frozenTiming!.signedFundingCreatedAt! * 1_000
      )
      expect(frozenTiming!.fundingExpiresAt).toBe(
        frozenTiming!.signedFundingExpiresAt! * 1_000
      )
      expect(frozenTiming!.fundingExpiresAt).toBeGreaterThan(
        frozenTiming!.takeoverAt
      )
      beginNetworkTeardown.get(buyerContext)?.()
      beginNetworkTeardown.get(merchantContext)?.()
      await buyerContext.close()
      await merchantContext.close()
      if (!partialRecovery) {
        control().completeFunding()
        expect(lnurl.snapshot().invoicesIssued).toBe(0)
        expect(control().snapshot().outgoingPaymentCount).toBe(0)
      }

      // A fresh browser has no buyer or former Merchant IndexedDB/session state.
      // Recovery must come from the real signed private order/inbox messages.
      const verificationRequestsBeforeCold =
        lnurl.verificationSnapshot().verificationRequests
      const observationAttemptsBeforeCold = observationOpenAttempts
      const observationsBeforeCold = observationOpenSuccesses
      const nativeWalletsBeforeCold = nativeWalletOpenSuccesses
      const completedFundingBeforeCold = completedFundingReads
      setStage("cold Merchant discovers the signed recovery")
      const coldContext = await browser.newContext({ serviceWorkers: "block" })
      contexts.push(coldContext)
      await coldContext.grantPermissions(["local-network-access"], {
        origin: merchantUrl,
      })
      const coldNetwork = await installHermeticCommerceNetwork(coldContext, {
        ...networkOptions,
        lnurl: lnurl.respond,
        onLocalFailure: recordNetworkFailure,
      })
      beginNetworkTeardown.set(coldContext, coldNetwork)
      await installHermeticSparkTransport(coldContext, transport, {
        appUrl: merchantUrl,
      })
      const coldPage = await coldContext.newPage()
      const coldPersistence = installPersistenceReloadBarrier(
        coldPage,
        merchantUrl,
        {
          isAbandonedCompletedRequest: coldNetwork.isAbandonedCompletedRequest,
        }
      )
      // Start from the current shared clock without rewinding provider history.
      // Date must advance with foreground timers so checkedAt/backoff retry
      // eligibility stays meaningful. Exact boundary behavior is unit-tested;
      // this browser case observes the original frozen deadlines unchanged.
      const coldObservationStartedAt = sharedClock.nowMs()
      expect(coldObservationStartedAt < frozenTiming!.takeoverAt).toBe(true)
      await coldPage.clock.install({
        time: new Date(coldObservationStartedAt),
      })
      await coldPage.clock.setSystemTime(coldObservationStartedAt)
      await installRealTestSigner(coldPage, merchant, TEST_RELAY_URL)
      await coldPage.goto(`${merchantUrl}/orders?order=${orderId}`)
      const recovery = coldPage.getByRole("region", {
        name: "Order payment",
        exact: true,
      })
      const recoveredOrder = recovery
      await expect(recoveredOrder).toBeVisible({ timeout: 45_000 })
      setStage(
        "Merchant order sorting keeps the selected payment target stable"
      )
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
      setStage("cold Merchant respects the frozen shopper handoff")
      expect(await frozenRouterTiming(coldPage, orderId)).toEqual(frozenTiming)
      const beforeHandoffTime = await coldPage.evaluate(() => Date.now())
      expect(beforeHandoffTime).toBeGreaterThanOrEqual(coldObservationStartedAt)
      expect(beforeHandoffTime).toBeLessThan(frozenTiming!.takeoverAt)
      setStage("cold Merchant requests query-only native authentication")
      await expect
        .poll(() => observationOpenAttempts - observationAttemptsBeforeCold, {
          timeout: 30_000,
        })
        .toBeGreaterThan(0)
      setStage("cold Merchant authenticates query-only native observations")
      await expect
        .poll(() => observationOpenSuccesses - observationsBeforeCold, {
          timeout: 30_000,
        })
        .toBeGreaterThan(0)
      await expect(
        recovery.getByRole("button", {
          name: /^(?:Pause|Pause coordination fee)$/,
        })
      ).toBeVisible()
      const beforeHandoff = control().snapshot()
      expect(beforeHandoff.sendInvocationCount).toBe(partialRecovery ? 2 : 0)
      expect(control().nativeSnapshot().nativeSendInvocationCount).toBe(
        partialRecovery ? 1 : 0
      )
      expect(await coldPage.evaluate(() => Date.now())).toBeLessThan(
        frozenTiming!.takeoverAt
      )
      expect(nativeWalletOpenSuccesses).toBe(nativeWalletsBeforeCold)
      await recovery
        .getByRole("button", { name: /^(?:Pause|Pause coordination fee)$/ })
        .click()
      await expect(
        recovery.getByRole("button", {
          name: /^(?:Resume payment processing|Resume coordination fee)$/,
        })
      ).toBeVisible()

      // Move only the isolated clock, not the application's frozen plan,
      // takeover gate or persisted proof. Newly issued fixture invoices use
      // the same time so their actual signed expiry remains meaningful. Reopen
      // after the Date jump instead of firing every in-flight network timeout
      // with fastForward; the worker's real handoff scheduling has unit coverage.
      setStage(
        "cold Merchant automatically continues after handoff without a prompt"
      )
      const resumedClockTime = frozenTiming!.takeoverAt + 1
      const clockAdvance = resumedClockTime - sharedClock.nowMs()
      expect(clockAdvance >= 0).toBe(true)
      sharedClock.advanceBy(clockAdvance)
      setStage("cold Merchant browser clock follows the isolated clock advance")
      // Resume ticking at the exact post-cutoff instant. Newly issued provider
      // invoices use the same forward-only shared clock, not rewritten history.
      await coldPage.clock.setSystemTime(resumedClockTime)
      setStage("cold Merchant stays paused across the isolated clock advance")
      await expect(
        recovery.getByRole("button", {
          name: /^(?:Resume payment processing|Resume coordination fee)$/,
        })
      ).toBeVisible()
      setStage("cold Merchant has no sends before reopening")
      expect(control().snapshot()).toEqual(beforeHandoff)
      setStage("cold Merchant reload navigation completes")
      try {
        await coldPersistence.reload()
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === "Persistence reload local request failed.") {
            setStage("cold Merchant reload rejected a failed local request")
          } else if (
            error.message === "Persistence reload work did not settle."
          ) {
            setStage("cold Merchant reload rejected pending local work")
          } else if (
            error.message === "Persistence reload barrier was disposed."
          ) {
            setStage("cold Merchant reload rejected a disposed barrier")
          } else if (error.name === "TimeoutError") {
            setStage("cold Merchant reload navigation timed out")
          }
        }
        throw error
      }
      setStage("cold Merchant enables automatic recovery on reopening")
      await expect(
        recovery.getByRole("button", {
          name: /^(?:Pause|Pause coordination fee)$/,
        })
      ).toBeVisible({ timeout: 30_000 })
      setStage("cold Merchant foreground Date advances after reopening")
      const reopenedClockTime = await coldPage.evaluate(() => Date.now())
      expect(reopenedClockTime).toBeGreaterThan(frozenTiming!.takeoverAt)
      await expect
        .poll(
          async () =>
            (await coldPage.evaluate(() => Date.now())) - reopenedClockTime,
          { timeout: 10_000 }
        )
        .toBeGreaterThanOrEqual(5_000)
      setStage("cold Merchant submits the final native treasury transfer")
      await expect
        .poll(() => control().nativeSnapshot().nativePaymentCount, {
          timeout: 75_000,
        })
        .toBe(1)
      setStage("cold Merchant opens native recovery only after handoff")
      await expect
        .poll(() => nativeWalletOpenSuccesses - nativeWalletsBeforeCold, {
          timeout: 30_000,
        })
        .toBeGreaterThan(0)
      setStage("cold Merchant reads exact completed funding from the provider")
      await expect
        .poll(() => completedFundingReads - completedFundingBeforeCold, {
          timeout: 30_000,
        })
        .toBeGreaterThan(0)
      setStage("cold Merchant retains the exact admitted recovery witness")
      await expect
        .poll(() => merchantRecoveryAdmission(coldPage, orderId), {
          timeout: 30_000,
        })
        .toMatchObject({ uniqueWitness: true, sourcesValidated: true })
      setStage("cold Merchant retains a separate provider settlement record")
      await expect
        .poll(() => merchantRecoveryAdmission(coldPage, orderId), {
          timeout: 30_000,
        })
        .toMatchObject({ settlementPresent: true })
      setStage("cold Merchant retains independent provider funding credit")
      await expect
        .poll(() => merchantRecoveryAdmission(coldPage, orderId), {
          timeout: 30_000,
        })
        .toMatchObject({ creditPresent: true })
      setStage("cold Merchant retains independently verified credit")
      await expect
        .poll(
          async () =>
            (
              await merchantRecordedCompletion(
                coldPage,
                merchant.pubkey,
                orderId
              )
            )?.creditVerified,
          { timeout: 30_000 }
        )
        .toBe(true)
      setStage("cold Merchant retains independently verified commerce")
      await expect
        .poll(
          async () =>
            (
              await merchantRecordedCompletion(
                coldPage,
                merchant.pubkey,
                orderId
              )
            )?.commerceVerified,
          { timeout: 30_000 }
        )
        .toBe(true)
      setStage(
        "cold Merchant independently verifies supported recipient invoices"
      )
      await expect(
        recoveredOrder.getByText("Payment verified", {
          exact: true,
        })
      ).toBeVisible({ timeout: 30_000 })
      setStage(
        "cold Merchant independently checks recipient verification requests"
      )
      expect(
        lnurl.verificationSnapshot().verificationRequests -
          verificationRequestsBeforeCold
      ).toBeGreaterThanOrEqual(2)
      setStage("cold Merchant preserves exact commerce payment counters")
      expect(control().snapshot()).toEqual({
        fundingInvoiceCount: 1,
        sendInvocationCount: 2,
        outgoingPaymentCount: 2,
        debitedSats: 1_113,
      })
      setStage(
        "cold Merchant observes the exact pending native treasury transfer"
      )
      expect(control().nativeSnapshot()).toMatchObject({
        nativeSendInvocationCount: 1,
        nativePaymentCount: 1,
        transfers: [
          {
            status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
            transferDirection: "OUTGOING",
            totalValue: 113,
            receiverIdentityPublicKey: treasuryIdentityPublicKey,
          },
        ],
      })

      setStage("cold Merchant preserves recovery while residual funds remain")
      control().setAdditionalOwnedSats(1)
      control().setNativeCompletion(true)
      setStage("cold Merchant reconciles the completed transfer without replay")
      await coldPersistence.reload()
      setStage(
        "cold Merchant keeps automatic native reconciliation active after claim"
      )
      await expect(
        recovery.getByRole("button", {
          name: /^(?:Pause|Pause coordination fee)$/,
        })
      ).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(
          () => control().nativeSnapshot().transfers[0]?.status ?? "missing",
          {
            timeout: 75_000,
          }
        )
        .toBe("TRANSFER_STATUS_COMPLETED")
      setStage("cold Merchant retains accurate recovery verification status")
      await expect(
        recovery.getByRole("heading", {
          name: "Payment verified",
          exact: true,
        })
      ).toBeVisible({ timeout: 30_000 })
      expect(await merchantWalletState(coldPage, orderId)).toBe("active")
      await expect(
        recovery.getByText("Payment details", { exact: true })
      ).toHaveCount(0)
      await expect(
        recovery.getByRole("button", {
          name: "Verify recovery key",
          exact: true,
        })
      ).toHaveCount(0)
      setStage(
        "cold Merchant records independently verified commerce and native receipt"
      )
      const completedReceipt = {
        creditVerified: true,
        merchantVerified: true,
        commerceVerified: true,
        feePending: false,
        recipientUnverified: false,
        creditedSats: 1_113,
        paidCommerceCount: 2,
        commerceDebitSats: 1_000,
        nativePrincipalSats: 113,
        nativeDebitSats: 113,
        nativeFeeSats: 0,
      }
      setStage("cold Merchant retains independently verified credit")
      await expect
        .poll(
          async () =>
            (
              await merchantRecordedCompletion(
                coldPage,
                merchant.pubkey,
                orderId
              )
            )?.creditVerified,
          { timeout: 30_000 }
        )
        .toBe(true)
      setStage("cold Merchant retains independently verified commerce")
      await expect
        .poll(
          async () =>
            (
              await merchantRecordedCompletion(
                coldPage,
                merchant.pubkey,
                orderId
              )
            )?.commerceVerified,
          { timeout: 30_000 }
        )
        .toBe(true)
      setStage("cold Merchant retains independently verified native receipt")
      await expect
        .poll(
          async () =>
            (
              await merchantRecordedCompletion(
                coldPage,
                merchant.pubkey,
                orderId
              )
            )?.feePending,
          { timeout: 30_000 }
        )
        .toBe(false)
      setStage("cold Merchant records exact independently verified accounting")
      await expect
        .poll(
          () => merchantRecordedCompletion(coldPage, merchant.pubkey, orderId),
          {
            timeout: 30_000,
          }
        )
        .toEqual(completedReceipt)
      setStage("cold Merchant persists terminal treasury reconciliation")
      await expect
        .poll(() => merchantTerminalReconciliation(coldPage, orderId), {
          timeout: 30_000,
        })
        .toEqual({ treasuryPaid: true, allLegsPaid: true })
      setStage(
        "cold Merchant payments match the frozen destinations and allocations"
      )
      const expected = [
        { lud16: merchantAddress, amountSats: 751 },
        { lud16: supplierAddress, amountSats: 249 },
      ]
      const sent = control().outgoingInvoices()
      expect(
        sent.length === expected.length &&
          sent.every((invoice, index) => {
            const actual = issued.get(invoice)
            return (
              actual?.lud16 === expected[index]!.lud16 &&
              actual.amountSats === expected[index]!.amountSats &&
              actual.feeSats === 0
            )
          })
      ).toBe(true)
      expect(control().nativeSnapshot()).toMatchObject({
        nativeSendInvocationCount: 1,
        nativePaymentCount: 1,
        transfers: [
          {
            status: "TRANSFER_STATUS_COMPLETED",
            transferDirection: "OUTGOING",
            totalValue: 113,
            receiverIdentityPublicKey: treasuryIdentityPublicKey,
            receivers: [
              {
                identityPublicKey: treasuryIdentityPublicKey,
                amountSats: 113,
                status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
              },
            ],
          },
        ],
      })
      expect(control().snapshot().debitedSats).toBe(1_113)
      setStage(
        "Merchant sends only the verified supplier's private notification"
      )
      await expect.poll(supplierNoticeCount, { timeout: 30_000 }).toBe(1)

      setStage("cold Merchant drains automatic recovery before retirement")
      const pauseBeforeRetirement = recovery.getByRole("button", {
        name: "Pause",
        exact: true,
      })
      if (await pauseBeforeRetirement.isVisible()) {
        await pauseBeforeRetirement.click()
        await expect(
          recovery.getByRole("button", {
            name: "Resume payment processing",
            exact: true,
          })
        ).toBeVisible()
      }
      setStage("cold Merchant retires only after fresh terminal zero evidence")
      control().setAdditionalOwnedSats(0)
      await coldPersistence.reload()
      await expect
        .poll(() => merchantWalletState(coldPage, orderId), { timeout: 45_000 })
        .toBe("retired")
      const completed = control().snapshot()
      setStage(
        "cold Merchant reload automatically checks without replaying payouts"
      )
      await coldPersistence.reload()
      setStage("cold Merchant retired recovery remains visible after reload")
      await expect(recoveredOrder).toBeVisible({ timeout: 30_000 })
      // The order row can be visible before the worker loads the persisted
      // retirement tombstone. Wait for that read, not merely a mounted row.
      setStage("cold Merchant retains retirement tombstone after reload")
      await expect
        .poll(() => merchantWalletState(coldPage, orderId), { timeout: 45_000 })
        .toBe("retired")
      setStage("cold Merchant retired reload does not replay payments")
      expect(control().snapshot()).toEqual(completed)
      expect(completed.sendInvocationCount).toBe(2)
      expect(
        await merchantRecordedCompletion(coldPage, merchant.pubkey, orderId)
      ).toEqual(completedReceipt)
      expect(control().nativeSnapshot().nativeSendInvocationCount).toBe(1)
      expect(await supplierNoticeCount()).toBe(1)
      expect(
        (await readTestRelayEvents({ kinds: [9_734, 9_735] })).length
      ).toBe(0)
      bodyCompleted = true
      return
    }
    setStage("external QR remains mounted during funding polls")
    // The initial named QR action already approved and opened this invoice.
    // Observe that same disclosure rather than toggling it a second time.
    await expect(
      page.getByRole("button", { name: "Hide QR code", exact: true })
    ).toBeVisible()
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
          }, 15_200)
        })
    )
    expect(qrStayedVisible).toBe(true)
    setStage("external QR records two bounded funding observations")
    expect(fundingObservations - observationsBeforeQr).toBeGreaterThanOrEqual(2)
    await expect(qr).toBeVisible()
    expect(control().snapshot().outgoingPaymentCount).toBe(0)
    // Simulate only the external provider settlement. The application must read
    // native receive/transfer history and derive its own exact credit proof.
    control().completeFunding()

    setStage("automatic commerce payouts and pending native treasury transfer")
    await expect
      .poll(
        () => {
          const nativePayments = control().nativeSnapshot().nativePaymentCount
          if (
            nativePayments === 0 &&
            control().snapshot().outgoingPaymentCount === 2
          ) {
            setStage("native treasury transfer not submitted after commerce")
          }
          return nativePayments
        },
        { timeout: 45_000 }
      )
      .toBe(1)
    setStage("pending native treasury buyer progress")
    await expect(
      page.getByText("Completing payment", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByRole("button", {
        name: "Resume payment",
        exact: true,
      })
    ).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Pause payment", exact: true })
    ).toBeEnabled()
    await expect(
      page.getByRole("region", {
        name: "Native Spark treasury authorization",
        exact: true,
      })
    ).toHaveCount(0)
    await expect(
      page.getByText("Order payment verified", { exact: true }).first()
    ).toBeVisible({ timeout: 30_000 })
    setStage("pending native treasury accounting")
    expect(control().snapshot()).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 2,
      outgoingPaymentCount: 2,
      debitedSats: 1_113,
    })
    expect(control().nativeSnapshot()).toMatchObject({
      nativeSendInvocationCount: 1,
      nativePaymentCount: 1,
      transfers: [
        {
          status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
          transferDirection: "OUTGOING",
          totalValue: 113,
          receiverIdentityPublicKey: treasuryIdentityPublicKey,
        },
      ],
    })
    await expect(confirmation).toBeHidden()

    setStage("partial payout receipt preserves pending native finalization")
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

    const pendingNative = control().nativeSnapshot()
    if (capabilityRegression) {
      setStage("disabled execution preserves partial saved payment history")
      setStage("partial execution stop waits for buyer pause")
      await page
        .getByRole("button", { name: "Pause payment", exact: true })
        .click()
      await expect(
        page.getByRole("button", { name: "Refresh saved status", exact: true })
      ).toBeEnabled()
      await setIsolatedRouterCapabilities(page, false, false)
      const walletOpensBeforeStop = nativeWalletOpenSuccesses
      const walletInitializationsBeforeStop = walletInitializations
      const stopSnapshot = control().snapshot()
      setStage("partial execution stop mounts disabled saved order")
      await remountIsolatedSavedOrder(page)
      setStage("partial execution stop refreshes saved status")
      await page
        .getByRole("button", { name: "Refresh saved status", exact: true })
        .click()
      setStage("partial execution stop shows paused notice")
      await expect(
        page.getByText("Payment processing paused", { exact: true })
      ).toBeVisible()
      setStage("partial execution stop disables dispatch controls")
      await expect(
        page.getByRole("button", { name: "Resume payment", exact: true })
      ).toBeDisabled()
      await expect(
        page.getByRole("button", {
          name: "Reopen external invoice",
          exact: true,
        })
      ).toHaveCount(0)
      setStage("partial execution stop retains recorded receipt")
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
      setStage("partial execution stop preserves verified commerce")
      await expect(
        page.getByText("Order payment verified", { exact: true }).first()
      ).toBeVisible()
      setStage("partial execution stop preserves provider and wallet counters")
      expect(control().snapshot()).toEqual(stopSnapshot)
      expect(control().nativeSnapshot().nativeSendInvocationCount).toBe(
        pendingNative.nativeSendInvocationCount
      )
      expect(nativeWalletOpenSuccesses).toBe(walletOpensBeforeStop)
      expect(walletInitializations).toBe(walletInitializationsBeforeStop)
      setStage("partial execution stop restores bound continuation")
      await setIsolatedRouterCapabilities(page, false, true)
      await remountIsolatedSavedOrder(page)
      await page
        .getByRole("button", { name: "Refresh saved status", exact: true })
        .click()
      const resume = page.getByRole("button", {
        name: "Resume payment",
        exact: true,
      })
      await expect(resume).toBeEnabled()
      await resume.click()
    }
    // The same approved foreground run must reconcile this existing send.
    // Completing the oracle must not require a second consent or submission.
    control().setNativeCompletion(true)
    setStage("automatically reconcile the completed native transfer")
    await expect(confirmation).toBeHidden()
    await expect(
      page.getByText("Payment recorded", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    setStage("terminal buyer reconciliation without replay")
    await expect(
      page.getByText(
        /Your payment is recorded\. Delivery confirmation is separate/
      )
    ).toBeVisible()
    const settled = control().snapshot()
    expect(settled).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 2,
      outgoingPaymentCount: 2,
      debitedSats: 1_113,
    })
    const expectedPayouts = [
      { lud16: merchantAddress, amountSats: 751, feeSats: 0 },
      { lud16: supplierAddress, amountSats: 249, feeSats: 0 },
    ]
    expect(control().nativeSnapshot()).toMatchObject({
      nativeSendInvocationCount: pendingNative.nativeSendInvocationCount,
      nativePaymentCount: pendingNative.nativePaymentCount,
      transfers: [
        {
          status: "TRANSFER_STATUS_COMPLETED",
          transferDirection: "OUTGOING",
          totalValue: 113,
          receiverIdentityPublicKey: treasuryIdentityPublicKey,
          receivers: [
            {
              identityPublicKey: treasuryIdentityPublicKey,
              amountSats: 113,
              status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
            },
          ],
        },
      ],
    })
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
        receipt.getByText("1,113 sats", { exact: true })
      ).toHaveCount(3)
      await expect(
        receipt.getByText("All checkout payments verified.", { exact: true })
      ).toBeVisible()
      await expect(receipt.getByRole("region", { name: /payout/ })).toHaveCount(
        0
      )
      await expect(receipt.getByText(/Supplier|Allocation/)).toHaveCount(0)
      const nativeReceipt = receipt.getByRole("region", {
        name: "Completed native Spark payment",
        exact: true,
      })
      await expect(nativeReceipt).toHaveCount(0)
      for (const [label, amount] of [
        ["Funding credited", "1,113 sats"],
        ["Recorded payouts", "1,113 sats"],
        ["Recorded outgoing fees", "0 sats"],
        ["Recorded total debited", "1,113 sats"],
        ["Unspent from recorded checkout credit", "0 sats"],
      ] as const) {
        await expect(
          receipt
            .getByText(label, { exact: true })
            .locator("..")
            .getByText(amount, { exact: true })
        ).toBeVisible()
      }
      await expect(receipt.getByText(/not a live wallet balance/)).toBeVisible()
      await expect(receipt.getByRole("button")).toHaveCount(0)
    }
    setStage("actual payout receipt uses provider fees")
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
            actual.feeSats === expected.feeSats &&
            actual.publicZap === undefined
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

    setStage("explicit buyer cleanup retains residual recovery")
    const cleanup = page.getByRole("button", {
      name: "Check wallet cleanup",
      exact: true,
    })
    await page.getByText("Checkout recovery details", { exact: true }).click()
    await expect(cleanup).toBeEnabled()
    if (capabilityRegression) {
      setStage("disabled execution preserves complete saved payment history")
      await setIsolatedRouterCapabilities(page, false, false)
      const walletOpensBeforeStop = nativeWalletOpenSuccesses
      await remountIsolatedSavedOrder(page)
      await page.getByText("Checkout recovery details", { exact: true }).click()
      await refresh.click()
      await expect(refresh).toBeEnabled()
      await expect(cleanup).toBeDisabled()
      await expect(
        page.getByText("Payment recorded", { exact: true })
      ).toBeVisible()
      await assertRecordedReceipt()
      expect(control().snapshot()).toEqual(settled)
      expect(nativeWalletOpenSuccesses).toBe(walletOpensBeforeStop)
      await setIsolatedRouterCapabilities(page, false, true)
      await remountIsolatedSavedOrder(page)
      await page.getByText("Checkout recovery details", { exact: true }).click()
      await refresh.click()
      await expect(cleanup).toBeEnabled()
    }
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
    setStage("recorded receipt remains historical with additional owned funds")
    await assertRecordedReceipt()

    setStage("explicit buyer cleanup verifies terminal zero funds")
    control().setAdditionalOwnedSats(0)
    await cleanup.click()
    await expect(
      page.getByText("Payment complete", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    expect(control().snapshot()).toEqual(settled)
    setStage("retired buyer order survives reload without replay")
    await buyerPersistence.reload()
    await expect(
      page.getByText("Payment complete", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByText("Order payment verified", { exact: true }).first()
    ).toBeVisible()
    setStage("retired payout receipt survives reload")
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
    // Ordinary V1 routing never requests or publishes a public zap.
    expect((await readTestRelayEvents({ kinds: [9_734] })).length).toBe(0)
    expect((await readTestRelayEvents({ kinds: [9_735] })).length).toBe(0)
    expect(webLnSends).toBe(0)
    if (capabilityRegression) {
      setStage("order and account changes hide stale saved payment history")
      const originalOrderId = new URL(page.url()).searchParams.get("order")!
      await setIsolatedRouterCapabilities(page, false, false)
      await remountIsolatedSavedOrder(page)
      await refresh.click()
      await expect(refresh).toBeEnabled()
      await expect(
        page.getByText("Payment complete", { exact: true })
      ).toBeVisible()
      await assertRecordedReceipt()
      await selectIsolatedOrder(
        page,
        await page.evaluate(() => crypto.randomUUID())
      )
      await expect(
        page.getByText("Payment complete", { exact: true })
      ).toHaveCount(0)
      await expect(receipt).toHaveCount(0)
      await selectIsolatedOrder(page, originalOrderId)
      await expect(
        page.getByText("Payment complete", { exact: true })
      ).toBeVisible({ timeout: 30_000 })
      await assertRecordedReceipt()
      await page
        .getByRole("button", { name: "Open account menu", exact: true })
        .click()
      await page
        .getByRole("menuitem", { name: "Disconnect", exact: true })
        .click()
      await expect(
        page.getByText("Payment complete", { exact: true })
      ).toHaveCount(0)
      await expect(receipt).toHaveCount(0)
      expect(control().snapshot()).toEqual(settled)
    }
    // This buyer-led case is not evidence for cold Merchant takeover, browser
    // suspension, real provider fees, or production funded settlement.
    bodyCompleted = true
  } catch {
    phaseRecorder.failed()
    // Never serialize underlying assertions, DOM, invoices or generated keys.
    throw new Error(`Isolated router smoke failed during ${stage}.`)
  } finally {
    // A blocked body remains running until it actually unwinds. Only a
    // positively finished body earns completed while cleanup is in progress.
    phaseRecorder.teardown(bodyCompleted)
    // End owned network work before draining fixture responses. This is
    // teardown only, never permission to hide failures during assertions.
    for (const beginTeardown of beginNetworkTeardown.values()) beginTeardown()
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
    phaseRecorder.complete()
  }
}

test("native router funding automatically reconciles commerce and the exact native treasury payment without duplicate payouts @commerce", async ({
  browser,
}) => rehearseRouter(browser))

test("native router cold Merchant restores a funded checkout and finishes all payouts without the buyer @commerce", async ({
  browser,
}) => rehearseRouter(browser, "cold-merchant"))

test("native router cold Merchant independently verifies supported recipients and finishes a partial checkout without replaying paid commerce @commerce", async ({
  browser,
}) => rehearseRouter(browser, "partial-cold-merchant"))

test("native router ordinary guest checkout completes private commerce and native treasury without public zap signing @commerce", async ({
  browser,
}) => rehearseRouter(browser, "buyer", "guest"))

test("native router execution gates preserve bound continuation and saved payment history without stale order or account display @commerce", async ({
  browser,
}) => rehearseRouter(browser, "buyer", "signed-in", null, true))

test("receiver setup saves and reads back a supported Merchant payment profile without creating a wallet or invoice @commerce", async ({
  browser,
}) => rehearseRouter(browser, "buyer", "signed-in", "supported-setup"))

test("receiver setup blocks an unsupported original Merchant before wallet funding or invoice disclosure @commerce", async ({
  browser,
}) => rehearseRouter(browser, "buyer", "signed-in", "unsupported-merchant"))

test("receiver setup blocks an unsupported original supplier before wallet funding or invoice disclosure @commerce", async ({
  browser,
}) => rehearseRouter(browser, "buyer", "signed-in", "unsupported-supplier"))
