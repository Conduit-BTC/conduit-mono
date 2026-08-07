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

  it("gates Market inbox reads behind explicit messaging readiness", async () => {
    const source = await Bun.file("apps/market/src/routes/messages.tsx").text()

    expect(source).toContain("MessagingReadinessNotice,")
    expect(source).toContain("enabled: signerConnected && messagingReady")
    expect(source).toContain("<MessagingReadinessNotice")
    // Network settings owns declaration setup/repair (CND-208).
    expect(source).not.toContain("publishPrivateMessageRelayDeclaration")
    expect(source).toContain('to: "/network"')
  })

  it("gates Merchant inbox reads behind explicit messaging readiness", async () => {
    const source = await Bun.file(
      "apps/merchant/src/routes/messages.tsx"
    ).text()

    expect(source).toContain("MessagingReadinessNotice,")
    expect(source).toContain("enabled: signerConnected && messagingReady")
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
})
