import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { installHermeticCommerceNetwork } from "./helpers/hermetic-network"
import { installMerchantDiscoveryContinuationModules } from "./helpers/merchant-discovery-continuation"
import { viteFileModuleUrl } from "./helpers/vite-file-module-url"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const fixtureModuleUrl = viteFileModuleUrl(
  resolve("e2e/fixtures/merchant-discovery-continuation.ts")
)

test("selected Merchant recovery continues once after an empty partial rediscovery page @merchant", async ({
  browser,
}) => {
  const relayPort = process.env.PLAYWRIGHT_RELAY_PORT
  if (!relayPort || relayPort === "0") {
    throw new Error("Mounted Merchant continuation requires its local relay.")
  }
  const context = await browser.newContext({ serviceWorkers: "block" })
  let beginTeardown: () => void = () => undefined
  let removeModuleFixtures: () => Promise<void> = async () => undefined
  let stage = "isolated mounted-panel setup"
  try {
    beginTeardown = await installHermeticCommerceNetwork(context, {
      appUrls: [marketUrl, merchantUrl],
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      imageUrl: "https://merchant-discovery-continuation.invalid/fixture.svg",
    })
    removeModuleFixtures = await installMerchantDiscoveryContinuationModules(
      context,
      fixtureModuleUrl
    )
    const page = await context.newPage()
    await page.goto(`${merchantUrl}/privacy-policy`)

    stage = "actual recovery panel mounted"
    await page.evaluate(async (fixtureUrl) => {
      const randomHex = () =>
        Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")
      const merchantPubkey = randomHex()
      const buyerPubkey = randomHex()
      const orderId = crypto.randomUUID()
      const candidate = {
        orderId,
        initialBuyerPubkey: buyerPubkey,
        checkoutId: crypto.randomUUID(),
        planDigest: randomHex(),
        wrapId: randomHex(),
        schemaVersion: 3 as const,
        takeoverAt: 0,
        preparedAt: 0,
      }
      const fixture = await import(fixtureUrl)
      fixture.configureMerchantDiscoveryContinuationFixture({
        principalPubkey: merchantPubkey,
        candidate,
      })
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const panelModuleUrl = "/src/components/CheckoutSparkRecoveryPanel.tsx"
      const { CheckoutSparkRecoveryPanel } = await import(panelModuleUrl)
      const host = document.createElement("div")
      host.id = "merchant-discovery-continuation-fixture"
      document.body.append(host)
      ReactDOM.createRoot(host).render(
        React.createElement(CheckoutSparkRecoveryPanel, {
          principalPubkey: merchantPubkey,
          selectedOrder: {
            orderId,
            buyerPubkey,
            merchantPubkey,
          },
          allowAutomaticPayouts: true,
          executionEnabled: true,
          startAutomatically: false,
          isSessionCurrent: () => true,
        })
      )
    }, fixtureModuleUrl)

    stage = "single explicit continuation available"
    const continueButton = page.getByRole("button", {
      name: "Continue this order",
    })
    await expect(continueButton).toBeVisible()
    await expect
      .poll(
        () =>
          page.evaluate(async (fixtureUrl) => {
            const fixture = await import(fixtureUrl)
            return fixture.merchantDiscoveryContinuationSnapshot()
          }, fixtureModuleUrl),
        { timeout: 5_000 }
      )
      .toEqual({
        discoverySessions: 1,
        discoveryPages: [1],
        observationCalls: 1,
        advancementCalls: 0,
      })

    stage = "empty partial rediscovery retains continuation consent"
    await continueButton.click()
    await expect
      .poll(
        () =>
          page.evaluate(async (fixtureUrl) => {
            const fixture = await import(fixtureUrl)
            return fixture.merchantDiscoveryContinuationSnapshot()
          }, fixtureModuleUrl),
        { timeout: 5_000 }
      )
      .toEqual({
        discoverySessions: 2,
        discoveryPages: [1, 2],
        observationCalls: 1,
        advancementCalls: 1,
      })

    stage = "one advancement without a second continuation"
    await expect(continueButton).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible()
  } catch {
    throw new Error(`Merchant discovery continuation failed: ${stage}.`)
  } finally {
    beginTeardown()
    await removeModuleFixtures()
    await context.unrouteAll({ behavior: "wait" })
    await context.close()
  }
})
