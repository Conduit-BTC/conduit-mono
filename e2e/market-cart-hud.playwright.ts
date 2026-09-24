import { expect, test, type Locator, type Page } from "@playwright/test"
import { nip19 } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import type { CartItem } from "../apps/market/src/lib/cart-model"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

const MERCHANT_SECRETS = Array.from({ length: 10 }, () => generateSecretKey())
const MERCHANTS = MERCHANT_SECRETS.map(getPublicKey)
const MERCHANT_A = MERCHANTS[0]!
const MERCHANT_B = MERCHANTS[1]!

function cartSeed(merchantCount: number) {
  return {
    version: 2,
    items: MERCHANTS.slice(0, merchantCount).map((merchant, index) => ({
      productId: `30402:${merchant}:item-${index}`,
      merchantPubkey: merchant,
      merchantAddedAt: 100 + index,
      title: `Catalog item ${index + 1}`,
      price: 1_200 + index,
      currency: "SATS",
      priceSats: 1_200 + index,
      format: "digital",
      quantity: 1 + (index % 2),
    })),
  }
}

function sameMerchantFulfillmentCartSeed() {
  const organizer = "a".repeat(64)
  const merchant = MERCHANT_A
  const pickup = (input: {
    productEvent: string
    market: string
    option: string
    title: string
    product: string
    location: string
  }) => ({
    type: "pickup",
    organizerPubkey: organizer,
    product: {
      coordinate: `30402:${merchant}:${input.product}`,
      eventId: input.productEvent,
      createdAt: 100,
      merchantPubkey: merchant,
    },
    calendar: {
      coordinate: `31922:${organizer}:event-${input.market}`,
      eventId: "f".repeat(64),
      createdAt: 101,
    },
    collection: {
      coordinate: `30405:${organizer}:market-${input.market}`,
      eventId: "e".repeat(64),
      createdAt: 102,
    },
    option: {
      coordinate: `30406:${organizer}:pickup-${input.option}`,
      eventId: "d".repeat(64),
      createdAt: 103,
      title: input.title,
      location: input.location,
    },
    handoffMode: "organizer_handoff",
    handlerPubkey: organizer,
    costSats: 0,
    sourceCost: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
  })

  return {
    version: 2,
    items: [
      {
        productId: `30402:${merchant}:delivery`,
        merchantPubkey: merchant,
        merchantAddedAt: 100,
        title: "Shipped item",
        price: 1_200,
        currency: "SATS",
        priceSats: 1_200,
        format: "physical",
        fulfillment: { type: "shipping" },
        quantity: 1,
      },
      {
        productId: `30402:${merchant}:pickup-main`,
        merchantPubkey: merchant,
        merchantAddedAt: 101,
        title: "Main entrance item",
        price: 1_200,
        currency: "SATS",
        priceSats: 1_200,
        format: "physical",
        fulfillment: pickup({
          productEvent: "1".repeat(64),
          market: "main",
          option: "main",
          title: "Merchant pickup",
          product: "pickup-main",
          location: "Test location",
        }),
        productEventId: "1".repeat(64),
        quantity: 1,
      },
      {
        productId: `30402:${merchant}:pickup-main`,
        merchantPubkey: merchant,
        merchantAddedAt: 102,
        title: "Main entrance item",
        price: 1_200,
        currency: "SATS",
        priceSats: 1_200,
        format: "physical",
        fulfillment: pickup({
          productEvent: "2".repeat(64),
          market: "main",
          option: "main",
          title: "Merchant pickup",
          product: "pickup-main",
          location: "Test location",
        }),
        productEventId: "2".repeat(64),
        quantity: 1,
      },
    ],
  }
}

async function seedCart(page: Page, merchantCount: number): Promise<void> {
  await page.addInitScript((seed) => {
    localStorage.setItem("conduit:cart", JSON.stringify(seed))
  }, cartSeed(merchantCount))
}

async function replaceCanonicalCart(
  page: Page,
  merchantCount: number
): Promise<void> {
  await page.evaluate((seed) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction("shoppingCarts", "readwrite")
        const store = transaction.objectStore("shoppingCarts")
        const get = store.get("market")
        get.onsuccess = () => {
          const now = Date.now()
          const previousRevision =
            typeof get.result?.revision === "number" ? get.result.revision : 0
          store.put({
            id: "market",
            version: 1,
            revision: previousRevision + 1,
            nextSequence: seed.items.length * 2 + 1,
            lines: seed.items.map((item, index) => ({
              id: `line:${index * 2 + 1}`,
              item,
              batches: [
                { id: `batch:${index * 2 + 2}`, quantity: item.quantity },
              ],
            })),
            migratedAt: now,
            updatedAt: now,
          })
        }
        transaction.oncomplete = () => {
          database.close()
          resolve()
        }
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    })
  }, cartSeed(merchantCount))
}

