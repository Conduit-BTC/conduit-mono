import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  ACCOUNT_NETWORK_LOCAL_STATE_MIGRATION_VERSION,
  ACCOUNT_NETWORK_LOCAL_STATE_UNMIGRATED_VERSION,
  ACCOUNT_NETWORK_LOCAL_STATE_VERSION,
  applyAccountNetworkRelayExclusion,
  applyAuthoritativeAccountNetworkReadds,
  createInMemoryAccountNetworkLocalStateRepository,
  emptyAccountNetworkLocalState,
  filterEligibleAccountRelayUrls,
  normalizeAccountNetworkLocalState,
  orderEquivalentAccountRelayOperations,
  replaceAccountNetworkPreferredRelayOrder,
  replaceAccountNetworkRelayScans,
  type AccountNetworkLocalState,
} from "@conduit/core/protocol/account-network-local-state"
import { deriveRelayScanResult } from "@conduit/core/protocol/relay-settings"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const OWNER_SECRET = generateSecretKey()
const OTHER_SECRET = generateSecretKey()
const OWNER = getPublicKey(OWNER_SECRET)
const OTHER = getPublicKey(OTHER_SECRET)

const RELAY_A = "wss://relay-a.net"
const RELAY_B = "wss://relay-b.net"
const RELAY_C = "wss://relay-c.net"
const RELAY_D = "wss://relay-d.net"

function signedEvent(input: {
  kind: 10002 | 10050
  createdAt: number
  tags: string[][]
  secret?: Uint8Array
}): SignedPublicNostrEvent {
  const event = finalizeEvent(
    {
      kind: input.kind,
      created_at: input.createdAt,
      tags: input.tags,
      content: "",
    },
    input.secret ?? OWNER_SECRET
  )
  return {
    ...event,
    tags: event.tags.map((tag) => [...tag]),
  }
}

function frontier(event: SignedPublicNostrEvent) {
  return { eventId: event.id, createdAt: event.created_at }
}

function excludeRelay(
  state: AccountNetworkLocalState,
  input: {
    relayUrl?: string
    relayList?: SignedPublicNostrEvent
    inboxDeclaration?: SignedPublicNostrEvent
    committedAt?: number
  } = {}
): AccountNetworkLocalState {
  return applyAccountNetworkRelayExclusion(state, {
    relayUrl: input.relayUrl ?? RELAY_A,
    relayListFrontier: input.relayList
      ? frontier(input.relayList)
      : { eventId: null, createdAt: null },
    inboxDeclarationFrontier: input.inboxDeclaration
      ? frontier(input.inboxDeclaration)
      : { eventId: null, createdAt: null },
    committedAt: input.committedAt ?? 100,
  })
}

