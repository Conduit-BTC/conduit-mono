import { describe, expect, it } from "bun:test"
import {
  buildAccountNetworkSettingsView,
  countAccountNetworkChangedKinds,
  getAccountNetworkRemovalInstruction,
  orderAccountNetworkRelayRows,
  prepareAccountNetworkSetRolesAction,
  validateAccountNetworkDesiredRoles,
  type AccountNetworkPreferenceUpdateRecord,
  type AccountNetworkPreferencesReconciliation,
  type AccountNetworkRelayRowView,
} from "@conduit/core"

function row(
  url: string,
  overrides: Partial<AccountNetworkRelayRowView> = {}
): AccountNetworkRelayRowView {
  return {
    url,
    readEnabled: true,
    publishEnabled: true,
    privateInboxEnabled: false,
    readState: "published",
    publishState: "published",
    privateInboxState: null,
    signedPosition: 0,
    candidate: false,
    reachability: "not_checked",
    capability: {
      configuredUses: [],
      observedCommerce: false,
      nip11: "not_checked",
      searchAdvertised: false,
      authEvidence: "untested",
    },
    ...overrides,
  }
}

function pendingRecord(): AccountNetworkPreferenceUpdateRecord {
  const outcome = (relayUrl: string) => ({
    relayUrl,
    publishStatus: "timed_out" as const,
    publishAttemptCount: 1,
    readbackStatus: "timed_out" as const,
    readbackAttemptCount: 1,
  })
  const checkpoint = (kind: 10002 | 10050) => ({
    kind,
    signedEvent: {
      id: `${kind}`.padStart(64, "0"),
      pubkey: "a".repeat(64),
      created_at: 2,
      kind,
      tags: [],
      content: "",
      sig: "b".repeat(128),
    },
    stagedAt: 2,
    relayPlan: ["wss://plan.example"],
    relayOutcomes: [outcome("wss://plan.example")],
    state: "active" as const,
  })
  return {
    pubkey: "a".repeat(64),
    updateId: "pending-whole-removal",
    action: "whole_relay_removal",
    removedRelayUrl: "wss://removed.example",
    baseRelayList: { eventId: "old-relays", createdAt: 1, state: "declared" },
    baseInboxDeclaration: {
      eventId: "old-inbox",
      createdAt: 1,
      state: "declared",
    },
    nip65Preferences: [
      {
        url: "wss://first.example",
        readEnabled: true,
        writeEnabled: true,
      },
      {
        url: "wss://second.example",
        readEnabled: true,
        writeEnabled: true,
      },
    ],
    inboxRelayUrls: ["wss://first.example"],
    previousInboxRelayUrls: ["wss://removed.example", "wss://first.example"],
    legacyRecoveryRemovedRelayUrls: ["wss://removed.example"],
    legacyRecoveryDiscarded: true,
    cutoverPolicyVersion: 1,
    cutoverGraceMs: 30 * 24 * 60 * 60 * 1_000,
    checkpoints: [checkpoint(10002), checkpoint(10050)],
    stagedAt: 2,
    updatedAt: 2,
  }
}

function reconciliation(
  pendingUpdate: AccountNetworkPreferenceUpdateRecord | null
): AccountNetworkPreferencesReconciliation {
  return {
    projection: {
      pubkey: "a".repeat(64),
      relayScope: "account:test",
      rows: [
        {
          url: "wss://removed.example",
          position: 0,
          read: "published",
          write: "published",
          privateInbox: "published",
          draftRead: false,
          draftWrite: false,
        },
        {
          url: "wss://first.example",
          position: 1,
          read: "published",
          write: "published",
          privateInbox: "published",
          draftRead: false,
          draftWrite: false,
        },
        {
          url: "wss://second.example",
          position: 2,
          read: "published",
          write: "published",
          privateInbox: null,
          draftRead: false,
          draftWrite: false,
        },
      ],
      relayListState: "declared",
      relayListStale: false,
      inboxState: "declared",
      inboxStale: false,
      runtimeRelaySettings: { version: 4, entries: [], updatedAt: 1 },
    },
    ownerRelayList: {
      state: "declared",
      stale: false,
      lookup: { coverage: "complete" },
    },
    inboxDeclaration: {
      state: "declared",
      stale: false,
      observation: { coverage: "complete" },
    },
    legacyMigration: "not_applicable",
    pendingUpdate,
    pendingUpdateStatus: pendingUpdate ? "ready" : "none",
  } as unknown as AccountNetworkPreferencesReconciliation
}

