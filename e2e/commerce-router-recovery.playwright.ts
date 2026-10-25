import { createHash } from "node:crypto"
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
import { buildEventMarketCalendarDraft } from "../packages/core/src/protocol/event-market"
import { getFutureMarketClaimRef } from "../packages/core/src/protocol/future-market-handoff"
import { formatEventMarketPickupClaimCode } from "../packages/core/src/protocol/event-market-handoff"
import { CANONICAL_COMMERCE_DISCOVERY_RELAYS } from "../packages/core/src/config"
import {
  decodeLightningInvoicePaymentHash,
  validateLightningInvoiceForPayment,
} from "../packages/core/src/protocol/lightning"
import { openPlaywrightRouterClock } from "../scripts/dev/playwright_router_clock"
import {
  createRouterSmokeRecorder,
  type RouterSmokePhase,
} from "../scripts/ci/router_smoke_diagnostic"
import {
  publishTestRelayEvents,
  readTestRelayEvents,
  TEST_RELAY_URL,
} from "./helpers/auth"
import {
  HERMETIC_NETWORK_DIAGNOSTIC_ANNOTATIONS,
  createHermeticCommerceNetworkPolicy,
  installHermeticCommerceNetwork,
  type HermeticNetworkFailureDiagnostic,
} from "./helpers/hermetic-network"
import { createHermeticRouterProvider } from "./helpers/hermetic-router-provider"
import { createDeterministicNwcWallet } from "./helpers/deterministic-nwc-wallet"
import { openWalletSetup } from "./helpers/wallet-fixture"
import { installPersistenceReloadBarrier } from "./helpers/persistence-reload-barrier"
import { viteFileModuleUrl } from "./helpers/vite-file-module-url"
import { installHermeticSparkTransport } from "./helpers/hermetic-spark-transport"
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
  const modulePath = viteFileModuleUrl(
    fileURLToPath(new URL("../packages/core/src/config.ts", import.meta.url))
  )
  const appCorePath = viteFileModuleUrl(
    fileURLToPath(new URL("../packages/core/src/index.ts", import.meta.url))
  )
  const observed = await page.evaluate(
    async ({ modulePath, appCorePath, admission, execution }) => {
      const { config } = await import(/* @vite-ignore */ modulePath)
      const { isQuantumRouterEnabled, isQuantumRouterExecutionEnabled } =
        await import(/* @vite-ignore */ appCorePath)
      config.quantumRouterEnabled = admission
      config.quantumRouterExecutionEnabled = execution
      // Return only public capability booleans, never the runtime config.
      return {
        admission: isQuantumRouterEnabled(),
        execution: isQuantumRouterExecutionEnabled(),
      }
    },
    { modulePath, appCorePath, admission, execution }
  )
  expect(observed).toEqual({ admission: admission && execution, execution })
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
      const matching = bindings.filter(
        (row: {
          orderWitness?: { orderId: string }
          buyerOrderBinding?: { orderId: string }
        }) =>
          (row.orderWitness?.orderId ?? row.buyerOrderBinding?.orderId) ===
          orderId
      )
      if (matching.length !== 1) return "absent"
      const binding = matching[0]!
      const retired = await db.checkoutSparkRetirements.get(binding.checkoutId)
      return retired ? "retired" : "active"
    },
    { modulePath, orderId }
  )
}

