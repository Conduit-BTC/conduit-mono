import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import {
  TEST_RELAY_URL,
  installTestSigner,
  seedTestRelayIdentity,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const screenshotDirectory = process.env.PLAYWRIGHT_NETWORK_UI_SCREENSHOT_DIR

async function openNetwork(
  page: Page,
  app: "market" | "merchant"
): Promise<string> {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey)
  await installTestSigner(page, pubkey, { secretKey })
  const appUrl = app === "market" ? marketUrl : merchantUrl

  await page.goto(app === "market" ? `${appUrl}/products` : appUrl)
  await expect(
    page.getByRole("button", {
      name:
        app === "market" ? "Open account menu" : "Open merchant account menu",
    })
  ).toBeVisible({ timeout: 15_000 })
  await page.goto(`${appUrl}/network`)
  await expect(
    page.getByRole("heading", { name: "Network", exact: true })
  ).toBeVisible()
  return appUrl
}

for (const app of ["market", "merchant"] as const) {
  test(`${app} warns before discarding unpublished relay edits @${app}`, async ({
    page,
  }) => {
    const appUrl = await openNetwork(page, app)
    const readRole = page.getByRole("button", {
      name: new RegExp(
        `^(Disable|Enable) Read for ${TEST_RELAY_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
      ),
    })

    await expect(readRole).toBeEnabled({ timeout: 20_000 })
    await readRole.click()
    await expect(readRole).toHaveAttribute("aria-pressed", "false")
    await expect(
      page.getByText("Unpublished changes", { exact: true })
    ).toBeVisible()

    const homeLink = page.getByRole("link", { name: /Conduit/i }).first()
    await homeLink.click()
    const leaveDialog = page.getByRole("alertdialog")
    await expect(
      leaveDialog.getByRole("heading", {
        name: "Leave with unpublished relay changes?",
      })
    ).toBeVisible()
    await expect(leaveDialog).toContainText(
      "Conduit and other Nostr apps will keep using your last published preferences."
    )
    const keepEditing = leaveDialog.getByRole("button", {
      name: "Keep editing",
    })
    await expect(keepEditing).toBeFocused()
    if (screenshotDirectory) {
      mkdirSync(screenshotDirectory, { recursive: true })
      await page.screenshot({
        path: join(
          screenshotDirectory,
          `${app}-network-unpublished-warning.png`
        ),
        fullPage: true,
        animations: "disabled",
      })
    }
    await keepEditing.click()
    await expect(page).toHaveURL(`${appUrl}/network`)
    await expect(homeLink).toBeFocused()
    await expect(readRole).toHaveAttribute("aria-pressed", "false")

    await homeLink.click()
    await leaveDialog.getByRole("button", { name: "Leave and discard" }).click()
    await expect(page).toHaveURL(`${appUrl}/`)

    await page.goto(`${appUrl}/network`)
    await expect(readRole).toHaveAttribute("aria-pressed", "true", {
      timeout: 20_000,
    })
  })
}
