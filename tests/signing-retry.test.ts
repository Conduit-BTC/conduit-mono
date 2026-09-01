import { describe, expect, it } from "bun:test"

import * as signingRetry from "../packages/core/src/protocol/signing-retry"
import {
  isTransientNip07BridgeError,
  withTransientNip07ReadinessRetry,
} from "../packages/core/src/protocol/signing-retry"

describe("transient NIP-07 readiness retry", () => {
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
    expect(
      isTransientNip07BridgeError(new Error("NIP-07 extension not available"))
    ).toBe(true)
  })

  it("retries only a caller-provided readiness probe", async () => {
    let calls = 0

    const result = await withTransientNip07ReadinessRetry(
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
      withTransientNip07ReadinessRetry(
        async () => {
          calls += 1
          throw new Error("User rejected access")
        },
        { retryDelaysMs: [0] }
      )
    ).rejects.toThrow("User rejected access")

    expect(calls).toBe(1)
  })

  it("does not export helpers that can replay a complete signer operation", () => {
    expect(signingRetry).not.toHaveProperty("withTransientNip07Retry")
    expect(signingRetry).not.toHaveProperty(
      "signNdkEventWithTransientNip07Retry"
    )
  })
})
