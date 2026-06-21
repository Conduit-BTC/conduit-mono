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
  await page.setViewportSize({ width: 375, height: 667 })
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(`${merchantUrl}/shipping`)

  await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()

  const countryPicker = page.getByRole("combobox", {
    name: "Search countries to add...",
  })
  const countryPickerTrigger = page
    .locator("[data-combobox-search-trigger]")
    .filter({ has: countryPicker })
  const triggerBox = await countryPickerTrigger.boundingBox()
  if (!triggerBox) {
    throw new Error("Country picker trigger was not visible")
  }

  await page.mouse.click(
    triggerBox.x + 12,
    triggerBox.y + triggerBox.height / 2
  )
  await page.keyboard.type("un")
  await expect(countryPicker).toHaveValue("un")
  await expect(page.getByRole("option").first()).toContainText("United")

  await countryPicker.fill("")
  await expect(page.getByRole("option").first()).toContainText("Åland Islands")

  await page.getByRole("heading", { name: "Shipping" }).click()
  await page.mouse.click(
    triggerBox.x + triggerBox.width - 12,
    triggerBox.y + triggerBox.height / 2
  )
  await page.keyboard.type("canada")
  await expect(countryPicker).toHaveValue("canada")
  await page.getByRole("option", { name: /CA Canada/i }).click()

  await expect(
    page.locator("span").filter({ hasText: /^Canada$/ })
  ).toBeVisible()
  await expect(countryPicker).toHaveValue("")
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
