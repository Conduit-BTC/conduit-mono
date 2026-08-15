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
    const header = await Bun.file(
      "apps/market/src/components/MarketHeader.tsx"
    ).text()

    expect(header).toContain("session.relaySettingsReady")
    expect(header).toContain("session.relayScope")
    expect(header).toContain("void refetchProfile()")
    expect(header).toContain("profileRelayScopeRef.current === readyScope")
    expect(header).toContain("subscribeRelaySettingsChanges")
    expect(header).toContain("changedScope !== session.relayScope")
  })
})
