import { describe, expect, it } from "bun:test"
import {
  canCaptureAnonymousTelemetry,
  sanitizeAnalyticsPath,
} from "@conduit/core"

describe("analytics route sanitization", () => {
  it("collapses known dynamic commerce routes", () => {
    expect(sanitizeAnalyticsPath("/products/bitcoin-book")).toBe(
      "/products/:productId"
    )
    expect(sanitizeAnalyticsPath("/orders/order-1234567890abcdef")).toBe(
      "/orders/:orderId"
    )
    expect(sanitizeAnalyticsPath("/store/npub1merchant")).toBe("/store/:pubkey")
    expect(sanitizeAnalyticsPath("/u/nprofile1buyer")).toBe("/u/:profileRef")
  })

  it("preserves known static product creation routes", () => {
    expect(sanitizeAnalyticsPath("/products/new")).toBe("/products/new")
  })

  it("drops query strings and collapses identifier-like unknown segments", () => {
    expect(
      sanitizeAnalyticsPath(
        "/debug/abcdef1234567890abcdef1234567890?invoice=lnbc..."
      )
    ).toBe("/debug/:id")
  })
})

describe("anonymous telemetry gate", () => {
  it("allows anonymous telemetry before signer connection", () => {
    expect(canCaptureAnonymousTelemetry(false)).toBe(true)
  })

  it("pauses telemetry after signer connection without consent", () => {
    expect(canCaptureAnonymousTelemetry(true)).toBe(false)
  })

  it("can be explicitly enabled for a connected session by future consent UI", () => {
    expect(canCaptureAnonymousTelemetry(true, true)).toBe(true)
  })
})
