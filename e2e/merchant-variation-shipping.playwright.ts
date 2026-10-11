import { expect, test, type Locator } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure"
import {
  installTestSigner,
  publishTestRelayEvents,
  readTestRelayEvents,
  seedTestRelayIdentity,
  TEST_RELAY_URL,
} from "./helpers/auth"

const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

for (const delayed of [false, true]) {
  test(
    delayed
      ? "fixed family refresh preserves an open draft and restores retained signed terms after restart @merchant"
      : "fixed family reopen loads exact signed shipping before changing and publishing terms @merchant",
    async ({ page }, testInfo) => {
      test.setTimeout(120_000)
      page.setDefaultTimeout(25_000)
      const secretKey = generateSecretKey()
      const pubkey = getPublicKey(secretKey)
      const createdAt = Math.floor(Date.now() / 1000) - 20
      const shipping = ["fixed-shoes", "fixed-shoes-small"].map((dTag, index) =>
        finalizeEvent(
          {
            kind: 30406,
            created_at: createdAt,
            content: "Synthetic fixed terms",
            tags: [
              ["d", `${dTag}-shipping-standard`],
              ["title", "Standard Shipping"],
              ["price", index ? "7" : "5", "USD"],
              ["country", "US"],
              ["service", "standard"],
            ],
          },
          secretKey
        )
      )
      const products = ["fixed-shoes", "fixed-shoes-small"].map((dTag, index) =>
        finalizeEvent(
          {
            kind: 30402,
            created_at: createdAt + 1,
            content: "Synthetic fixed family",
            tags: [
              ["d", dTag],
              ["title", index ? "3 Men/4.5 Women" : "Fixed shoes"],
              ["price", "20", "USD"],
              ["type", index ? "variation" : "variable", "physical"],
              ["stock", "4"],
              ["shipping_option", `30406:${pubkey}:${dTag}-shipping-standard`],
              ["image", "https://media.conduit.market/synthetic-shoes.png"],
              ["t", "shoes"],
              ["t", "shipping"],
              ["t", "synthetic"],
              ...(index
                ? [
                    ["a", `30402:${pubkey}:fixed-shoes`],
                    ["spec", "Size", "3 Men/4.5 Women"],
                  ]
                : []),
            ],
          },
          secretKey
        )
      )
      await seedTestRelayIdentity(secretKey)
      await publishTestRelayEvents([...products, ...(delayed ? [] : shipping)])
      let unavailable = false
      let blockedReads = 0
      await page.routeWebSocket(TEST_RELAY_URL, (socket) => {
        const server = socket.connectToServer()
        socket.onMessage((message) => {
          const frame = JSON.parse(String(message))
          if (
            unavailable &&
            frame[0] === "REQ" &&
            frame
              .slice(2)
              .some((filter: { kinds?: number[] }) =>
                filter.kinds?.includes(30406)
              )
          ) {
            blockedReads++
            socket.send(
              JSON.stringify([
                "CLOSED",
                frame[1],
                "auth-required: synthetic shipping read unavailable",
              ])
            )
            return
          }
          server.send(message)
        })
        server.onMessage((message) => socket.send(message))
      })
      await installTestSigner(page, pubkey, { secretKey })
      await page.goto(`${merchantUrl}/products`)
      await page
        .getByRole("button", { name: "Edit", exact: true })
        .first()
        .click()
      const edit = page.getByRole("dialog", { name: "Edit product family" })
      await expect(edit).toBeVisible()
      await edit.getByLabel("Title", { exact: true }).fill("Edited fixed shoes")
      await edit.locator("#product-variation-price-0").fill("29")
      await expect(
        edit.getByRole("button", { name: "Save changes", exact: true })
      ).toBeEnabled()
      await edit
        .getByRole("button", { name: "Change fulfillment", exact: true })
        .click()
      const warning = edit.locator("#product-variations-help").filter({
        hasText:
          "3 Men/4.5 Women shipping could not be verified from the current relay read. Refresh products before saving this family.",
      })
      if (delayed) {
        await expect(warning).toBeVisible()
        await publishTestRelayEvents(shipping)
      }
      await expect(warning).toBeHidden({ timeout: 30_000 })
      await expect(edit.locator("#product-shipping")).toHaveValue("5")
      await expect(edit.locator("#product-variation-shipping-0")).toHaveValue(
        "7"
      )
      await expect(edit.getByLabel("Title", { exact: true })).toHaveValue(
        "Edited fixed shoes"
      )
      await expect(edit.locator("#product-variation-price-0")).toHaveValue("29")

      if (delayed) {
        await edit
          .locator("form")
          .getByRole("button", { name: "Close", exact: true })
          .click()
        await expect(edit).toBeHidden()
        unavailable = true
        await page.reload()
        await page
          .getByRole("button", { name: "Edit", exact: true })
          .first()
          .click()
        await expect.poll(() => blockedReads).toBeGreaterThan(0)
        await expect(edit).toBeVisible()
        await expect(edit.getByLabel("Title", { exact: true })).toHaveValue(
          "Edited fixed shoes"
        )
        await expect(edit.locator("#product-variation-price-0")).toHaveValue(
          "29"
        )
        await expect(edit.locator("#product-variation-shipping-0")).toHaveValue(
          "7"
        )
        await expect(warning).toBeHidden()
        unavailable = false
        await edit
          .getByRole("button", {
            name: "Keep existing fulfillment",
            exact: true,
          })
          .click()
      } else {
        await edit.locator("#product-shipping").fill("6")
        await edit.locator("#product-variation-shipping-0").fill("9")
      }
      await edit.screenshot({
        path: testInfo.outputPath(
          `fixed-shipping-${delayed ? "restored" : "changed"}-${testInfo.project.name}.png`
        ),
      })
      await edit
        .getByRole("button", { name: "Save changes", exact: true })
        .click()
      await expect(edit).toBeHidden({ timeout: 30_000 })
      let published: Awaited<ReturnType<typeof readTestRelayEvents>> = []
      // The dialog closes on durable local signing, before relay delivery ends.
      await expect
        .poll(
          async () => {
            published = await readTestRelayEvents({
              kinds: [30402, 30406],
              authors: [pubkey],
            })
            return [
              ["fixed-shoes", "title", "Edited fixed shoes"],
              ["fixed-shoes-small", "price", "29"],
            ].every(([dTag, field, value]) =>
              published.some(
                (event) =>
                  event.kind === 30402 &&
                  event.tags.some(([key, d]) => key === "d" && d === dTag) &&
                  event.tags.some(
                    ([key, text]) => key === field && text === value
                  )
              )
            )
          },
          { timeout: 15_000 }
        )
        .toBe(true)
      expect(published.every(verifyEvent)).toBe(true)
      const amounts = published
        .filter((event) => event.kind === 30406)
        .map((event) => event.tags.find(([name]) => name === "price")?.[1])
        .sort()
      expect(amounts).toEqual(delayed ? ["5", "7"] : ["6", "9"])
      expect(
        published.find(
          (event) =>
            event.kind === 30402 &&
            event.tags.some(
              ([key, value]) => key === "d" && value === "fixed-shoes"
            )
        )?.tags
      ).toContainEqual(["title", "Edited fixed shoes"])
    }
  )
}

