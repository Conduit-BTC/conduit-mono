import { describe, expect, it } from "bun:test"
import { verifyDeclarationReadBack } from "../packages/core/src/hooks/useInboxDeclaration"
import {
  sharedInboxDiscoveryRelayUrls,
  type InboxDeclarationResolution,
} from "../packages/core/src/protocol/private-message-routing"
import { toMessagingReadinessNoticeState } from "../packages/ui/src/components/MessagingReadinessNotice"

const SHARED_RELAY = sharedInboxDiscoveryRelayUrls()[0]!
const SIBLING_SHARED_RELAY = sharedInboxDiscoveryRelayUrls()[1]!

function resolution(
  overrides: Partial<InboxDeclarationResolution>
): InboxDeclarationResolution {
  return {
    pubkey: "owner",
    state: "declared",
    relayUrls: ["wss://inbox.example"],
    stale: false,
    fetchedAt: 0,
    ...overrides,
  }
}

describe("verifyDeclarationReadBack", () => {
  it("confirms a fresh declared read-back", () => {
    expect(verifyDeclarationReadBack(resolution({}))).toEqual({
      confirmed: true,
    })
  })

  it("confirms only the declaration event and relay set that was published", () => {
    const expected = {
      eventId: "new-declaration",
      relayUrls: ["wss://inbox-a.example", "wss://inbox-b.example"],
    }
    expect(
      verifyDeclarationReadBack(
        resolution({
          eventId: "new-declaration",
          sharedSourceRelayUrls: [SHARED_RELAY],
          relayUrls: ["wss://inbox-b.example/", "wss://inbox-a.example"],
          observation: {
            coverage: "complete",
            attemptedRelayUrls: [SHARED_RELAY],
            successfulRelayUrls: [SHARED_RELAY],
            failedRelayUrls: [],
            eventId: "new-declaration",
            eventSourceRelayUrls: [SHARED_RELAY],
          },
        }),
        expected
      )
    ).toEqual({ confirmed: true })
    expect(() =>
      verifyDeclarationReadBack(
        resolution({
          eventId: "older-declaration",
          relayUrls: ["wss://inbox-a.example", "wss://inbox-b.example"],
        }),
        expected
      )
    ).toThrow("not discoverable")
    expect(
      verifyDeclarationReadBack(
        resolution({
          eventId: "new-declaration",
          relayUrls: ["wss://inbox-a.example"],
        }),
        expected
      )
    ).toEqual({ confirmed: false })
  })

  it("reports pending confirmation for a degraded read-back", () => {
    expect(verifyDeclarationReadBack(resolution({ stale: true }))).toEqual({
      confirmed: false,
    })
    expect(
      verifyDeclarationReadBack(
        resolution({ state: "lookup_unavailable", relayUrls: [] })
      )
    ).toEqual({ confirmed: false })
    expect(
      verifyDeclarationReadBack(
        resolution({ state: "lookup_partial", relayUrls: [] })
      )
    ).toEqual({ confirmed: false })
  })

  it("accepts exact positive shared evidence despite a sibling relay failure", () => {
    const expected = {
      eventId: "new-declaration",
      relayUrls: ["wss://inbox.example"],
    }
    expect(
      verifyDeclarationReadBack(
        resolution({
          stale: true,
          eventId: expected.eventId,
          sharedSourceRelayUrls: [SHARED_RELAY],
          observation: {
            coverage: "partial",
            attemptedRelayUrls: [SHARED_RELAY, SIBLING_SHARED_RELAY],
            successfulRelayUrls: [SHARED_RELAY],
            failedRelayUrls: [SIBLING_SHARED_RELAY],
            eventId: expected.eventId,
            eventSourceRelayUrls: [SHARED_RELAY],
          },
        }),
        expected
      )
    ).toEqual({ confirmed: true })
  })

  it("does not accept stale owner-only provenance as shared read-back", () => {
    const eventId = "new-declaration"
    expect(
      verifyDeclarationReadBack(
        resolution({
          stale: true,
          eventId,
          observation: {
            coverage: "partial",
            attemptedRelayUrls: ["wss://shared.example"],
            successfulRelayUrls: ["wss://shared.example"],
            failedRelayUrls: [],
            eventId,
            eventSourceRelayUrls: ["wss://owner-only.example"],
          },
        }),
        { eventId, relayUrls: ["wss://inbox.example"] }
      )
    ).toEqual({ confirmed: false })
  })

  it("does not confirm an exact shared read-back that failed durable merge", () => {
    const eventId = "new-declaration"
    expect(
      verifyDeclarationReadBack(
        resolution({
          eventId,
          sharedSourceRelayUrls: [],
          observation: {
            coverage: "complete",
            attemptedRelayUrls: [SHARED_RELAY],
            successfulRelayUrls: [SHARED_RELAY],
            failedRelayUrls: [],
            eventId,
            eventSourceRelayUrls: [SHARED_RELAY],
          },
        }),
        { eventId, relayUrls: ["wss://inbox.example"] }
      )
    ).toEqual({ confirmed: false })
  })

  it("throws when a complete read-back cannot find the declaration", () => {
    expect(() =>
      verifyDeclarationReadBack(
        resolution({ state: "not_observed", relayUrls: [] })
      )
    ).toThrow("not discoverable yet")
    expect(() =>
      verifyDeclarationReadBack(
        resolution({ state: "malformed", relayUrls: [] })
      )
    ).toThrow("not discoverable yet")
    expect(() =>
      verifyDeclarationReadBack(
        resolution({ state: "signed_empty", relayUrls: [] })
      )
    ).toThrow("not discoverable yet")
    expect(() =>
      verifyDeclarationReadBack(
        resolution({
          state: "distribution_pending",
          relayUrls: [],
          observation: {
            coverage: "complete",
            attemptedRelayUrls: ["wss://shared.example"],
            successfulRelayUrls: ["wss://shared.example"],
            failedRelayUrls: [],
            eventSourceRelayUrls: [],
          },
        }),
        {
          eventId: "expected-declaration",
          relayUrls: ["wss://inbox.example"],
        }
      )
    ).toThrow("not discoverable yet")
    expect(() =>
      verifyDeclarationReadBack(
        resolution({
          state: "distribution_pending",
          relayUrls: [],
          observation: {
            coverage: "complete",
            attemptedRelayUrls: ["wss://shared.example"],
            successfulRelayUrls: ["wss://shared.example"],
            failedRelayUrls: [],
            eventId: "different-declaration",
            eventSourceRelayUrls: ["wss://shared.example"],
          },
        }),
        {
          eventId: "expected-declaration",
          relayUrls: ["wss://inbox.example"],
        }
      )
    ).toThrow("not discoverable yet")
    expect(() =>
      verifyDeclarationReadBack(
        resolution({
          eventId: "newer-durable-declaration",
          observation: {
            coverage: "partial",
            attemptedRelayUrls: [
              "wss://shared-a.example",
              "wss://shared-b.example",
            ],
            successfulRelayUrls: ["wss://shared-a.example"],
            failedRelayUrls: ["wss://shared-b.example"],
            eventId: "expected-declaration",
            eventSourceRelayUrls: ["wss://shared-a.example"],
          },
        }),
        {
          eventId: "expected-declaration",
          relayUrls: ["wss://inbox.example"],
        }
      )
    ).toThrow("not discoverable yet")
  })

  it("keeps degraded pending read-back retryable", () => {
    expect(
      verifyDeclarationReadBack(
        resolution({
          state: "distribution_pending",
          relayUrls: [],
          observation: {
            coverage: "partial",
            attemptedRelayUrls: [
              "wss://shared-a.example",
              "wss://shared-b.example",
            ],
            successfulRelayUrls: ["wss://shared-a.example"],
            failedRelayUrls: ["wss://shared-b.example"],
            eventSourceRelayUrls: [],
          },
        }),
        {
          eventId: "expected-declaration",
          relayUrls: ["wss://inbox.example"],
        }
      )
    ).toEqual({ confirmed: false })
  })
})
describe("toMessagingReadinessNoticeState", () => {
  it("keeps ready/loading out of warning copy and maps every blocking state", () => {
    expect(toMessagingReadinessNoticeState("ready")).toBeNull()
    expect(toMessagingReadinessNoticeState("loading")).toBeNull()
    for (const state of [
      "not_observed",
      "distribution_pending",
      "signed_empty",
      "malformed",
      "lookup_failed",
      "lookup_partial",
      "lookup_unavailable",
    ] as const) {
      expect(toMessagingReadinessNoticeState(state)).toBe(state)
    }
  })
})
