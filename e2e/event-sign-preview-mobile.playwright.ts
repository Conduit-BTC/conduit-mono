import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const merchantUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
}`

const fixturePath = fileURLToPath(
  new URL("./fixtures/event-sign-preview.tsx", import.meta.url)
)

test.use({ viewport: { width: 320, height: 568 } })

test("printable event sign scales and excludes controls at 320px @merchant", async ({
  page,
}) => {
  const browserErrors: string[] = []
  page.on("pageerror", (error) => browserErrors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text())
  })
  await page.goto(`${merchantUrl}/about`)
  await page.evaluate(() => {
    const root = document.createElement("div")
    root.id = "event-sign-mobile-test-root"
    document.body.replaceChildren(root)
  })
  await page.addScriptTag({
    type: "module",
    content: `import ${JSON.stringify(encodeURI(`/@fs${fixturePath}`))};`,
  })

  const preview = page.getByTestId("event-sign-print-preview")
  const stage = preview.getByTestId("event-sign-sheet-stage")
  const printableSheet = preview.getByTestId("event-sign-sheet")
  const closeButton = preview.getByRole("button", { name: "Close" })
  await expect
    .poll(async () => ({
      browserErrors,
      previewCount: await preview.count(),
    }))
    .toEqual({ browserErrors: [], previewCount: 1 })
  await expect(preview).toBeVisible()
  await expect(closeButton).toBeVisible()
  await expect(
    printableSheet.getByText("https://conduit.market", { exact: true })
  ).toBeVisible()

  await expect
    .poll(async () => {
      const [stageBounds, sheetBounds] = await Promise.all([
        stage.boundingBox(),
        printableSheet.boundingBox(),
      ])
      if (!stageBounds || !sheetBounds) return Number.POSITIVE_INFINITY
      return Math.abs(stageBounds.width - sheetBounds.width)
    })
    .toBeLessThan(1)

  const screenLayout = await preview.evaluate((element) => {
    const stageElement = element.querySelector<HTMLElement>(
      ".event-sign-sheet-stage"
    )
    const sheetElement = element.querySelector<HTMLElement>(".event-sign-sheet")
    const bannerElement =
      element.querySelector<HTMLElement>(".event-sign-banner")
    const qrElement = element.querySelector<HTMLElement>(".event-sign-qr-frame")
    const scanCopyElement = element.querySelector<HTMLElement>(
      ".event-sign-scan-copy"
    )
    if (
      !stageElement ||
      !sheetElement ||
      !bannerElement ||
      !qrElement ||
      !scanCopyElement
    ) {
      throw new Error("Mobile printable sign preview is incomplete.")
    }
    const previewBounds = element.getBoundingClientRect()
    const stageBounds = stageElement.getBoundingClientRect()
    const sheetBounds = sheetElement.getBoundingClientRect()
    const bannerBounds = bannerElement.getBoundingClientRect()
    const qrBounds = qrElement.getBoundingClientRect()
    const scanCopyBounds = scanCopyElement.getBoundingClientRect()
    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      previewWidth: previewBounds.width,
      stageWidth: stageBounds.width,
      stageHeight: stageBounds.height,
      sheetWidth: sheetBounds.width,
      sheetHeight: sheetBounds.height,
      sheetBottom: sheetBounds.bottom,
      bannerWidth: bannerBounds.width,
      bannerHeight: bannerBounds.height,
      bannerObjectFit: getComputedStyle(bannerElement).objectFit,
      qrWidth: qrBounds.width,
      qrHeight: qrBounds.height,
      scanCopyBottom: scanCopyBounds.bottom,
    }
  })
  expect(screenLayout.documentScrollWidth).toBeLessThanOrEqual(
    screenLayout.documentClientWidth + 1
  )
  expect(screenLayout.stageWidth).toBeLessThanOrEqual(screenLayout.previewWidth)
  expect(screenLayout.sheetWidth).toBeCloseTo(screenLayout.stageWidth, 1)
  expect(screenLayout.sheetHeight).toBeCloseTo(screenLayout.stageHeight, 1)
  expect(screenLayout.bannerWidth).toBeCloseTo(screenLayout.sheetWidth, 1)
  expect(screenLayout.bannerWidth / screenLayout.bannerHeight).toBeCloseTo(3, 1)
  expect(screenLayout.bannerObjectFit).toBe("cover")
  expect(screenLayout.qrWidth).toBeCloseTo(screenLayout.qrHeight, 1)
  expect(screenLayout.scanCopyBottom).toBeLessThanOrEqual(
    screenLayout.sheetBottom + 1
  )

  const closeBounds = await closeButton.boundingBox()
  expect(closeBounds?.width).toBeGreaterThanOrEqual(44)
  expect(closeBounds?.height).toBeGreaterThanOrEqual(44)

  await page.emulateMedia({ media: "print" })
  await expect(closeButton).toBeHidden()
  const printLayout = await preview.evaluate((element) => {
    const sheetElement = element.querySelector<HTMLElement>(".event-sign-sheet")
    const bannerElement =
      element.querySelector<HTMLElement>(".event-sign-banner")
    if (!sheetElement || !bannerElement) {
      throw new Error("Printable sign sheet is incomplete.")
    }
    const sheetBounds = sheetElement.getBoundingClientRect()
    const bannerBounds = bannerElement.getBoundingClientRect()
    return {
      sheetWidth: sheetBounds.width,
      sheetHeight: sheetBounds.height,
      sheetTransform: getComputedStyle(sheetElement).transform,
      bannerWidth: bannerBounds.width,
      bannerHeight: bannerBounds.height,
    }
  })
  expect(printLayout).toEqual({
    sheetWidth: 816,
    sheetHeight: 1_056,
    sheetTransform: "none",
    bannerWidth: 816,
    bannerHeight: 272,
  })

  await page.emulateMedia({ media: "screen" })
  await closeButton.click()
  await expect(preview).toBeHidden()
})
