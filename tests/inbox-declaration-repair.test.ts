import { describe, expect, it } from "bun:test"
import { verifyDeclarationReadBack } from "../packages/core/src/hooks/useInboxDeclaration"
import type { InboxDeclarationResolution } from "../packages/core/src/protocol/private-message-routing"
import {
  canPublishInboxDeclaration,
  MAX_INBOX_RELAY_SELECTION,
} from "../packages/ui/src/components/PrivateInboxSection"

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
          relayUrls: ["wss://inbox-b.example/", "wss://inbox-a.example"],
        }),
        expected
      )
    ).toEqual({ confirmed: true })
    expect(
      verifyDeclarationReadBack(
        resolution({
          eventId: "older-declaration",
          relayUrls: ["wss://inbox-a.example", "wss://inbox-b.example"],
        }),
        expected
      )
    ).toEqual({ confirmed: false })
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

  it("throws when a complete read-back cannot find the declaration", () => {
    expect(() =>
      verifyDeclarationReadBack(
        resolution({ state: "not_declared", relayUrls: [] })
      )
    ).toThrow("not discoverable yet")
    expect(() =>
      verifyDeclarationReadBack(
        resolution({ state: "malformed", relayUrls: [] })
      )
    ).toThrow("not discoverable yet")
  })
})

describe("canPublishInboxDeclaration", () => {
  const base = {
    status: "not_declared" as const,
    stale: false,
    selectedCount: 1,
    selectionChanged: true,
  }

  it("allows publishing a first or repaired declaration", () => {
    expect(canPublishInboxDeclaration(base)).toBe(true)
    expect(canPublishInboxDeclaration({ ...base, status: "malformed" })).toBe(
      true
    )
  })

  it("allows updating a fresh ready declaration only when the selection changed", () => {
    expect(canPublishInboxDeclaration({ ...base, status: "ready" })).toBe(true)
    expect(
      canPublishInboxDeclaration({
        ...base,
        status: "ready",
        selectionChanged: false,
      })
    ).toBe(false)
  })

  it("blocks publishing while loading or during a degraded lookup", () => {
    expect(canPublishInboxDeclaration({ ...base, status: "loading" })).toBe(
      false
    )
    expect(
      canPublishInboxDeclaration({ ...base, status: "lookup_partial" })
    ).toBe(false)
    expect(
      canPublishInboxDeclaration({ ...base, status: "lookup_unavailable" })
    ).toBe(false)
  })

  it("blocks overwriting a stale-ready declaration that could not be read", () => {
    expect(
      canPublishInboxDeclaration({ ...base, status: "ready", stale: true })
    ).toBe(false)
  })

  it("enforces the selection bounds", () => {
    expect(canPublishInboxDeclaration({ ...base, selectedCount: 0 })).toBe(
      false
    )
    expect(
      canPublishInboxDeclaration({
        ...base,
        selectedCount: MAX_INBOX_RELAY_SELECTION + 1,
      })
    ).toBe(false)
  })
})
