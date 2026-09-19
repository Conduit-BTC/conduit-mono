import { expect, test } from "@playwright/test"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { installTestSigner } from "./helpers/auth"

const merchantUrl =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")

test("loaded product preview stays visible while its title changes @merchant", async ({
  page,
}) => {
  const pubkey = getPublicKey(generateSecretKey())
  const imageUrl = "https://cdn.jsdelivr.net/cover.svg"
  await installTestSigner(page, pubkey)
  await page.route(imageUrl, (route) =>
    route.fulfill({
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#8b5cf6"/></svg>',
      contentType: "image/svg+xml",
    })
  )
  await page.goto(`${merchantUrl}/products`)

  await page.getByRole("button", { name: "Add product" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await dialog.getByLabel("Title").fill("Original title")
  await dialog.getByLabel("Primary image URL").fill(`  ${imageUrl}  `)

  const previewImage = dialog.locator(`img[src="${imageUrl}"]`)
  await expect(previewImage).toHaveClass(/opacity-100/)
  const addImage = dialog.getByRole("button", {
    name: "Add another image",
    exact: true,
  })
  await expect(addImage).toBeEnabled()
  await addImage.click()
  await expect(dialog.getByLabel("Image 2 URL")).toBeFocused()
  await dialog.getByLabel("Title").fill("Updated title")

  await expect(previewImage).toHaveAttribute("alt", "Updated title")
  await expect(previewImage).toHaveClass(/opacity-100/)
})
