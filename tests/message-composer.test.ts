import { describe, expect, it } from "bun:test"

import { shouldSendMessageOnKeyDown } from "@conduit/ui"

describe("message composer keyboard handling", () => {
  it("sends on an unmodified Enter key", () => {
    expect(
      shouldSendMessageOnKeyDown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 13,
      })
    ).toBe(true)
  })

  it("keeps Shift+Enter as a newline", () => {
    expect(
      shouldSendMessageOnKeyDown({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
        keyCode: 13,
      })
    ).toBe(false)
  })

  it("does not submit while WebKit or an IME is composing", () => {
    expect(
      shouldSendMessageOnKeyDown({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
        keyCode: 13,
      })
    ).toBe(false)
    expect(
      shouldSendMessageOnKeyDown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 229,
      })
    ).toBe(false)
  })
})
