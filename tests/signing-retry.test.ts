import { describe, expect, it } from "bun:test"

import {
  isTransientNip07BridgeError,
  signNdkEventWithTransientNip07Retry,
  withTransientNip07Retry,
} from "../packages/core/src/protocol/signing-retry"

describe("transient NIP-07 signing retry", () => {
  it("recognizes browser extension bridge readiness failures", () => {
    expect(
      isTransientNip07BridgeError(
        new Error(
          "Could not establish connection. Receiving end does not exist."
        )
      )
    ).toBe(true)
    expect(isTransientNip07BridgeError(new Error("User rejected access"))).toBe(
      false
    )
  })

  it("retries transient bridge failures before returning the operation result", async () => {
    let calls = 0

    const result = await withTransientNip07Retry(
      async () => {
        calls += 1
        if (calls === 1) {
          throw new Error(
            "Could not establish connection. Receiving end does not exist."
          )
        }
        return "signed"
      },
      { retryDelaysMs: [0] }
    )

    expect(result).toBe("signed")
    expect(calls).toBe(2)
  })

  it("does not retry signer rejection or other non-transient failures", async () => {
    let calls = 0

    await expect(
      withTransientNip07Retry(
        async () => {
          calls += 1
          throw new Error("User rejected access")
        },
        { retryDelaysMs: [0] }
      )
    ).rejects.toThrow("User rejected access")

    expect(calls).toBe(1)
  })

  it("retries direct NDK event signing on transient bridge failures", async () => {
    let calls = 0
    const event = {
      sign: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error(
            "The message port closed before a response was received."
          )
        }
        return "sig"
      },
    }

    await expect(
      signNdkEventWithTransientNip07Retry(event as never, undefined, {
        retryDelaysMs: [0],
      })
    ).resolves.toBe("sig")
    expect(calls).toBe(2)
  })
})
