import { expect, test } from "@playwright/test"
import {
  TEST_PUBKEY,
  TEST_PUBKEY_2,
  installLateNip07Shim,
  installLockedNip07Shim,
  installNip07Shim,
  installRejectingNip07Shim,
  resolveLockedSigner,
} from "./fixtures/nip07"

/**
 * CND-21: NIP-07 signer compatibility and popup readiness QA.
 *
 * These automated tests cover the NIP-07 connect flows that can be
 * exercised with a deterministic shim:
 *
 *  - Fresh connect (unlocked signer, no stored auth)
 *  - Auto-reconnect (stored pubkey + signer available on load)
 *  - Late-injecting extension (window.nostr arrives after a short delay)
 *  - Locked / pending signer (getPublicKey hangs until user acts)
 *  - Rejected signer (user denies permission)
 *  - No extension present (window.nostr absent)
 *  - Signer switch (disconnect + reconnect with a different pubkey)
 *  - Disconnect clears state and returns to unauthenticated UI
 *
 * Manual QA matrix (real browser extensions) is recorded separately
 * in the CND-21 Linear issue.
 */

const MARKET_URL = "http://localhost:3000"
const MERCHANT_URL = "http://localhost:3001"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openSignerDialog(page: import("@playwright/test").Page) {
  const connectBtn = page.getByRole("button", { name: /Connect/i }).first()
  await connectBtn.waitFor({ state: "visible", timeout: 10_000 })
  await connectBtn.click()
}

// ---------------------------------------------------------------------------
// Market – connect flows
// ---------------------------------------------------------------------------

