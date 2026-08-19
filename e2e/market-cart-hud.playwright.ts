import { expect, test, type Page } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

const MERCHANTS = Array.from({ length: 10 }, (_, index) =>
  String(index + 1)
    .repeat(64)
    .slice(0, 64)
)
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

async function seedCart(page: Page, merchantCount: number): Promise<void> {
  await page.addInitScript((seed) => {
    localStorage.setItem("conduit:cart", JSON.stringify(seed))
  }, cartSeed(merchantCount))
}

async function seedMerchantProfile(
  page: Page,
  profile: { pubkey: string; name: string; lud16?: string }
): Promise<void> {
  await page.evaluate((row) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const transaction = request.result.transaction("profiles", "readwrite")
        transaction.objectStore("profiles").put({
          pubkey: row.pubkey,
          name: row.name,
          displayName: row.name,
          ...(row.lud16 ? { lud16: row.lud16 } : {}),
          cachedAt: Date.now(),
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    })
  }, profile)
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

test("market cart HUD keeps every fixed control inside the HUD across merchant-count and width variants", async ({
  page,
}) => {
  test.setTimeout(120_000)
  for (const merchantCount of [1, 2, 6, 10]) {
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
        const rail = hud.getByRole("group", { name: "Store carts" })
        await expect(rail.getByRole("button")).toHaveCount(merchantCount)
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
      expect(overflow.scrollWidth).toBe(overflow.clientWidth)

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
  }
})

test("market cart HUD is route-aware and layered above the fixed footer", async ({
  page,
}) => {
  await seedCart(page, 2)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${marketUrl}/products`)
  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).toBeVisible()

  const rail = hud.getByRole("group", { name: "Store carts" })
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
  const hudBox = await hud.boundingBox()
  const footerBox = await legalFooter.boundingBox()
  expect(hudBox!.y + hudBox!.height).toBeLessThanOrEqual(footerBox!.y)

  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByRole("region", { name: "Cart inventory" })
  ).toHaveCount(0)
})

test("market cart HUD rail activation expands a collapsed HUD for pointer and keyboard", async ({
  page,
}) => {
  await seedCart(page, 2)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${marketUrl}/products`)
  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).toBeVisible()
  const toggle = hud.locator("button[aria-expanded]")
  const rail = hud.getByRole("group", { name: "Store carts" })
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

test("market cart HUD collapse restores focus from the panel to the disclosure toggle", async ({
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

test("market cart HUD restore is quiet while a real first increase announces and expands", async ({
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

  // A cross-tab storage mutation increasing a quantity is a real change.
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("conduit:cart") ?? "{}")
    stored.items[0].quantity += 1
    localStorage.setItem("conduit:cart", JSON.stringify(stored))
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "conduit:cart",
        storageArea: localStorage,
        newValue: JSON.stringify(stored),
      })
    )
  })
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(liveRegion).toContainText("Cart updated")
})

test("market cart presence starts one shared merchant-scoped LNURL preflight without payment data", async ({
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
  expect(lnurlRequests).toEqual([])

  // Restoring a cart for the merchant starts the preflight once the profile
  // resolves the Lightning address.
  await seedCart(page, 2)
  await page.goto(`${marketUrl}/products`)
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
  await expect
    .poll(() => lnurlRequests.length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)

  // The preflight is a bare capability GET: no cart contents, buyer
  // identity, invoice, or payment data leave the app, and the invoice
  // callback is never contacted without explicit payment intent.
  for (const request of lnurlRequests) {
    expect(request.method).toBe("GET")
    expect(request.body).toBeNull()
    expect(request.url).toBe(
      "https://merchant-fixture.dev/.well-known/lnurlp/payments"
    )
  }

  // Route handoff inside the lease reuses the same result: an in-app
  // navigation to the cart starts no additional metadata request.
  const requestsBeforeNavigation = lnurlRequests.length
  const hud = page.getByRole("region", { name: "Cart inventory" })
  const toggle = hud.locator("button[aria-expanded]")
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click()
  }
  await hud.getByRole("link", { name: "View cart" }).click()
  await expect(page).toHaveURL(/\/cart/)
  await expect(page.getByText("Lamp Merchant").first()).toBeVisible()
  await page.waitForTimeout(1_500)
  expect(lnurlRequests.length).toBe(requestsBeforeNavigation)
})

test("market cart HUD isolates a failed merchant-scoped LNURL endpoint and stays interactive", async ({
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

test("market cart HUD does not present a partial total", async ({ page }) => {
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
  await expect(hud).toContainText("Total unavailable")
  await expect(hud).not.toContainText("1,200 sats")
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(localStorage.getItem("conduit:cart") ?? "{}")
        return stored.items?.map(
          (item: { productId: string }) => item.productId
        )
      })
    )
    .toEqual([`30402:${MERCHANT_A}:priced`, `30402:${MERCHANT_A}:unpriced`])
})
