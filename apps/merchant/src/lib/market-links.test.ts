import { encodeEventMarketNaddr, pubkeyToNpub } from "@conduit/core"
import {
  getEventMarketUrl,
  getProfileUrl,
  getProductUrl,
  getStorefrontUrl,
  inferMarketOrigin,
} from "./market-links"

declare function test(name: string, fn: () => void): void
declare function expect(actual: unknown): {
  toBe(expected: unknown): void
}

const pubkey = "0".repeat(64)
const npub = pubkeyToNpub(pubkey)
const eventNaddr = encodeEventMarketNaddr(`30405:${pubkey}:event-catalog`)

test("uses the Market app as the canonical production origin", () => {
  expect(inferMarketOrigin()).toBe("https://shop.conduit.market")
})

test("builds storefront and profile links on the Market app", () => {
  expect(getStorefrontUrl(pubkey)).toBe(
    `https://shop.conduit.market/store/${npub}`
  )
  expect(getProfileUrl(pubkey)).toBe(`https://shop.conduit.market/u/${npub}`)
})

test("builds canonical event catalog links on the Market app", () => {
  expect(getEventMarketUrl(eventNaddr)).toBe(
    `https://shop.conduit.market/events/${eventNaddr}`
  )
})

test("builds canonical buyer-facing product links on the Market app", () => {
  const addressId = `30402:${pubkey}:product-one`
  const productUrl = new URL(getProductUrl(addressId))

  expect(productUrl.origin).toBe("https://shop.conduit.market")
  expect(productUrl.pathname.startsWith("/products/naddr1")).toBe(true)
})
