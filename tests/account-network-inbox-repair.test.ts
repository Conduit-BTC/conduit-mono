import { describe, expect, it } from "bun:test"
import type { NetworkPreferenceRelayOutcome } from "../packages/core/src/db"
import {
  applyNetworkPreferenceDistributionOutcomes,
  hasCompletedExactNetworkPreferenceReadback,
  unresolvedNetworkPreferenceReadbackRelayUrls,
} from "../packages/core/src/protocol/network-preference-delivery"
import { toMessagingReadinessNoticeState } from "../packages/ui/src/components/MessagingReadinessNotice"

function pendingOutcomes(): NetworkPreferenceRelayOutcome[] {
  return ["wss://shared-a.example", "wss://shared-b.example"].map(
    (relayUrl) => ({
      relayUrl,
      publishStatus: "pending",
      publishAttemptCount: 0,
      readbackStatus: "pending",
      readbackAttemptCount: 0,
    })
  )
}

describe("account Network inbox repair representation", () => {
  it("requires complete bounded exact readback before confirmation", () => {
    const partial = applyNetworkPreferenceDistributionOutcomes(
      pendingOutcomes(),
      {
        readback: [{ relayUrl: "wss://shared-a.example", status: "observed" }],
        observedAt: 1_000,
      }
    )
    expect(hasCompletedExactNetworkPreferenceReadback(partial)).toBe(false)
    expect(unresolvedNetworkPreferenceReadbackRelayUrls(partial)).toEqual([
      "wss://shared-b.example",
    ])

    const complete = applyNetworkPreferenceDistributionOutcomes(partial, {
      readback: [{ relayUrl: "wss://shared-b.example", status: "absent" }],
      observedAt: 2_000,
    })
    expect(hasCompletedExactNetworkPreferenceReadback(complete)).toBe(true)
  })

  it("keeps timed-out shared evidence pending instead of treating it as absence", () => {
    const evidence = applyNetworkPreferenceDistributionOutcomes(
      pendingOutcomes(),
      {
        readback: [
          { relayUrl: "wss://shared-a.example", status: "observed" },
          { relayUrl: "wss://shared-b.example", status: "timed_out" },
        ],
        observedAt: 1_000,
      }
    )

    expect(hasCompletedExactNetworkPreferenceReadback(evidence)).toBe(false)
    expect(unresolvedNetworkPreferenceReadbackRelayUrls(evidence)).toEqual([
      "wss://shared-b.example",
    ])
  })

  it("keeps observation read-only outside the shared mutation owner", async () => {
    const [readinessHook, controller, mutationOwner] = await Promise.all([
      Bun.file("packages/core/src/hooks/useInboxDeclaration.ts").text(),
      Bun.file("packages/core/src/hooks/useAccountNetworkSettings.ts").text(),
      Bun.file("packages/core/src/protocol/account-network-mutation.ts").text(),
    ])

    expect(readinessHook).not.toContain("publishDeclaration:")
    expect(readinessHook).not.toContain("publishPrivateMessageRelayDeclaration")
    expect(controller).toContain("publishAccountNetworkMutation")
    expect(controller).toContain("redistributeAccountNetworkInboxDeclaration")
    expect(mutationOwner).toContain("previousInboxRelayUrls")
    expect(mutationOwner).toContain("removeLegacyReadRecoveryRelayUrls")
  })

  it("keeps recovery and exact-readback status explicit in the shared panel", async () => {
    const panel = await Bun.file(
      "packages/ui/src/components/RelaySettingsPanel.tsx"
    ).text()

    expect(panel).toContain("Recovery read-only")
    expect(panel).toContain("7-day recovery window")
    expect(panel).toContain("exact readback")
    expect(panel).toContain("unresolved")
    expect(panel).toContain("excluded")
    expect(panel).not.toContain("PrivateInboxSection")
  })

  it("preserves every non-ready messaging notice state", () => {
    expect(toMessagingReadinessNoticeState("ready")).toBeNull()
    expect(toMessagingReadinessNoticeState("loading")).toBeNull()
    for (const state of [
      "not_observed",
      "distribution_pending",
      "signed_empty",
      "malformed",
      "lookup_failed",
      "lookup_partial",
      "lookup_unavailable",
    ] as const) {
      expect(toMessagingReadinessNoticeState(state)).toBe(state)
    }
  })
})
