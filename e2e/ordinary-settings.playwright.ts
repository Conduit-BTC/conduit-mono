import { expect, test } from "@playwright/test"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"
const market = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchant = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const relay = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
// Settings may contain private fields; never collect DOM snapshots or traces.
test.use({ trace: "off", screenshot: "off", video: "off" })
test.setTimeout(120_000)
test("ordinary preferences follow the signer across Shop and Sell automatically @market @merchant", async ({
  browser,
}) => {
  const identity = createRuntimeSignerIdentity(),
    context = await browser.newContext()
  const shop = await context.newPage(),
    sell = await context.newPage()
  try {
    await installRealTestSigner(shop, identity, relay)
    await installRealTestSigner(sell, identity, relay)
    await shop.goto(`${market}/preferences`)
    await expect(
      shop.getByRole("heading", { name: "Private preferences", exact: true })
    ).toBeVisible()
    await shop
      .getByRole("combobox", { name: "Display currency", exact: true })
      .click()
    await shop.getByRole("option", { name: "EUR", exact: true }).click()
    await shop
      .getByRole("button", { name: "Save private preferences", exact: true })
      .click()
    await expect(
      shop.getByRole("status").filter({ hasText: "Saved and found on relays." })
    ).toBeVisible({ timeout: 30_000 })
    await sell.goto(`${merchant}/preferences`)
    await expect(
      sell.getByRole("combobox", { name: "Display currency", exact: true })
    ).toHaveText("EUR", { timeout: 30_000 })
    await sell
      .getByRole("textbox", { name: "Public notice", exact: true })
      .fill("Synthetic storefront notice")
    await sell
      .getByRole("button", { name: "Publish public settings", exact: true })
      .click()
    await expect(
      sell
        .getByRole("status")
        .filter({ hasText: "Public settings saved and found on relays." })
    ).toBeVisible({ timeout: 30_000 })
    await shop.reload()
    await expect(
      shop.getByRole("combobox", { name: "Display currency", exact: true })
    ).toHaveText("EUR", { timeout: 30_000 })
    const visitor = await browser.newContext(),
      page = await visitor.newPage()
    try {
      await page.goto(`${market}/${identity.pubkey}`)
      await expect(
        page.getByText("Synthetic storefront notice", { exact: true })
      ).toBeVisible({ timeout: 30_000 })
      expect(await page.evaluate(() => "nostr" in window)).toBe(false)
    } finally {
      await visitor.close()
    }
    await expect(
      sell.getByRole("button", { name: /sync settings|restore settings/i })
    ).toHaveCount(0)
  } finally {
    await context.close()
    disposeRuntimeSignerIdentity(identity)
  }
})
