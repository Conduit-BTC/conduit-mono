import { describe, expect, it } from "bun:test"
import {
  ACCOUNT_NETWORK_ROUTING_POLICY_VERSION,
  classifyAccountNetworkPersonalRelayEvidence,
  createDefaultAccountNetworkRoutingPolicy,
  isAccountNetworkRoutingSourceEnabled,
  markAccountNetworkSetupPrompt,
  migrateLegacyAccountNetworkRoutingPolicy,
  normalizeAccountNetworkRoutingPolicy,
  reconcileAccountNetworkRoutingPolicy,
  setAccountNetworkRoutingSourceEnabled,
} from "@conduit/core/protocol/account-network-routing-policy"

describe("account network routing policy", () => {
  it("keeps app and personal routing on until scoped NIP-65 absence is complete", () => {
    const policy = createDefaultAccountNetworkRoutingPolicy()
    expect(policy).toEqual({
      policyVersion: ACCOUNT_NETWORK_ROUTING_POLICY_VERSION,
      appRelaysEnabled: true,
      personalRelaysEnabled: true,
      appRelaysTouched: false,
      personalRelaysTouched: false,
      setupPromptState: "untouched",
    })
    expect(isAccountNetworkRoutingSourceEnabled(policy, "app")).toBe(true)
    expect(isAccountNetworkRoutingSourceEnabled(policy, "personal")).toBe(true)
    expect(policy).not.toHaveProperty("privateInboxEnabled")
  })

  it("strictly normalizes the policy version, booleans, and prompt state", () => {
    const policy = createDefaultAccountNetworkRoutingPolicy()
    expect(normalizeAccountNetworkRoutingPolicy(policy)).toEqual(policy)
    expect(() =>
      normalizeAccountNetworkRoutingPolicy({
        ...policy,
        policyVersion: ACCOUNT_NETWORK_ROUTING_POLICY_VERSION + 1,
      })
    ).toThrow("Unsupported account network routing policy version")
    expect(() =>
      normalizeAccountNetworkRoutingPolicy({
        ...policy,
        appRelaysEnabled: 1,
      })
    ).toThrow("must be a boolean")
    expect(() =>
      normalizeAccountNetworkRoutingPolicy({
        ...policy,
        setupPromptState: "dismissed",
      })
    ).toThrow("requires an update timestamp")
    expect(() =>
      normalizeAccountNetworkRoutingPolicy({
        ...policy,
        setupPromptUpdatedAt: 1,
      })
    ).toThrow("cannot have an update timestamp")
  })

  it("preserves the old personal route during a legacy migration", () => {
    expect(migrateLegacyAccountNetworkRoutingPolicy()).toMatchObject({
      appRelaysEnabled: true,
      personalRelaysEnabled: true,
      appRelaysTouched: false,
      personalRelaysTouched: false,
    })
  })

  it("marks source switches as touched without introducing inbox policy", () => {
    const appOff = setAccountNetworkRoutingSourceEnabled(
      createDefaultAccountNetworkRoutingPolicy(),
      "app",
      false
    )
    expect(appOff).toMatchObject({
      appRelaysEnabled: false,
      appRelaysTouched: true,
      personalRelaysTouched: false,
    })
    const personalOn = setAccountNetworkRoutingSourceEnabled(
      appOff,
      "personal",
      true
    )
    expect(personalOn).toMatchObject({
      personalRelaysEnabled: true,
      personalRelaysTouched: true,
    })
    expect(personalOn).not.toHaveProperty("privateInboxEnabled")
  })

  it("tracks prompt dismissal and action with explicit timestamps", () => {
    const dismissed = markAccountNetworkSetupPrompt(
      createDefaultAccountNetworkRoutingPolicy(),
      "dismissed",
      10
    )
    expect(dismissed).toMatchObject({
      setupPromptState: "dismissed",
      setupPromptUpdatedAt: 10,
    })
    expect(markAccountNetworkSetupPrompt(dismissed, "acted", 20)).toMatchObject(
      {
        setupPromptState: "acted",
        setupPromptUpdatedAt: 20,
      }
    )
  })

  it("enables an untouched personal layer from positive signed evidence", () => {
    const absentWithinScope = reconcileAccountNetworkRoutingPolicy(
      createDefaultAccountNetworkRoutingPolicy(),
      { state: "absent_within_scope", observedAt: 10 }
    )
    expect(absentWithinScope.personalRelaysEnabled).toBe(false)
    const reconciled = reconcileAccountNetworkRoutingPolicy(absentWithinScope, {
      state: "positive",
      source: "published",
      observedAt: 20,
    })
    expect(reconciled).toMatchObject({
      personalRelaysEnabled: true,
      personalRelaysTouched: false,
      setupPromptState: "acted",
      setupPromptUpdatedAt: 20,
    })
    expect(
      reconcileAccountNetworkRoutingPolicy(reconciled, {
        state: "positive",
        source: "retained",
        observedAt: 30,
      }).setupPromptUpdatedAt
    ).toBe(20)
  })

  it("never overrides an explicit personal switch", () => {
    const explicitlyOff = setAccountNetworkRoutingSourceEnabled(
      migrateLegacyAccountNetworkRoutingPolicy(),
      "personal",
      false
    )
    expect(
      reconcileAccountNetworkRoutingPolicy(explicitlyOff, {
        state: "positive",
        source: "retained",
        observedAt: 30,
      })
    ).toMatchObject({
      personalRelaysEnabled: false,
      personalRelaysTouched: true,
      setupPromptState: "acted",
    })

    const explicitlyOn = setAccountNetworkRoutingSourceEnabled(
      createDefaultAccountNetworkRoutingPolicy(),
      "personal",
      true
    )
    expect(
      reconcileAccountNetworkRoutingPolicy(explicitlyOn, {
        state: "absent_within_scope",
        observedAt: 40,
      })
    ).toEqual(explicitlyOn)
  })

  it("turns an untouched personal layer off only on complete scoped absence", () => {
    const legacy = migrateLegacyAccountNetworkRoutingPolicy()
    const unknown = reconcileAccountNetworkRoutingPolicy(legacy, {
      state: "unknown",
      reason: "partial",
    })
    expect(unknown).toEqual(legacy)
    expect(
      reconcileAccountNetworkRoutingPolicy(legacy, {
        state: "absent_within_scope",
        observedAt: 50,
      }).personalRelaysEnabled
    ).toBe(false)

    const absentWithinScope = reconcileAccountNetworkRoutingPolicy(legacy, {
      state: "absent_within_scope",
      observedAt: 50,
    })
    expect(
      reconcileAccountNetworkRoutingPolicy(absentWithinScope, {
        state: "unknown",
        reason: "unavailable",
      })
    ).toEqual(absentWithinScope)
  })

  it("classifies pending, retained, absent, and incomplete owner evidence", () => {
    expect(
      classifyAccountNetworkPersonalRelayEvidence({
        state: "declared",
        stale: false,
        lookup: { coverage: "complete", hadEvent: true, observedAt: 10 },
        current: {
          state: "declared",
          observedAt: 9,
          preferences: [{ url: "wss://pending.example" }],
        } as never,
        pendingDistribution: { stagedAt: 9 } as never,
      })
    ).toEqual({ state: "positive", source: "pending", observedAt: 9 })

    expect(
      classifyAccountNetworkPersonalRelayEvidence({
        state: "malformed",
        stale: true,
        current: {
          state: "malformed",
          observedAt: 12,
        } as never,
        lastUsable: {
          state: "declared",
          observedAt: 11,
          preferences: [{ url: "wss://retained.example" }],
        } as never,
        lookup: { coverage: "partial", hadEvent: false, observedAt: 13 },
      })
    ).toEqual({ state: "positive", source: "retained", observedAt: 12 })

    expect(
      classifyAccountNetworkPersonalRelayEvidence({
        state: "not_observed",
        stale: false,
        lastUsable: {
          state: "declared",
          observedAt: 13,
          preferences: [{ url: "wss://retained.example" }],
        } as never,
        lookup: { coverage: "complete", hadEvent: false, observedAt: 14 },
      })
    ).toEqual({ state: "positive", source: "retained", observedAt: 13 })

    expect(
      classifyAccountNetworkPersonalRelayEvidence({
        state: "signed_empty",
        stale: false,
        current: {
          state: "signed_empty",
          observedAt: 14,
          preferences: [],
        } as never,
        lookup: { coverage: "complete", hadEvent: true, observedAt: 14 },
      })
    ).toEqual({ state: "unknown", reason: "signed_empty" })

    expect(
      classifyAccountNetworkPersonalRelayEvidence({
        state: "not_observed",
        stale: false,
        lookup: { coverage: "complete", hadEvent: false, observedAt: 14 },
      })
    ).toEqual({ state: "absent_within_scope", observedAt: 14 })

    expect(
      classifyAccountNetworkPersonalRelayEvidence({
        state: "not_observed",
        stale: false,
        lookup: { coverage: "partial", hadEvent: false, observedAt: 14 },
      })
    ).toEqual({ state: "unknown", reason: "partial" })

    expect(
      classifyAccountNetworkPersonalRelayEvidence({
        state: "lookup_unavailable",
        stale: false,
        lookup: { coverage: "unavailable", hadEvent: false, observedAt: 15 },
      })
    ).toEqual({ state: "unknown", reason: "unavailable" })
  })
})
