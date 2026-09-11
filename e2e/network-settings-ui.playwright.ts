import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import {
  TEST_RELAY_URL,
  installTestSigner,
  seedTestRelayIdentity,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const screenshotDirectory = process.env.PLAYWRIGHT_NETWORK_UI_SCREENSHOT_DIR
const accountNetworkLocalStateModuleUrl = `/@fs/${join(
  process.cwd(),
  "packages/core/src/protocol/account-network-local-state.ts"
)}`
const layouts = [
  { name: "desktop", viewport: { width: 1280, height: 720 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
] as const

async function openNetwork(
  page: Page,
  app: "market" | "merchant"
): Promise<{ appUrl: string; pubkey: string }> {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey)
  await installTestSigner(page, pubkey, { secretKey })
  const appUrl = app === "market" ? marketUrl : merchantUrl

  await page.goto(app === "market" ? `${appUrl}/products` : appUrl)
  await expect(
    page.getByRole("button", {
      name:
        app === "market"
          ? "Open account menu"
          : /^Open (merchant account )?menu$/,
    })
  ).toBeVisible({ timeout: 15_000 })
  await page.goto(`${appUrl}/network`)
  await expect(
    page.getByRole("heading", { name: "Network", exact: true })
  ).toBeVisible()
  return { appUrl, pubkey }
}

async function expectMinimumTouchTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  expect(box, "expected a visible control with a bounding box").not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
}

test("account-local relay preference reaches another storage-sharing tab without reload @market @merchant", async ({
  page,
  context,
}) => {
  const secondPage = await context.newPage()
  await Promise.all([
    page.goto(`${marketUrl}/products`),
    secondPage.goto(`${marketUrl}/products`),
  ])
  const pubkey = getPublicKey(generateSecretKey())
  // Mock browser mode intentionally admits only the isolated relay. The
  // multi-relay permutation semantics are covered by the local-state and view
  // tests; this browser seam verifies that the preference crosses tabs.
  const preferredRelayOrder = [TEST_RELAY_URL]
  const observedOrder = secondPage.evaluate(
    async ({ moduleUrl, accountPubkey, expectedOrder }) => {
      const localState = await import(/* @vite-ignore */ moduleUrl)
      return await new Promise<string[]>((resolve, reject) => {
        let unsubscribe = () => undefined
        const timeout = window.setTimeout(() => {
          unsubscribe()
          reject(new Error("Timed out waiting for the shared relay order."))
        }, 5_000)
        unsubscribe = localState.subscribeAccountNetworkLocalState(
          accountPubkey,
          {
            onChange(state: { preferredRelayOrder?: string[] } | undefined) {
              if (
                JSON.stringify(state?.preferredRelayOrder ?? []) !==
                JSON.stringify(expectedOrder)
              ) {
                return
              }
              window.clearTimeout(timeout)
              unsubscribe()
              resolve([...(state?.preferredRelayOrder ?? [])])
            },
            onError(error: unknown) {
              window.clearTimeout(timeout)
              unsubscribe()
              reject(error)
            },
          }
        )
      })
    },
    {
      moduleUrl: accountNetworkLocalStateModuleUrl,
      accountPubkey: pubkey,
      expectedOrder: preferredRelayOrder,
    }
  )

  await page.evaluate(
    async ({ moduleUrl, accountPubkey, nextOrder }) => {
      const localState = await import(/* @vite-ignore */ moduleUrl)
      await localState.dexieAccountNetworkLocalStateRepository.update(
        accountPubkey,
        (current: unknown) =>
          localState.replaceAccountNetworkPreferredRelayOrder(
            current,
            nextOrder,
            Date.now()
          )
      )
    },
    {
      moduleUrl: accountNetworkLocalStateModuleUrl,
      accountPubkey: pubkey,
      nextOrder: preferredRelayOrder,
    }
  )

  expect(await observedOrder).toEqual(preferredRelayOrder)
  await expect(secondPage).toHaveURL(`${marketUrl}/products`)
})

for (const app of ["market", "merchant"] as const) {
  for (const layout of layouts) {
    test(`${app} ${layout.name} reconstructs signed Network preferences despite obsolete local settings @${app}`, async ({
      page,
    }) => {
      await page.setViewportSize(layout.viewport)
      const { pubkey } = await openNetwork(page, app)
      const legacyRelayUrl = "wss://obsolete-local-network.example"
      const legacySettings = JSON.stringify({
        version: 1,
        updatedAt: 1,
        entries: [
          {
            url: legacyRelayUrl,
            readEnabled: true,
            writeEnabled: true,
            section: "public",
            source: "manual",
            capabilities: {},
            warnings: {},
          },
        ],
      })
      const obsoleteEntries = [
        ...["market", "merchant", "account"].map((scope) => [
          `conduit:relay-settings:v1:${scope}:${pubkey}`,
          legacySettings,
        ]),
        [
          `conduit:network-legacy-migration:v1:${pubkey}`,
          JSON.stringify({
            version: 1,
            status: "prepared",
            sourceFingerprint: "obsolete-source",
          }),
        ],
        [
          `conduit:network-legacy-read-recovery:v1:${pubkey}`,
          JSON.stringify({
            version: 1,
            readRelayUrls: [legacyRelayUrl],
            updatedAt: 1,
          }),
        ],
      ]
      await page.evaluate((entries) => {
        for (const [key, value] of entries) localStorage.setItem(key, value)
      }, obsoleteEntries)
      await page.reload()

      await expect(
        page.getByRole("heading", { name: "Network", exact: true })
      ).toBeVisible()
      for (const role of ["Read", "Publish", "Private inbox"]) {
        await expect(
          page.getByRole("button", {
            name: `Disable ${role} for ${TEST_RELAY_URL}`,
            exact: true,
          })
        ).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 })
      }
      await expect(page.getByText(legacyRelayUrl, { exact: true })).toHaveCount(
        0
      )
      await expect(
        page.getByText("Older relay role draft", { exact: true })
      ).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: "Discard older draft" })
      ).toHaveCount(0)
      expect(
        await page.evaluate(
          (entries) => entries.map(([key]) => [key, localStorage.getItem(key)]),
          obsoleteEntries
        )
      ).toEqual(obsoleteEntries)

      if (screenshotDirectory) {
        mkdirSync(screenshotDirectory, { recursive: true })
        await page.screenshot({
          path: join(
            screenshotDirectory,
            `${app}-${layout.name}-network-signed-reconstruction.png`
          ),
          fullPage: true,
          animations: "disabled",
        })
      }
    })

    test(`${app} ${layout.name} warns before discarding unpublished relay edits @${app}`, async ({
      page,
    }) => {
      await page.setViewportSize(layout.viewport)
      const { appUrl } = await openNetwork(page, app)
      const removeRelay = page.getByRole("button", {
        name: `Remove ${TEST_RELAY_URL} from my whole setup`,
      })
      await expect(removeRelay).toBeEnabled({ timeout: 20_000 })
      if (layout.name === "mobile") {
        await expectMinimumTouchTarget(removeRelay)
        await expectMinimumTouchTarget(
          page.getByRole("button", { name: "Refresh" }).first()
        )
        await expectMinimumTouchTarget(
          page.getByRole("button", { name: "Add relay" })
        )
        await expectMinimumTouchTarget(
          page.getByRole("button", { name: "Review and publish" }).first()
        )
        const disclosureControls = page.locator("summary:visible")
        const disclosureCount = await disclosureControls.count()
        expect(disclosureCount).toBeGreaterThan(0)
        for (let index = 0; index < disclosureCount; index += 1) {
          await expectMinimumTouchTarget(disclosureControls.nth(index))
        }
      }
      await removeRelay.click()
      const removalDialog = page.getByRole("alertdialog")
      await expect(
        removalDialog.getByRole("heading", {
          name: "Remove this relay from your whole setup?",
        })
      ).toBeVisible()
      await expect(removalDialog).toContainText(
        "Enable Publish on at least one relay."
      )
      await expect(removalDialog).toContainText(
        "ends any recovery reads for this relay immediately"
      )
      const cancelRemoval = removalDialog.getByRole("button", {
        name: "Cancel",
      })
      await expect(
        removalDialog.getByRole("button", { name: "Proceed" })
      ).toBeDisabled()
      if (layout.name === "mobile") {
        await expectMinimumTouchTarget(cancelRemoval)
        await expectMinimumTouchTarget(
          removalDialog.getByRole("button", { name: "Proceed" })
        )
      }
      await cancelRemoval.click()
      await expect(removeRelay).toBeFocused()

      const readRole = page.getByRole("button", {
        name: new RegExp(
          `^(Disable|Enable) Read for ${TEST_RELAY_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
        ),
      })

      await expect(readRole).toBeEnabled({ timeout: 20_000 })
      if (layout.name === "mobile") await expectMinimumTouchTarget(readRole)
      await readRole.click()
      await expect(readRole).toHaveAttribute("aria-pressed", "false")
      await expect(
        page.getByText("Unpublished changes", { exact: true })
      ).toBeVisible()

      const leaveTrigger =
        app === "merchant" && layout.name === "mobile"
          ? page.getByRole("link", { name: "Home", exact: true })
          : page.getByRole("link", { name: /Conduit/i }).first()
      if (app === "merchant" && layout.name === "mobile") {
        await page.getByRole("button", { name: "Open menu" }).click()
        await expect(leaveTrigger).toBeVisible()
      }
      await leaveTrigger.click()
      const leaveDialog = page.getByRole("alertdialog")
      await expect(
        leaveDialog.getByRole("heading", {
          name: "Leave with unpublished relay changes?",
        })
      ).toBeVisible()
      await expect(leaveDialog).toContainText(
        "Conduit and other Nostr apps will keep using your last published preferences."
      )
      const keepEditing = leaveDialog.getByRole("button", {
        name: "Keep editing",
      })
      await expect(keepEditing).toBeFocused()
      if (screenshotDirectory) {
        mkdirSync(screenshotDirectory, { recursive: true })
        await page.screenshot({
          path: join(
            screenshotDirectory,
            `${app}-${layout.name}-network-unpublished-warning.png`
          ),
          fullPage: true,
          animations: "disabled",
        })
      }
      await keepEditing.click()
      await expect(page).toHaveURL(`${appUrl}/network`)
      await expect(leaveTrigger).toBeFocused()
      if (app === "merchant" && layout.name === "mobile") {
        await page
          .getByRole("dialog", { name: "Conduit" })
          .getByRole("button", { name: "Close" })
          .click()
      }
      await expect(readRole).toHaveAttribute("aria-pressed", "false")

      if (app === "merchant" && layout.name === "mobile") {
        await page.getByRole("button", { name: "Open menu" }).click()
        await expect(leaveTrigger).toBeVisible()
      }
      await leaveTrigger.click()
      await leaveDialog
        .getByRole("button", { name: "Leave and discard" })
        .click()
      await expect(page).toHaveURL(`${appUrl}/`)

      await page.goto(`${appUrl}/network`)
      await expect(readRole).toHaveAttribute("aria-pressed", "true", {
        timeout: 20_000,
      })
    })
  }
}
