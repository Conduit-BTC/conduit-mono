import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import {
  THEME_STORAGE_KEY,
  type ThemeId,
  type ThemePreference,
} from "@conduit/ui/theme"
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

async function expectThemeToggleIcon(
  button: Locator,
  icon: "moon" | "sun" | "sun-moon"
): Promise<void> {
  const svg = button.locator("svg")
  await expect(svg).toHaveClass(new RegExp(`lucide-${icon}`))
  await expect(svg).toHaveClass(/size-5/)
  if (icon === "sun-moon") return
  await expect(svg.locator("circle")).toHaveCount(icon === "sun" ? 1 : 0)
  await expect(svg.locator("path")).toHaveCount(icon === "sun" ? 8 : 1)
}

const themePreferenceLabels: Record<ThemePreference, string> = {
  system: "System",
  "day-market": "Day Market",
  "night-market": "Night Market",
}

async function expectThemeToggle(
  page: Page,
  currentPreference: ThemePreference,
  nextPreference: ThemePreference,
  icon: "moon" | "sun" | "sun-moon"
): Promise<Locator> {
  const name = `Appearance: ${themePreferenceLabels[currentPreference]}. Switch to ${themePreferenceLabels[nextPreference]}`
  const button = page.getByRole("button", { name })
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute(
    "data-theme-toggle-preference",
    currentPreference
  )
  await expect(button).toHaveAttribute(
    "data-theme-toggle-target",
    nextPreference
  )
  await expect(button).toHaveAttribute("title", name)
  await expectThemeToggleIcon(button, icon)
  return button
}

async function expectFirstFrameTheme(
  page: Page,
  theme: ThemeId
): Promise<void> {
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
    .toBe(theme)
}

async function captureScreenshot(page: Page, fileName: string): Promise<void> {
  if (!screenshotDirectory) return
  await mkdir(screenshotDirectory, { recursive: true })
  await page.screenshot({
    path: join(screenshotDirectory, fileName),
    animations: "disabled",
    fullPage: true,
  })
}

test("Market direct theme toggle cycles System, Day, and Night while signed out @market", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" })
  await installFirstFrameThemeProbe(page)
  await page.goto(`${marketUrl}/products`)

  await expect(
    page.getByRole("button", { name: "Connect", exact: true })
  ).toBeVisible()
  await expectResolvedTheme(page, "day-market", "light")
  await expectFirstFrameTheme(page, "day-market")
  await expect
    .poll(() =>
      page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)
    )
    .toBeNull()

  const systemToggle = await expectThemeToggle(
    page,
    "system",
    "day-market",
    "sun-moon"
  )

  await page.emulateMedia({ colorScheme: "dark" })
  await expectResolvedTheme(page, "night-market", "dark")
  await expectThemeToggle(page, "system", "day-market", "sun-moon")
  await page.emulateMedia({ colorScheme: "light" })
  await expectResolvedTheme(page, "day-market", "light")

  const syncedPage = await page.context().newPage()
  await syncedPage.emulateMedia({ colorScheme: "light" })
  await syncedPage.goto(`${marketUrl}/products`)
  await expectResolvedTheme(syncedPage, "day-market", "light")
  await expectThemeToggle(syncedPage, "system", "day-market", "sun-moon")

  await systemToggle.focus()
  await page.keyboard.press("Enter")
  await expectResolvedTheme(page, "day-market", "light")
  await expectResolvedTheme(syncedPage, "day-market", "light")
  await expect
    .poll(() =>
      page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)
    )
    .toBe("day-market")
  const dayToggle = await expectThemeToggle(
    page,
    "day-market",
    "night-market",
    "sun"
  )
  await expectThemeToggle(syncedPage, "day-market", "night-market", "sun")

  await page.emulateMedia({ colorScheme: "dark" })
  await expectResolvedTheme(page, "day-market", "light")

  await dayToggle.click()
  await expectResolvedTheme(page, "night-market", "dark")
  await expectResolvedTheme(syncedPage, "night-market", "dark")
  const nightToggle = await expectThemeToggle(
    page,
    "night-market",
    "system",
    "moon"
  )
  await captureScreenshot(page, "market-night-market-direct-toggle.png")

  await nightToggle.click()
  await expect
    .poll(() =>
      page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)
    )
    .toBe("system")
  await expectResolvedTheme(page, "night-market", "dark")
  await expectResolvedTheme(syncedPage, "day-market", "light")
  await expectThemeToggle(page, "system", "day-market", "sun-moon")
  await expectThemeToggle(syncedPage, "system", "day-market", "sun-moon")

  await page.emulateMedia({ colorScheme: "light" })
  await expectResolvedTheme(page, "day-market", "light")
  await page.emulateMedia({ colorScheme: "dark" })
  await expectResolvedTheme(page, "night-market", "dark")

  await page.reload()
  await expectResolvedTheme(page, "night-market", "dark")
  await expectFirstFrameTheme(page, "night-market")
  await expectThemeToggle(page, "system", "day-market", "sun-moon")
  await captureScreenshot(page, "market-system-direct-toggle.png")
  await syncedPage.close()
})

