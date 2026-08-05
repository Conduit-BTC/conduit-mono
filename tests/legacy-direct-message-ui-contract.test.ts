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
    expect(source).toContain("publishPrivateMessageRelayDeclaration")
    expect(source).toContain("<MessagingReadinessNotice")
  })

  it("gates Merchant inbox reads behind explicit messaging readiness", async () => {
    const source = await Bun.file(
      "apps/merchant/src/routes/messages.tsx"
    ).text()

    expect(source).toContain("MessagingReadinessNotice,")
    expect(source).toContain("enabled: signerConnected && messagingReady")
    expect(source).toContain("publishPrivateMessageRelayDeclaration")
    expect(source).toContain("<MessagingReadinessNotice")
  })
})
