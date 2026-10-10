import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test, type Request } from "@playwright/test"
import { THEME_STORAGE_KEY } from "@conduit/ui/theme"
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"
import { recordSmokeDiagnostic } from "./helpers/smoke-diagnostics"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"

test.use({ trace: "off", screenshot: "off", video: "off" })

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
// Direct route shells and their visible empty/degraded/readiness states. Populated
// commerce/event/wallet flows remain covered by their existing behavior suites.
const routes = {
  market: [
    "/",
    "/products",
    "/merchants",
    "/sellers",
    "/zapouts",
    "/events",
    "/cart",
    "/checkout",
    "/orders",
    "/messages",
    "/profile",
    "/preferences",
    "/wallet",
    "/network",
    "/about",
    "/terms-of-service",
    "/privacy-policy",
  ],
  merchant: [
    "/",
    "/products",
    "/events",
    "/events/new",
    "/orders",
    "/messages",
    "/profile",
    "/wallet",
    "/shipping",
    "/network",
    "/about",
    "/terms-of-service",
    "/privacy-policy",
  ],
}
for (const area of ["market", "merchant"] as const) {
  for (const theme of ["day-market", "night-market"]) {
    test(`${area} surface audit in ${theme} @${area}`, async ({
      page,
    }, info) => {
      test.setTimeout(120000)
      let phase = "setup"
      let routeIndex = -1
      let navigationError = "none"
      const pending = new Set<Request>()
      const record = () =>
        recordSmokeDiagnostic(info, "surface-audit", {
          phase,
          routeIndex,
          navigationError,
          pendingDocuments: [...pending].filter(
            (r) => r.resourceType() === "document"
          ).length,
          pendingImages: [...pending].filter(
            (r) => r.resourceType() === "image"
          ).length,
          pendingFonts: [...pending].filter((r) => r.resourceType() === "font")
            .length,
          pendingScripts: [...pending].filter(
            (r) => r.resourceType() === "script"
          ).length,
        })
      const mark = (value: string) => {
        phase = value
        record()
      }
      page.on("request", (request) => {
        pending.add(request)
        record()
      })
      const finish = (request: Request) => {
        pending.delete(request)
        record()
      }
      page.on("requestfinished", finish)
      page.on("requestfailed", finish)
      record()
      // A nonessential image must not become the readiness gate for route UI.
      let releaseImage!: () => void
      let imageRequested = false
      const heldImage = new Promise<void>((resolve) => {
        releaseImage = resolve
      })
      await page.route("**/__surface_readiness_probe.svg", async (route) => {
        imageRequested = true
        await heldImage
        await route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        })
      })
      await page.addInitScript(() => {
        if (location.pathname !== "/") return
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            const image = document.createElement("img")
            image.src = "/__surface_readiness_probe.svg"
            image.style.display = "none"
            document.body.append(image)
          },
          { once: true }
        )
      })
      const identity = createRuntimeSignerIdentity()
      try {
        const createdAt = Math.floor(Date.now() / 1000)
        await publishTestRelayEvents(
          [0, 10002, 10050].map((kind) =>
            signRuntimeTestEvent(identity, {
              kind,
              created_at: createdAt,
              tags:
                kind === 10002
                  ? [["r", TEST_RELAY_URL]]
                  : kind === 10050
                    ? [["relay", TEST_RELAY_URL]]
                    : [],
              content: kind === 0 ? "{}" : "",
            })
          )
        )
        await installRealTestSigner(page, identity, TEST_RELAY_URL)
        await page.addInitScript(
          ({ key, theme }) => localStorage.setItem(key, theme),
          { key: THEME_STORAGE_KEY, theme }
        )
        const directory = process.env.PLAYWRIGHT_UI_SURFACE_SCREENSHOT_DIR
        if (directory) await mkdir(directory, { recursive: true })
        const evidence = []
        for (const [index, route] of routes[area].entries()) {
          routeIndex = index
          mark("navigate")
          try {
            await page.goto(
              `${area === "market" ? marketUrl : merchantUrl}${route}`,
              { waitUntil: "domcontentloaded" }
            )
          } catch (error) {
            const message = error instanceof Error ? error.message : ""
            navigationError = /interrupted/i.test(message)
              ? "interrupted"
              : /aborted|cancelled|canceled|NSURLErrorCancelled|ERR_ABORTED/i.test(
                    message
                  )
                ? "aborted"
                : /timeout/i.test(message)
                  ? "timeout"
                  : "other"
            record()
            throw error
          }
          mark("render")
          if (route === "/wallet") {
            await expect(page).toHaveURL(
              `${area === "market" ? marketUrl : merchantUrl}/wallet`
            )
            await expect(
              page.getByRole("button", { name: "Create wallet", exact: true })
            ).toBeVisible()
          }
          await page.locator("#root").waitFor({ state: "visible" })
          mark("fonts")
          // WebKit can hold FontFaceSet.ready behind unrelated images. Await
          // actual font loads so typography remains required independently.
          const fontCount = await page.evaluate(async () => {
            const fonts = Array.from(document.fonts)
            await Promise.all(fonts.map((font) => font.load()))
            return fonts.length
          })
          expect(
            fontCount,
            "bundled font faces are registered"
          ).toBeGreaterThan(0)
          mark("render")
          await expect(
            page.getByText("Something went wrong", { exact: true })
          ).not.toBeVisible()
          await expect(
            page
              .getByRole("heading")
              .first()
              .or(
                page.getByRole("navigation", {
                  name: "Market browse",
                  exact: true,
                })
              )
              .first()
          ).toBeVisible()
          await expect(
            page.getByRole("heading", {
              name: "Sign in to Conduit",
              exact: true,
            }),
            route
          ).not.toBeVisible()
          const headings = await page.getByRole("heading").allTextContents()
          const browseNavigation = await page
            .getByRole("navigation", { name: "Market browse", exact: true })
            .count()
          expect(
            headings.length + browseNavigation,
            `${route} has a rendered page heading or catalog navigation`
          ).toBeGreaterThan(0)
          if (index === 0) {
            await expect.poll(() => imageRequested).toBe(true)
            releaseImage()
          }
          mark("measure")
          const metrics = await page.evaluate(() => {
            const visible = Array.from(
              document.querySelectorAll("main *,[role=dialog] *")
            ).filter((el) => {
              const r = el.getBoundingClientRect()
              const s = getComputedStyle(el)
              return r.width > 0 && r.height > 0 && s.visibility !== "hidden"
            })
            return {
              width: document.documentElement.clientWidth,
              content: document.documentElement.scrollWidth,
              overflow: visible
                .filter(
                  (el) =>
                    el.getBoundingClientRect().right >
                    document.documentElement.clientWidth + 1
                )
                .slice(-10)
                .map((el) => ({
                  tag: el.tagName,
                  classes: el.getAttribute("class"),
                  width: el.getBoundingClientRect().width,
                })),
              decorativeGradients: visible.filter(
                (el) =>
                  getComputedStyle(el).backgroundImage.includes("gradient") &&
                  !el.closest("[data-tip-celebration]")
              ).length,
              oversizedBoxes: visible.filter((el) => {
                const s = getComputedStyle(el)
                const r = el.getBoundingClientRect()
                return (
                  r.width > 100 &&
                  r.height > 50 &&
                  ["DIV", "SECTION", "ARTICLE", "ASIDE"].includes(el.tagName) &&
                  parseFloat(s.borderTopLeftRadius) >
                    (el.closest("[role=dialog]") ? 12 : 8) &&
                  parseFloat(s.borderTopLeftRadius) <
                    Math.min(r.width, r.height) / 2
                )
              }).length,
            }
          })
          expect
            .soft(
              metrics.content,
              `${route} document containment: ${JSON.stringify(metrics.overflow)}`
            )
            .toBeLessThanOrEqual(metrics.width + 1)
          expect
            .soft(
              metrics.decorativeGradients,
              `${route} decorative gradient backgrounds`
            )
            .toBe(0)
          expect
            .soft(metrics.oversizedBoxes, `${route} arbitrary panel geometry`)
            .toBe(0)
          evidence.push({ route, headings, metrics })
          if (directory) {
            mark("capture")
            await page.screenshot({
              path: join(
                directory,
                `${area}-${info.project.name}-${theme}-${route.replace(/\W+/g, "-") || "home"}.png`
              ),
              fullPage: true,
              mask: [
                page.locator("input,textarea,.font-mono"),
                page.getByRole("button", { name: /Open.*account menu/ }),
              ],
            })
          }
        }
        mark("complete")
        await info.attach("surface-audit", {
          body: JSON.stringify(evidence, null, 2),
          contentType: "application/json",
        })
      } finally {
        releaseImage()
        disposeRuntimeSignerIdentity(identity)
      }
    })
  }
}

test("Merchant legacy Payments opens Wallets before the next route navigation @merchant", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  try {
    await installRealTestSigner(page, identity, TEST_RELAY_URL)
    await page.goto(`${merchantUrl}/payments`, {
      waitUntil: "domcontentloaded",
    })
    await expect(page).toHaveURL(`${merchantUrl}/wallet`)
    await expect(
      page.getByRole("button", { name: "Create wallet", exact: true })
    ).toBeVisible()
    await expect(page).toHaveTitle(/Wallets/)
    await page.goto(`${merchantUrl}/shipping`, {
      waitUntil: "domcontentloaded",
    })
    await expect(page).toHaveURL(`${merchantUrl}/shipping`)
    await expect(page.getByRole("heading").first()).toBeVisible()
    await expect(
      page.getByText("Something went wrong", { exact: true })
    ).not.toBeVisible()
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})
