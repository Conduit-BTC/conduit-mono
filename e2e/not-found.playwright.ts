import { expect, test } from "@playwright/test"
import { installTestSigner, TEST_BUYER_PUBKEY } from "./helpers/auth"

for (const app of ["market", "merchant"] as const) {
  const port =
    app === "market"
      ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
      : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
  const url = `http://127.0.0.1:${port}/potato`

  test(`${app} missing page keeps its shell and loops inline @${app}`, async ({
    page,
  }, testInfo) => {
    await page.goto(url)
    await expect(
      page.getByRole("heading", { name: "You have left the network." })
    ).toBeVisible()
    await expect(page.getByRole("banner")).toBeVisible()
    const home = page.getByRole("link", {
      name: app === "market" ? "Go to marketplace" : "Go to dashboard",
    })
    await expect(home).toHaveAttribute("href", "/")
    const video = page.locator(".network-not-found video")
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => element.currentTime)
      )
      .toBeGreaterThan(0)
    expect(
      await video.evaluate(
        (element: HTMLVideoElement) =>
          element.muted && element.loop && element.playsInline
      )
    ).toBe(true)
    await expect(
      page.getByRole("button", { name: /background video/ })
    ).toHaveCount(0)
    await video.evaluate((element: HTMLVideoElement) => {
      element.currentTime = element.duration - 0.2
    })
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => element.currentTime)
      )
      .toBeLessThan(2)
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      )
    ).toBe(true)
    const scene = await page.locator(".network-not-found").boundingBox()
    const header = await page.getByRole("banner").boundingBox()
    const footer = await page.getByRole("contentinfo").boundingBox()
    expect(scene).not.toBeNull()
    expect(scene!.x).toBe(0)
    expect(scene!.width).toBe(header!.width)
    expect(scene!.y).toBeCloseTo(header!.y + header!.height, 0)
    expect(scene!.y + scene!.height).toBeGreaterThanOrEqual(footer!.y - 1)
    if (process.env.NOT_FOUND_EVIDENCE_DIR) {
      await page.screenshot({
        path: `${process.env.NOT_FOUND_EVIDENCE_DIR}/${app}-${testInfo.project.name}.png`,
        fullPage: true,
      })
    }
    await home.click()
    await expect(page).toHaveURL(`http://127.0.0.1:${port}/`)
    await expect(
      page.getByRole("heading", { name: "You have left the network." })
    ).toHaveCount(0)
  })

  test(`${app} reduced motion avoids video downloads and responds to preference changes @${app}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    const videoRequests: string[] = []
    page.on("request", (request) => {
      if (request.url().includes("space-loop"))
        videoRequests.push(request.url())
    })
    await page.goto(url)
    await expect(
      page.getByRole("heading", { name: "You have left the network." })
    ).toBeVisible()
    await expect(page.locator(".network-not-found video")).toHaveCount(0)
    expect(videoRequests).toEqual([])
    await expect
      .poll(() =>
        page
          .locator(".network-not-found img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth)
      )
      .toBeGreaterThan(0)
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await expect(page.locator(".network-not-found video")).toHaveCount(1)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(page.locator(".network-not-found video")).toHaveCount(0)
  })

  test(`${app} failed media keeps the poster and recovery link @${app}`, async ({
    page,
  }) => {
    const failedDownload = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url().includes("space-loop"),
    })
    await page.route("**/*space-loop*", (route) => route.abort())
    await page.goto(url)
    await failedDownload
    await expect(
      page.getByRole("heading", { name: "You have left the network." })
    ).toBeVisible()
    await expect(page.locator(".network-not-found video")).toHaveCount(0)
    await expect
      .poll(() =>
        page
          .locator(".network-not-found img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth)
      )
      .toBeGreaterThan(0)
    await expect(
      page.getByRole("button", { name: /background video/ })
    ).toHaveCount(0)
  })
}

test("merchant signed-in missing page keeps workspace navigation @merchant", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await page.goto(
    `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}/potato`
  )
  await expect(
    page.getByRole("heading", { name: "You have left the network." })
  ).toBeVisible()
  const main = page.locator("[data-merchant-main-scroll]")
  await expect(main).toBeVisible()
  const scene = await page.locator(".network-not-found").boundingBox()
  const workspace = await main.boundingBox()
  expect(scene!.x).toBe(workspace!.x)
  expect(scene!.width).toBe(workspace!.width)
  expect(scene!.y + scene!.height).toBeGreaterThanOrEqual(
    page.viewportSize()!.height - 1
  )
  if (process.env.NOT_FOUND_EVIDENCE_DIR) {
    await page.screenshot({
      path: `${process.env.NOT_FOUND_EVIDENCE_DIR}/merchant-workspace-${page.viewportSize()!.width}.png`,
      fullPage: true,
    })
  }
  await expect(
    page.getByRole("heading", { name: "Sign in to Conduit" })
  ).toHaveCount(0)
})
