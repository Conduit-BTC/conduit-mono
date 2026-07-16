import { describe, expect, it } from "bun:test"
import type { PublishWithPlannerResult } from "@conduit/core"
import {
  buildLocalProductDeliveryNotice,
  buildLocalProductRetryNotice,
  buildProductDeliveryNotice,
  formatProductRelayUrls,
} from "../apps/merchant/src/lib/product-delivery"

function deliveryResult(
  overrides: Partial<PublishWithPlannerResult> = {}
): PublishWithPlannerResult {
  return {
    plan: {
      intent: "author_event",
      primaryRelayUrls: [],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    },
    attemptedRelayUrls: [],
    successfulRelayUrls: [],
    failedRelayUrls: [],
    relayFailureMessages: {},
    ...overrides,
  }
}

describe("merchant product delivery notices", () => {
  it("shows the signed local projection while relay delivery is pending", () => {
    const publish = buildLocalProductDeliveryNotice("publish")
    const deletion = buildLocalProductDeliveryNotice("delete")

    expect(publish.state).toBe("delivering")
    expect(publish.detail).toContain("visible locally")
    expect(deletion.state).toBe("delivering")
    expect(deletion.detail).toContain("hidden locally")
  })

  it("summarizes successful relay acknowledgements without duplicating counts", () => {
    const notice = buildProductDeliveryNotice(
      "publish",
      deliveryResult({
        attemptedRelayUrls: ["wss://relay.one"],
        successfulRelayUrls: ["wss://relay.one"],
      })
    )

    expect(notice.state).toBe("delivered")
    expect(notice.detail).toContain("ACKed 1 of 1 relay.")
    expect(notice.detail).not.toContain("1 of 1 1 relay")
  })

  it("keeps partial delivery visible with actionable retry guidance", () => {
    const notice = buildProductDeliveryNotice(
      "delete",
      deliveryResult({
        attemptedRelayUrls: ["wss://relay.one", "wss://relay.two"],
        successfulRelayUrls: ["wss://relay.one"],
        failedRelayUrls: ["wss://relay.two"],
        relayFailureMessages: {
          "wss://relay.two": "rate-limited: retry later",
        },
      })
    )

    expect(notice.state).toBe("partial")
    expect(notice.detail).toContain("Use Retry delivery")
    expect(notice.failedRelayUrls).toEqual(["wss://relay.two"])
  })

  it("accumulates relay acknowledgements across retry attempts", () => {
    const firstAttempt = buildProductDeliveryNotice(
      "delete",
      deliveryResult({
        attemptedRelayUrls: [
          "wss://relay.one",
          "wss://relay.two",
          "wss://relay.three",
        ],
        successfulRelayUrls: ["wss://relay.one", "wss://relay.three"],
        failedRelayUrls: ["wss://relay.two"],
      })
    )
    const retry = buildProductDeliveryNotice(
      "delete",
      deliveryResult({
        attemptedRelayUrls: [
          "wss://relay.one",
          "wss://relay.two",
          "wss://relay.three",
        ],
        successfulRelayUrls: ["wss://relay.two", "wss://relay.three"],
        failedRelayUrls: ["wss://relay.one"],
      }),
      firstAttempt
    )

    expect(retry.state).toBe("delivered")
    expect(retry.detail).toContain("ACKed 3 of 3 relays.")
    expect(retry.failedRelayUrls).toEqual([])
  })

  it("describes a local retry without claiming relay acknowledgement", () => {
    const notice = buildLocalProductRetryNotice("publish")

    expect(notice.state).toBe("retry_needed")
    expect(notice.detail).toContain("remains visible locally")
    expect(notice.successfulRelayUrls).toEqual([])
  })

  it("caps the visible relay list", () => {
    expect(
      formatProductRelayUrls([
        "wss://one",
        "wss://two",
        "wss://three",
        "wss://four",
        "wss://five",
      ])
    ).toBe("wss://one, wss://two, wss://three, wss://four, +1 more")
  })
})
