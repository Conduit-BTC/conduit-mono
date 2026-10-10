import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { THEME_STORAGE_KEY } from "@conduit/ui/theme"
import { installTestSigner, TEST_MERCHANT_PUBKEY } from "./helpers/auth"
const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

for (const theme of ["day-market", "night-market"]) {
  test(`catalog density and matching media radius in ${theme} @market`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      ({ key, theme }) => localStorage.setItem(key, theme),
      { key: THEME_STORAGE_KEY, theme }
    )
    await page.goto(`${marketUrl}/products`)
    await page.evaluate(async () => {
      const container = document.createElement("div")
      container.id = "density-harness"
      container.style.cssText =
        "position:relative;z-index:100;padding:12px;background:var(--background)"
      document.body.append(container)
      const fixture =
        await import("/src/test-fixtures/shared-ui-density-harness.tsx")
      fixture.mountSharedUiDensityHarness(container)
    })
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const card = page.getByTestId("density-catalog").getByRole("link").first()
      await expect(card).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const geometry = await card.evaluate((element) => {
        const media = element.firstElementChild!
        const title = element.querySelector("h3")!
        const merchant = element.querySelector("button")!
        const action = element.querySelector('[aria-label^="Add "]')!
        const price =
          element.querySelector('[data-slot="product-price"]') ??
          element.querySelector(".tabular-nums")!
        const box = element.getBoundingClientRect(),
          image = media.getBoundingClientRect(),
          p = price.getBoundingClientRect(),
          a = action.getBoundingClientRect()
        return {
          bodyHeight: box.height - image.height,
          titleHeight: title.getBoundingClientRect().height,
          merchantLineHeight: parseFloat(getComputedStyle(merchant).lineHeight),
          merchantTargetHeight: merchant.getBoundingClientRect().height,
          actionRightOfPrice: a.left >= p.right - 1,
          actionHeight: a.height,
          radius: getComputedStyle(element).borderTopLeftRadius,
          mediaRadius: getComputedStyle(media).borderTopLeftRadius,
          priceText: price.textContent,
          priceClipped:
            price.firstElementChild!.scrollWidth >
            price.firstElementChild!.clientWidth,
          priceColor: getComputedStyle(price.firstElementChild ?? price).color,
          pageWidth: document.documentElement.clientWidth,
          contentWidth: document.documentElement.scrollWidth,
        }
      })
      expect(geometry.bodyHeight).toBeLessThanOrEqual(145)
      expect(geometry.titleHeight).toBeLessThanOrEqual(25)
      expect(geometry.merchantLineHeight).toBeLessThanOrEqual(28)
      expect(geometry.merchantTargetHeight).toBeGreaterThanOrEqual(
        width < 640 ? 44 : 24
      )
      expect(geometry.actionRightOfPrice).toBe(true)
      expect(geometry.actionHeight).toBeGreaterThanOrEqual(
        width < 768 ? 44 : 32
      )
      expect(parseFloat(geometry.mediaRadius)).toBeCloseTo(
        parseFloat(geometry.radius) - 1,
        0
      )
      expect(geometry.priceText).not.toMatch(/[~≈]/)
      expect(geometry.priceClipped, `Complete price at ${width}px`).toBe(false)
      expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.pageWidth + 1)
      if (process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR) {
        await mkdir(process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR, {
          recursive: true,
        })
        await page.getByTestId("density-catalog").screenshot({
          path: join(
            process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR,
            `catalog-${info.project.name}-${theme}-${width}.png`
          ),
        })
      }
    }
    const stepTitles = await page
      .getByTestId("narrow-stepper")
      .locator("[data-slot=step-title]")
      .evaluateAll((elements) =>
        elements.map((el) => el.getBoundingClientRect().height)
      )
    for (const height of stepTitles) expect(height).toBeLessThanOrEqual(48)
    const contrast = await page
      .getByTestId("semantic-states")
      .evaluate((root) => {
        const components = (value: string) => {
          const n = value.match(/[\d.]+/g)!.map(Number)
          return value.startsWith("color(srgb")
            ? n.map((v, i) => (i < 3 ? v * 255 : v))
            : n
        }
        const rgb = (value: string) => components(value).slice(0, 3)
        const over = (fg: number[], bg: number[], alpha: number) =>
          fg.map((v, i) => v * alpha + bg[i] * (1 - alpha))
        const luminance = (c: number[]) =>
          c
            .map((v) => v / 255)
            .map((v) =>
              v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
            )
            .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
        const background = (el: Element): number[] => {
          const value = getComputedStyle(el).backgroundColor
          const numbers = components(value)
          const alpha = numbers[3] ?? 1
          return alpha === 1
            ? numbers.slice(0, 3)
            : over(
                numbers.slice(0, 3),
                el.parentElement
                  ? background(el.parentElement)
                  : [255, 255, 255],
                alpha
              )
        }
        return [
          ...root.querySelectorAll("[data-testid]"),
          document.querySelector(
            "[data-testid=density-catalog] [data-slot=product-price] > div"
          )!,
        ].map((el) => {
          const color = rgb(getComputedStyle(el).color),
            bg = background(el)
          const a = luminance(color),
            b = luminance(bg)
          return {
            id: el.getAttribute("data-testid") ?? "bitcoin-price",
            color,
            ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          }
        })
      })
    await info.attach("rendered-contrast", {
      body: JSON.stringify(contrast),
      contentType: "application/json",
    })
    for (const sample of contrast)
      expect.soft(sample.ratio, sample.id!).toBeGreaterThanOrEqual(4.5)
    expect(
      contrast.find((x) => x.id === "success-copy")!.color[1]
    ).toBeGreaterThan(contrast.find((x) => x.id === "success-copy")!.color[0])
    expect(contrast.find((x) => x.id === "cancel-action")!.color).toEqual([
      255, 255, 255,
    ])
    if (process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR)
      await page.getByTestId("semantic-states").screenshot({
        path: join(
          process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR,
          `semantic-${info.project.name}-${theme}.png`
        ),
      })
  })
  test(`merchant menu keeps its control position in ${theme} @merchant`, async ({
    page,
  }) => {
    await installTestSigner(page, TEST_MERCHANT_PUBKEY)
    await page.addInitScript(
      ({ key, theme }) => localStorage.setItem(key, theme),
      { key: THEME_STORAGE_KEY, theme }
    )
    await page.goto(`${merchantUrl}/products`)
    for (const width of [320, 375, 900, 1023]) {
      await page.setViewportSize({ width, height: 900 })
      const open = page.getByRole("button", { name: "Open menu", exact: true })
      await expect(open).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const initial = await open.boundingBox()
      await open.click()
      const dialog = page.getByRole("dialog", {
        name: "Conduit Merchant navigation",
      })
      const close = dialog.getByRole("button", { name: "Close", exact: true })
      await expect(close).toBeVisible()
      // Wait for the existing sheet entrance animation to settle.
      await expect
        .poll(async () => Math.abs((await close.boundingBox())!.x - initial!.x))
        .toBeLessThan(1)
      const final = await close.boundingBox()
      expect(Math.abs(final!.y - initial!.y)).toBeLessThan(1)
      await page.keyboard.press("Escape")
      await expect(open).toBeFocused()
    }
  })
}

