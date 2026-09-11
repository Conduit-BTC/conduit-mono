import { describe, expect, it } from "bun:test"
import {
  createAccountRelaySettingsPresentation,
  reviewRelaySettingsAccountMutation,
  shouldRetryRelaySettingsAccountMutation,
} from "@conduit/core/hooks/useRelaySettings"
import {
  planInboxDeclarationAccountMutation,
  reviewInboxDeclarationAccountMutation,
} from "@conduit/core/hooks/useInboxDeclaration"
import { EVENT_KINDS } from "@conduit/core/protocol/kinds"
import type { AccountNetworkPreferencesReconciliation } from "@conduit/core/protocol/network-preferences"
import type {
  RelaySettingsEntry,
  RelaySettingsState,
} from "@conduit/core/protocol/relay-settings"

const ACCOUNT = "a".repeat(64)
const RELAY_A = "wss://relay.damus.io"
const RELAY_B = "wss://nos.lol"
const INBOX_A = "wss://relay.primal.net"
const INBOX_B = "wss://relay.ditto.pub"

function relayEntry(
  url: string,
  readEnabled: boolean,
  writeEnabled: boolean
): RelaySettingsEntry {
  return {
    url,
    readEnabled,
    writeEnabled,
    section: "public",
    capabilities: {
      nip11: true,
      search: false,
      dm: false,
      auth: false,
      commerce: false,
      protectedMessages: false,
      listings: false,
      cleanup: false,
    },
    warnings: {
      dmWithoutAuth: false,
      staleRelayInfo: false,
      unreachable: false,
      commercePartialSupport: false,
    },
    source: "manual",
  }
}

function relaySettings(
  entries: Array<[url: string, read: boolean, publish: boolean]>
): RelaySettingsState {
  return {
    version: 1,
    entries: entries.map(([url, read, publish]) =>
      relayEntry(url, read, publish)
    ),
    updatedAt: 1,
  }
}

function reconciliation(
  input: {
    inboxState?: "declared" | "distribution_pending" | "not_observed"
    inboxRelayUrls?: string[]
    recoveryRelayUrls?: string[]
    pendingRelayList?: boolean
  } = {}
): AccountNetworkPreferencesReconciliation {
  const inboxState = input.inboxState ?? "declared"
  const inboxRelayUrls = input.inboxRelayUrls ?? [INBOX_A]
  const inboxEventId = "2".repeat(64)
  return {
    projection: {
      pubkey: ACCOUNT,
      relayScope: `account:${ACCOUNT}`,
      rows: [
        {
          url: RELAY_A,
          position: 1,
          read: "published",
          write: "published",
          privateInbox: null,
          draftRead: false,
          draftWrite: false,
        },
        {
          url: RELAY_B,
          position: 0,
          read: "published",
          write: "published",
          privateInbox: null,
          draftRead: false,
          draftWrite: false,
        },
      ],
      relayListState: "declared",
      relayListStale: false,
      inboxState,
      inboxStale: false,
    },
    ownerRelayList: {
      pubkey: ACCOUNT,
      state: "declared",
      preferences: [
        { url: RELAY_A, readEnabled: true, writeEnabled: true },
        { url: RELAY_B, readEnabled: true, writeEnabled: true },
      ],
      stale: false,
      ...(input.pendingRelayList
        ? { pendingDistribution: { signedEvent: { id: "1".repeat(64) } } }
        : {}),
      lookup: {
        observedAt: 1,
        coverage: "complete",
        hadEvent: true,
        eventId: "1".repeat(64),
      },
      observation: {
        coverage: "complete",
        attemptedRelayUrls: [],
        successfulRelayUrls: [],
        failedRelayUrls: [],
        cappedRelayUrls: [],
        eventSourceRelayUrls: [],
      },
    },
    inboxDeclaration: {
      pubkey: ACCOUNT,
      state: inboxState,
      relayUrls: inboxState === "declared" ? inboxRelayUrls : [],
      ...(inboxState === "distribution_pending"
        ? {
            pendingRelayUrls: inboxRelayUrls,
            pendingPublishRelayUrls: [RELAY_A],
          }
        : {}),
      ...(input.recoveryRelayUrls
        ? { retainedReadRelayUrls: input.recoveryRelayUrls }
        : {}),
      stale: false,
      fetchedAt: 1,
      ...(inboxState === "not_observed"
        ? {}
        : { eventId: inboxEventId, eventCreatedAt: 2 }),
      observation: {
        coverage: "complete",
        attemptedRelayUrls: [],
        successfulRelayUrls: [],
        failedRelayUrls: [],
        eventSourceRelayUrls: [],
      },
    },
    legacyMigration: "already_complete",
    legacyReviewCandidate: null,
    legacyInboxRecoveryRelayUrls: [],
    localExcludedRelayUrls: [],
  } as unknown as AccountNetworkPreferencesReconciliation
}

