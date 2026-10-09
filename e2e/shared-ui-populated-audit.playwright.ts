import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { nip19 } from "nostr-tools"
import { THEME_STORAGE_KEY } from "@conduit/ui/theme"
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
test.use({ trace: "off", screenshot: "off", video: "off" })

async function inspect(page: Page, info: TestInfo, name: string) {
  const geometry = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }))
  expect(geometry.content, name).toBeLessThanOrEqual(geometry.width + 1)
  const directory = process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.screenshot({
    path: join(directory, `${info.project.name}-${name}.png`),
    fullPage: true,
    mask: [
      page.locator("input,textarea,.font-mono"),
      page.getByRole("button", { name: /Open.*account menu/ }),
    ],
  })
}

for (const theme of ["day-market", "night-market"]) {
  test(`populated profile, payment readiness, catalog and editor surfaces in ${theme} @merchant`, async ({
    page,
  }, info) => {
    const identity = createRuntimeSignerIdentity()
    const { pubkey } = identity
    try {
      const title =
        "Colombia coffee gift set with an exceptionally long catalog name"
      const createdAt = Math.floor(Date.now() / 1000)
      const coordinate = `30402:${pubkey}:visual-coffee`
      await publishTestRelayEvents([
        signRuntimeTestEvent(identity, {
          kind: 0,
          created_at: createdAt,
          tags: [],
          content: JSON.stringify({
            name: "Sample Roastery",
            display_name:
              "Sample neighborhood roastery and merchant collective",
            about:
              "Fictional coffee and accessories for the shared surface review.",
            picture: "https://ui-smoke.conduit.market/avatar.svg",
            banner: "https://ui-smoke.conduit.market/banner.svg",
            lud16: "merchant@ui-smoke.conduit.market",
          }),
        }),
        signRuntimeTestEvent(identity, {
          kind: 10002,
          created_at: createdAt,
          tags: [["r", TEST_RELAY_URL]],
          content: "",
        }),
        signRuntimeTestEvent(identity, {
          kind: 10050,
          created_at: createdAt,
          tags: [["relay", TEST_RELAY_URL]],
          content: "",
        }),
        signRuntimeTestEvent(identity, {
          kind: 30402,
          created_at: createdAt,
          tags: [
            ["d", "visual-coffee"],
            ["title", title],
            ["summary", "Fictional coffee gift set."],
            ["price", "206353", "SATS"],
            ["type", "simple", "digital"],
            ["stock", "3"],
            ["image", "https://ui-smoke.conduit.market/product.svg"],
          ],
          content: "Fictional coffee gift set.",
        }),
      ])
      await page.route("https://ui-smoke.conduit.market/**", (route) =>
        route.request().url().includes("/.well-known/lnurlp/")
          ? route.fulfill({
              headers: { "access-control-allow-origin": "*" },
              json: {
                tag: "payRequest",
                callback: "https://ui-smoke.conduit.market/invoice",
                minSendable: 1000,
                maxSendable: 100000000,
                allowsNostr: true,
                nostrPubkey: pubkey,
                metadata: '[["text/plain","Synthetic readiness endpoint"]]',
              },
            })
          : route.fulfill({
              contentType: "image/svg+xml",
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="white"/><text x="30" y="100" font-size="32">Sample roastery</text></svg>',
            })
      )
      await installRealTestSigner(page, identity, TEST_RELAY_URL)
      await page.addInitScript(
        ({ key, theme }) => localStorage.setItem(key, theme),
        { key: THEME_STORAGE_KEY, theme }
      )
      // Keep each browser in its actual desktop or phone configuration.
      // Resizing an emulated touch phone into a desktop is not desktop evidence.
      for (const width of [info.project.use.isMobile ? 375 : 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`${merchantUrl}/profile`)
        await expect(
          page.getByText(
            "Fictional coffee and accessories for the shared surface review.",
            { exact: true }
          )
        ).toBeVisible()
        await inspect(page, info, `profile-${theme}-${width}`)
        await page
          .getByRole("button", { name: "Edit profile", exact: true })
          .first()
          .click()
        await expect(page.getByLabel("Display name")).toBeVisible()
        await inspect(page, info, `profile-edit-${theme}-${width}`)
        await page.getByRole("button", { name: "Cancel", exact: true }).click()
        await page.goto(`${merchantUrl}/payments`)
        await expect(
          page.getByText("Zap support detected", { exact: true })
        ).toBeVisible()
        const success = page
          .getByText("Zap support detected", { exact: true })
          .locator("..")
          .locator("svg")
        const color = await success.evaluate((el) => getComputedStyle(el).color)
        expect(color).not.toBe(
          await page.locator("h1").evaluate((el) => getComputedStyle(el).color)
        )
        await inspect(page, info, `payments-ready-${theme}-${width}`)
        await page.goto(`${merchantUrl}/products`)
        await expect(
          page.getByRole("heading", { name: title, exact: true })
        ).toBeVisible()
        await inspect(page, info, `merchant-catalog-${theme}-${width}`)
        await page.getByRole("button", { name: "Edit", exact: true }).click()
        await expect(
          page.getByRole("dialog", { name: "Edit listing", exact: true })
        ).toBeVisible()
        await inspect(page, info, `product-editor-${theme}-${width}`)
        await page.keyboard.press("Escape")
        await page.goto(`${marketUrl}/${nip19.npubEncode(pubkey)}`)
        await expect(
          page.getByRole("heading", { name: title, exact: true })
        ).toBeVisible()
        await inspect(page, info, `storefront-${theme}-${width}`)
        await page.goto(
          `${marketUrl}/products/${encodeURIComponent(coordinate)}`
        )
        await expect(
          page.getByRole("heading", { name: title, exact: true })
        ).toBeVisible()
        await inspect(page, info, `product-detail-${theme}-${width}`)
      }
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}