async function readCanonicalCartProductIds(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction("shoppingCarts", "readonly")
          const get = transaction.objectStore("shoppingCarts").get("market")
          transaction.oncomplete = () => {
            const lines = Array.isArray(get.result?.lines)
              ? get.result.lines
              : []
            resolve(
              lines.map(
                (line: { item: { productId: string } }) => line.item.productId
              )
            )
            database.close()
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
  )
}

async function seedMerchantProfile(
  page: Page,
  profile: { pubkey: string; name: string; lud16?: string; picture?: string },
  includeSignedFrontier = false
): Promise<void> {
  const event = includeSignedFrontier
    ? finalizeEvent(
        {
          kind: 0,
          created_at: Math.floor(Date.now() / 1_000),
          tags: [],
          content: JSON.stringify({
            name: profile.name,
            lud16: profile.lud16,
            picture: profile.picture,
          }),
        },
        MERCHANT_SECRETS[MERCHANTS.indexOf(profile.pubkey)]!
      )
    : undefined
  await page.evaluate(
    ({ row, event }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const transaction = request.result.transaction(
            "profiles",
            "readwrite"
          )
          transaction.objectStore("profiles").put({
            pubkey: row.pubkey,
            name: row.name,
            displayName: row.name,
            ...(row.picture ? { picture: row.picture } : {}),
            ...(row.lud16 ? { lud16: row.lud16 } : {}),
            ...(event
              ? {
                  rawContent: event.content,
                  eventId: event.id,
                  eventCreatedAt: event.created_at,
                }
              : {}),
            cachedAt: Date.now(),
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
    },
    { row: profile, event }
  )
}

async function expectMobilePurchaseTabLayout(tab: Locator): Promise<void> {
  const avatar = tab.getByTestId("purchase-tab-avatar")
  const count = tab.getByTestId("purchase-tab-count")
  await expect(avatar).toBeVisible()
  await expect(count).toBeVisible()
  await expect(tab.getByTestId("purchase-tab-details")).toBeHidden()
  const boxes = await tab.evaluate((element) => {
    const bounds = (testId: string) =>
      element
        .querySelector(`[data-testid='${testId}']`)!
        .getBoundingClientRect()
    const avatar = bounds("purchase-tab-avatar")
    const count = bounds("purchase-tab-count")
    return {
      avatarRight: avatar.right,
      countLeft: count.left,
      verticalOffset: Math.abs(
        (avatar.top + avatar.bottom) / 2 - (count.top + count.bottom) / 2
      ),
      countHeight: count.height,
      countRadius: parseFloat(
        getComputedStyle(
          element.querySelector("[data-testid='purchase-tab-count']")!
        ).borderTopLeftRadius
      ),
    }
  })
  expect(boxes.avatarRight).toBeLessThanOrEqual(boxes.countLeft)
  expect(boxes.verticalOffset).toBeLessThanOrEqual(2)
  expect(boxes.countHeight).toBeGreaterThanOrEqual(20)
  expect(boxes.countRadius).toBeGreaterThanOrEqual(12)
}

async function expectInsideHud(page: Page): Promise<void> {
  // Measure the HUD and its fixed controls in one pass and poll so the
  // slide-in transition cannot race the two measurements.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hud = document.querySelector(
            "section[aria-label='Cart inventory']"
          )
          if (!hud) return "missing-hud"
          const hudBox = hud.getBoundingClientRect()
          const controls = [
            hud.querySelector("button[aria-expanded]"),
            ...Array.from(hud.querySelectorAll("a,button")).filter((el) =>
              /^(Checkout|Zap out)$/.test(el.textContent?.trim() ?? "")
            ),
          ].filter((el): el is Element => el !== null)
          for (const control of controls) {
            const box = control.getBoundingClientRect()
            if (box.width <= 24) return "clipped-width"
            if (
              box.left < hudBox.left - 0.5 ||
              box.right > hudBox.right + 0.5 ||
              box.top < hudBox.top - 0.5 ||
              box.bottom > hudBox.bottom + 0.5
            ) {
              return "outside-hud"
            }
          }
          return "contained"
        }),
      { timeout: 5_000 }
    )
    .toBe("contained")
}

