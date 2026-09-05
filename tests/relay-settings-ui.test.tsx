import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  AccountNetworkRelayRowView,
  AccountNetworkSettingsController,
  AccountNetworkSettingsView,
} from "@conduit/core"
import { RelaySettingsPanel } from "@conduit/ui"

function relayRow(
  url: string,
  overrides: Partial<AccountNetworkRelayRowView> = {}
): AccountNetworkRelayRowView {
  return {
    url,
    readEnabled: true,
    publishEnabled: true,
    privateInboxEnabled: false,
    readState: "published",
    publishState: "published",
    privateInboxState: null,
    signedPosition: 0,
    candidate: false,
    capability: {
      configuredCommerce: false,
      observedCommerce: false,
      nip11: "not_checked",
      searchAdvertised: false,
      authEvidence: "untested",
    },
    ...overrides,
  }
}

function networkView(
  overrides: Partial<AccountNetworkSettingsView> = {}
): AccountNetworkSettingsView {
  const rows = [
    relayRow("wss://first.example", {
      privateInboxEnabled: true,
      privateInboxState: "published",
    }),
    relayRow("wss://second.example", { signedPosition: 1 }),
  ]
  return {
    status: "ready",
    error: null,
    rows,
    capabilityByUrl: Object.fromEntries(
      rows.map((row) => [row.url, row.capability])
    ),
    relayList: {
      state: "declared",
      stale: false,
      coverage: "complete",
    },
    inbox: {
      state: "declared",
      stale: false,
      coverage: "complete",
    },
    pendingStatus: "none",
    pendingCheckpoints: [],
    activeUpdateId: null,
    revision: JSON.stringify(rows),
    ...overrides,
  }
}

function controller(
  overrides: Partial<AccountNetworkSettingsController> = {}
): AccountNetworkSettingsController {
  return {
    view: networkView(),
    operation: { kind: null, phase: "idle", message: null },
    exactInboxRedistributionAvailable: false,
    mediaServers: null,
    addRelay: async (url) => relayRow(url, { candidate: true }),
    refreshRelay: async (row) => row,
    save: async () => undefined,
    removeRelay: async () => undefined,
    retryPendingUpdate: async () => undefined,
    redistributeExactInboxDeclaration: async () => undefined,
    retryReconciliation: () => undefined,
    clearOperation: () => undefined,
    ...overrides,
  }
}

function buttonOpeningTag(markup: string, label: string): string {
  const labelIndex = markup.indexOf(label)
  const buttonStart = markup.lastIndexOf("<button", labelIndex)
  return markup.slice(buttonStart, markup.indexOf(">", buttonStart) + 1)
}

