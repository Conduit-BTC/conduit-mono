import { admitFixture } from "./helpers/public-event"
import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  ACCOUNT_NETWORK_LOCAL_STATE_VERSION,
  applyAccountNetworkRelayExclusion,
  applyAuthoritativeAccountNetworkReadds,
  createInMemoryAccountNetworkLocalStateRepository,
  emptyAccountNetworkLocalState,
  filterEligibleAccountRelayTargets,
  normalizeAccountNetworkLocalState,
  orderEquivalentAccountRelayOperations,
  replaceAccountNetworkPreferredRelayOrder,
  replaceAccountNetworkRelayScans,
  replaceAccountNetworkRoutingPolicy,
  type AccountNetworkLocalState,
} from "@conduit/core/protocol/account-network-local-state"
import {
  reconcileAccountNetworkRoutingPolicy,
  setAccountNetworkRoutingSourceEnabled,
} from "@conduit/core/protocol/account-network-routing-policy"
import { deriveRelayScanResult } from "@conduit/core/protocol/relay-settings"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import { createInMemoryOwnerRelayListEvidenceRepository } from "@conduit/core/protocol/owner-relay-list-evidence"
import {
  mergeRelayTargets,
  relayTargetsFromUrls,
} from "@conduit/core/protocol/relay-authority"
import { config } from "@conduit/core/config"

const OWNER_SECRET = generateSecretKey()
const OTHER_SECRET = generateSecretKey()
const OWNER = getPublicKey(OWNER_SECRET)
const OTHER = getPublicKey(OTHER_SECRET)

const RELAY_A = "wss://relay-a.net"
const RELAY_B = "wss://relay-b.net"
const RELAY_C = "wss://relay-c.net"
const RELAY_D = "wss://relay-d.net"

