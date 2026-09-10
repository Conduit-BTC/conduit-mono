import { describe, expect, it } from "bun:test"
import {
  ACCOUNT_NETWORK_LAST_INBOX_REPLACEMENT_MESSAGE,
  ACCOUNT_NETWORK_SINGLE_PUBLISH_WARNING,
  buildAccountNetworkSettingsView,
  createCandidateNetworkRelayRow,
  orderAccountNetworkRelayRows,
  validateAccountNetworkDesiredRoles,
  type AccountNetworkRelayRowView,
} from "../packages/core/src/protocol/network-settings-view"
import type { AccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import type {
  AccountNetworkPreferencesReconciliation,
  NetworkPreferenceRow,
} from "../packages/core/src/protocol/network-preferences"
import type { RelayScanResult } from "../packages/core/src/protocol/relay-settings"

const PUBKEY = "a".repeat(64)

function localState(
  overrides: Partial<AccountNetworkLocalState> = {}
): AccountNetworkLocalState {
  return {
    pubkey: PUBKEY,
    version: 1,
    migrationVersion: 1,
    exclusions: [],
    preferredRelayOrder: [],
    relayScans: [],
    updatedAt: 1,
    ...overrides,
  }
}

function reconciliation(input?: {
  rows?: NetworkPreferenceRow[]
  owner?: Record<string, unknown>
  inbox?: Record<string, unknown>
  legacyInboxRecoveryRelayUrls?: string[]
}): AccountNetworkPreferencesReconciliation {
  return {
    projection: {
      pubkey: PUBKEY,
      relayScope: `account:${PUBKEY}`,
      rows: input?.rows ?? [
        {
          url: "wss://first.example",
          position: 0,
          read: "published",
          write: "published",
          privateInbox: "published",
        },
        {
          url: "wss://second.example",
          position: 1,
          read: "published",
          write: null,
          privateInbox: null,
        },
      ],
      relayListState: "declared",
      relayListStale: false,
      inboxState: "declared",
      inboxStale: false,
      runtimeRelaySettings: { version: 1, entries: [], updatedAt: 1 },
    },
    ownerRelayList: {
      pubkey: PUBKEY,
      state: "declared",
      preferences: [],
      stale: false,
      current: {
        signedEvent: { created_at: 10 },
        sourceRelayUrls: ["wss://source.example"],
        observedAt: 20_000,
      },
      lookup: {
        coverage: "complete",
        observedAt: 20_000,
        hadEvent: true,
      },
      observation: {
        coverage: "complete",
        attemptedRelayUrls: [],
        successfulRelayUrls: [],
        failedRelayUrls: [],
        cappedRelayUrls: [],
        eventSourceRelayUrls: [],
      },
      ...input?.owner,
    },
    inboxDeclaration: {
      pubkey: PUBKEY,
      state: "declared",
      relayUrls: ["wss://first.example"],
      stale: false,
      fetchedAt: 30_000,
      eventId: "inbox-event",
      eventCreatedAt: 30,
      sourceRelayUrls: ["wss://source.example"],
      observation: {
        coverage: "complete",
        attemptedRelayUrls: [],
        successfulRelayUrls: [],
        failedRelayUrls: [],
        eventId: "inbox-event",
        eventSourceRelayUrls: [],
      },
      ...input?.inbox,
    },
    legacyMigration: "not_applicable",
    legacyReviewCandidate: null,
    legacyInboxRecoveryRelayUrls: input?.legacyInboxRecoveryRelayUrls ?? [],
  } as unknown as AccountNetworkPreferencesReconciliation
}

function scan(
  url: string,
  options: {
    reachable?: boolean
    observedCommerce?: boolean
    advertisedAuth?: boolean
  } = {}
): RelayScanResult {
  const observed = options.observedCommerce ?? false
  const advertisedAuth = options.advertisedAuth ?? false
  const observation = (name: "auth" | "protected" | "other") => ({
    supported: observed || (name === "auth" && advertisedAuth),
    status: observed
      ? ("observed" as const)
      : name === "auth" && advertisedAuth
        ? ("advertised" as const)
        : ("unknown" as const),
    confidence: observed
      ? ("observed" as const)
      : name === "auth" && advertisedAuth
        ? ("advertised" as const)
        : ("none" as const),
    evidence: observed
      ? (["active-probe"] as const)
      : name === "auth" && advertisedAuth
        ? (["nip11"] as const)
        : ([] as const),
  })
  return {
    url,
    reachable: options.reachable ?? true,
    relayName: "Example relay",
    capabilities: {
      nip11: true,
      search: false,
      dm: observed,
      auth: observed || advertisedAuth,
      commerce: observed,
      protectedMessages: observed,
      listings: observed,
      cleanup: observed,
    },
    warnings: {
      dmWithoutAuth: false,
      staleRelayInfo: false,
      unreachable: !(options.reachable ?? true),
      commercePartialSupport: false,
    },
    observations: {
      search: observation("other"),
      auth: observation("auth"),
      protectedMessages: observation("protected"),
      listings: observation("other"),
      cleanup: observation("other"),
    },
    scannedAt: 40_000,
  }
}

function exclusion(relayUrl: string) {
  return {
    relayUrl,
    committedAt: 2,
    relayListFrontier: { eventId: null, createdAt: null },
    inboxDeclarationFrontier: { eventId: null, createdAt: null },
  }
}

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

describe("network settings view", () => {
  it("preserves an owner-selected ws relay and all of its signed roles", () => {
    const view = buildAccountNetworkSettingsView({
      reconciliation: reconciliation({
        rows: [
          {
            url: "ws://OWNER-SELECTED.EXAMPLE/",
            position: 0,
            read: "published",
            write: "pending",
            privateInbox: "published",
          },
        ],
        inbox: {
          relayUrls: ["ws://owner-selected.example"],
        },
      }),
      localState: localState(),
    })

    expect(view.rows).toEqual([
      expect.objectContaining({
        url: "ws://owner-selected.example",
        readEnabled: true,
        publishEnabled: true,
        privateInboxEnabled: true,
        readState: "published",
        publishState: "pending",
        privateInboxState: "published",
        signedPosition: 0,
        candidate: false,
      }),
    ])
  })

  it("projects one row per relay with independent roles and omits whole-relay exclusions", () => {
    const duplicateRows = [
      ...reconciliation().projection.rows,
      {
        ...reconciliation().projection.rows[0]!,
        position: 2,
      },
    ]
    const view = buildAccountNetworkSettingsView({
      reconciliation: reconciliation({ rows: duplicateRows }),
      localState: localState({
        exclusions: [exclusion("wss://second.example")],
      }),
    })

    expect(view.rows).toHaveLength(1)
    expect(view.rows[0]).toMatchObject({
      url: "wss://first.example",
      readEnabled: true,
      publishEnabled: true,
      privateInboxEnabled: true,
      readState: "published",
      publishState: "published",
      privateInboxState: "published",
    })
    expect(view.rows.some((row) => row.url === "wss://second.example")).toBe(
      false
    )
  })

  it("keeps configured Conduit uses separate from observed capability", () => {
    const configuredUrl = "wss://relay.conduit.market"
    const observedUrl = "wss://observed.example"
    const rows = [configuredUrl, observedUrl].map((url, position) => ({
      url,
      position,
      read: "published" as const,
      write: "published" as const,
      privateInbox: null,
    }))
    const view = buildAccountNetworkSettingsView({
      reconciliation: reconciliation({ rows }),
      localState: localState({
        relayScans: [
          scan(configuredUrl),
          scan(observedUrl, { observedCommerce: true }),
        ],
      }),
    })

    const configured = view.rows.find((row) => row.url === configuredUrl)
    const observed = view.rows.find((row) => row.url === observedUrl)
    expect(configured?.capability).toMatchObject({
      observedCommerce: false,
      nip11: "available",
    })
    expect(configured?.capability.configuredUses).toContain("app_publishing")
    expect(observed?.capability).toMatchObject({
      configuredUses: [],
      observedCommerce: true,
    })
  })

  it("presents stale signed frontiers as retained without relabeling refresh time", () => {
    const view = buildAccountNetworkSettingsView({
      reconciliation: reconciliation({
        owner: {
          stale: true,
          lookup: { coverage: "partial", observedAt: 99_000, hadEvent: false },
        },
        inbox: {
          stale: true,
          fetchedAt: 99_000,
          observation: {
            coverage: "partial",
            attemptedRelayUrls: [],
            successfulRelayUrls: [],
            failedRelayUrls: [],
            eventSourceRelayUrls: [],
          },
        },
      }),
      localState: localState(),
    })

    expect(view.relayList).toMatchObject({
      stale: true,
      retained: true,
      coverage: "partial",
      observedAt: 20_000,
    })
    expect(view.inbox).toMatchObject({
      stale: true,
      retained: true,
      coverage: "partial",
      observedAt: null,
    })
  })

  it("summarizes both exact pending deliveries and excludes removed targets", () => {
    const view = buildAccountNetworkSettingsView({
      reconciliation: reconciliation({
        owner: {
          pendingDistribution: {
            signedEvent: { id: "owner-event" },
            publishRelayUrls: [
              "wss://first.example",
              "wss://second.example",
              "wss://removed.example",
            ],
            relayOutcomes: [
              {
                relayUrl: "wss://first.example",
                publishStatus: "acked",
                publishAttemptCount: 1,
                readbackStatus: "observed",
                readbackAttemptCount: 1,
              },
              {
                relayUrl: "wss://second.example",
                publishStatus: "acked",
                publishAttemptCount: 1,
                readbackStatus: "pending",
                readbackAttemptCount: 0,
              },
              {
                relayUrl: "wss://removed.example",
                publishStatus: "pending",
                publishAttemptCount: 0,
                readbackStatus: "pending",
                readbackAttemptCount: 0,
              },
            ],
            stagedAt: 1,
          },
        },
        inbox: {
          state: "distribution_pending",
          relayUrls: [],
          pendingRelayUrls: ["wss://first.example", "wss://second.example"],
          pendingPublishRelayUrls: [
            "wss://first.example",
            "wss://second.example",
            "wss://removed.example",
          ],
          sourceRelayUrls: ["wss://first.example"],
          pendingRelayOutcomes: [
            {
              relayUrl: "wss://first.example",
              publishStatus: "acked",
              publishAttemptCount: 1,
              readbackStatus: "observed",
              readbackAttemptCount: 1,
            },
            {
              relayUrl: "wss://second.example",
              publishStatus: "acked",
              publishAttemptCount: 1,
              readbackStatus: "pending",
              readbackAttemptCount: 0,
            },
            {
              relayUrl: "wss://removed.example",
              publishStatus: "pending",
              publishAttemptCount: 0,
              readbackStatus: "pending",
              readbackAttemptCount: 0,
            },
          ],
        },
      }),
      localState: localState({
        exclusions: [exclusion("wss://removed.example")],
      }),
    })

    expect(view.pendingExactDeliveries).toEqual([
      {
        kind: 10002,
        label: "Read and Publish",
        eventId: "owner-event",
        confirmationState: "readback_pending",
        eligibleTargetCount: 2,
        exactReadbackCount: 1,
        unresolvedCount: 1,
        excludedTargetCount: 1,
        retryAvailable: true,
      },
      {
        kind: 10050,
        label: "Private inbox",
        eventId: "inbox-event",
        confirmationState: "readback_pending",
        eligibleTargetCount: 2,
        exactReadbackCount: 1,
        unresolvedCount: 1,
        excludedTargetCount: 1,
        retryAvailable: true,
      },
    ])
  })

  it("does not call an all-policy-blocked pending event exactly confirmed", () => {
    const view = buildAccountNetworkSettingsView({
      reconciliation: reconciliation({
        owner: {
          pendingDistribution: {
            signedEvent: { id: "owner-event" },
            publishRelayUrls: ["wss://removed.example"],
            relayOutcomes: [
              {
                relayUrl: "wss://removed.example",
                publishStatus: "acked",
                publishAttemptCount: 1,
                readbackStatus: "pending",
                readbackAttemptCount: 0,
              },
            ],
            stagedAt: 1,
          },
        },
        inbox: {
          state: "distribution_pending",
          relayUrls: [],
          pendingRelayUrls: ["wss://removed.example"],
          pendingPublishRelayUrls: ["wss://removed.example"],
          pendingRelayOutcomes: [
            {
              relayUrl: "wss://removed.example",
              publishStatus: "acked",
              publishAttemptCount: 1,
              readbackStatus: "pending",
              readbackAttemptCount: 0,
            },
          ],
        },
      }),
      localState: localState({
        exclusions: [exclusion("wss://removed.example")],
      }),
    })

    expect(view.pendingExactDeliveries).toEqual([
      expect.objectContaining({
        kind: 10002,
        confirmationState: "policy_blocked",
        eligibleTargetCount: 0,
        exactReadbackCount: 0,
        unresolvedCount: 0,
        excludedTargetCount: 1,
        retryAvailable: false,
      }),
      expect.objectContaining({
        kind: 10050,
        confirmationState: "policy_blocked",
        eligibleTargetCount: 0,
        exactReadbackCount: 0,
        unresolvedCount: 0,
        excludedTargetCount: 1,
        retryAvailable: false,
      }),
    ])
  })

  it("applies preferred order only inside the same eligibility and capability group", () => {
    const configured = row("wss://configured.example", {
      capability: {
        configuredUses: ["product_discovery"],
        observedCommerce: false,
        nip11: "not_checked",
        searchAdvertised: false,
        authEvidence: "untested",
      },
    })
    const observed = row("wss://observed.example", {
      capability: {
        configuredUses: [],
        observedCommerce: true,
        nip11: "available",
        searchAdvertised: false,
        authEvidence: "succeeded",
      },
    })
    const draftCandidate = row("wss://candidate.example", {
      readState: "draft",
      publishState: "draft",
      signedPosition: null,
      candidate: true,
      capability: {
        configuredUses: ["product_discovery"],
        observedCommerce: true,
        nip11: "available",
        searchAdvertised: false,
        authEvidence: "succeeded",
      },
    })
    const responded = row("wss://responded.example", {
      signedPosition: 2,
      reachability: "responded",
    })
    const unchecked = row("wss://unchecked.example", { signedPosition: 1 })
    const otherUnchecked = row("wss://other.example", { signedPosition: 0 })
    const ordered = orderAccountNetworkRelayRows(
      [
        draftCandidate,
        unchecked,
        observed,
        configured,
        otherUnchecked,
        responded,
      ],
      [
        draftCandidate.url,
        observed.url,
        unchecked.url,
        responded.url,
        otherUnchecked.url,
        configured.url,
      ]
    )

    expect(ordered.map((entry) => entry.url)).toEqual([
      configured.url,
      observed.url,
      responded.url,
      unchecked.url,
      otherUnchecked.url,
      draftCandidate.url,
    ])
  })

  it("creates a signer-free candidate from local scan evidence but never revives an exclusion", () => {
    const candidate = createCandidateNetworkRelayRow({
      url: "WSS://CANDIDATE.EXAMPLE/",
      localState: localState(),
      scan: scan("wss://candidate.example", { advertisedAuth: true }),
      authEvidence: "succeeded",
    })

    expect(candidate).toMatchObject({
      url: "wss://candidate.example",
      candidate: true,
      readEnabled: false,
      publishEnabled: false,
      privateInboxEnabled: false,
      capability: {
        nip11: "available",
        authEvidence: "succeeded",
      },
    })
    expect(
      createCandidateNetworkRelayRow({
        url: "WS://OWNER-SELECTED.EXAMPLE:7447/",
        localState: localState(),
      })
    ).toMatchObject({
      url: "ws://owner-selected.example:7447",
      candidate: true,
    })
    expect(() =>
      createCandidateNetworkRelayRow({
        url: "ftp://not-a-relay.example",
        localState: localState(),
      })
    ).toThrow("ws:// or wss://")
    expect(() =>
      createCandidateNetworkRelayRow({
        url: "not a relay host",
        localState: localState(),
      })
    ).toThrow()
    expect(() =>
      createCandidateNetworkRelayRow({
        url: "wss://removed.example",
        localState: localState({
          exclusions: [exclusion("wss://removed.example")],
        }),
      })
    ).toThrow("removed from the whole setup")
  })

  it("requires Publish, warns for one, and requires an inbox replacement only when removing the last usable one", () => {
    const context = {
      reconciliation: reconciliation(),
      localState: localState(),
    }
    const noPublish = validateAccountNetworkDesiredRoles(
      [
        {
          url: "wss://first.example",
          readEnabled: true,
          publishEnabled: false,
          privateInboxEnabled: false,
        },
      ],
      context
    )
    expect(noPublish.errors).toEqual([
      "Enable Publish on at least one relay.",
      ACCOUNT_NETWORK_LAST_INBOX_REPLACEMENT_MESSAGE,
    ])

    const onePublish = validateAccountNetworkDesiredRoles(
      [
        {
          url: "wss://replacement.example",
          readEnabled: false,
          publishEnabled: true,
          privateInboxEnabled: true,
        },
      ],
      context
    )
    expect(onePublish).toEqual({
      valid: true,
      errors: [],
      warnings: [ACCOUNT_NETWORK_SINGLE_PUBLISH_WARNING],
    })

    const ownerSelectedWs = validateAccountNetworkDesiredRoles(
      [
        {
          url: "ws://owner-selected.example",
          readEnabled: true,
          publishEnabled: true,
          privateInboxEnabled: true,
        },
      ],
      context
    )
    expect(ownerSelectedWs).toEqual({
      valid: true,
      errors: [],
      warnings: [ACCOUNT_NETWORK_SINGLE_PUBLISH_WARNING],
    })

    const nonWebSocketScheme = validateAccountNetworkDesiredRoles(
      [
        {
          url: "ftp://not-a-relay.example",
          readEnabled: true,
          publishEnabled: true,
          privateInboxEnabled: true,
        },
      ],
      context
    )
    expect(nonWebSocketScheme).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "Every selected role must use a valid relay URL.",
      ]),
    })

    const declaredInboxToggledOff = validateAccountNetworkDesiredRoles(
      [
        {
          url: "wss://first.example",
          readEnabled: true,
          publishEnabled: true,
          privateInboxEnabled: false,
        },
      ],
      {
        reconciliation: reconciliation({
          inbox: {
            cutoverRecoveryRelayUrls: ["wss://first.example"],
          },
        }),
        localState: localState(),
      }
    )
    expect(declaredInboxToggledOff.errors).toContain(
      ACCOUNT_NETWORK_LAST_INBOX_REPLACEMENT_MESSAGE
    )

    const alreadyWithoutInbox = validateAccountNetworkDesiredRoles(
      [
        {
          url: "wss://only.example",
          readEnabled: false,
          publishEnabled: true,
          privateInboxEnabled: false,
        },
      ],
      {
        reconciliation: reconciliation({
          inbox: { state: "signed_empty", relayUrls: [], eventId: "empty" },
        }),
        localState: localState(),
      }
    )
    expect(alreadyWithoutInbox.valid).toBe(true)

    const recoveryPreservedDuringRoleChange =
      validateAccountNetworkDesiredRoles(
        [
          {
            url: "wss://only.example",
            readEnabled: false,
            publishEnabled: true,
            privateInboxEnabled: false,
          },
          {
            url: "wss://legacy-inbox.example",
            readEnabled: false,
            publishEnabled: false,
            privateInboxEnabled: false,
          },
        ],
        {
          reconciliation: reconciliation({
            inbox: {
              state: "not_observed",
              relayUrls: [],
              eventId: undefined,
            },
            legacyInboxRecoveryRelayUrls: ["wss://legacy-inbox.example"],
          }),
          localState: localState(),
        }
      )
    expect(recoveryPreservedDuringRoleChange).toEqual({
      valid: true,
      errors: [],
      warnings: [ACCOUNT_NETWORK_SINGLE_PUBLISH_WARNING],
    })

    const legacyRecoveryWholeRemoval = validateAccountNetworkDesiredRoles(
      [
        {
          url: "wss://only.example",
          readEnabled: false,
          publishEnabled: true,
          privateInboxEnabled: false,
        },
      ],
      {
        reconciliation: reconciliation({
          inbox: { state: "not_observed", relayUrls: [], eventId: undefined },
          legacyInboxRecoveryRelayUrls: ["wss://legacy-inbox.example"],
        }),
        localState: localState(),
      }
    )
    expect(legacyRecoveryWholeRemoval.errors).toContain(
      ACCOUNT_NETWORK_LAST_INBOX_REPLACEMENT_MESSAGE
    )
  })

  it("keeps a recovery union usable only while at least one recovery row remains", () => {
    const reconciliationWithRecovery = reconciliation({
      inbox: {
        state: "signed_empty",
        relayUrls: [],
        eventId: "empty",
        cutoverRecoveryRelayUrls: [
          "wss://first-recovery.example",
          "wss://second-recovery.example",
        ],
      },
    })
    const publishRelay = {
      url: "wss://only.example",
      readEnabled: true,
      publishEnabled: true,
      privateInboxEnabled: false,
    }
    const remainingRecovery = {
      url: "wss://second-recovery.example",
      readEnabled: false,
      publishEnabled: false,
      privateInboxEnabled: false,
    }

    expect(
      validateAccountNetworkDesiredRoles([publishRelay, remainingRecovery], {
        reconciliation: reconciliationWithRecovery,
        localState: localState(),
      }).valid
    ).toBe(true)
    expect(
      validateAccountNetworkDesiredRoles([publishRelay], {
        reconciliation: reconciliationWithRecovery,
        localState: localState(),
      }).errors
    ).toContain(ACCOUNT_NETWORK_LAST_INBOX_REPLACEMENT_MESSAGE)
  })

  it("rejects cross-account local evidence", () => {
    expect(() =>
      buildAccountNetworkSettingsView({
        reconciliation: reconciliation(),
        localState: localState({ pubkey: "b".repeat(64) }),
      })
    ).toThrow("cannot cross accounts")
  })
})
