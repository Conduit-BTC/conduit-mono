import { describe, expect, it } from "bun:test"

import {
  buildClientErrorTelemetryProperties,
  createClientErrorRateLimiter,
  getClientErrorFamily,
  getClientErrorMessage,
  sanitizeTelemetryEventProperties,
} from "@conduit/core"

describe("client error telemetry", () => {
  it("classifies errors without inspecting messages or stacks", () => {
    expect(getClientErrorFamily(new TypeError("private product title"))).toBe(
      "type_error"
    )
    expect(
      getClientErrorFamily(new ReferenceError("private payment detail"))
    ).toBe("reference_error")
    expect(getClientErrorFamily(new Error("private order detail"))).toBe(
      "error"
    )
    expect(getClientErrorFamily("private rejection detail")).toBe("non_error")
    expect(
      getClientErrorFamily(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("private proxy detail")
            },
          }
        )
      )
    ).toBe("non_error")
  })

  it("extracts display messages without trusting hostile thrown values", () => {
    const fallback = "An unexpected error occurred."
    const prototypeProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("private proxy prototype detail")
        },
      }
    )
    const messageProxy = new Proxy(new Error("private proxy message detail"), {
      get(target, property, receiver) {
        if (property === "message") {
          throw new Error("private proxy property detail")
        }
        return Reflect.get(target, property, receiver)
      },
    })

    expect(getClientErrorMessage(new Error("Readable error"), fallback)).toBe(
      "Readable error"
    )
    expect(getClientErrorMessage("private rejection detail", fallback)).toBe(
      fallback
    )
    expect(getClientErrorMessage(prototypeProxy, fallback)).toBe(fallback)
    expect(getClientErrorMessage(messageProxy, fallback)).toBe(fallback)
  })

  it("builds an enum-only payload for the shared sanitizer", () => {
    const error = new TypeError("private message")

    expect(
      sanitizeTelemetryEventProperties({
        app: "market",
        eventName: "client_error_result",
        properties: buildClientErrorTelemetryProperties({
          error,
          source: "react_error_boundary",
        }),
      })
    ).toEqual({
      action: "react_error_boundary",
      app: "market",
      event_family: "type_error",
      event_name: "client_error_result",
      mode: "handled",
      status: "failure",
      surface: "browser",
    })
  })

  it("deduplicates repeated signatures and rate-limits bursts", () => {
    const limiter = createClientErrorRateLimiter({
      dedupeMs: 10_000,
      maxEvents: 2,
      windowMs: 60_000,
    })

    expect(limiter.shouldRecord("window_error:type_error:/products", 0)).toBe(
      true
    )
    expect(
      limiter.shouldRecord("window_error:type_error:/products", 1_000)
    ).toBe(false)
    expect(
      limiter.shouldRecord("unhandled_rejection:error:/checkout", 1_000)
    ).toBe(true)
    expect(limiter.shouldRecord("window_error:error:/cart", 2_000)).toBe(false)
    expect(limiter.shouldRecord("window_error:error:/cart", 60_000)).toBe(true)
  })
})