test("market cart HUD keeps every fixed control inside the HUD across merchant-count and width variants @market", async ({
  browser,
}) => {
  test.setTimeout(120_000)
  for (const merchantCount of [1, 2, 6, 10]) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.addInitScript((seed) => {
      localStorage.setItem("conduit:cart", JSON.stringify(seed))
    }, cartSeed(merchantCount))
    await page.goto(`${marketUrl}/products`)
    if (merchantCount === 6) {
      // Long merchant names must truncate inside the rail, not push the CTA.
      await seedMerchantProfile(page, {
        pubkey: MERCHANT_A,
        name: "The Extraordinarily Long Merchant Name Emporium And Sundries",
      })
      await page.reload()
    }
    const hud = page.getByRole("region", { name: "Cart inventory" })
    await expect(hud).toBeVisible()

    for (const width of [390, 896, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(hud).toBeVisible()
      await expectInsideHud(page)

      if (merchantCount > 1) {
        const rail = hud.getByRole("group", { name: "Cart purchases" })
        await expect(rail.getByRole("button")).toHaveCount(merchantCount)
        await expect(rail.getByRole("button").first()).toHaveAccessibleName(
          /Digital delivery/
        )
        if (width === 390) {
          const firstTab = rail.getByRole("button").first()
          await expectMobilePurchaseTabLayout(firstTab)
          await expect(firstTab.getByTestId("purchase-tab-count")).toHaveText(
            /^[12]$/
          )
          await expect(
            firstTab.getByText("Digital", { exact: true })
          ).toBeHidden()
          if (merchantCount === 6) {
            const fifthTab = rail.getByRole("button").nth(4)
            await rail.evaluate((element) => {
              element.scrollLeft = 0
            })
            await fifthTab.evaluate((element) => element.click())
            await expect
              .poll(() => rail.evaluate((element) => element.scrollLeft))
              .toBeGreaterThan(0)
            await expect
              .poll(async () => {
                const railBounds = await rail.boundingBox()
                const tabBounds = await fifthTab.boundingBox()
                return Math.abs(
                  railBounds!.x +
                    railBounds!.width / 2 -
                    (tabBounds!.x + tabBounds!.width / 2)
                )
              })
              .toBeLessThan(3)
            await firstTab.evaluate((element) => element.click())
            await expect
              .poll(() => rail.evaluate((element) => element.scrollLeft))
              .toBe(0)
          }
        }
        const railBox = await rail.evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }))
        expect(railBox.scrollWidth).toBeGreaterThanOrEqual(railBox.clientWidth)
      }

      const overflow = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }))
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)

      // The expanded panel's CTA must also stay contained.
      const toggle = hud.locator("button[aria-expanded]")
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click()
      }
      const expandedCta = hud
        .locator("a,button")
        .filter({ hasText: /^(Continue to checkout|Continue to Zap Out)$/ })
        .first()
      await expect(expandedCta).toBeVisible()
      const hudBox = await hud.boundingBox()
      const ctaBox = await expandedCta.boundingBox()
      expect(ctaBox!.x + ctaBox!.width).toBeLessThanOrEqual(
        hudBox!.x + hudBox!.width + 0.5
      )
    }
    await context.close()
  }
})

