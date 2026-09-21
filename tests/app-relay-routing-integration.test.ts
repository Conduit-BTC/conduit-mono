import { describe, expect, it } from "bun:test"
import {
  applyAccountNetworkRelayExclusion,
  CANONICAL_APP_RELAY_DEFINITIONS,
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
const PERSONAL_ONLY_RELAY = "wss://personal-only.example"
const REMOTE_PERSONAL_OVERLAP_RELAY = "wss://relay.nostr.band"
const OVERLAP_RELAY = "wss://relay.ditto.pub"
const DECLARED_INBOX = "wss://inbox.example"
const REMOVED_APP_RELAY = "wss://relay.damus.io"

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
      setAccountNetworkRoutingSourceEnabled(policy, "app", true)
    )
    await repository.update(OWNER, (state) =>
      applyAccountNetworkRelayExclusion(state, {
        relayUrl: OVERLAP_RELAY,
        relayListFrontier: { eventId: null, createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
        committedAt: 200,
      })
    )
    const wholeRelayExcluded = await filterEligibleAccountRelayUrls({
      accountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      candidateRelayUrls: readPlan.relayUrls,
      appRelayUrls: readPlan.appRelayUrls,
      personalRelayUrls: readPlan.personalRelayUrls,
      repository,
    })
    expect(wholeRelayExcluded).not.toContain(OVERLAP_RELAY)
    expect(wholeRelayExcluded).toContain(PERSONAL_RELAY)

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

  it("keeps the removed Damus relay out of app config, plans, and personal setup presets", () => {
    const settings = createRelaySettingsFromPreferences([], "published")
    const routingPolicy = {
      appRelaysEnabled: true,
      personalRelaysEnabled: false,
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
    const appConfigUrls = [
      ...CANONICAL_APP_RELAY_DEFINITIONS.map((relay) => relay.url),
      ...config.appReadRelayUrls,
      ...config.appCommerceRelayUrls,
      ...config.appWriteRelayUrls,
      ...config.commerceDiscoveryRelayUrls,
      ...config.dmCompatibilityOrderRelayUrls,
    ]
    const personalSetupPresetUrls = CANONICAL_APP_RELAY_DEFINITIONS.filter(
      (relay) => relay.nip65Preset !== null || relay.nip17Preset
    ).map((relay) => relay.url)

    expect(appConfigUrls).not.toContain(REMOVED_APP_RELAY)
    expect(personalSetupPresetUrls).not.toContain(REMOVED_APP_RELAY)
    expect(readPlan.relayUrls).not.toContain(REMOVED_APP_RELAY)
    expect(readPlan.appRelayUrls).not.toContain(REMOVED_APP_RELAY)
    expect(writePlan.primaryRelayUrls).not.toContain(REMOVED_APP_RELAY)
    expect(writePlan.appRelayUrls).not.toContain(REMOVED_APP_RELAY)
  })

  it("preserves remote NIP-65 authority across app and personal source cutoffs", async () => {
    const remoteAuthor = "b".repeat(64)
    const settings = createRelaySettingsFromPreferences(
      [
        { url: PERSONAL_RELAY, readEnabled: true, writeEnabled: true },
        {
          url: REMOTE_PERSONAL_OVERLAP_RELAY,
          readEnabled: true,
          writeEnabled: true,
        },
        { url: PERSONAL_ONLY_RELAY, readEnabled: true, writeEnabled: true },
      ],
      "published"
    )
    const relayLists = new Map([
      [
        remoteAuthor,
        {
          pubkey: remoteAuthor,
          readRelayUrls: [],
          writeRelayUrls: [OVERLAP_RELAY, REMOTE_PERSONAL_OVERLAP_RELAY],
          eventCreatedAt: 1,
          cachedAt: 1,
        },
      ],
    ])
    const plan = planRelayReads({
      intent: "general",
      authors: [remoteAuthor],
      relayLists,
      authenticatedPubkey: OWNER,
      settings,
      routingPolicy: {
        appRelaysEnabled: true,
        personalRelaysEnabled: true,
      },
      maxRelays: 20,
      skipHealthFilter: true,
    })
    expect(plan.independentRelayUrls).toEqual(
      expect.arrayContaining([OVERLAP_RELAY, REMOTE_PERSONAL_OVERLAP_RELAY])
    )
    expect(plan.appRelayUrls).toContain(OVERLAP_RELAY)
    expect(plan.personalRelayUrls).toEqual(
      expect.arrayContaining([
        PERSONAL_RELAY,
        REMOTE_PERSONAL_OVERLAP_RELAY,
        PERSONAL_ONLY_RELAY,
      ])
    )

    const repository = createInMemoryAccountNetworkLocalStateRepository()
    await repository.updateRoutingPolicy(OWNER, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "app", false)
    )
    const appDisabled = await filterEligibleAccountRelayUrls({
      accountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      candidateRelayUrls: plan.candidateRelayUrls,
      appRelayUrls: plan.appRelayUrls,
      personalRelayUrls: plan.personalRelayUrls,
      independentRelayUrls: plan.independentRelayUrls,
      repository,
    })
    expect(appDisabled).toContain(OVERLAP_RELAY)
    expect(appDisabled).not.toContain("wss://relay.dreamith.to")

    await repository.updateRoutingPolicy(OWNER, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "app", true)
    )
    await repository.updateRoutingPolicy(OWNER, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "personal", false)
    )
    const personalDisabled = await filterEligibleAccountRelayUrls({
      accountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      candidateRelayUrls: plan.candidateRelayUrls,
      appRelayUrls: plan.appRelayUrls,
      personalRelayUrls: plan.personalRelayUrls,
      independentRelayUrls: plan.independentRelayUrls,
      repository,
    })
    expect(personalDisabled).toContain(REMOTE_PERSONAL_OVERLAP_RELAY)
    expect(personalDisabled).not.toContain(PERSONAL_RELAY)
    expect(personalDisabled).not.toContain(PERSONAL_ONLY_RELAY)

    await repository.update(OWNER, (state) =>
      applyAccountNetworkRelayExclusion(state, {
        relayUrl: REMOTE_PERSONAL_OVERLAP_RELAY,
        relayListFrontier: { eventId: null, createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
        committedAt: 300,
      })
    )
    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        authenticatedPubkey: OWNER,
        candidateRelayUrls: plan.candidateRelayUrls,
        appRelayUrls: plan.appRelayUrls,
        personalRelayUrls: plan.personalRelayUrls,
        independentRelayUrls: plan.independentRelayUrls,
        repository,
      })
    ).not.toContain(REMOTE_PERSONAL_OVERLAP_RELAY)
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
