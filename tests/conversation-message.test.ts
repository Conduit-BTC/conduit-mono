import { describe, expect, it } from "bun:test"
import { getConversationMessageDisplayContent } from "@conduit/ui"

describe("getConversationMessageDisplayContent", () => {
  it("extracts the readable text from a legacy order-status DM", () => {
    const content = JSON.stringify({
      id: "2e2811f8-d38e-4929-a937-7b41e5fa6f2e",
      type: 2,
      message: "Your order has been declined.",
      paid: false,
      shipped: false,
      cancelled: true,
    })

    expect(getConversationMessageDisplayContent(content)).toBe(
      "Your order has been declined."
    )
  })

  it("preserves ordinary JSON sent as chat text", () => {
    const content = JSON.stringify({ message: "keep the full object" })

    expect(getConversationMessageDisplayContent(content)).toBe(content)
  })

  it("preserves non-JSON chat text", () => {
    expect(getConversationMessageDisplayContent("Hello from Market")).toBe(
      "Hello from Market"
    )
  })
})
