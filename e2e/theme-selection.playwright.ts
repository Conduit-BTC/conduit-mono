import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
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

async function expectThemeToggleIcon(
  button: Locator,
  icon: "moon" | "sun"
): Promise<void> {
  const svg = button.locator("svg")
  await expect(svg).toHaveClass(new RegExp(`lucide-${icon}`))
  await expect(svg).toHaveClass(/size-5/)
  await expect(svg.locator("circle")).toHaveCount(icon === "sun" ? 1 : 0)
  await expect(svg.locator("path")).toHaveCount(icon === "sun" ? 8 : 1)
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

test("Market direct theme toggle works while signed out and preserves an explicit choice @market", async ({
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

  const switchToNight = page.getByRole("button", {
    name: "Switch to Night Market",
  })
  await expect(switchToNight).toBeVisible()
  await expectThemeToggleIcon(switchToNight, "moon")

  await page.emulateMedia({ colorScheme: "dark" })
  await expectResolvedTheme(page, "night-market", "dark")
  await expectThemeToggleIcon(
    page.getByRole("button", { name: "Switch to Day Market" }),
    "sun"
  )
  await page.emulateMedia({ colorScheme: "light" })
  await expectResolvedTheme(page, "day-market", "light")

  const syncedPage = await page.context().newPage()
  await syncedPage.emulateMedia({ colorScheme: "light" })
  await syncedPage.goto(`${marketUrl}/products`)
  await expectResolvedTheme(syncedPage, "day-market", "light")

  await switchToNight.focus()
  await page.keyboard.press("Enter")
  await expectResolvedTheme(page, "night-market", "dark")
  await expectResolvedTheme(syncedPage, "night-market", "dark")
  await expect
    .poll(() =>
      page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)
    )
    .toBe("night-market")
  await expectThemeToggleIcon(
    page.getByRole("button", { name: "Switch to Day Market" }),
    "sun"
  )

  await page.emulateMedia({ colorScheme: "dark" })
  await page.emulateMedia({ colorScheme: "light" })
  await expectResolvedTheme(page, "night-market", "dark")

  await page.reload()
  await expectResolvedTheme(page, "night-market", "dark")
  await expectFirstFrameTheme(page, "night-market")
  await captureScreenshot(page, "market-night-market-direct-toggle.png")
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

  const switchToDay = page.getByRole("button", {
    name: "Switch to Day Market",
  })
  await expect(switchToDay).toBeVisible()
  await expectThemeToggleIcon(switchToDay, "sun")
  const mobileToggleBox = await switchToDay.boundingBox()
  expect(mobileToggleBox).not.toBeNull()
  expect(mobileToggleBox!.x + mobileToggleBox!.width).toBeLessThanOrEqual(390)
  expect(mobileToggleBox!.y).toBeGreaterThanOrEqual(0)

  await switchToDay.click()
  await expectResolvedTheme(page, "day-market", "light")
  await expectThemeToggleIcon(
    page.getByRole("button", { name: "Switch to Night Market" }),
    "moon"
  )
  await captureScreenshot(page, "merchant-day-market-connect-gate-mobile.png")

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
  const workspaceToggle = workspacePage.getByRole("button", {
    name: "Switch to Night Market",
  })
  await expect(workspaceToggle).toBeVisible()
  await expectThemeToggleIcon(workspaceToggle, "moon")
  await captureScreenshot(
    workspacePage,
    "merchant-day-market-direct-toggle-desktop.png"
  )

  await workspaceToggle.focus()
  await workspacePage.keyboard.press("Space")
  await expectResolvedTheme(workspacePage, "night-market", "dark")
  await expectResolvedTheme(page, "night-market", "dark")
  await expect
    .poll(() =>
      workspacePage.evaluate(
        (key) => localStorage.getItem(key),
        THEME_STORAGE_KEY
      )
    )
    .toBe("night-market")

  await workspacePage.reload()
  await expectResolvedTheme(workspacePage, "night-market", "dark")
  await expectFirstFrameTheme(workspacePage, "night-market")
})
