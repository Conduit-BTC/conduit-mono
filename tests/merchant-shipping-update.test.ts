import { describe, expect, it } from "bun:test"
import { prepareShippingUpdate } from "../apps/merchant/src/lib/shipping-update"

describe("prepareShippingUpdate", () => {
  it("requires a non-empty tracking code and carrier", () => {
    expect(() =>
      prepareShippingUpdate({
        trackingNumber: "  ",
        carrier: "UPS",
        trackingUrl: "",
        note: "",
      })
    ).toThrow("Tracking code is required.")

    expect(() =>
      prepareShippingUpdate({
        trackingNumber: "1Z999",
        carrier: "  ",
        trackingUrl: "",
        note: "",
      })
    ).toThrow("Carrier is required.")
  })

  it("trims required values and keeps URL and notes optional", () => {
    expect(
      prepareShippingUpdate({
        trackingNumber: " 1Z999 ",
        carrier: " UPS ",
        trackingUrl: "",
        note: "  ",
      })
    ).toEqual({
      trackingNumber: "1Z999",
      carrier: "UPS",
      trackingUrl: undefined,
      note: undefined,
    })
  })
})
