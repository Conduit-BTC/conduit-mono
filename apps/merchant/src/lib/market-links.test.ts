import { pubkeyToNpub } from "@conduit/core"
import {
  getProfileUrl,
  getStorefrontUrl,
  inferMarketOrigin,
} from "./market-links"

declare function test(name: string, fn: () => void): void
declare function expect(actual: unknown): {
  toBe(expected: unknown): void
}

const pubkey = "0".repeat(64)
const npub = pubkeyToNpub(pubkey)

test("uses the Market app as the canonical production origin", () => {
  expect(inferMarketOrigin()).toBe("https://shop.conduit.market")
})

test("builds storefront and profile links on the Market app", () => {
  expect(getStorefrontUrl(pubkey)).toBe(
    `https://shop.conduit.market/store/${npub}`
  )
  expect(getProfileUrl(pubkey)).toBe(`https://shop.conduit.market/u/${npub}`)
})