test.describe("market / signer connect", () => {
  test("fresh connect with unlocked signer", async ({ page }) => {
    await installNip07Shim(page)
    await page.goto(MARKET_URL + "/products")

    await openSignerDialog(page)

    // Click the Connect signer button inside the dialog
    const connectAction = page
      .getByRole("button", { name: /Connect signer/i })
      .first()
    await connectAction.waitFor({ state: "visible", timeout: 5_000 })
    await connectAction.click()

    // Should transition to connected state: pubkey pill appears in header
    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })

    // Dialog closes on success
    await expect(
      page.getByRole("dialog", { name: /Connect a signer/i })
    ).not.toBeVisible()

    // localStorage should have the pubkey stored
    const stored = await page.evaluate(() =>
      localStorage.getItem("conduit:auth")
    )
    expect(stored).toBe(TEST_PUBKEY)
  })

  test("auto-reconnect with stored pubkey and available signer", async ({
    page,
  }) => {
    await installNip07Shim(page)
    // Pre-seed stored auth like a returning session
    await page.addInitScript((pk) => {
      localStorage.setItem("conduit:auth", pk)
    }, TEST_PUBKEY)

    await page.goto(MARKET_URL + "/products")

    // Pubkey pill should appear without any user interaction
    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })

    // No connect dialog should auto-open
    await expect(page.getByRole("dialog")).not.toBeVisible()
  })

  test("auto-reconnect does not open signer dialog without user gesture", async ({
    page,
  }) => {
    await installNip07Shim(page)
    await page.addInitScript((pk) => {
      localStorage.setItem("conduit:auth", pk)
    }, TEST_PUBKEY)

    await page.goto(MARKET_URL + "/products")
    // Wait briefly to ensure no modal appeared
    await page.waitForTimeout(2_000)

    const dialogs = page.getByRole("dialog")
    await expect(dialogs).toHaveCount(0)
  })

  test("late-injecting extension: auto-reconnect succeeds when stored pubkey + late shim", async ({
    page,
  }) => {
    // Store pubkey so auto-reconnect fires, but shim arrives after 800ms —
    // still within the 5 × 200ms injection wait (1s total).
    await installLateNip07Shim(page, 800)
    await page.addInitScript((pk) => {
      localStorage.setItem("conduit:auth", pk)
    }, TEST_PUBKEY)

    await page.goto(MARKET_URL + "/products")

    // Auto-reconnect should pick up the late shim and complete
    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
  })

  test("no extension shows install prompt, not blank/stall", async ({
    page,
  }) => {
    // No shim installed: window.nostr is absent
    await page.goto(MARKET_URL + "/products")

    await openSignerDialog(page)

    // After the 2s injection wait, the dialog should surface an actionable
    // error or install message, not spin indefinitely.
    await expect(
      page
        .getByText(/No NIP-07 extension found|Install a Nostr signer|nos2x/i)
        .first()
    ).toBeVisible({ timeout: 10_000 })

    // Connect button should be disabled (no extension available)
    const connectBtn = page
      .getByRole("button", { name: /Connect signer/i })
      .first()
    if (await connectBtn.isVisible()) {
      await expect(connectBtn).toBeDisabled()
    }
  })

  test("rejected signer shows error and allows retry", async ({ page }) => {
    await installRejectingNip07Shim(page)
    await page.goto(MARKET_URL + "/products")

    await openSignerDialog(page)

    const connectAction = page
      .getByRole("button", { name: /Connect signer/i })
      .first()
    await connectAction.waitFor({ state: "visible", timeout: 5_000 })
    await connectAction.click()

    // Error message should appear in the dialog
    await expect(page.getByText(/rejected|failed|error/i).first()).toBeVisible({
      timeout: 15_000,
    })

    // Dialog must remain open (not auto-close on error)
    await expect(page.getByRole("dialog")).toBeVisible()

    // Retry must be possible: connect button re-enabled after error
    await expect(connectAction).toBeEnabled({ timeout: 5_000 })
  })

  test("locked signer shows waiting state then connects on unlock", async ({
    page,
  }) => {
    await installLockedNip07Shim(page)
    await page.goto(MARKET_URL + "/products")

    await openSignerDialog(page)

    const connectAction = page
      .getByRole("button", { name: /Connect signer/i })
      .first()
    await connectAction.waitFor({ state: "visible", timeout: 5_000 })
    await connectAction.click()

    // While pending, the button should be in connecting state or disabled
    await expect(
      page.getByRole("button", { name: /Connecting\.\.\./i }).first()
    ).toBeVisible({ timeout: 5_000 })

    // Now simulate the user approving in the extension popup
    await resolveLockedSigner(page, TEST_PUBKEY)

    // Should connect successfully
    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
  })

  test("disconnect clears state and shows unauthenticated UI", async ({
    page,
  }) => {
    await installNip07Shim(page)
    await page.addInitScript((pk) => {
      localStorage.setItem("conduit:auth", pk)
    }, TEST_PUBKEY)

    await page.goto(MARKET_URL + "/products")

    const pubkeyBtn = page.locator("button", { hasText: "7459" }).first()
    await pubkeyBtn.waitFor({ state: "visible", timeout: 15_000 })

    // Open disconnect dialog and confirm
    await pubkeyBtn.click()

    // The UserMenu opens a Dialog directly — click the Disconnect confirm button
    await page
      .getByRole("button", { name: /^Disconnect$/ })
      .last()
      .click({ timeout: 5_000 })

    // Should show Connect button again (unauthenticated)
    await expect(
      page.getByRole("button", { name: /Connect/i }).first()
    ).toBeVisible({ timeout: 5_000 })

    // localStorage should be cleared
    const stored = await page.evaluate(() =>
      localStorage.getItem("conduit:auth")
    )
    expect(stored).toBeNull()
  })

  test("signer switch: disconnect then reconnect with different pubkey", async ({
    page,
  }) => {
    // Start with pubkey 1
    await installNip07Shim(page, { pubkey: TEST_PUBKEY })
    await page.addInitScript((pk) => {
      localStorage.setItem("conduit:auth", pk)
    }, TEST_PUBKEY)

    await page.goto(MARKET_URL + "/products")
    const pubkeyBtn = page.locator("button", { hasText: "7459" }).first()
    await pubkeyBtn.waitFor({ state: "visible", timeout: 15_000 })

    // Disconnect via the Dialog
    await pubkeyBtn.click()
    await page
      .getByRole("button", { name: /^Disconnect$/ })
      .last()
      .click({ timeout: 5_000 })

    // Now update the shim to return pubkey 2 for the next connect
    await page.evaluate((pk2) => {
      ;(
        window as unknown as { nostr: { getPublicKey: () => Promise<string> } }
      ).nostr.getPublicKey = async () => pk2
    }, TEST_PUBKEY_2)

    // Reconnect
    const connectBtn = page.getByRole("button", { name: /Connect/i }).first()
    await connectBtn.waitFor({ state: "visible", timeout: 5_000 })
    await connectBtn.click()

    const connectAction = page
      .getByRole("button", { name: /Connect signer/i })
      .first()
    await connectAction.waitFor({ state: "visible", timeout: 5_000 })
    await connectAction.click()

    // Should now show pubkey 2's short form (aabb)
    await page
      .locator("button", { hasText: "aabb" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })

    const stored = await page.evaluate(() =>
      localStorage.getItem("conduit:auth")
    )
    expect(stored).toBe(TEST_PUBKEY_2)
  })
})

// ---------------------------------------------------------------------------
// Market – auth redirect flow
// ---------------------------------------------------------------------------

test.describe("market / auth redirect", () => {
  test("authRequired route opens signer dialog then connects", async ({
    page,
  }) => {
    await installNip07Shim(page)
    await page.goto(MARKET_URL + "/products?authRequired=true")

    // The signer dialog should auto-open
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 })

    const connectAction = page
      .getByRole("button", { name: /Connect signer/i })
      .first()
    await connectAction.waitFor({ state: "visible", timeout: 5_000 })
    await connectAction.click()

    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
  })
})

// ---------------------------------------------------------------------------
// Merchant – connect flows
// ---------------------------------------------------------------------------

