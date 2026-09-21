import { expect, test, type Locator, type Page } from "@playwright/test"
import { TEST_BUYER_PUBKEY, installTestSigner } from "./helpers/auth"

const appCases = [
  {
    app: "market",
    appName: "Conduit Market",
    url: `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`,
  },
  {
    app: "merchant",
    appName: "Conduit Merchant Portal",
    url: `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`,
  },
] as const

const marketUrl = appCases[0].url

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1)
}

async function visibleHeaderRows(page: Page): Promise<number[]> {
  const centers = await page
    .locator(".market-header-layout > *:visible")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect()
        return rect.top + rect.height / 2
      })
    )

  return centers.reduce<number[]>((rows, center) => {
    if (!rows.some((row) => Math.abs(row - center) <= 2)) rows.push(center)
    return rows
  }, [])
}

async function expectSameRow(first: Locator, second: Locator): Promise<void> {
  const [firstBox, secondBox] = await Promise.all([
    first.boundingBox(),
    second.boundingBox(),
  ])
  expect(firstBox).not.toBeNull()
  expect(secondBox).not.toBeNull()
  const firstCenter = firstBox!.y + firstBox!.height / 2
  const secondCenter = secondBox!.y + secondBox!.height / 2
  expect(Math.abs(firstCenter - secondCenter)).toBeLessThanOrEqual(2)
}

for (const { app, appName, url } of appCases) {
  test(`${app} signed-out About renders visitor content in the public app shell @${app}`, async ({
    page,
  }) => {
    await page.goto(`${url}/about`)

    await expect(
      page.getByRole("heading", {
        name: `About ${appName}`,
        level: 1,
        exact: true,
      })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "How Conduit works", level: 2 })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Multiple relays", level: 3 })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Public and private data", level: 3 })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "You stay in control", level: 3 })
    ).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Network settings" })
    ).toHaveCount(0)

    const footer = page.getByRole("contentinfo")
    if (app === "market") {
      await expect(footer.getByText("About", { exact: true })).toHaveAttribute(
        "aria-current",
        "page"
      )
      await expect(footer.getByRole("link", { name: "About" })).toHaveCount(0)
    } else {
      await expect(footer.getByRole("link", { name: "About" })).toBeVisible()
    }
    await expect(footer.getByRole("link", { name: "Terms" })).toBeVisible()
    await expect(footer.getByRole("link", { name: "Privacy" })).toBeVisible()

    if (app === "market") {
      await expect(
        page.getByRole("navigation", { name: "Market navigation" })
      ).toBeVisible()
    } else {
      const merchantHomeLink = page.getByRole("link", {
        name: "Conduit Merchant home",
      })
      await expect(merchantHomeLink).toBeVisible()
      await expect(merchantHomeLink).toHaveAttribute("href", "/")
      await expect(
        page.getByRole("heading", { name: "Sign in to Conduit" })
      ).toHaveCount(0)
      await expect(
        page.getByRole("link", { name: "Open merchant workspace" })
      ).toHaveCount(0)
    }
  })

  test(`${app} signed-out About remains usable at a mobile viewport @${app}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${url}/about`)

    await expect(
      page.getByRole("heading", {
        name: `About ${appName}`,
        level: 1,
        exact: true,
      })
    ).toBeVisible()
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      /width=device-width/
    )
    await page.getByText("Build details", { exact: true }).click()
    await page.getByText("Nostr app handler metadata", { exact: true }).click()
    await expectNoHorizontalOverflow(page)

    if (app === "merchant") {
      await expect(
        page.getByRole("link", { name: "Conduit Merchant home" })
      ).toBeVisible()
      await expect(
        page.getByRole("link", { name: "Open workspace" })
      ).toHaveCount(0)
    }
  })
}

test("market mobile chrome hides while scrolling down and returns on scroll up @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 })
  await page.goto(`${marketUrl}/about`)

  const header = page.getByRole("banner")
  const footer = page.locator("footer")
  const footerItems = [
    footer.getByText("About", { exact: true }),
    footer.getByRole("link", { name: "Terms" }),
    footer.getByRole("link", { name: "Privacy" }),
    footer.getByRole("link", { name: "Report a Bug" }),
  ]

  await expect(header).toBeVisible()
  await expect(footer).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Conduit Market home" })
  ).toContainText("market")
  await expect(page.getByRole("button", { name: /^Messages/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Orders" })).toHaveCount(0)
  const cartButton = page.getByRole("button", { name: /^Cart,/ })
  const connectButton = page.getByRole("button", { name: "Connect" })
  await expect(cartButton).toBeVisible()
  await expect(connectButton).toBeVisible()
  expect((await connectButton.boundingBox())!.width).toBeLessThanOrEqual(44)
  expect(await visibleHeaderRows(page)).toHaveLength(2)
  await expectSameRow(
    page.getByRole("link", { name: "Conduit Market home" }),
    cartButton
  )
  for (const item of footerItems) await expect(item).toBeVisible()
  await expect(footerItems[0]).toHaveAttribute("aria-current", "page")
  await expect(footer.getByRole("link", { name: "About" })).toHaveCount(0)
  await expect(
    footer.getByRole("link", { name: "Conduit landing page" })
  ).toHaveCount(0)
  await expect(
    footer.getByRole("navigation", { name: "Resource links" })
  ).toHaveCount(0)

  const linkCenters = await Promise.all(
    footerItems.map(async (item) => {
      const box = await item.boundingBox()
      expect(box).not.toBeNull()
      return box!.y + box!.height / 2
    })
  )
  expect(Math.max(...linkCenters) - Math.min(...linkCenters)).toBeLessThan(1)
  expect(
    await footer.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true)

  await page.evaluate(() => window.scrollTo(0, 600))
  await expect
    .poll(() =>
      header.evaluate((element) => element.getBoundingClientRect().bottom)
    )
    .toBeLessThanOrEqual(0)
  await expect(footer).toHaveAttribute("aria-hidden", "true")
  await expect(footer).toHaveClass(/translate-y-full/)

  await page.evaluate(() => window.scrollBy(0, -8))
  await expect
    .poll(() =>
      header.evaluate((element) => element.getBoundingClientRect().bottom)
    )
    .toBeGreaterThan(0)
  await expect
    .poll(() =>
      footer.evaluate((element) => element.getBoundingClientRect().top)
    )
    .toBeLessThan(700)
  await expect(footer).not.toHaveAttribute("aria-hidden", "true")
  await expect(footer).toHaveClass(/translate-y-0/)

  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(12)
})

test("market signed-in mobile header keeps buyer actions beside search in two rows @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 })
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await page.goto(`${marketUrl}/about`)

  const searchInput = page.getByRole("combobox", { name: /^Search products/ })
  const messagesButton = page.getByRole("button", { name: /^Messages/ })
  const ordersButton = page.getByRole("button", { name: "Orders" })
  const cartButton = page.getByRole("button", { name: /^Cart,/ })

  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible({ timeout: 15_000 })
  await expect(messagesButton).toBeVisible()
  await expect(ordersButton).toBeVisible()
  await expect(cartButton).toBeVisible()
  expect(await visibleHeaderRows(page)).toHaveLength(2)
  await expectSameRow(searchInput, messagesButton)
  await expectSameRow(searchInput, ordersButton)
  await expectSameRow(
    page.getByRole("link", { name: "Conduit Market home" }),
    cartButton
  )
})
