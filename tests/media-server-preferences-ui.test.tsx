import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  MediaServerPreferencesSection,
  RelaySettingsPanel,
} from "../packages/ui/src"
import type {
  AccountNetworkSettingsController,
  MediaServerPreferencesView,
} from "../packages/core/src"

function view(
  overrides: Partial<MediaServerPreferencesView> = {}
): MediaServerPreferencesView {
  return {
    status: "not_observed",
    coverage: "complete",
    localServerUrls: [],
    publishedServerUrls: [],
    dirty: false,
    stale: false,
    retained: false,
    sourceRelayCount: 0,
    publishedCreatedAt: null,
    observedAt: 1_700_000_000_000,
    completeObservedAt: null,
    lookupError: null,
    isLoading: false,
    isRefetching: false,
    canPublish: false,
    publishDisabledReason: "Add at least one media server before publishing.",
    publishPhase: "idle",
    publishMessage: null,
    publishOutcome: null,
    acceptedRelayCount: 0,
    rejectedRelayCount: 0,
    timedOutRelayCount: 0,
    targetRelayCount: 0,
    retryAvailable: false,
    pendingSignedListDiffers: false,
    ...overrides,
  }
}

const actions = {
  onAddServer: () => ({ ok: true }),
  onRemoveServer: () => undefined,
  onMoveServer: () => undefined,
  onPublish: () => undefined,
  onRetryPublish: () => undefined,
  onRetryLookup: () => undefined,
}

