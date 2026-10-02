import { expect, test, type Locator, type Page } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  installTestSigner,
  publishTestRelayEvents,
  readTestRelayEvents,
  seedTestRelayIdentity,
  TEST_RELAY_URL,
} from "./helpers/auth"

const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

for (const { reopen, invalid } of [
  { reopen: false, invalid: false },
  { reopen: true, invalid: false },
  { reopen: false, invalid: true },
  { reopen: true, invalid: true },
]) {
  test(`${invalid ? "malformed" : "conflicting"} shipping rates require explicit replacement${reopen ? " after reopening" : " while editing"} @merchant`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000)
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    await seedTestRelayIdentity(secretKey)
    const createdAt = Math.floor(Date.now() / 1000) - 10
    function signedRates(priceMinor: number) {
      const policy = {
        version: 2,
        title: "Rates",
        originCountry: "US",
        currency: "SATS",
        domestic: {
          rules: [
            { country: "US", bands: [{ maxWeightGrams: 1000, priceMinor }] },
          ],
        },
        international: null,
      }
      return finalizeEvent(
        {
          kind: 30406,
          created_at: createdAt,
          content: "Synthetic rates",
          tags: [
            ["d", "conduit-shipping-policy"],
            ["title", "Rates"],
            ["price", String(priceMinor), "SATS"],
            ["country", "US"],
            ["service", "standard"],
            ["conduit_shipping_table", "2", JSON.stringify(policy)],
          ],
        },
        secretKey
      )
    }
    // The relay replaces equal-timestamp events by ID. Observe both in sequence
    // so the retained frontier must preserve the conflict even after reopening.
    const [conflicting, initial] = [signedRates(100), signedRates(200)].sort(
      (a, b) => a.id.localeCompare(b.id)
    )
    function malformedRevision(timestamp: number) {
      const event = signedRates(100)
      return finalizeEvent(
        {
          ...event,
          created_at: timestamp,
          tags: event.tags.map((tag) =>
            tag[0] === "conduit_shipping_table" ? [tag[0], "2", "bad"] : tag
          ),
        },
        secretKey
      )
    }
    let incompleteReads = false
    if (invalid) {
      await page.routeWebSocket(TEST_RELAY_URL, (socket) => {
        const server = socket.connectToServer()
        const policySubscriptions = new Set<string>()
        socket.onMessage((message) => {
          const frame = JSON.parse(message.toString())
          if (
            frame[0] === "REQ" &&
            frame
              .slice(2)
              .some((filter: { kinds?: number[] }) =>
                filter.kinds?.some((kind) => kind === 30406 || kind === 5)
              )
          )
            policySubscriptions.add(frame[1])
          server.send(message)
        })
        server.onMessage((message) => {
          const frame = JSON.parse(message.toString())
          if (
            incompleteReads &&
            frame[0] === "EOSE" &&
            policySubscriptions.has(frame[1])
          )
            socket.send(
              JSON.stringify([
                "CLOSED",
                frame[1],
                "Synthetic incomplete shipping read",
              ])
            )
          else socket.send(message)
        })
      })
    }
    await publishTestRelayEvents([initial!])
    await installTestSigner(page, pubkey, { secretKey })
    await page.goto(`${merchantUrl}/shipping`)
    const price = page.getByLabel("Shipping price", { exact: true }).first()
    await expect(price).toHaveValue(
      initial!.tags.find((tag) => tag[0] === "price")![1]!
    )
    await price.fill("300")
    await publishTestRelayEvents([
      invalid ? malformedRevision(createdAt + 1) : conflicting!,
    ])
    async function activate(control: Locator) {
      if (testInfo.project.use.hasTouch) await control.tap()
      else await control.click()
    }
    await activate(
      page.getByRole("button", { name: "Check for updates", exact: true })
    )
    const replace = page.getByRole("button", {
      name: invalid ? "Replace invalid rates" : "Replace conflicting rates",
      exact: true,
    })
    await expect(replace).toBeEnabled()
    await expect(price).toHaveValue("300")
    if (reopen) {
      await page.reload()
      await expect(replace).toBeEnabled()
      await expect(price).toHaveValue("")
      await chooseCountry(page, "Origin country", "United States")
      await page.getByLabel("Shipping currency", { exact: true }).click()
      await page.getByRole("option", { name: "SATS", exact: true }).click()
      await page
        .getByLabel("Up to weight", { exact: true })
        .first()
        .fill("1000")
      await price.fill("300")
    }
    const publish = page.getByRole("button", {
      name: "Publish shipping rates",
      exact: true,
    })
    await expect(publish).toBeDisabled()
    await page.screenshot({
      path: testInfo.outputPath("shipping-conflict-review.png"),
      fullPage: true,
    })
    await page.evaluate(() => {
      const signer = (
        window as unknown as {
          nostr: { signEvent: (...args: unknown[]) => Promise<unknown> }
        }
      ).nostr
      const sign = signer.signEvent.bind(signer)
      const state = window as unknown as { shippingSignCount: number }
      state.shippingSignCount = 0
      signer.signEvent = async (...args) => {
        state.shippingSignCount++
        return sign(...args)
      }
      document
        .querySelector('section[aria-label="Shipping rates"] form')!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })
    const signCount = () =>
      page.evaluate(
        () =>
          (window as unknown as { shippingSignCount: number }).shippingSignCount
      )
    expect(await signCount()).toBe(0)
    if (invalid) {
      incompleteReads = true
      await activate(
        page.getByRole("button", { name: "Check for updates", exact: true })
      )
      await expect(replace).toBeDisabled()
      await expect(publish).toBeDisabled()
      expect(await signCount()).toBe(0)
      incompleteReads = false
      await activate(
        page.getByRole("button", { name: "Check for updates", exact: true })
      )
      await expect(replace).toBeEnabled()
    }
    await activate(replace)
    await expect(price).toHaveValue("300")
    await expect(publish).toBeEnabled()
    expect(await signCount()).toBe(0)
    if (invalid) {
      incompleteReads = true
      await activate(
        page.getByRole("button", { name: "Check for updates", exact: true })
      )
      await expect(replace).toBeDisabled()
      await expect(publish).toBeDisabled()
      await page.evaluate(() => {
        document
          .querySelector('section[aria-label="Shipping rates"] form')!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true })
          )
      })
      expect(await signCount()).toBe(0)
      incompleteReads = false
      await activate(
        page.getByRole("button", { name: "Check for updates", exact: true })
      )
      await expect(replace).toHaveCount(0)
      await expect(publish).toBeEnabled()
      await publishTestRelayEvents([malformedRevision(createdAt + 2)])
      await activate(
        page.getByRole("button", { name: "Check for updates", exact: true })
      )
      await expect(replace).toBeEnabled()
      await expect(publish).toBeDisabled()
      expect(await signCount()).toBe(0)
      await activate(replace)
      await expect(publish).toBeEnabled()
    }
    await activate(publish)
    await expect(
      page.getByText("Shipping rates published.", { exact: true })
    ).toBeVisible({ timeout: 20_000 })
    expect(await signCount()).toBe(1)
    const [replacement] = await readTestRelayEvents({
      kinds: [30406],
      authors: [pubkey],
      "#d": ["conduit-shipping-policy"],
    })
    expect(replacement!.created_at).toBeGreaterThan(
      createdAt + (invalid ? 2 : 0)
    )
    expect(replacement!.tags.some((tag) => tag[0] === "price")).toBe(false)
    const replacementPolicy = JSON.parse(
      replacement!.tags.find((tag) => tag[0] === "conduit_shipping_table")![2]!
    )
    expect(replacementPolicy.domestic.rules[0].bands[0].priceMinor).toBe(300)
    await page.reload()
    await expect(price).toHaveValue("300")
    await expect(replace).toHaveCount(0)
    await expect(page.getByText("Published", { exact: true })).toBeVisible()
  })
}

