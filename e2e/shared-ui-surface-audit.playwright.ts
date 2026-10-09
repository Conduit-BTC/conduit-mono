import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
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
    "/payments",
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
        for (const route of routes[area]) {
          await page.goto(
            `${area === "market" ? marketUrl : merchantUrl}${route}`
          )
          await page.locator("#root").waitFor({ state: "visible" })
          await page.evaluate(() => document.fonts.ready)
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
          if (directory)
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
        await info.attach("surface-audit", {
          body: JSON.stringify(evidence, null, 2),
          contentType: "application/json",
        })
      } finally {
        disposeRuntimeSignerIdentity(identity)
      }
    })
  }
}