test("market cart HUD is route-aware and layered above the fixed footer @market", async ({
  page,
}) => {
  await seedCart(page, 2)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${marketUrl}/products`)
  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).toBeVisible()

  const rail = hud.getByRole("group", { name: "Cart purchases" })
  expect(
    await rail.evaluate((element) =>
      getComputedStyle(element).maskImage.toString()
    )
  ).toContain("linear-gradient")
  const selectedCart = rail.locator("button[aria-pressed='true']")
  await expect(selectedCart).toHaveCount(1)
  await expect(hud.getByRole("region", { name: "Cart products" })).toBeVisible()

  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--market-hud-height"
      )
    )
  ).toMatch(/^[1-9]\d*px$/)

  const legalFooter = page.locator("footer").filter({
    has: page.getByRole("navigation", { name: "Legal links" }),
  })
  const footerLayout = await legalFooter.evaluate((footer) => ({
    height: Math.ceil(footer.getBoundingClientRect().height),
    offset: getComputedStyle(document.documentElement).getPropertyValue(
      "--market-fixed-footer-height"
    ),
    position: getComputedStyle(footer).position,
  }))
  expect(footerLayout.position).toBe("fixed")
  expect(footerLayout.offset).toBe(`${footerLayout.height}px`)
  // Measured together and polled: the dock slides in, so two separate reads
  // can capture the HUD mid transition.
  await expect
    .poll(async () =>
      hud.evaluate((element) => {
        const footer = document.querySelector("footer")
        const hudRect = element.getBoundingClientRect()
        const footerRect = footer!.getBoundingClientRect()
        return Math.round(hudRect.bottom - footerRect.top)
      })
    )
    .toBeLessThanOrEqual(0)

  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByRole("region", { name: "Cart inventory" })
  ).toHaveCount(0)
})

test("market cart HUD rail activation expands a collapsed HUD for pointer and keyboard @market", async ({
  page,
}) => {
  await seedCart(page, 2)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${marketUrl}/products`)
  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).toBeVisible()
  const toggle = hud.locator("button[aria-expanded]")
  const rail = hud.getByRole("group", { name: "Cart purchases" })
  const merchantButtons = rail.getByRole("button")
  const panelId = await toggle.getAttribute("aria-controls")
  const panel = hud.locator(`[id="${panelId}"]`)

  // Bottom dock arrow points at the resulting motion: expanded shows down
  // (no rotation), collapsed shows up (rotated).
  const chevronRotation = () =>
    toggle.locator("svg").evaluate((el) => {
      const style = getComputedStyle(el)
      return style.rotate !== "none" && style.rotate !== ""
        ? style.rotate
        : style.transform
    })
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  expect(await chevronRotation()).toBe("none")

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(panel).toHaveAttribute("aria-hidden", "true")
  await expect.poll(chevronRotation).not.toBe("none")

  // Pointer activation of an inactive merchant selects and expands it.
  const inactive = rail.locator("button[aria-pressed='false']").first()
  const inactiveLabel = await inactive.textContent()
  await inactive.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(panel).not.toHaveAttribute("aria-hidden", "true")
  const productRail = hud.getByRole("region", { name: "Cart products" })
  await expect(productRail).toBeVisible()
  expect(inactiveLabel).toBeTruthy()

  // Activating the already-selected merchant while collapsed also expands.
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await rail.locator("button[aria-pressed='true']").click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")

  // Keyboard: Enter and Space on a merchant button expand a collapsed HUD.
  await toggle.click()
  await merchantButtons.first().focus()
  await page.keyboard.press("Enter")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await toggle.click()
  await merchantButtons.first().focus()
  await page.keyboard.press(" ")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
})

