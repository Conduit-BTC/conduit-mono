import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { nip19 } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  TEST_RELAY_URL,
  installTestSigner,
  publishTestRelayEvents,
  readTestRelayEvents,
  seedTestRelayIdentity,
} from "./helpers/auth"

const merchantUrl =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
const PRODUCT_KIND = 30_402
const INBOX_DECLARATION_KIND = 10_050

const draftFixture = {
  title: "Browser-local relay kit",
  summary: "A complete draft retained across private inbox setup.",
  price: "42",
  stock: "7",
  currency: "SATS",
  format: "Digital",
  imageUrls: [
    "https://media.conduit.market/browser-local-relay-kit.png",
    "https://media.conduit.market/browser-local-relay-kit-detail.png",
  ],
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

  await expect(dialog.getByLabel("Image 2 URL")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await dialog.getByLabel("Primary image URL").fill(draftFixture.imageUrls[0])
  await dialog.getByRole("button", { name: "Add by URL", exact: true }).click()
  const secondImage = dialog.getByLabel("Image 2 URL")
  await expect(secondImage).toBeFocused()
  await secondImage.fill(draftFixture.imageUrls[1])
  await dialog
    .getByRole("button", { name: "Move image 2 up", exact: true })
    .click()
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
  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(
    draftFixture.imageUrls[1]
  )
  await expect(dialog.getByLabel("Image 2 URL")).toHaveValue(
    draftFixture.imageUrls[0]
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

async function submitPrivateInboxChange(page: Page): Promise<void> {
  const relaySettings = page.getByRole("region", { name: "Relays" })
  const enablePrivateInbox = relaySettings.getByRole("button", {
    name: `Enable Private inbox for ${TEST_RELAY_URL}`,
  })
  await expect(enablePrivateInbox).toBeEnabled({ timeout: 20_000 })
  await enablePrivateInbox.click()

  const reviewButton = relaySettings.getByRole("button", {
    name: "Review and publish",
  })
  await expect(reviewButton).toBeEnabled()
  await reviewButton.click()
  const reviewDialog = page.getByRole("alertdialog")
  await expect(
    reviewDialog.getByRole("heading", {
      name: "Publish these Network changes?",
    })
  ).toBeVisible()
  await reviewDialog.getByRole("button", { name: "Sign and publish" }).click()
}

async function runCompleteJourney(
  page: Page,
  viewportName: "desktop" | "mobile"
): Promise<void> {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey, { inboxDeclaration: "omit" })
  await installTestSigner(page, pubkey, { secretKey })

  await page.goto(merchantUrl)
  const readinessPanel = page
    .locator("section")
    .filter({ hasText: "Merchant readiness" })
    .first()
  await expect(readinessPanel).toBeVisible({ timeout: 20_000 })
  await expect(readinessPanel.getByText("Private inbox")).toHaveCount(0)
  await expect(
    readinessPanel.getByRole("link", { name: "Network Ready" })
  ).toBeVisible()
  await captureEvidence(readinessPanel, `${viewportName}-merchant-readiness`)

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

  await submitPrivateInboxChange(page)
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
  await seedTestRelayIdentity(secretKey, { inboxDeclaration: "omit" })
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
  await submitPrivateInboxChange(page)
  await expect(
    page.getByText("Nostr signer failed: unavailable", { exact: true })
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByRole("button", { name: "Return to product draft" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Return to product draft" }).click()
  const leaveDialog = page.getByRole("alertdialog")
  await expect(
    leaveDialog.getByRole("heading", {
      name: "Leave with unpublished relay changes?",
    })
  ).toBeVisible()
  await leaveDialog.getByRole("button", { name: "Leave and discard" }).click()
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
  await seedTestRelayIdentity(secretKey, { inboxDeclaration: "omit" })
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

test("merchant publishes versioned supplier allocation terms with explicit profile relays @merchant", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const merchantSecretKey = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecretKey)
  const supplierPubkey = getPublicKey(generateSecretKey())
  const title = `Supplier allocation ${Date.now().toString(36)}`
  await seedTestRelayIdentity(merchantSecretKey, { inboxDeclaration: "omit" })
  await installTestSigner(page, merchantPubkey, {
    secretKey: merchantSecretKey,
  })
  await page.goto(`${merchantUrl}/products`)

  const productDialog = await fillProductDraft(page, title)
  await productDialog
    .getByRole("checkbox", {
      name: "Publish signed supplier allocation terms",
    })
    .check()
  await productDialog.getByLabel("Merchant weight").fill("3")
  await productDialog
    .getByLabel("Merchant profile relay")
    .fill("wss://relay.conduit.market")
  await productDialog.getByRole("button", { name: "Add supplier" }).click()
  await productDialog
    .getByLabel("Supplier identity")
    .fill(nip19.npubEncode(supplierPubkey))
  await productDialog
    .getByLabel("Profile relay", { exact: true })
    .fill("wss://nos.lol")
  await productDialog.getByLabel("Weight", { exact: true }).fill("1")
  await expect(
    productDialog.getByRole("button", { name: "Publish product" })
  ).toBeEnabled()
  await productDialog.getByRole("button", { name: "Publish product" }).click()
  const readinessDialog = page.getByRole("alertdialog")
  await expect(
    readinessDialog.getByRole("heading", {
      name: "Set up your private inbox",
    })
  ).toBeVisible({ timeout: 15_000 })
  await readinessDialog.getByRole("button", { name: "Publish anyway" }).click()
  await expect(productDialog).toBeHidden({ timeout: 15_000 })

  await expect
    .poll(async () => {
      const events = await readTestRelayEvents({
        kinds: [PRODUCT_KIND],
        authors: [merchantPubkey],
      })
      return events.find((event) =>
        event.tags.some(([name, value]) => name === "title" && value === title)
      )?.tags
    })
    .toEqual(
      expect.arrayContaining([
        ["conduit_supplier_allocation", "1"],
        ["zap", merchantPubkey, "wss://relay.conduit.market/", "3"],
        ["zap", supplierPubkey, "wss://nos.lol/", "1"],
      ])
    )
})

test("merchant must explicitly repair or remove malformed allocation evidence before editing @merchant", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const merchantSecretKey = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecretKey)
  const supplierPubkey = getPublicKey(generateSecretKey())
  const title = `Malformed allocation ${Date.now().toString(36)}`
  const createdAt = Math.floor(Date.now() / 1_000)
  await seedTestRelayIdentity(merchantSecretKey, { inboxDeclaration: "omit" })
  await publishTestRelayEvents([
    finalizeEvent(
      {
        kind: PRODUCT_KIND,
        created_at: createdAt,
        tags: [
          ["d", `malformed-allocation-${createdAt}`],
          ["title", title],
          ["summary", "A listing with malformed signed split evidence."],
          ["price", "10", "SATS"],
          ["type", "simple", "digital"],
          ["image", "https://media.conduit.market/malformed-allocation.png"],
          ["t", "allocation"],
          ["t", "merchant"],
          ["t", "test"],
          ["conduit_supplier_allocation", "2"],
          ["zap", merchantPubkey, "wss://relay.conduit.market", "3"],
          ["zap", supplierPubkey, "wss://nos.lol", "1"],
          ["zap", "not-a-public-key", "wss://relay.ditto.pub", "1"],
        ],
        content: "A listing with malformed signed split evidence.",
      },
      merchantSecretKey
    ),
  ])
  await installTestSigner(page, merchantPubkey, {
    secretKey: merchantSecretKey,
  })
  await page.goto(`${merchantUrl}/products`)

  await expect(page.getByText(title, { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Edit listing" })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Title").fill(`${title} updated`)
  await expect(
    dialog.getByRole("alert").filter({
      hasText:
        "Repair the invalid signed revenue-split terms or remove them before publishing.",
    })
  ).toBeVisible()
  await expect(
    dialog.getByRole("button", { name: "Save changes", exact: true })
  ).toBeDisabled()

  await dialog.getByLabel("Merchant weight").fill("4")
  await expect(
    dialog.getByRole("button", { name: "Save changes", exact: true })
  ).toBeEnabled()
})

test("merchant rejects a stale unrelated family edit before signing refreshed allocation terms @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const merchantSecretKey = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecretKey)
  const supplierPubkey = getPublicKey(generateSecretKey())
  const suffix = Date.now().toString(36)
  const parentDTag = `allocation-refresh-${suffix}`
  const childDTag = `${parentDTag}-small`
  const initialTitle = `Allocation refresh ${suffix}`
  const refreshedTitle = `${initialTitle} current`
  const parentCoordinate = `${PRODUCT_KIND}:${merchantPubkey}:${parentDTag}`
  const initialCreatedAt = Math.floor(Date.now() / 1_000) - 60
  const familyEvent = (input: {
    dTag: string
    title: string
    child: boolean
    createdAt: number
    allocated: boolean
  }) =>
    finalizeEvent(
      {
        kind: PRODUCT_KIND,
        created_at: input.createdAt,
        tags: [
          ["d", input.dTag],
          ["title", input.title],
          ["summary", "A signed family for allocation refresh QA."],
          ["price", "10", "SATS"],
          ["type", input.child ? "variation" : "variable", "digital"],
          ["image", "https://media.conduit.market/allocation-refresh.png"],
          ["t", "allocation"],
          ["t", "family"],
          ["t", "regression"],
          ...(input.child
            ? [
                ["a", parentCoordinate],
                ["spec", "size", "Small"],
              ]
            : []),
          ...(input.allocated
            ? [
                ["conduit_supplier_allocation", "1"],
                ["zap", merchantPubkey, "wss://relay.conduit.market", "3"],
                ["zap", supplierPubkey, "wss://nos.lol", "1"],
              ]
            : []),
        ],
        content: "A signed family for allocation refresh QA.",
      },
      merchantSecretKey
    )

  await seedTestRelayIdentity(merchantSecretKey, { inboxDeclaration: "omit" })
  await publishTestRelayEvents([
    familyEvent({
      dTag: parentDTag,
      title: initialTitle,
      child: false,
      createdAt: initialCreatedAt,
      allocated: false,
    }),
    familyEvent({
      dTag: childDTag,
      title: `${initialTitle} Small`,
      child: true,
      createdAt: initialCreatedAt + 1,
      allocated: false,
    }),
  ])
  await installTestSigner(page, merchantPubkey, {
    secretKey: merchantSecretKey,
  })
  await page.goto(`${merchantUrl}/products`)

  await expect(page.getByText(initialTitle, { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Edit product family" })
  await expect(dialog).toBeVisible()
  await dialog
    .getByLabel("Title", { exact: true })
    .fill(`${initialTitle} edited`)
  await page.evaluate((productKind) => {
    const browserWindow = window as unknown as {
      nostr: {
        signEvent: (
          event: Record<string, unknown>
        ) => Promise<Record<string, unknown>>
      }
      __staleFamilyProductSignCount: number
    }
    const originalSignEvent = browserWindow.nostr.signEvent.bind(
      browserWindow.nostr
    )
    browserWindow.__staleFamilyProductSignCount = 0
    browserWindow.nostr.signEvent = async (event) => {
      if (event.kind === productKind) {
        browserWindow.__staleFamilyProductSignCount += 1
      }
      return originalSignEvent(event)
    }
  }, PRODUCT_KIND)

  await publishTestRelayEvents([
    familyEvent({
      dTag: parentDTag,
      title: refreshedTitle,
      child: false,
      createdAt: initialCreatedAt + 30,
      allocated: true,
    }),
    familyEvent({
      dTag: childDTag,
      title: `${refreshedTitle} Small`,
      child: true,
      createdAt: initialCreatedAt + 31,
      allocated: true,
    }),
  ])
  // The root card updating behind the still-open dialog proves Merchant has
  // consumed a newer complete family read before the stale form is submitted.
  await expect(page.getByText(refreshedTitle, { exact: true })).toBeVisible({
    timeout: 35_000,
  })
  await dialog.getByRole("button", { name: "Save changes" }).click()
  await expect(
    dialog.getByText(
      "Products changed while this editor was open. Refresh and reopen the product before changing supplier allocation terms."
    )
  ).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __staleFamilyProductSignCount: number })
          .__staleFamilyProductSignCount
    )
  ).toBe(0)
  const productEvents = await readTestRelayEvents({
    kinds: [PRODUCT_KIND],
    authors: [merchantPubkey],
  })
  // Replaceable kind-30402 coordinates expose only the latest signed root and
  // child. The rejected stale title must never appear as another revision.
  expect(productEvents).toHaveLength(2)
  expect(
    productEvents.map(
      (event) => event.tags.find(([name]) => name === "title")?.[1]
    )
  ).toEqual(expect.arrayContaining([refreshedTitle, `${refreshedTitle} Small`]))
})

test("merchant cannot sign changed allocation terms from a degraded family missing a child @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const merchantSecretKey = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecretKey)
  const supplierPubkey = getPublicKey(generateSecretKey())
  const suffix = Date.now().toString(36)
  const parentDTag = `incomplete-allocation-${suffix}`
  const parentCoordinate = `${PRODUCT_KIND}:${merchantPubkey}:${parentDTag}`
  const createdAt = Math.floor(Date.now() / 1_000) - 60
  const allocationTags = [
    ["conduit_supplier_allocation", "1"],
    ["zap", merchantPubkey, "wss://relay.conduit.market", "3"],
    ["zap", supplierPubkey, "wss://nos.lol", "1"],
  ]
  const members = [
    { dTag: parentDTag, title: `Incomplete family ${suffix}`, size: null },
    {
      dTag: `${parentDTag}-small`,
      title: `Incomplete family ${suffix} Small`,
      size: "Small",
    },
    {
      dTag: `${parentDTag}-large`,
      title: `Incomplete family ${suffix} Large`,
      size: "Large",
    },
  ] as const
  const signedMembers = members.map((member, index) =>
    finalizeEvent(
      {
        kind: PRODUCT_KIND,
        created_at: createdAt + index,
        tags: [
          ["d", member.dTag],
          ["title", member.title],
          ["summary", "A signed family with a missing cached variation."],
          ["price", "10", "SATS"],
          ["type", member.size ? "variation" : "variable", "digital"],
          ["image", "https://media.conduit.market/incomplete-allocation.png"],
          ["t", "allocation"],
          ["t", "family"],
          ["t", "regression"],
          ...(member.size
            ? [
                ["a", parentCoordinate],
                ["spec", "size", member.size],
              ]
            : []),
          ...allocationTags,
        ],
        content: "A signed family with a missing cached variation.",
      },
      merchantSecretKey
    )
  )

  await seedTestRelayIdentity(merchantSecretKey, { inboxDeclaration: "omit" })
  await publishTestRelayEvents(signedMembers)
  expect(
    await readTestRelayEvents({
      kinds: [PRODUCT_KIND],
      authors: [merchantPubkey],
    })
  ).toHaveLength(3)
  await installTestSigner(page, merchantPubkey, {
    secretKey: merchantSecretKey,
  })
  // The backing relay has three signed coordinates, but this browser only has
  // two cached members and cannot complete a relay read to discover the third.
  await page.routeWebSocket(/^wss?:\/\//, (socket) => {
    void socket.close()
  })
  await page.goto(`${merchantUrl}/products`)
  await page.evaluate(
    ({
      merchantPubkey,
      supplierPubkey,
      parentCoordinate,
      members,
      eventIds,
      createdAt,
      relayUrl,
    }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction("products", "readwrite")
          const cachedAt = Date.now()
          for (const index of [0, 1]) {
            const member = members[index]
            transaction.objectStore("products").put({
              id: `${30_402}:${merchantPubkey}:${member.dTag}`,
              pubkey: merchantPubkey,
              dTag: member.dTag,
              title: member.title,
              summary: "A signed family with a missing cached variation.",
              price: 10,
              currency: "SATS",
              priceSats: 10,
              type: member.size ? "variation" : "variable",
              parentProductId: member.size ? parentCoordinate : undefined,
              specifications: member.size
                ? [{ key: "size", value: member.size }]
                : [],
              format: "digital",
              visibility: "public",
              stock: 1,
              images: [
                {
                  url: "https://media.conduit.market/incomplete-allocation.png",
                },
              ],
              tags: ["allocation", "family", "regression"],
              publicZapEnabled: true,
              zapMessagePolicy: "generic_only",
              publicZapPolicyKnown: true,
              supplierAllocation: {
                state: "valid",
                recipients: [
                  {
                    pubkey: merchantPubkey,
                    relayHint: "wss://relay.conduit.market/",
                    weight: 3,
                    role: "merchant",
                  },
                  {
                    pubkey: supplierPubkey,
                    relayHint: "wss://nos.lol/",
                    weight: 1,
                    role: "supplier",
                  },
                ],
                issues: [],
                revisionEventId: eventIds[index],
                revisionCreatedAt: createdAt + index,
              },
              eventId: eventIds[index],
              eventCreatedAt: createdAt + index,
              sourceRelayUrls: [relayUrl],
              createdAt: cachedAt,
              updatedAt: cachedAt,
              cachedAt,
            })
          }
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    {
      merchantPubkey,
      supplierPubkey,
      parentCoordinate,
      members,
      eventIds: signedMembers.map((event) => event.id),
      createdAt,
      relayUrl: TEST_RELAY_URL,
    }
  )
  await page.reload()
  await expect(page.getByText(members[0].title, { exact: true })).toBeVisible({
    timeout: 35_000,
  })
  await expect(page.getByText(members[2].title, { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Edit product family" })
  await expect(dialog).toBeVisible()
  await page.evaluate((productKind) => {
    const browserWindow = window as unknown as {
      nostr: {
        signEvent: (
          event: Record<string, unknown>
        ) => Promise<Record<string, unknown>>
      }
      __incompleteFamilyProductSignCount: number
    }
    const originalSignEvent = browserWindow.nostr.signEvent.bind(
      browserWindow.nostr
    )
    browserWindow.__incompleteFamilyProductSignCount = 0
    browserWindow.nostr.signEvent = async (event) => {
      if (event.kind === productKind) {
        browserWindow.__incompleteFamilyProductSignCount += 1
      }
      return originalSignEvent(event)
    }
  }, PRODUCT_KIND)
  await dialog.getByLabel("Merchant weight").fill("4")
  await dialog.getByRole("button", { name: "Save changes" }).click()
  await expect(
    dialog.getByText(
      "Refresh products before changing supplier allocation terms. The current product-family read is incomplete."
    )
  ).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __incompleteFamilyProductSignCount: number })
          .__incompleteFamilyProductSignCount
    )
  ).toBe(0)
  expect(
    await readTestRelayEvents({
      kinds: [PRODUCT_KIND],
      authors: [merchantPubkey],
    })
  ).toHaveLength(3)
})
