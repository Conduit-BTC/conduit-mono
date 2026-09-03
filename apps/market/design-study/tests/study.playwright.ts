import { expect, test, type Page } from "@playwright/test"

const audits = new WeakMap<
  Page,
  { unexpectedRequests: string[]; errors: string[] }
>()

test.beforeEach(async ({ page }) => {
  const unexpectedRequests: string[] = []
  const errors: string[] = []
  audits.set(page, { unexpectedRequests, errors })
  const allowedOrigins = new Set([
    "http://127.0.0.1:7070",
    "http://127.0.0.1:7071",
  ])
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (
      !allowedOrigins.has(url.origin) ||
      url.pathname.includes("/packages/core/") ||
      url.pathname.includes("/apps/market/src/")
    ) {
      unexpectedRequests.push(
        `${request.method()} ${url.origin}${url.pathname}`
      )
    }
  })
  page.on("websocket", (socket) => {
    const url = new URL(socket.url())
    if (url.origin !== "ws://127.0.0.1:7070")
      unexpectedRequests.push(`WebSocket ${url.origin}`)
  })
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await page.addInitScript(() => {
    const violations: string[] = []
    Object.assign(window, { studyPolicyViolations: violations })
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push(event.violatedDirective)
    )
  })
})

test.afterEach(async ({ page }) => {
  // Include attempted connections blocked by CSP, not only completed requests.
  const audit = audits.get(page)!
  expect(
    audit.unexpectedRequests,
    "Study must not load production modules or contact external services"
  ).toEqual([])
  expect(audit.errors, "No browser runtime errors").toEqual([])
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { studyPolicyViolations: string[] })
          .studyPolicyViolations
    )
  ).toEqual([])
})

test("sample catalog and screenshot fit the viewport", async ({
  page,
}, testInfo) => {
  await page.goto("/")
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()
  await expect(page.locator("[data-product-id]")).toHaveCount(12)
  await expect(
    page.getByText("No image available", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Weekend long-sleeve is sold out" })
  ).toBeDisabled()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({
    path: testInfo.outputPath("catalog.png"),
    fullPage: true,
  })
})

test("search, category, shop, sort, and empty recovery use fixtures", async ({
  page,
}) => {
  await page.goto("/")
  await page
    .getByRole("searchbox", { name: "Search sample products" })
    .fill("coffee-does-not-exist")
  await expect(
    page.getByRole("heading", { name: "No products found" })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .first()
    .click()
  await page.getByRole("button", { name: "Clothing", exact: true }).click()
  await expect(page.locator("[data-product-id]")).toHaveCount(3)
  await page.getByRole("button", { name: "All products", exact: true }).click()
  await page.getByRole("combobox", { name: "Shop", exact: true }).click()
  await page.getByRole("option", { name: "Early Bird", exact: true }).click()
  await expect(page.locator("[data-product-id]")).toHaveCount(2)
  await page.getByRole("combobox", { name: "Sort", exact: true }).click()
  await page
    .getByRole("option", { name: "Price: low to high", exact: true })
    .click()
  await expect(page.locator("[data-product-id]").first()).toHaveAttribute(
    "data-product-id",
    "tea"
  )
  await page.getByRole("searchbox").fill("blend")
  await expect(page.locator("[data-product-id]")).toHaveCount(1)
})

test("options and cart are pretend, dialogs restore keyboard focus", async ({
  page,
}) => {
  await page.goto("/")
  await page
    .getByRole("combobox", { name: "Option for Everyday cotton tee" })
    .click()
  await page.getByRole("option", { name: "Large", exact: true }).click()
  await page
    .getByRole("button", { name: "Add Everyday cotton tee to demo cart" })
    .click()
  await expect(
    page.getByText("Added Everyday cotton tee (Large) to the demo cart.", {
      exact: true,
    })
  ).toBeVisible()
  const cart = page.getByRole("button", { name: "Demo cart, 1 items" })
  await cart.focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Tab")
  expect(
    await dialog.evaluate((element) => element.contains(document.activeElement))
  ).toBe(true)
  await page.keyboard.press("Escape")
  await expect(cart).toBeFocused()
  await cart.click()
  await page.getByRole("button", { name: "Clear demo cart" }).click()
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("button", { name: "Demo cart, 0 items" })
  ).toBeVisible()
  const product = page.getByRole("button", {
    name: "View Hand-thrown everyday mug",
  })
  await product.click()
  await expect(
    dialog.getByRole("heading", { name: "Hand-thrown everyday mug" })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(product).toBeFocused()
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Demo cart, 0 items" })
  ).toBeVisible()
})

test("theme cycles and persists without login; both appearances fit", async ({
  page,
}, testInfo) => {
  await page.goto("/")
  const initial =
    testInfo.project.use.colorScheme === "dark" ? "night-market" : "day-market"
  await expect(page.locator("html")).toHaveAttribute("data-theme", initial)
  await page
    .getByRole("button", {
      name: "Appearance: System. Switch to Day Market",
      exact: true,
    })
    .click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "day-market")
  await page.screenshot({
    path: testInfo.outputPath("day-market.png"),
    fullPage: true,
  })
  await page
    .getByRole("button", {
      name: "Appearance: Day Market. Switch to Night Market",
      exact: true,
    })
    .click()
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "night-market"
  )
  await page.reload()
  await expect(
    page.getByRole("button", {
      name: "Appearance: Night Market. Switch to System",
      exact: true,
    })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: testInfo.outputPath("night-market.png"),
    fullPage: true,
  })
})

test("study controls expose loading and empty states", async ({ page }) => {
  await page.goto("/")
  await page.getByText("Study controls", { exact: true }).click()
  await page.getByRole("combobox", { name: "Preview state" }).click()
  await page.getByRole("option", { name: "Loading", exact: true }).click()
  await expect(
    page.getByText("Loading sample products…", { exact: true })
  ).toBeVisible()
  await expect(page.locator("[data-product-id]")).toHaveCount(0)
  await page.getByRole("combobox", { name: "Preview state" }).click()
  await page.getByRole("option", { name: "Empty", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "No products found" })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .first()
    .click()
  await expect(page.locator("[data-product-id]")).toHaveCount(12)
})

test("built page also runs without production services", async ({ page }) => {
  await page.goto("http://127.0.0.1:7071/")
  await expect(page.locator("[data-product-id]")).toHaveCount(12)
  await page
    .getByRole("button", { name: "Add Carry-all canvas tote to demo cart" })
    .click()
  await page.getByRole("button", { name: "Demo cart, 1 items" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await page
    .getByRole("button", {
      name: "Appearance: System. Switch to Day Market",
      exact: true,
    })
    .click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "day-market")
})
