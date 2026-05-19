import { expect, test } from "@playwright/test"
import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  installTestSigner,
  seedMarketCart,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

test("merchant shipping country combobox supports search and selection", async ({
  page,
}) => {
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(`${merchantUrl}/shipping`)

  await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()

  const countryPicker = page
    .locator('button[role="combobox"]')
    .filter({ hasText: "Search countries to add..." })

  await countryPicker.click()
  await page.getByPlaceholder("Search countries to add...").fill("canada")
  await page.getByRole("option", { name: /CA Canada/i }).click()

  await expect(
    page.locator("span").filter({ hasText: /^Canada$/ })
  ).toBeVisible()
  await expect(countryPicker).toBeVisible()
})

test("market checkout country combobox supports search and selection", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await seedMarketCart(page)
  await page.goto(`${marketUrl}/checkout`)

  await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()

  await page.getByRole("combobox", { name: /country/i }).click()
  await page.getByPlaceholder("Search countries...").fill("canada")
  await page.getByRole("option", { name: /CA Canada/i }).click()

  await expect(page.getByRole("combobox", { name: /country/i })).toContainText(
    "Canada (CA)"
  )
})

test("market wallet setup route renders for connected signer", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await page.goto(`${marketUrl}/wallet`)

  await expect(
    page.getByRole("heading", { name: "Wallet", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Wallet connection", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: /connect wallet/i })
  ).toBeVisible()
  await expect(page.getByPlaceholder("nostr+walletconnect://...")).toBeVisible()
})