async function signedEvent(input: {
  kind: 10002 | 10050
  createdAt: number
  tags: string[][]
  secret?: Uint8Array
}): Promise<SignedPublicNostrEvent> {
  const event = finalizeEvent(
    {
      kind: input.kind,
      created_at: input.createdAt,
      tags: input.tags,
      content: "",
    },
    input.secret ?? OWNER_SECRET
  )
  return await admitFixture({
    ...event,
    tags: event.tags.map((tag) => [...tag]),
  })
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
  it("reads existing local policy without retaining obsolete migration metadata", async () => {
    const policy = excludeRelay(emptyAccountNetworkLocalState(OWNER, () => 10))
    const historical = { ...policy, migrationVersion: 1 }
    expect(normalizeAccountNetworkLocalState(historical, OWNER)).toEqual(policy)
    expect(
      normalizeAccountNetworkLocalState(historical, OWNER)
    ).not.toHaveProperty("migrationVersion")
  })

  it("strictly normalizes account identity, versions, and causal references", async () => {
    const empty = emptyAccountNetworkLocalState(OWNER.toUpperCase(), () => 10)
    expect(empty).toMatchObject({
      pubkey: OWNER,
      version: ACCOUNT_NETWORK_LOCAL_STATE_VERSION,
      routingPolicy: {
        policyVersion: 1,
        appRelaysEnabled: true,
        personalRelaysEnabled: true,
        appRelaysTouched: false,
        personalRelaysTouched: false,
        setupPromptState: "untouched",
      },
      updatedAt: 10,
    })

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

  it("migrates legacy local records without disabling prior personal routing", async () => {
    const migrated = normalizeAccountNetworkLocalState({
      pubkey: OWNER,
      version: 1,
      exclusions: [],
      preferredRelayOrder: [],
      relayScans: [],
      updatedAt: 9,
    })

    expect(migrated).toMatchObject({
      version: ACCOUNT_NETWORK_LOCAL_STATE_VERSION,
      routingPolicy: {
        appRelaysEnabled: true,
        personalRelaysEnabled: true,
        appRelaysTouched: false,
        personalRelaysTouched: false,
        setupPromptState: "untouched",
      },
    })
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

  it("atomically replaces and updates routing policy inside the account fence", async () => {
    const repository = createInMemoryAccountNetworkLocalStateRepository(
      [],
      () => 10
    )

    const replaced = await repository.replaceRoutingPolicy(
      OWNER.toUpperCase(),
      setAccountNetworkRoutingSourceEnabled(
        emptyAccountNetworkLocalState(OWNER, () => 1).routingPolicy,
        "app",
        false
      ),
      11
    )
    expect(replaced.routingPolicy).toMatchObject({
      appRelaysEnabled: false,
      appRelaysTouched: true,
      personalRelaysEnabled: true,
    })

    const updated = await repository.updateRoutingPolicy(
      OWNER,
      (policy) =>
        setAccountNetworkRoutingSourceEnabled(policy, "personal", true),
      12
    )
    expect(updated.routingPolicy).toMatchObject({
      appRelaysEnabled: false,
      personalRelaysEnabled: true,
      personalRelaysTouched: true,
    })
    expect(updated.updatedAt).toBe(12)
    expect(await repository.get(OTHER)).toBeUndefined()

    expect(
      replaceAccountNetworkRoutingPolicy(updated, updated.routingPolicy, 99)
        .updatedAt
    ).toBe(12)
    await expect(
      repository.updateRoutingPolicy("invalid", (policy) => policy)
    ).rejects.toThrow("requires a valid hex pubkey")
  })

  it("re-reads local policy on every target admission and fails closed", async () => {
    let calls = 0
    let stored: AccountNetworkLocalState | undefined
    const repository = {
      async get() {
        calls += 1
        return stored ? structuredClone(stored) : undefined
      },
    }
    const targets = relayTargetsFromUrls([RELAY_A, RELAY_B, RELAY_A], {
      kind: "public_hint",
      operation: "read",
    })
    const eligible = async () =>
      (
        await filterEligibleAccountRelayTargets({
          accountPubkey: OWNER,
          targets,
          operation: "read",
          repository,
        })
      ).map((target) => target.url)
    expect(await eligible()).toEqual([RELAY_A, RELAY_B])
    stored = excludeRelay(
      emptyAccountNetworkLocalState(OWNER, () => 1),
      {
        committedAt: 2,
      }
    )
    expect(await eligible()).toEqual([RELAY_B])
    expect(calls).toBe(2)
    expect(
      await filterEligibleAccountRelayTargets({
        accountPubkey: OWNER,
        targets,
        operation: "read",
        repository: {
          async get() {
            throw new Error("IndexedDB unavailable")
          },
        },
      })
    ).toEqual([])
    expect(
      await filterEligibleAccountRelayTargets({
        accountPubkey: "invalid",
        targets,
        operation: "read",
        repository,
      })
    ).toEqual([])
  })

  it("requires signed same-account evidence for an owner ws target", async () => {
    const ownerWs = "ws://owner-relay.example"
    const remoteWs = "ws://remote-hint.example"
    const repository = createInMemoryAccountNetworkLocalStateRepository()
    const evidence = createInMemoryOwnerRelayListEvidenceRepository()
    const selection = await signedEvent({
      kind: 10002,
      createdAt: 100,
      tags: [["r", ownerWs, "read"]],
    })
    await evidence.reconcile({
      pubkey: OWNER,
      observations: [{ signedEvent: selection }],
      lookup: {
        observedAt: 100,
        coverage: "complete",
        hadEvent: true,
        eventId: selection.id,
      },
    })
    const targets = mergeRelayTargets(
      relayTargetsFromUrls([ownerWs, remoteWs], {
        kind: "owner_nip65",
        operation: "read",
        ownerPubkey: OWNER,
        selection: "read",
      }),
      relayTargetsFromUrls([RELAY_B], {
        kind: "public_hint",
        operation: "read",
      })
    )
    const eligible = async (authenticatedPubkey?: string) =>
      (
        await filterEligibleAccountRelayTargets({
          accountPubkey: OWNER,
          authenticatedPubkey,
          targets,
          operation: "read",
          repository,
          ownerRelayListEvidenceRepository: evidence,
        })
      ).map((target) => target.url)
    expect(await eligible(OWNER)).toEqual([ownerWs, RELAY_B])
    expect(await eligible(OTHER)).toEqual([RELAY_B])
    expect(await eligible()).toEqual([RELAY_B])
    await repository.update(OWNER, (state) =>
      excludeRelay(state, { relayUrl: ownerWs, committedAt: 200 })
    )
    expect(await eligible(OWNER)).toEqual([RELAY_B])
  })

  it("preserves overlap grants through independent App and personal switches", async () => {
    const appRelay = config.appReadRelayUrls[0]!
    const personalRelay = RELAY_B
    const repository = createInMemoryAccountNetworkLocalStateRepository()
    const evidence = createInMemoryOwnerRelayListEvidenceRepository()
    const selection = await signedEvent({
      kind: 10002,
      createdAt: 100,
      tags: [
        ["r", appRelay, "read"],
        ["r", personalRelay, "read"],
      ],
    })
    await evidence.reconcile({
      pubkey: OWNER,
      observations: [{ signedEvent: selection }],
      lookup: {
        observedAt: 100,
        coverage: "complete",
        hadEvent: true,
        eventId: selection.id,
      },
    })
    const targets = mergeRelayTargets(
      relayTargetsFromUrls([appRelay], {
        kind: "app",
        operation: "read",
        bucket: "general_read",
      }),
      relayTargetsFromUrls([appRelay, personalRelay], {
        kind: "owner_nip65",
        operation: "read",
        ownerPubkey: OWNER,
        selection: "read",
      })
    )
    const eligible = async () =>
      (
        await filterEligibleAccountRelayTargets({
          accountPubkey: OWNER,
          authenticatedPubkey: OWNER,
          targets,
          operation: "read",
          repository,
          ownerRelayListEvidenceRepository: evidence,
        })
      ).map((target) => target.url)
    expect(await eligible()).toEqual([appRelay, personalRelay])
    await repository.updateRoutingPolicy(OWNER, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "personal", false)
    )
    expect(await eligible()).toEqual([appRelay])
    await repository.updateRoutingPolicy(OWNER, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "personal", true)
    )
    await repository.updateRoutingPolicy(OWNER, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "app", false)
    )
    expect(await eligible()).toEqual([appRelay, personalRelay])
    await repository.update(OWNER, (state) =>
      excludeRelay(state, { relayUrl: appRelay, committedAt: 200 })
    )
    expect(await eligible()).toEqual([personalRelay])
    expect(
      await filterEligibleAccountRelayTargets({
        accountPubkey: OWNER,
        targets: [{ url: RELAY_C, grants: [] }],
        operation: "read",
        repository,
      })
    ).toEqual([])
  })

  it("clears exclusions only for stronger valid own events that explicitly re-add", async () => {
    const relayList = await signedEvent({
      kind: 10002,
      createdAt: 100,
      tags: [["r", RELAY_A, "read"]],
    })
    const inboxDeclaration = await signedEvent({
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

    const newerOmission = await signedEvent({
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

    const otherAuthorReadd = await signedEvent({
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

    const newerRelayListReadd = await signedEvent({
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
    const newerInboxReadd = await signedEvent({
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
    const firstRelayList = await signedEvent({
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
      {
        name: "Relay A",
        icon: "https://relay-a.net/icon.png",
        supported_nips: [42, 50, 59],
      },
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
