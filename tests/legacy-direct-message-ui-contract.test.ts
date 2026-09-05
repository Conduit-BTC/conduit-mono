import { describe, expect, it } from "bun:test"

describe("legacy direct-message UI contract", () => {
  it("uses the shared warning and omits the composer in Market's nip04 branch", async () => {
    const source = await Bun.file("apps/market/src/routes/messages.tsx").text()
    const branch = source.match(
      /selectedDmTransport === "nip04" \? \(([\s\S]*?)\n\s*\) : \(/
    )?.[1]

    expect(source).toContain("LegacyDirectMessageNotice,")
    expect(branch).toContain("<LegacyDirectMessageNotice />")
    expect(branch).not.toContain("<MessageComposer")
  })

  it("uses the shared warning and omits the composer in Merchant's nip04 branch", async () => {
    const source = await Bun.file(
      "apps/merchant/src/routes/messages.tsx"
    ).text()
    const branch = source.match(
      /selected\.transport === "nip04" \? \(([\s\S]*?)\n\s*\) : \(/
    )?.[1]

    expect(source).toContain("LegacyDirectMessageNotice,")
    expect(branch).toContain("<LegacyDirectMessageNotice />")
    expect(branch).not.toContain("<MessageComposer")
  })

  it("keeps Market inbox reads permissive and gates sends on readiness", async () => {
    const source = await Bun.file("apps/market/src/routes/messages.tsx").text()

    expect(source).toContain("MessagingReadinessNotice,")
    // Own-inbox reads are permissive (CND-208); no read query gates on readiness.
    expect(source).not.toContain("enabled: signerConnected && messagingReady")
    // Kind-14 sends still require an own declaration.
    expect(source).toContain(
      'if (!messagingReady) throw new Error("Encrypted messaging is not enabled")'
    )
    expect(source).toContain("<MessagingReadinessNotice")
    // Validated kind-16 order replies keep the recipient-delivery path even
    // when the sender self-copy declaration needs repair.
    expect(source).toContain('aria-label="Reply to merchant"')
    expect(source).not.toContain(
      "Enable encrypted messaging to reply in this order conversation."
    )
    // Network settings owns declaration setup/repair (CND-208).
    expect(source).not.toContain("publishPrivateMessageRelayDeclaration")
    expect(source).toContain('to: "/network"')
  })

  it("keeps Merchant inbox reads permissive and gates sends on readiness", async () => {
    const source = await Bun.file(
      "apps/merchant/src/routes/messages.tsx"
    ).text()

    expect(source).toContain("MessagingReadinessNotice,")
    // Own-inbox reads are permissive (CND-208); no read query gates on readiness.
    expect(source).not.toContain("enabled: signerConnected && messagingReady")
    // Sends still require an own declaration.
    expect(source).toContain("!messagingReady ||")
    expect(source).toContain("<MessagingReadinessNotice")
    // Network settings owns declaration setup/repair (CND-208).
    expect(source).not.toContain("publishPrivateMessageRelayDeclaration")
    expect(source).toContain('to: "/network"')
  })

  it("keeps declaration publishing owned by Network settings", async () => {
    for (const routePath of [
      "apps/market/src/routes/network.tsx",
      "apps/merchant/src/routes/network.tsx",
    ]) {
      const source = await Bun.file(routePath).text()
      expect(source).toContain("useAccountNetworkSettings")
      expect(source).toContain(
        "<RelaySettingsPanel controller={networkSettings} />"
      )
      expect(source).not.toContain("useInboxDeclaration")
    }

    const controller = await Bun.file(
      "packages/core/src/hooks/useAccountNetworkSettings.ts"
    ).text()
    expect(controller).toContain("publishAccountNetworkPreferenceUpdate")
    expect(controller).toContain("prepareAccountNetworkSetRolesAction")

    const networkSettingsView = await Bun.file(
      "packages/core/src/protocol/network-settings-view.ts"
    ).text()
    expect(networkSettingsView).toContain('type: "set_roles"')
    expect(networkSettingsView).toContain("inboxRelayUrls")
  })

  it("waits for first-login relay import before deciding inbox readiness", async () => {
    for (const routePath of [
      "apps/market/src/routes/messages.tsx",
      "apps/merchant/src/routes/messages.tsx",
      "apps/merchant/src/routes/orders.tsx",
    ]) {
      const source = await Bun.file(routePath).text()
      expect(source).toContain("session.relaySettingsReady")
      expect(source).toContain("relayScope: session.relayScope")
    }

    const networkController = await Bun.file(
      "packages/core/src/hooks/useAccountNetworkSettings.ts"
    ).text()
    expect(networkController).toContain("enabled: session.relaySettingsReady")
    expect(networkController).toContain("relayScope: session.relayScope")

    const hookSource = await Bun.file(
      "packages/core/src/hooks/useInboxDeclaration.ts"
    ).text()
    expect(hookSource).toContain("subscribeRelaySettingsChanges")
    expect(hookSource).toContain("invalidateInboxDeclaration(pubkey)")
    expect(hookSource).toContain("queryClient.invalidateQueries({ queryKey })")
    expect(hookSource).toContain('isLoading: status === "loading"')

    const ordersSource = await Bun.file(
      "apps/merchant/src/routes/orders.tsx"
    ).text()
    expect(ordersSource).toContain("toMessagingReadinessNoticeState(")
    expect(ordersSource).toContain("state={inboxReadinessNoticeState}")

    for (const routePath of [
      "apps/market/src/routes/messages.tsx",
      "apps/merchant/src/routes/messages.tsx",
    ]) {
      const source = await Bun.file(routePath).text()
      expect(source).toContain(") : dmReadiness.isLoading ? (")
      expect(source).toContain("Checking encrypted messaging setup...")
      expect(source).toContain('message.deliveryState === "failed" &&')
      expect(source).toContain("messagingReady")
    }

    const relaySettingsSource = await Bun.file(
      "packages/core/src/hooks/useRelaySettings.ts"
    ).text()
    expect(relaySettingsSource).toContain("relaySettingsContextKey")
    expect(relaySettingsSource).toContain("currentContextKeyRef.current")
    expect(relaySettingsSource).toContain(
      "currentContextKeyRef.current !== operationContextKey"
    )
  })
})
