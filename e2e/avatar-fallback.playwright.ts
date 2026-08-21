import { expect, test } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const avatarHarnessUrl = "/src/test-fixtures/avatar-fallback-harness.tsx"

test("market conversation avatar falls back after a public image load fails @market", async ({
  page,
}) => {
  const failedAvatarUrl =
    "https://cdn.conduit.market/conduit-test/failed-avatar.png"
  let requestCount = 0
  await page.route(failedAvatarUrl, async (route) => {
    await route.abort("failed")
    requestCount += 1
  })
  await page.goto(`${marketUrl}/products`)

  await page.evaluate(
    async ({ harnessUrl, src }) => {
      const container = document.createElement("div")
      container.id = "avatar-fallback-harness"
      document.body.append(container)
      const { mountAvatarFallbackHarness } = (await import(harnessUrl)) as {
        mountAvatarFallbackHarness: (
          element: HTMLElement,
          imageSrc: string
        ) => void
      }
      mountAvatarFallbackHarness(container, src)
    },
    { harnessUrl: avatarHarnessUrl, src: failedAvatarUrl }
  )

  await expect.poll(() => requestCount).toBe(1)
  await expect(page.getByTestId("avatar-loading-status")).toHaveText("error")
  const frame = page.getByTestId("avatar-fallback-frame")
  await expect(
    frame.locator('img[src="/images/logo/logo-icon.svg"]')
  ).toBeVisible()
  await expect(frame.getByAltText("Broken avatar")).toHaveCount(0)
})
