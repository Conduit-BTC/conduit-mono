import { describe, expect, test } from "bun:test"
import { clearLocalKeyClipboard } from "../packages/ui/src/components/local-key-clipboard"

function fixture(clipboard?: { writeText?: (value: string) => Promise<void> }) {
  return {
    isConnected: true,
    disabled: false,
    ownerDocument: { defaultView: { navigator: { clipboard } } },
  } as unknown as HTMLInputElement
}

describe("write-only local-key clipboard clearing", () => {
  test("writes only empty text and never reads clipboard or field contents", async () => {
    const writes: string[] = []
    const input = fixture({
      writeText: async (value) => {
        writes.push(value)
      },
      get readText(): never {
        throw new Error("Unexpected read")
      },
    } as { writeText: (value: string) => Promise<void> })
    Object.defineProperty(input, "value", {
      get() {
        throw new Error("Unexpected field read")
      },
    })
    expect(await clearLocalKeyClipboard(input)).toBe(true)
    expect(writes).toEqual([""])
  })

  test("success waits for browser acknowledgement", async () => {
    let release!: () => void
    let completed = false
    const input = fixture({
      writeText: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    })
    const pending = clearLocalKeyClipboard(input).then((result) => {
      completed = true
      return result
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    expect(await pending).toBe(true)
  })

  for (const failure of [
    "missing",
    "unsupported",
    "denied",
    "throws",
  ] as const) {
    test(`${failure} exposes only failure without retrying`, async () => {
      let writes = 0
      const input = fixture(
        failure === "missing"
          ? undefined
          : {
              writeText:
                failure === "unsupported"
                  ? undefined
                  : () => {
                      writes += 1
                      if (failure === "throws")
                        throw new Error("Private browser detail")
                      return Promise.reject(new Error("Private browser detail"))
                    },
            }
      )
      expect(await clearLocalKeyClipboard(input)).toBe(false)
      expect(writes).toBe(failure === "denied" || failure === "throws" ? 1 : 0)
    })
  }

  for (const invalidation of ["detach", "disable"] as const) {
    test(`${invalidation} never initiates a write`, async () => {
      let writes = 0
      const input = fixture({
        writeText: async () => {
          writes += 1
        },
      })
      if (invalidation === "detach")
        Object.assign(input, { isConnected: false })
      else input.disabled = true
      expect(await clearLocalKeyClipboard(input)).toBe(false)
      expect(writes).toBe(0)
    })
  }
})