describe("account Network settings view", () => {
  it("orders one flat list by approved evidence tiers and stable ties", () => {
    const ordered = orderAccountNetworkRelayRows([
      row("wss://candidate-z.example", {
        readEnabled: false,
        publishEnabled: false,
        candidate: true,
        signedPosition: null,
      }),
      row("wss://plain.example", { signedPosition: 1 }),
      row("wss://nip11-only.example", {
        signedPosition: 0,
        capability: {
          configuredUses: [],
          observedCommerce: false,
          nip11: "available",
          searchAdvertised: false,
          authEvidence: "untested",
        },
      }),
      row("wss://advertised.example", {
        signedPosition: 99,
        capability: {
          configuredUses: [],
          observedCommerce: false,
          nip11: "available",
          searchAdvertised: false,
          authEvidence: "succeeded",
        },
      }),
      row("wss://observed.example", {
        signedPosition: 50,
        capability: {
          configuredUses: [],
          observedCommerce: true,
          nip11: "not_checked",
          searchAdvertised: false,
          authEvidence: "untested",
        },
      }),
      row("wss://configured.example", {
        signedPosition: 75,
        capability: {
          configuredUses: ["product_discovery"],
          observedCommerce: false,
          nip11: "not_checked",
          searchAdvertised: false,
          authEvidence: "untested",
        },
      }),
      row("wss://candidate-a.example", {
        readEnabled: false,
        publishEnabled: false,
        candidate: true,
        signedPosition: null,
      }),
    ])

    expect(ordered.map((entry) => entry.url)).toEqual([
      "wss://observed.example",
      "wss://configured.example",
      "wss://advertised.example",
      "wss://nip11-only.example",
      "wss://plain.example",
      "wss://candidate-a.example",
      "wss://candidate-z.example",
    ])
  })

  it("separates exact configured uses from observed relay capabilities", () => {
    const base = reconciliation(null)
    const relayUrls = [
      "wss://relay.conduit.market",
      "wss://relay.ditto.pub",
      "wss://nos.lol",
      "wss://relay.primal.net",
      "wss://premium.primal.net",
    ]
    const configured = {
      ...base,
      projection: {
        ...base.projection,
        rows: relayUrls.map((url, position) => ({
          url,
          position,
          read: "published" as const,
          write: "published" as const,
          privateInbox: null,
          draftRead: false,
          draftWrite: false,
        })),
      },
    }

    const view = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: configured,
      error: null,
    })

    expect(
      view.capabilityByUrl["wss://relay.conduit.market"]?.configuredUses
    ).toEqual([
      "app_publishing",
      "order_messages",
      "private_inbox",
      "inbox_discovery",
    ])
    expect(
      view.capabilityByUrl["wss://relay.ditto.pub"]?.configuredUses
    ).toEqual([
      "product_discovery",
      "search",
      "order_messages",
      "private_inbox",
      "inbox_discovery",
      "general_reads",
      "public_activity",
    ])
    expect(view.capabilityByUrl["wss://nos.lol"]?.configuredUses).toEqual([
      "inbox_discovery",
      "general_reads",
      "public_activity",
    ])
    expect(
      view.capabilityByUrl["wss://relay.primal.net"]?.configuredUses
    ).toEqual(["inbox_discovery", "general_reads", "public_activity"])
    expect(
      view.capabilityByUrl["wss://premium.primal.net"]?.configuredUses
    ).toEqual([])
    expect(
      view.capabilityByUrl["wss://relay.conduit.market"]?.observedCommerce
    ).toBe(false)
  })

  it("does not treat a search-only active probe as observed commerce", () => {
    const base = reconciliation(null)
    const searchOnlyEntry = {
      url: "wss://second.example",
      readEnabled: false,
      writeEnabled: false,
      section: "commerce" as const,
      capabilities: {
        nip11: true,
        search: true,
        dm: true,
        auth: true,
        commerce: true,
        protectedMessages: true,
        listings: true,
        cleanup: true,
      },
      warnings: {
        dmWithoutAuth: false,
        staleRelayInfo: false,
        unreachable: false,
        commercePartialSupport: false,
      },
      observations: {
        search: {
          supported: true,
          status: "observed" as const,
          confidence: "observed" as const,
          evidence: ["active-probe" as const],
        },
        auth: {
          supported: true,
          status: "advertised" as const,
          confidence: "advertised" as const,
          evidence: ["nip11" as const],
        },
        protectedMessages: {
          supported: true,
          status: "known" as const,
          confidence: "known" as const,
          evidence: ["conduit-commerce-profile" as const],
        },
        listings: {
          supported: true,
          status: "known" as const,
          confidence: "known" as const,
          evidence: ["conduit-commerce-profile" as const],
        },
        cleanup: {
          supported: true,
          status: "known" as const,
          confidence: "known" as const,
          evidence: ["conduit-commerce-profile" as const],
        },
      },
    }
    const view = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: base,
      error: null,
      capabilityEntries: [searchOnlyEntry],
    })

    expect(view.capabilityByUrl[searchOnlyEntry.url]?.observedCommerce).toBe(
      false
    )
  })

  it("projects presentation-safe signed frontier evidence for both relay preference events", () => {
    const base = reconciliation(null)
    const withEvidence = {
      ...base,
      ownerRelayList: {
        ...base.ownerRelayList,
        stale: true,
        current: {
          signedEvent: { created_at: 101 },
          observedAt: 202_000,
          completeObservedAt: 201_000,
          sourceRelayUrls: [
            "wss://source-a.example",
            "wss://source-b.example",
            "wss://source-a.example",
          ],
        },
        lookup: { coverage: "partial" },
      },
      inboxDeclaration: {
        ...base.inboxDeclaration,
        stale: true,
        eventId: "inbox-frontier",
        eventCreatedAt: 303,
        fetchedAt: 404_000,
        sourceRelayUrls: [
          "wss://source-a.example",
          "wss://source-c.example",
          "wss://source-c.example",
        ],
        observation: {
          coverage: "partial",
          eventId: "inbox-frontier",
        },
      },
    } as unknown as AccountNetworkPreferencesReconciliation

    const view = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: withEvidence,
      error: null,
    })

    expect(view.relayList).toEqual({
      state: "declared",
      stale: true,
      coverage: "partial",
      eventCreatedAt: 101,
      observedAt: 202_000,
      sourceRelayCount: 2,
    })
    expect(view.inbox).toEqual({
      state: "declared",
      stale: true,
      coverage: "partial",
      eventCreatedAt: 303,
      observedAt: 404_000,
      sourceRelayCount: 2,
    })
  })

  it("does not mislabel a degraded inbox lookup time as an event observation", () => {
    const base = reconciliation(null)
    const withRetainedEvidence = {
      ...base,
      inboxDeclaration: {
        ...base.inboxDeclaration,
        stale: true,
        eventId: "retained-inbox-frontier",
        eventCreatedAt: 505,
        fetchedAt: 606_000,
        sourceRelayUrls: ["wss://source-a.example"],
        observation: {
          coverage: "partial",
        },
      },
    } as unknown as AccountNetworkPreferencesReconciliation

    const view = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: withRetainedEvidence,
      error: null,
    })

    expect(view.inbox).toMatchObject({
      eventCreatedAt: 505,
      observedAt: null,
      sourceRelayCount: 1,
    })
  })

  it("projects complete retained inbox evidence without a new lookup observation", () => {
    const base = reconciliation(null)
    const withRetainedEvidence = {
      ...base,
      inboxDeclaration: {
        ...base.inboxDeclaration,
        stale: false,
        eventId: "retained-inbox-frontier",
        eventCreatedAt: 707,
        fetchedAt: 808_000,
        sourceRelayUrls: ["wss://source-a.example"],
        observation: undefined,
      },
    } as unknown as AccountNetworkPreferencesReconciliation

    const view = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: withRetainedEvidence,
      error: null,
    })

    expect(view.inbox).toMatchObject({
      eventCreatedAt: 707,
      observedAt: 808_000,
      sourceRelayCount: 1,
    })
  })

  it("projects passive reachability from the latest preference refresh", () => {
    const base = reconciliation(null)
    const withRelayOutcomes = {
      ...base,
      ownerRelayList: {
        ...base.ownerRelayList,
        observation: {
          coverage: "partial",
          attemptedRelayUrls: ["wss://removed.example", "wss://first.example"],
          successfulRelayUrls: ["wss://first.example"],
          failedRelayUrls: ["wss://removed.example"],
          cappedRelayUrls: [],
          eventSourceRelayUrls: [],
        },
      },
      inboxDeclaration: {
        ...base.inboxDeclaration,
        observation: {
          coverage: "partial",
          attemptedRelayUrls: ["wss://first.example", "wss://second.example"],
          successfulRelayUrls: ["wss://second.example"],
          failedRelayUrls: ["wss://first.example"],
          eventSourceRelayUrls: [],
        },
      },
    } as unknown as AccountNetworkPreferencesReconciliation

    const view = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: withRelayOutcomes,
      error: null,
    })
    const reachability = Object.fromEntries(
      view.rows.map((entry) => [entry.url, entry.reachability])
    )

    expect(reachability).toEqual({
      "wss://first.example": "responded",
      "wss://removed.example": "issue",
      "wss://second.example": "responded",
    })
  })

  it("projects the durable pending desired frontier and drops a whole-setup removal immediately", () => {
    const view = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: reconciliation(pendingRecord()),
      error: null,
    })

    expect(view.rows.map((entry) => entry.url)).toEqual([
      "wss://first.example",
      "wss://second.example",
    ])
    expect(view.rows.every((entry) => entry.readState === "pending")).toBe(true)
    expect(view.rows[0]?.privateInboxState).toBe("pending")
    expect(view.activeUpdateId).toBe("pending-whole-removal")
    expect(view.pendingCheckpoints).toHaveLength(2)
    expect(view.pendingCheckpoints.every((entry) => entry.retryAvailable)).toBe(
      true
    )
  })

  it("never exposes a transient update from another signer account", () => {
    const view = buildAccountNetworkSettingsView({
      accountPubkey: "c".repeat(64),
      status: "reconciling",
      reconciliation: null,
      error: null,
      transientUpdate: pendingRecord(),
    })

    expect(view.rows).toEqual([])
    expect(view.pendingStatus).toBe("none")
    expect(view.activeUpdateId).toBeNull()
  })

  it("keeps both complete desired role sets during a one-kind same-account refetch", () => {
    const transient = pendingRecord()
    transient.checkpoints = transient.checkpoints.filter(
      (checkpoint) => checkpoint.kind === 10002
    )
    const view = buildAccountNetworkSettingsView({
      accountPubkey: transient.pubkey,
      status: "reconciling",
      reconciliation: null,
      error: null,
      transientUpdate: transient,
    })

    expect(view.rows.map((entry) => entry.url)).toEqual([
      "wss://first.example",
      "wss://second.example",
    ])
    expect(view.rows[0]?.readState).toBe("pending")
    expect(view.rows[0]?.privateInboxState).toBe("published")
  })

  it("omits an explicitly superseded kind during a mixed checkpoint refetch", () => {
    const transient = pendingRecord()
    transient.checkpoints = transient.checkpoints.map((checkpoint) =>
      checkpoint.kind === 10002
        ? { ...checkpoint, state: "superseded" as const }
        : checkpoint
    )
    const view = buildAccountNetworkSettingsView({
      accountPubkey: transient.pubkey,
      status: "reconciling",
      reconciliation: null,
      error: null,
      transientUpdate: transient,
    })

    expect(view.rows.map((entry) => entry.url)).toEqual(["wss://first.example"])
    expect(view.rows[0]).toMatchObject({
      readEnabled: false,
      publishEnabled: false,
      privateInboxEnabled: true,
      readState: null,
      publishState: null,
      privateInboxState: "pending",
    })
  })

  it("labels confirmed active checkpoint memberships signed while partial memberships remain pending", () => {
    const partial = pendingRecord()
    const confirmed = pendingRecord()
    confirmed.checkpoints = confirmed.checkpoints.map((checkpoint) =>
      checkpoint.kind === 10002
        ? {
            ...checkpoint,
            relayOutcomes: checkpoint.relayOutcomes.map((outcome) => ({
              ...outcome,
              publishStatus: "acked" as const,
              readbackStatus: "observed" as const,
            })),
          }
        : checkpoint
    )
    const partialView = buildAccountNetworkSettingsView({
      accountPubkey: partial.pubkey,
      status: "ready",
      reconciliation: reconciliation(partial),
      error: null,
    })
    const confirmedView = buildAccountNetworkSettingsView({
      accountPubkey: confirmed.pubkey,
      status: "ready",
      reconciliation: reconciliation(confirmed),
      error: null,
    })

    expect(
      partialView.rows.find((entry) => entry.url === "wss://second.example")
        ?.readState
    ).toBe("pending")
    expect(
      confirmedView.rows.find((entry) => entry.url === "wss://second.example")
        ?.readState
    ).toBe("published")
    expect(
      confirmedView.pendingCheckpoints.find(
        (checkpoint) => checkpoint.kind === 10002
      )?.state
    ).toBe("confirmed")
  })

  it("uses staged signed order rather than the superseded projection order", () => {
    const pending = pendingRecord()
    pending.nip65Preferences.reverse()
    const view = buildAccountNetworkSettingsView({
      accountPubkey: pending.pubkey,
      status: "ready",
      reconciliation: reconciliation(pending),
      error: null,
    })

    expect(view.rows.map((entry) => entry.url)).toEqual([
      "wss://second.example",
      "wss://first.example",
    ])
  })

  it("keeps revision stable across evidence reordering but changes it for a new signed frontier", () => {
    const base = reconciliation(null)
    const firstFrontier = {
      ...base,
      ownerRelayList: {
        ...base.ownerRelayList,
        current: { signedEvent: { id: "frontier-a" } },
      },
    } as AccountNetworkPreferencesReconciliation
    const secondFrontier = {
      ...base,
      ownerRelayList: {
        ...base.ownerRelayList,
        current: { signedEvent: { id: "frontier-b" } },
      },
    } as AccountNetworkPreferencesReconciliation
    const refreshedEvidence = {
      ...firstFrontier,
      ownerRelayList: {
        ...firstFrontier.ownerRelayList,
        observation: {
          coverage: "complete",
          attemptedRelayUrls: ["wss://first.example"],
          successfulRelayUrls: ["wss://first.example"],
          failedRelayUrls: [],
          cappedRelayUrls: [],
          eventSourceRelayUrls: [],
        },
      },
    } as AccountNetworkPreferencesReconciliation
    const capabilityEntry = {
      url: "wss://second.example",
      readEnabled: false,
      writeEnabled: false,
      section: "public" as const,
      capabilities: {
        nip11: true,
        search: true,
        dm: false,
        auth: false,
        commerce: false,
      },
      warnings: {
        dmWithoutAuth: false,
        staleRelayInfo: false,
        unreachable: false,
        commercePartialSupport: false,
      },
      observations: {
        search: {
          supported: true,
          status: "advertised" as const,
          confidence: "advertised" as const,
          evidence: ["nip11" as const],
        },
        auth: {
          supported: false,
          status: "unknown" as const,
          confidence: "none" as const,
          evidence: [],
        },
        protectedMessages: {
          supported: false,
          status: "unknown" as const,
          confidence: "none" as const,
          evidence: [],
        },
        listings: {
          supported: false,
          status: "unknown" as const,
          confidence: "none" as const,
          evidence: [],
        },
        cleanup: {
          supported: false,
          status: "unknown" as const,
          confidence: "none" as const,
          evidence: [],
        },
      },
    }
    const before = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: firstFrontier,
      error: null,
    })
    const reordered = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: firstFrontier,
      error: null,
      capabilityEntries: [capabilityEntry],
    })
    const advanced = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: secondFrontier,
      error: null,
      capabilityEntries: [capabilityEntry],
    })
    const refreshed = buildAccountNetworkSettingsView({
      accountPubkey: "a".repeat(64),
      status: "ready",
      reconciliation: refreshedEvidence,
      error: null,
    })

    expect(reordered.rows[0]?.url).toBe("wss://second.example")
    expect(reordered.revision).toBe(before.revision)
    expect(
      refreshed.rows.find((entry) => entry.url === "wss://first.example")
        ?.reachability
    ).toBe("responded")
    expect(refreshed.revision).toBe(before.revision)
    expect(advanced.revision).not.toBe(reordered.revision)
  })

  it("requires a safe general setup and at least one Private inbox relay", () => {
    const safe = [
      {
        url: "wss://first.example",
        readEnabled: true,
        publishEnabled: true,
        privateInboxEnabled: true,
      },
      {
        url: "wss://second.example",
        readEnabled: true,
        publishEnabled: false,
        privateInboxEnabled: false,
      },
    ]

    expect(validateAccountNetworkDesiredRoles(safe)).toBeNull()
    expect(
      validateAccountNetworkDesiredRoles(
        safe.map((entry) => ({ ...entry, privateInboxEnabled: false }))
      )
    ).toBe("Choose at least one Private inbox relay.")
    expect(getAccountNetworkRemovalInstruction(safe, safe[0]!.url)).toBe(
      "Add a replacement relay and enable Read or Publish plus Private inbox before removing this one."
    )
  })

  it("infers whether one or both signed objects changed", () => {
    const baseline = [
      {
        url: "wss://first.example",
        readEnabled: true,
        publishEnabled: true,
        privateInboxEnabled: true,
      },
      {
        url: "wss://second.example",
        readEnabled: true,
        publishEnabled: false,
        privateInboxEnabled: false,
      },
    ]
    expect(countAccountNetworkChangedKinds(baseline, baseline)).toBe(0)
    expect(
      countAccountNetworkChangedKinds(baseline, [
        { ...baseline[0]!, publishEnabled: false },
        baseline[1]!,
      ])
    ).toBe(1)
    expect(
      countAccountNetworkChangedKinds(baseline, [
        {
          ...baseline[0]!,
          publishEnabled: false,
          privateInboxEnabled: false,
        },
        { ...baseline[1]!, privateInboxEnabled: true },
      ])
    ).toBe(2)
  })

  it("preserves each unchanged signed order and keeps the signer count aligned", () => {
    const exact = reconciliation(null)
    exact.ownerRelayList.preferences = [
      {
        url: "wss://second.example",
        readEnabled: true,
        writeEnabled: true,
      },
      {
        url: "wss://first.example",
        readEnabled: true,
        writeEnabled: true,
      },
    ]
    exact.inboxDeclaration.relayUrls = [
      "wss://second.example",
      "wss://first.example",
    ]
    const baseline = [
      {
        url: "wss://second.example",
        readEnabled: true,
        publishEnabled: true,
        privateInboxEnabled: true,
      },
      {
        url: "wss://first.example",
        readEnabled: true,
        publishEnabled: true,
        privateInboxEnabled: true,
      },
    ]
    const automaticOrder = [...baseline].reverse()
    const inboxOnly = automaticOrder.map((entry) => ({
      ...entry,
      privateInboxEnabled: entry.url === "wss://first.example",
    }))
    const nip65Only = automaticOrder.map((entry) => ({
      ...entry,
      publishEnabled:
        entry.url === "wss://first.example" ? false : entry.publishEnabled,
    }))
    const both = nip65Only.map((entry) => ({
      ...entry,
      privateInboxEnabled: entry.url === "wss://first.example",
    }))

    const preparedInboxOnly = prepareAccountNetworkSetRolesAction(
      exact,
      inboxOnly
    )
    expect(
      preparedInboxOnly.action.nip65Preferences.map((entry) => entry.url)
    ).toEqual(["wss://second.example", "wss://first.example"])
    expect(preparedInboxOnly.action.inboxRelayUrls).toEqual([
      "wss://first.example",
    ])
    expect(preparedInboxOnly.changedKindCount).toBe(1)
    expect(countAccountNetworkChangedKinds(baseline, inboxOnly)).toBe(1)

    const preparedNip65Only = prepareAccountNetworkSetRolesAction(
      exact,
      nip65Only
    )
    expect(
      preparedNip65Only.action.nip65Preferences.map((entry) => entry.url)
    ).toEqual(["wss://first.example", "wss://second.example"])
    expect(preparedNip65Only.action.inboxRelayUrls).toEqual([
      "wss://second.example",
      "wss://first.example",
    ])
    expect(preparedNip65Only.changedKindCount).toBe(1)
    expect(countAccountNetworkChangedKinds(baseline, nip65Only)).toBe(1)

    const preparedBoth = prepareAccountNetworkSetRolesAction(exact, both)
    expect(preparedBoth.changedKindCount).toBe(2)
    expect(countAccountNetworkChangedKinds(baseline, both)).toBe(2)
  })
})
