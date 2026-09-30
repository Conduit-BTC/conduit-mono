import { describe, expect, it } from "bun:test"
import {
  resolveCheckoutPartnerCode,
  sanitizeTelemetryEventProperties,
} from "@conduit/core"

describe("checkout referral source boundary", () => {
  it("requires one active registration and rejects per-click or malformed codes", () => {
    const registry = [
      { code: "marketplace_a", account: "public-marketplace-a", active: true },
    ]
    expect(resolveCheckoutPartnerCode("marketplace_a", registry)).toBe(
      "marketplace_a"
    )
    expect(resolveCheckoutPartnerCode("unique_click_123", registry)).toBeNull()
    expect(resolveCheckoutPartnerCode("MARKETPLACE_A", registry)).toBeNull()
    expect(
      resolveCheckoutPartnerCode("marketplace_a", [
        { ...registry[0]!, active: false },
      ])
    ).toBeNull()
  })

  it("never admits unknown partner codes into the provider event", () => {
    const base = {
      app: "market" as const,
      eventName: "checkout_handoff_result" as const,
    }
    expect(
      sanitizeTelemetryEventProperties({
        ...base,
        properties: {
          surface: "checkout",
          handoff_stage: "arrival",
          mode: "buy",
        },
      })
    ).toMatchObject({ handoff_stage: "arrival", mode: "buy" })
    expect(
      sanitizeTelemetryEventProperties({
        ...base,
        properties: {
          surface: "checkout",
          handoff_stage: "arrival",
          mode: "buy",
          partner_code: "unique_click_123",
        },
      })
    ).toBeNull()
    expect(
      sanitizeTelemetryEventProperties({
        ...base,
        properties: {
          surface: "checkout",
          handoff_stage: "arrival",
          mode: "buy",
          product: "naddr1secret",
        },
      })
    ).toBeNull()
  })
})
