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

async function expectSilentThemeFeedback(page: Page): Promise<void> {
  await expect(page.locator("[data-theme-toggle-feedback]")).toHaveAttribute(
    "data-state",
    "hidden"
  )
  await expect(page.locator("[data-theme-toggle-status]")).toBeEmpty()
}

async function expectThemeFeedbackWithinViewport(page: Page): Promise<void> {
  const feedbackBox = await page
    .locator("[data-theme-toggle-feedback]")
    .boundingBox()
  const buttonBox = await page
    .locator("[data-theme-toggle-preference]")
    .boundingBox()
  expect(feedbackBox).not.toBeNull()
  expect(buttonBox).not.toBeNull()
  expect(feedbackBox!.x).toBeGreaterThanOrEqual(0)
  expect(feedbackBox!.x + feedbackBox!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width
  )
  expect(feedbackBox!.y).toBeGreaterThanOrEqual(
    buttonBox!.y + buttonBox!.height
  )
}

for (const surface of [
  {
    name: "Market",
    url: `${marketUrl}/products`,
    width: 1440,
    area: "@market",
  },
  { name: "Merchant", url: merchantUrl, width: 390, area: "@merchant" },
]) {
  test(`${surface.name} theme toggle briefly confirms direct changes ${surface.area}`, async ({
    page,
  }) => {
    const clockStart = Date.now()
    await page.clock.install({ time: clockStart })
    await page.setViewportSize({ width: surface.width, height: 900 })
    await page.emulateMedia({
      colorScheme: "dark",
      reducedMotion: "no-preference",
    })
    await page.goto(surface.url)
    const button = await expectThemeToggle(
      page,
      "system",
      "day-market",
      "sun-moon"
    )
    await expectSilentThemeFeedback(page)
    await page.clock.pauseAt(clockStart + 60_000)

    const feedback = page.locator("[data-theme-toggle-feedback]")
    const status = page.locator("[data-theme-toggle-status]")
    await button.click()
    await expect(feedback).toHaveText("Day Market")
    await expect(feedback).toHaveAttribute("data-state", "visible")
    await expect(status).toHaveText("Appearance set to Day Market.")
    await expect(status).toHaveAttribute("role", "status")
    await expect(feedback).toHaveCSS("transition-duration", "0.15s")
    await expect(feedback).toHaveCSS("pointer-events", "none")
    await page.clock.runFor(800)
    await expect(feedback).toHaveCSS("opacity", "1")
    await captureScreenshot(
      page,
      `${surface.name.toLowerCase()}-day-theme-feedback.png`
    )

    const nightButton = await expectThemeToggle(
      page,
      "day-market",
      "night-market",
      "sun"
    )
    await nightButton.click()
    await expect(feedback).toHaveCount(1)
    await expect(feedback).toHaveText("Night Market")
    await expect(status).toHaveText("Appearance set to Night Market.")
    await page.clock.runFor(300)
    await expect(feedback).toHaveAttribute("data-state", "visible")
    await expect(feedback).toHaveCSS("opacity", "1")
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expectThemeFeedbackWithinViewport(page)
      await captureScreenshot(
        page,
        `${surface.name.toLowerCase()}-${width}-night-theme-feedback.png`
      )
    }
    await page.setViewportSize({ width: surface.width, height: 900 })
    await page.clock.runFor(700)
    await expect(feedback).toHaveAttribute("data-state", "hidden")
    await page.clock.runFor(150)
    await expect(feedback).toHaveCSS("opacity", "0")

    const systemButton = await expectThemeToggle(
      page,
      "night-market",
      "system",
      "moon"
    )
    await systemButton.focus()
    await page.keyboard.press("Enter")
    await expect(feedback).toHaveText("System")
    await expect(status).toHaveText("Appearance set to System.")
    await expect(
      page.getByRole("button", {
        name: "Appearance: System. Switch to Day Market",
      })
    ).toBeFocused()
    await page.clock.runFor(150)
    await expectThemeFeedbackWithinViewport(page)
    await captureScreenshot(
      page,
      `${surface.name.toLowerCase()}-system-theme-feedback.png`
    )

    await page.clock.runFor(1_000)
    await expect(feedback).toHaveCSS("opacity", "0")
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" })
    await expectResolvedTheme(page, "day-market", "light")
    await expect(feedback).toHaveAttribute("data-state", "hidden")
    await expect(status).toHaveText("Appearance set to System.")
    await expect(feedback).toHaveCSS("transition-property", "none")

    await page.keyboard.press("Space")
    await expect(feedback).toHaveText("Day Market")
    await expect(feedback).toHaveCSS("opacity", "1")
    await page.clock.runFor(1_000)
    await expect(feedback).toHaveCSS("opacity", "0")
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
  await expectSilentThemeFeedback(syncedPage)

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
  await expectSilentThemeFeedback(syncedPage)

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
  await expectSilentThemeFeedback(syncedPage)

  await page.emulateMedia({ colorScheme: "light" })
  await expectResolvedTheme(page, "day-market", "light")
  await page.emulateMedia({ colorScheme: "dark" })
  await expectResolvedTheme(page, "night-market", "dark")

  await page.reload()
  await expectResolvedTheme(page, "night-market", "dark")
  await expectFirstFrameTheme(page, "night-market")
  await expectThemeToggle(page, "system", "day-market", "sun-moon")
  await expectSilentThemeFeedback(page)
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
