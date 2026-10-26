import { expect, test } from "@playwright/test"
import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  installTestSigner,
} from "./helpers/auth"
import { nip19 } from "nostr-tools"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
test.use({ trace: "off", screenshot: "off", video: "off" })

for (const destination of [
  "/messages?tab=dms",
  "/network",
  "/preferences",
  "/profile",
]) {
  test(`Market sign-in returns to ${destination} @market`, async ({ page }) => {
    await installTestSigner(page, TEST_BUYER_PUBKEY, { rememberAuth: false })
    await page.goto(`${marketUrl}${destination}`)
    const dialog = page.getByRole("dialog", { name: "Sign in to Conduit" })
    await expect(dialog).toBeVisible()
    await dialog
      .getByRole("button", { name: "Connect Extension (NIP-07)", exact: true })
      .click()
    await expect(page).toHaveURL(`${marketUrl}${destination}`)
    await expect(page.getByRole("dialog")).toHaveCount(0)
  })
}

for (const destination of [
  "/messages",
  "/network",
  "/profile",
  "/products",
  "/orders",
  "/shipping",
]) {
  test(`Merchant sign-in returns to ${destination} @merchant`, async ({
    page,
  }) => {
    await installTestSigner(page, TEST_MERCHANT_PUBKEY, { rememberAuth: false })
    await page.goto(`${merchantUrl}${destination}`)
    await expect(
      page.getByRole("heading", { name: "Sign in to Conduit", exact: true })
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Connect Extension (NIP-07)", exact: true })
      .click()
    await expect(page).toHaveURL(`${merchantUrl}${destination}`)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Open merchant account menu" })
    ).toBeVisible()
  })
}

test("public identity message sign-in opens the selected conversation without sending @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY, { rememberAuth: false })
  await page.goto(`${marketUrl}/${nip19.npubEncode(TEST_MERCHANT_PUBKEY)}`)
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Connect Extension (NIP-07)", exact: true })
    .click()
  await expect(page).toHaveURL(
    new RegExp(`/messages\\?.*merchant=${TEST_MERCHANT_PUBKEY}`)
  )
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("Merchant wallet stays available and signs in through one modal @merchant", async ({
  page,
}) => {
  await installTestSigner(page, TEST_MERCHANT_PUBKEY, { rememberAuth: false })
  await page.goto(`${merchantUrl}/wallet`)
  await expect(
    page.getByRole("heading", { name: "Sign in to Conduit", exact: true })
  ).toHaveCount(0)
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Sign in to Conduit" })
  await expect(dialog).toHaveCount(1)
  await dialog
    .getByRole("button", { name: "Connect Extension (NIP-07)", exact: true })
    .click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(`${merchantUrl}/wallet`)
})

test("dismissing sign-in restores keyboard focus to its requester @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/products`)
  const connect = page
    .getByRole("button", { name: "Connect", exact: true })
    .first()
  await connect.click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(connect).toBeFocused()
})

for (const app of ["market", "merchant"] as const) {
  test(`${app} account menu manages one identity and disconnects from the wallet @${app}`, async ({
    page,
  }) => {
    const origin = app === "market" ? marketUrl : merchantUrl
    await installTestSigner(page, TEST_BUYER_PUBKEY)
    await page.goto(`${origin}/wallet`)
    await page
      .getByRole("button", {
        name:
          app === "market" ? "Open account menu" : "Open merchant account menu",
        exact: true,
      })
      .click()
    const menu = page.getByRole("menu")
    await expect(menu.getByRole("menuitem", { name: /Profile/ })).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: /Network/ })).toBeVisible()
    await expect(
      menu.getByRole("menuitem", { name: /Switch account/ })
    ).toHaveCount(0)
    await menu
      .getByRole("menuitem", { name: "Disconnect", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Connect", exact: true })
    ).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page).toHaveURL(`${origin}/wallet`)
  })
}
