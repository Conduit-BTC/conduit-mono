import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  AccountNetworkRelayRowView,
  AccountNetworkSettingsController,
} from "@conduit/core"
import { RelaySettingsPanel } from "@conduit/ui"

const EMPTY_FRONTIER = {
  state: "not_observed",
  stale: false,
  retained: false,
  coverage: "complete" as const,
  eventCreatedAt: null,
  observedAt: null,
  sourceRelayCount: 0,
}

function relayRow(
  url: string,
  overrides: Partial<AccountNetworkRelayRowView> = {}
): AccountNetworkRelayRowView {
  return {
    url,
    readEnabled: true,
    publishEnabled: true,
    privateInboxEnabled: true,
    readState: "published",
    publishState: "published",
    privateInboxState: "published",
    signedPosition: 0,
    candidate: false,
    recoveryReadOnly: false,
    reachability: "responded",
    capability: {
      configuredUses: [],
      observedCommerce: false,
      nip11: "available",
      searchAdvertised: false,
      authEvidence: "untested",
    },
    ...overrides,
  }
}

function controller(
  input: {
    rows?: AccountNetworkRelayRowView[]
    pendingExactDeliveries?: AccountNetworkSettingsController["view"]["pendingExactDeliveries"]
    validation?: ReturnType<AccountNetworkSettingsController["validate"]>
    legacyDraftReviewAvailable?: boolean
  } = {}
): AccountNetworkSettingsController {
  return {
    view: {
      rows: input.rows ?? [],
      relayList: EMPTY_FRONTIER,
      inbox: EMPTY_FRONTIER,
      pendingExactDeliveries: input.pendingExactDeliveries ?? [],
    },
    status: "ready",
    error: null,
    revision: "test-revision",
    operation: { kind: null, phase: "idle", message: null },
    relayInformationRefreshing: false,
    exactInboxRedistributionAvailable: false,
    legacyDraftReviewAvailable: input.legacyDraftReviewAvailable ?? false,
    mediaServers: null,
    addRelay: async () => relayRow("wss://added.example"),
    validate: () =>
      input.validation ?? { valid: true, errors: [], warnings: [] },
    save: async () => undefined,
    removeRelay: async () => undefined,
    retryPendingUpdate: async () => undefined,
    redistributeExactInboxDeclaration: async () => undefined,
    reorderRelays: async () => undefined,
    discardLegacyDraft: async () => undefined,
    refresh: async () => undefined,
    clearOperation: () => undefined,
  }
}

