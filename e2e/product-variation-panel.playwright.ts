import { expect, test, type Locator, type Page } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const harnessUrl = "/src/test-fixtures/product-variation-panel-harness.tsx"

type Geometry = { x: number; y: number; width: number; height: number }
type PanelStyle = {
  backgroundColor: string
  borderBottomLeftRadius: string
  borderBottomRightRadius: string
  borderBottomColor: string
  borderLeftColor: string
  borderRightColor: string
  borderTopWidth: string
  boxShadow: string
  opacity: string
  pointerEvents: string
  position: string
  visibility: string
  transitionProperty: string
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
      backgroundColor: style.backgroundColor,
      borderBottomLeftRadius: style.borderBottomLeftRadius,
      borderBottomRightRadius: style.borderBottomRightRadius,
      borderBottomColor: style.borderBottomColor,
      borderLeftColor: style.borderLeftColor,
      borderRightColor: style.borderRightColor,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      position: style.position,
      visibility: style.visibility,
      transitionProperty: style.transitionProperty,
    }
  })
}

async function cardStyle(card: Locator): Promise<{
  backgroundColor: string
  borderBottomWidth: string
  borderLeftColor: string
  borderRightColor: string
  boxShadow: string
  scale: string
  transitionProperty: string
}> {
  return card.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderBottomWidth: style.borderBottomWidth,
      borderLeftColor: style.borderLeftColor,
      borderRightColor: style.borderRightColor,
      boxShadow: style.boxShadow,
      scale: style.scale,
      transitionProperty: style.transitionProperty,
    }
  })
}

function expectMatchingOpaqueBackgrounds(
  cardBackground: string,
  panelBackground: string
): void {
  expect(panelBackground).toBe(cardBackground)
  const components = cardBackground.match(/[\d.]+/g)
  expect(components?.length).toBeGreaterThanOrEqual(3)
  expect(components?.length).toBeLessThanOrEqual(4)
  expect(components?.length === 4 ? Number(components[3]) : 1).toBe(1)
}

function expectJoinedBorderColors(
  card: Awaited<ReturnType<typeof cardStyle>>,
  panel: PanelStyle
): void {
  expect(card.borderLeftColor).toBe(panel.borderLeftColor)
  expect(card.borderRightColor).toBe(panel.borderRightColor)
  expect(card.borderLeftColor).toBe(panel.borderBottomColor)
}

async function hasJoinedBorderColors(
  card: Locator,
  panel: Locator
): Promise<boolean> {
  const [cardComputedStyle, panelComputedStyle] = await Promise.all([
    cardStyle(card),
    panelStyle(panel),
  ])
  return (
    cardComputedStyle.borderLeftColor === panelComputedStyle.borderLeftColor &&
    cardComputedStyle.borderRightColor ===
      panelComputedStyle.borderRightColor &&
    cardComputedStyle.borderLeftColor === panelComputedStyle.borderBottomColor
  )
}

