import { expect, test, type Page } from "@playwright/test"
import {
  installLockedTestSigner,
  installTestSigner,
  seedStoredAuth,
  TEST_BUYER_PUBKEY,
  TEST_LOCKED_SIGNER_PUBKEY,
  unlockTestSigner,
} from "./helpers/auth"

async function expectBackgroundPlaying(page: Page) {
  const video = page.locator(".network-not-found video")
  await expect(video).toHaveCount(1)
  // A mounted element is not yet playback. Exercise preference changes from
  // the playing state; pending-download cancellation has separate coverage.
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime)
    )
    .toBeGreaterThan(0)
}

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
    await expectBackgroundPlaying(page)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(page.locator(".network-not-found video")).toHaveCount(0)
  })

  test(`${app} reduced motion cancels a pending video download and can resume @${app}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    let releaseDownload!: () => void
    const held = new Promise<void>((resolve) => {
      releaseDownload = resolve
    })
    const videoStarted = page.waitForRequest((request) =>
      request.url().includes("space-loop")
    )
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = (resource, options) => {
        if (String(resource).includes("space-loop")) {
          options?.signal?.addEventListener(
            "abort",
            () => {
              document.documentElement.dataset.videoDownloadAborted = "true"
            },
            { once: true }
          )
        }
        return originalFetch(resource, options)
      }
    })
    await page.route("**/*space-loop*", async (route) => {
      await held
      await route.continue()
    })
    try {
      await page.goto(url)
      await expect(
        page.getByRole("heading", {
          name: "You have left the network.",
        })
      ).toBeVisible()
      await page.emulateMedia({ reducedMotion: "no-preference" })
      await videoStarted
      await page.emulateMedia({ reducedMotion: "reduce" })
      await expect(page.locator("html")).toHaveAttribute(
        "data-video-download-aborted",
        "true"
      )
      releaseDownload()
      await expect(page.locator(".network-not-found video")).toHaveCount(0)
    } finally {
      releaseDownload()
      await page.unrouteAll({ behavior: "wait" })
    }
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await expectBackgroundPlaying(page)
  })

  test(`${app} data saver avoids downloads and responds to preference changes @${app}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const connection = Object.assign(new EventTarget(), { saveData: true })
      Object.defineProperty(navigator, "connection", { value: connection })
      window.addEventListener("test:toggle-data-saver", () => {
        connection.saveData = !connection.saveData
        connection.dispatchEvent(new Event("change"))
      })
    })
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
    await page.evaluate(() =>
      window.dispatchEvent(new Event("test:toggle-data-saver"))
    )
    await expectBackgroundPlaying(page)
    await page.evaluate(() =>
      window.dispatchEvent(new Event("test:toggle-data-saver"))
    )
    await expect(page.locator(".network-not-found video")).toHaveCount(0)
    await page.evaluate(() =>
      window.dispatchEvent(new Event("test:toggle-data-saver"))
    )
    await expectBackgroundPlaying(page)
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

test("merchant missing page waits for signer restoration before loading media @merchant", async ({
  page,
}) => {
  await installLockedTestSigner(page)
  await seedStoredAuth(page, TEST_LOCKED_SIGNER_PUBKEY)
  const videoRequests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("space-loop")) videoRequests.push(request.url())
  })
  await page.goto(
    `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}/potato`
  )
  await expect(
    page.getByText("Restoring signer", { exact: true })
  ).toBeVisible()
  await expect(page.locator(".network-not-found")).toHaveCount(0)
  expect(videoRequests).toEqual([])
  await unlockTestSigner(page, TEST_LOCKED_SIGNER_PUBKEY)
  await expect(page.locator("[data-merchant-main-scroll]")).toBeVisible()
  await expect(page.getByLabel("Open merchant account menu")).toBeVisible()
  const video = page.locator(".network-not-found video")
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime)
    )
    .toBeGreaterThan(0)
})
