import { describe, expect, it } from "bun:test"
import {
  EVENT_KINDS,
  config,
  createInMemoryAccountNetworkLocalStateRepository,
  createRelaySettingsFromPreferences,
  filterEligibleAccountRelayUrls,
  planRelayReads,
  planRelayWrites,
  selectPrivateMessageDeliveryRoute,
  setAccountNetworkRoutingSourceEnabled,
  type InboxDeclarationResolution,
} from "@conduit/core"

const OWNER = "a".repeat(64)
const PERSONAL_RELAY = "wss://personal.example"
const OVERLAP_RELAY = "wss://relay.ditto.pub"
const DECLARED_INBOX = "wss://inbox.example"

function resolution(
  overrides: Partial<InboxDeclarationResolution>
): InboxDeclarationResolution {
  return {
    pubkey: "b".repeat(64),
    state: "declared",
    relayUrls: [DECLARED_INBOX],
    stale: false,
    fetchedAt: 1,
    ...overrides,
  }
}

describe("app relay routing integration", () => {
  it("composes app and personal plans while the final I/O seam honors live source cutoffs", async () => {
    const settings = createRelaySettingsFromPreferences(
      [
        {
          url: OVERLAP_RELAY,
          readEnabled: true,
          writeEnabled: true,
        },
        {
          url: PERSONAL_RELAY,
          readEnabled: true,
          writeEnabled: true,
        },
      ],
      "published"
    )
    const routingPolicy = {
      appRelaysEnabled: true,
      personalRelaysEnabled: true,
    }
    const readPlan = planRelayReads({
      intent: "general",
      authenticatedPubkey: OWNER,
      settings,
      routingPolicy,
      maxRelays: 20,
      skipHealthFilter: true,
    })
    const writePlan = planRelayWrites({
      intent: "author_event",
      authorPubkey: OWNER,
      authenticatedPubkey: OWNER,
      settings,
      signedRelayListAuthoritative: true,
      routingPolicy,
      maxPrimaryRelays: 20,
      skipHealthFilter: true,
    })

    expect(readPlan.relayUrls.filter((url) => url === OVERLAP_RELAY)).toEqual([
      OVERLAP_RELAY,
    ])
    expect(readPlan.appRelayUrls).toContain(OVERLAP_RELAY)
    expect(readPlan.personalRelayUrls).toEqual(
      expect.arrayContaining([OVERLAP_RELAY, PERSONAL_RELAY])
    )
    expect(writePlan.appRelayUrls).toContain(OVERLAP_RELAY)
    expect(writePlan.personalRelayUrls).toEqual(
      expect.arrayContaining([OVERLAP_RELAY, PERSONAL_RELAY])
    )

    const repository = createInMemoryAccountNetworkLocalStateRepository()
    await repository.updateRoutingPolicy(OWNER, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "personal", false)
    )
    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        authenticatedPubkey: OWNER,
        candidateRelayUrls: readPlan.relayUrls,
        appRelayUrls: readPlan.appRelayUrls,
        personalRelayUrls: readPlan.personalRelayUrls,
        repository,
      })
    ).not.toContain(PERSONAL_RELAY)
    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        authenticatedPubkey: OWNER,
        candidateRelayUrls: readPlan.relayUrls,
        appRelayUrls: readPlan.appRelayUrls,
        personalRelayUrls: readPlan.personalRelayUrls,
        repository,
      })
    ).toContain(OVERLAP_RELAY)

    await repository.updateRoutingPolicy(OWNER, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "personal", true)
    )
    await repository.updateRoutingPolicy(OWNER, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "app", false)
    )
    const personalOnly = await filterEligibleAccountRelayUrls({
      accountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      candidateRelayUrls: readPlan.relayUrls,
      appRelayUrls: readPlan.appRelayUrls,
      personalRelayUrls: readPlan.personalRelayUrls,
      repository,
    })
    expect(personalOnly).toEqual(
      expect.arrayContaining([OVERLAP_RELAY, PERSONAL_RELAY])
    )
    expect(personalOnly).not.toContain("wss://relay.dreamith.to")

    await repository.updateRoutingPolicy(OWNER, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "personal", false)
    )
    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        candidateRelayUrls: [DECLARED_INBOX],
        appRelayUrls: [],
        personalRelayUrls: [],
        repository,
      })
    ).toEqual([DECLARED_INBOX])
  })

  it("keeps declared NIP-17 delivery exclusive and bounds fallback to validated orders", () => {
    const declared = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      declaration: resolution({}),
      validatedOrder: false,
      compatibilityEnabled: true,
    })
    expect(declared).toMatchObject({
      route: "declared_inbox",
      relayUrls: [DECLARED_INBOX],
    })

    const compatibility = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: true,
    })
    expect(compatibility).toMatchObject({
      route: "compatibility_order",
      relayUrls: config.dmCompatibilityOrderRelayUrls.slice(0, 3),
    })

    for (const state of [
      "signed_empty",
      "malformed",
      "lookup_partial",
      "lookup_unavailable",
    ] as const) {
      const blocked = selectPrivateMessageDeliveryRoute({
        rumorKind: EVENT_KINDS.ORDER,
        declaration: resolution({ state, relayUrls: [] }),
        validatedOrder: true,
        compatibilityEnabled: true,
      })
      expect(blocked.route).toBe("blocked")
    }

    expect(
      selectPrivateMessageDeliveryRoute({
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        declaration: resolution({ state: "not_observed", relayUrls: [] }),
        validatedOrder: false,
        compatibilityEnabled: true,
      }).route
    ).toBe("blocked")
    expect(
      selectPrivateMessageDeliveryRoute({
        rumorKind: EVENT_KINDS.ORDER,
        declaration: resolution({ state: "not_observed", relayUrls: [] }),
        validatedOrder: false,
        compatibilityEnabled: true,
      }).route
    ).toBe("blocked")
  })
})