// Return only whether the exact order retains a signed kind-1059 ciphertext
// wrap. Ciphertext, event identifiers, keys and order data never leave the page.
async function hasActiveEncryptedRecovery(
  page: Page,
  orderId: string | null
): Promise<boolean> {
  const modulePath = `/@fs/${fileURLToPath(new URL("../apps/market/src/lib/checkout-spark-recovery-handoff.ts", import.meta.url)).replaceAll("\\", "/")}`
  return page.evaluate(
    async ({ modulePath, orderId }) => {
      if (!orderId) return false
      const { listCheckoutSparkRecoveryDeliveries } = await import(
        /* @vite-ignore */ modulePath
      )
      return (await listCheckoutSparkRecoveryDeliveries()).some(
        (saved: {
          record: {
            orderId: string
            signedRecipientWrap: {
              id: string
              kind: number
              content: string
            }
          }
          deliveryProgress: { recipientWrapId: string }
        }) =>
          saved.record.orderId === orderId &&
          saved.record.signedRecipientWrap.kind === 1_059 &&
          saved.record.signedRecipientWrap.content.length > 0 &&
          saved.deliveryProgress.recipientWrapId ===
            saved.record.signedRecipientWrap.id
      )
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

// Re-read the original Merchant recovery through its authenticated discovery
// path. Optional outgoing progress is not a recovery or guest-receipt gate.
// Only this exact-order availability boolean leaves the isolated page.
async function hasRetainedMerchantRecovery(
  page: Page,
  orderId: string | null
): Promise<boolean> {
  const databasePath = `/@fs/${fileURLToPath(new URL("../packages/core/src/db/index.ts", import.meta.url)).replaceAll("\\", "/")}`
  const commercePath = `/@fs/${fileURLToPath(new URL("../packages/core/src/protocol/commerce.ts", import.meta.url)).replaceAll("\\", "/")}`
  return page.evaluate(
    async ({ databasePath, commercePath, orderId }) => {
      const { db } = await import(/* @vite-ignore */ databasePath)
      const bindings = await db.checkoutSparkPlanBindings.toArray()
      const matching = bindings.filter(
        (row: { orderWitness?: { orderId: string } }) =>
          row.orderWitness?.orderId === orderId
      )
      if (matching.length !== 1) return false
      const binding = matching[0]!
      const { getMerchantCheckoutSparkRecoveryList } = await import(
        /* @vite-ignore */ commercePath
      )
      const read = await getMerchantCheckoutSparkRecoveryList(
        binding.orderWitness.merchantPubkey
      )
      return read.candidates.some(
        (candidate: {
          checkoutId: string
          orderId: string
          planDigest: string
        }) =>
          candidate.checkoutId === binding.checkoutId &&
          candidate.orderId === orderId &&
          candidate.planDigest === binding.planDigest
      )
    },
    { databasePath, commercePath, orderId }
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

// Diagnose only the exact isolated order after a failed continuation assertion.
// Hashing the saved state locates its existing signed outbox row; this does not
// create, sign, store, publish or promote any recovery/payment authority.
async function merchantRemainingPayoutEvidence(
  page: Page,
  orderId: string | null
) {
  const moduleUrl = (path: string) =>
    viteFileModuleUrl(fileURLToPath(new URL(path, import.meta.url)))
  return page.evaluate(
    async ({
      databasePath,
      progressPath,
      repositoryPath,
      discoveryPath,
      selectionPath,
      orderId,
    }) => {
      const [{ db }, { createCheckoutSparkMerchantProgress }, repository] =
        await Promise.all([
          import(/* @vite-ignore */ databasePath),
          import(/* @vite-ignore */ progressPath),
          import(/* @vite-ignore */ repositoryPath),
        ])
      const matching = (await db.checkoutSparkReconciliations.toArray()).filter(
        (row: { state: { plan: { orderId: string } } }) =>
          row.state.plan.orderId === orderId
      )
      if (matching.length !== 1) return null
      const state = matching[0].state
      const next = state.legs.find(
        (leg: { status: string }) => leg.status !== "paid"
      )
      const binding = await db.checkoutSparkPlanBindings.get(
        state.plan.checkoutId
      )
      const exact = binding?.merchantProgressOutbox?.find(
        (delivery: {
          record: { initialHandoffId: string; snapshotId: string }
        }) =>
          createCheckoutSparkMerchantProgress({
            initialHandoffId: delivery.record.initialHandoffId,
            state,
          }).snapshotId === delivery.record.snapshotId
      )
      const stored = exact
        ? await new repository.DexieMerchantCheckoutSparkProgressRepository().load(
            state.plan.merchantPubkey,
            state.plan.checkoutId,
            state.plan.planDigest,
            exact.record.snapshotId
          )
        : null
      // A separate bounded read can distinguish a stale mounted discovery
      // pointer from unavailable signed evidence. It has no wallet/send callback
      // and does not import or rewrite recovered order state.
      const [
        { createMerchantCheckoutSparkRecoveryDiscovery },
        { selectMerchantCheckoutSparkSignedNextPayout },
      ] = await Promise.all([
        import(/* @vite-ignore */ discoveryPath),
        import(/* @vite-ignore */ selectionPath),
      ])
      const fresh = await createMerchantCheckoutSparkRecoveryDiscovery(
        state.plan.merchantPubkey
      )
      let freshMatchesPrepared = false
      let freshSelectionReady = false
      try {
        let page = await fresh.nextPage()
        for (let count = 0; page.history.hasMore && count < 16; count++)
          page = await fresh.nextPage()
        const selected = page.candidates.filter(
          (candidate: { orderId: string }) => candidate.orderId === orderId
        )
        if (
          !page.history.hasMore &&
          page.conflictCount === 0 &&
          selected.length === 1
        ) {
          freshMatchesPrepared =
            stored !== null &&
            selected[0].merchantProgress?.snapshotId ===
              stored.record.snapshotId
          const selection = await selectMerchantCheckoutSparkSignedNextPayout(
            state.plan.merchantPubkey,
            selected[0],
            () => {}
          )
          freshSelectionReady = selection.status === "ready"
        }
      } finally {
        fresh.dispose()
      }
      return {
        freshMatchesPrepared,
        freshSelectionReady,
        nextUnpaidIsOrganizer:
          state.plan.recipients.find(
            (recipient: { legId: string; kind: string }) =>
              recipient.legId === next?.legId
          )?.kind === "organizer",
        nextUnpaidHasIntent: next?.intent != null,
        exactProgressStaged: stored !== null,
        exactProgressSelfAccepted:
          stored !== null &&
          (stored.record.schemaVersion === 2
            ? stored.merchantAccepted === true
            : stored.relayAccepted === true),
      }
    },
    {
      databasePath: moduleUrl("../packages/core/src/db/index.ts"),
      progressPath: moduleUrl(
        "../packages/core/src/protocol/checkout-spark-merchant-progress.ts"
      ),
      repositoryPath: moduleUrl(
        "../packages/core/src/protocol/checkout-spark-merchant-progress-repository.ts"
      ),
      discoveryPath: moduleUrl("../packages/core/src/protocol/commerce.ts"),
      selectionPath: moduleUrl(
        "../apps/merchant/src/lib/checkout-spark-settled-continuation.ts"
      ),
      orderId,
    }
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

// New app-created checkouts must bind the no-floor policy before funding. This
// observation never rewrites a saved plan or exposes its private payload.
async function hasCurrentConduitFeePolicy(page: Page, orderId: string | null) {
  const dbPath = viteFileModuleUrl(
    fileURLToPath(new URL("../packages/core/src/db/index.ts", import.meta.url))
  )
  return page.evaluate(
    async ({ dbPath, orderId }) => {
      const { db } = await import(/* @vite-ignore */ dbPath)
      const rows = await db.checkoutSparkReconciliations.toArray()
      const matching = rows.filter(
        (row: { state: { plan: { orderId: string } } }) =>
          row.state.plan.orderId === orderId
      )
      return (
        matching.length === 1 &&
        matching[0].state.plan.conduitFeePolicy === "percentage-only-v1"
      )
    },
    { dbPath, orderId }
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

async function rehearseRouter(
  browser: Browser,
  continuation: "buyer" | "cold-merchant" | "partial-cold-merchant" = "buyer",
  buyerMode: "signed-in" | "guest" = "signed-in",
  receiverAdmission:
    | "supported-setup"
    | "unsupported-merchant"
    | "unsupported-supplier"
    | null = null,
  capabilityRegression = false,
  scopedRecovery = false,
  offlineTreasury = false
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
  const {
    native,
    transport: nativeTransport,
    issued,
    lnurl,
  } = createHermeticRouterProvider({
    recipients: [merchantAddress, supplierAddress],
    nowSeconds: () => Math.floor(sharedClock.nowMs() / 1_000),
    selectedIdentity: () => identity,
    onWalletInitialization() {
      walletInitializations += 1
    },
    onFundingInvoice(request) {
      identity = request.identityPublicKey
      grossFundingSats = request.amountSats
    },
  })
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
      // The shared Wallets editor saves the account's public address; receiver
      // eligibility is independently checked at checkout admission, not by
      // restricting ordinary profile address updates.
      setStage("Merchant setup reads back its genuine signed receiving profile")
      await merchantPage.goto(`${merchantUrl}/wallet`)
      await expect(
        merchantPage.getByRole("heading", { name: "Wallets", exact: true })
      ).toBeVisible()
      const addressSection = merchantPage.getByRole("region", {
        name: "Nostr profile receiving address",
        exact: true,
      })
      await addressSection
        .getByRole("button", { name: "Edit", exact: true })
        .click()
      const addressDialog = merchantPage.getByRole("dialog", {
        name: "Public Lightning address",
        exact: true,
      })
      await addressDialog
        .getByLabel("Lightning address", { exact: true })
        .fill(merchantAddress)
      const save = addressDialog.getByRole("button", {
        name: "Save public address",
        exact: true,
      })
      await expect(save).toBeEnabled()
      await save.click()
      await expect(addressSection.locator("[data-wallet-address]")).toHaveText(
        merchantAddress,
        { timeout: 30_000 }
      )
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
      await expect(addressSection.locator("[data-wallet-address]")).toHaveText(
        merchantAddress,
        { timeout: 30_000 }
      )
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
    const catalogPrice = product.getByTitle("₿1,023 (estimated conversion)", {
      exact: true,
    })
    await expect(catalogPrice).toBeVisible()
    await expect(catalogPrice).toHaveText("Estimated conversion: ₿1,023")
    await expect(product.getByText(/Estimated total/)).toBeVisible()
    if (buyerMode === "guest") {
      setStage("guest product detail navigation")
      const revisions = await readTestRelayEvents({
        kinds: [30_402],
        authors: [merchant.pubkey],
      })
      const revision = revisions[0]!
      const identifier = revision.tags.find(([key]) => key === "d")?.[1]
      if (!identifier)
        throw new Error("The public product reference is unavailable")
      const reference = nip19.naddrEncode({
        kind: 30_402,
        pubkey: merchant.pubkey,
        identifier,
        relays: [TEST_RELAY_URL],
      })
      await page.goto(`${marketUrl}/products/${reference}`)
      await expect(
        page.getByRole("heading", { name: productTitle, exact: true, level: 1 })
      ).toBeVisible()
      const addFromDetail = page.getByRole("button", {
        name: "Add 1 to cart",
        exact: true,
      })
      await expect(addFromDetail).toBeEnabled()
      setStage("guest product detail cart admission")
      await addFromDetail.click()
      const detailCart = page.getByRole("region", {
        name: "Cart inventory",
        exact: true,
      })
      await expect(
        detailCart.getByRole("link", {
          name: "Continue to checkout",
          exact: true,
        })
      ).toBeVisible()
      expect(walletInitializations).toBe(0)
      expect(lnurl.snapshot().invoicesIssued).toBe(0)
      // Keep the original guest catalog-card add and full-cart checkout below.
      // The HUD opens automatically when its first item is added.
      setStage("guest product detail cart reset")
      await detailCart
        .getByRole("button", {
          name: `Decrease ${productTitle} quantity`,
          exact: true,
        })
        .click()
      await expect(detailCart).toHaveCount(0)
      await page.goto(`${marketUrl}${catalogPath}`)
      await expect(product).toBeVisible({ timeout: 30_000 })
    }
    setStage("buyer add product to cart")
    await product
      .getByRole("button", { name: `Add ${productTitle} to cart`, exact: true })
      .click()
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
      checkoutPrice.getByText("₿1,023", { exact: true })
    ).toBeVisible()
    await expect(
      checkoutPrice.getByText("₿1,000", { exact: true })
    ).toBeVisible()
    const approvalNote = page.getByText(
      "Your fixed total of 1,023 sats includes a best-effort 21 sats Conduit fee estimate and payment reserves; Conduit is paid last, including unused authorized reserves, with no increase to your total.",
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
          ) {
            setStage("buyer order preparation rejected")
            throw new Error("Router preparation failed")
          }
          return page
            .getByRole("heading", { name: "Orders", exact: true })
            .isVisible()
        },
        { timeout: 45_000 }
      )
      .toBe(true)
    setStage("buyer prepared funding matches the frozen total")
    expect(grossFundingSats).toBe(1_023)
    expect(
      await hasCurrentConduitFeePolicy(
        page,
        new URL(page.url()).searchParams.get("order")
      )
    ).toBe(true)
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
    await expect(paymentPlan.getByText("₿1,023", { exact: true })).toBeVisible()
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
    control().setNativeSenderCommitment(false)
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
      let untouchedOrderId: string | null = null
      let untouchedIdentity: string | undefined
      let untouchedTakeoverAt = 0
      let untouchedTiming: Awaited<ReturnType<typeof frozenRouterTiming>> = null
      if (scopedRecovery) {
        // Prepare another genuine signed order in separate browser storage.
        // Neither buyer is allowed to route it; only the selected Merchant
        // order will receive the later explicit continuation authorization.
        const selectedIdentity = identity
        const otherContext = await browser.newContext({
          serviceWorkers: "block",
        })
        contexts.push(otherContext)
        await otherContext.grantPermissions(["local-network-access"], {
          origin: marketUrl,
        })
        const otherNetwork = await installHermeticCommerceNetwork(
          otherContext,
          {
            ...networkOptions,
            lnurl: lnurl.respond,
            onLocalFailure: recordNetworkFailure,
          }
        )
        beginNetworkTeardown.set(otherContext, otherNetwork)
        await installHermeticSparkTransport(otherContext, transport, {
          appUrl: marketUrl,
        })
        const otherPage = await otherContext.newPage()
        await installRealTestSigner(otherPage, buyer, TEST_RELAY_URL)
        await otherPage.goto(`${marketUrl}${catalogPath}`)
        const otherProduct = otherPage
          .getByRole("listitem")
          .filter({ hasText: productTitle })
        await expect(otherProduct).toBeVisible({ timeout: 30_000 })
        await otherProduct
          .getByRole("button", {
            name: `Add ${productTitle} to cart`,
            exact: true,
          })
          .click()
        await otherPage
          .getByRole("region", { name: "Cart inventory", exact: true })
          .getByRole("link", { name: "Continue to checkout", exact: true })
          .click()
        const otherPrepare = otherPage.getByRole("button", {
          name: "Continue to payment",
          exact: true,
        })
        await expect(otherPrepare).toBeEnabled({ timeout: 30_000 })
        await otherPrepare.click()
        await expect(
          otherPage.getByRole("heading", { name: "Orders", exact: true })
        ).toBeVisible({ timeout: 45_000 })
        untouchedOrderId = new URL(otherPage.url()).searchParams.get("order")
        untouchedIdentity = identity
        const otherTiming = await frozenRouterTiming(
          otherPage,
          untouchedOrderId
        )
        expect(
          untouchedOrderId !== null &&
            untouchedOrderId !== orderId &&
            untouchedIdentity !== undefined &&
            untouchedIdentity !== selectedIdentity &&
            otherTiming !== null
        ).toBe(true)
        untouchedTakeoverAt = otherTiming!.takeoverAt
        untouchedTiming = otherTiming
        expect(control().snapshot()).toEqual({
          fundingInvoiceCount: 1,
          sendInvocationCount: 0,
          outgoingPaymentCount: 0,
          debitedSats: 0,
        })
        beginNetworkTeardown.get(otherContext)?.()
        await otherContext.close()
        identity = selectedIdentity
      }
      beginNetworkTeardown.get(buyerContext)?.()
      beginNetworkTeardown.get(merchantContext)?.()
      await buyerContext.close()
      await merchantContext.close()
      if (!partialRecovery) {
        control().completeFunding()
        expect(lnurl.snapshot().invoicesIssued).toBe(0)
        expect(control().snapshot().outgoingPaymentCount).toBe(0)
      }
      const untouchedControl = untouchedIdentity
        ? native.control.forIdentity(untouchedIdentity)
        : null
      untouchedControl?.completeFunding()
      const untouchedSnapshot = untouchedControl?.snapshot()
      const untouchedNativeSnapshot = untouchedControl?.nativeSnapshot()

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
      if (!scopedRecovery)
        expect(coldObservationStartedAt < frozenTiming!.takeoverAt).toBe(true)
      await coldPage.clock.install({
        time: new Date(coldObservationStartedAt),
      })
      await coldPage.clock.setSystemTime(coldObservationStartedAt)
      await installRealTestSigner(coldPage, merchant, TEST_RELAY_URL)
      await coldPage.goto(
        `${merchantUrl}/orders?order=${orderId}${scopedRecovery ? "&recovery=paused" : ""}`
      )
      const recovery = coldPage.getByRole("region", {
        name: "Order payment",
        exact: true,
      })
      const recoveredOrder = recovery
      const completedPayment = recovery.getByText(
        "Payment complete. The checkout wallet and recovery remain saved with this order.",
        { exact: true }
      )
      const assertScopedPaymentsComplete = async () => {
        await expect(completedPayment).toBeVisible()
        await expect(
          recovery.getByRole("button", {
            name: /^(?:Finish recovery|Continue this order|Pause|Pause coordination fee|Resume payment processing|Resume coordination fee)$/,
          })
        ).toHaveCount(0)
        await expect(recovery.getByRole("progressbar")).toHaveCount(0)
        await expect(
          recovery.getByText(
            /Keep Orders open; unresolved payouts remain held until verified\./
          )
        ).toHaveCount(0)
      }
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
      setStage("cold Merchant restores exact saved funding deadlines")
      expect(await frozenRouterTiming(coldPage, orderId)).toEqual(frozenTiming)
      setStage("cold Merchant respects the frozen shopper handoff")
      const beforeHandoffTime = await coldPage.evaluate(() => Date.now())
      expect(beforeHandoffTime).toBeGreaterThanOrEqual(coldObservationStartedAt)
      if (!scopedRecovery) {
        setStage("cold Merchant remains before the original shopper cutoff")
        expect(beforeHandoffTime).toBeLessThan(frozenTiming!.takeoverAt)
      }
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
          name: scopedRecovery
            ? "Continue this order"
            : /^(?:Pause|Pause coordination fee)$/,
        })
      ).toBeVisible()
      const beforeHandoff = control().snapshot()
      expect(beforeHandoff.sendInvocationCount).toBe(partialRecovery ? 2 : 0)
      expect(control().nativeSnapshot().nativeSendInvocationCount).toBe(
        partialRecovery ? 1 : 0
      )
      if (!scopedRecovery) {
        expect(await coldPage.evaluate(() => Date.now())).toBeLessThan(
          frozenTiming!.takeoverAt
        )
      }
      expect(nativeWalletOpenSuccesses).toBe(nativeWalletsBeforeCold)
      if (!scopedRecovery) {
        await recovery
          .getByRole("button", { name: /^(?:Pause|Pause coordination fee)$/ })
          .click()
      }
      await expect(
        recovery.getByRole("button", {
          name: /^(?:Resume payment processing|Resume coordination fee|Continue this order|Finish recovery)$/,
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
      // Preparing the additional order can legitimately cross the first
      // deadline. The scoped case needs both original deadlines expired, not
      // a claim that its extra setup happened within the buyer's authority.
      const resumedClockTime =
        Math.max(
          frozenTiming!.takeoverAt,
          untouchedTakeoverAt,
          scopedRecovery ? sharedClock.nowMs() : 0
        ) + 1
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
          name: /^(?:Resume payment processing|Resume coordination fee|Continue this order|Finish recovery)$/,
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
      if (scopedRecovery) {
        const continueOrder = recovery.getByRole("button", {
          name: "Continue this order",
          exact: true,
        })
        await expect(continueOrder).toBeVisible({ timeout: 30_000 })
        // The other funded order must really be discovered and independently
        // admitted; a missing candidate would not prove scope isolation.
        await expect
          .poll(() => merchantRecoveryAdmission(coldPage, untouchedOrderId), {
            timeout: 30_000,
          })
          .toMatchObject({ uniqueWitness: true, sourcesValidated: true })
        for (const fundedOrderId of [orderId, untouchedOrderId]) {
          await expect
            .poll(
              () =>
                merchantRecordedCompletion(
                  coldPage,
                  merchant.pubkey,
                  fundedOrderId
                ),
              { timeout: 30_000 }
            )
            .toMatchObject({
              creditVerified: true,
              creditedSats: 1_023,
              paidCommerceCount: 0,
              nativePrincipalSats: null,
            })
        }
        expect(await frozenRouterTiming(coldPage, orderId)).toEqual(
          frozenTiming
        )
        expect(await frozenRouterTiming(coldPage, untouchedOrderId)).toEqual(
          untouchedTiming
        )
        const continuedAt = await coldPage.evaluate(() => Date.now())
        expect(continuedAt).toBeGreaterThan(frozenTiming!.takeoverAt)
        expect(continuedAt).toBeGreaterThan(untouchedTakeoverAt)
        expect(control().snapshot()).toEqual(beforeHandoff)
        expect(untouchedControl!.snapshot()).toEqual(untouchedSnapshot)
        expect(untouchedControl!.nativeSnapshot()).toEqual(
          untouchedNativeSnapshot
        )
        await continueOrder.click()
        await expect(
          recovery.getByRole("progressbar", {
            name: "Completing this order…",
            exact: true,
          })
        ).toBeVisible()
      }
      await expect(
        recovery.getByRole("button", {
          name: /^(?:Pause|Pause coordination fee)$/,
        })
      ).toBeVisible({ timeout: 30_000 })
      setStage("cold Merchant foreground Date advances after reopening")
      const reopenedClockTime = await coldPage.evaluate(() => Date.now())
      expect(reopenedClockTime).toBeGreaterThan(frozenTiming!.takeoverAt)
      if (scopedRecovery)
        expect(reopenedClockTime).toBeGreaterThan(untouchedTakeoverAt)
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
        debitedSats: 1_023,
      })
      setStage(
        "cold Merchant observes the exact pending native treasury transfer"
      )
      expect(control().nativeSnapshot()).toMatchObject({
        nativeSendInvocationCount: 1,
        nativePaymentCount: 1,
        transfers: [
          {
            status: "TRANSFER_STATUS_APPLYING_SENDER_KEY_TWEAK",
            transferDirection: "OUTGOING",
            totalValue: 23,
            receiverIdentityPublicKey: treasuryIdentityPublicKey,
            receivers: [
              {
                identityPublicKey: treasuryIdentityPublicKey,
                amountSats: 23,
                status: "TRANSFER_RECEIVER_STATUS_INITIATED",
              },
            ],
          },
        ],
      })
      if (scopedRecovery) {
        await expect(
          recovery.getByRole("progressbar", {
            name: "Completing this order…",
            exact: true,
          })
        ).toBeVisible()
        expect(untouchedControl!.snapshot()).toEqual(untouchedSnapshot)
        expect(untouchedControl!.nativeSnapshot()).toEqual(
          untouchedNativeSnapshot
        )
      }

      setStage("cold Merchant preserves recovery while residual funds remain")
      control().setAdditionalOwnedSats(1)
      control().setNativeCompletion(true)
      setStage("cold Merchant reconciles the completed transfer without replay")
      if (!scopedRecovery) await coldPersistence.reload()
      setStage(
        "cold Merchant keeps automatic native reconciliation active after claim"
      )
      await expect(
        recovery
          .getByRole("progressbar", {
            name: "Completing this order…",
            exact: true,
          })
          .or(completedPayment)
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
      setStage("cold Merchant keeps the completed checkout wallet active")
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
        creditedSats: 1_023,
        paidCommerceCount: 2,
        commerceDebitSats: 1_000,
        nativePrincipalSats: 23,
        nativeDebitSats: 23,
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
            totalValue: 23,
            receiverIdentityPublicKey: treasuryIdentityPublicKey,
            receivers: [
              {
                identityPublicKey: treasuryIdentityPublicKey,
                amountSats: 23,
                status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
              },
            ],
          },
        ],
      })
      expect(control().snapshot().debitedSats).toBe(1_023)
      setStage(
        "Merchant sends only the verified supplier's private notification"
      )
      await expect.poll(supplierNoticeCount, { timeout: 30_000 }).toBe(1)

      setStage(
        "cold Merchant completes payment while retaining checkout recovery"
      )
      await assertScopedPaymentsComplete()
      setStage("cold Merchant keeps the completed checkout wallet active")
      expect(await merchantWalletState(coldPage, orderId)).toBe("active")
      setStage("cold Merchant retains original encrypted recovery")
      expect(await hasRetainedMerchantRecovery(coldPage, orderId)).toBe(true)
      control().setAdditionalOwnedSats(0)
      await coldPersistence.reload()
      await assertScopedPaymentsComplete()
      setStage("cold Merchant keeps the completed checkout wallet active")
      expect(await merchantWalletState(coldPage, orderId)).toBe("active")
      setStage("cold Merchant retains original encrypted recovery")
      expect(await hasRetainedMerchantRecovery(coldPage, orderId)).toBe(true)
      const completed = control().snapshot()
      setStage(
        "cold Merchant reload automatically checks without replaying payouts"
      )
      await coldPersistence.reload()
      setStage("cold Merchant retained recovery and paid state survive reload")
      await expect(recoveredOrder).toBeVisible({ timeout: 30_000 })
      await assertScopedPaymentsComplete()
      setStage("cold Merchant keeps the completed checkout wallet active")
      expect(await merchantWalletState(coldPage, orderId)).toBe("active")
      setStage("cold Merchant retains original encrypted recovery")
      expect(await hasRetainedMerchantRecovery(coldPage, orderId)).toBe(true)
      await expect(
        recovery.getByText("Recovery check details", { exact: true })
      ).toHaveCount(0)
      setStage("cold Merchant retained reload does not replay payments")
      expect(control().snapshot()).toEqual(completed)
      expect(completed.sendInvocationCount).toBe(2)
      setStage("cold Merchant reload preserves recorded accounting")
      expect(
        await merchantRecordedCompletion(coldPage, merchant.pubkey, orderId)
      ).toEqual(completedReceipt)
      setStage("cold Merchant reload preserves the native send count")
      expect(control().nativeSnapshot().nativeSendInvocationCount).toBe(1)
      if (scopedRecovery) {
        await assertScopedPaymentsComplete()
        expect(untouchedControl!.snapshot()).toEqual(untouchedSnapshot)
        expect(untouchedControl!.nativeSnapshot()).toEqual(
          untouchedNativeSnapshot
        )
        expect(await merchantWalletState(coldPage, untouchedOrderId)).not.toBe(
          "retired"
        )
      }
      setStage("cold Merchant retains one supplier notification")
      expect(await supplierNoticeCount()).toBe(1)
      setStage("private router keeps public zap history empty")
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
    if (offlineTreasury) {
      const buyerOrderId = new URL(page.url()).searchParams.get("order")
      expect(typeof buyerOrderId === "string" && buyerOrderId.length > 0).toBe(
        true
      )
      setStage("native treasury pre-commit provider transfer matches")
      const beforeCommit = control().nativeSnapshot()
      expect(beforeCommit).toMatchObject({
        nativeSendInvocationCount: 1,
        nativePaymentCount: 1,
        transfers: [
          {
            status: "TRANSFER_STATUS_APPLYING_SENDER_KEY_TWEAK",
            receivers: [{ status: "TRANSFER_RECEIVER_STATUS_INITIATED" }],
          },
        ],
      })
      setStage("native treasury sender commitment applied")
      control().setNativeSenderCommitment(true)
      setStage("sender-committed payment status visible")
      await expect(
        page.getByText("Payment recorded", { exact: true })
      ).toBeVisible({ timeout: 30_000 })
      setStage("sender-committed delivery separation visible")
      await expect(
        page.getByText(
          /Your payment is recorded\. Delivery confirmation is separate/
        )
      ).toBeVisible()

      setStage("sender commitment completes routing without native replay")
      const committedPayments = control().snapshot()
      expect(committedPayments).toEqual({
        fundingInvoiceCount: 1,
        sendInvocationCount: 2,
        outgoingPaymentCount: 2,
        debitedSats: 1_023,
      })
      setStage("sender-committed exact provider transfer matches")
      const committedNative = control().nativeSnapshot()
      expect(committedNative).toMatchObject({
        nativeSendInvocationCount: beforeCommit.nativeSendInvocationCount,
        nativePaymentCount: beforeCommit.nativePaymentCount,
        transfers: [
          {
            status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
            transferDirection: "OUTGOING",
            totalValue: 23,
            receiverIdentityPublicKey: treasuryIdentityPublicKey,
            receivers: [
              {
                identityPublicKey: treasuryIdentityPublicKey,
                amountSats: 23,
                status: "TRANSFER_RECEIVER_STATUS_CLAIM_PENDING",
              },
            ],
          },
        ],
      })
      setStage("sender-committed persisted obligations match")
      await expect
        .poll(() => merchantTerminalReconciliation(page, buyerOrderId), {
          timeout: 30_000,
        })
        .toEqual({ treasuryPaid: true, allLegsPaid: true })

      setStage("sender-committed payment receipt is fully verified")
      const committedReceipt = page.getByRole("region", {
        name: "Payment history",
        includeHidden: true,
      })
      if (!(await committedReceipt.isVisible())) {
        await page
          .locator("details")
          .filter({ has: committedReceipt })
          .locator("summary")
          .click()
      }
      await expect(committedReceipt).toBeVisible()
      await expect(
        committedReceipt.getByText("All checkout payments verified.", {
          exact: true,
        })
      ).toBeVisible()

      setStage("unclaimed receiver keeps encrypted checkout recovery saved")
      await expect(
        page.getByRole("button", { name: "Check wallet cleanup", exact: true })
      ).toHaveCount(0)
      expect(await merchantWalletState(page, buyerOrderId)).toBe("active")
      expect(await hasActiveEncryptedRecovery(page, buyerOrderId)).toBe(true)

      setStage("sender-committed refresh does not replay native payment")
      const refresh = page.getByRole("button", {
        name: "Refresh saved status",
        exact: true,
      })
      await refresh.click()
      await expect(refresh).toBeEnabled()
      await expect(
        page.getByText("Payment recorded", { exact: true })
      ).toBeVisible()
      expect(control().snapshot()).toEqual(committedPayments)
      expect(control().nativeSnapshot()).toEqual(committedNative)
      await expect(
        page.getByRole("button", { name: "Check wallet cleanup", exact: true })
      ).toHaveCount(0)
      expect(await merchantWalletState(page, buyerOrderId)).toBe("active")
      expect(await hasActiveEncryptedRecovery(page, buyerOrderId)).toBe(true)
      bodyCompleted = true
      return
    }
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
      debitedSats: 1_023,
    })
    expect(control().nativeSnapshot()).toMatchObject({
      nativeSendInvocationCount: 1,
      nativePaymentCount: 1,
      transfers: [
        {
          status: "TRANSFER_STATUS_APPLYING_SENDER_KEY_TWEAK",
          transferDirection: "OUTGOING",
          totalValue: 23,
          receiverIdentityPublicKey: treasuryIdentityPublicKey,
          receivers: [
            {
              identityPublicKey: treasuryIdentityPublicKey,
              amountSats: 23,
              status: "TRANSFER_RECEIVER_STATUS_INITIATED",
            },
          ],
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
      setStage("partial execution stop requests buyer pause")
      await page
        .getByRole("button", { name: "Pause payment", exact: true })
        .click()
      setStage("partial execution stop waits for buyer pause")
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
      debitedSats: 1_023,
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
          totalValue: 23,
          receiverIdentityPublicKey: treasuryIdentityPublicKey,
          receivers: [
            {
              identityPublicKey: treasuryIdentityPublicKey,
              amountSats: 23,
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
        receipt.getByText("1,023 sats", { exact: true })
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
        ["Funding credited", "1,023 sats"],
        ["Recorded payouts", "1,023 sats"],
        ["Recorded outgoing fees", "0 sats"],
        ["Recorded total debited", "1,023 sats"],
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

    setStage("paid checkout retains wallet and encrypted recovery")
    const buyerOrderId = new URL(page.url()).searchParams.get("order")
    const cleanup = page.getByRole("button", {
      name: "Check wallet cleanup",
      exact: true,
    })
    await expect(cleanup).toHaveCount(0)
    expect(await merchantWalletState(page, buyerOrderId)).toBe("active")
    expect(await hasActiveEncryptedRecovery(page, buyerOrderId)).toBe(true)
    if (capabilityRegression) {
      setStage("disabled execution preserves complete saved payment history")
      await setIsolatedRouterCapabilities(page, false, false)
      const walletOpensBeforeStop = nativeWalletOpenSuccesses
      await remountIsolatedSavedOrder(page)
      await refresh.click()
      await expect(refresh).toBeEnabled()
      await expect(cleanup).toHaveCount(0)
      await expect(
        page.getByText("Payment recorded", { exact: true })
      ).toBeVisible()
      await assertRecordedReceipt()
      expect(control().snapshot()).toEqual(settled)
      expect(nativeWalletOpenSuccesses).toBe(walletOpensBeforeStop)
      await setIsolatedRouterCapabilities(page, false, true)
      await remountIsolatedSavedOrder(page)
      await refresh.click()
      await expect(refresh).toBeEnabled()
    }
    control().setAdditionalOwnedSats(1)
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(
      page.getByText("Payment recorded", { exact: true })
    ).toBeVisible()
    await assertRecordedReceipt()
    expect(await merchantWalletState(page, buyerOrderId)).toBe("active")
    expect(await hasActiveEncryptedRecovery(page, buyerOrderId)).toBe(true)
    expect(control().snapshot()).toEqual(settled)
    control().setAdditionalOwnedSats(0)
    setStage("retained buyer order survives reload without replay")
    await buyerPersistence.reload()
    await expect(
      page.getByText("Payment recorded", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByText("Order payment verified", { exact: true }).first()
    ).toBeVisible()
    await assertRecordedReceipt()
    await expect(cleanup).toHaveCount(0)
    expect(await merchantWalletState(page, buyerOrderId)).toBe("active")
    expect(await hasActiveEncryptedRecovery(page, buyerOrderId)).toBe(true)
    await refresh.click()
    await expect(refresh).toBeEnabled()
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
        page.getByText("Payment recorded", { exact: true })
      ).toBeVisible()
      await assertRecordedReceipt()
      await selectIsolatedOrder(
        page,
        await page.evaluate(() => crypto.randomUUID())
      )
      await expect(
        page.getByText("Payment recorded", { exact: true })
      ).toHaveCount(0)
      await expect(receipt).toHaveCount(0)
      await selectIsolatedOrder(page, originalOrderId)
      await expect(
        page.getByText("Payment recorded", { exact: true })
      ).toBeVisible({ timeout: 30_000 })
      await assertRecordedReceipt()
      await page
        .getByRole("button", { name: "Open account menu", exact: true })
        .click()
      await page
        .getByRole("menuitem", { name: "Disconnect", exact: true })
        .click()
      await expect(
        page.getByText("Payment recorded", { exact: true })
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

async function rehearseEventRouter(
  browser: Browser,
  continuation:
    "buyer" | "organizer" | "organizer-merchant" | "organizer-replacement",
  buyerMode: "signed-in" | "guest" = "signed-in",
  buyerFunding: "qr" | "nwc" = "qr"
) {
  test.setTimeout(300_000)
  const sharedClock = openPlaywrightRouterClock()
  sharedClock.reset()
  const organizer = createRuntimeSignerIdentity()
  const merchant = createRuntimeSignerIdentity()
  const supplier = createRuntimeSignerIdentity()
  const buyer = createRuntimeSignerIdentity()
  const merchantAddress = "event-merchant@wallet.conduit.market"
  const supplierAddress = "event-supplier@wallet.conduit.market"
  const organizerAddress = "event-organizer@wallet.conduit.market"
  const nwcFunding: {
    proof: {
      identityPublicKey: string
      amountSats: number
      paymentRequest: string
      preimage: string
    } | null
    authorized: boolean
  } = { proof: null, authorized: false }
  const provider = createHermeticRouterProvider({
    recipients: [merchantAddress, supplierAddress, organizerAddress],
    nowSeconds: () => Math.floor(sharedClock.nowMs() / 1_000),
    ...(buyerFunding === "nwc"
      ? {
          onFundingInvoiceIssued(issued: NonNullable<typeof nwcFunding.proof>) {
            if (nwcFunding.proof)
              throw new Error("Expected one native funding invoice.")
            nwcFunding.proof = issued
          },
        }
      : {}),
  })
  const nwc =
    buyerFunding === "nwc"
      ? createDeterministicNwcWallet({
          relayUrl: TEST_RELAY_URL,
          network: "regtest",
          nowSeconds: () => Math.floor(sharedClock.nowMs() / 1_000),
          methods: ["get_info", "get_balance", "pay_invoice"],
          authorizeExternalInvoice(request) {
            const proof = nwcFunding.proof
            if (
              !proof ||
              nwcFunding.authorized ||
              request.invoice !== proof.paymentRequest ||
              (request.amount !== undefined &&
                request.amount !== proof.amountSats * 1_000) ||
              !validateLightningInvoiceForPayment({
                invoice: request.invoice,
                expectedAmountMsats: proof.amountSats * 1_000,
                expectedNetwork: "regtest",
                nowSeconds: Math.floor(sharedClock.nowMs() / 1_000),
              }).ok ||
              createHash("sha256")
                .update(proof.preimage, "hex")
                .digest("hex") !==
                decodeLightningInvoicePaymentHash(request.invoice)
            )
              return null
            const funding = provider.native.control.forIdentity(
              proof.identityPublicKey
            )
            if (funding.snapshot().fundingInvoiceCount !== 1) return null
            funding.completeFunding()
            nwcFunding.authorized = true
            return { preimage: proof.preimage, fees_paid: 0 }
          },
        })
      : null
  const closeProviders = async () => {
    const closed = await Promise.allSettled([
      provider.transport.close(),
      nwc?.close() ?? Promise.resolve(),
    ])
    const failedClose = closed.find((result) => result.status === "rejected")
    if (failedClose?.status === "rejected") throw failedClose.reason
  }
  const contexts: BrowserContext[] = []
  const teardowns: Array<() => void> = []
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
  const recorder = createRouterSmokeRecorder(test.info().annotations)
  let stage: RouterSmokePhase = "event setup"
  let bodyCompleted = false
  let heldOrganizerSend = false
  let releaseOrganizerSend: () => void = () => undefined
  const organizerSendResponse = new Promise<void>((resolve) => {
    releaseOrganizerSend = resolve
  })
  const setStage = (next: RouterSmokePhase) => {
    stage = next
    recorder.phase(next)
  }
  setStage("event setup")
  const contextFor = async (
    identity: RuntimeSignerIdentity,
    appUrl: string
  ) => {
    const context = await browser.newContext({
      serviceWorkers: "block",
      ...(appUrl === marketUrl && buyerMode === "guest"
        ? { viewport: { width: 390, height: 844 } }
        : {}),
    })
    contexts.push(context)
    await context.grantPermissions(["local-network-access"], { origin: appUrl })
    const network = await installHermeticCommerceNetwork(context, {
      ...networkOptions,
      lnurl: provider.lnurl.respond,
      onLocalFailure: recordNetworkFailure,
    })
    teardowns.push(network)
    await installHermeticSparkTransport(
      context,
      {
        async request(command) {
          const result = await provider.transport.request(command)
          if (
            (continuation === "organizer-merchant" ||
              continuation === "organizer-replacement") &&
            identity === organizer &&
            !heldOrganizerSend &&
            command.type === "wallet.call" &&
            command.method === "payLightningInvoice"
          ) {
            // Delay only the external provider response. Its payment really
            // happened; neither actor receives manufactured application proof.
            heldOrganizerSend = true
            await organizerSendResponse
          }
          return result
        },
      },
      { appUrl }
    )
    const page = await context.newPage()
    if (appUrl !== marketUrl || buyerMode !== "guest")
      await installRealTestSigner(page, identity, TEST_RELAY_URL)
    return { page, context }
  }
  try {
    await seedIdentity(organizer, "Isolated Event Organizer", organizerAddress)
    await seedIdentity(merchant, "Isolated Event Merchant", merchantAddress)
    await seedIdentity(supplier, "Isolated Event Supplier", supplierAddress)
    await seedIdentity(buyer, "Isolated Event Buyer")
    const createdAt = Math.floor(sharedClock.nowMs() / 1_000) - 10
    const calendar = signRuntimeTestEvent(organizer, {
      ...buildEventMarketCalendarDraft({
        kind: 31923,
        dTag: "native-event-calendar",
        title: "Isolated Event Fair",
        start: createdAt + 7_200,
        end: createdAt + 10_800,
        locations: ["Public event hall"],
      }),
      created_at: createdAt,
    })
    const calendarCoordinate = `31923:${organizer.pubkey}:native-event-calendar`
    const marketCoordinate = `30409:${organizer.pubkey}:native-event-market`
    const market = signRuntimeTestEvent(organizer, {
      kind: 30409,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", "native-event-market"],
        ["a", calendarCoordinate],
        ["event_market", "2", "open"],
        ["merchant", merchant.pubkey, "organizer_handoff", "Pickup desk"],
        // Existing organizer terms stay valid; only this new checkout's
        // independently versioned Conduit policy loses its minimum.
        ["conduit_event_fee", "1", "active", "250", "10", organizerAddress],
      ],
    })
    const grant = signRuntimeTestEvent(organizer, {
      kind: 3841,
      created_at: createdAt,
      content: "",
      tags: [
        ["openmarkets", "event-market-auth", "1"],
        ["a", marketCoordinate],
        ["p", merchant.pubkey],
        ["state", "active"],
        ["seq", "0"],
        ["alt", "Open Markets event merchant authorization"],
      ],
    })
    const productTitle = "Isolated Event Mug"
    const productCoordinate = `30402:${merchant.pubkey}:native-event-product`
    const listing = signRuntimeTestEvent(merchant, {
      kind: 30402,
      created_at: createdAt,
      content: "Offline event checkout rehearsal.",
      tags: [
        ["d", "native-event-product"],
        ["title", productTitle],
        ["summary", "Offline event checkout rehearsal."],
        ["price", "1000", "SATS"],
        ["type", "simple", "physical"],
        ["stock", "3"],
        ["image", imageUrl],
        ["t", "commerce"],
        ["t", "hermetic"],
        ["conduit_supplier_allocation", "1"],
        ["zap", merchant.pubkey, merchantProfileRelay, "3"],
        ["zap", supplier.pubkey, supplierProfileRelay, "1"],
      ],
    })
    await publishTestRelayEvents([calendar, market, grant, listing])
    const eventPath = `/events/${nip19.naddrEncode({ kind: 30409, pubkey: organizer.pubkey, identifier: "native-event-market", relays: [TEST_RELAY_URL] })}`
    const { page: merchantPage } = await contextFor(merchant, merchantUrl)
    const organizerSession = await contextFor(organizer, merchantUrl)
    let organizerPage = organizerSession.page
    setStage("event occurrence assignment")
    await merchantPage.goto(
      `${merchantUrl}/products?eventMarket=${eventPath.split("/").at(-1)}`
    )
    const assignments = merchantPage.getByRole("region", {
      name: "Occurrence assignments",
      exact: true,
    })
    setStage("event occurrence date selection")
    await assignments
      .getByRole("combobox", { name: "Event date", exact: true })
      .click()
    await merchantPage
      .getByRole("option", { name: /Isolated Event Fair/ })
      .click()
    setStage("event occurrence product selection")
    await assignments
      .getByRole("combobox", { name: "Product or variation", exact: true })
      .click()
    await merchantPage
      .getByRole("option", { name: productTitle, exact: true })
      .click()
    setStage("event occurrence allocation submission")
    await assignments
      .getByRole("textbox", { name: "Pickup allocation", exact: true })
      .fill("2")
    await assignments
      .getByRole("button", { name: "Add to event", exact: true })
      .click()
    await expect
      .poll(
        async () =>
          (
            await readTestRelayEvents({
              kinds: [30410],
              authors: [merchant.pubkey],
            })
          ).length
      )
      .toBe(1)
    setStage("event organizer device selection")
    await organizerPage.goto(`${merchantUrl}${eventPath}`)
    await organizerPage
      .getByRole("button", {
        name: "Set up pickup here",
        exact: true,
      })
      .click()
    await expect(
      organizerPage.getByText(
        "Pickup is set up here. Copy the setup code and share it with the seller.",
        { exact: true }
      )
    ).toBeVisible({ timeout: 30_000 })
    await organizerPage
      .locator("summary")
      .filter({ hasText: "Technical pickup details" })
      .click()
    const writerId = await organizerPage
      .getByRole("textbox", { name: "Pickup setup code", exact: true })
      .inputValue()
    setStage("event reserved stock Merchant page")
    await merchantPage.goto(`${merchantUrl}${eventPath}`)
    setStage("event reserved stock product selector")
    await merchantPage
      .getByRole("combobox", {
        name: "Stock for organizer pickup",
        exact: true,
      })
      .click()
    setStage("event reserved stock product selection")
    await merchantPage
      .getByRole("option", { name: /native-event-product/ })
      .click()
    setStage("event reserved stock quantity entry")
    await merchantPage
      .getByRole("textbox", { name: "Quantity to reserve", exact: true })
      .fill("2")
    setStage("event reserved stock pickup setup entry")
    await merchantPage
      .getByRole("textbox", {
        name: "Pickup setup code from organizer",
        exact: true,
      })
      .fill(writerId)
    setStage("event reserved stock grant submission")
    await merchantPage
      .getByRole("button", {
        name: "Reserve stock for organizer",
        exact: true,
      })
      .click()
    setStage("event reserved stock grant saved notice")
    await expect(
      merchantPage.getByText(/exact stock reservation is saved/)
    ).toBeVisible()
    setStage("event reserved stock Organizer refresh")
    await organizerPage
      .getByRole("button", {
        name: "Check for stock updates",
        exact: true,
      })
      .click()
    setStage("event reserved stock Organizer acceptance")
    const stockAcceptanceDeadline = Date.now() + 15_000
    const stockActionTimeout = () => {
      const remaining = stockAcceptanceDeadline - Date.now()
      if (remaining <= 0)
        throw new Error("Isolated stock acceptance deadline elapsed.")
      return remaining
    }
    const acceptReservedStock = organizerPage.getByRole("button", {
      name: "Accept reserved stock",
      exact: true,
    })
    // A first discovery page may only inspect retained wrappers. Follow the
    // advertised next page, not another fresh read or reservation, within the
    // original acceptance action's total deadline. Empty/unavailable is not
    // permission to accept, and a disabled wrong-device grant stays blocked.
    for (let page = 1; page < 32; page++) {
      let nextAction = "waiting"
      await expect
        .poll(
          async () => {
            nextAction = await organizerPage
              .getByRole("button", {
                name: /^(Accept reserved stock|Check more stock history)$/,
              })
              .evaluateAll((buttons) => {
                const available = buttons.filter(
                  (button) =>
                    !button.matches(":disabled") &&
                    button.getAttribute("aria-disabled") !== "true" &&
                    button.getClientRects().length > 0 &&
                    getComputedStyle(button).visibility !== "hidden"
                )
                if (
                  available.some(
                    (button) =>
                      button.textContent?.trim() === "Accept reserved stock"
                  )
                )
                  return "accept"
                return available.length ? "more" : "waiting"
              })
            return nextAction !== "waiting"
          },
          { timeout: stockActionTimeout() }
        )
        .toBe(true)
      if (nextAction === "accept") break
      if (
        await organizerPage
          .getByText(
            "Private stock messages are unavailable. Saved stock remains unchanged.",
            { exact: true }
          )
          .isVisible()
      )
        throw new Error("Isolated stock discovery is unavailable.")
      await organizerPage
        .getByRole("button", {
          name: "Check more stock history",
          exact: true,
        })
        .click({ timeout: stockActionTimeout() })
    }
    await acceptReservedStock.click({ timeout: stockActionTimeout() })
    setStage("event reserved stock ready notice")
    await expect(
      organizerPage.getByText(/Reserved stock is ready for pickup here/)
    ).toBeVisible()
    setStage("event buyer checkout")
    const { page: buyerPage, context: buyerContext } = await contextFor(
      buyer,
      marketUrl
    )
    if (nwc) {
      await nwc.start()
      await buyerPage.goto(`${marketUrl}/wallet`)
      await nwc.configureMerchantConnection(async (connectionString) => {
        await openWalletSetup(buyerPage, "Connect wallet")
        await buyerPage
          .getByLabel("Wallet label", { exact: true })
          .fill("Event Buyer NWC")
        await buyerPage
          .getByLabel("NWC connection string", { exact: true })
          .fill(connectionString)
        await buyerPage
          .getByRole("button", { name: "Connect", exact: true })
          .click()
      })
      await expect(
        buyerPage.getByRole("article", {
          name: "Event Buyer NWC wallet",
          exact: true,
        })
      ).toBeVisible()
    }
    await buyerPage.goto(`${marketUrl}${eventPath}`)
    setStage("event buyer catalog admission")
    const product = buyerPage
      .getByRole("listitem")
      .filter({ hasText: productTitle })
    setStage("buyer catalog product visibility")
    await expect(product).toBeVisible({ timeout: 30_000 })
    setStage("buyer add product to cart")
    await expect(
      product.getByRole("button", {
        name: `Add ${productTitle} to cart`,
        exact: true,
      })
    ).toBeEnabled({ timeout: 30_000 })
    await product
      .getByRole("button", { name: `Add ${productTitle} to cart`, exact: true })
      .click()
    setStage("event buyer cart checkout")
    await buyerPage
      .getByRole("region", { name: "Cart inventory", exact: true })
      .getByRole("link", { name: "Continue to checkout", exact: true })
      .click()
    setStage("event buyer price presentation")
    if (buyerMode === "guest") {
      setStage("event guest contact-free fields")
      await buyerPage
        .getByRole("checkbox", { name: "Use a name only for handoff" })
        .check()
      await buyerPage
        .getByRole("textbox", { name: "Name or pseudonym for handoff" })
        .fill("Event visitor")
      let receiptDownloads = 0
      buyerPage.on("download", () => {
        receiptDownloads += 1
      })
      await buyerPage
        .getByRole("button", { name: "Show private receipt", exact: true })
        .click()
      await expect(
        buyerPage.getByRole("region", { name: "Private pickup receipt" })
      ).toBeVisible()
      expect(receiptDownloads).toBe(0)
      await buyerPage
        .getByRole("checkbox", { name: "I saved my private receipt" })
        .check()
      await expect(buyerPage.locator("#ship-email")).toHaveCount(0)
      await expect(buyerPage.locator("#ship-phone")).toHaveCount(0)
      await expect(buyerPage.getByLabel(/Street address/i)).toHaveCount(0)
      setStage("event mobile checkout layout")
      expect(
        await buyerPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1
        )
      ).toBe(true)
    }
    const checkoutPrice = buyerPage.getByRole("region", {
      name: "Order price",
      exact: true,
    })
    setStage("event organizer fee disclosure")
    await expect(
      checkoutPrice.getByText("Event organizer fee", { exact: true })
    ).toBeVisible()
    await expect(checkoutPrice.getByText("₿25", { exact: true })).toBeVisible()
    await expect(
      checkoutPrice.getByText("₿1,048", { exact: true })
    ).toBeVisible()
    setStage("event buyer plan preparation")
    await buyerPage
      .getByRole("button", { name: "Continue to payment", exact: true })
      .click()
    await expect(buyerPage).toHaveURL(/\/orders(?:\?|$)/, { timeout: 45_000 })
    const orderId = new URL(buyerPage.url()).searchParams.get("order")
    if (!orderId) throw new Error("Expected event order selection.")
    const timing = await frozenRouterTiming(buyerPage, orderId)
    if (!timing) throw new Error("Expected frozen event deadlines.")
    expect(await hasCurrentConduitFeePolicy(buyerPage, orderId)).toBe(true)
    expect(await hasActiveEncryptedRecovery(buyerPage, orderId)).toBe(true)
    expect(provider.control().snapshot()).toMatchObject({
      fundingInvoiceCount: 1,
      sendInvocationCount: 0,
    })
    setStage("event buyer funding authorization")
    if (nwc) {
      provider.control().setNativeCompletion(false)
      provider.control().setNativeSenderCommitment(true)
      await buyerPage.getByLabel("Pay with", { exact: true }).click()
      await buyerPage.getByRole("option", { name: /Event Buyer NWC/ }).click()
      const pay = buyerPage.getByRole("button", {
        name: "Pay for order",
        exact: true,
      })
      await expect(pay).toBeEnabled()
      await pay.click()
    } else {
      await buyerPage
        .getByRole("button", { name: "Show QR code", exact: true })
        .click()
      await expect(
        buyerPage.getByText(/Pay once, then return here to check progress/)
      ).toBeVisible()
      if (buyerMode === "guest")
        expect(
          await buyerPage.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1
          )
        ).toBe(true)
      provider.control().setNativeCompletion(false)
      provider.control().setNativeSenderCommitment(true)
    }
    if (continuation === "buyer") {
      setStage("event buyer automatic payment routing")
      if (!nwc) provider.control().completeFunding()
      setStage("event buyer payment completion visible")
      await expect(
        buyerPage.getByText("Payment recorded", { exact: true })
      ).toBeVisible({ timeout: 60_000 })
      setStage("event buyer exact Lightning payments verified")
      expect(provider.control().snapshot()).toEqual({
        fundingInvoiceCount: 1,
        sendInvocationCount: 3,
        outgoingPaymentCount: 3,
        debitedSats: 1_048,
      })
      setStage("event buyer exact native payment verified")
      expect(
        provider.control().nativeSnapshot().nativeSendInvocationCount
      ).toBe(1)
      if (nwc) {
        setStage("event buyer connected funding paid once")
        await expect(
          buyerPage.getByText(/active buyer session stopped/)
        ).toHaveCount(0)
        expect(nwcFunding.authorized).toBe(true)
        expect(nwc.snapshot().counters).toMatchObject({
          payInvoice: 1,
          makeInvoice: 0,
        })
        expect(nwc.snapshot().invoiceState).toBe("none")
      }
    }
    // Closing never creates another payment. Organizer reconciles the same
    // exact attempts, whether Buyer already sent them or disappeared before credit.
    teardowns[2]!()
    await buyerContext.close()
    if (continuation !== "buyer") provider.control().completeFunding()
    setStage("event organizer observes the buyer cutoff")
    await organizerPage.clock.install({ time: new Date(sharedClock.nowMs()) })
    await organizerPage
      .getByRole("button", { name: "Refresh saved event orders", exact: true })
      .click()
    await organizerPage
      .getByRole("button", {
        name: new RegExp(`Open saved order ${orderId.slice(-8)}$`),
      })
      .click()
    setStage("event exact pickup claim and handout")
    const handoutItems = organizerPage.getByRole("region", {
      name: "Items to hand out",
      exact: true,
    })
    await expect(
      handoutItems.getByText(productTitle, { exact: true })
    ).toBeVisible()
    await expect(handoutItems.getByText("Qty 1", { exact: true })).toBeVisible()
    setStage("event organizer observes the buyer cutoff")
    const continueOrder = organizerPage.getByRole("button", {
      name: "Continue this order",
      exact: true,
    })
    await expect(continueOrder).toBeDisabled()
    const advanceMs = timing.takeoverAt - sharedClock.nowMs() + 1_000
    expect(advanceMs).toBeGreaterThan(0)
    sharedClock.advanceBy(advanceMs)
    await organizerPage.clock.fastForward(advanceMs)
    await merchantPage.clock.install({ time: new Date(sharedClock.nowMs()) })
    // The boundary timer must enable the already-open card; no reload or click.
    await expect(continueOrder).toBeEnabled()
    setStage("event organizer automatic payment routing")
    await continueOrder.click()
    if (
      continuation === "organizer-merchant" ||
      continuation === "organizer-replacement"
    ) {
      setStage(
        "buyer disappears after commerce and before the remaining payment"
      )
      await expect
        .poll(() => provider.control().snapshot().outgoingPaymentCount, {
          timeout: 30_000,
        })
        .toBe(1)
      expect(heldOrganizerSend).toBe(true)
      setStage("partial execution stop requests buyer pause")
      await organizerPage
        .getByRole("button", { name: "Pause this order", exact: true })
        .click()
      releaseOrganizerSend()
      setStage("partial execution stop waits for buyer pause")
      await expect(
        organizerPage.getByRole("button", {
          name: "Pause this order",
          exact: true,
        })
      ).toHaveCount(0, { timeout: 30_000 })
      await expect(
        organizerPage.getByRole("button", {
          name: "Continue this order",
          exact: true,
        })
      ).toBeEnabled()
      setStage("partial execution stop preserves provider and wallet counters")
      expect(provider.control().snapshot().sendInvocationCount).toBe(1)
      if (continuation === "organizer-merchant") {
        await organizerPage.close()
        // A fresh Merchant session has neither Organizer stock-writer state nor
        // Buyer storage. It must authenticate the original order and exact
        // Organizer progress, independently check that send, then finish once.
        setStage("cold Merchant discovers the signed recovery")
        const coldMerchant = await contextFor(merchant, merchantUrl)
        await coldMerchant.page.clock.install({
          time: new Date(sharedClock.nowMs()),
        })
        await coldMerchant.page.goto(
          `${merchantUrl}/orders?order=${orderId}&recovery=paused`
        )
        const recovery = coldMerchant.page.getByRole("region", {
          name: "Order payment",
          exact: true,
        })
        await expect(recovery).toBeVisible({ timeout: 45_000 })
        setStage("cold Merchant retains the exact admitted recovery witness")
        await expect
          .poll(() => merchantRecoveryAdmission(coldMerchant.page, orderId), {
            timeout: 30_000,
          })
          .toMatchObject({ uniqueWitness: true, sourcesValidated: true })
        setStage(
          "cold Merchant automatically continues after handoff without a prompt"
        )
        await recovery
          .getByRole("button", { name: "Continue this order", exact: true })
          .click()
        // Keep the original 60-second bound and final exact count. Separate
        // no continuation from a remaining-leg stop without exposing payments.
        const continuationDeadline = Date.now() + 60_000
        try {
          setStage("cold Merchant resumes the next Lightning payout")
          await expect
            .poll(() => provider.control().snapshot().sendInvocationCount, {
              timeout: Math.max(1, continuationDeadline - Date.now()),
            })
            .toBeGreaterThanOrEqual(2)
          setStage("cold Merchant completes remaining Lightning payouts")
          await expect
            .poll(() => provider.control().snapshot().sendInvocationCount, {
              timeout: Math.max(1, continuationDeadline - Date.now()),
            })
            .toBe(3)
        } catch (cause) {
          const failedPayoutStage = stage
          // Inspect only fixed product copy after the original assertion has
          // failed. No raw DOM, notices, provider values or error text escapes.
          for (const [fixedNotice, diagnosticStage] of [
            [
              "We need the original order before payment processing can continue. Check again when your order history is available.",
              "cold Merchant continuation has original order authority",
            ],
            [
              "The payment check could not finish. Your saved progress is kept and checks will retry. Do not request another payment.",
              "cold Merchant continuation has available payment checks",
            ],
            [
              "The recipient for a saved payment could not be verified. Review the saved payment details before continuing. Do not request another payment.",
              "cold Merchant continuation has verified recipients",
            ],
            [
              "The saved payout invoice has expired. A replacement is allowed only after the exact previous attempt is closed and its funds are confirmed returned and spendable. Do not request another buyer payment.",
              "cold Merchant continuation is not awaiting invoice renewal",
            ],
            [
              "Payment processing needs a closer look. Check the saved payment before taking another action.",
              "cold Merchant continuation needs no payment attention",
            ],
            [
              "Automatic payments are paused. A payment already sent may still finish.",
              "cold Merchant continuation is not paused",
            ],
            [
              "The coordination fee needs attention. This order remains paid and fulfillment can continue.",
              "cold Merchant remaining fees need no attention",
            ],
            [
              "Coordination fee processing is paused. This order remains paid.",
              "cold Merchant remaining fee processing is not paused",
            ],
          ] as const) {
            setStage(diagnosticStage)
            expect(
              await recovery.getByText(fixedNotice, { exact: true }).count()
            ).toBe(0)
          }
          setStage(
            "cold Merchant provider completed the second Lightning payout"
          )
          expect(
            provider.control().snapshot().outgoingPaymentCount
          ).toBeGreaterThanOrEqual(2)
          setStage(
            "cold Merchant saved independently verified commerce payments"
          )
          const recorded = await merchantRecordedCompletion(
            coldMerchant.page,
            merchant.pubkey,
            orderId
          )
          expect(recorded?.commerceVerified).toBe(true)
          expect(recorded?.paidCommerceCount).toBeGreaterThanOrEqual(2)
          setStage("cold Merchant next unpaid recipient is organizer")
          const remaining = await merchantRemainingPayoutEvidence(
            coldMerchant.page,
            orderId
          )
          expect(remaining?.nextUnpaidIsOrganizer).toBe(true)
          setStage("cold Merchant prepared the remaining organizer payout")
          expect(remaining?.nextUnpaidHasIntent).toBe(true)
          setStage("cold Merchant staged exact current progress")
          expect(remaining?.exactProgressStaged).toBe(true)
          setStage(
            "cold Merchant exact current progress has a self acknowledgement"
          )
          expect(remaining?.exactProgressSelfAccepted).toBe(true)
          setStage("cold Merchant fresh discovery matches prepared progress")
          expect(remaining?.freshMatchesPrepared).toBe(true)
          setStage(
            "cold Merchant fresh discovery can select the prepared payout"
          )
          expect(remaining?.freshSelectionReady).toBe(true)
          setStage(failedPayoutStage)
          throw cause
        }
        setStage("cold Merchant submits the final native treasury transfer")
        await expect
          .poll(
            () => provider.control().nativeSnapshot().nativeSendInvocationCount,
            { timeout: 30_000 }
          )
          .toBe(1)
        setStage(
          "cold Merchant completes payment while retaining checkout recovery"
        )
        await expect(
          recovery.getByText(
            "Payment complete. The checkout wallet and recovery remain saved with this order.",
            { exact: true }
          )
        ).toBeVisible({ timeout: 60_000 })
        expect(provider.control().snapshot().sendInvocationCount).toBe(3)
        expect(
          provider.control().nativeSnapshot().nativeSendInvocationCount
        ).toBe(1)
        teardowns.at(-1)!()
        await coldMerchant.context.close()

        // Restore the original designated stock device. Merchant financial
        // completion must be observable without granting it physical handout.
        setStage("event organizer recovery page reopening")
        organizerPage = await organizerSession.context.newPage()
        await installRealTestSigner(organizerPage, organizer, TEST_RELAY_URL)
        await organizerPage.clock.install({
          time: new Date(sharedClock.nowMs()),
        })
        await organizerPage.goto(`${merchantUrl}${eventPath}`)
      } else {
        // Registration is not authority. Only the complete positive transfer
        // from the quiesced source may activate this independent fresh device.
        setStage("event replacement device registration")
        const replacement = await contextFor(organizer, merchantUrl)
        await replacement.page.clock.install({
          time: new Date(sharedClock.nowMs()),
        })
        await replacement.page.goto(`${merchantUrl}${eventPath}`)
        await replacement.page
          .locator("summary")
          .filter({ hasText: "Move pickup to another device (advanced)" })
          .click()
        await replacement.page
          .getByRole("button", {
            name: "Prepare replacement device",
            exact: true,
          })
          .click()
        await expect(
          replacement.page.getByText(
            "Replacement device is prepared. Copy its ID to the original device; no stock or payment authority has moved yet.",
            { exact: true }
          )
        ).toBeVisible({ timeout: 30_000 })
        await replacement.page
          .locator("summary")
          .filter({ hasText: "Technical pickup details" })
          .click()
        const targetId = await replacement.page
          .getByRole("textbox", {
            name: "Replacement device handover ID",
            exact: true,
          })
          .inputValue()
        setStage("event source device handover")
        await organizerPage
          .locator("summary")
          .filter({ hasText: "Move pickup to another device (advanced)" })
          .click()
        await organizerPage
          .getByRole("textbox", { name: "Replacement device ID", exact: true })
          .fill(targetId)
        await organizerPage
          .getByRole("checkbox", {
            name: "I understand this stops stock sales and pickup on this device",
            exact: true,
          })
          .check()
        await organizerPage
          .getByRole("button", {
            name: "Freeze this device and send handover",
            exact: true,
          })
          .click()
        setStage("event retired device cannot continue")
        await expect(
          organizerPage.getByText(
            "Pickup has moved from this browser. Continue on the replacement; do not hand out orders here.",
            { exact: true }
          )
        ).toBeVisible()
        await expect(
          organizerPage.getByRole("button", {
            name: "Continue this order",
            exact: true,
          })
        ).toHaveCount(0)
        expect(provider.control().snapshot().sendInvocationCount).toBe(1)
        // Retirement precedes external signing/publication. Its visible fence
        // is not a relay ACK and cannot promise fresh target discovery yet.
        setStage("event source device handover")
        await expect(
          organizerPage.getByText(
            "The exact complete handover was sent privately to your account. Verify and restore it on the prepared replacement device.",
            { exact: true }
          )
        ).toBeVisible({ timeout: 45_000 })
        setStage("event replacement transfer discovery")
        await replacement.page
          .getByRole("button", {
            name: "Check for stock updates",
            exact: true,
          })
          .click()
        await replacement.page
          .locator("summary")
          .filter({ hasText: "Recover saved stock history (advanced)" })
          .click()
        const restoreHandover = replacement.page.getByRole("button", {
          name: "Verify and restore complete handover",
          exact: true,
        })
        // The existing reader first processes retained history, then advertises
        // bounded continuation. Follow those pages, not an implicit fresh read.
        const historyCheck = replacement.page.getByRole("button", {
          name: /^(?:Check for stock updates|Check more stock history)$/,
        })
        const moreHistory = replacement.page.getByRole("button", {
          name: "Check more stock history",
          exact: true,
        })
        for (let page = 0; page < 32; page++) {
          await expect(historyCheck).toBeEnabled({ timeout: 30_000 })
          if (await restoreHandover.isVisible()) break
          if (!(await moreHistory.isVisible())) break
          await moreHistory.click()
        }
        await expect(restoreHandover).toBeVisible({ timeout: 30_000 })
        setStage("event replacement transfer activation")
        await restoreHandover.click()
        setStage("event replacement writer projection")
        await expect(
          replacement.page.getByRole("textbox", {
            name: "Pickup setup code",
            exact: true,
          })
        ).toHaveValue(writerId, { timeout: 30_000 })
        organizerPage = replacement.page
      }
      setStage("event organizer saved orders refresh")
      await organizerPage
        .getByRole("button", {
          name: "Refresh saved event orders",
          exact: true,
        })
        .click()
      setStage("event organizer saved order selection")
      await organizerPage
        .getByRole("button", {
          name: new RegExp(`Open saved order ${orderId.slice(-8)}$`),
        })
        .click()
      setStage("event organizer restored continuation")
      await organizerPage
        .getByRole("button", { name: "Continue this order", exact: true })
        .click()
    }
    setStage("event organizer payment completion observation")
    await expect
      .poll(
        async () => {
          if (
            await organizerPage
              .getByText(/Payment routing is complete/)
              .isVisible()
          )
            return true
          if (
            await organizerPage
              .getByText("Needs attention", { exact: true })
              .isVisible()
          ) {
            if (
              await organizerPage
                .getByText(
                  "Reserve this complete organizer order before routing.",
                  { exact: true }
                )
                .isVisible()
            )
              setStage("event organizer stock authority rejected")
            else if (
              await organizerPage
                .getByText(
                  "Exact organizer checkout recovery requires reconciliation.",
                  { exact: true }
                )
                .isVisible()
            )
              setStage("event organizer recovery authority rejected")
            else if (
              await organizerPage
                .getByText("Organizer checkout destination is unavailable.", {
                  exact: true,
                })
                .isVisible()
            )
              setStage("event organizer destination rejected")
            else if (provider.control().snapshot().sendInvocationCount === 0)
              setStage("event organizer routing stopped before sends")
            else if (provider.control().snapshot().outgoingPaymentCount < 3)
              setStage("event organizer routing stopped during commerce")
            else if (
              provider.control().nativeSnapshot().nativeSendInvocationCount ===
              0
            )
              setStage("event organizer native submission pending")
            else setStage("event organizer native verification pending")
            throw new Error("Organizer routing requires attention.")
          }
          return false
        },
        { timeout: 60_000 }
      )
      .toBe(true)
    await expect(
      organizerPage.getByText("Ready for pickup", { exact: true })
    ).toBeVisible()
    expect(provider.control().snapshot()).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 3,
      outgoingPaymentCount: 3,
      debitedSats: 1_048,
    })
    expect(provider.control().nativeSnapshot()).toMatchObject({
      nativeSendInvocationCount: 1,
      nativePaymentCount: 1,
      transfers: [
        {
          status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
          receiverIdentityPublicKey: treasuryIdentityPublicKey,
          totalValue: 24,
          receivers: [
            {
              amountSats: 24,
              status: "TRANSFER_RECEIVER_STATUS_CLAIM_PENDING",
            },
          ],
        },
      ],
    })
    const payoutFacts = provider
      .control()
      .outgoingInvoices()
      .map((invoice) => {
        const issued = provider.issued.get(invoice)
        return (
          issued && {
            lud16: issued.lud16,
            amountSats: issued.amountSats,
            feeSats: issued.feeSats,
          }
        )
      })
    expect(payoutFacts).toEqual([
      { lud16: merchantAddress, amountSats: 751, feeSats: 0 },
      { lud16: supplierAddress, amountSats: 249, feeSats: 0 },
      { lud16: organizerAddress, amountSats: 24, feeSats: 0 },
    ])
    setStage("event exact pickup claim and handout")
    const claimCode = formatEventMarketPickupClaimCode(
      getFutureMarketClaimRef({
        orderId,
        merchantPubkey: merchant.pubkey,
        organizerPubkey: organizer.pubkey,
        marketCoordinate,
      })
    )
    await organizerPage
      .getByRole("textbox", { name: "Buyer's pickup code", exact: true })
      .fill(claimCode)
    await organizerPage
      .getByRole("button", {
        name: "Confirm code and hand out once",
        exact: true,
      })
      .click()
    await expect(
      organizerPage.getByText(/Handout recorded/).first()
    ).toBeVisible()
    await expect(
      organizerPage.getByRole("button", {
        name: "Confirm code and hand out once",
        exact: true,
      })
    ).toHaveCount(0)
    await organizerPage
      .getByRole("button", {
        name: "Stop new sales and close reserved stock",
        exact: true,
      })
      .click()
    await expect(
      organizerPage.getByText(/New sales are stopped for this pool/)
    ).toBeVisible()
    setStage("event Merchant once-only stock reconciliation")
    const stockHistoryCheck = merchantPage.getByRole("button", {
      name: /^(?:Check for stock updates|Check more stock history)$/,
    })
    const moreStockHistory = merchantPage.getByRole("button", {
      name: "Check more stock history",
      exact: true,
    })
    await stockHistoryCheck.click()
    // Retained acceptance may precede relay handout and closing history. Finish
    // the advertised pages before the first import, not after a partial import.
    for (let page = 0; page < 32; page++) {
      await expect(stockHistoryCheck).toBeEnabled({ timeout: 30_000 })
      if (!(await moreStockHistory.isVisible())) break
      await moreStockHistory.click()
    }
    await expect(stockHistoryCheck).toBeEnabled({ timeout: 30_000 })
    await expect(moreStockHistory).toBeHidden()
    await expect(
      merchantPage.getByText(
        "The bounded message check finished. Saved stock remains authoritative; older history may still exist elsewhere.",
        { exact: true }
      )
    ).toBeVisible()
    await merchantPage
      .getByRole("button", {
        name: "Reconcile accepted order stock",
        exact: true,
      })
      .click()
    await expect(
      merchantPage.getByText(
        /exact accepted order and handout are reconciled once/
      )
    ).toBeVisible()
    await merchantPage
      .getByRole("button", {
        name: "Reconcile accepted order stock",
        exact: true,
      })
      .click()
    await expect(merchantPage.getByText(/already reconciled/)).toBeVisible()
    await merchantPage
      .getByRole("button", {
        name: "Review closed stock and release unused quantity",
        exact: true,
      })
      .click()
    await expect(
      merchantPage.getByText(/complete closing history is reconciled/)
    ).toBeVisible()
    const databasePath = viteFileModuleUrl(
      fileURLToPath(
        new URL("../packages/core/src/db/index.ts", import.meta.url)
      )
    )
    expect(
      await merchantPage.evaluate(
        async ({ databasePath, productCoordinate, orderId }) => {
          const { db } = await import(/* @vite-ignore */ databasePath)
          const product =
            await db.merchantInventoryProducts.get(productCoordinate)
          const accepted = await db.merchantInventoryAcceptedOrders.get(orderId)
          return {
            stock: product?.stock,
            accepted: !!accepted?.organizerImport,
          }
        },
        { databasePath, productCoordinate, orderId }
      )
    ).toEqual({ stock: 2, accepted: true })
    expect(provider.control().snapshot().sendInvocationCount).toBe(3)
    expect(provider.control().nativeSnapshot().nativeSendInvocationCount).toBe(
      1
    )
    expect((await readTestRelayEvents({ kinds: [9734, 9735] })).length).toBe(0)
    if (nwc)
      expect(nwc.snapshot().counters).toMatchObject({
        payInvoice: 1,
        makeInvoice: 0,
      })
    bodyCompleted = true
  } catch {
    recorder.failed()
    throw new Error(`Isolated Event router smoke failed during ${stage}.`)
  } finally {
    releaseOrganizerSend()
    recorder.teardown(bodyCompleted)
    for (const teardown of teardowns) teardown()
    await Promise.allSettled(
      contexts.map(async (context) => {
        await context.setOffline(true).catch(() => undefined)
        await context.unrouteAll({ behavior: "wait" }).catch(() => undefined)
        await context.close()
      })
    )
    sharedClock.reset()
    try {
      await closeProviders()
    } finally {
      nwcFunding.proof = null
      for (const identity of [organizer, merchant, supplier, buyer])
        disposeRuntimeSignerIdentity(identity)
      recorder.complete()
    }
  }
}

test("native router Event Market checkout hands funded routing to the organizer and reconciles one physical handout @commerce", async ({
  browser,
}) => rehearseEventRouter(browser, "organizer"))

test("native router Event Market Buyer completes all payments before organizer pickup without replaying any transfer @commerce", async ({
  browser,
}) => rehearseEventRouter(browser, "buyer"))

test("native router Event Market Buyer funds once through its connected NWC wallet and completes all payments before organizer pickup @commerce", async ({
  browser,
}) => rehearseEventRouter(browser, "buyer", "signed-in", "nwc"))

test("native router Event Market Merchant finishes an interrupted Organizer payout and returns exact progress for one handout @commerce", async ({
  browser,
}) => rehearseEventRouter(browser, "organizer-merchant"))

test("native router Event Market mobile guest pays one external invoice and the Organizer finishes pickup without login or contact fields @commerce", async ({
  browser,
}) => rehearseEventRouter(browser, "buyer", "guest"))

test("native router Event Market replacement device resumes a complete transferred journal and exact partial payment without a second handout @commerce", async ({
  browser,
}) => rehearseEventRouter(browser, "organizer-replacement"))

test("native router records sender-committed treasury payment while receiver claim remains pending and recovery stays saved @commerce", async ({
  browser,
}) => rehearseRouter(browser, "buyer", "signed-in", null, false, false, true))

test("native router cold Merchant restores a funded checkout and finishes all payouts without the buyer @commerce", async ({
  browser,
}) => rehearseRouter(browser, "cold-merchant"))

test("native router cold Merchant independently verifies supported recipients and finishes a partial checkout without replaying paid commerce @commerce", async ({
  browser,
}) => rehearseRouter(browser, "partial-cold-merchant"))

test("native router scoped Merchant continuation finishes only the selected funded order with truthful progress @commerce", async ({
  browser,
}) => rehearseRouter(browser, "cold-merchant", "signed-in", null, false, true))

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