test.describe("merchant / signer connect", () => {
  test("unauthenticated root gate shows connect button and description", async ({
    page,
  }) => {
    // No shim, no stored auth
    await page.goto(MERCHANT_URL)
    await page.waitForLoadState("domcontentloaded")

    // The merchant gate should show a connect button
    await expect(
      page.getByRole("button", { name: /Connect signer/i }).first()
    ).toBeVisible({ timeout: 10_000 })

    // Description text should guide the user
    await expect(
      page.getByText(/Nostr signer|NIP-07|Alby|nos2x/i).first()
    ).toBeVisible({ timeout: 10_000 })
  })

  test("fresh connect via merchant gate", async ({ page }) => {
    await installNip07Shim(page)
    await page.goto(MERCHANT_URL)

    const connectBtn = page
      .getByRole("button", { name: /Connect signer/i })
      .first()
    await connectBtn.waitFor({ state: "visible", timeout: 10_000 })
    await connectBtn.click()

    // After connect, dashboard content should appear (pubkey pill in header)
    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
  })

  test("merchant gate shows waiting state while connecting", async ({
    page,
  }) => {
    await installLockedNip07Shim(page)
    await page.goto(MERCHANT_URL)

    const connectBtn = page
      .getByRole("button", { name: /Connect signer/i })
      .first()
    await connectBtn.waitFor({ state: "visible", timeout: 10_000 })
    await connectBtn.click()

    // Should show "Waiting for your signer approval..." while pending
    await expect(
      page.getByText(/Waiting for your signer approval/i).first()
    ).toBeVisible({ timeout: 5_000 })

    // Unlock
    await resolveLockedSigner(page, TEST_PUBKEY)

    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
  })

  test("rejected signer shows error and allows retry on merchant gate", async ({
    page,
  }) => {
    await installRejectingNip07Shim(page)
    await page.goto(MERCHANT_URL)

    const connectBtn = page
      .getByRole("button", { name: /Connect signer/i })
      .first()
    await connectBtn.waitFor({ state: "visible", timeout: 10_000 })
    await connectBtn.click()

    // Error state should appear
    await expect(page.getByText(/rejected|failed|error/i).first()).toBeVisible({
      timeout: 15_000,
    })

    // Connect button must remain available for retry
    await expect(connectBtn).toBeEnabled({ timeout: 5_000 })
  })

  test("auto-reconnect succeeds on merchant app", async ({ page }) => {
    await installNip07Shim(page)
    await page.addInitScript((pk) => {
      localStorage.setItem("conduit:auth", pk)
    }, TEST_PUBKEY)

    await page.goto(MERCHANT_URL)

    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })

    // Should not show the connect gate
    await expect(
      page.getByRole("button", { name: /Connect signer/i }).first()
    ).not.toBeVisible()
  })

  test("auto-reconnect clears state when extension is absent", async ({
    page,
  }) => {
    // Store pubkey but do NOT inject window.nostr
    await page.addInitScript((pk) => {
      localStorage.setItem("conduit:auth", pk)
    }, TEST_PUBKEY)

    await page.goto(MERCHANT_URL)

    // Wait for the reconnect injection loop (5 × 200ms) to finish, then check.
    // ConnectGate appears immediately when !signerConnected, so we must wait
    // for the async cleanup to complete before asserting localStorage.
    await expect(
      page.getByRole("button", { name: /Connect signer/i }).first()
    ).toBeVisible({ timeout: 10_000 })

    // Poll until localStorage is cleared (reconnect cleanup is async)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("conduit:auth")), {
        timeout: 5_000,
      })
      .toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Cross-browser compatibility screenshots
// ---------------------------------------------------------------------------

test.describe("signer UI screenshots", () => {
  test.beforeEach(async ({ page }) => {
    await installNip07Shim(page)
    await page.addInitScript((pk) => {
      localStorage.setItem("conduit:auth", pk)
    }, TEST_PUBKEY)
  })

  test("market header connected state", async ({ page, browserName }) => {
    await page.goto(MARKET_URL + "/products")
    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })

    await page.screenshot({
      path: `tmp/playwright/cnd21-market-header-${browserName}.png`,
      clip: { x: 0, y: 0, width: 1440, height: 96 },
    })
  })

  test("market signer dialog connected", async ({ page, browserName }) => {
    await page.goto(MARKET_URL + "/products")
    const pubkeyBtn = page.locator("button", { hasText: "7459" }).first()
    await pubkeyBtn.waitFor({ state: "visible", timeout: 15_000 })

    // Open the signer dialog via the header button in connected state
    const headerConnectBtn = page.getByRole("button", { name: /Signer:/i })
    if (await headerConnectBtn.isVisible()) {
      await headerConnectBtn.click()
      await page.waitForTimeout(300)
      await page.screenshot({
        path: `tmp/playwright/cnd21-market-signer-dialog-${browserName}.png`,
      })
    }
  })

  test("merchant header connected state", async ({ page, browserName }) => {
    await page.goto(MERCHANT_URL)
    await page
      .locator("button", { hasText: "7459" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })

    await page.screenshot({
      path: `tmp/playwright/cnd21-merchant-header-${browserName}.png`,
      clip: { x: 0, y: 0, width: 1440, height: 96 },
    })
  })

  test("merchant connect gate unauthenticated", async ({
    page,
    browserName,
  }) => {
    // No auth stored; navigate directly (fresh context has no conduit:auth)
    await page.goto(MERCHANT_URL)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2_500)

    await page.screenshot({
      path: `tmp/playwright/cnd21-merchant-gate-${browserName}.png`,
    })
  })
})