for (const malformed of [false, true]) {
  test(
    malformed
      ? "malformed family shipping adjustments require explicit repair before republication @merchant"
      : "minimum BTC handling survives family reopen and preserved fulfillment republication @merchant",
    async ({ page }, testInfo) => {
      test.setTimeout(120_000)
      page.setDefaultTimeout(25_000)
      const activate = (control: Locator) =>
        testInfo.project.use.hasTouch ? control.tap() : control.click()
      const secretKey = generateSecretKey()
      const pubkey = getPublicKey(secretKey)
      await seedTestRelayIdentity(secretKey)
      const coordinate = `30406:${pubkey}:conduit-shipping-policy`
      const table = {
        version: 2,
        title: "BTC handling rates",
        originCountry: "US",
        currency: "BTC",
        domestic: {
          rules: [
            { country: "US", bands: [{ maxWeightGrams: 1000, priceMinor: 0 }] },
          ],
        },
        international: null,
      }
      const createdAt = Math.floor(Date.now() / 1000) - 10
      const policy = finalizeEvent(
        {
          kind: 30406,
          content: "Synthetic BTC handling terms",
          tags: [
            ["d", "conduit-shipping-policy"],
            ["title", table.title],
            ["country", "US"],
            ["service", "standard"],
            ["conduit_shipping_table", "2", JSON.stringify(table)],
          ],
          created_at: createdAt,
        },
        secretKey
      )
      const adjustments = malformed
        ? "{"
        : JSON.stringify({
            handling: {
              amount: 0.00000001,
              currency: "BTC",
              normalizedCurrency: "BTC",
            },
          })
      const products = ["btc-handling", "btc-handling-small"].map(
        (dTag, index) =>
          finalizeEvent(
            {
              kind: 30402,
              content: "Synthetic BTC handling product",
              tags: [
                ["d", dTag],
                ["title", index === 0 ? "BTC handling family" : "Small"],
                ["price", "0.001", "BTC"],
                ["type", index === 0 ? "variable" : "variation", "physical"],
                ["weight", "250", "g"],
                ["shipping_option", coordinate],
                ["conduit_shipping_adjustments", "1", adjustments],
                ["image", "https://media.conduit.market/btc-handling.png"],
                ["t", "shipping"],
                ["t", "handling"],
                ["t", "test"],
                ...(index === 0
                  ? []
                  : [
                      ["a", `30402:${pubkey}:btc-handling`],
                      ["spec", "Size", "Small"],
                    ]),
              ],
              created_at: createdAt,
            },
            secretKey
          )
      )
      await publishTestRelayEvents([policy, ...products])
      await installTestSigner(page, pubkey, { secretKey })
      await page.goto(`${merchantUrl}/products`)
      await activate(
        page.getByRole("button", { name: "Edit", exact: true }).first()
      )
      const edit = page.getByRole("dialog", { name: "Edit product family" })
      await expect(edit).toBeVisible()
      const parent = edit.getByRole("region", {
        name: "Product shipping measurements",
        exact: true,
      })
      await parent.getByText("Packing and dimensions", { exact: true }).click()
      const small = edit.getByRole("group", {
        name: "Variation Small",
        exact: true,
      })
      await small.getByText("Packing and dimensions", { exact: true }).click()
      for (const scope of [parent, small]) {
        const handling = scope.getByLabel("Handling per item", { exact: true })
        await expect(handling).toHaveValue(malformed ? "" : "0.00000001")
        await expect(handling).toBeDisabled()
      }
      await edit
        .getByLabel("Title", { exact: true })
        .fill("Edited BTC handling family")
      await small.locator("#product-variation-price-0").fill("0.002")
      const save = edit.getByRole("button", {
        name: "Save changes",
        exact: true,
      })
      await expect(save).toBeEnabled()
      if (malformed) {
        await save.click()
        await expect(edit).toBeVisible()
        await expect(
          page.getByText(
            "Change fulfillment to repair or remove invalid shipping adjustments before publishing.",
            { exact: true }
          )
        ).toBeVisible()
        expect(
          (
            await readTestRelayEvents({ kinds: [30402], authors: [pubkey] })
          ).filter((event) => event.created_at > createdAt)
        ).toHaveLength(0)
        await edit
          .getByRole("button", { name: "Change fulfillment", exact: true })
          .click()
        for (const scope of [parent, small]) {
          await scope
            .getByLabel("Handling per item", { exact: true })
            .fill("0.00000001")
        }
        await expect(save).toBeEnabled()
      }
      await save.click()
      await expect(edit).not.toBeVisible({ timeout: 30_000 })
      await expect
        .poll(async () => {
          const events = await readTestRelayEvents({
            kinds: [30402],
            authors: [pubkey],
          })
          return events.filter((event) => event.created_at > createdAt).length
        })
        .toBe(2)
      const republished = await readTestRelayEvents({
        kinds: [30402],
        authors: [pubkey],
      })
      expect(
        republished
          .map((event) => event.tags.find(([name]) => name === "d")![1])
          .sort()
      ).toEqual(["btc-handling", "btc-handling-small"])
      expect(
        republished.find((event) =>
          event.tags.some(
            ([name, value]) => name === "d" && value === "btc-handling"
          )
        )!.tags
      ).toContainEqual(["title", "Edited BTC handling family"])
      expect(
        republished.find((event) =>
          event.tags.some(
            ([name, value]) => name === "d" && value === "btc-handling-small"
          )
        )!.tags
      ).toContainEqual(["price", "0.002", "BTC"])
      for (const event of republished) {
        expect(event.created_at).toBeGreaterThan(createdAt)
        expect(event.tags).toContainEqual(["weight", "250", "g"])
        expect(event.tags).toContainEqual(["shipping_option", coordinate])
        const handling = JSON.parse(
          event.tags.find(
            ([name]) => name === "conduit_shipping_adjustments"
          )![2]!
        ).handling
        expect(handling.currency).toBe("BTC")
        expect(handling.amount * 100_000_000).toBe(1)
      }
    }
  )
}

