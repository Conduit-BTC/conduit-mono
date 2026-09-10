import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("relay-list publish contract", () => {
  it("delegates account signing and publishing to the shared mutation owner", async () => {
    const relayHook = await readFile(
      "packages/core/src/hooks/useRelaySettings.ts",
      "utf8"
    )
    const inboxHook = await readFile(
      "packages/core/src/hooks/useInboxDeclaration.ts",
      "utf8"
    )

    expect(relayHook).toContain("reviewRelaySettingsAccountMutation")
    expect(relayHook).toContain("publishAccountNetworkMutation")
    expect(relayHook).toContain("retryAccountNetworkMutation")
    expect(relayHook).toContain("createNdkNostrEventSigner")
    expect(relayHook).not.toContain("new NDKEvent")
    expect(relayHook).not.toContain("publishWithPlanner")
    expect(relayHook).not.toContain("event.sign(")
    expect(relayHook).not.toContain("loadRelaySettingsPresentation")
    expect(relayHook).not.toContain("setAccountRelaySettingsProjection")
    expect(relayHook).not.toContain("runtimeRelaySettings")
    expect(relayHook).toContain(
      "localSettingsControlConnections &&\n      previousContextKeyRef.current"
    )
    expect(relayHook).toContain(
      "const next = accountScoped\n        ? { ...updated, updatedAt: Date.now() }\n        : saveRelaySettings(updated, scope)"
    )

    expect(inboxHook).toContain("reviewInboxDeclarationAccountMutation")
    expect(inboxHook).toContain("publishAccountNetworkMutation")
    expect(inboxHook).toContain("retryAccountNetworkMutation")
    expect(inboxHook).toContain("redistributeAccountNetworkInboxDeclaration")
    expect(inboxHook).not.toContain("publishPrivateMessageRelayDeclaration")
    expect(inboxHook).not.toContain(
      "redistributePrivateMessageRelayDeclaration"
    )
    expect(inboxHook).not.toContain("getNdk()")
    expect(inboxHook).not.toContain("subscribeRelaySettingsChanges")
  })
})
