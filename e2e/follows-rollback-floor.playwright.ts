import { expect, test } from "@playwright/test"

import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  installTestSigner,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`

test("market storefront keeps browsing available while follow updates are paused", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await page.routeWebSocket(/^wss?:\/\//, (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return

      let frame: unknown
      try {
        frame = JSON.parse(message)
      } catch {
        return
      }
      if (!Array.isArray(frame) || frame[0] !== "REQ") return
      if (typeof frame[1] !== "string") return
      socket.send(JSON.stringify(["EOSE", frame[1]]))
    })
  })

  await page.goto(`${marketUrl}/store/${TEST_MERCHANT_PUBKEY}`, {
    waitUntil: "domcontentloaded",
  })

  await expect(page.getByRole("link", { name: "Shop" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible()

  const followButton = page.getByRole("button", {
    name: "Follow",
    exact: true,
  })
  await expect(followButton).toBeVisible()
  await expect(followButton).toBeDisabled()
  await expect(
    page.getByText("Follow updates are temporarily paused.", { exact: true })
  ).toBeVisible()

  const storeSearch = page.getByPlaceholder("Search items in this store")
  await expect(storeSearch).toBeEditable()
  await storeSearch.fill("coffee")
  await expect(page).toHaveURL(/(?:\?|&)q=coffee(?:&|$)/)
  await expect(storeSearch).toHaveValue("coffee")
})
