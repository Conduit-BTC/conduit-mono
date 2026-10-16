import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test"
import { nip19 } from "nostr-tools"
import { THEME_STORAGE_KEY } from "@conduit/ui/theme"
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"

import { measureTextContrast } from "./helpers/rendered-contrast"
import { createDeterministicNwcWallet } from "./helpers/deterministic-nwc-wallet"
import {
  recordSmokeDiagnostic,
  type PopulatedAuditPhase,
} from "./helpers/smoke-diagnostics"

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
      page.locator(
        "input,textarea,.font-mono,.tabular-nums,[data-wallet-address]"
      ),
      page.getByRole("button", { name: /Open.*account menu/ }),
    ],
  })
}

async function expectReadable(locator: Locator, info: TestInfo, label: string) {
  await expect(locator).toBeVisible()
  const samples = await measureTextContrast(locator)
  expect(samples).toHaveLength(1)
  await info.attach(label, {
    body: JSON.stringify(samples),
    contentType: "application/json",
  })
  expect(samples[0].ratio, label).toBeGreaterThanOrEqual(4.5)
}

for (const theme of ["day-market", "night-market"]) {
  test(`populated profile, payment readiness, catalog and editor surfaces in ${theme} @merchant`, async ({
    page,
  }, info) => {
    const startedAt = Date.now()
    let phase: PopulatedAuditPhase = "setup"
    let pageCrashed = false
    const record = () =>
      recordSmokeDiagnostic(info, "populated-audit", {
        phase,
        elapsedSeconds: (Date.now() - startedAt) / 1000,
        pageCrashed,
      })
    const mark = (value: PopulatedAuditPhase) => {
      phase = value
      record()
    }
    page.on("crash", () => {
      pageCrashed = true
      record()
    })
    record()
    const identity = createRuntimeSignerIdentity()
    const { pubkey } = identity
    const wallet = createDeterministicNwcWallet({ relayUrl: TEST_RELAY_URL })
    try {
      mark("start_wallet")
      await wallet.start()
      const title =
        "Colombia coffee gift set with an exceptionally long catalog name"
      const createdAt = Math.floor(Date.now() / 1000)
      const coordinate = `30402:${pubkey}:visual-coffee`
      mark("seed_profiles")
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
      mark("install_signer")
      await installRealTestSigner(page, identity, TEST_RELAY_URL)
      await page.addInitScript(
        ({ key, theme }) => localStorage.setItem(key, theme),
        { key: THEME_STORAGE_KEY, theme }
      )
      // Keep each browser in its actual desktop or phone configuration.
      // Resizing an emulated touch phone into a desktop is not desktop evidence.
      for (const width of [info.project.use.isMobile ? 375 : 1280]) {
        await page.setViewportSize({ width, height: 900 })
        mark("profile_navigate")
        await page.goto(`${merchantUrl}/profile`)
        mark("profile_ready")
        await expect(
          page.getByText(
            "Fictional coffee and accessories for the shared surface review.",
            { exact: true }
          )
        ).toBeVisible()
        await expectReadable(
          page.getByText("IDENTITY", { exact: true }),
          info,
          "profile-identity-contrast"
        )
        await inspect(page, info, `profile-${theme}-${width}`)
        mark("profile_edit")
        await page
          .getByRole("button", { name: "Edit profile", exact: true })
          .first()
          .click()
        await expect(page.getByLabel("Display name")).toBeVisible()
        await inspect(page, info, `profile-edit-${theme}-${width}`)
        await page.getByRole("button", { name: "Cancel", exact: true }).click()
        mark("payments_navigate")
        await page.goto(`${merchantUrl}/payments`)
        await expect(page).toHaveURL(`${merchantUrl}/wallet`)
        mark("wallet_configure")
        await wallet.configureMerchantConnection(async (uri) => {
          await page.evaluate(
            ({ pubkey, uri }) =>
              localStorage.setItem(`conduit:merchant:nwc_uri:${pubkey}`, uri),
            { pubkey, uri }
          )
        })
        mark("wallet_reload")
        await page.reload()
        mark("wallet_ready")
        await expect(page.locator('[data-wallet-state="ready"]')).toBeVisible()
        mark("wallet_contrast")
        await expectReadable(
          page.getByRole("heading", { name: "Wallets", level: 1, exact: true }),
          info,
          "wallets-heading-contrast"
        )
        await expectReadable(
          page.locator('article[data-wallet-state="ready"] h3'),
          info,
          "wallet-name-contrast"
        )
        await inspect(page, info, `wallets-ready-${theme}-${width}`)
        mark("network_navigate")
        await page.goto(`${merchantUrl}/network`)
        mark("network_ready")
        await expectReadable(
          page.getByRole("button", { name: /^Disable Read for / }).first(),
          info,
          "enabled-relay-role-contrast"
        )
        mark("catalog_navigate")
        await page.goto(`${merchantUrl}/products`)
        mark("catalog_ready")
        await expect(
          page.getByRole("heading", { name: title, exact: true })
        ).toBeVisible()
        await inspect(page, info, `merchant-catalog-${theme}-${width}`)
        mark("editor_open")
        await page.getByRole("button", { name: "Edit", exact: true }).click()
        mark("editor_ready")
        await expect(
          page.getByRole("dialog", { name: "Edit listing", exact: true })
        ).toBeVisible()
        await inspect(page, info, `product-editor-${theme}-${width}`)
        await page.keyboard.press("Escape")
        mark("storefront_navigate")
        await page.goto(`${marketUrl}/${nip19.npubEncode(pubkey)}`)
        mark("storefront_ready")
        await expect(
          page.getByRole("heading", { name: title, exact: true })
        ).toBeVisible()
        await inspect(page, info, `storefront-${theme}-${width}`)
        mark("product_navigate")
        await page.goto(
          `${marketUrl}/products/${encodeURIComponent(coordinate)}`
        )
        mark("product_ready")
        await expect(
          page.getByRole("heading", { name: title, exact: true })
        ).toBeVisible()
        await inspect(page, info, `product-detail-${theme}-${width}`)
        mark("legal_navigate")
        await page.goto(`${marketUrl}/terms-of-service`)
        mark("legal_contrast")
        const legalLink = page.getByRole("link", {
          name: "Conduit Product Privacy Policy",
          exact: true,
        })
        await expectReadable(legalLink, info, "legal-link-contrast")
        await legalLink.hover()
        await expectReadable(legalLink, info, "legal-link-hover-contrast")
      }
      mark("complete")
    } finally {
      record()
      await wallet.close()
      disposeRuntimeSignerIdentity(identity)
    }
  })
}
