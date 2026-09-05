import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import {
  TEST_RELAY_URL,
  installTestSigner,
  readTestRelayEvents,
  seedTestRelayIdentity,
} from "./helpers/auth"

const merchantUrl =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
const PRODUCT_KIND = 30_402
const INBOX_DECLARATION_KIND = 10_050
const SECOND_NETWORK_RELAY_URL = "wss://network-backup.example"

const draftFixture = {
  title: "Browser-local relay kit",
  summary: "A complete draft retained across private inbox setup.",
  price: "42",
  stock: "7",
  currency: "SATS",
  format: "Digital",
  imageUrl: "https://media.conduit.market/browser-local-relay-kit.png",
  tags: ["relay", "merchant", "local-draft"],
} as const

async function captureEvidence(locator: Locator, name: string): Promise<void> {
  const outputDirectory = process.env.PLAYWRIGHT_DRAFT_SCREENSHOT_DIR
  if (!outputDirectory) return
  await mkdir(outputDirectory, { recursive: true })
  await locator.screenshot({
    animations: "disabled",
    path: join(outputDirectory, `${name}.png`),
  })
}

async function fillProductDraft(page: Page, title = draftFixture.title) {
  await page.getByRole("button", { name: "Add product" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel("Title").fill(title)
  await dialog.getByLabel("Summary").fill(draftFixture.summary)
  await dialog.getByLabel("Price").fill(draftFixture.price)
  await dialog.getByLabel("Stock quantity").fill(draftFixture.stock)

  await dialog.locator("#product-currency").click()
  await page.getByRole("option", { name: draftFixture.currency }).click()
  await dialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: draftFixture.format }).click()

  await dialog.getByLabel("Image URL").fill(draftFixture.imageUrl)
  const publicZaps = dialog.getByRole("checkbox", {
    name: /Enable public zaps for purchases/,
  })
  await publicZaps.uncheck()

  const tags = dialog.getByRole("combobox", { name: "Tags" })
  for (const tag of draftFixture.tags) {
    await tags.fill(tag)
    await tags.press("Enter")
  }

  await expect(
    dialog.getByRole("button", { name: "Publish product" })
  ).toBeEnabled()
  return dialog
}

async function expectProductDraft(
  page: Page,
  title = draftFixture.title
): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel("Title")).toHaveValue(title)
  await expect(dialog.getByLabel("Summary")).toHaveValue(draftFixture.summary)
  await expect(dialog.getByLabel("Price")).toHaveValue(draftFixture.price)
  await expect(dialog.getByLabel("Stock quantity")).toHaveValue(
    draftFixture.stock
  )
  await expect(dialog.locator("#product-currency")).toContainText(
    draftFixture.currency
  )
  await expect(dialog.locator("#product-fulfillment")).toContainText(
    draftFixture.format
  )
  await expect(dialog.getByLabel("Image URL")).toHaveValue(
    draftFixture.imageUrl
  )
  await expect(
    dialog.getByRole("checkbox", {
      name: /Enable public zaps for purchases/,
    })
  ).not.toBeChecked()
  for (const tag of draftFixture.tags) {
    await expect(
      dialog.getByRole("button", { name: `Remove ${tag} tag` })
    ).toBeVisible()
  }
  return dialog
}

async function choosePrivateInboxSetup(page: Page): Promise<void> {
  const productDialog = page.getByRole("dialog", { name: "Add product" })
  await productDialog.getByRole("button", { name: "Publish product" }).click()

  const readinessDialog = page.getByRole("alertdialog")
  await expect(
    readinessDialog.getByRole("heading", {
      name: "Set up your private inbox",
    })
  ).toBeVisible({ timeout: 15_000 })
  await readinessDialog
    .getByRole("button", { name: "Set up private inbox" })
    .click()
  await expect(page).toHaveURL(`${merchantUrl}/network`)
}