async function chooseCountry(page: Page, label: string, country: string) {
  await page.getByLabel(label, { exact: true }).click()
  await page
    .getByPlaceholder("Search countries", { exact: true })
    .filter({ visible: true })
    .fill(country)
  await page.getByRole("option", { name: country, exact: true }).click()
}

test("digital drafts publish after their unused shipping table is withdrawn @merchant", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000)
  page.setDefaultTimeout(25_000)
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey)
  const coordinate = `30406:${pubkey}:conduit-shipping-policy`
  const policy = {
    version: 2,
    title: "Shipping",
    originCountry: "US",
    currency: "SATS",
    domestic: {
      rules: [
        { country: "US", bands: [{ maxWeightGrams: 1000, priceMinor: 500 }] },
      ],
    },
    international: null,
  }
  const now = Math.floor(Date.now() / 1000)
  const event = finalizeEvent(
    {
      kind: 30406,
      created_at: now,
      content: "Synthetic shipping",
      tags: [
        ["d", "conduit-shipping-policy"],
        ["title", "Shipping"],
        ["price", "500", "SATS"],
        ["country", "US"],
        ["service", "standard"],
        ["conduit_shipping_table", "2", JSON.stringify(policy)],
      ],
    },
    secretKey
  )
  await publishTestRelayEvents([event])
  await installTestSigner(page, pubkey, { secretKey })
  await page.goto(`${merchantUrl}/products`)
  await expect(page.locator('aside a[href="/shipping"]')).toHaveText("Shipping")
  const add = page.getByRole("button", { name: "Add product" }).first()
  if (testInfo.project.use.hasTouch) await add.tap()
  else await add.click()
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByLabel("Shipping pricing", { exact: true })
  ).toContainText("Use my shipping table")
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Synthetic digital listing")
  await dialog.getByLabel("Price", { exact: true }).fill("1000")
  await dialog.getByLabel("Fulfillment", { exact: true }).click()
  await page.getByRole("option", { name: "Digital", exact: true }).click()
  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await dialog
    .getByLabel("Primary image URL")
    .fill("https://media.conduit.market/synthetic-digital.png")
  const tags = dialog.getByRole("combobox", { name: "Tags", exact: true })
  for (const tag of ["digital", "shipping", "test"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
  await publishTestRelayEvents([
    finalizeEvent(
      {
        kind: 5,
        created_at: now + 1,
        content: "Synthetic withdrawal",
        tags: [
          ["a", coordinate],
          ["e", event.id],
          ["k", "30406"],
        ],
      },
      secretKey
    ),
  ])
  const publish = dialog.getByRole("button", {
    name: "Publish product",
    exact: true,
  })
  await expect(publish).toBeEnabled()
  await publish.click()
  await expect(dialog).not.toBeVisible()
  await expect
    .poll(
      async () =>
        (await readTestRelayEvents({ kinds: [30402], authors: [pubkey] }))
          .length,
      { timeout: 20_000 }
    )
    .toBe(1)
  const products = await readTestRelayEvents({
    kinds: [30402],
    authors: [pubkey],
  })
  expect(products).toHaveLength(1)
  expect(products[0]!.tags).toContainEqual(["type", "simple", "digital"])
  expect(
    products[0]!.tags.some((tag) =>
      [
        "shipping_option",
        "weight",
        "dim",
        "conduit_shipping_adjustments",
      ].includes(tag[0]!)
    )
  ).toBe(false)
})