test("market cart HUD distinguishes same-merchant delivery and pickup purchases @market", async ({
  page,
}) => {
  const picture = "https://cdn.conduit.market/test/cart-hud-avatar.svg"
  await page.route(picture, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="#8b5cf6"/></svg>',
    })
  )
  await page.addInitScript((seed) => {
    localStorage.setItem("conduit:cart", JSON.stringify(seed))
  }, sameMerchantFulfillmentCartSeed())
  await page.goto(`${marketUrl}/products`)
  await seedMerchantProfile(page, {
    pubkey: MERCHANT_A,
    name: "Fixture Market",
    picture,
  })
  await page.reload()

  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).toBeVisible()
  const rail = hud.getByRole("group", { name: "Cart purchases" })
  const selectors = rail.getByRole("button")
  await expect(selectors).toHaveCount(3)
  await expect(selectors.nth(0)).toHaveAccessibleName(/Fixture Market/)
  await expect(selectors.nth(1)).toHaveAccessibleName(/Fixture Market/)
  await expect(selectors.nth(2)).toHaveAccessibleName(/Fixture Market/)

  const names = await selectors.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label") ?? "")
  )
  expect(names.every((name) => name.includes("Fixture Market"))).toBe(true)
  expect(names.every((name) => name.includes("1 cart item"))).toBe(true)
  expect(names[0]).toContain("Delivery")
  expect(names[1]).toContain("Event pickup - Test location")
  expect(names[2]).toContain("Event pickup - Test location")
  expect(new Set(names).size).toBe(3)
  await page.setViewportSize({ width: 896, height: 900 })
  await expect(
    selectors.nth(0).getByText("Delivery", { exact: true })
  ).toBeVisible()
  for (const selector of [selectors.nth(1), selectors.nth(2)]) {
    await expect(selector.getByTestId("purchase-tab-details")).toBeVisible()
    await expect(selector.getByText("Pickup", { exact: true })).toBeVisible()
    await expect(selector).not.toContainText("Test location")
    await expect(selector.getByTestId("purchase-tab-count")).toHaveText("1")
  }

  await page.setViewportSize({ width: 390, height: 900 })
  for (const selector of await selectors.all()) {
    await expectMobilePurchaseTabLayout(selector)
    await expect(selector.getByTestId("purchase-tab-count")).toHaveText("1")
    await expect(
      selector.getByTestId("purchase-tab-avatar").locator("img")
    ).toBeVisible()
  }
  const pickupGroups = await page.evaluate(async (seed) => {
    const { groupCartPurchases } = await import("/src/lib/cart-model.ts")
    return groupCartPurchases(seed.items as CartItem[])
      .slice(1)
      .map((group) => ({ id: group.id }))
  }, sameMerchantFulfillmentCartSeed())
  await expectInsideHud(page)

  const toggle = hud.locator("button[aria-expanded]")
  for (const [index, purchaseGroup] of pickupGroups.entries()) {
    const selector = selectors.nth(index + 1)
    await selector.evaluate((element) => {
      element.scrollIntoView({ block: "nearest", inline: "center" })
    })
    if ((await toggle.getAttribute("aria-expanded")) === "true") {
      await toggle.click()
    }
    await selector.click()
    await expect(selector).toHaveAttribute("aria-pressed", "true")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    const checkoutLink = hud.getByRole("link", { name: "Continue to checkout" })
    await expect(checkoutLink).toBeVisible()
    const checkoutUrl = new URL(
      await checkoutLink.getAttribute("href")!,
      marketUrl
    )
    expect(JSON.parse(checkoutUrl.searchParams.get("purchase") ?? "null")).toBe(
      purchaseGroup.id
    )
    expect(checkoutUrl.searchParams.get("merchant")).toBe(
      nip19.npubEncode(MERCHANT_A)
    )
    await checkoutLink.click()
    await expect(page).toHaveURL(/\/checkout\?/)
    expect(
      JSON.parse(new URL(page.url()).searchParams.get("purchase") ?? "null")
    ).toBe(purchaseGroup.id)
    expect(new URL(page.url()).searchParams.get("merchant")).toBe(MERCHANT_A)
    await page.goto(`${marketUrl}/products`)
    await expect(hud).toBeVisible()
  }
  const keyboardTarget = selectors.nth(1)
  await keyboardTarget.focus()
  await page.keyboard.press("Enter")
  await expect(keyboardTarget).toHaveAttribute("aria-pressed", "true")
  const keyboardCheckout = new URL(
    await hud
      .getByRole("link", { name: "Continue to checkout" })
      .getAttribute("href")!,
    marketUrl
  )
  expect(
    JSON.parse(keyboardCheckout.searchParams.get("purchase") ?? "null")
  ).toBe(pickupGroups[0]!.id)
  expect(keyboardCheckout.searchParams.get("merchant")).toBe(
    nip19.npubEncode(MERCHANT_A)
  )
  await expectInsideHud(page)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hud = document.querySelector(
          "section[aria-label='Cart inventory']"
        )
        const context = hud?.querySelector(
          "[data-testid='selected-purchase-context']"
        )
        if (!hud || !context) return "missing"
        const label = context.querySelector("span > span:last-child")
        if (!label) return "missing-label"
        const hudBox = hud.getBoundingClientRect()
        const contextBox = context.getBoundingClientRect()
        if (document.documentElement.scrollWidth > window.innerWidth) {
          return "page-overflow"
        }
        if (getComputedStyle(label).textOverflow === "ellipsis") {
          return "truncated-label"
        }
        return contextBox.left >= hudBox.left - 0.5 &&
          contextBox.right <= hudBox.right + 0.5
          ? "contained"
          : "context-overflow"
      })
    )
    .toBe("contained")
})