describe("RelaySettingsPanel account Network review", () => {
  it("accepts a one-relay setup and describes the actual minimum", () => {
    const emptyMarkup = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller()} />
    )
    expect(emptyMarkup).toContain("at least one Publish relay")
    expect(emptyMarkup).toContain(
      "Select a Private inbox if you want to receive private messages."
    )
    expect(emptyMarkup).not.toContain(
      "Publish relay and select a Private inbox"
    )
    expect(emptyMarkup).not.toContain("at least two relays")

    const oneRelayMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [relayRow("wss://only.example")],
          validation: {
            valid: true,
            errors: [],
            warnings: [
              "One Publish relay is valid, but adding another improves redundancy.",
            ],
          },
        })}
      />
    )
    expect(oneRelayMarkup).toContain(
      "One Publish relay is valid, but adding another improves redundancy."
    )
  })

  it("identifies recovery-only inboxes and makes whole-relay cutoff explicit", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [
            relayRow("wss://previous-inbox.example", {
              readEnabled: false,
              publishEnabled: false,
              privateInboxEnabled: false,
              readState: null,
              publishState: null,
              privateInboxState: null,
              recoveryReadOnly: true,
            }),
          ],
        })}
      />
    )

    expect(markup).toContain("Recovery read-only")
    expect(markup).toContain("7-day recovery window")
    expect(markup).toContain(
      'aria-label="Remove wss://previous-inbox.example from my whole setup"'
    )
    expect(markup).toContain("ends recovery for this relay immediately")
  })

  it("blocks a reviewed change that removes the last usable private inbox", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [
            relayRow("wss://last-inbox.example", {
              privateInboxEnabled: false,
            }),
          ],
          validation: {
            valid: false,
            errors: [
              "Select a replacement before removing the last usable Private inbox.",
            ],
            warnings: [
              "One Publish relay is valid, but adding another improves redundancy.",
            ],
          },
        })}
      />
    )

    expect(markup).toContain(
      "Select a replacement before removing the last usable Private inbox."
    )
    const publishButton = markup.match(
      /<button[^>]*disabled=""[^>]*>.*?Review and publish.*?<\/button>/
    )?.[0]
    expect(publishButton).toBeDefined()
  })

  it("previews whole removal by omitting the target recovery row", async () => {
    const panelSource = await Bun.file(
      "packages/ui/src/components/RelaySettingsPanel.tsx"
    ).text()
    const preview = panelSource.match(
      /function removalInstructionForReview\([\s\S]*?\n\}/
    )?.[0]
    expect(preview).toContain("baselineRoles.filter(")
    expect(preview).toContain("(roles) => roles.url !== relayUrl")
    expect(preview).not.toContain("baselineRoles.map(")
    expect(panelSource).toContain("disabled={busy || Boolean(instruction)}")
  })

  it("keeps legacy role-draft discard separate from inbox recovery", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({ legacyDraftReviewAvailable: true })}
      />
    )

    expect(markup).toContain("Older relay role draft")
    expect(markup).toContain("does not end private inbox recovery")
    expect(markup).toContain("Discard older draft")
  })

  it("shows exact readback evidence without an update-journal summary", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [relayRow("wss://relay.example")],
          pendingExactDeliveries: [
            {
              kind: 10050,
              label: "Private inbox",
              eventId: "f".repeat(64),
              eligibleTargetCount: 3,
              exactReadbackCount: 1,
              unresolvedCount: 2,
              excludedTargetCount: 1,
              retryAvailable: true,
            },
          ],
        })}
      />
    )

    expect(markup).toContain("1 exact readback")
    expect(markup).toContain("2 unresolved")
    expect(markup).toContain("3 eligible targets")
    expect(markup).toContain("1 excluded")
    expect(markup).toContain("Retry exact signed update")
    expect(markup).not.toContain("accepted")
    expect(markup).not.toContain("timed out")
  })

  it("offers move controls only across equivalent adjacent rows", () => {
    const equivalentMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [
            relayRow("wss://first.example", { signedPosition: 0 }),
            relayRow("wss://second.example", { signedPosition: 1 }),
          ],
        })}
      />
    )
    expect(equivalentMarkup).toContain(
      'aria-label="Move wss://first.example later"'
    )
    expect(equivalentMarkup).toContain(
      'aria-label="Move wss://second.example earlier"'
    )
    expect(equivalentMarkup).toContain("does not ask your signer")

    const nonEquivalentMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [
            relayRow("wss://responded.example", {
              signedPosition: 0,
              reachability: "responded",
            }),
            relayRow("wss://unchecked.example", {
              signedPosition: 1,
              reachability: "not_checked",
            }),
          ],
        })}
      />
    )
    expect(nonEquivalentMarkup).not.toContain('aria-label="Move ')
  })

  it("keeps the relay editor reset key insensitive to local reordering", async () => {
    const panelSource = await Bun.file(
      "packages/ui/src/components/RelaySettingsPanel.tsx"
    ).text()
    const revisionHelper = panelSource.match(
      /function getRelaySettingsEditorRevision\([\s\S]*?\n\}/
    )?.[0]

    expect(revisionHelper).toBeDefined()
    expect(revisionHelper).toContain(
      ".sort((left, right) => left[0].localeCompare(right[0]))"
    )
    expect(revisionHelper).toContain("Boolean(row.recoveryReadOnly)")
    expect(panelSource).toContain("key={editorRevision}")
  })
})
