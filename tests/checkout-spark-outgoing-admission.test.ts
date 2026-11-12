import { describe, expect, it } from "bun:test"
import {
  CheckoutSparkOutgoingNotAdmittedError,
  sendAfterPreAdmissionGuard,
} from "../packages/core/src/protocol/checkout-spark-outgoing-admission"

describe("sendAfterPreAdmissionGuard", () => {
  it("types a rejected pre-send currency check as not admitted, without sending", async () => {
    let sends = 0
    const thrown = await sendAfterPreAdmissionGuard(
      async () => {
        throw new Error("authority ended")
      },
      async () => {
        sends += 1
        return "sent"
      }
    ).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
    expect(sends).toBe(0)
  })

  it("keeps a send rejection untyped (possibly sent)", async () => {
    const failure = new Error("sdk failed after entry")
    const thrown = await sendAfterPreAdmissionGuard(
      () => undefined,
      async () => {
        throw failure
      }
    ).catch((error: unknown) => error)
    expect(thrown).toBe(failure)
    expect(thrown).not.toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
  })

  it("keeps a post-send currency rejection untyped (possibly sent)", async () => {
    let checks = 0
    let sends = 0
    const thrown = await sendAfterPreAdmissionGuard(
      () => {
        checks += 1
        if (checks > 1) throw new Error("authority ended after send")
      },
      async () => {
        sends += 1
        return "sent"
      }
    ).catch((error: unknown) => error)
    expect(sends).toBe(1)
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
  })

  it("returns the send result when both checks pass", async () => {
    await expect(
      sendAfterPreAdmissionGuard(
        () => undefined,
        async () => "sent"
      )
    ).resolves.toBe("sent")
  })
})