test("variation measurements require explicit sharing and preserve independent adjustments @merchant", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(25_000)
  const activate = (control: Locator) =>
    testInfo.project.use.hasTouch ? control.tap() : control.click()
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey)
  const table = {
    version: 2,
    title: "Variation rates",
    originCountry: "US",
    currency: "SATS",
    domestic: {
      rules: [
        { country: "US", bands: [{ maxWeightGrams: 1000, priceMinor: 100 }] },
      ],
    },
    international: null,
  }
  const policy = finalizeEvent(
    {
      kind: 30406,
      content: "Synthetic variation shipping terms",
      tags: [
        ["d", "conduit-shipping-policy"],
        ["title", table.title],
        ["price", "100", "SATS"],
        ["country", "US"],
        ["service", "standard"],
        ["conduit_shipping_table", "2", JSON.stringify(table)],
      ],
      created_at: Math.floor(Date.now() / 1000) - 10,
    },
    secretKey
  )
  await publishTestRelayEvents([policy])
  await installTestSigner(page, pubkey, { secretKey })
  await page.goto(`${merchantUrl}/products`)
  await activate(page.getByRole("button", { name: "Add product" }).first())
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await expect(dialog).toBeVisible()
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Variation shipping test")
  await dialog.getByLabel("Price", { exact: true }).fill("1000")
  await expect(
    dialog.getByLabel("Shipping pricing", { exact: true })
  ).toContainText("Use my shipping table")
  const parent = dialog.getByRole("region", {
    name: "Product shipping measurements",
    exact: true,
  })
  await parent.getByLabel("Shipping weight", { exact: true }).fill("500")
  await parent.getByText("Packing and dimensions", { exact: true }).click()
  await parent.getByLabel("Extra packing weight", { exact: true }).fill("99")
  await parent.getByLabel("Handling per item", { exact: true }).fill("99")
  await parent.getByLabel("Length", { exact: true }).fill("20")
  await parent.getByLabel("Width", { exact: true }).fill("10")
  await parent.getByLabel("Height", { exact: true }).fill("5")
  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await dialog
    .getByLabel("Primary image URL")
    .fill("https://media.conduit.market/variation-shipping.png")
  const tags = dialog.getByRole("combobox", { name: "Tags", exact: true })
  for (const tag of ["shipping", "variation", "test"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
  await dialog
    .getByRole("checkbox", { name: /This product has options/ })
    .check()
  await dialog.getByLabel("Option name", { exact: true }).fill("Size")
  await dialog.getByLabel("Values", { exact: true }).fill("Small, Large")
  await dialog.getByRole("button", { name: "Make all available" }).click()
  const shared = dialog.getByRole("checkbox", {
    name: "Use the same weight and dimensions for all physical variations",
  })
  await expect(shared).not.toBeChecked()
  const publish = dialog.getByRole("button", {
    name: "Publish product",
    exact: true,
  })
  await expect(publish).toBeDisabled()
  const small = dialog.getByRole("group", {
    name: "Variation Small",
    exact: true,
  })
  const large = dialog.getByRole("group", {
    name: "Variation Large",
    exact: true,
  })
  await small.getByLabel("Shipping weight", { exact: true }).fill("250")
  await small.getByText("Packing and dimensions", { exact: true }).click()
  await small.getByLabel("Extra packing weight", { exact: true }).fill("20")
  await small.getByLabel("Handling per item", { exact: true }).fill("10")
  await small.getByLabel("Length", { exact: true }).fill("12")
  await expect(publish).toBeDisabled()
  await small.getByLabel("Width", { exact: true }).fill("8")
  await small.getByLabel("Height", { exact: true }).fill("2")
  await expect(publish).toBeDisabled()
  await large.getByLabel("Format", { exact: true }).click()
  await page.getByRole("option", { name: "Digital", exact: true }).click()
  await expect(publish).toBeEnabled()
  const useTable = small.getByRole("checkbox", { name: "Use table" })
  const variationPrice = small.locator("#product-variation-shipping-0")
  await useTable.uncheck()
  await variationPrice.fill("7")
  await expect(publish).toBeDisabled()
  await expect(dialog.locator("#product-variations-help")).toContainText(
    "Small: Fixed variation prices cannot be combined with table shipping"
  )
  await dialog.locator("form").dispatchEvent("submit")
  await expect(dialog).toBeVisible()
  await expect(publish).toBeDisabled()
  expect(
    await readTestRelayEvents({ kinds: [30402], authors: [pubkey] })
  ).toHaveLength(0)
  await variationPrice.fill("")
  await expect(publish).toBeEnabled()
  await useTable.check()
  await expect(publish).toBeEnabled()
  await shared.check()
  await expect(
    small.getByLabel("Shipping weight", { exact: true })
  ).toHaveCount(0)
  await shared.uncheck()
  await expect(
    small.getByLabel("Shipping weight", { exact: true })
  ).toHaveValue("250")
  const duplicateIds = await dialog.evaluate((element) => {
    const ids = [...element.querySelectorAll("[id]")].map((node) => node.id)
    return ids.filter((id, index) => ids.indexOf(id) !== index)
  })
  expect(duplicateIds).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath(
      `pr588-variation-individual-${testInfo.project.name}.png`
    ),
  })
  await publish.click()
  await expect(dialog).not.toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      async () =>
        (await readTestRelayEvents({ kinds: [30402], authors: [pubkey] }))
          .length
    )
    .toBe(3)
  const events = await readTestRelayEvents({
    kinds: [30402],
    authors: [pubkey],
  })
  const smallEvent = events.find((event) =>
    event.tags.some((tag) => tag[0] === "spec" && tag[2] === "Small")
  )!
  const largeEvent = events.find((event) =>
    event.tags.some((tag) => tag[0] === "spec" && tag[2] === "Large")
  )!
  expect(smallEvent.tags).toContainEqual(["weight", "250", "g"])
  expect(smallEvent.tags).toContainEqual(["dim", "12x8x2", "cm"])
  expect(
    JSON.parse(
      smallEvent.tags.find(
        ([name]) => name === "conduit_shipping_adjustments"
      )![2]!
    )
  ).toMatchObject({ weightAllowanceGrams: 20, handling: { amount: 10 } })
  expect(
    largeEvent.tags.some(([name]) =>
      [
        "weight",
        "dim",
        "conduit_shipping_adjustments",
        "shipping_option",
      ].includes(name)
    )
  ).toBe(false)
  await activate(
    page.getByRole("button", { name: "Edit", exact: true }).first()
  )
  const edit = page.getByRole("dialog", { name: "Edit product family" })
  await expect(edit).toBeVisible()
  await edit
    .getByRole("button", { name: "Change fulfillment", exact: true })
    .click()
  const editShared = edit.getByRole("checkbox", {
    name: "Use the same weight and dimensions for all physical variations",
  })
  await expect(editShared).not.toBeChecked()
  const editSmall = edit.getByRole("group", {
    name: "Variation Small",
    exact: true,
  })
  await expect(
    editSmall.getByLabel("Shipping weight", { exact: true })
  ).toHaveValue("250")
  await edit
    .getByRole("region", { name: "Product shipping measurements", exact: true })
    .getByLabel("Shipping weight", { exact: true })
    .fill("900")
  await editShared.check()
  await expect(
    editSmall.getByLabel("Shipping weight", { exact: true })
  ).toHaveCount(0)
  await editSmall.getByText("Packing and handling", { exact: true }).click()
  await expect(
    editSmall.getByLabel("Extra packing weight", { exact: true })
  ).toHaveValue("20")
  await expect(
    editSmall.getByLabel("Handling per item", { exact: true })
  ).toHaveValue("10")
  await page.screenshot({
    path: testInfo.outputPath(
      `pr588-variation-shared-${testInfo.project.name}.png`
    ),
  })
  await edit.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(edit).not.toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => {
      const events = await readTestRelayEvents({
        kinds: [30402],
        authors: [pubkey],
      })
      return events
        .find((event) =>
          event.tags.some((tag) => tag[0] === "spec" && tag[2] === "Small")
        )
        ?.tags.find(([name]) => name === "weight")?.[1]
    })
    .toBe("900")
  await activate(
    page.getByRole("button", { name: "Edit", exact: true }).first()
  )
  await expect(editShared).toBeChecked()
})
