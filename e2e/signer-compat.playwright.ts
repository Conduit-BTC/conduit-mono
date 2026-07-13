import { expect, test, type Page } from "@playwright/test"
import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  installLateTestSigner,
  installLockedTestSigner,
  installRejectingTestSigner,
  installTestSigner,
  seedStoredAuth,
  unlockTestSigner,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

async function openMarketSignerDialog(page: Page): Promise<void> {
  await page.goto(`${marketUrl}/products`)
  await page
    .getByRole("button", { name: /^Connect$/ })
    .first()
    .click()
  await expect(page.getByRole("dialog")).toBeVisible()
}

async function connectFromMarketDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Connect signer/i }).click()
}

test("market connect tolerates late NIP-07 signer injection", async ({
  page,
}) => {
  await installLateTestSigner(page, TEST_BUYER_PUBKEY)
  await openMarketSignerDialog(page)

  const connectButton = page.getByRole("button", { name: /Connect signer/i })
  await expect(connectButton).toBeEnabled({ timeout: 8_000 })
  await connectButton.click()

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("conduit:auth")), {
      timeout: 10_000,
    })
    .toBe(TEST_BUYER_PUBKEY)
})

test("market rejected signer keeps retry path visible", async ({ page }) => {
  await installRejectingTestSigner(page)
  await openMarketSignerDialog(page)

  await connectFromMarketDialog(page)

  await expect(page.getByText(/rejected/i).first()).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(
    page.getByRole("button", { name: /Connect signer/i })
  ).toBeEnabled()
})

test("market getRelays failure does not block signer connect", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY, {
    rememberAuth: false,
    getRelaysThrows: true,
  })
  await openMarketSignerDialog(page)

  await connectFromMarketDialog(page)

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("conduit:auth")), {
      timeout: 10_000,
    })
    .toBe(TEST_BUYER_PUBKEY)
})

test("merchant locked signer shows waiting state then connects after unlock", async ({
  page,
}) => {
  await installLockedTestSigner(page)
  await page.goto(merchantUrl)

  await page.getByRole("button", { name: /Connect signer/i }).click()
  await expect(page.getByRole("button", { name: /Connecting/i })).toBeDisabled({
    timeout: 5_000,
  })

  await unlockTestSigner(page, TEST_MERCHANT_PUBKEY)

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("conduit:auth")), {
      timeout: 10_000,
    })
    .toBe(TEST_MERCHANT_PUBKEY)
})

test("merchant remembered auth falls back to explicit retry when signer needs activation", async ({
  page,
}) => {
  await seedStoredAuth(page, TEST_MERCHANT_PUBKEY)
  await installLockedTestSigner(page)
  await page.goto(merchantUrl)

  await expect(page.getByText("Restoring signer")).toBeVisible()
  await expect(page.getByText(/fresh button click/i)).toBeVisible({
    timeout: 8_000,
  })

  const connectButton = page.getByRole("button", { name: /Connect signer/i })
  await expect(connectButton).toBeEnabled()
  await connectButton.click()
  await expect(page.getByRole("button", { name: /Connecting/i })).toBeDisabled({
    timeout: 5_000,
  })

  await unlockTestSigner(page, TEST_MERCHANT_PUBKEY)

  await expect(
    page.getByRole("heading", { name: "Merchant Portal" })
  ).toBeVisible({ timeout: 10_000 })
})
