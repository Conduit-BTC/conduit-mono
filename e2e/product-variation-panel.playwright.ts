import { expect, test, type Locator, type Page } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const harnessUrl = "/src/test-fixtures/product-variation-panel-harness.tsx"

type Geometry = { x: number; y: number; width: number; height: number }
type PanelStyle = {
  opacity: string
  pointerEvents: string
  position: string
  visibility: string
}

async function mountHarness(page: Page): Promise<void> {
  await page.goto(`${marketUrl}/products`)
  await page.evaluate(async (fixtureUrl) => {
    const container = document.createElement("div")
    container.id = "product-variation-panel-harness"
    container.style.position = "relative"
    container.style.zIndex = "100"
    container.style.paddingBottom = "24rem"
    document.body.append(container)
    const fixture = (await import(fixtureUrl)) as {
      mountProductVariationPanelHarness: (element: HTMLElement) => () => void
    }
    fixture.mountProductVariationPanelHarness(container)
  }, harnessUrl)
}

async function geometry(locator: Locator): Promise<Geometry> {
  const box = await locator.boundingBox()
  if (!box) throw new Error("Expected element geometry")
  return box
}

async function panelStyle(panel: Locator): Promise<PanelStyle> {
  return await panel.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      position: style.position,
      visibility: style.visibility,
    }
  })
}

async function variationPanel(variableItem: Locator): Promise<Locator> {
  return variableItem
    .getByText("Size", { exact: true })
    .locator("xpath=../../..")
}

async function focusWithKeyboard(
  page: Page,
  locator: Locator,
  maximumTabs = 40
): Promise<void> {
  await page.locator("body").focus()
  for (let tab = 0; tab < maximumTabs; tab += 1) {
    await page.keyboard.press("Tab")
    if (
      await locator.evaluate((element) => document.activeElement === element)
    ) {
      return
    }
  }
  throw new Error("Expected keyboard navigation to focus element")
}

async function expectInlinePanel(panel: Locator, card: Locator): Promise<void> {
  await expect(panel).toBeVisible()
  expect(await panelStyle(panel)).toMatchObject({
    opacity: "1",
    pointerEvents: "auto",
    position: "static",
    visibility: "visible",
  })

  const [panelBox, cardBox] = await Promise.all([
    geometry(panel),
    geometry(card),
  ])
  expect(panelBox.x).toBeGreaterThanOrEqual(cardBox.x)
  expect(panelBox.y).toBeGreaterThanOrEqual(cardBox.y)
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(
    cardBox.x + cardBox.width
  )
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(
    cardBox.y + cardBox.height
  )
}

function expectUnchangedGeometry(
  initial: readonly Geometry[],
  current: readonly Geometry[]
): void {
  expect(current).toHaveLength(initial.length)
  const scrollDelta = current[0].y - initial[0].y
  for (const [index, initialBox] of initial.entries()) {
    const currentBox = current[index]
    expect(currentBox).toMatchObject({
      width: initialBox.width,
      height: initialBox.height,
      x: initialBox.x,
    })
    expect(
      Math.abs(currentBox.y - initialBox.y - scrollDelta)
    ).toBeLessThanOrEqual(1)
  }
}