describe("RelaySettingsPanel", () => {
  it("renders one flat account Network list with the three user-facing roles", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller()} />
    )

    expect(markup).toContain(">Network<")
    expect(markup).toContain(">Relays<")
    expect(markup).toContain(">Read<")
    expect(markup).toContain(">Publish<")
    expect(markup).toContain(">Private inbox<")
    expect(markup.match(/wss:\/\/first\.example/g)?.length).toBeGreaterThan(0)
    expect(markup.match(/wss:\/\/second\.example/g)?.length).toBeGreaterThan(0)
    expect(markup).not.toContain("Commerce Relays")
    expect(markup).not.toContain("Other Relays")
    expect(markup).not.toContain("Move earlier")
    expect(markup).not.toContain("draggable=")
    expect(markup).not.toContain(">IN<")
    expect(markup).not.toContain(">OUT<")
  })

  it("keeps Add Relay before the relay list and explains candidates as unpublished", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller()} />
    )

    expect(markup.indexOf("Add Relay")).toBeLessThan(markup.indexOf(">Relays<"))
    expect(markup).toContain("only reads its advertised metadata")
    expect(markup).toContain("unpublished candidate")
    expect(markup).toContain('aria-describedby="account-network-relay-help"')
  })

  it("labels NIP-11 and authentication evidence without claiming health or delivery", () => {
    const rows = [
      relayRow("wss://metadata.example", {
        privateInboxEnabled: true,
        capability: {
          configuredCommerce: true,
          observedCommerce: false,
          nip11: "advertised",
          searchAdvertised: true,
          authEvidence: "advertised",
          relayName: "Metadata relay",
        },
      }),
      relayRow("wss://unavailable.example", {
        signedPosition: 1,
        capability: {
          configuredCommerce: false,
          observedCommerce: false,
          nip11: "unavailable",
          searchAdvertised: false,
          authEvidence: "unavailable",
        },
      }),
    ]
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          view: networkView({ rows, revision: JSON.stringify(rows) }),
        })}
      />
    )

    expect(markup).toContain("Commerce configured")
    expect(markup).toContain("NIP-11 metadata observed")
    expect(markup).toContain("NIP-11 metadata unavailable")
    expect(markup).toContain("Search advertised")
    expect(markup).toContain("Auth advertised")
    expect(markup).toContain("Auth unavailable")
    expect(markup).toContain("Metadata is not a health check")
    expect(markup).not.toContain("Delivery confirmed")
    expect(markup).not.toContain("NIP-17 supported")
    expect(markup).not.toContain("NIP-65 supported")
    expect(markup).not.toContain("NIP-99 supported")
  })

  it("presents stronger live auth evidence without losing its advertised-support ordering tier", () => {
    const plain = relayRow("wss://plain.example", { signedPosition: 0 })
    const auth = relayRow("wss://auth.example", {
      signedPosition: 1,
      capability: {
        configuredCommerce: false,
        observedCommerce: false,
        nip11: "advertised",
        searchAdvertised: false,
        authEvidence: "advertised",
      },
    })
    const view = networkView({
      rows: [plain, auth],
      capabilityByUrl: {
        [plain.url]: plain.capability,
        [auth.url]: { ...auth.capability, authEvidence: "succeeded" },
      },
      revision: "stable-signed-frontier",
    })
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller({ view })} />
    )

    expect(markup).toContain("Auth succeeded")
    expect(markup).not.toContain("Auth advertised")
    expect(markup.indexOf(auth.url)).toBeLessThan(markup.indexOf(plain.url))
  })

  it("shows independent two-object pending outcomes and exact-byte retry", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          view: networkView({
            pendingStatus: "ready",
            activeUpdateId: "pending-update",
            pendingCheckpoints: [
              {
                kind: 10002,
                label: "Read and Publish",
                state: "partial",
                acceptedCount: 1,
                confirmedCount: 0,
                rejectedCount: 1,
                timedOutCount: 0,
                targetCount: 2,
                retryAvailable: true,
              },
              {
                kind: 10050,
                label: "Private inbox",
                state: "confirmed",
                acceptedCount: 2,
                confirmedCount: 1,
                rejectedCount: 0,
                timedOutCount: 0,
                targetCount: 2,
                retryAvailable: false,
              },
            ],
          }),
          operation: {
            kind: "retry",
            phase: "complete",
            message:
              "The exact signed preferences remain retryable; some relay outcomes are still pending.",
          },
        })}
      />
    )

    expect(markup).toContain("Partial relay outcome")
    expect(markup).toContain("Exact event confirmed")
    expect(markup).toContain("1 accepted")
    expect(markup).toContain("1 rejected")
    expect(markup).toContain("Retry exact signed update")
    expect(markup).toContain("exact readback")
    expect(markup).not.toContain("delivered")
  })

  it("preserves the legacy exact-declaration recovery without a signer action", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({ exactInboxRedistributionAvailable: true })}
      />
    )

    expect(markup).toContain("Finish private inbox distribution")
    expect(markup).toContain("Retry exact declaration")
    expect(markup).toContain("does not create a new event or ask your signer")
    expect(markup).not.toContain("Publish inbox declaration")
  })

  it("uses one coordinated Save action and describes the two signer requests", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller()} />
    )

    expect(markup).toContain("Save Network changes")
    expect(markup).toContain("one or two signer requests")
    expect(markup.match(/Save Network changes/g)?.length).toBe(1)
    expect(markup).not.toContain("Publish NIP-65")
    expect(markup).not.toContain("Publish inbox")
    expect(markup).not.toContain("Clear local")
  })

  it("treats a retained draft role as an explicit unsaved signed change", () => {
    const rows = [
      relayRow("wss://first.example", {
        privateInboxEnabled: true,
        privateInboxState: "published",
      }),
      relayRow("wss://second.example", { signedPosition: 1 }),
      relayRow("wss://draft.example", {
        readEnabled: true,
        publishEnabled: false,
        privateInboxEnabled: false,
        readState: "draft",
        publishState: null,
        privateInboxState: null,
        signedPosition: 2,
        candidate: true,
      }),
    ]
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          view: networkView({ rows, revision: "draft-frontier" }),
        })}
      />
    )

    expect(markup).toContain("Unpublished candidate")
    expect(markup).toContain("Discard edits")
    expect(buttonOpeningTag(markup, "Save Network changes")).not.toContain(
      'disabled=""'
    )
  })

  it("blocks signed mutations when exact retry storage is unavailable", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          view: networkView({ pendingStatus: "unavailable" }),
        })}
      />
    )

    expect(markup).toContain("cannot safely stage or resume an update")
    expect(buttonOpeningTag(markup, "Save Network changes")).toContain(
      'disabled=""'
    )
    expect(
      buttonOpeningTag(
        markup,
        "Refresh advertised metadata for wss://first.example"
      )
    ).not.toContain('disabled=""')
  })

  it("blocks candidate discard only while a Network operation is active", () => {
    const candidate = relayRow("wss://candidate.example", {
      readEnabled: false,
      publishEnabled: false,
      privateInboxEnabled: false,
      readState: null,
      publishState: null,
      privateInboxState: null,
      signedPosition: null,
      candidate: true,
    })
    const base = networkView()
    const view = networkView({
      rows: [...base.rows, candidate],
      capabilityByUrl: {
        ...base.capabilityByUrl,
        [candidate.url]: candidate.capability,
      },
      revision: "candidate-discard",
    })
    const idleMarkup = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller({ view })} />
    )
    const busyMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          view,
          operation: { kind: "save", phase: "publishing", message: null },
        })}
      />
    )
    const label = "Discard unpublished candidate wss://candidate.example"

    expect(buttonOpeningTag(idleMarkup, label)).not.toContain('disabled=""')
    expect(buttonOpeningTag(busyMarkup, label)).toContain('disabled=""')
  })

  it("blocks a fresh reconciliation only during an active Network operation", () => {
    const idleMarkup = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller()} />
    )
    const busyMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          operation: {
            kind: "remove",
            phase: "awaiting_signatures",
            message: null,
          },
        })}
      />
    )

    expect(buttonOpeningTag(idleMarkup, "Check again")).not.toContain(
      'disabled=""'
    )
    expect(buttonOpeningTag(busyMarkup, "Check again")).toContain('disabled=""')
  })
})
