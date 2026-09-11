import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  createCandidateNetworkRelayRow,
  emptyAccountNetworkLocalState,
  prepareAccountNetworkPreferencesPresentation,
  type AccountNetworkPreferencesReconciliation,
  type AccountNetworkPreferencesState,
  type AccountNetworkRelayRowView,
  type AccountNetworkSettingsController,
  type RelayAuthEvidenceState,
  type RelayScanResult,
} from "@conduit/core"
import { RelaySettingsPanel } from "@conduit/ui"

const OWNER = "a".repeat(64)
const EMPTY_FRONTIER = {
  state: "not_observed",
  stale: false,
  retained: false,
  coverage: "complete" as const,
  eventCreatedAt: null,
  observedAt: null,
  sourceRelayCount: 0,
}

function relayScan(url: string, advertisedAuth: boolean): RelayScanResult {
  const observation = (advertised = false) => ({
    supported: advertised,
    status: advertised ? ("advertised" as const) : ("unknown" as const),
    confidence: advertised ? ("advertised" as const) : ("none" as const),
    evidence: advertised ? (["nip11"] as const) : ([] as const),
  })
  return {
    url,
    reachable: true,
    capabilities: {
      nip11: true,
      search: false,
      dm: false,
      auth: advertisedAuth,
      commerce: false,
      protectedMessages: false,
      listings: false,
      cleanup: false,
    },
    warnings: {
      dmWithoutAuth: false,
      staleRelayInfo: false,
      unreachable: false,
      commercePartialSupport: false,
    },
    observations: {
      search: observation(),
      auth: observation(advertisedAuth),
      protectedMessages: observation(),
      listings: observation(),
      cleanup: observation(),
    },
    scannedAt: 1,
  }
}

function relayRow(
  state: RelayAuthEvidenceState | "advertised",
  index: number
): AccountNetworkRelayRowView {
  return {
    url: `wss://${state.replaceAll("_", "-")}.example`,
    readEnabled: true,
    publishEnabled: index === 0,
    privateInboxEnabled: false,
    readState: "published",
    publishState: index === 0 ? "published" : null,
    privateInboxState: null,
    signedPosition: index,
    candidate: false,
    recoveryReadOnly: false,
    reachability: "responded",
    capability: {
      configuredUses: [],
      observedCommerce: false,
      nip11: "available",
      searchAdvertised: false,
      authEvidence: state,
    },
  }
}

function controller(
  rows: AccountNetworkRelayRowView[]
): AccountNetworkSettingsController {
  return {
    view: {
      rows,
      relayList: EMPTY_FRONTIER,
      inbox: EMPTY_FRONTIER,
      pendingExactDeliveries: [],
    },
    status: "ready",
    error: null,
    revision: "auth-evidence",
    operation: { kind: null, phase: "idle", message: null },
    relayInformationRefreshing: false,
    exactInboxRedistributionAvailable: false,
    legacyDraftReviewAvailable: false,
    mediaServers: null,
    addRelay: async () => relayRow("untested", rows.length),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
    prepareChange: () => {
      throw new Error("Not used in this presentation test")
    },
    retryPendingUpdate: async () => undefined,
    redistributeExactInboxDeclaration: async () => undefined,
    reorderRelays: async () => undefined,
    discardLegacyDraft: async () => undefined,
    refresh: async () => undefined,
    clearOperation: () => undefined,
  }
}

describe("relay authentication evidence", () => {
  it("keeps advertised metadata until stronger runtime evidence exists", () => {
    const url = "wss://advertised.example"
    const localState = emptyAccountNetworkLocalState(OWNER)
    const scan = relayScan(url, true)

    expect(
      createCandidateNetworkRelayRow({ url, localState, scan }).capability
        .authEvidence
    ).toBe("advertised")
    expect(
      createCandidateNetworkRelayRow({
        url,
        localState,
        scan,
        authEvidence: "untested",
      }).capability.authEvidence
    ).toBe("advertised")

    for (const state of [
      "challenge_observed",
      "succeeded",
      "rejected",
      "unavailable",
    ] as const) {
      expect(
        createCandidateNetworkRelayRow({
          url,
          localState,
          scan,
          authEvidence: state,
        }).capability.authEvidence
      ).toBe(state)
    }
  })

  it("masks the previous account's reconciliation before the new scope initializes", () => {
    const previousAccount = "b".repeat(64)
    const state: AccountNetworkPreferencesState = {
      contextKey: previousAccount,
      status: "ready",
      localReady: true,
      reconciliation: {
        projection: { pubkey: previousAccount },
      } as AccountNetworkPreferencesReconciliation,
      error: null,
    }

    const presentation = prepareAccountNetworkPreferencesPresentation(
      OWNER,
      state
    )

    expect(presentation).toEqual({
      status: "reconciling",
      localReady: false,
      reconciliation: null,
      error: null,
    })
    expect(JSON.stringify(presentation)).not.toContain(previousAccount)
  })

  it("keeps NIP-11 metadata distinct from runtime NIP-42 outcomes", () => {
    const evidence = [
      "untested",
      "advertised",
      "challenge_observed",
      "succeeded",
      "rejected",
      "unavailable",
    ] as const
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller(
          evidence.map((state, index) => relayRow(state, index))
        )}
      />
    )

    expect(markup).toContain("Relay information")
    expect(markup).toContain("Not advertised")
    expect(markup).toContain("Advertised")
    expect(markup).toContain("Challenge observed")
    expect(markup).toContain("Succeeded")
    expect(markup).toContain("Rejected")
    expect(markup).toContain("Unavailable")
    expect(markup).not.toContain(">Supported<")
    expect(markup).not.toContain(">Verified<")
  })
})
