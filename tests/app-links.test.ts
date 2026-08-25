import { describe, expect, it } from "bun:test"

import {
  buildMerchantOrderReviewUrl,
  inferConduitAppOrigin,
} from "@conduit/core"

describe("paired Conduit app origins", () => {
  it("falls back to the canonical production apps", () => {
    expect(inferConduitAppOrigin("market", undefined)).toBe(
      "https://shop.conduit.market"
    )
    expect(inferConduitAppOrigin("merchant", undefined)).toBe(
      "https://sell.conduit.market"
    )
  })

  it("preserves preview labels in both directions", () => {
    expect(
      inferConduitAppOrigin("merchant", {
        hostname: "fix-293.conduit-market-coo.pages.dev",
        protocol: "https:",
        port: "",
      })
    ).toBe("https://fix-293.conduit-merchant-33n.pages.dev")
    expect(
      inferConduitAppOrigin("market", {
        hostname: "fix-293.conduit-merchant-signet.pages.dev",
        protocol: "https:",
        port: "",
      })
    ).toBe("https://fix-293.conduit-market-signet.pages.dev")
  })

  it("pairs local ports in both directions", () => {
    expect(
      inferConduitAppOrigin("merchant", {
        hostname: "localhost",
        protocol: "http:",
        port: "3000",
      })
    ).toBe("http://localhost:3001")
    expect(
      inferConduitAppOrigin("market", {
        hostname: "127.0.0.1",
        protocol: "http:",
        port: "7001",
      })
    ).toBe("http://127.0.0.1:7000")
    expect(
      inferConduitAppOrigin("merchant", {
        hostname: "mybox.tailnet.ts.net",
        protocol: "http:",
        port: "7000",
      })
    ).toBe("http://mybox.tailnet.ts.net:7001")
  })
})

describe("Merchant order review URLs", () => {
  it("encodes the order id on the selected Merchant origin", () => {
    expect(
      buildMerchantOrderReviewUrl(
        "https://fix-293.conduit-merchant-33n.pages.dev",
        "order /?&=✓"
      )
    ).toBe(
      "https://fix-293.conduit-merchant-33n.pages.dev/orders?order=order+%2F%3F%26%3D%E2%9C%93"
    )
  })

  it("rejects unsafe origins", () => {
    expect(() =>
      buildMerchantOrderReviewUrl(
        "https://sell.conduit.market/orders?other=value",
        "order-id"
      )
    ).toThrow("safe merchant origin")
    expect(() =>
      buildMerchantOrderReviewUrl("http://example.com", "order-id")
    ).toThrow("safe merchant origin")
  })

  it("accepts a forwarded local Merchant dev origin", () => {
    expect(
      buildMerchantOrderReviewUrl(
        "http://mybox.tailnet.ts.net:7001",
        "order-id"
      )
    ).toBe("http://mybox.tailnet.ts.net:7001/orders?order=order-id")
  })
})
