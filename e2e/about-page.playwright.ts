import { expect, test, type Page } from "@playwright/test"

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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1)
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
    await expect(footer.getByRole("link", { name: "About" })).toBeVisible()
    await expect(footer.getByRole("link", { name: "Terms" })).toBeVisible()
    await expect(footer.getByRole("link", { name: "Privacy" })).toBeVisible()

    if (app === "market") {
      await expect(
        page.getByRole("navigation", { name: "Market navigation" })
      ).toBeVisible()
    } else {
      const workspaceLink = page.getByRole("link", {
        name: "Open merchant workspace",
      })
      await expect(workspaceLink).toBeVisible()
      await expect(
        page.getByRole("heading", { name: "Connect a signer" })
      ).toHaveCount(0)
      await workspaceLink.click()
      await expect(page).toHaveURL(`${url}/`)
      await expect(
        page.getByRole("heading", { name: "Connect a signer" })
      ).toBeVisible()
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
        page.getByRole("link", { name: "Open workspace" })
      ).toBeVisible()
    }
  })
}
