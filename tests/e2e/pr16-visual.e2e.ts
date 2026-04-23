import { expect, test } from "@playwright/test"
import { installNip07Shim, TEST_PUBKEY } from "./fixtures/nip07"

/**
 * Visual smoke coverage for PR #16 review fixes:
 *  1. Profile dropdown renders as a clean menu below the trigger (no
 *     duplicated profile bar).
 *  2. "Set up relays" warning item appears when relay setup is incomplete.
 *  3. Settings/Relay panel shows per-relay status dots and the signer
 *     relay list from NIP-07 getRelays().
 *  4. Merchant header no longer shows the global notifications bell.
 *
 * The NIP-07 shim supplies a deterministic pubkey + relay list so the
 * screenshots are reproducible.
 */

const MARKET_URL = "http://localhost:3000"
const MERCHANT_URL = "http://localhost:3001"

test.describe("market", () => {
  test.beforeEach(async ({ page }) => {
    await installNip07Shim(page)
    await page.addInitScript((pubkey) => {
      localStorage.setItem("conduit:auth", pubkey)
    }, TEST_PUBKEY)
  })

  test("header and profile dropdown", async ({ page }) => {
    await page.goto(MARKET_URL + "/products")
    await page.waitForLoadState("networkidle")
    const pubkeyButton = page.locator("button", { hasText: "7459" }).first()
    await pubkeyButton.waitFor({ state: "visible", timeout: 15_000 })

    await page.screenshot({
      path: "tmp/playwright/market-01-header.png",
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: 96 },
    })

    await pubkeyButton.click()
    // Give Radix a tick to open
    await page.waitForTimeout(250)

    await page.screenshot({
      path: "tmp/playwright/market-02-dropdown.png",
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: 480 },
    })

    // Sanity: the dropdown content should include menuitems for
    // Profile / Network / Disconnect.
    await expect(page.getByRole("menuitem", { name: /Profile/i })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: /Network/i })).toBeVisible()
    await expect(
      page.getByRole("menuitem", { name: /Disconnect/i })
    ).toBeVisible()

    // Close dropdown before next step
    await page.keyboard.press("Escape")
  })

  test("settings page with live relay status", async ({ page }) => {
    await page.goto(MARKET_URL + "/settings")
    await expect(page.getByText(/Relay Settings/i)).toBeVisible({
      timeout: 15_000,
    })
    // Wait for signer reconnect so the header shows the pubkey pill rather
    // than a "Connecting..." stub; that also means the merged relay set
    // has been applied.
    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })

    // Allow a moment for NDK per-relay connection attempts to surface as
    // status dots.
    await page.waitForTimeout(3_500)

    await page.screenshot({
      path: "tmp/playwright/market-03-settings.png",
      fullPage: true,
    })
  })
})

test.describe("merchant", () => {
  test.beforeEach(async ({ page }) => {
    await installNip07Shim(page)
    await page.addInitScript((pubkey) => {
      localStorage.setItem("conduit:auth", pubkey)
    }, TEST_PUBKEY)
  })

  test("header has no bell and profile dropdown", async ({ page }) => {
    await page.goto(MERCHANT_URL)
    const pubkeyButton = page
      .locator("button", {
        hasText: "7459",
      })
      .first()
    await pubkeyButton.waitFor({ state: "visible", timeout: 15_000 })

    await page.screenshot({
      path: "tmp/playwright/merchant-01-header.png",
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: 96 },
    })

    await pubkeyButton.click()
    await page.waitForTimeout(250)

    await page.screenshot({
      path: "tmp/playwright/merchant-02-dropdown.png",
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: 520 },
    })

    await expect(page.getByRole("menuitem", { name: /Profile/i })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: /Network/i })).toBeVisible()

    // Assert the header does not contain any element whose accessible name
    // matches the old notifications bell.
    const bell = page.getByRole("button", { name: /notification/i })
    await expect(bell).toHaveCount(0)

    await page.keyboard.press("Escape")
  })

  test("settings page with live relay status", async ({ page }) => {
    await page.goto(MERCHANT_URL + "/settings")
    await expect(page.getByText(/Relay Settings/i)).toBeVisible({
      timeout: 15_000,
    })
    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })

    await page.waitForTimeout(3_500)

    await page.screenshot({
      path: "tmp/playwright/merchant-03-settings.png",
      fullPage: true,
    })
  })
})
