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
import {
  installTestSigner,
  TEST_MERCHANT_PUBKEY,
  TEST_RELAY_URL,
} from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"

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
  test(`shared wallet import composition and sensitive draft clearing in ${theme} @market`, async ({
    page,
  }, info) => {
    const identity = createRuntimeSignerIdentity()
    try {
      await installRealTestSigner(page, identity, TEST_RELAY_URL)
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
        name: "Import wallet",
        exact: true,
      })
      await expect(trigger).toBeEnabled()
      await trigger.click()
      const dialog = page.getByRole("dialog", {
        name: "Import wallet",
        exact: true,
      })
      const phrase = dialog.getByLabel("Recovery phrase", { exact: true })
      const field = await expectSharedField(phrase)
      expect(field.description).toBeTruthy()
      await expect(page.locator(`[id="${field.description}"]`)).toContainText(
        "original wallet"
      )
      await expect(phrase).toHaveAttribute("required", "")
      await dialog
        .locator("summary")
        .filter({ hasText: "Advanced settings" })
        .click()
      const account = dialog.getByLabel("Spark account number", { exact: true })
      const accountField = await expectSharedField(account)
      expect(accountField.description).toBeTruthy()
      await expect(
        page.locator(`[id="${accountField.description}"]`)
      ).toContainText("number saved with the source wallet")
      await phrase.fill("synthetic private draft")
      await account.fill("7")
      await expectContained(page)
      await screenshot(page, info, `wallet-restore-${theme}`)
      await page.keyboard.press("Escape")
      await expect(dialog).not.toBeVisible()
      await expect(trigger).toBeFocused()
      await trigger.click()
      await expect(phrase).toHaveValue("")
      await dialog
        .locator("summary")
        .filter({ hasText: "Advanced settings" })
        .click()
      await expect(account).toHaveValue("1")
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(trigger).toBeFocused()
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
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