for (const [viewportName, width, height] of [
  ["mobile", 375, 812],
  ["desktop", 1440, 1000],
] as const) {
  test(`merchant publishes, recovers and withdraws custom weight tables on ${viewportName} @merchant`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(180_000)
    page.setDefaultTimeout(25_000)
    const activate = (control: Locator) =>
      testInfo.project.use.hasTouch ? control.tap() : control.click()
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
    await chooseCountry(page, "Origin country", "Canada")
    const remapped = domestic.getByRole("group", {
      name: "Canada custom area",
      exact: true,
    })
    await expect(
      remapped.getByLabel("State / region", { exact: true })
    ).toHaveValue("")
    await expect(
      remapped.getByLabel("Postal prefix", { exact: true })
    ).toHaveValue("")
    await expect(remapped.getByLabel("Shipping price").first()).toHaveValue(
      "300"
    )
    const blockedPublish = page.getByRole("button", {
      name: "Publish shipping rates",
      exact: true,
    })
    await expect(blockedPublish).toBeDisabled()
    await expect(page.locator("#shipping-policy-error")).toContainText(
      "Choose a state or enter a postal prefix"
    )
    await page
      .locator("form")
      .filter({ has: blockedPublish })
      .dispatchEvent("submit")
    expect(
      await readTestRelayEvents({ kinds: [30406], authors: [pubkey] })
    ).toHaveLength(0)
    await remapped.getByLabel("State / region", { exact: true }).fill("BC")
    await expect(blockedPublish).toBeEnabled()
    await chooseCountry(page, "Origin country", "United States")
    await expect(blockedPublish).toBeDisabled()
    await domestic.getByLabel("State", { exact: true }).click()
    await page.getByRole("option", { name: "California", exact: true }).click()
    await domestic.getByLabel("Postal prefix", { exact: true }).fill("94")
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
    expect(events[0]!.tags.some((tag) => tag[0] === "price")).toBe(false)
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
      path: testInfo.outputPath(`shipping-rates-${viewportName}.png`),
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
      await activate(page.getByRole("button", { name: "Add product" }).first())
      const dialog = page.getByRole("dialog", { name: "Add product" })
      await expect(dialog).toBeVisible()
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
      if (index === 2 && viewportName === "mobile") {
        await dialog
          .getByLabel("Shipping weight", { exact: true })
          .scrollIntoViewIfNeeded()
        await page.screenshot({
          path: testInfo.outputPath("shipping-product-mobile.png"),
        })
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

    await activate(
      page.getByRole("button", { name: "Edit", exact: true }).first()
    )
    const edit = page.getByRole("dialog", { name: "Edit listing" })
    await expect(edit).toBeVisible()
    const measurements = edit.getByRole("region", {
      name: "Product shipping measurements",
      exact: true,
    })
    await expect(
      measurements.getByLabel("Shipping weight", { exact: true })
    ).toBeDisabled()
    await edit
      .getByRole("button", { name: "Change fulfillment", exact: true })
      .click()
    await expect(
      measurements.getByLabel("Shipping weight", { exact: true })
    ).toBeEnabled()
    await measurements.getByLabel("Weight unit", { exact: true }).click()
    await page.getByRole("option", { name: "Grams", exact: true }).click()
    await measurements
      .getByLabel("Shipping weight", { exact: true })
      .fill("450")
    await measurements
      .getByText("Packing and dimensions", { exact: true })
      .click()
    await measurements
      .getByLabel("Extra packing weight", { exact: true })
      .fill("75")
    await measurements
      .getByLabel("Handling per item", { exact: true })
      .fill("2")
    const editedTitle = await edit
      .getByLabel("Title", { exact: true })
      .inputValue()
    await edit
      .getByRole("button", {
        name: /Publish changes|Save changes|Update product/,
        exact: true,
      })
      .click()
    await expect(edit).not.toBeVisible({ timeout: 30_000 })
    await expect
      .poll(async () => {
        const events = await readTestRelayEvents({
          kinds: [30402],
          authors: [pubkey],
        })
        return events
          .find((event) =>
            event.tags.some(
              (tag) => tag[0] === "title" && tag[1] === editedTitle
            )
          )
          ?.tags.find((tag) => tag[0] === "weight")?.[1]
      })
      .toBe("450")
    const editedEvent = (
      await readTestRelayEvents({ kinds: [30402], authors: [pubkey] })
    ).find((event) =>
      event.tags.some((tag) => tag[0] === "title" && tag[1] === editedTitle)
    )!
    expect(
      JSON.parse(
        editedEvent.tags.find(
          (tag) => tag[0] === "conduit_shipping_adjustments"
        )![2]!
      )
    ).toMatchObject({ weightAllowanceGrams: 75, handling: { amount: 2 } })

    // A new browser storage context reads the public signed table independently.
    const secondContext = await browser.newContext({
      viewport: { width, height },
    })
    const second = await secondContext.newPage()
    second.setDefaultTimeout(25_000)
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

test("late shipping revisions and withdrawals require explicit draft review before signing @merchant", async ({
  page,
}) => {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey)
  const table = {
    version: 2,
    title: "Rates",
    originCountry: "US",
    currency: "SATS",
    domestic: {
      rules: [
        { country: "US", bands: [{ maxWeightGrams: 1000, priceMinor: 100 }] },
      ],
    },
    international: null,
  }
  const initial = finalizeEvent(
    {
      kind: 30406,
      created_at: Math.floor(Date.now() / 1000) - 10,
      content: "Synthetic rates",
      tags: [
        ["d", "conduit-shipping-policy"],
        ["title", "Rates"],
        ["price", "100", "SATS"],
        ["country", "US"],
        ["service", "standard"],
        ["conduit_shipping_table", "2", JSON.stringify(table)],
      ],
    },
    secretKey
  )
  await publishTestRelayEvents([initial])
  await installTestSigner(page, pubkey, { secretKey })
  await page.goto(`${merchantUrl}/shipping`)
  const price = page.getByLabel("Shipping price", { exact: true }).first()
  await expect(price).toHaveValue("100")
  await price.fill("101")
  const newer = finalizeEvent(
    {
      ...initial,
      created_at: initial.created_at + 1,
      tags: initial.tags.map((tag) =>
        tag[0] === "price"
          ? ["price", "200", "SATS"]
          : tag[0] === "conduit_shipping_table"
            ? [
                tag[0],
                "2",
                JSON.stringify({
                  ...table,
                  domestic: {
                    rules: [
                      {
                        country: "US",
                        bands: [{ maxWeightGrams: 1000, priceMinor: 200 }],
                      },
                    ],
                  },
                }),
              ]
            : tag
      ),
    },
    secretKey
  )
  await publishTestRelayEvents([newer])
  async function refresh() {
    await page
      .getByRole("button", { name: "Check for updates", exact: true })
      .click()
  }
  await refresh()
  await expect(
    page.getByRole("button", { name: "Load latest rates" })
  ).toBeVisible()
  await expect(price).toHaveValue("101")
  const publish = page.getByRole("button", {
    name: "Publish rate changes",
    exact: true,
  })
  await expect(publish).toBeDisabled()
  await page.evaluate(() => {
    const signer = (
      window as unknown as {
        nostr: { signEvent: (...args: unknown[]) => Promise<unknown> }
      }
    ).nostr
    const sign = signer.signEvent.bind(signer)
    const state = window as unknown as { shippingSignCount: number }
    state.shippingSignCount = 0
    signer.signEvent = async (...args) => {
      state.shippingSignCount++
      return sign(...args)
    }
    document
      .querySelector('section[aria-label="Shipping rates"] form')!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { shippingSignCount: number }).shippingSignCount
    )
  ).toBe(0)
  await page.getByRole("button", { name: "Load latest rates" }).click()
  await expect(price).toHaveValue("200")
  await price.fill("201")
  const deletion = finalizeEvent(
    {
      kind: 5,
      created_at: newer.created_at + 1,
      content: "Synthetic withdrawal",
      tags: [
        ["a", `30406:${pubkey}:conduit-shipping-policy`],
        ["e", newer.id],
        ["k", "30406"],
      ],
    },
    secretKey
  )
  await publishTestRelayEvents([deletion])
  await refresh()
  await expect(
    page.getByRole("button", { name: "Load latest rates" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Publish shipping rates", exact: true })
  ).toBeDisabled()
  await expect(price).toHaveValue("201")
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { shippingSignCount: number }).shippingSignCount
    )
  ).toBe(0)
  await page.getByRole("button", { name: "Load latest rates" }).click()
  await chooseCountry(page, "Origin country", "United States")
  await page.getByLabel("Shipping currency", { exact: true }).click()
  await page.getByRole("option", { name: "SATS", exact: true }).click()
  await page.getByLabel("Up to weight", { exact: true }).first().fill("1000")
  await price.fill("300")
  await page
    .getByRole("button", { name: "Publish shipping rates", exact: true })
    .click()
  await expect(page.getByText(/Shipping rates published\./)).toBeVisible({
    timeout: 20_000,
  })
})
