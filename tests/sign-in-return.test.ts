import { describe, expect, it } from "bun:test"
import { parseSignInReturnTo } from "../packages/core/src/utils/sign-in-return"

describe("sign-in navigation intent", () => {
  it("preserves protected route query state", () => {
    expect(
      parseSignInReturnTo("/messages?tab=dms&merchant=example", "market")
    ).toBe("/messages?tab=dms&merchant=example")
    expect(
      parseSignInReturnTo("/products?eventMarket=example", "merchant")
    ).toBe("/products?eventMarket=example")
  })
  it("rejects external, malformed, unsupported and action destinations", () => {
    for (const value of [
      "https://example.com/messages",
      "//example.com/messages",
      "/\\example.com/messages",
      "/messages\n",
      "/%6dessages",
      "/checkout",
      "/wallet",
      "/about",
      "/products",
      null,
      {},
      "/messages?" + "a".repeat(4096),
    ]) {
      expect(parseSignInReturnTo(value, "market")).toBeUndefined()
    }
    expect(parseSignInReturnTo("/preferences", "merchant")).toBeUndefined()
  })
  it("discards fragment instructions", () => {
    expect(parseSignInReturnTo("/orders#send", "market")).toBe("/orders")
  })
})
