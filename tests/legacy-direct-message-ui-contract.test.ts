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
    // Sends still require an own declaration.
    expect(source).toContain(
      'if (!messagingReady) throw new Error("Encrypted messaging is not enabled")'
    )
    expect(source).toContain("<MessagingReadinessNotice")
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
      expect(source).toContain("useInboxDeclaration")
      expect(source).toContain("privateInbox")
      expect(source).toContain("getInboxCandidateRelayUrls")
    }
  })

  it("waits for first-login relay import before deciding inbox readiness", async () => {
    for (const routePath of [
      "apps/market/src/routes/messages.tsx",
      "apps/market/src/routes/network.tsx",
      "apps/merchant/src/routes/messages.tsx",
      "apps/merchant/src/routes/network.tsx",
      "apps/merchant/src/routes/orders.tsx",
    ]) {
      const source = await Bun.file(routePath).text()
      expect(source).toContain("session.relaySettingsReady")
      expect(source).toContain("relayScope: session.relayScope")
    }

    const hookSource = await Bun.file(
      "packages/core/src/hooks/useInboxDeclaration.ts"
    ).text()
    expect(hookSource).toContain("subscribeRelaySettingsChanges")
    expect(hookSource).toContain("invalidateInboxDeclaration(pubkey)")
    expect(hookSource).toContain("queryClient.invalidateQueries({ queryKey })")

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
