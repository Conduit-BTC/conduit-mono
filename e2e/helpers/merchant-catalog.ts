import { expect, type Page } from "@playwright/test"

/** Wait for the settled empty state before activating a moving touch target. */
export async function waitForEmptyMerchantCatalog(page: Page) {
  // The complete empty state replaces taller loading placeholders.
  await expect(page.getByText("No listings yet", { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await page.evaluate(() => document.fonts.ready)
  const trigger = page.getByRole("button", { name: "Add product" }).first()
  await expect(trigger).toBeEnabled({ timeout: 20_000 })
  return trigger
}

/** Initial setup for fixtures that own a fresh, empty merchant catalog. */
export async function prepareEmptyMerchantCatalog(
  page: Page,
  url: string,
  onPhase?: (phase: "navigate" | "catalog") => void
) {
  onPhase?.("navigate")
  await page.goto(url, { waitUntil: "domcontentloaded" })
  onPhase?.("catalog")
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()
  return waitForEmptyMerchantCatalog(page)
}
