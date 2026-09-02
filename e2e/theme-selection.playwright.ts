import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { THEME_STORAGE_KEY, type ThemeId } from "@conduit/ui/theme"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { installTestSigner } from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const screenshotDirectory = process.env.PLAYWRIGHT_THEME_SCREENSHOT_DIR

async function installFirstFrameThemeProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.requestAnimationFrame(() => {
      const themeWindow = window as Window & {
        __conduitThemeAtFirstFrame?: string | null
      }
      themeWindow.__conduitThemeAtFirstFrame =
        document.documentElement.getAttribute("data-theme")
    })
  })
}

async function expectResolvedTheme(
  page: Page,
  theme: ThemeId,
  colorScheme: "dark" | "light"
): Promise<void> {
  const root = page.locator("html")
  await expect(root).toHaveAttribute("data-theme", theme)
  await expect
    .poll(() =>
      root.evaluate((element) => getComputedStyle(element).colorScheme)
    )
    .toBe(colorScheme)
  await expect
    .poll(() =>
      page.locator('meta[name="theme-color"]').getAttribute("content")
    )
    .not.toBe("")
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document
          .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content.trim()
        return (
          !!content &&
          !content.includes("var(") &&
          CSS.supports("color", content)
        )
      })
    )
    .toBe(true)
}

async function openAppearanceMenu(
  page: Page,
  accountMenuName: string,
  currentPreferenceLabel: string
) {
  await page.getByRole("button", { name: accountMenuName }).click()
  const appearance = page.getByRole("menuitem", {
    name: `Appearance: ${currentPreferenceLabel}`,
  })
  await expect(appearance).toBeVisible()
  await appearance.hover()
  await expect(
    page.getByRole("menuitemradio", { name: "Use device setting" })
  ).toBeVisible()
  return appearance
}

async function selectThemePreference(
  page: Page,
  accountMenuName: string,
  currentPreferenceLabel: string,
  nextPreferenceLabel: string
): Promise<void> {
  await openAppearanceMenu(page, accountMenuName, currentPreferenceLabel)
  const item = page.getByRole("menuitemradio", {
    name: nextPreferenceLabel,
  })
  await item.click()
  await expect(item).toHaveAttribute("aria-checked", "true")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
}

async function captureMainScreenshot(
  page: Page,
  fileName: string
): Promise<void> {
  if (!screenshotDirectory) return
  await mkdir(screenshotDirectory, { recursive: true })
  await page
    .locator("main")
    .first()
    .screenshot({
      path: join(screenshotDirectory, fileName),
      animations: "disabled",
    })
}

test("Market selects Night Market by keyboard and preserves it across reload @market", async ({
  page,
}) => {
  const secretKey = generateSecretKey()
  await page.emulateMedia({ colorScheme: "light" })
  await installFirstFrameThemeProbe(page)
  await installTestSigner(page, getPublicKey(secretKey), { secretKey })
  await page.goto(`${marketUrl}/products`)

  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible({ timeout: 15_000 })
  await expectResolvedTheme(page, "day-market", "light")

  const syncedPage = await page.context().newPage()
  await syncedPage.emulateMedia({ colorScheme: "light" })
  await syncedPage.goto(`${marketUrl}/products`)
  await expectResolvedTheme(syncedPage, "day-market", "light")

  const appearance = await openAppearanceMenu(
    page,
    "Open account menu",
    "Use device setting"
  )
  await appearance.focus()
  await page.keyboard.press("ArrowRight")
  const systemItem = page.getByRole("menuitemradio", {
    name: "Use device setting",
  })
  const nightItem = page.getByRole("menuitemradio", { name: "Night Market" })
  await expect(systemItem).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(nightItem).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(nightItem).toHaveAttribute("aria-checked", "true")
  await expectResolvedTheme(page, "night-market", "dark")
  await expectResolvedTheme(syncedPage, "night-market", "dark")
  await syncedPage.close()

  await page.emulateMedia({ colorScheme: "dark" })
  await page.emulateMedia({ colorScheme: "light" })
  await expectResolvedTheme(page, "night-market", "dark")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")

  await page.reload()
  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible({ timeout: 15_000 })
  await expectResolvedTheme(page, "night-market", "dark")
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __conduitThemeAtFirstFrame?: string | null
            }
          ).__conduitThemeAtFirstFrame
      )
    )
    .toBe("night-market")
  await captureMainScreenshot(page, "market-night-market.png")

  await openAppearanceMenu(page, "Open account menu", "Night Market")
  await expect(nightItem).toHaveAttribute("aria-checked", "true")
  const restoredSystemItem = page.getByRole("menuitemradio", {
    name: "Use device setting",
  })
  await restoredSystemItem.focus()
  await page.keyboard.press("Enter")
  await expectResolvedTheme(page, "day-market", "light")
  await page.emulateMedia({ colorScheme: "dark" })
  await expectResolvedTheme(page, "night-market", "dark")
})

test("Merchant selects Day Market and preserves it across reload @merchant", async ({
  page,
}) => {
  const secretKey = generateSecretKey()
  await page.emulateMedia({ colorScheme: "dark" })
  await installFirstFrameThemeProbe(page)
  await installTestSigner(page, getPublicKey(secretKey), { secretKey })
  await page.goto(merchantUrl)

  await expect(
    page.getByRole("button", { name: "Open merchant account menu" })
  ).toBeVisible({ timeout: 15_000 })
  await expectResolvedTheme(page, "night-market", "dark")

  await selectThemePreference(
    page,
    "Open merchant account menu",
    "Use device setting",
    "Day Market"
  )
  await expectResolvedTheme(page, "day-market", "light")
  await page.emulateMedia({ colorScheme: "light" })
  await page.emulateMedia({ colorScheme: "dark" })
  await expectResolvedTheme(page, "day-market", "light")

  await page.reload()
  await expect(
    page.getByRole("button", { name: "Open merchant account menu" })
  ).toBeVisible({ timeout: 15_000 })
  await expectResolvedTheme(page, "day-market", "light")
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __conduitThemeAtFirstFrame?: string | null
            }
          ).__conduitThemeAtFirstFrame
      )
    )
    .toBe("day-market")
  await captureMainScreenshot(page, "merchant-day-market.png")

  await openAppearanceMenu(page, "Open merchant account menu", "Day Market")
  await expect(
    page.getByRole("menuitemradio", { name: "Day Market" })
  ).toHaveAttribute("aria-checked", "true")
  await page.getByRole("menuitemradio", { name: "Use device setting" }).click()
  await expectResolvedTheme(page, "night-market", "dark")
  await page.emulateMedia({ colorScheme: "light" })
  await expectResolvedTheme(page, "day-market", "light")

  expect(
    await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)
  ).toBe("system")
})