describe("account Network compatibility hook adapters", () => {
  it("derives the legacy relay presentation from reconciliation rows", () => {
    const presentation =
      createAccountRelaySettingsPresentation(reconciliation())

    expect(presentation.entries.map((entry) => entry.url)).toEqual([
      RELAY_B,
      RELAY_A,
    ])
    expect(
      presentation.entries.every(
        (entry) =>
          entry.source === "published" &&
          entry.readEnabled &&
          entry.writeEnabled
      )
    ).toBe(true)
  })

  it("reviews a relay-list edit as one signature and preserves kind:10050", () => {
    const reviewed = reviewRelaySettingsAccountMutation(
      reconciliation(),
      relaySettings([
        [RELAY_A, false, true],
        [RELAY_B, true, true],
      ])
    )

    expect(reviewed.changedKinds).toEqual([EVENT_KINDS.RELAY_LIST])
    expect(reviewed.signerRequestCount).toBe(1)
    expect(
      reviewed.action.relays.find((relay) => relay.url === INBOX_A)
    ).toEqual({
      url: INBOX_A,
      read: false,
      publish: false,
      privateInbox: true,
    })
  })

  it("reviews an inbox edit as one signature and preserves NIP-65 roles", () => {
    const reviewed = reviewInboxDeclarationAccountMutation(reconciliation(), [
      INBOX_B,
    ])

    expect(reviewed.changedKinds).toEqual([EVENT_KINDS.PRIVATE_MESSAGE_RELAYS])
    expect(reviewed.signerRequestCount).toBe(1)
    expect(
      reviewed.action.relays.filter((relay) => relay.read || relay.publish)
    ).toEqual([
      { url: RELAY_B, read: true, publish: true, privateInbox: false },
      { url: RELAY_A, read: true, publish: true, privateInbox: false },
    ])
  })

  it("allows a Read/Publish-only edit with no active inbox", () => {
    const reviewed = reviewRelaySettingsAccountMutation(
      reconciliation({ inboxState: "not_observed", inboxRelayUrls: [] }),
      relaySettings([
        [RELAY_A, true, true],
        [RELAY_B, false, true],
      ])
    )

    expect(reviewed.changedKinds).toEqual([EVENT_KINDS.RELAY_LIST])
    expect(reviewed.signerRequestCount).toBe(1)
    expect(reviewed.action.relays.some((relay) => relay.privateInbox)).toBe(
      false
    )
  })

  it("leaves recovery-only inbox evidence untouched by a relay-list edit", () => {
    const reviewed = reviewRelaySettingsAccountMutation(
      reconciliation({
        inboxState: "not_observed",
        inboxRelayUrls: [],
        recoveryRelayUrls: [INBOX_A],
      }),
      relaySettings([
        [RELAY_A, true, true],
        [RELAY_B, false, true],
      ])
    )

    expect(reviewed.changedKinds).toEqual([EVENT_KINDS.RELAY_LIST])
    expect(reviewed.action.removedRelayUrls).toEqual([])
  })

  it("uses exact retry only for an unchanged pending relay list", () => {
    const current = reconciliation({ pendingRelayList: true })
    const unchanged = reviewRelaySettingsAccountMutation(
      current,
      relaySettings([
        [RELAY_A, true, true],
        [RELAY_B, true, true],
      ])
    )
    const changed = reviewRelaySettingsAccountMutation(
      current,
      relaySettings([
        [RELAY_A, false, true],
        [RELAY_B, true, true],
      ])
    )

    expect(shouldRetryRelaySettingsAccountMutation(current, unchanged)).toBe(
      true
    )
    expect(shouldRetryRelaySettingsAccountMutation(current, changed)).toBe(
      false
    )
  })

  it("selects exact inbox retry, exact redistribution, or reviewed publish", () => {
    const pending = reconciliation({ inboxState: "distribution_pending" })
    expect(
      planInboxDeclarationAccountMutation({
        reconciliation: pending,
        readiness: {
          state: "distribution_pending",
          eventId: "2".repeat(64),
          relayUrls: [INBOX_A],
          retainedRelayUrls: [],
          stale: true,
          distributionRepairable: true,
        },
        relayUrls: [INBOX_A],
      })
    ).toEqual({ type: "retry" })

    const declared = reconciliation()
    expect(
      planInboxDeclarationAccountMutation({
        reconciliation: declared,
        readiness: {
          state: "ready",
          eventId: "2".repeat(64),
          relayUrls: [INBOX_A],
          stale: true,
          distributionRepairable: true,
        },
        relayUrls: [INBOX_A],
      })
    ).toEqual({ type: "redistribute" })

    const replacement = planInboxDeclarationAccountMutation({
      reconciliation: declared,
      readiness: {
        state: "ready",
        eventId: "2".repeat(64),
        relayUrls: [INBOX_A],
        stale: false,
        distributionRepairable: false,
      },
      relayUrls: [INBOX_B],
    })
    expect(replacement.type).toBe("publish")
    expect(
      replacement.type === "publish"
        ? replacement.reviewed.signerRequestCount
        : null
    ).toBe(1)
  })
})