function expectOpaquePanelCorners(panel: PanelStyle): void {
  expect(parseFloat(panel.borderBottomLeftRadius)).toBeGreaterThan(0)
  expect(parseFloat(panel.borderBottomRightRadius)).toBeGreaterThan(0)
  const components = panel.backgroundColor.match(/[\d.]+/g)
  expect(components?.length).toBeGreaterThanOrEqual(3)
  expect(components?.length).toBeLessThanOrEqual(4)
  expect(components?.length === 4 ? Number(components[3]) : 1).toBe(1)
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
  await page.emulateMedia({ colorScheme: "dark" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)

  const grid = page.getByTestId("product-variation-grid")
  const variableItem = page.getByTestId("variable-product-list-item")
  const sibling = page.getByTestId("simple-product-sibling")
  const variableCard = variableItem.locator(":scope > div")
  const media = variableCard.locator(":scope > div:first-child")
  const chooseSize = variableItem.getByRole("combobox", {
    name: "Choose size",
    includeHidden: true,
  })
  const panel = await variationPanel(variableItem)

  await expect(grid).toBeVisible()
  await expect(chooseSize).toBeAttached()
  await variableCard.scrollIntoViewIfNeeded()
  await expect
    .poll(() => panelStyle(panel))
    .toMatchObject({
      opacity: "0",
      pointerEvents: "none",
      position: "absolute",
      visibility: "hidden",
    })

  const initialCardGeometry = await geometry(variableCard)
  const initialGridGeometry = await Promise.all(
    [variableItem, sibling, grid].map(geometry)
  )

  await variableCard.hover()
  await expect(chooseSize).toBeVisible()
  await expect
    .poll(() => panelStyle(panel))
    .toMatchObject({
      opacity: "1",
      pointerEvents: "auto",
      position: "absolute",
      visibility: "visible",
    })
  const expandedCardGeometry = await geometry(variableCard)
  expect(expandedCardGeometry.width / initialCardGeometry.width).toBeCloseTo(
    1.12,
    2
  )
  expect(expandedCardGeometry.height / initialCardGeometry.height).toBeCloseTo(
    1.12,
    2
  )
  const expandedPanelStyle = await panelStyle(panel)
  expect(expandedPanelStyle).toMatchObject({
    borderTopWidth: "0px",
    boxShadow: "none",
  })
  expectOpaquePanelCorners(expandedPanelStyle)
  const expandedCardStyle = await cardStyle(variableCard)
  expect(expandedCardStyle).toMatchObject({
    borderBottomWidth: "0px",
  })
  expect(
    await media.evaluate((element) =>
      parseFloat(getComputedStyle(element).borderTopLeftRadius)
    )
  ).toBeGreaterThan(0)
  expect(
    await media.evaluate((element) =>
      parseFloat(getComputedStyle(element).borderTopRightRadius)
    )
  ).toBeGreaterThan(0)
  expectMatchingOpaqueBackgrounds(
    expandedCardStyle.backgroundColor,
    expandedPanelStyle.backgroundColor
  )
  await expect.poll(() => hasJoinedBorderColors(variableCard, panel)).toBe(true)
  expectJoinedBorderColors(
    await cardStyle(variableCard),
    await panelStyle(panel)
  )
  expectUnchangedGeometry(
    initialGridGeometry,
    await Promise.all([variableItem, sibling, grid].map(geometry))
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
  const openCardStyle = await cardStyle(variableCard)
  const openPanelStyle = await panelStyle(panel)
  expect(openCardStyle).toMatchObject({
    borderBottomWidth: "0px",
  })
  expect(openCardStyle.scale).toBe("1.12")
  expect(openCardStyle.boxShadow).not.toBe("none")
  expectMatchingOpaqueBackgrounds(
    openCardStyle.backgroundColor,
    openPanelStyle.backgroundColor
  )
  await expect.poll(() => hasJoinedBorderColors(variableCard, panel)).toBe(true)
  expectJoinedBorderColors(
    await cardStyle(variableCard),
    await panelStyle(panel)
  )
  expectUnchangedGeometry(
    initialGridGeometry,
    await Promise.all([variableItem, sibling, grid].map(geometry))
  )

  await page.keyboard.press("Escape")
  await expect(chooseSize).toHaveAttribute("aria-expanded", "false")
})

test("market product variation panel uses an opaque matching light overlay @market", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)

  const variableItem = page.getByTestId("variable-product-list-item")
  const variableCard = variableItem.locator(":scope > div")
  const panel = await variationPanel(variableItem)

  await variableCard.hover()
  await expect(panel).toBeVisible()
  const expandedCardStyle = await cardStyle(variableCard)
  const expandedPanelStyle = await panelStyle(panel)
  expectMatchingOpaqueBackgrounds(
    expandedCardStyle.backgroundColor,
    expandedPanelStyle.backgroundColor
  )
  await expect.poll(() => hasJoinedBorderColors(variableCard, panel)).toBe(true)
  expectJoinedBorderColors(
    await cardStyle(variableCard),
    await panelStyle(panel)
  )
  expectOpaquePanelCorners(expandedPanelStyle)
})

test("market product variation panel joins hydration controls on desktop hover @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)

  const variableItem = page.getByTestId("hydrating-variable-product-list-item")
  const variableCard = variableItem.locator(":scope > div")
  const skeleton = variableItem.getByRole("status", {
    name: "Loading product options",
  })
  const panel = skeleton.locator("xpath=../..")

  await variableCard.scrollIntoViewIfNeeded()
  const cardBox = await geometry(variableCard)
  await page.mouse.move(
    cardBox.x + cardBox.width / 2,
    cardBox.y + cardBox.height / 2
  )

  await expect(skeleton).toBeVisible()
  expect(await cardStyle(variableCard)).toMatchObject({
    borderBottomWidth: "0px",
  })
  expect(await panelStyle(panel)).toMatchObject({
    borderTopWidth: "0px",
    opacity: "1",
    visibility: "visible",
  })
})

test("market product variation panel reveals instantly with reduced motion @market", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)

  const variableItem = page.getByTestId("variable-product-list-item")
  const variableCard = variableItem.locator(":scope > div")
  const chooseSize = variableItem.getByRole("combobox", {
    name: "Choose size",
    includeHidden: true,
  })
  const panel = await variationPanel(variableItem)

  await variableCard.scrollIntoViewIfNeeded()
  const cardBox = await geometry(variableCard)
  await page.mouse.move(
    cardBox.x + cardBox.width / 2,
    cardBox.y + cardBox.height / 2
  )

  await expect(chooseSize).toBeVisible()
  expect(await cardStyle(variableCard)).toMatchObject({
    scale: "1.12",
    transitionProperty: "none",
  })
  expect(await panelStyle(panel)).toMatchObject({
    opacity: "1",
    transitionProperty: "none",
  })
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

  const listbox = page.getByRole("listbox")
  await expect(listbox).toBeVisible()
  await expect(chooseSize).toHaveAttribute("aria-expanded", "true")
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
    expect((await cardStyle(variableCard)).scale).toBe("none")
    await chooseSize.click()
    await expect(page.getByRole("listbox")).toBeVisible()
    expect((await cardStyle(variableCard)).scale).toBe("none")
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
  expect((await cardStyle(variableCard)).scale).toBe("none")
})
