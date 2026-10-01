import { expect, test } from "@playwright/test"
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

const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

test("variation measurements require explicit sharing and preserve independent adjustments @merchant", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
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
  await page.getByRole("button", { name: "Add product" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add product" })
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
  await page.getByRole("button", { name: "Edit", exact: true }).first().click()
  const edit = page.getByRole("dialog", { name: "Edit product family" })
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
  await page.getByRole("button", { name: "Edit", exact: true }).first().click()
  await expect(editShared).toBeChecked()
})
