import { expect, type Page } from "@playwright/test"

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
  // The complete empty state replaces the taller loading placeholders. Let
  // that actual catalog read and the bundled fonts settle before one activation.
  await expect(page.getByText("No listings yet", { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await page.evaluate(() => document.fonts.ready)
  const trigger = page.getByRole("button", { name: "Add product" }).first()
  await expect(trigger).toBeEnabled({ timeout: 20_000 })
  return trigger
}
