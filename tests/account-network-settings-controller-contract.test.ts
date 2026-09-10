import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import { createCandidateNetworkRelayRow } from "../packages/core/src/protocol/network-settings-view"

const controllerSource = readFileSync(
  new URL(
    "../packages/core/src/hooks/useAccountNetworkSettings.ts",
    import.meta.url
  ),
  "utf8"
)

function sourceBetween(start: string, end: string): string {
  const startIndex = controllerSource.indexOf(start)
  const endIndex = controllerSource.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThan(-1)
  expect(endIndex).toBeGreaterThan(startIndex)
  return controllerSource.slice(startIndex, endIndex)
}

describe("account Network settings controller contract", () => {
  it("adapts the shared session reconciliation to the new mutation and local-state owners", () => {
    expect(controllerSource).toContain(
      'from "../protocol/account-network-mutation"'
    )
    expect(controllerSource).toContain(
      'from "../protocol/account-network-local-state"'
    )
    expect(controllerSource).toContain(
      'from "../protocol/network-settings-view"'
    )
    expect(controllerSource).toContain(
      "const accountPreferences = session.accountNetworkPreferences"
    )
    expect(controllerSource).not.toContain("network-preference-updates")
    expect(controllerSource).not.toContain("useAccountNetworkPreferences(")
    expect(controllerSource).not.toContain("loadRelaySettings(")
  })

  it("carries live owner authority into independent media preference I/O", () => {
    const mediaPreferences = sourceBetween(
      "const mediaServerPreferences = useMediaServerPreferences(",
      "const captureAccount = useCallback("
    )
    expect(mediaPreferences).toContain(
      'auth.status === "connected" ? auth.pubkey : null'
    )
  })

  it("prepares one frozen authoritative review and exposes one execute doorway", () => {
    const execution = sourceBetween(
      "const executePreparedMutation = useCallback(",
      "const prepareChange = useCallback("
    )
    const preparation = sourceBetween(
      "const prepareChange = useCallback(",
      "const retryPendingUpdate = useCallback("
    )
    expect(preparation).toContain("reviewAccountNetworkMutation(")
    expect(execution).toContain("publishAccountNetworkMutation({")
    expect(execution).toContain("reviewed,")
    expect(execution).toContain("authenticatedPubkey: reviewed.pubkey")
    expect(preparation).toContain("createNdkNostrEventSigner(")
    expect(controllerSource).toContain('type: "set_roles"')
    expect(controllerSource).toContain("removedRelayUrls,")
    expect(preparation).toContain("if (summary.signerRequestCount > 0)")
    expect(preparation).toContain("const snapshot = captureAuth()")
    expect(preparation).toContain("const snapshot = captureAccount()")
    expect(preparation).toContain("let started = false")
    expect(preparation).toContain("if (started)")
    expect(execution).toContain("revisionRef.current !== preparedRevision")
    expect(execution).toContain("...(signer ? { signer } : {})")
    expect(controllerSource).not.toContain("  save: (")
    expect(controllerSource).not.toContain("  removeRelay: (")
  })

  it("accepts an owner-selected ws candidate before relay I/O or storage", () => {
    const localState = emptyAccountNetworkLocalState("a".repeat(64))
    expect(
      createCandidateNetworkRelayRow({
        url: "ws://owner-selected.example",
        localState,
      }).url
    ).toBe("ws://owner-selected.example")
    expect(() =>
      createCandidateNetworkRelayRow({
        url: "ftp://not-a-relay.example",
        localState,
      })
    ).toThrow("ws:// or wss://")

    const add = sourceBetween(
      "const addRelay = useCallback(",
      "const reorderRelays = useCallback("
    )
    const preflightIndex = add.indexOf(
      "const candidateUrl = createCandidateNetworkRelayRow({"
    )
    const scanIndex = add.indexOf("const scan = await scanRelay(")
    const persistIndex = add.indexOf(
      "const updated = await recordAccountNetworkRelayScans({"
    )
    expect(preflightIndex).toBeGreaterThan(-1)
    expect(scanIndex).toBeGreaterThan(preflightIndex)
    expect(persistIndex).toBeGreaterThan(scanIndex)
  })

  it("keeps exact retries, inbox redistribution, and ordering signer-free", () => {
    const retry = sourceBetween(
      "const retryPendingUpdate = useCallback(",
      "const redistributeExactInboxDeclaration = useCallback("
    )
    const redistribute = sourceBetween(
      "const redistributeExactInboxDeclaration = useCallback(",
      "const addRelay = useCallback("
    )
    const reorder = sourceBetween(
      "const reorderRelays = useCallback(",
      "const discardLegacyDraft = useCallback("
    )

    expect(retry).toContain("retryAccountNetworkMutation({")
    expect(retry).toContain("authenticatedPubkey: snapshot.pubkey")
    expect(redistribute).toContain(
      "redistributeAccountNetworkInboxDeclaration({"
    )
    expect(redistribute).toContain("authenticatedPubkey: snapshot.pubkey")
    expect(reorder).toContain("reorderAccountNetworkRelays({")
    expect(reorder).toContain(".filter(isAccountNetworkRelayRowOrderEligible)")
    expect(reorder).not.toContain("current.preferredRelayOrder.filter(")
    for (const operation of [retry, redistribute, reorder]) {
      expect(operation).not.toContain("captureAuth(")
      expect(operation).not.toContain("createNdkNostrEventSigner(")
      expect(operation).not.toContain("signEvent(")
    }
    expect(reorder).not.toContain("accountPreferences.refetch()")
  })

  it("does not turn local ordering into a reviewed-role revision", () => {
    const revision = sourceBetween(
      "function scopedRevision(",
      "export function useAccountNetworkSettings("
    )
    expect(revision).not.toContain("preferredRelayOrder")
    expect(revision).not.toContain("relayScans")
    expect(revision).toContain(
      ".sort((left, right) => left[0].localeCompare(right[0]))"
    )
  })

  it("refreshes only already-validated view rows", () => {
    const refresh = sourceBetween(
      "const refresh = useCallback(",
      "return {\n    view: baseView"
    )
    expect(refresh).toContain("async (): Promise<void>")
    expect(refresh).toContain("relayUrls: baseView.rows.map((row) => row.url)")
    expect(refresh).not.toContain("relayUrls?:")
  })

  it("turns refresh failures into an actionable operation error", () => {
    const refresh = sourceBetween(
      "const refresh = useCallback(",
      "return {\n    view: baseView"
    )
    expect(refresh).toContain(
      'setOperation({ kind: "refresh", phase: "checking", message: null })'
    )
    expect(refresh).toContain("await accountPreferences.refetch()")
    expect(refresh).toContain("} catch (error) {")
    expect(refresh).toContain('kind: "refresh"')
    expect(refresh).toContain('phase: "error"')
    expect(refresh).toContain("operationErrorMessage(error)")
    expect(refresh).toContain("Try again.")
    expect(refresh).not.toContain("throw error")
  })

  it("discards only the legacy NIP-65 role draft", () => {
    const discard = sourceBetween(
      "const discardLegacyDraft = useCallback(",
      "const refresh = useCallback("
    )
    expect(discard).toContain("completeLegacyRelaySettingsDraftMigration({")
    expect(discard).toContain('disposition: "discarded"')
    expect(discard).not.toContain("removeLegacyRelayReadRecoveryRelayUrls")
    expect(discard).not.toContain("clearLegacyInbox")
  })
})
