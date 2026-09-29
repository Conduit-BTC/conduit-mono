import { expect, test, type Page } from "@playwright/test"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import {
  installTestSigner,
  readTestRelayEvents,
  seedTestRelayIdentity,
} from "./helpers/auth"

const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

async function chooseCountry(page: Page, label: string, country: string) {
  await page.getByLabel(label, { exact: true }).click()
  await page
    .getByPlaceholder("Search countries", { exact: true })
    .filter({ visible: true })
    .fill(country)
  await page.getByRole("option", { name: country, exact: true }).click()
}

for (const [viewportName, width, height] of [
  ["mobile", 375, 812],
  ["desktop", 1440, 1000],
] as const) {
  test(`merchant publishes, recovers and withdraws custom weight tables on ${viewportName} @merchant`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(180_000)
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    await seedTestRelayIdentity(secretKey)
    await installTestSigner(page, pubkey, { secretKey })
    await page.setViewportSize({ width, height })
    await page.goto(`${merchantUrl}/shipping`)
    await expect(
      page.getByRole("heading", { name: "Shipping", exact: true })
    ).toBeVisible()
    await chooseCountry(page, "Origin country", "United States")
    await page.getByLabel("Shipping currency", { exact: true }).click()
    await page.getByRole("option", { name: "SATS", exact: true }).click()
    await page.getByLabel("Weight unit", { exact: true }).click()
    await page.getByRole("option", { name: "Pounds", exact: true }).click()
    const domestic = page.getByRole("region", { name: "Domestic rates" })
    await domestic.getByLabel("Up to weight").fill("1")
    await domestic.getByLabel("Shipping price").fill("200")
    await domestic.getByRole("button", { name: "Add weight band" }).click()
    await domestic.getByLabel("Up to weight").nth(1).fill("2")
    await domestic.getByLabel("Shipping price").nth(1).fill("500")
    await page.getByLabel("Weight unit", { exact: true }).click()
    await page.getByRole("option", { name: "Grams", exact: true }).click()
    await expect(domestic.getByLabel("Up to weight").first()).toHaveValue("454")
    await expect(domestic.getByLabel("Up to weight").nth(1)).toHaveValue("908")
    await domestic
      .getByRole("button", { name: "Customize by state or postal area" })
      .click()
    await domestic.getByLabel("State", { exact: true }).click()
    await page.getByRole("option", { name: "California", exact: true }).click()
    await domestic.getByLabel("Postal prefix", { exact: true }).fill("94")
    const custom = domestic.getByRole("group", {
      name: "United States custom area",
      exact: true,
    })
    await custom.getByLabel("Shipping price").first().fill("300")
    await custom.getByLabel("Shipping price").nth(1).fill("600")
    await domestic.getByLabel("Free shipping from").fill("10000")
    await page.getByRole("checkbox", { name: "Enable international" }).check()
    const international = page.getByRole("region", {
      name: "International rates",
    })
    await international.getByLabel("Country", { exact: true }).click()
    await page
      .getByPlaceholder("Search countries", { exact: true })
      .filter({ visible: true })
      .fill("Canada")
    await page.getByRole("option", { name: "Canada", exact: true }).click()
    await international.getByLabel("Up to weight").fill("1000")
    await international.getByLabel("Shipping price").fill("800")
    await international.getByLabel("Free shipping from").fill("20000")
    await page.getByText("Preview a basket", { exact: true }).click()
    await chooseCountry(page, "Preview destination", "United States")
    await expect(
      page.getByText("Combined shipping: 500 SATS", { exact: true })
    ).toBeVisible()
    await page.getByLabel("Preview state / region").fill("CA")
    await page.getByLabel("Preview postal code").fill("94107")
    await expect(
      page.getByText("Combined shipping: 600 SATS", { exact: true })
    ).toBeVisible()
    await page.getByLabel("Preview state / region").fill("")
    await page.getByLabel("Preview postal code").fill("")
    await page.getByLabel("Basket subtotal").fill("10000")
    await expect(
      page.getByText("Combined shipping: 0 SATS", { exact: true })
    ).toBeVisible()
    await page.getByLabel("First item weight").fill("1000")
    await expect(
      page.getByText(/This basket needs merchant coordination/)
    ).toBeVisible()
    await page.getByLabel("First item weight").fill("250")
    await page.getByLabel("Basket subtotal").fill("0")
    const publish = page.getByRole("button", {
      name: "Publish shipping rates",
      exact: true,
    })
    await expect(publish).toBeEnabled({ timeout: 20_000 })
    await publish.click()
    await expect(page.getByText(/Shipping rates published\./)).toBeVisible({
      timeout: 20_000,
    })
    const events = await readTestRelayEvents({
      kinds: [30406],
      authors: [pubkey],
      "#d": ["conduit-shipping-policy"],
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.content).not.toMatch(/^\s*\{/)
    const policy = JSON.parse(
      events[0]!.tags.find((tag) => tag[0] === "conduit_shipping_table")![2]!
    )
    expect(policy).toMatchObject({
      version: 2,
      originCountry: "US",
      currency: "SATS",
    })
    expect(policy.weightAllowanceGrams).toBeUndefined()
    expect(policy.handlingMinor).toBeUndefined()
    expect(policy.domestic.rules).toHaveLength(2)
    expect(policy.domestic.rules[1].postalPrefix).toBe("94")
    expect(policy.domestic.rules[0].bands).toEqual([
      { maxWeightGrams: 454, priceMinor: 200 },
      { maxWeightGrams: 908, priceMinor: 500 },
    ])

    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
      )
      .toBe(true)
    if (viewportName === "desktop") {
      await expect(
        page.locator("aside").getByRole("link", { name: /Shipping/ })
      ).not.toContainText("Needs completion")
    }
    await page.getByText("Preview a basket", { exact: true }).click()
    await page
      .getByRole("heading", { name: "Shipping", exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({
      path: `/private/tmp/shipping-rates-${viewportName}.png`,
      fullPage: true,
    })

    await page.goto(`${merchantUrl}/products`)
    // Wait for the independently read public policy before opening a new draft.
    await expect(page.locator('aside a[href="/shipping"]')).toHaveText(
      "Shipping",
      { timeout: 20_000 }
    )
    for (const [index, weight] of [
      [1, "250"],
      [2, "400"],
    ] as const) {
      await page.getByRole("button", { name: "Add product" }).first().click()
      const dialog = page.getByRole("dialog", { name: "Add product" })
      await dialog
        .getByLabel("Title", { exact: true })
        .fill(`Table product ${index}`)
      await dialog.getByLabel("Price", { exact: true }).fill("1000")
      await expect(
        dialog.getByLabel("Currency", { exact: true })
      ).toContainText("SATS")
      await expect(
        dialog.getByLabel("Shipping pricing", { exact: true })
      ).toContainText("Use my shipping table")
      if (index === 1) {
        await dialog.getByLabel("Weight unit", { exact: true }).click()
        await page.getByRole("option", { name: "Ounces", exact: true }).click()
      } else {
        await dialog.getByLabel("Weight unit", { exact: true }).click()
        await page.getByRole("option", { name: "Grams", exact: true }).click()
        await dialog.getByLabel("Currency", { exact: true }).click()
        await page.getByRole("option", { name: "USD", exact: true }).click()
        await expect(
          dialog.getByText("Shipping uses SATS; this product uses USD.", {
            exact: true,
          })
        ).toBeVisible()
      }
      await dialog
        .getByLabel("Shipping weight", { exact: true })
        .fill(index === 1 ? "8" : weight)
      await dialog.getByText("Packing and dimensions", { exact: true }).click()
      await dialog
        .getByLabel("Extra packing weight", { exact: true })
        .fill(index === 1 ? "1" : "50")
      await dialog
        .getByLabel("Handling per item", { exact: true })
        .fill(index === 1 ? "25" : "1.25")
      await dialog.getByRole("button", { name: "Add by URL" }).click()
      await dialog
        .getByLabel("Primary image URL")
        .fill(`https://media.conduit.market/shipping-table-${index}.png`)
      const tags = dialog.getByRole("combobox", { name: "Tags", exact: true })
      for (const tag of ["shipping", "table", "test"]) {
        await tags.fill(tag)
        await tags.press("Enter")
      }
      await expect(
        dialog.getByRole("button", { name: "Publish product", exact: true })
      ).toBeEnabled()
      await dialog
        .getByRole("button", { name: "Publish product", exact: true })
        .click()
      await expect(dialog).not.toBeVisible({ timeout: 30_000 })
      await expect
        .poll(
          async () =>
            (await readTestRelayEvents({ kinds: [30402], authors: [pubkey] }))
              .length,
          { timeout: 20_000 }
        )
        .toBe(index)
    }
    const products = await readTestRelayEvents({
      kinds: [30402],
      authors: [pubkey],
    })
    expect(products).toHaveLength(2)
    for (const product of products) {
      expect(product.tags).toContainEqual([
        "shipping_option",
        `30406:${pubkey}:conduit-shipping-policy`,
      ])
      const adjustments = JSON.parse(
        product.tags.find(
          (tag) => tag[0] === "conduit_shipping_adjustments"
        )![2]!
      )
      expect(adjustments.weightAllowanceGrams).toBeGreaterThan(0)
      expect(adjustments.handling.amount).toBeGreaterThan(0)
      if (
        product.tags.some(
          (tag) => tag[0] === "title" && tag[1] === "Table product 1"
        )
      ) {
        expect(product.tags).toContainEqual(["weight", "227", "g"])
        expect(adjustments.weightAllowanceGrams).toBe(29)
      }
      expect(product.tags.some((tag) => tag[0] === "weight")).toBe(true)
    }

    // A new browser storage context reads the public signed table independently.
    const secondContext = await browser.newContext({
      viewport: { width, height },
    })
    const second = await secondContext.newPage()
    await installTestSigner(second, pubkey, { secretKey })
    await second.goto(`${merchantUrl}/shipping`)
    await expect(
      second.getByRole("button", { name: "Publish rate changes" })
    ).toBeVisible({ timeout: 20_000 })
    await expect(second.getByLabel("Up to weight").first()).toHaveValue("454")
    await expect(second.getByLabel("Shipping price").first()).toHaveValue("200")
    await second.getByLabel("Shipping price").first().fill("201")
    await second.getByRole("button", { name: "Publish rate changes" }).click()
    await expect(second.getByText(/Shipping rates published\./)).toBeVisible({
      timeout: 20_000,
    })
    const updated = await readTestRelayEvents({
      kinds: [30406],
      authors: [pubkey],
      "#d": ["conduit-shipping-policy"],
    })
    expect(updated).toHaveLength(1)
    expect(updated[0]!.id).not.toBe(events[0]!.id)
    expect(updated[0]!.created_at).toBeGreaterThan(events[0]!.created_at)
    await second.getByRole("button", { name: "Withdraw policy" }).click()
    await second
      .getByRole("alertdialog")
      .getByRole("button", { name: "Sign and withdraw" })
      .click()
    await expect(second.getByText(/Shipping policy withdrawn\./)).toBeVisible({
      timeout: 20_000,
    })
    const deletions = await readTestRelayEvents({
      kinds: [5],
      authors: [pubkey],
    })
    expect(
      deletions.some((event) =>
        event.tags.some(
          (tag) =>
            tag[0] === "a" &&
            tag[1] === `30406:${pubkey}:conduit-shipping-policy`
        )
      )
    ).toBe(true)
    await secondContext.close()
    expect(testInfo.errors).toHaveLength(0)
  })
}