test("all carts keep each purchase card and action contained on mobile @market", async ({
  page,
}) => {
  await page.addInitScript((seed) => {
    localStorage.setItem("conduit:cart", JSON.stringify(seed))
  }, sameMerchantFulfillmentCartSeed())
  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByText("Conflicting fulfillment was separated")
  ).toBeVisible()
  await expect(
    page.getByText(/Shipping and each exact event pickup/)
  ).toHaveCount(0)
  const clearActions = page.getByRole("button", {
    name: /^Clear .* purchase, reference /,
  })
  await expect(clearActions).toHaveCount(3)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width)
    for (let index = 0; index < 3; index += 1) {
      const card = clearActions.nth(index).locator("xpath=ancestor::section[1]")
      const cardBounds = await card.boundingBox()
      const clearBounds = await clearActions.nth(index).boundingBox()
      expect(cardBounds).not.toBeNull()
      expect(clearBounds).not.toBeNull()
      expect(clearBounds!.x).toBeGreaterThanOrEqual(cardBounds!.x)
      expect(clearBounds!.x + clearBounds!.width).toBeLessThanOrEqual(
        cardBounds!.x + cardBounds!.width
      )
      await expect(
        card.getByRole("button", { name: "Order", exact: true })
      ).toBeVisible()
      await expect(
        card.getByRole("button", { name: /Review 1 item/ })
      ).toBeVisible()
    }
  }
})

test("market cart HUD shows one purchase's details when its compact tab is opened @market", async ({
  page,
}) => {
  const seed = sameMerchantFulfillmentCartSeed()
  seed.items = [seed.items[1]!]
  await page.addInitScript((cart) => {
    localStorage.setItem("conduit:cart", JSON.stringify(cart))
  }, seed)
  await page.goto(`${marketUrl}/products`)
  await seedMerchantProfile(page, {
    pubkey: MERCHANT_A,
    name: "Fixture Market",
  })
  await page.reload()

  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).toBeVisible()
  const rail = hud.getByRole("group", { name: "Cart purchases" })
  await expect(rail.getByRole("button")).toHaveCount(1)
  const purchaseTab = rail.getByRole("button", {
    name: /Fixture Market, 1 cart item, Event pickup - Test location/,
  })
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expectMobilePurchaseTabLayout(purchaseTab)
    const railBounds = await rail.boundingBox()
    const tabBounds = await purchaseTab.boundingBox()
    expect(tabBounds!.width).toBeLessThan(96)
    expect(railBounds!.width - tabBounds!.width).toBeGreaterThan(20)
  }
  await expect(purchaseTab.getByTestId("purchase-tab-count")).toHaveText("1")
  await expect(purchaseTab.getByText("Fixture Market")).toBeHidden()
  await expect(purchaseTab.getByText("Test location")).toBeHidden()
  const toggle = hud.locator("button[aria-expanded]")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await purchaseTab.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(hud.getByTestId("selected-purchase-context")).toContainText(
    "Test location"
  )
  await expect(
    hud.getByRole("link", { name: "Open Fixture Market merchant page" })
  ).toBeVisible()
  await expectInsideHud(page)
})

test("market cart HUD collapse restores focus from the panel to the disclosure toggle @market", async ({
  page,
}) => {
  await seedCart(page, 2)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${marketUrl}/products`)
  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).toBeVisible()
  const toggle = hud.locator("button[aria-expanded]")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")

  const quantityButton = hud
    .getByRole("button", { name: /Decrease .* quantity/ })
    .first()
  await quantityButton.focus()
  await page.keyboard.press("Escape")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(toggle).toBeFocused()
})

test("market cart HUD restore is quiet while a real first increase announces and expands @market", async ({
  context,
  page,
}) => {
  await seedCart(page, 1)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${marketUrl}/products`)
  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).toBeVisible()
  const liveRegion = hud.locator("[aria-live='polite']")
  await expect(liveRegion).toHaveText("")

  const toggle = hud.locator("button[aria-expanded]")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")

  // A real cart mutation from another same-origin tab is announced.
  const otherTab = await context.newPage()
  await otherTab.goto(`${marketUrl}/cart`)
  await otherTab
    .getByRole("button", { name: "Increase quantity for Catalog item 1" })
    .click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(liveRegion).toContainText("Cart updated")
})