test("Merchant direct theme toggle stays available through sign-in and responsive layouts @merchant", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: "dark" })
  await installFirstFrameThemeProbe(page)
  await page.goto(merchantUrl)

  await expect(
    page.getByRole("main", { name: "Connect a signer" })
  ).toBeVisible()
  await expectResolvedTheme(page, "night-market", "dark")
  await expectFirstFrameTheme(page, "night-market")

  const systemToggle = await expectThemeToggle(
    page,
    "system",
    "day-market",
    "sun-moon"
  )
  const mobileToggleBox = await systemToggle.boundingBox()
  expect(mobileToggleBox).not.toBeNull()
  expect(mobileToggleBox!.x + mobileToggleBox!.width).toBeLessThanOrEqual(390)
  expect(mobileToggleBox!.y).toBeGreaterThanOrEqual(0)
  await captureScreenshot(page, "merchant-system-connect-gate-mobile.png")

  await systemToggle.click()
  await expectResolvedTheme(page, "day-market", "light")
  await expectThemeToggle(page, "day-market", "night-market", "sun")

  const secretKey = generateSecretKey()
  const workspacePage = await page.context().newPage()
  await workspacePage.setViewportSize({ width: 1440, height: 900 })
  await workspacePage.emulateMedia({ colorScheme: "dark" })
  await installFirstFrameThemeProbe(workspacePage)
  await installTestSigner(workspacePage, getPublicKey(secretKey), { secretKey })
  await workspacePage.goto(merchantUrl)

  await expect(
    workspacePage.getByRole("button", { name: "Open merchant account menu" })
  ).toBeVisible({ timeout: 15_000 })
  await expectResolvedTheme(workspacePage, "day-market", "light")
  await expectFirstFrameTheme(workspacePage, "day-market")
  const workspaceToggle = await expectThemeToggle(
    workspacePage,
    "day-market",
    "night-market",
    "sun"
  )
  await captureScreenshot(
    workspacePage,
    "merchant-day-market-direct-toggle-desktop.png"
  )

  await workspaceToggle.focus()
  await workspacePage.keyboard.press("Space")
  await expectResolvedTheme(workspacePage, "night-market", "dark")
  await expectResolvedTheme(page, "night-market", "dark")
  const switchToSystem = await expectThemeToggle(
    workspacePage,
    "night-market",
    "system",
    "moon"
  )
  await expect
    .poll(() =>
      workspacePage.evaluate(
        (key) => localStorage.getItem(key),
        THEME_STORAGE_KEY
      )
    )
    .toBe("night-market")

  await switchToSystem.click()
  await expect
    .poll(() =>
      workspacePage.evaluate(
        (key) => localStorage.getItem(key),
        THEME_STORAGE_KEY
      )
    )
    .toBe("system")
  await expectResolvedTheme(workspacePage, "night-market", "dark")
  await expectResolvedTheme(page, "night-market", "dark")
  await expectThemeToggle(workspacePage, "system", "day-market", "sun-moon")

  await page.emulateMedia({ colorScheme: "light" })
  await expectResolvedTheme(page, "day-market", "light")
  await expectResolvedTheme(workspacePage, "night-market", "dark")

  await workspacePage.reload()
  await expectResolvedTheme(workspacePage, "night-market", "dark")
  await expectFirstFrameTheme(workspacePage, "night-market")
  await expectThemeToggle(workspacePage, "system", "day-market", "sun-moon")
  await captureScreenshot(
    workspacePage,
    "merchant-system-direct-toggle-desktop.png"
  )
})
