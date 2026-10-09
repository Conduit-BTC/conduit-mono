import { expect, test, type Page } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const pubkey = "a".repeat(64)
const apiUrl = "https://api.brainstorm.world/user/trustSignals"
const nip05Url =
  "https://nip05-badge.conduit.market/.well-known/nostr.json?name=merchant"

async function mountBadge(page: Page) {
  await page.goto(`${marketUrl}/products`)
  await page.evaluate(async (key) => {
    const container = document.createElement("div")
    container.id = "brainstorm-badge-harness"
    document.body.replaceChildren(container)
    const harnessUrl = "/src/test-fixtures/brainstorm-badge-harness.tsx"
    const { mountBrainstormBadgeHarness } = await import(harnessUrl)
    mountBrainstormBadgeHarness(container, key)
  }, pubkey)
}

for (const width of [390, 1280]) {
  test(`only positive Brainstorm verification enhances the NIP-05 badge at ${width}px @market`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 720 })
    await page.route(nip05Url, (route) =>
      route.fulfill({ json: { names: { merchant: pubkey } } })
    )
    for (const state of [
      "verified",
      "unknown",
      "flagged",
      "unavailable",
      "mismatched",
    ] as const) {
      await page.route(apiUrl, async (route) => {
        expect(route.request().postDataJSON()).toEqual({ pubkeys: [pubkey] })
        await route.fulfill(
          state === "unavailable"
            ? { status: 503, body: "Unavailable" }
            : {
                json: {
                  code: 200,
                  data: {
                    results: [
                      {
                        pubkey:
                          state === "mismatched" ? "b".repeat(64) : pubkey,
                        verified: state === "verified",
                        flagged: state === "flagged",
                      },
                    ],
                  },
                },
              }
        )
      })
      await mountBadge(page)
      const badge = page.getByTestId("icon-badge").getByRole("img")
      await expect(badge).toHaveAttribute("title", /Verified NIP-05/)
      const shield = badge.locator("svg")
      if (state === "verified") {
        await expect(shield).toHaveClass(/nip05-brainstorm-verified/)
        await expect(badge).toHaveAttribute(
          "title",
          /also verified by Brainstorm's network/
        )
        await expect(badge).toHaveAttribute(
          "aria-label",
          /also verified by Brainstorm's network/
        )
        await expect(
          page.getByTestId("full-badge").locator("span[title]").first()
        ).toHaveAttribute("title", /also verified by Brainstorm's network/)
      } else {
        await expect(shield).not.toHaveClass(/nip05-brainstorm-verified/)
        await expect(badge).toHaveAttribute(
          "title",
          "Verified NIP-05: merchant@nip05-badge.conduit.market"
        )
      }
      await expect(page.locator("body")).not.toContainText(
        /score|unknown|flagged|unavailable|checking/i
      )
      for (const theme of ["night-market", "day-market"]) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute("data-theme", value),
          theme
        )
        await page
          .locator("#brainstorm-badge-harness")
          .screenshot({ path: testInfo.outputPath(`${state}-${theme}.png`) })
      }
      await page.unroute(apiUrl)
    }
  })
}

test("Brainstorm cannot substitute for a failed NIP-05 mapping @market", async ({
  page,
}) => {
  let brainstormRequests = 0
  await page.route(nip05Url, (route) =>
    route.fulfill({ json: { names: { merchant: "b".repeat(64) } } })
  )
  await page.route(apiUrl, async (route) => {
    brainstormRequests += 1
    await route.fulfill({
      json: { code: 200, data: { results: [{ pubkey, verified: true }] } },
    })
  })
  await mountBadge(page)
  const badge = page.getByTestId("icon-badge").getByRole("img")
  await expect(badge).toHaveAttribute(
    "title",
    "NIP-05 verification failed: merchant@nip05-badge.conduit.market"
  )
  await expect(badge.locator("svg")).not.toHaveClass(
    /nip05-brainstorm-verified/
  )
  expect(brainstormRequests).toBe(0)
})

test("pending Brainstorm verification leaves the ordinary badge unchanged @market", async ({
  page,
}) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(nip05Url, (route) =>
    route.fulfill({ json: { names: { merchant: pubkey } } })
  )
  await page.route(apiUrl, async (route) => {
    await pending
    await route.fulfill({
      json: { code: 200, data: { results: [{ pubkey, verified: true }] } },
    })
  })
  await mountBadge(page)
  const badge = page.getByTestId("icon-badge").getByRole("img")
  await expect(badge).toHaveAttribute(
    "title",
    "Verified NIP-05: merchant@nip05-badge.conduit.market"
  )
  await expect(badge.locator("svg")).not.toHaveClass(
    /nip05-brainstorm-verified/
  )
  await expect(page.locator("body")).not.toContainText(
    /Brainstorm|checking|unknown/i
  )
  release()
  await expect(badge.locator("svg")).toHaveClass(/nip05-brainstorm-verified/)
})
