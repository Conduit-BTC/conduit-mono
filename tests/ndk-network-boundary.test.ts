import { describe, expect, it } from "bun:test"

describe("NDK network boundary", () => {
  it("keeps contact-list reads on Conduit's planned verified reader", async () => {
    const [follows, merchantTrust] = await Promise.all([
      Bun.file("packages/core/src/protocol/follows.ts").text(),
      Bun.file("apps/market/src/hooks/useMerchantTrustContext.ts").text(),
    ])

    expect(follows).not.toContain(".fetchEvents(")
    expect(merchantTrust).not.toContain(".fetchEvents(")
    expect(follows).toContain("fetchSignedEventsFanoutDetailed")
    expect(follows).toContain("skipHealthFilter: true")
  })

  it("does not connect a shared NDK pool or use bare default publishing", async () => {
    const [sessionContext, relayPublisher] = await Promise.all([
      Bun.file("packages/core/src/context/ConduitSessionContext.tsx").text(),
      Bun.file("packages/core/src/protocol/relay-publish.ts").text(),
    ])

    expect(sessionContext).not.toContain("void connectNdk(")
    expect(relayPublisher).not.toContain("await event.publish()")
    expect(relayPublisher).toContain(
      "Refusing to publish without an approved relay target."
    )
  })

  it("refetches the signed-in profile after authenticated relay activation", async () => {
    const [sessionContext, header] = await Promise.all([
      Bun.file("packages/core/src/context/ConduitSessionContext.tsx").text(),
      Bun.file("apps/market/src/components/MarketHeader.tsx").text(),
    ])

    expect(sessionContext).toContain("!relaySettingsReady ||")
    expect(sessionContext).toContain("session.relayScope")
    expect(sessionContext).toContain("void refetchProfile()")
    expect(sessionContext).toContain(
      "profileRelayScopeRef.current === profileScope"
    )
    expect(sessionContext).toContain("subscribeRelaySettingsChanges")
    expect(sessionContext).toContain("scope !== activeScopeRef.current")
    expect(sessionContext).toContain("profileRefreshReadyRef.current")
    expect(header).not.toContain("subscribeRelaySettingsChanges")
    expect(header).not.toContain("useConduitSession")
  })
})