async function savePrivateInboxRole(page: Page): Promise<void> {
  const privateInboxRole = page.getByRole("button", {
    name: new RegExp(
      `^(Enable|Disable) Private inbox for ${TEST_RELAY_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
    ),
  })
  await expect(privateInboxRole).toBeEnabled({ timeout: 20_000 })
  await expect(privateInboxRole).toHaveAttribute("aria-pressed", "false")
  await privateInboxRole.focus()
  await expect(privateInboxRole).toBeFocused()
  await page.keyboard.press("Space")
  await expect(privateInboxRole).toHaveAttribute("aria-pressed", "true")
  const saveButton = page.getByRole("button", {
    name: "Save Network changes",
  })
  await expect(saveButton).toBeEnabled()
  await saveButton.click()
}

async function runCompleteJourney(
  page: Page,
  viewportName: "desktop" | "mobile"
): Promise<void> {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey, {
    inboxDeclaration: "omit",
    relayListUrls: [TEST_RELAY_URL, SECOND_NETWORK_RELAY_URL],
  })
  await installTestSigner(page, pubkey, { secretKey })

  await page.goto(merchantUrl)
  const privateInboxRow = page
    .getByRole("link")
    .filter({ hasText: "Private inbox" })
  await expect(privateInboxRow).toContainText("Needs setup", {
    timeout: 20_000,
  })
  await expect(page.getByRole("link", { name: "Network Ready" })).toBeVisible()
  const readinessPanel = page
    .locator("section")
    .filter({ hasText: "Merchant readiness" })
    .first()
  await captureEvidence(
    readinessPanel,
    `${viewportName}-private-inbox-readiness`
  )

  await page.goto(`${merchantUrl}/products`)
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()
  const productDialog = await fillProductDraft(page)
  await productDialog
    .locator("form")
    .getByRole("button", { name: "Close" })
    .click()
  await expect(productDialog).toBeHidden()

  const resumeButton = page.getByRole("button", {
    name: "Resume product draft",
  })
  await expect(resumeButton).toBeVisible()
  await expect(
    page.getByText(
      "This draft exists only in this browser on this device. It is not a public listing until you publish it.",
      { exact: true }
    )
  ).toBeVisible()
  const resumePanel = page
    .locator("section")
    .filter({ has: resumeButton })
    .first()
  await captureEvidence(resumePanel, `${viewportName}-resume-product-draft`)

  await page.reload()
  await expect(resumeButton).toBeVisible()
  await expect(page.getByRole("dialog", { name: "Add product" })).toBeHidden()
  await resumeButton.click()
  await expectProductDraft(page)

  await choosePrivateInboxSetup(page)
  expect(new URL(page.url()).search).toBe("")
  const savedBeforeSetup = await page.evaluate(
    ({ merchantPubkey, title }) => {
      const encodedPubkey = encodeURIComponent(merchantPubkey)
      const draft = localStorage.getItem(
        `conduit:merchant:product_draft:v1:${encodedPubkey}:create`
      )
      const returnIntent = localStorage.getItem(
        `conduit:merchant:product_draft_return:v1:${encodedPubkey}`
      )
      return {
        draftSaved: draft?.includes(title) ?? false,
        returnIntent: returnIntent ? JSON.parse(returnIntent) : null,
      }
    },
    { merchantPubkey: pubkey, title: draftFixture.title }
  )
  expect(savedBeforeSetup).toEqual({
    draftSaved: true,
    returnIntent: {
      version: 1,
      route: "/products",
      draftTarget: "create",
      state: "awaiting_inbox_setup",
    },
  })
  await expect(
    page.getByRole("button", { name: "Return to product draft" })
  ).toBeVisible()
  await captureEvidence(
    page.locator("main").first(),
    `${viewportName}-network-settings`
  )
  if (viewportName === "mobile") {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
  }

  await savePrivateInboxRole(page)
  await expect(page).toHaveURL(`${merchantUrl}/products`, { timeout: 20_000 })

  const reopenedDialog = await expectProductDraft(page)
  await expect(reopenedDialog.getByLabel("Title")).toBeFocused()
  expect(
    await page.evaluate((merchantPubkey) => {
      return localStorage.getItem(
        `conduit:merchant:product_draft_return:v1:${encodeURIComponent(merchantPubkey)}`
      )
    }, pubkey)
  ).toBeNull()

  const productEvents = await readTestRelayEvents({
    kinds: [PRODUCT_KIND],
    authors: [pubkey],
  })
  const inboxDeclarations = await readTestRelayEvents({
    kinds: [INBOX_DECLARATION_KIND],
    authors: [pubkey],
  })
  expect(productEvents).toHaveLength(0)
  expect(inboxDeclarations).toHaveLength(1)

  await captureEvidence(
    reopenedDialog,
    `${viewportName}-draft-reopened-after-network`
  )
  if (viewportName === "mobile") {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
  }

  await reopenedDialog
    .locator("form")
    .getByRole("button", { name: "Close" })
    .click()
  await expect(resumeButton).toBeFocused()
}

test("product draft returns from private inbox setup on desktop @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await runCompleteJourney(page, "desktop")
})

test("product draft returns from private inbox setup on mobile @merchant", async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()
  try {
    await runCompleteJourney(page, "mobile")
  } finally {
    await context.close()
  }
})

test("cancelled or failed inbox setup keeps the exact local draft @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  const title = "Inbox setup recovery draft"
  await seedTestRelayIdentity(secretKey, {
    inboxDeclaration: "omit",
    relayListUrls: [TEST_RELAY_URL, SECOND_NETWORK_RELAY_URL],
  })
  await installTestSigner(page, pubkey, { secretKey })
  await page.goto(`${merchantUrl}/products`)

  await fillProductDraft(page, title)
  await choosePrivateInboxSetup(page)
  await page.getByRole("button", { name: "Return to product draft" }).click()
  await expect(page).toHaveURL(`${merchantUrl}/products`)
  await expectProductDraft(page, title)

  await page.evaluate(() => {
    const signer = (
      window as unknown as {
        nostr: {
          signEvent: (
            event: Record<string, unknown>
          ) => Promise<Record<string, unknown>>
        }
      }
    ).nostr
    const originalSignEvent = signer.signEvent.bind(signer)
    signer.signEvent = async (event) => {
      if (event.kind === 10_050) {
        throw new Error("Test private inbox signing failure")
      }
      return originalSignEvent(event)
    }
  })

  await choosePrivateInboxSetup(page)
  await savePrivateInboxRole(page)
  await expect(
    page.getByText("Nostr signer failed: unavailable", { exact: true })
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByRole("button", { name: "Return to product draft" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Return to product draft" }).click()
  await expectProductDraft(page, title)

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard changes" }).click()
  await expect(
    page.getByRole("button", { name: "Resume product draft" })
  ).toHaveCount(0)
  expect(
    await page.evaluate((merchantPubkey) => {
      const encodedPubkey = encodeURIComponent(merchantPubkey)
      return {
        draft: localStorage.getItem(
          `conduit:merchant:product_draft:v1:${encodedPubkey}:create`
        ),
        returnIntent: localStorage.getItem(
          `conduit:merchant:product_draft_return:v1:${encodedPubkey}`
        ),
      }
    }, pubkey)
  ).toEqual({ draft: null, returnIntent: null })
})

test("publish choices keep editing or enter the signer path exactly once @merchant", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  const title = "Publish anyway once"
  await seedTestRelayIdentity(secretKey, {
    inboxDeclaration: "omit",
    relayListUrls: [TEST_RELAY_URL, SECOND_NETWORK_RELAY_URL],
  })
  await installTestSigner(page, pubkey, { secretKey })
  await page.goto(`${merchantUrl}/products`)
  await page.evaluate(() => {
    const browserWindow = window as unknown as {
      nostr: {
        signEvent: (
          event: Record<string, unknown>
        ) => Promise<Record<string, unknown>>
      }
      __productSignCount: number
    }
    const originalSignEvent = browserWindow.nostr.signEvent.bind(
      browserWindow.nostr
    )
    browserWindow.__productSignCount = 0
    browserWindow.nostr.signEvent = async (event) => {
      if (event.kind === 30_402) browserWindow.__productSignCount += 1
      return originalSignEvent(event)
    }
  })

  const productDialog = await fillProductDraft(page, title)
  await productDialog.getByRole("button", { name: "Publish product" }).click()
  let readinessDialog = page.getByRole("alertdialog")
  await expect(
    readinessDialog.getByRole("heading", {
      name: "Set up your private inbox",
    })
  ).toBeVisible({ timeout: 15_000 })
  await readinessDialog.getByRole("button", { name: "Keep editing" }).click()
  await expect(productDialog).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __productSignCount: number }).__productSignCount
    )
  ).toBe(0)

  await productDialog.getByRole("button", { name: "Publish product" }).click()
  readinessDialog = page.getByRole("alertdialog")
  await readinessDialog.getByRole("button", { name: "Publish anyway" }).click()
  await expect(productDialog).toBeHidden({ timeout: 15_000 })
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __productSignCount: number }).__productSignCount
    )
  ).toBe(1)
  await expect
    .poll(async () => {
      const events = await readTestRelayEvents({
        kinds: [PRODUCT_KIND],
        authors: [pubkey],
      })
      return events.filter((event) =>
        event.tags.some(([name, value]) => name === "title" && value === title)
      ).length
    })
    .toBe(1)
})