test("market product variation panel preserves grid geometry across desktop mouse reveal and select portal @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)

  const grid = page.getByTestId("product-variation-grid")
  const variableItem = page.getByTestId("variable-product-list-item")
  const sibling = page.getByTestId("simple-product-sibling")
  const variableCard = variableItem.locator(":scope > div")
  const chooseSize = variableItem.getByRole("combobox", {
    name: "Choose size",
    includeHidden: true,
  })
  const panel = await variationPanel(variableItem)

  await expect(grid).toBeVisible()
  await expect(chooseSize).toBeAttached()
  await variableCard.scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollBy(0, 240))
  await page.mouse.move(1430, 20)
  await expect
    .poll(() => panelStyle(panel))
    .toEqual({
      opacity: "0",
      pointerEvents: "none",
      position: "absolute",
      visibility: "hidden",
    })

  const initialGeometry = await Promise.all(
    [variableCard, variableItem, sibling, grid].map(geometry)
  )

  const variableCardBox = await geometry(variableCard)
  await page.mouse.move(
    variableCardBox.x + variableCardBox.width / 2,
    variableCardBox.y + variableCardBox.height / 2
  )
  await expect(chooseSize).toBeVisible()
  await expect
    .poll(() => panelStyle(panel))
    .toMatchObject({
      opacity: "1",
      pointerEvents: "auto",
      position: "absolute",
      visibility: "visible",
    })
  expectUnchangedGeometry(
    initialGeometry,
    await Promise.all([variableCard, variableItem, sibling, grid].map(geometry))
  )

  await chooseSize.click()
  await expect(chooseSize).toHaveAttribute("aria-expanded", "true")
  await expect(page.getByRole("listbox")).toBeVisible()
  await page.mouse.move(1430, 880)
  await expect(page.getByRole("listbox")).toBeVisible()
  await expect
    .poll(() => panelStyle(panel))
    .toMatchObject({
      opacity: "1",
      pointerEvents: "auto",
      visibility: "visible",
    })
  expectUnchangedGeometry(
    initialGeometry,
    await Promise.all([variableCard, variableItem, sibling, grid].map(geometry))
  )

  await page.keyboard.press("Escape")
  await expect(chooseSize).toHaveAttribute("aria-expanded", "false")
})

test("market product variation panel reveals for desktop keyboard Select interaction @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)

  const variableItem = page.getByTestId("variable-product-list-item")
  const variableCard = variableItem.locator(":scope > div")
  const chooseSize = variableItem.getByRole("combobox", {
    name: "Choose size",
    includeHidden: true,
  })
  const panel = await variationPanel(variableItem)

  await page.mouse.move(1430, 20)
  await expect
    .poll(() => panelStyle(panel))
    .toMatchObject({ opacity: "0", visibility: "hidden" })

  await focusWithKeyboard(page, variableCard)
  await expect(variableCard).toBeFocused()
  await expect
    .poll(() => panelStyle(panel))
    .toMatchObject({
      opacity: "1",
      pointerEvents: "auto",
      visibility: "visible",
    })

  await focusWithKeyboard(page, chooseSize)
  await expect(chooseSize).toBeFocused()
  await chooseSize.press("Enter")
  await expect(chooseSize).toHaveAttribute("aria-expanded", "true")

  const listbox = page.getByRole("listbox")
  await expect(listbox).toBeVisible()
  await expect
    .poll(() =>
      listbox.evaluate((element) => element.contains(document.activeElement))
    )
    .toBe(true)
  await expect
    .poll(() => panelStyle(panel))
    .toMatchObject({
      opacity: "1",
      pointerEvents: "auto",
      visibility: "visible",
    })

  await page.keyboard.press("Escape")
  await expect(chooseSize).toHaveAttribute("aria-expanded", "false")
})

test("market product variation panel remains inline on touch tablets @market", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 1024, height: 768 },
  })
  const page = await context.newPage()

  try {
    await mountHarness(page)
    await expect
      .poll(() =>
        page.evaluate(() => window.matchMedia("(hover: none)").matches)
      )
      .toBe(true)

    const variableItem = page.getByTestId("variable-product-list-item")
    const variableCard = variableItem.locator(":scope > div")
    const chooseSize = variableItem.getByRole("combobox", {
      name: "Choose size",
      includeHidden: true,
    })
    const panel = await variationPanel(variableItem)

    await expect(chooseSize).toBeVisible()
    await expectInlinePanel(panel, variableCard)
  } finally {
    await context.close()
  }
})

test("market product variation panel remains inline on narrow mobile @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mountHarness(page)

  const variableItem = page.getByTestId("variable-product-list-item")
  const variableCard = variableItem.locator(":scope > div")
  const chooseSize = variableItem.getByRole("combobox", {
    name: "Choose size",
    includeHidden: true,
  })
  const panel = await variationPanel(variableItem)

  await expect(chooseSize).toBeVisible()
  await expectInlinePanel(panel, variableCard)
})
