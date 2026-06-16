import { afterEach, describe, expect, it } from "bun:test"
import { hasNip07 } from "../packages/core/src/context/AuthContext"

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window"
)

function setTestWindow(value: unknown): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  })
}

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor)
    return
  }

  Reflect.deleteProperty(globalThis, "window")
})

describe("NIP-07 availability", () => {
  it("requires the mandatory NIP-07 getPublicKey and signEvent methods", () => {
    setTestWindow({
      nostr: {
        getPublicKey: async () => "a".repeat(64),
      },
    })

    expect(hasNip07()).toBe(false)

    setTestWindow({
      nostr: {
        getPublicKey: async () => "a".repeat(64),
        signEvent: async (event: Record<string, unknown>) => ({
          ...event,
          id: "0".repeat(64),
          pubkey: "a".repeat(64),
          sig: "1".repeat(128),
        }),
      },
    })

    expect(hasNip07()).toBe(true)
  })
})