test("market cart presence starts one shared merchant-scoped LNURL preflight without payment data @market", async ({
  page,
}) => {
  const lnurlRequests: Array<{
    url: string
    method: string
    body: string | null
  }> = []
  await page.route("https://merchant-fixture.dev/**", async (route) => {
    const request = route.request()
    lnurlRequests.push({
      url: request.url(),
      method: request.method(),
      body: request.postData(),
    })
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tag: "payRequest",
        callback: "https://merchant-fixture.dev/callback",
        minSendable: 1_000,
        maxSendable: 100_000_000_000,
        allowsNostr: true,
        nostrPubkey: "f".repeat(64),
        metadata: JSON.stringify([["text/plain", "pay"]]),
      }),
    })
  })

  // Plain product visits without a cart create no LNURL requests.
  await page.goto(`${marketUrl}/products`)
  await page.waitForTimeout(1_000)
  expect(lnurlRequests.length).toBe(0)

  // Restoring a cart for the merchant starts the preflight once the profile
  // resolves the Lightning address.
  await replaceCanonicalCart(page, 2)
  await page.reload()
  await expect(
    page.getByRole("region", { name: "Cart inventory" })
  ).toBeVisible()
  await seedMerchantProfile(page, {
    pubkey: MERCHANT_B,
    name: "Lamp Merchant",
    lud16: "payments@merchant-fixture.dev",
  })
  await page.goto(`${marketUrl}/products`)
  await expect(
    page.getByRole("region", { name: "Cart inventory" })
  ).toBeVisible()
  // Display-only cache fields cannot authorize provider preflight.
  await page.waitForTimeout(1_000)
  expect(lnurlRequests).toHaveLength(0)
  await seedMerchantProfile(
    page,
    {
      pubkey: MERCHANT_B,
      name: "Lamp Merchant",
      lud16: "payments@merchant-fixture.dev",
    },
    true
  )
  await page.goto(`${marketUrl}/products`)
  await expect
    .poll(() => lnurlRequests.length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)

  // The preflight is a bare capability GET: no cart contents, buyer
  // identity, invoice, or payment data leave the app, and the invoice
  // callback is never contacted without explicit payment intent.
  for (const request of lnurlRequests) {
    expect(
      request.method === "GET" &&
        request.body === null &&
        request.url ===
          "https://merchant-fixture.dev/.well-known/lnurlp/payments"
    ).toBe(true)
  }

  // Route handoff inside the lease reuses the same result: an in-app
  // navigation to the cart starts no additional metadata request.
  const requestsBeforeNavigation = lnurlRequests.length
  const hud = page.getByRole("region", { name: "Cart inventory" })
  const toggle = hud.locator("button[aria-expanded]")
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click()
  }
  await hud.getByRole("link", { name: "View full cart" }).click()
  await expect(page).toHaveURL(/\/cart/)
  await expect(page.getByText("Lamp Merchant").first()).toBeVisible()
  await page.waitForTimeout(1_500)
  expect(lnurlRequests.length).toBe(requestsBeforeNavigation)
})

test("market cart HUD isolates a failed merchant-scoped LNURL endpoint and stays interactive @market", async ({
  page,
}) => {
  await page.route("https://merchant-fixture.dev/**", (route) => route.abort())
  await seedCart(page, 2)
  await page.goto(`${marketUrl}/products`)
  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).toBeVisible()
  await seedMerchantProfile(page, {
    pubkey: MERCHANT_B,
    name: "Lamp Merchant",
    lud16: "payments@merchant-fixture.dev",
  })
  await page.goto(`${marketUrl}/products`)
  await expect(hud).toBeVisible()
  // The HUD stays interactive and the ordinary checkout path stays available.
  await expect(
    hud
      .locator("a,button")
      .filter({ hasText: /checkout/i })
      .first()
  ).toBeVisible()
})

test("market cart HUD keeps totals out of the merchant selector @market", async ({
  page,
}) => {
  await page.addInitScript(
    ({ merchant }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 2,
          items: [
            {
              productId: "priced",
              merchantPubkey: merchant,
              title: "Priced item",
              price: 1_200,
              priceSats: 1_200,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
            {
              productId: "unpriced",
              merchantPubkey: merchant,
              title: "Unpriced item",
              price: 10,
              currency: "UNSUPPORTED",
              format: "digital",
              quantity: 1,
            },
          ],
        })
      )
    },
    { merchant: MERCHANT_A }
  )
  await page.goto(`${marketUrl}/products`)
  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).not.toContainText("Total unavailable")
  await expect(hud).not.toContainText("1,200 sats")
  await expect
    .poll(() => readCanonicalCartProductIds(page))
    .toEqual([`30402:${MERCHANT_A}:priced`, `30402:${MERCHANT_A}:unpriced`])
})
