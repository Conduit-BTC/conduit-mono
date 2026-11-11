import { test, expect } from "@playwright/test"
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url())
    return u.origin === "http://127.0.0.1:4318"
      ? route.continue()
      : route.abort("blockedbyclient")
  })
  await context.routeWebSocket(/.*/, (socket) => socket.close())
})
test("submitted payout stays uncertain after absent provider history without a second send", async ({
  page,
}) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Inspect uncertain payout" }).click()
  await expect(page.locator("#result")).toHaveText(
    JSON.stringify({
      reason: "prior_possible_send",
      sends: 1,
      status: "submitted",
    })
  )
})

test("account change during a pending read revokes the real buyer runner", async ({
  page,
}) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Test account-change fence" }).click()
  await expect(page.locator("#result")).toHaveText(
    JSON.stringify({ status: "paused", reason: "paused", reads: 1 })
  )
})

for (const action of ["pause", "cancel", "visibility"] as const) {
  test(`${action} revokes an activation while its read drains`, async ({
    page,
  }) => {
    await page.goto("/")
    await page
      .getByRole("button", { name: "Start guarded read", exact: true })
      .click()
    await expect(page.locator("#result")).toHaveText("read pending")
    if (action === "visibility") {
      // Simulated visibility at the DOM seam; this does not attest OS tab switching.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        })
        document.dispatchEvent(new Event("visibilitychange"))
      })
    } else {
      await page.locator(`#${action}`).click()
    }
    await page.locator("#release").click()
    await expect(page.locator("#result")).toHaveText(
      JSON.stringify({ status: "paused", reason: "paused", reads: 1 })
    )
  })
}
test("a concurrent activation cannot acquire the same runner", async ({
  page,
}) => {
  await page.goto("/")
  await page.locator("#start").click()
  await expect(page.locator("#result")).toHaveText("read pending")
  await page.locator("#duplicate").click()
  await expect(page.locator("#result")).toHaveText(
    JSON.stringify({ status: "paused", reason: "busy", reads: 1 })
  )
  await page.locator("#pause").click()
  await page.locator("#release").click()
  await expect(page.locator("#result")).toHaveText(
    JSON.stringify({ status: "paused", reason: "paused", reads: 1 })
  )
})

test("isolated synthetic NIP-07 signer produces a verifiable event", async ({
  page,
}) => {
  await page.goto("/")
  await page
    .getByRole("button", { name: "Verify synthetic extension signer" })
    .click()
  await expect(page.locator("#result")).toHaveText(
    JSON.stringify({ valid: true, identityMatches: true })
  )
})
test("external HTTP and WebSocket access are denied", async ({ page }) => {
  await page.goto("/")
  const denied = await page.evaluate(async () => {
    const http = await fetch("https://shop.conduit.market/").then(
      () => false,
      () => true
    )
    const websocket = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket("wss://relay.damus.io")
      socket.onopen = () => {
        socket.close()
        resolve(false)
      }
      socket.onerror = () => resolve(true)
      socket.onclose = () => resolve(true)
    })
    return { http, websocket }
  })
  expect(denied).toEqual({ http: true, websocket: true })
})

test("actual serial-worker ownership differs from a synthetic selection marker and pause prevents the next order", async ({
  page,
}) => {
  await page.goto("/")
  await page
    .getByRole("button", { name: "Inspect serial worker ownership" })
    .click()
  await expect(page.locator("#result")).toHaveText(
    JSON.stringify({
      selectionMarker: "second",
      actualWorker: "first",
      starts: 1,
    })
  )
})
