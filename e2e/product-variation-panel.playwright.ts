import { expect, test, type Locator, type Page } from "@playwright/test"
import { resolve } from "node:path"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const harnessUrl = "/src/test-fixtures/product-variation-panel-harness.tsx"
const selectedVariationId = `30402:${"a".repeat(64)}:conduit-shirt-m`

type Geometry = { x: number; y: number; width: number; height: number }
type PanelStyle = {
  backgroundColor: string
  borderBottomLeftRadius: string
  borderBottomRightRadius: string
  borderBottomColor: string
  borderBottomWidth: string
  borderLeftColor: string
  borderLeftWidth: string
  borderRightColor: string
  borderRightWidth: string
  borderTopWidth: string
  boxShadow: string
  opacity: string
  pointerEvents: string
  position: string
  visibility: string
  transitionProperty: string
}

async function mountHarness(page: Page): Promise<void> {
  await page.route("https://cdn.conduit.market/variation-*.jpg", (route) =>
    route.fulfill({
      path: resolve("apps/market/public/images/placeholders/landscape.jpg"),
      contentType: "image/jpeg",
    })
  )
  await page.goto(`${marketUrl}/products`)
  await page.evaluate(async (fixtureUrl) => {
    const container = document.createElement("div")
    container.id = "product-variation-panel-harness"
    container.style.position = "relative"
    container.style.zIndex = "100"
    container.style.padding = "clamp(1rem, 3vw, 3rem)"
    container.style.paddingBottom = "10rem"
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
      borderBottomWidth: style.borderBottomWidth,
      borderLeftColor: style.borderLeftColor,
      borderLeftWidth: style.borderLeftWidth,
      borderRightColor: style.borderRightColor,
      borderRightWidth: style.borderRightWidth,
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
  borderLeftWidth: string
  borderRightColor: string
  borderTopColor: string
  borderTopLeftRadius: string
  borderTopRightRadius: string
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
      borderLeftWidth: style.borderLeftWidth,
      borderRightColor: style.borderRightColor,
      borderTopColor: style.borderTopColor,
      borderTopLeftRadius: style.borderTopLeftRadius,
      borderTopRightRadius: style.borderTopRightRadius,
      boxShadow: style.boxShadow,
      scale: style.scale,
      transitionProperty: style.transitionProperty,
    }
  })
}

