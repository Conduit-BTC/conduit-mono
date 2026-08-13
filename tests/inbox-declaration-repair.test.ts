import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { verifyDeclarationReadBack } from "../packages/core/src/hooks/useInboxDeclaration"
import type { InboxDeclarationResolution } from "../packages/core/src/protocol/private-message-routing"
import {
  canPublishInboxDeclaration,
  MAX_INBOX_RELAY_SELECTION,
  PrivateInboxSection,
  type PrivateInboxStatus,
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
          observation: {
            coverage: "complete",
            attemptedRelayUrls: ["wss://shared.example"],
            successfulRelayUrls: ["wss://shared.example"],
            failedRelayUrls: [],
            eventId: "new-declaration",
            eventSourceRelayUrls: ["wss://shared.example"],
          },
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
          observation: {
            coverage: "partial",
            attemptedRelayUrls: [
              "wss://shared-a.example",
              "wss://shared-b.example",
            ],
            successfulRelayUrls: ["wss://shared-a.example"],
            failedRelayUrls: ["wss://shared-b.example"],
            eventId: expected.eventId,
            eventSourceRelayUrls: ["wss://shared-a.example"],
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
  })
})

describe("canPublishInboxDeclaration", () => {
  const base = {
    status: "not_observed" as const,
    stale: false,
    distributionRepairable: false,
    selectedCount: 1,
    selectionChanged: true,
  }

  it("allows publishing a first or repaired declaration", () => {
    expect(canPublishInboxDeclaration(base)).toBe(true)
    expect(canPublishInboxDeclaration({ ...base, status: "malformed" })).toBe(
      true
    )
    expect(
      canPublishInboxDeclaration({ ...base, status: "signed_empty" })
    ).toBe(true)
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

  it("blocks overwriting any stale signed frontier that could not be read", () => {
    expect(
      canPublishInboxDeclaration({ ...base, status: "ready", stale: true })
    ).toBe(false)
    expect(
      canPublishInboxDeclaration({
        ...base,
        status: "signed_empty",
        stale: true,
      })
    ).toBe(false)
    expect(
      canPublishInboxDeclaration({
        ...base,
        status: "malformed",
        stale: true,
      })
    ).toBe(false)
  })

  it("allows only same-set redistribution after complete shared non-observation", () => {
    expect(
      canPublishInboxDeclaration({
        ...base,
        status: "ready",
        stale: true,
        distributionRepairable: true,
        selectionChanged: false,
      })
    ).toBe(true)
    expect(
      canPublishInboxDeclaration({
        ...base,
        status: "ready",
        stale: true,
        distributionRepairable: true,
        selectionChanged: true,
      })
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

describe("PrivateInboxSection relay evidence", () => {
  it("renders declared, reachability, and protected-message evidence without overclaiming delivery", () => {
    const markup = renderToStaticMarkup(
      createElement(PrivateInboxSection, {
        status: "ready",
        declaredRelayUrls: ["wss://declared.example"],
        candidateRelays: [
          {
            url: "wss://declared.example",
            configured: true,
            enabled: true,
            declared: true,
            retained: false,
            selectable: true,
            relayInfoProbe: "failed",
            protectedMessageCapabilityEvidence: "advertised",
            protectedMessageRuntimeEvidence: "probe_failed",
          },
          {
            url: "wss://observed.example",
            configured: true,
            enabled: true,
            declared: false,
            retained: false,
            selectable: true,
            relayInfoProbe: "succeeded",
            protectedMessageCapabilityEvidence: "unknown",
            protectedMessageRuntimeEvidence: "probe_passed",
          },
          {
            url: "wss://unknown.example",
            configured: true,
            enabled: false,
            declared: false,
            retained: false,
            selectable: false,
            relayInfoProbe: "unknown",
            protectedMessageCapabilityEvidence: "unknown",
            protectedMessageRuntimeEvidence: "unknown",
          },
        ],
        onPublish: () => undefined,
        onRetryLookup: () => undefined,
      })
    )

    expect(markup).toContain("Declared")
    expect(markup).toContain("IN enabled")
    expect(markup).toContain("IN off")
    expect(markup).toContain("Relay unreachable")
    expect(markup).toContain("Relay info reached")
    expect(markup).toContain("NIP-59 advertised")
    expect(markup).toContain("Protected-message probe passed")
    expect(markup).toContain("Protected-message probe failed")
    expect(markup).toContain("Advertisement unknown")
    expect(markup).not.toContain("recipient received")
    expect(markup).not.toContain("delivery confirmed")
  })

  it("distinguishes bounded non-observation, signed empty, and malformed declarations", () => {
    const renderStatus = (status: PrivateInboxStatus) =>
      renderToStaticMarkup(
        createElement(PrivateInboxSection, {
          status,
          declaredRelayUrls: [],
          candidateRelays: [],
          onPublish: () => undefined,
          onRetryLookup: () => undefined,
        })
      )

    const notObserved = renderStatus("not_observed")
    expect(notObserved).toContain("bounded lookup")
    expect(notObserved).toContain("does not prove one is absent everywhere")

    const signedEmpty = renderStatus("signed_empty")
    expect(signedEmpty).toContain("lists no secure inbox relays")
    expect(signedEmpty).toContain("Restore your private inbox")

    const malformed = renderStatus("malformed")
    expect(malformed).toContain("relay tags could not be used safely")
    expect(malformed).toContain("not the same as choosing an empty inbox")
  })

  it("offers Retry for stale blockers and redistribution for a complete shared miss", () => {
    const staleBlocker = renderToStaticMarkup(
      createElement(PrivateInboxSection, {
        status: "signed_empty",
        stale: true,
        declaredRelayUrls: [],
        candidateRelays: [],
        onPublish: () => undefined,
        onRetryLookup: () => undefined,
      })
    )
    expect(staleBlocker).toContain("Retry")
    expect(staleBlocker).toContain("latest shared lookup was degraded")

    const redistribution = renderToStaticMarkup(
      createElement(PrivateInboxSection, {
        status: "ready",
        stale: true,
        distributionRepairable: true,
        declaredRelayUrls: ["wss://inbox.example"],
        candidateRelays: [
          {
            url: "wss://inbox.example",
            configured: false,
            enabled: false,
            declared: true,
            retained: false,
            selectable: true,
            relayInfoProbe: "unknown",
            protectedMessageCapabilityEvidence: "unknown",
            protectedMessageRuntimeEvidence: "unknown",
          },
        ],
        onPublish: () => undefined,
        onRetryLookup: () => undefined,
      })
    )
    expect(redistribution).toContain("Redistribute your private inbox")
    expect(redistribution).toContain("Redistribute inbox declaration")
    expect(redistribution).not.toContain(">Retry<")
  })

  it("redistributes an oversized declaration through its bounded effective route", () => {
    const relayUrls = [
      "wss://inbox-a.example",
      "wss://inbox-b.example",
      "wss://inbox-c.example",
      "wss://inbox-d.example",
    ]
    const markup = renderToStaticMarkup(
      createElement(PrivateInboxSection, {
        status: "ready",
        stale: true,
        distributionRepairable: true,
        declaredRelayUrls: relayUrls,
        candidateRelays: relayUrls.map((url) => ({
          url,
          configured: false,
          enabled: false,
          declared: true,
          retained: false,
          selectable: true,
          relayInfoProbe: "unknown" as const,
          protectedMessageCapabilityEvidence: "unknown" as const,
          protectedMessageRuntimeEvidence: "unknown" as const,
        })),
        onPublish: () => undefined,
        onRetryLookup: () => undefined,
      })
    )
    const labelIndex = markup.indexOf("Redistribute inbox declaration")
    const buttonStart = markup.lastIndexOf("<button", labelIndex)
    const openingTag = markup.slice(
      buttonStart,
      markup.indexOf(">", buttonStart) + 1
    )

    expect(labelIndex).toBeGreaterThan(-1)
    expect(buttonStart).toBeGreaterThan(-1)
    expect(openingTag).not.toContain(' disabled=""')
    expect(openingTag).not.toContain(" disabled>")
  })

  it("labels retained recovery evidence without calling it current", () => {
    const markup = renderToStaticMarkup(
      createElement(PrivateInboxSection, {
        status: "signed_empty",
        declaredRelayUrls: [],
        candidateRelays: [
          {
            url: "wss://previous.example",
            configured: false,
            enabled: false,
            declared: false,
            retained: true,
            selectable: true,
            relayInfoProbe: "unknown",
            protectedMessageCapabilityEvidence: "unknown",
            protectedMessageRuntimeEvidence: "unknown",
          },
        ],
        onPublish: () => undefined,
        onRetryLookup: () => undefined,
      })
    )
    expect(markup).toContain("Previously declared")
    expect(markup).toContain("not the current declaration")
  })
})
