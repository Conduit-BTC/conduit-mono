import { describe, expect, test } from "bun:test"
import { pasteLocalKeyFromClipboard } from "../packages/core/src/protocol/local-key"

function fixture(readText: () => Promise<string>) {
  return {
    value: "existing input",
    isConnected: true,
    disabled: false,
    ownerDocument: { defaultView: { navigator: { clipboard: { readText } } } },
  } as unknown as HTMLInputElement
}

describe("contained clipboard paste", () => {
  test("writes directly to the input and returns only success", async () => {
    const input = fixture(async () => "clipboard test text")
    expect(
      await pasteLocalKeyFromClipboard(input, new AbortController().signal)
    ).toBe(true)
    expect(input.value).toBe("clipboard test text")
  })

  for (const failure of ["denied", "empty", "unavailable"] as const) {
    test(`${failure} preserves the input and exposes only a generic error`, async () => {
      const input = fixture(async () => {
        if (failure === "denied")
          throw new Error("private clipboard diagnostic")
        return "   "
      })
      if (failure === "unavailable")
        Object.assign(input.ownerDocument, { defaultView: null })
      await expect(
        pasteLocalKeyFromClipboard(input, new AbortController().signal)
      ).rejects.toThrow("Clipboard paste unavailable")
      expect(input.value).toBe("existing input")
    })
  }

  for (const invalidation of ["abort", "detach", "disable"] as const) {
    test(`${invalidation} discards a delayed clipboard result`, async () => {
      let release!: (text: string) => void
      const input = fixture(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      const controller = new AbortController()
      const pending = pasteLocalKeyFromClipboard(input, controller.signal)
      if (invalidation === "abort") controller.abort()
      if (invalidation === "detach")
        Object.assign(input, { isConnected: false })
      if (invalidation === "disable") input.disabled = true
      release("late clipboard test text")
      expect(await pending).toBe(false)
      expect(input.value).toBe("existing input")
    })
  }

  test("an already canceled attempt never reads the clipboard", async () => {
    let reads = 0
    const input = fixture(async () => {
      reads += 1
      return "unused"
    })
    const controller = new AbortController()
    controller.abort()
    expect(await pasteLocalKeyFromClipboard(input, controller.signal)).toBe(
      false
    )
    expect(reads).toBe(0)
  })
})