for (const theme of ["day-market", "night-market"]) {
  test(`compact large prices stay inside neighboring cards in ${theme} @market`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      ({ key, theme }) => localStorage.setItem(key, theme),
      { key: THEME_STORAGE_KEY, theme }
    )
    await page.goto(`${marketUrl}/products`)
    await page.evaluate(async () => {
      const container = document.createElement("div")
      container.id = "price-harness"
      container.style.cssText =
        "position:relative;z-index:100;padding:12px;background:var(--background)"
      document.body.append(container)
      const fixture =
        await import("/src/test-fixtures/shared-ui-density-harness.tsx")
      fixture.mountSharedUiPriceHarness(container)
    })
    const catalog = page.getByTestId("compact-prices")
    await expect(catalog.getByText("$100.3k", { exact: true })).toBeVisible()
    await expect(catalog.getByText("$1.403M", { exact: true })).toBeVisible()
    await expect(catalog.getByText("$1.403B", { exact: true })).toBeVisible()
    await expect(catalog.getByText("$1M", { exact: true })).toBeVisible()
    await expect(catalog.getByText("1 BTC", { exact: true })).toBeVisible()
    for (const width of [320, 375, 768]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(() => document.fonts.ready)
      for (const enlarged of [false, true]) {
        await page.evaluate(
          (enlarged) =>
            (document.documentElement.style.fontSize = enlarged ? "200%" : ""),
          enlarged
        )
        const bounds = await catalog.getByRole("link").evaluateAll(
          (cards, minimumActionHeight) =>
            cards.map((card) => {
              const box = card.getBoundingClientRect()
              const price = card.querySelector('[data-slot="product-price"]')!
              const spans = price.querySelectorAll('span[aria-hidden="true"]')
              const fragments = [
                ...(spans.length
                  ? spans
                  : price.querySelectorAll("span[title]")),
              ].flatMap((el) => {
                const r = document.createRange()
                r.selectNodeContents(el)
                return [...r.getClientRects()].map((x) => ({
                  left: x.left,
                  right: x.right,
                }))
              })
              const actions = [
                ...card.querySelectorAll('[role="group"] button'),
              ].map((el) => el.getBoundingClientRect())
              return {
                contained: fragments.every(
                  (r) => r.left >= box.left - 1 && r.right <= box.right + 1
                ),
                actions: actions.every(
                  (a) =>
                    a.left >= box.left - 1 &&
                    a.right <= box.right + 1 &&
                    a.height >= minimumActionHeight
                ),
              }
            }),
          width < 768 ? 44 : 32
        )
        expect(
          bounds.every((b) => b.contained),
          `${width}px ${enlarged ? "enlarged" : "normal"} price fragments`
        ).toBe(true)
        expect(bounds.every((b) => b.actions)).toBe(true)
      }
      await page.evaluate(() => (document.documentElement.style.fontSize = ""))
    }
    await page.setViewportSize({ width: 320, height: 900 })
    const btcCard = catalog
      .getByRole("link")
      .filter({ hasText: "₿100,000,000" })
    const add = btcCard.getByRole("button", {
      name: "Add Large price to cart",
      exact: true,
    })
    // Keyboard activation checks focus preservation; Safari does not focus buttons on pointer clicks.
    await add.focus()
    await add.press("Enter")
    await expect(
      btcCard.getByRole("button", { name: "Remove one Large price from cart" })
    ).toBeFocused()
    await btcCard
      .getByRole("button", { name: "Add one more Large price to cart" })
      .click()
    await expect(
      btcCard.getByRole("group", { name: "Cart action for Large price" })
    ).toContainText("2")
    const quantityBounds = await btcCard.evaluate((card) => {
      const box = card.getBoundingClientRect()
      return [...card.querySelectorAll('[role="group"] button')].every((el) => {
        const action = el.getBoundingClientRect()
        return (
          action.left >= box.left - 1 &&
          action.right <= box.right + 1 &&
          action.height >= 44
        )
      })
    })
    expect(quantityBounds).toBe(true)
    await expect(
      btcCard.locator('[data-slot="product-price"] span[title]').first()
    ).toHaveAttribute("title", "₿100,000,000")
    await expect(
      page
        .getByTestId("merchant-compact-price")
        .getByText("1.235 BTC", { exact: true })
    ).toBeVisible()
    if (process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR) {
      await mkdir(process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR, { recursive: true })
      for (const row of [2, 4, 5]) {
        await catalog
          .locator("ul")
          .nth(row)
          .screenshot({
            path: join(
              process.env.PLAYWRIGHT_UI_SCREENSHOT_DIR,
              `compact-prices-${row}-${info.project.name}-${theme}.png`
            ),
          })
      }
    }
  })
}
