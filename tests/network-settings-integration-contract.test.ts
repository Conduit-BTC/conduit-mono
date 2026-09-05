import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"

const marketRoute = readFileSync(
  new URL("../apps/market/src/routes/network.tsx", import.meta.url),
  "utf8"
)
const merchantRoute = readFileSync(
  new URL("../apps/merchant/src/routes/network.tsx", import.meta.url),
  "utf8"
)
const merchantProductsRoute = readFileSync(
  new URL("../apps/merchant/src/routes/products.tsx", import.meta.url),
  "utf8"
)
const controllerSource = readFileSync(
  new URL(
    "../packages/core/src/hooks/useAccountNetworkSettings.ts",
    import.meta.url
  ),
  "utf8"
)
const panelSource = readFileSync(
  new URL(
    "../packages/ui/src/components/RelaySettingsPanel.tsx",
    import.meta.url
  ),
  "utf8"
)

describe("shared account Network integration contract", () => {
  it("wires Market and Merchant through the same controller and panel", () => {
    for (const source of [marketRoute, merchantRoute]) {
      expect(source).toContain(
        "const networkSettings = useAccountNetworkSettings()"
      )
      expect(source).toContain(
        "<RelaySettingsPanel controller={networkSettings} />"
      )
      expect(source).not.toContain("useRelaySettings(")
      expect(source).not.toContain("useInboxDeclaration(")
      expect(source).not.toContain("useMediaServerPreferences(")
      expect(source).not.toContain("onReorderCommerceRelay")
      expect(source).not.toContain("PrivateInboxSection")
    }
  })

  it("routes one Save through the coordinated action and whole removal through remove_relay", () => {
    expect(
      controllerSource.match(/publishAccountNetworkPreferenceUpdate\(/g)
    ).toHaveLength(1)
    expect(controllerSource).toContain("prepareAccountNetworkSetRolesAction(")
    expect(controllerSource).toContain('runUpdate("save", prepared.action)')
    expect(controllerSource).toContain(
      'await runUpdate("remove", { type: "remove_relay", relayUrl })'
    )
    expect(controllerSource).not.toContain("allowSignedEmptyInbox")
  })

  it("routes the shared Conduit prompt through one coordinated update", () => {
    const normalizedController = controllerSource.replace(/\s+/g, " ")
    const normalizedPanel = panelSource.replace(/\s+/g, " ")
    const promptStart = normalizedPanel.indexOf("function ConduitRelayPrompt(")
    const promptEnd = normalizedPanel.indexOf(
      "function LegacyInboxRecoverySection",
      promptStart
    )
    const promptSource = normalizedPanel.slice(promptStart, promptEnd)

    expect(normalizedController).toContain(
      "const prepared = prepareConduitRelayRecommendation(reconciliation)"
    )
    expect(normalizedController).toContain(
      'await runUpdate("conduit_relay", prepared.action)'
    )
    expect(promptSource).toContain("await controller.addConduitRelay()")
    expect(promptSource).toContain("setDismissed(true) setError(null)")
    const dismissStart = promptSource.indexOf('variant="ghost"')
    const acceptStart = promptSource.indexOf(
      '<Button type="button" disabled={busy}',
      dismissStart
    )
    expect(promptSource.slice(dismissStart, acceptStart)).not.toContain(
      "addConduitRelay"
    )
    for (const source of [marketRoute, merchantRoute]) {
      expect(source).not.toContain("Add the Conduit relay?")
      expect(source).not.toContain("conduitRelayPrompt")
    }
  })

  it("retries coordinated and legacy work with exact signed bytes", () => {
    expect(controllerSource).toContain("retryAccountNetworkPreferenceUpdate({")
    expect(controllerSource).toContain(
      "signedEvent: durable.current.signedEvent"
    )
    expect(panelSource).toContain(
      "This does not create a new event or ask your signer."
    )
    const legacyStart = controllerSource.indexOf(
      "const redistributeExactInboxDeclaration"
    )
    const legacyEnd = controllerSource.indexOf("const addRelay", legacyStart)
    const legacyPath = controllerSource.slice(legacyStart, legacyEnd)
    expect(legacyPath).not.toContain("signEvent(")
    expect(legacyPath).not.toContain("publishAccountNetworkPreferenceUpdate")
  })

  it("uses the shared accessible warning with Cancel and Proceed", () => {
    const normalizedPanelSource = panelSource.replace(/\s+/g, " ")
    expect(panelSource).toContain("<AlertDialog")
    expect(panelSource).toContain("<AlertDialogContent")
    expect(panelSource).toContain("onCloseAutoFocus={(event) =>")
    expect(panelSource).toContain("returnFocusRef.current.focus()")
    expect(normalizedPanelSource).toContain(
      "After you complete every signer request, Conduit will stop reading, publishing, and checking it for private messages immediately. Stale clients may still send messages there, and those messages can be missed."
    )
    expect(panelSource).toContain("Cancel")
    expect(panelSource).toContain("Proceed")
    expect(panelSource).toContain("disabled={busy || Boolean(instruction)}")
  })

  it("announces a failed whole-setup removal inside the open dialog", () => {
    const normalizedPanelSource = panelSource.replace(/\s+/g, " ")
    const dialogStart = normalizedPanelSource.indexOf(
      "export function RelayRemovalDialog"
    )
    const dialogEnd = normalizedPanelSource.indexOf(
      "function removalInstructionForReview",
      dialogStart
    )
    const dialogSource = normalizedPanelSource.slice(dialogStart, dialogEnd)

    expect(normalizedPanelSource).toContain(
      'controller.operation.kind === "remove" && controller.operation.phase === "error"'
    )
    expect(normalizedPanelSource).toContain(
      "? (controller.operation.message ??"
    )
    expect(dialogSource).toContain(
      '<p role="alert" className="text-pretty text-sm text-error"> {errorMessage} </p>'
    )
  })

  it("discards a local candidate without entering whole-setup removal", () => {
    expect(panelSource).toContain(
      "if (hasSignedOrPendingMembership(row)) relayUrls.add(row.url)"
    )
    expect(panelSource).toContain("if (!wholeSetupRelayUrls.has(row.url))")
    expect(panelSource).toContain(
      "current.filter((candidate) => candidate.url !== row.url)"
    )
    expect(panelSource).toContain(".removeRelay(relayPendingRemoval)")
  })

  it("routes a signed relay's final role through whole-setup removal", () => {
    const normalizedPanelSource = panelSource.replace(/\s+/g, " ")
    const toggleStart = normalizedPanelSource.indexOf("function toggleRole(")
    const toggleEnd = normalizedPanelSource.indexOf(
      "async function addRelay",
      toggleStart
    )
    const toggleSource = normalizedPanelSource.slice(toggleStart, toggleEnd)

    expect(toggleSource).toContain("wholeSetupRelayUrls.has(url)")
    expect(toggleSource).toContain("roleEnabled(currentRow, role)")
    expect(toggleSource).toContain(
      "removalTriggerRef.current = trigger setRelayPendingRemoval(url) return"
    )
    expect(toggleSource.indexOf("setRelayPendingRemoval(url)")).toBeLessThan(
      toggleSource.indexOf("setRows((current)")
    )
  })

  it("deduplicates normalized local candidates before reading metadata", () => {
    const normalizedPanelSource = panelSource.replace(/\s+/g, " ")
    const addStart = normalizedPanelSource.indexOf(
      "async function addRelay(event: FormEvent<HTMLFormElement>)"
    )
    const addEnd = normalizedPanelSource.indexOf(
      "async function refreshRelay",
      addStart
    )
    const addSource = normalizedPanelSource.slice(addStart, addEnd)

    expect(addSource).toContain("const normalized = tryNormalizeRelayUrl")
    expect(addSource).toContain(
      "if (rows.some((row) => row.url === normalized.url))"
    )
    expect(addSource.indexOf("rows.some")).toBeLessThan(
      addSource.indexOf("controller.addRelay(normalized.url)")
    )
    expect(addSource).toContain("current.some((row) => row.url === added.url)")
  })

  it("clears stale operation outcomes when a new local review begins", () => {
    const normalizedPanelSource = panelSource.replace(/\s+/g, " ")
    expect(normalizedPanelSource).toContain(
      "role: AccountNetworkRole, trigger: HTMLButtonElement ): void { controller.clearOperation()"
    )
    expect(normalizedPanelSource).toContain(
      'setNewRelayUrl("") controller.clearOperation()'
    )
    expect(normalizedPanelSource).toContain(
      "setLocalActionError(null) controller.clearOperation() return"
    )
    expect(normalizedPanelSource).toContain(
      "controller.clearOperation() removalTriggerRef.current = trigger setRelayPendingRemoval(row.url)"
    )
    expect(normalizedPanelSource).toContain(
      "function discardReview(): void { setRows(discardReviewRows(controller.view.rows)) setLocalActionError(null) controller.clearOperation()"
    )
  })

  it("keeps Media preferences separate after the relay review", () => {
    expect(panelSource.match(/<MediaServerPreferencesSection/g)).toHaveLength(1)
    expect(panelSource.indexOf("Save Network changes")).toBeLessThan(
      panelSource.indexOf("<MediaServerPreferencesSection")
    )
  })

  it("keeps Merchant publishing recovery aligned with the unified roles", () => {
    expect(merchantProductsRoute).toContain(
      "Open Network, add another relay or enable Publish on one, then try again."
    )
    expect(merchantProductsRoute).not.toContain("reset to defaults")
    expect(merchantProductsRoute).not.toContain("enable OUT")
  })
})
