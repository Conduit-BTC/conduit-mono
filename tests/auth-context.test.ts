import { afterEach, describe, expect, it } from "bun:test"
import {
  connectNip07SignerForAuth,
  hasNip07,
  isTransientNip07ConnectError,
} from "../packages/core/src/context/AuthContext"

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

function createNip07Window(
  getPublicKey: () => Promise<string>
): Record<string, unknown> {
  return {
    nostr: {
      getPublicKey,
      signEvent: async (event: Record<string, unknown>) => ({
        ...event,
        id: "0".repeat(64),
        pubkey: "a".repeat(64),
        sig: "1".repeat(128),
      }),
    },
  }
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

  it("recognizes transient extension bridge failures", () => {
    expect(
      isTransientNip07ConnectError(
        new Error(
          "Could not establish connection. Receiving end does not exist."
        )
      )
    ).toBe(true)
    expect(
      isTransientNip07ConnectError(
        new Error("The message port closed before a response was received.")
      )
    ).toBe(true)
    expect(
      isTransientNip07ConnectError(new Error("User rejected access"))
    ).toBe(false)
  })

  it("retries transient signer bridge failures with a fresh NIP-07 signer", async () => {
    let calls = 0
    setTestWindow(
      createNip07Window(async () => {
        calls += 1
        if (calls === 1) {
          throw new Error(
            "Could not establish connection. Receiving end does not exist."
          )
        }

        return "a".repeat(64)
      })
    )

    const { user } = await connectNip07SignerForAuth("interactive", {
      retryDelaysMs: [0],
    })

    expect(calls).toBe(2)
    expect(user.pubkey).toBe("a".repeat(64))
  })

  it("does not retry signer rejection errors", async () => {
    let calls = 0
    setTestWindow(
      createNip07Window(async () => {
        calls += 1
        throw new Error("User rejected access")
      })
    )

    await expect(
      connectNip07SignerForAuth("interactive", {
        retryDelaysMs: [0],
      })
    ).rejects.toThrow("User rejected access")
    expect(calls).toBe(1)
  })

  it("replaces exhausted transient bridge failures with actionable copy", async () => {
    setTestWindow(
      createNip07Window(async () => {
        throw new Error(
          "Could not establish connection. Receiving end does not exist."
        )
      })
    )

    await expect(
      connectNip07SignerForAuth("interactive", {
        retryDelaysMs: [0],
      })
    ).rejects.toThrow("Your signer extension was not ready yet")
  })
})
