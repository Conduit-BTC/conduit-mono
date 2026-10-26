import { expect, test } from "@playwright/test"
import { TEST_MERCHANT_PUBKEY, installTestSigner } from "./helpers/auth"

const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

test.use({ trace: "off", screenshot: "off", video: "off" })

test("merchant authenticated route errors keep failed disconnect retry @merchant", async ({
  page,
}) => {
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(
    `${merchantUrl}/products?__conduit_telemetry_test=react_error_boundary`
  )
  await page.getByRole("button", { name: "Open merchant account menu" }).click()
  await page.evaluate(() => {
    const removeItem = Storage.prototype.removeItem
    Storage.prototype.removeItem = function (key: string) {
      if (this === localStorage && key === "conduit:auth")
        throw new DOMException("Synthetic cleanup failure", "SecurityError")
      return removeItem.call(this, key)
    }
    ;(
      window as unknown as { restoreDisconnectStorage: () => void }
    ).restoreDisconnectStorage = () => {
      Storage.prototype.removeItem = removeItem
    }
  })
  await page.getByRole("menuitem", { name: "Disconnect", exact: true }).click()
  const retry = page.getByRole("button", {
    name: "Retry disconnect",
    exact: true,
  })
  await expect(retry).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Open merchant account menu" })
  ).toHaveCount(0)
  await page.evaluate(() =>
    (
      window as unknown as { restoreDisconnectStorage: () => void }
    ).restoreDisconnectStorage()
  )
  await retry.click()
  await expect(retry).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("conduit:auth")))
    .toBeNull()
})
