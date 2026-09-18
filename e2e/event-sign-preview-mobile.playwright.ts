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
  await expect(
    printableSheet.getByText("Shop this merchant", { exact: true })
  ).toHaveCount(0)
  await expect(
    printableSheet.getByText("At the event", { exact: true })
  ).toHaveCount(0)
  await expect(
    printableSheet.getByText("Listings and event participation can change.", {
      exact: true,
    })
  ).toHaveCount(0)

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
    const eventBannerElement = element.querySelector<HTMLElement>(
      ".event-sign-event-banner-mini"
    )
    const merchantBannerElement = element.querySelector<HTMLElement>(
      ".event-sign-merchant-banner"
    )
    const qrElement = element.querySelector<HTMLElement>(".event-sign-qr-frame")
    const scanCopyElement = element.querySelector<HTMLElement>(
      ".event-sign-scan-copy"
    )
    if (
      !stageElement ||
      !sheetElement ||
      !eventBannerElement ||
      !merchantBannerElement ||
      !qrElement ||
      !scanCopyElement
    ) {
      throw new Error("Mobile printable sign preview is incomplete.")
    }
    const previewBounds = element.getBoundingClientRect()
    const stageBounds = stageElement.getBoundingClientRect()
    const sheetBounds = sheetElement.getBoundingClientRect()
    const eventBannerBounds = eventBannerElement.getBoundingClientRect()
    const merchantBannerBounds = merchantBannerElement.getBoundingClientRect()
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
      eventBannerWidth: eventBannerBounds.width,
      eventBannerHeight: eventBannerBounds.height,
      eventBannerObjectFit: getComputedStyle(eventBannerElement).objectFit,
      merchantBannerWidth: merchantBannerBounds.width,
      merchantBannerHeight: merchantBannerBounds.height,
      merchantBannerObjectFit: getComputedStyle(merchantBannerElement)
        .objectFit,
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
  expect(
    screenLayout.eventBannerWidth / screenLayout.eventBannerHeight
  ).toBeCloseTo(3, 1)
  expect(screenLayout.eventBannerObjectFit).toBe("cover")
  expect(
    screenLayout.merchantBannerWidth / screenLayout.merchantBannerHeight
  ).toBeCloseTo(3, 1)
  expect(screenLayout.merchantBannerObjectFit).toBe("cover")
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
    const eventContextElement = element.querySelector<HTMLElement>(
      ".event-sign-event-context"
    )
    const eventBannerElement = element.querySelector<HTMLElement>(
      ".event-sign-event-banner-mini"
    )
    const dividerElement = element.querySelector<HTMLElement>(
      ".event-sign-section-divider"
    )
    const merchantLockupElement = element.querySelector<HTMLElement>(
      ".event-sign-merchant-lockup"
    )
    const merchantBannerElement = element.querySelector<HTMLElement>(
      ".event-sign-merchant-banner"
    )
    const avatarElement =
      element.querySelector<HTMLElement>(".event-sign-avatar")
    const merchantNameElement = element.querySelector<HTMLElement>(
      ".event-sign-merchant-name"
    )
    const qrElement = element.querySelector<HTMLElement>(".event-sign-qr-frame")
    if (!sheetElement || !eventContextElement || !eventBannerElement) {
      throw new Error("Printable sign sheet is incomplete.")
    }
    if (
      !dividerElement ||
      !merchantLockupElement ||
      !merchantBannerElement ||
      !avatarElement ||
      !merchantNameElement ||
      !qrElement
    ) {
      throw new Error("Printable merchant identity is incomplete.")
    }
    const sheetBounds = sheetElement.getBoundingClientRect()
    const eventContextBounds = eventContextElement.getBoundingClientRect()
    const eventBannerBounds = eventBannerElement.getBoundingClientRect()
    const dividerBounds = dividerElement.getBoundingClientRect()
    const merchantLockupBounds = merchantLockupElement.getBoundingClientRect()
    const merchantBannerBounds = merchantBannerElement.getBoundingClientRect()
    const avatarBounds = avatarElement.getBoundingClientRect()
    const qrBounds = qrElement.getBoundingClientRect()
    return {
      sheetWidth: sheetBounds.width,
      sheetHeight: sheetBounds.height,
      sheetTransform: getComputedStyle(sheetElement).transform,
      eventBannerWidth: eventBannerBounds.width,
      eventBannerHeight: eventBannerBounds.height,
      dividerWidth: dividerBounds.width,
      dividerHeight: dividerBounds.height,
      eventContextToDividerGap: dividerBounds.top - eventContextBounds.bottom,
      dividerToMerchantGap: merchantLockupBounds.top - dividerBounds.bottom,
      merchantLockupWidth: merchantLockupBounds.width,
      merchantLockupHeight: merchantLockupBounds.height,
      merchantBannerWidth: merchantBannerBounds.width,
      merchantBannerHeight: merchantBannerBounds.height,
      avatarWidth: avatarBounds.width,
      merchantNameFontSize: Number.parseFloat(
        getComputedStyle(merchantNameElement).fontSize
      ),
      merchantToQrGap: qrBounds.top - merchantLockupBounds.bottom,
    }
  })
  expect(printLayout.sheetWidth).toBe(816)
  expect(printLayout.sheetHeight).toBe(1_056)
  expect(printLayout.sheetTransform).toBe("none")
  expect(printLayout.eventBannerWidth).toBe(176)
  expect(printLayout.eventBannerHeight).toBeCloseTo(176 / 3, 1)
  expect(printLayout.dividerWidth).toBe(672)
  expect(printLayout.dividerHeight).toBe(2)
  expect(printLayout.eventContextToDividerGap).toBe(24)
  expect(printLayout.dividerToMerchantGap).toBe(20)
  expect(printLayout.merchantLockupWidth).toBe(672)
  expect(printLayout.merchantLockupHeight).toBe(336)
  expect(printLayout.merchantBannerWidth).toBe(672)
  expect(printLayout.merchantBannerHeight).toBe(224)
  expect(printLayout.avatarWidth).toBe(176)
  expect(printLayout.merchantNameFontSize).toBe(52)
  expect(printLayout.merchantToQrGap).toBe(16)

  await page.emulateMedia({ media: "screen" })
  await closeButton.click()
  await expect(preview).toBeHidden()
})
