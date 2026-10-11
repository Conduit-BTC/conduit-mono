import { expect, test, type Locator } from "@playwright/test"
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
} from "./helpers/auth"
import { recordSmokeDiagnostic } from "./helpers/smoke-diagnostics"

const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

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
  await expect(
    page.getByRole("button", {
      name: "Open merchant account menu",
      exact: true,
    })
  ).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const trigger = page.getByRole("button", { name: "Add product" }).first()
  await expect(trigger).toBeEnabled()
  // Preserve one activation and capture only delivery, mount and geometry state.
  const diagnosticHandle = await trigger.evaluateHandle((element) => {
    const observations = {
      pointerDownOnTrigger: false,
      pointerUpOnTrigger: false,
      clickOnTrigger: false,
      dialogMounted: false,
      dialogRemoved: false,
      fontsAtClick: "unknown",
    }
    const listeners = ["pointerdown", "pointerup", "click"].map((type) => {
      const listener = (event: Event) => {
        const onTrigger =
          event.target instanceof Node && element.contains(event.target)
        if (type === "pointerdown")
          observations.pointerDownOnTrigger = onTrigger
        if (type === "pointerup") observations.pointerUpOnTrigger = onTrigger
        if (type === "click") {
          observations.clickOnTrigger = onTrigger
          observations.fontsAtClick = document.fonts.status
        }
      }
      document.addEventListener(type, listener, true)
      return { type, listener }
    })
    const containsDialog = (node: Node) =>
      node instanceof Element &&
      (node.matches('[role="dialog"]') ||
        !!node.querySelector('[role="dialog"]'))
    const observer = new MutationObserver((changes) => {
      for (const change of changes) {
        if ([...change.addedNodes].some(containsDialog))
          observations.dialogMounted = true
        if ([...change.removedNodes].some(containsDialog))
          observations.dialogRemoved = true
      }
    })
    observer.observe(document, { childList: true, subtree: true })
    return {
      read() {
        const rect = element.getBoundingClientRect()
        return {
          ...observations,
          dialogPresent: !!document.querySelector('[role="dialog"]'),
          triggerEnabled:
            element.isConnected && !element.hasAttribute("disabled"),
          triggerX: rect.x,
          triggerY: rect.y,
          triggerWidth: rect.width,
          triggerHeight: rect.height,
        }
      },
      dispose() {
        observer.disconnect()
        for (const { type, listener } of listeners)
          document.removeEventListener(type, listener, true)
      },
    }
  })
  const dialog = page.getByRole("dialog", { name: "Add product" })
  try {
    await activate(trigger)
    await expect(dialog).toBeVisible()
  } catch (error) {
    recordSmokeDiagnostic(
      testInfo,
      "variation-dialog-open",
      await diagnosticHandle.evaluate((probe) => probe.read())
    )
    throw error
  } finally {
    await diagnosticHandle.evaluate((probe) => probe.dispose())
    await diagnosticHandle.dispose()
  }
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