async function resolvedThemeColor(
  page: Page,
  customProperty: string
): Promise<string> {
  return page.evaluate((property) => {
    const probe = document.createElement("span")
    probe.style.color = `var(${property})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, customProperty)
}

async function expectPrimaryCardHighlight(
  page: Page,
  card: Locator
): Promise<void> {
  const [style, primaryColor] = await Promise.all([
    cardStyle(card),
    resolvedThemeColor(page, "--primary-500"),
  ])
  expect(style).toMatchObject({
    borderLeftColor: primaryColor,
    borderRightColor: primaryColor,
    borderTopColor: primaryColor,
  })
  expect(style.boxShadow).toContain(primaryColor)
  expect(parseFloat(style.borderTopLeftRadius)).toBeGreaterThan(0)
  expect(parseFloat(style.borderTopRightRadius)).toBeGreaterThan(0)
}

async function expectNeutralCardBorder(
  page: Page,
  card: Locator
): Promise<void> {
  const [style, borderColor, primaryColor] = await Promise.all([
    cardStyle(card),
    resolvedThemeColor(page, "--border"),
    resolvedThemeColor(page, "--primary-500"),
  ])
  expect(style).toMatchObject({
    borderLeftColor: borderColor,
    borderRightColor: borderColor,
    borderTopColor: borderColor,
  })
  expect(style.boxShadow).not.toContain(primaryColor)
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
  const image = media.locator("img")
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((element) => element.naturalWidth))
    .toBeGreaterThan(0)
  const notice = sibling.locator('[data-slot="product-notice"]')
  await expect(notice).toContainText(
    "Checking current signed event pickup evidence"
  )
  const [noticeBox, siblingBox] = await Promise.all([
    geometry(notice),
    geometry(sibling),
  ])
  expect(noticeBox.y).toBeGreaterThan(siblingBox.y)
  expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(
    siblingBox.y + siblingBox.height
  )
  const merchantName = sibling.getByRole("button", {
    name: "Peter No Taxation Without Representation Ruszkie Bitcorners",
  })
  await expect(merchantName).toBeVisible()
  await expect
    .poll(() =>
      merchantName.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          contained: element.scrollWidth > element.clientWidth,
          overflow: style.overflow,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
        }
      })
    )
    .toEqual({
      contained: true,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    })
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
  const initialCardStyle = await cardStyle(variableCard)
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
  expect(expandedCardGeometry.width).toBe(initialCardGeometry.width)
  expect(expandedCardGeometry.height).toBe(initialCardGeometry.height)
  const expandedPanelGeometry = await geometry(panel)
  expect(expandedPanelGeometry.x).toBeCloseTo(expandedCardGeometry.x - 1, 5)
  expect(expandedPanelGeometry.width).toBeCloseTo(
    expandedCardGeometry.width + 2,
    5
  )
  const expandedPanelStyle = await panelStyle(panel)
  expect(expandedPanelStyle).toMatchObject({
    borderBottomWidth: "2px",
    borderLeftWidth: "2px",
    borderRightWidth: "2px",
    borderTopWidth: "0px",
    boxShadow: "none",
  })
  expectOpaquePanelCorners(expandedPanelStyle)
  const expandedCardStyle = await cardStyle(variableCard)
  expect(expandedCardStyle).toMatchObject({
    borderBottomWidth: "0px",
    borderLeftWidth: "1px",
    scale: "none",
  })
  expect(expandedCardStyle.backgroundColor).toBe(
    initialCardStyle.backgroundColor
  )
  await expectPrimaryCardHighlight(page, variableCard)
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
  await expect.poll(() => hasJoinedBorderColors(variableCard, panel)).toBe(true)
  expectUnchangedGeometry(
    initialGridGeometry,
    await Promise.all([variableItem, sibling, grid].map(geometry))
  )

  await page.locator("#product-variation-panel-harness").screenshot({
    path: test.info().outputPath("variation-dark.png"),
  })

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
  expect(openCardStyle.scale).toBe("none")
  expect(openCardStyle.boxShadow).not.toBe("none")
  expect(openCardStyle.backgroundColor).toBe(initialCardStyle.backgroundColor)
  expectOpaquePanelCorners(openPanelStyle)
  await expect.poll(() => hasJoinedBorderColors(variableCard, panel)).toBe(true)
  expectUnchangedGeometry(
    initialGridGeometry,
    await Promise.all([variableItem, sibling, grid].map(geometry))
  )

  await page.getByRole("option", { name: "M" }).press("Enter")
  await expect(chooseSize).toHaveAttribute("aria-expanded", "false")
  await expect(chooseSize).toContainText("M")
  await expect(
    variableItem.getByText("40,000 sats", { exact: true })
  ).toBeVisible()
  await expect(variableItem.getByText(/From /)).not.toBeAttached()
  await expect(
    variableItem.getByRole("img", { name: "Conduit Shirt M" })
  ).toHaveAttribute("src", "https://cdn.conduit.market/variation-m.jpg")

  await variableItem.getByRole("button", { name: "Add" }).click()
  await expect(
    variableItem.getByRole("button", { name: "In cart (1)" })
  ).toBeDisabled()
  await variableItem.hover()
  await expect(
    variableItem.getByRole("button", {
      name: "Stock limit reached for Conduit Shirt",
    })
  ).toBeDisabled()
  await expect
    .poll(() =>
      page
        .locator("#product-variation-panel-harness")
        .evaluate((element) =>
          JSON.parse(element.dataset.addedProduct ?? "null")
        )
    )
    .toEqual({
      id: selectedVariationId,
      title: "Conduit Shirt M",
      price: 40_000,
      currency: "SATS",
      stock: 1,
      image: "https://cdn.conduit.market/variation-m.jpg",
      specifications: [{ key: "size", value: "M" }],
    })
})

test("market ready zero-axis families do not render an empty variation panel or remove a card seam @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)

  const item = page.getByTestId("zero-axis-variable-product-list-item")
  const card = item.locator(":scope > div")
  await card.hover()

  await expect(item.getByRole("combobox")).not.toBeAttached()
  await expect(
    item.locator('[data-slot="product-variation-selector"]')
  ).not.toBeAttached()
  await expect(
    item.getByRole("status", { name: "Loading product options" })
  ).not.toBeAttached()
  await expect
    .poll(() =>
      card.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          borderTopWidth: style.borderTopWidth,
          borderBottomWidth: style.borderBottomWidth,
        }
      })
    )
    .toEqual({ borderTopWidth: "1px", borderBottomWidth: "1px" })
})

test("market product variation panel opens above the card when the page ends below it @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)

  const variableItem = page.getByTestId("variable-product-list-item")
  const variableCard = variableItem.locator(":scope > div")
  const media = variableCard.locator(":scope > div:first-child")
  const chooseSize = variableItem.getByRole("combobox", {
    name: "Choose size",
    includeHidden: true,
  })
  const panel = await variationPanel(variableItem)

  await page.evaluate(() => {
    const container = document.getElementById("product-variation-panel-harness")
    if (container) container.style.paddingBottom = "0px"
  })
  const viewportHeight = page.viewportSize()?.height ?? 0
  // The catalog above the harness keeps loading; retry until the page end
  // settles with the card resting against the bottom of the viewport.
  await expect
    .poll(async () => {
      await page.evaluate(() =>
        window.scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: "instant",
        })
      )
      const restingCard = await geometry(variableCard)
      return restingCard.y + restingCard.height
    })
    .toBeGreaterThan(viewportHeight - 40)

  await variableCard.hover()
  await expect(chooseSize).toBeVisible()
  await expect
    .poll(() => panelStyle(panel))
    .toMatchObject({ opacity: "1", position: "absolute" })

  const [cardBox, panelBox] = await Promise.all([
    geometry(variableCard),
    geometry(panel),
  ])
  expect(
    Math.abs(panelBox.y + panelBox.height - cardBox.y)
  ).toBeLessThanOrEqual(1)
  expect(panelBox.y).toBeGreaterThanOrEqual(0)

  const openedAbovePanel = await panelStyle(panel)
  expect(openedAbovePanel.borderBottomLeftRadius).toBe("0px")
  expect(parseFloat(openedAbovePanel.borderTopWidth)).toBeGreaterThan(0)
  expect(
    await panel.evaluate((element) =>
      parseFloat(getComputedStyle(element).borderTopLeftRadius)
    )
  ).toBeGreaterThan(0)
  expect(
    await variableCard.evaluate(
      (element) => getComputedStyle(element).borderTopWidth
    )
  ).toBe("0px")
  expect(
    await media.evaluate(
      (element) => getComputedStyle(element).borderTopLeftRadius
    )
  ).toBe("0px")

  await chooseSize.click()
  await expect(page.getByRole("option", { name: "M" })).toBeVisible()
  await page.mouse.move(0, 0)
  const panelWhileOpen = await geometry(panel)
  expect(
    Math.abs(panelWhileOpen.y + panelWhileOpen.height - cardBox.y)
  ).toBeLessThanOrEqual(1)
  await page.keyboard.press("Escape")
})

test("market product variation panel uses an opaque light overlay @market", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)

  const variableItem = page.getByTestId("variable-product-list-item")
  const variableCard = variableItem.locator(":scope > div")
  const panel = await variationPanel(variableItem)
  const initialCardStyle = await cardStyle(variableCard)

  await variableCard.hover()
  await expect(panel).toBeVisible()
  const expandedCardStyle = await cardStyle(variableCard)
  const expandedPanelStyle = await panelStyle(panel)
  expect(expandedCardStyle.backgroundColor).toBe(
    initialCardStyle.backgroundColor
  )
  await expect.poll(() => hasJoinedBorderColors(variableCard, panel)).toBe(true)
  expectOpaquePanelCorners(expandedPanelStyle)
  await page.locator("#product-variation-panel-harness").screenshot({
    path: test.info().outputPath("variation-light.png"),
  })
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

  await variableCard.evaluate((element) =>
    element.scrollIntoView({ block: "center", behavior: "instant" })
  )
  const cardBox = await geometry(variableCard)
  await page.mouse.move(
    cardBox.x + cardBox.width / 2,
    cardBox.y + cardBox.height / 2
  )

  await expect(skeleton).toBeVisible()
  expect(await panelStyle(panel)).toMatchObject({
    opacity: "1",
    visibility: "visible",
  })
  // The three-row skeleton is the tallest panel, so it may open on either
  // side; the seam facing the card must be open on both boxes.
  const seam = await panel.evaluate((element) => {
    const card = element.parentElement?.parentElement as HTMLElement
    const panelStyles = getComputedStyle(element)
    const cardStyles = getComputedStyle(card)
    const opensAbove =
      element.getBoundingClientRect().bottom <=
      card.getBoundingClientRect().top + 1
    return opensAbove
      ? {
          panelSeam: panelStyles.borderBottomWidth,
          cardSeam: cardStyles.borderTopWidth,
        }
      : {
          panelSeam: panelStyles.borderTopWidth,
          cardSeam: cardStyles.borderBottomWidth,
        }
  })
  expect(seam).toEqual({ panelSeam: "0px", cardSeam: "0px" })
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
    scale: "none",
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
    await expectNeutralCardBorder(page, variableCard)
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
  await page.emulateMedia({ colorScheme: "dark" })
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
  await expectNeutralCardBorder(page, variableCard)
  expect((await cardStyle(variableCard)).scale).toBe("none")
  await page.locator("#product-variation-panel-harness").screenshot({
    path: test.info().outputPath("variation-mobile.png"),
  })
})

test("market variation panel clears an open portal when family availability changes @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)
  const item = page.getByTestId("variable-product-list-item")
  const card = item.locator(":scope > div")
  await card.hover()
  await item.getByRole("combobox", { name: "Choose size" }).click()
  await expect(page.getByRole("listbox")).toBeVisible()
  await page.mouse.move(1430, 880)
  await expect.poll(() => cardStyle(card)).toMatchObject({ scale: "none" })
  await page
    .getByRole("button", {
      name: "Toggle variation availability",
      includeHidden: true,
    })
    .evaluate((button) => button.click())
  await expect(page.getByRole("listbox")).not.toBeAttached()
  await expect.poll(() => cardStyle(card)).toMatchObject({ scale: "none" })
})

test("market integrated pickup provenance keeps keyboard actions inside the notice @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mountHarness(page)
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.variationCopiedText = text
        },
      },
    })
  })
  const harness = page.locator("#product-variation-panel-harness")
  const notice = page
    .getByTestId("simple-product-sibling")
    .locator('[data-slot="product-notice"]')
  await expect(notice).toContainText("Fixture pickup handler")
  const copy = notice.getByRole("button")
  await expect(copy).toHaveAccessibleName("Copy pickup handler npub")
  await copy.focus()
  await expect(copy).toBeFocused()
  await copy.press("Enter")
  await expect(copy).toHaveAccessibleName("Copied")
  expect(
    await harness.evaluate(
      (element) => element.dataset.productActivations ?? "0"
    )
  ).toBe("0")
  const profileLink = notice.getByRole("link")
  await expect(profileLink).toHaveAttribute("href", /\/u\/npub1/)
  expect(
    await page.evaluate(
      () => document.documentElement.dataset.variationCopiedText
    )
  ).toBe((await profileLink.getAttribute("href"))!.split("/").at(-1))
  await profileLink.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("fixture-profile-page")).toBeVisible()
  expect(
    await harness.evaluate(
      (element) => element.dataset.productActivations ?? "0"
    )
  ).toBe("0")
})
