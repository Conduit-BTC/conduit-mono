import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test"
import { THEME_STORAGE_KEY } from "@conduit/ui/theme"
import { installTestSigner, TEST_MERCHANT_PUBKEY } from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

async function expectContained(page: Page) {
  const geometry = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }))
  expect(geometry.content).toBeLessThanOrEqual(geometry.width + 1)
}

async function expectSharedField(control: Locator) {
  const geometry = await control.evaluate((element) => {
    const label = document.querySelector(`label[for="${element.id}"]`)
    if (!label) throw new Error("Missing visible field label")
    return {
      gap:
        element.getBoundingClientRect().top -
        label.getBoundingClientRect().bottom,
      font: getComputedStyle(element).fontFamily,
      size: parseFloat(getComputedStyle(element).fontSize),
      description: element.getAttribute("aria-describedby"),
    }
  })
  expect(geometry.gap).toBeCloseTo(4, 0)
  expect(geometry.font).toContain("Poppins")
  expect(geometry.size).toBeGreaterThanOrEqual(16)
  return geometry
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const directory = process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  // These screens contain empty wallet fields and synthetic event identity only.
  // Mask account identifiers; never capture credentials, balances or pairing data.
  await page.screenshot({
    path: join(directory, `${info.project.name}-${name}.png`),
    fullPage: true,
    mask: [
      page.locator('input[type="password"], textarea'),
      page.getByRole("button", { name: /Open.*account menu/ }),
    ],
  })
}

for (const theme of ["day-market", "night-market"] as const) {
  test(`shared wallet setup and restore composition in ${theme} @market`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      ({ key, theme }) => localStorage.setItem(key, theme),
      { key: THEME_STORAGE_KEY, theme }
    )
    await page.goto(`${marketUrl}/wallet`)
    await expect(
      page.getByRole("heading", { name: "Wallets", exact: true })
    ).toBeVisible()
    await expectContained(page)
    const trigger = page.getByRole("button", {
      name: "Add portable wallet",
      exact: true,
    })
    await trigger.click()
    const dialog = page.getByRole("dialog", { name: "Add a Spark wallet" })
    const nickname = dialog.getByLabel("Wallet nickname (optional)")
    const field = await expectSharedField(nickname)
    expect(field.description).toBeTruthy()
    await expect(page.locator(`[id="${field.description}"]`)).toContainText(
      "stored only in this browser"
    )
    await dialog.getByRole("tab", { name: "Restore", exact: true }).click()
    await expectSharedField(
      dialog.getByLabel("Recovery phrase", { exact: true })
    )
    await expect(
      dialog.getByLabel("Recovery phrase", { exact: true })
    ).toHaveAttribute("required", "")
    await expectContained(page)
    await screenshot(page, info, `wallet-restore-${theme}`)
    await page.keyboard.press("Escape")
    await expect(dialog).not.toBeVisible()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(nickname).toHaveValue("")
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  })

  test(`shared Events page composition in ${theme} @merchant`, async ({
    page,
  }, info) => {
    await installTestSigner(page, TEST_MERCHANT_PUBKEY)
    await page.addInitScript(
      ({ key, theme }) => localStorage.setItem(key, theme),
      { key: THEME_STORAGE_KEY, theme }
    )
    await page.goto(`${merchantUrl}/events`)
    const heading = page.getByRole("heading", { name: "Events", exact: true })
    await expect(heading).toBeVisible({ timeout: 20_000 })
    await expect(
      page.getByRole("button", { name: "Create event", exact: true }).first()
    ).toBeVisible()
    await expect(
      page.getByText(
        "Find events where you can sell, or create and manage an event of your own."
      )
    ).toBeVisible()
    expect(
      await heading.evaluate((element) => getComputedStyle(element).fontFamily)
    ).toContain("Poppins")
    await expectContained(page)
    await screenshot(page, info, `events-${theme}`)
  })
}
