import { resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { TEST_RELAY_URL } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const fixturePath = `/@fs${resolve("packages/ui/workbench/scroll-containment-harness.tsx")}`

// Authenticated shells can display account identifiers; evidence is geometry only.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"
test.use({ screenshot: "off", trace: "off", video: "off" })

async function mountLongForm(page: Page) {
  await expect(page.locator("main")).toBeVisible()
  await expect(page.locator("main > *").first()).toBeVisible()
  await page.evaluate(async (path) => {
    const container = document.createElement("div")
    container.dataset.testid = "scroll-containment-fixture"
    document.querySelector("main")!.append(container)
    const fixture = await import(/* @vite-ignore */ path)
    fixture.mountScrollContainmentHarness(container)
  }, fixturePath)
  await expect(page.getByLabel("Last form field")).toBeAttached()
  // Exercise the real Radix form bridge, not a hand-written approximation.
  await expect(page.locator('select[name="containment-choice"]')).toHaveCount(1)
}

async function documentGeometry(page: Page) {
  return page.evaluate(() => ({
    viewport: document.documentElement.clientHeight,
    visibleHeight: window.visualViewport?.height ?? window.innerHeight,
    height: document.documentElement.scrollHeight,
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollY: window.scrollY,
    rootTop: document.getElementById("root")!.getBoundingClientRect().top,
    rootHeight: document.getElementById("root")!.getBoundingClientRect().height,
  }))
}

async function expectDesktopMerchantContained(page: Page) {
  await expect
    .poll(async () => {
      const geometry = await documentGeometry(page)
      return Math.abs(geometry.height - geometry.viewport)
    })
    .toBeLessThanOrEqual(1)
  const geometry = await documentGeometry(page)
  expect(geometry.scrollY).toBe(0)
  expect(geometry.rootTop).toBe(0)
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1)
}

async function exercisePortals(page: Page) {
  const choice = page.getByRole("combobox", { name: "Containment choice" })
  await choice.click()
  await page.getByRole("option", { name: "Second choice" }).click()
  await expect(choice).toContainText("Second choice")
  await expect(choice).toBeFocused()
  const trigger = page.getByRole("button", { name: "Open containment dialog" })
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "Containment dialog" })
  await expect(dialog).toBeInViewport()
  await dialog.getByLabel("Dialog field").fill("Layout check")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
}

async function addEscapingRootControl(page: Page) {
  await page.evaluate(() => {
    const root = document.getElementById("root")!
    const control = document
      .querySelector<HTMLSelectElement>('select[name="containment-choice"]')!
      .cloneNode(true) as HTMLSelectElement
    control.removeAttribute("name")
    control.style.top = `${root.getBoundingClientRect().height + 2000}px`
    control.dataset.testid = "escaping-root-control"
    root.append(control)
  })
}

for (const route of ["/events/new", "/profile", "/preferences"]) {
  test(`Merchant contains long form controls across ${route} and responsive layouts @merchant`, async ({
    page,
    browserName,
    isMobile,
  }) => {
    const identity = createRuntimeSignerIdentity()
    try {
      await installRealTestSigner(page, identity, TEST_RELAY_URL)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${merchantUrl}${route}`)
      await mountLongForm(page)
      await expectDesktopMerchantContained(page)

      const nativeControl = page.locator('select[name="containment-choice"]')
      const before = await nativeControl.evaluate(
        (element) => element.getBoundingClientRect().top
      )
      await page.getByLabel("Last form field").focus()
      await expect(page.getByLabel("Last form field")).toBeInViewport()
      const after = await nativeControl.evaluate(
        (element) => element.getBoundingClientRect().top
      )
      expect(before - after).toBeGreaterThan(500)
      await expectDesktopMerchantContained(page)
      await exercisePortals(page)

      // A future positioned child outside main must not reintroduce an outer
      // scrollbar even if it misses the scroll owner's positioning boundary.
      await addEscapingRootControl(page)
      await page.evaluate(() =>
        window.scrollTo({ top: 10000, behavior: "instant" })
      )
      // Playwright cannot synthesize wheel input in mobile WebKit; the
      // direct document scroll above still exercises its containment boundary.
      if (!(browserName === "webkit" && isMobile)) {
        await page.mouse.move(1439, 450)
        await page.mouse.wheel(0, 1500)
      }
      await expectDesktopMerchantContained(page)
      await page
        .getByTestId("escaping-root-control")
        .evaluate((element) => element.remove())

      await page.setViewportSize({ width: 1024, height: 900 })
      await expectDesktopMerchantContained(page)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByLabel("Last form field").focus()
      await expect(page.getByLabel("Last form field")).toBeInViewport()
      expect((await documentGeometry(page)).scrollY).toBeGreaterThan(0)
      await exercisePortals(page)
      await page.setViewportSize({ width: 1440, height: 900 })
      await expectDesktopMerchantContained(page)
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}

for (const route of ["/products", "/preferences"]) {
  test(`Market preserves document scrolling without escaped control overflow on ${route} @market`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    try {
      if (route === "/preferences") {
        await installRealTestSigner(page, identity, TEST_RELAY_URL)
      }
      await page.goto(`${marketUrl}${route}`)
      await expect(page).toHaveURL(`${marketUrl}${route}`)
      if (route === "/preferences") {
        await expect(
          page.getByRole("heading", { name: "Preferences", exact: true })
        ).toBeVisible()
      }
      await mountLongForm(page)
      await page.getByLabel("Last form field").focus()
      await expect(page.getByLabel("Last form field")).toBeInViewport()
      expect((await documentGeometry(page)).scrollY).toBeGreaterThan(0)
      await exercisePortals(page)
      await addEscapingRootControl(page)
      await page.evaluate(() =>
        window.scrollTo({ top: 10000, behavior: "instant" })
      )
      const geometry = await documentGeometry(page)
      expect(geometry.height).toBeLessThanOrEqual(
        Math.ceil(geometry.rootHeight) + 1
      )
      // Mobile WebKit can have a smaller visual viewport than the layout viewport.
      expect(geometry.scrollY).toBeLessThanOrEqual(
        geometry.rootHeight - geometry.visibleHeight + 1
      )
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1)
      await page.getByLabel("Last form field").focus()
      await expect(page.getByLabel("Last form field")).toBeInViewport()
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}
