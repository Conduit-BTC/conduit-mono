import { expect, test } from "@playwright/test"

const MERCHANT_A = "1".repeat(64)
const MERCHANT_B = "2".repeat(64)
const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ merchantA, merchantB }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 2,
          items: [
            {
              productId: `30402:${merchantA}:notebook`,
              merchantPubkey: merchantA,
              merchantAddedAt: 100,
              title: "Field Notebook",
              price: 1_200,
              currency: "SATS",
              priceSats: 1_200,
              format: "digital",
              quantity: 2,
            },
            {
              productId: `30402:${merchantB}:lamp`,
              merchantPubkey: merchantB,
              merchantAddedAt: 200,
              title: "Reading Lamp",
              price: 3_400,
              currency: "SATS",
              priceSats: 3_400,
              format: "digital",
              quantity: 1,
            },
          ],
        })
      )
    },
    { merchantA: MERCHANT_A, merchantB: MERCHANT_B }
  )
})

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1_440, height: 900 },
]) {
  test(`cart HUD is contained and route-aware on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.goto(`${marketUrl}/products`)
    const hud = page.getByRole("region", { name: "Cart inventory" })
    await expect(hud).toBeVisible()
    await expect(hud.getByRole("tab")).toHaveCount(2)
    await expect(hud.getByText("Reading Lamp")).toBeVisible()
    await expect(
      hud.getByRole("link", { name: /Continue to checkout/ })
    ).toBeVisible()

    expect(
      await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        hudHeight: getComputedStyle(document.documentElement).getPropertyValue(
          "--market-hud-height"
        ),
      }))
    ).toEqual({
      clientWidth: viewport.width,
      scrollWidth: viewport.width,
      hudHeight: expect.stringMatching(/^[1-9]\d*px$/),
    })

    const legalFooter = page.locator("footer").filter({
      has: page.getByRole("navigation", { name: "Legal links" }),
    })
    const footerLayout = await legalFooter.evaluate((footer) => ({
      height: Math.ceil(footer.getBoundingClientRect().height),
      offset: getComputedStyle(document.documentElement).getPropertyValue(
        "--market-fixed-footer-height"
      ),
      position: getComputedStyle(footer).position,
      scrollPaddingBottom: getComputedStyle(document.documentElement)
        .scrollPaddingBottom,
    }))
    expect(footerLayout.scrollPaddingBottom).not.toBe("auto")

    if (viewport.name === "desktop") {
      const hudBox = await hud.boundingBox()
      const footerBox = await legalFooter.boundingBox()
      expect(footerLayout.position).toBe("fixed")
      expect(footerLayout.offset).toBe(`${footerLayout.height}px`)
      expect(hudBox).not.toBeNull()
      expect(footerBox).not.toBeNull()
      expect(hudBox!.y + hudBox!.height).toBeLessThanOrEqual(footerBox!.y)
    } else {
      expect(footerLayout.position).not.toBe("fixed")
      expect(footerLayout.offset).toBe("0px")
    }

    const toggle = hud.locator("button[aria-expanded]")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(hud.locator("[inert]")).toHaveAttribute("aria-hidden", "true")

    await page.goto(`${marketUrl}/cart`)
    await expect(
      page.getByRole("region", { name: "Cart inventory" })
    ).toHaveCount(0)
  })
}
