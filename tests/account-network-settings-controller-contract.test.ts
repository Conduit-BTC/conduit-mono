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

  it("maps one reviewed role action to one coordinated publish owner", () => {
    const mutation = sourceBetween(
      "const runMutation = useCallback(",
      "const save = useCallback("
    )
    expect(mutation).toContain("reviewAccountNetworkMutation(")
    expect(mutation).toContain("publishAccountNetworkMutation({")
    expect(mutation).toContain("reviewed,")
    expect(mutation).toContain("createNdkNostrEventSigner(")
    expect(controllerSource).toContain('type: "set_roles"')
    expect(controllerSource).toContain("removedRelayUrls,")
    expect(mutation).toContain("if (reviewed.signerRequestCount > 0)")
    expect(mutation).toContain("const snapshot = captureAuth()")
    expect(mutation).toContain("const snapshot = captureAccount()")
    expect(mutation).toContain("...(signer ? { signer } : {})")
  })

  it("rejects an insecure or excluded candidate before relay I/O or storage", () => {
    const localState = emptyAccountNetworkLocalState("a".repeat(64))
    expect(() =>
      createCandidateNetworkRelayRow({
        url: "ws://insecure.example",
        localState,
      })
    ).toThrow("secure relay URL")

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
    expect(redistribute).toContain(
      "redistributeAccountNetworkInboxDeclaration({"
    )
    expect(reorder).toContain("reorderAccountNetworkRelays({")
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