describe("shared media server preference UI", () => {
  it("explains the future fallback without silently adding it", () => {
    const html = renderToStaticMarkup(
      <MediaServerPreferencesSection view={view()} {...actions} />
    )
    expect(html).toContain("Media servers")
    expect(html).toContain("https://blossom.nostr.build")
    expect(html).toContain("will not add or publish that fallback")
    expect(html).not.toContain('value="https://blossom.nostr.build"')
    expect(html).toContain(
      "Choose the preferred order for Blossom media servers."
    )
    expect(html).not.toContain("Changes stay on this device")
    expect(html).not.toContain("Enter a public HTTPS origin")
  })

  it("renders ordered native controls, dirty state, and a quiet clean field", () => {
    const html = renderToStaticMarkup(
      <MediaServerPreferencesSection
        view={view({
          localServerUrls: [
            "https://two.conduit.market",
            "https://one.conduit.market",
          ],
          publishedServerUrls: ["https://one.conduit.market"],
          dirty: true,
          canPublish: true,
          publishDisabledReason: null,
        })}
        {...actions}
      />
    )
    const orderedListStart = html.indexOf('aria-label="Ordered media servers"')
    const orderedListEnd = html.indexOf("</ol>", orderedListStart)
    const orderedList = html.slice(orderedListStart, orderedListEnd)
    expect(orderedList.indexOf("https://two.conduit.market")).toBeLessThan(
      orderedList.indexOf("https://one.conduit.market")
    )
    expect(html).toContain(
      'aria-label="Move https://two.conduit.market earlier"'
    )
    expect(html).toContain('aria-label="Move https://two.conduit.market later"')
    expect(html).toContain('aria-label="Remove https://one.conduit.market"')
    expect(html).toContain("min-h-11 min-w-11")
    expect(html).toContain("Draft saved on this device; not published.")
    expect(html).not.toContain("media-server-url-help")
    expect(html).not.toContain('aria-describedby="media-server-url-error"')
    expect(html).not.toContain("draggable=")
  })

  it("uses one calm section flow without redundant happy-state pills", () => {
    const html = renderToStaticMarkup(
      <MediaServerPreferencesSection
        view={view({
          status: "published",
          localServerUrls: ["https://media.conduit.market"],
          publishedServerUrls: ["https://media.conduit.market"],
          sourceRelayCount: 2,
          publishedCreatedAt: 1_700_000_000,
        })}
        {...actions}
      />
    )

    expect(html).toContain(">Refresh</button>")
    expect(html).not.toContain("Published list observed")
    expect(html).not.toContain("Matches observed list")
    expect(html.indexOf("Published preference")).toBeLessThan(
      html.indexOf('aria-label="Ordered media servers"')
    )
    expect(html.indexOf('aria-label="Ordered media servers"')).toBeLessThan(
      html.indexOf("Add media server")
    )
    expect(html.indexOf("Add media server")).toBeLessThan(
      html.indexOf("Review and publish")
    )
  })

  it("keeps a retained published event calm after an incomplete refresh", () => {
    const html = renderToStaticMarkup(
      <MediaServerPreferencesSection
        view={view({
          status: "lookup_partial",
          coverage: "partial",
          publishedServerUrls: ["https://media.conduit.market"],
          sourceRelayCount: 1,
          publishedCreatedAt: 1_700_000_000,
          stale: true,
          retained: true,
        })}
        {...actions}
      />
    )

    expect(html).toContain("Published preference")
    expect(html).toContain("Published")
    expect(html).toContain("Last seen")
    expect(html).toContain("Seen on 1 relay")
    expect(html).not.toContain("Lookup incomplete")
    expect(html).not.toContain("Lookup coverage")
    expect(html).not.toContain("bounded")
  })

  it("keeps a malformed published replacement visibly repairable", () => {
    const html = renderToStaticMarkup(
      <MediaServerPreferencesSection
        view={view({
          status: "malformed",
          publishedServerUrls: ["https://retained.conduit.market"],
          publishedCreatedAt: 1_700_000_000,
          stale: true,
          retained: true,
        })}
        {...actions}
      />
    )

    expect(html).toContain(
      "The published preference needs repair. Add a valid media server to replace it."
    )
    expect(html).not.toContain("Lookup coverage")
  })

  it("reports partial delivery, pending confirmation, retry, and cancellation distinctly", () => {
    const partial = renderToStaticMarkup(
      <MediaServerPreferencesSection
        view={view({
          localServerUrls: ["https://media.conduit.market"],
          publishedServerUrls: ["https://media.conduit.market"],
          publishPhase: "partial",
          publishOutcome: "partial",
          publishMessage:
            "The update was confirmed after 1 of 2 relay targets accepted it.",
          retryAvailable: true,
        })}
        {...actions}
      />
    )
    expect(partial).toContain("1 of 2 relay targets")
    expect(partial).toContain("Retry signed update")

    const pending = renderToStaticMarkup(
      <MediaServerPreferencesSection
        view={view({
          localServerUrls: ["https://media.conduit.market"],
          publishPhase: "confirmation_pending",
          publishOutcome: "confirmation_pending",
          publishMessage: "Fresh read-back is still pending.",
          retryAvailable: true,
        })}
        {...actions}
      />
    )
    expect(pending).toContain("Fresh read-back is still pending")
    expect(pending).not.toContain("Signed and saved")

    const cancelled = renderToStaticMarkup(
      <MediaServerPreferencesSection
        view={view({
          localServerUrls: ["https://media.conduit.market"],
          dirty: true,
          publishPhase: "cancelled",
          publishMessage:
            "Signing was cancelled. Your local media server edits were retained.",
        })}
        {...actions}
      />
    )
    expect(cancelled).toContain("Signing was cancelled")
    expect(cancelled).toContain("edits were retained")
  })

  it("is composed once through the shared Network settings panel", () => {
    const controller: AccountNetworkSettingsController = {
      view: {
        rows: [],
        relayList: {
          state: "not_observed",
          stale: false,
          retained: false,
          coverage: "complete",
          eventCreatedAt: null,
          observedAt: null,
          sourceRelayCount: 0,
        },
        inbox: {
          state: "not_observed",
          stale: false,
          retained: false,
          coverage: "complete",
          eventCreatedAt: null,
          observedAt: null,
          sourceRelayCount: 0,
        },
        pendingExactDeliveries: [],
      },
      status: "ready",
      error: null,
      revision: "media-composition-test",
      operation: { kind: null, phase: "idle", message: null },
      relayInformationRefreshing: false,
      exactInboxRedistributionAvailable: false,
      legacyDraftReviewAvailable: false,
      mediaServers: { view: view(), ...actions },
      addRelay: async () => {
        throw new Error("not used")
      },
      validate: () => ({ valid: false, errors: [], warnings: [] }),
      prepareChange: () => ({
        summary: {
          signerRequestCount: 0,
          changedObjects: [],
          warnings: [],
        },
        execute: async () => undefined,
      }),
      retryPendingUpdate: async () => undefined,
      redistributeExactInboxDeclaration: async () => undefined,
      reorderRelays: async () => undefined,
      discardLegacyDraft: async () => undefined,
      refresh: async () => undefined,
      clearOperation: () => undefined,
    }
    const html = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller} />
    )
    expect(html.match(/id="media-server-preferences-heading"/g)?.length).toBe(1)
    expect(html).toContain("Add media server")
    expect(html).toContain("Add relay")
  })
})