describe("account network local state", () => {
  it("strictly normalizes account identity, versions, and causal references", () => {
    const empty = emptyAccountNetworkLocalState(OWNER.toUpperCase(), () => 10)
    expect(empty).toMatchObject({
      pubkey: OWNER,
      version: ACCOUNT_NETWORK_LOCAL_STATE_VERSION,
      migrationVersion: ACCOUNT_NETWORK_LOCAL_STATE_UNMIGRATED_VERSION,
      updatedAt: 10,
    })
    expect(ACCOUNT_NETWORK_LOCAL_STATE_MIGRATION_VERSION).toBe(1)

    expect(() =>
      applyAccountNetworkRelayExclusion(empty, {
        relayUrl: RELAY_A,
        relayListFrontier: { eventId: "a".repeat(64), createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
        committedAt: 11,
      })
    ).toThrow("must both be null or valid")
    expect(() =>
      normalizeAccountNetworkLocalState({
        ...empty,
        version: ACCOUNT_NETWORK_LOCAL_STATE_VERSION + 1,
      })
    ).toThrow("Unsupported account network state version")
    expect(
      normalizeAccountNetworkLocalState({
        ...empty,
        preferredRelayOrder: ["ws://owner-relay.example/"],
      }).preferredRelayOrder
    ).toEqual(["ws://owner-relay.example"])
  })

  it("keeps repository reads and writes isolated by normalized account", async () => {
    const repository = createInMemoryAccountNetworkLocalStateRepository()
    const ownerState = excludeRelay(
      emptyAccountNetworkLocalState(OWNER, () => 1),
      { committedAt: 2 }
    )

    await repository.replace(OWNER.toUpperCase(), ownerState)
    expect(await repository.get(OTHER)).toBeUndefined()
    expect((await repository.get(OWNER))?.exclusions).toHaveLength(1)

    const mutableCopy = await repository.get(OWNER)
    mutableCopy!.exclusions.length = 0
    expect((await repository.get(OWNER))?.exclusions).toHaveLength(1)

    await expect(
      repository.replace(OWNER, {
        ...ownerState,
        pubkey: OTHER,
      })
    ).rejects.toThrow("belongs to another account")

    await repository.update(OTHER, (current) =>
      replaceAccountNetworkPreferredRelayOrder(current, [RELAY_B], 3)
    )
    expect((await repository.get(OTHER))?.preferredRelayOrder).toEqual([
      RELAY_B,
    ])
    expect((await repository.get(OWNER))?.preferredRelayOrder).toEqual([])
  })

  it("re-reads local policy on every eligibility call and fails closed", async () => {
    let calls = 0
    let stored: AccountNetworkLocalState | undefined
    const repository = {
      async get() {
        calls += 1
        return stored ? structuredClone(stored) : undefined
      },
    }

    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        candidateRelayUrls: [RELAY_A, RELAY_B, RELAY_A],
        repository,
      })
    ).toEqual([RELAY_A, RELAY_B])

    stored = excludeRelay(
      emptyAccountNetworkLocalState(OWNER, () => 1),
      {
        committedAt: 2,
      }
    )
    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        candidateRelayUrls: [RELAY_A, RELAY_B],
        repository,
      })
    ).toEqual([RELAY_B])
    expect(calls).toBe(2)

    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        candidateRelayUrls: [RELAY_A],
        repository: {
          async get() {
            throw new Error("IndexedDB unavailable")
          },
        },
      })
    ).toEqual([])
    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: "invalid",
        candidateRelayUrls: [RELAY_A],
        repository,
      })
    ).toEqual([])
  })

  it("admits only the exact owner-selected ws subset at the final I/O seam", async () => {
    const ownerWs = "ws://owner-relay.example"
    const remoteWs = "ws://remote-hint.example"
    const repository = createInMemoryAccountNetworkLocalStateRepository()

    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        authenticatedPubkey: OWNER,
        candidateRelayUrls: [ownerWs, remoteWs, RELAY_B],
        ownerSelectedRelayUrls: [ownerWs],
        repository,
      })
    ).toEqual([ownerWs, RELAY_B])
    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        authenticatedPubkey: OTHER,
        candidateRelayUrls: [ownerWs, RELAY_B],
        ownerSelectedRelayUrls: [ownerWs],
        repository,
      })
    ).toEqual([RELAY_B])
    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        candidateRelayUrls: [ownerWs, remoteWs],
        repository,
      })
    ).toEqual([])

    await repository.update(OWNER, (state) =>
      excludeRelay(state, { relayUrl: ownerWs, committedAt: 200 })
    )
    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: OWNER,
        authenticatedPubkey: OWNER,
        candidateRelayUrls: [ownerWs],
        ownerSelectedRelayUrls: [ownerWs],
        repository,
      })
    ).toEqual([])
  })

  it("clears exclusions only for stronger valid own events that explicitly re-add", () => {
    const relayList = signedEvent({
      kind: 10002,
      createdAt: 100,
      tags: [["r", RELAY_A, "read"]],
    })
    const inboxDeclaration = signedEvent({
      kind: 10050,
      createdAt: 100,
      tags: [
        ["relay", RELAY_A],
        ["relay", RELAY_B],
      ],
    })
    const excluded = excludeRelay(
      emptyAccountNetworkLocalState(OWNER, () => 1),
      { relayList, inboxDeclaration, committedAt: 1_000 }
    )

    expect(
      applyAuthoritativeAccountNetworkReadds(excluded, {
        relayList,
        updatedAt: 1_001,
      }).exclusions
    ).toHaveLength(1)

    const newerOmission = signedEvent({
      kind: 10002,
      createdAt: 101,
      tags: [["r", RELAY_B]],
    })
    expect(
      applyAuthoritativeAccountNetworkReadds(excluded, {
        relayList: newerOmission,
        updatedAt: 1_002,
      }).exclusions
    ).toHaveLength(1)

    const otherAuthorReadd = signedEvent({
      kind: 10002,
      createdAt: 102,
      tags: [["r", RELAY_A]],
      secret: OTHER_SECRET,
    })
    expect(() =>
      applyAuthoritativeAccountNetworkReadds(excluded, {
        relayList: otherAuthorReadd,
        updatedAt: 1_003,
      })
    ).toThrow("author does not match")

    const newerRelayListReadd = signedEvent({
      kind: 10002,
      createdAt: 102,
      tags: [["r", RELAY_A, "write"]],
    })
    expect(
      applyAuthoritativeAccountNetworkReadds(excluded, {
        relayList: newerRelayListReadd,
        updatedAt: 1_004,
      }).exclusions
    ).toEqual([])

    const excludedInboxRelay = excludeRelay(excluded, {
      relayUrl: RELAY_B,
      relayList,
      inboxDeclaration,
      committedAt: 1_005,
    })
    const newerInboxReadd = signedEvent({
      kind: 10050,
      createdAt: 103,
      tags: [["relay", RELAY_B]],
    })
    expect(
      applyAuthoritativeAccountNetworkReadds(excludedInboxRelay, {
        inboxDeclaration: newerInboxReadd,
        updatedAt: 1_006,
      }).exclusions.map((entry) => entry.relayUrl)
    ).toEqual([RELAY_A])

    const nullFrontierExclusion = excludeRelay(
      emptyAccountNetworkLocalState(OWNER, () => 1),
      { relayUrl: RELAY_C, committedAt: 2 }
    )
    const firstRelayList = signedEvent({
      kind: 10002,
      createdAt: 1,
      tags: [["r", RELAY_C]],
    })
    expect(
      applyAuthoritativeAccountNetworkReadds(nullFrontierExclusion, {
        relayList: firstRelayList,
        updatedAt: 3,
      }).exclusions
    ).toEqual([])
  })

  it("persists signer-free order and the existing RelayScanResult vocabulary", async () => {
    const repository = createInMemoryAccountNetworkLocalStateRepository()
    const scan = deriveRelayScanResult(
      RELAY_A,
      { name: "Relay A", supported_nips: [42, 50, 59] },
      { now: () => 10 }
    )

    await repository.update(OWNER, (current) =>
      replaceAccountNetworkRelayScans(
        replaceAccountNetworkPreferredRelayOrder(
          current,
          [RELAY_B, RELAY_A],
          11
        ),
        [scan],
        12
      )
    )

    const saved = await repository.get(OWNER)
    expect(saved?.preferredRelayOrder).toEqual([RELAY_B, RELAY_A])
    expect(saved?.relayScans).toEqual([scan])
    expect(saved?.exclusions).toEqual([])
  })

  it("orders only within explicit equivalence slots", async () => {
    const state = replaceAccountNetworkPreferredRelayOrder(
      emptyAccountNetworkLocalState(OWNER, () => 1),
      [RELAY_C, RELAY_A],
      2
    )
    const repository = createInMemoryAccountNetworkLocalStateRepository([state])
    const operations = [
      { relayUrl: RELAY_A, equivalenceKey: "read", value: "read-a" },
      { relayUrl: RELAY_B, equivalenceKey: "write", value: "write-b" },
      { relayUrl: RELAY_C, equivalenceKey: "read", value: "read-c" },
      { relayUrl: RELAY_C, equivalenceKey: "write", value: "write-c" },
      { relayUrl: RELAY_B, equivalenceKey: "read", value: "read-b" },
    ]

    const ordered = await orderEquivalentAccountRelayOperations({
      accountPubkey: OWNER,
      operations,
      repository,
    })
    expect(ordered.map((operation) => operation.value)).toEqual([
      "read-c",
      "write-c",
      "read-a",
      "write-b",
      "read-b",
    ])
    expect(ordered.map((operation) => operation.equivalenceKey)).toEqual(
      operations.map((operation) => operation.equivalenceKey)
    )

    const noPreference = await orderEquivalentAccountRelayOperations({
      accountPubkey: OWNER,
      operations: [
        { relayUrl: RELAY_B, equivalenceKey: "read", value: "first" },
        { relayUrl: RELAY_D, equivalenceKey: "read", value: "second" },
      ],
      repository,
    })
    expect(noPreference.map((operation) => operation.value)).toEqual([
      "first",
      "second",
    ])
  })
})
