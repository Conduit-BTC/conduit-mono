import { beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  __resetAccountNetworkMutationLocksForTests,
  createInMemoryAccountNetworkMutationRepository,
  publishAccountNetworkMutation,
  recordAccountNetworkRelayScans,
  redistributeAccountNetworkInboxDeclaration,
  reorderAccountNetworkRelays,
  retryAccountNetworkMutation,
  reviewAccountNetworkMutation,
  type AccountNetworkMutationAction,
  type AccountNetworkMutationDependencies,
  type AccountNetworkMutationRepository,
  type AccountNetworkMutationSnapshot,
  type AccountNetworkRelayRoles,
} from "@conduit/core/protocol/account-network-mutation"
import {
  applyAccountNetworkRelayExclusion,
  createInMemoryAccountNetworkLocalStateRepository,
  emptyAccountNetworkLocalState,
  filterEligibleAccountRelayUrls,
  orderEquivalentAccountRelayOperations,
} from "@conduit/core/protocol/account-network-local-state"
import {
  applyInboxDeclarationDistributionStage,
  applyInboxDeclarationEvidenceMerge,
  INBOX_DECLARATION_CUTOVER_GRACE_MS,
  INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
} from "@conduit/core/protocol/inbox-declaration-evidence"
import { EVENT_KINDS } from "@conduit/core/protocol/kinds"
import type { AccountNetworkPreferencesReconciliation } from "@conduit/core/protocol/network-preferences"
import { NostrSignerError } from "@conduit/core/protocol/nostr-event-signer"
import {
  applyOwnerRelayListEvidenceReconciliation,
  type OwnerRelayListResolution,
} from "@conduit/core/protocol/owner-relay-list-evidence"
import type { InboxDeclarationResolution } from "@conduit/core/protocol/private-message-routing"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const ACCOUNT_SECRET = generateSecretKey()
const ACCOUNT = getPublicKey(ACCOUNT_SECRET)
const RELAY_A = "wss://relay.damus.io"
const RELAY_B = "wss://nos.lol"
const INBOX_A = "wss://relay.primal.net"
const INBOX_B = "wss://relay.ditto.pub"
const INBOX_C = "wss://inbox.nostr.wine"
const PLAN_A = "wss://purplepag.es"
const PLAN_B = "wss://relay.nostr.band"
const OBSERVED_AT = 150_000
const MUTATION_AT = 200_000

function signedEvent(input: {
  kind: number
  createdAt: number
  tags: string[][]
}): SignedPublicNostrEvent {
  const event = finalizeEvent(
    {
      kind: input.kind,
      created_at: input.createdAt,
      tags: input.tags,
      content: "",
    },
    ACCOUNT_SECRET
  )
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  }
}

interface FixtureOptions {
  ownerCreatedAt?: number
  ownerTags?: string[][]
  inboxCreatedAt?: number
  inboxRelayUrls?: string[]
  cutoverRecoveryRelayUrls?: string[]
  legacyInboxRecoveryRelayUrls?: string[]
}

function createFixture(options: FixtureOptions = {}): {
  snapshot: AccountNetworkMutationSnapshot
  reconciliation: AccountNetworkPreferencesReconciliation
  ownerEvent: SignedPublicNostrEvent
  inboxEvent: SignedPublicNostrEvent
} {
  const ownerEvent = signedEvent({
    kind: EVENT_KINDS.RELAY_LIST,
    createdAt: options.ownerCreatedAt ?? 100,
    tags: options.ownerTags ?? [
      ["r", RELAY_A],
      ["r", RELAY_B],
    ],
  })
  const inboxRelayUrls = options.inboxRelayUrls ?? [INBOX_A]
  const inboxEvent = signedEvent({
    kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
    createdAt: options.inboxCreatedAt ?? 101,
    tags: inboxRelayUrls.map((relayUrl) => ["relay", relayUrl]),
  })
  const ownerRelayList = applyOwnerRelayListEvidenceReconciliation(undefined, {
    pubkey: ACCOUNT,
    observations: [
      {
        signedEvent: ownerEvent,
        sourceRelayUrls: [PLAN_A],
        observedAt: OBSERVED_AT,
        completeObservedAt: OBSERVED_AT,
      },
    ],
    lookup: {
      observedAt: OBSERVED_AT,
      coverage: "complete",
      hadEvent: true,
      eventId: ownerEvent.id,
    },
    cachedAt: OBSERVED_AT,
  })
  const inboxDeclaration = applyInboxDeclarationEvidenceMerge(undefined, {
    pubkey: ACCOUNT,
    signedEvent: inboxEvent,
    sourceRelayUrls: [PLAN_A],
    sharedSourceRelayUrls: [PLAN_A],
    observedAt: OBSERVED_AT,
    completeObservedAt: OBSERVED_AT,
    cachedAt: OBSERVED_AT,
    lookup: {
      observedAt: OBSERVED_AT,
      coverage: "complete",
      hadEvent: true,
      eventId: inboxEvent.id,
    },
  })
  if (options.cutoverRecoveryRelayUrls?.length) {
    inboxDeclaration.cutoverRecoveries = [
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: inboxEvent.id,
        relayUrls: [...options.cutoverRecoveryRelayUrls],
      },
    ]
  }

  const ownerCurrent = ownerRelayList.current!
  const ownerResolution: OwnerRelayListResolution = {
    pubkey: ownerRelayList.pubkey,
    state: ownerCurrent.state,
    preferences: structuredClone(ownerCurrent.preferences),
    stale: false,
    current: structuredClone(ownerCurrent),
    lastUsable: ownerRelayList.lastUsable
      ? structuredClone(ownerRelayList.lastUsable)
      : undefined,
    lookup: structuredClone(ownerRelayList.latestLookup),
    observation: {
      coverage: "complete",
      attemptedRelayUrls: [PLAN_A],
      successfulRelayUrls: [PLAN_A],
      failedRelayUrls: [],
      cappedRelayUrls: [],
      eventId: ownerEvent.id,
      eventSourceRelayUrls: [PLAN_A],
    },
  }
  const inboxResolution: InboxDeclarationResolution = {
    pubkey: ACCOUNT,
    state: "declared",
    relayUrls: [...inboxRelayUrls],
    ...(options.cutoverRecoveryRelayUrls?.length
      ? {
          cutoverRecoveryRelayUrls: [...options.cutoverRecoveryRelayUrls],
        }
      : {}),
    stale: false,
    fetchedAt: OBSERVED_AT,
    eventId: inboxEvent.id,
    eventCreatedAt: inboxEvent.created_at,
    sourceRelayUrls: [PLAN_A],
    sharedSourceRelayUrls: [PLAN_A],
    observation: {
      coverage: "complete",
      attemptedRelayUrls: [PLAN_A],
      successfulRelayUrls: [PLAN_A],
      failedRelayUrls: [],
      eventId: inboxEvent.id,
      eventSourceRelayUrls: [PLAN_A],
    },
  }
  const reconciliation: AccountNetworkPreferencesReconciliation = {
    projection: {
      pubkey: ACCOUNT,
      relayScope: `account:${ACCOUNT}`,
      rows: [],
      relayListState: ownerResolution.state,
      relayListStale: false,
      inboxState: inboxResolution.state,
      inboxStale: false,
    },
    ownerRelayList: ownerResolution,
    inboxDeclaration: inboxResolution,
    legacyMigration: "already_complete",
    legacyReviewCandidate: null,
    localExcludedRelayUrls: [],
    legacyInboxRecoveryRelayUrls: options.legacyInboxRecoveryRelayUrls ?? [],
  }
  return {
    snapshot: {
      ownerRelayList,
      inboxDeclaration,
      localState: emptyAccountNetworkLocalState(ACCOUNT, () => 0),
    },
    reconciliation,
    ownerEvent,
    inboxEvent,
  }
}

function baselineRoles(): AccountNetworkRelayRoles[] {
  return [
    {
      url: RELAY_A,
      read: true,
      publish: true,
      privateInbox: false,
    },
    {
      url: RELAY_B,
      read: true,
      publish: true,
      privateInbox: false,
    },
    {
      url: INBOX_A,
      read: false,
      publish: false,
      privateInbox: true,
    },
  ]
}

function action(
  relays: readonly AccountNetworkRelayRoles[],
  removedRelayUrls: readonly string[] = []
): AccountNetworkMutationAction {
  return {
    type: "set_roles",
    relays,
    removedRelayUrls,
  }
}

function ownerChangedRoles(): AccountNetworkRelayRoles[] {
  return baselineRoles().map((relay) =>
    relay.url === RELAY_A ? { ...relay, publish: false } : relay
  )
}

function inboxChangedRoles(): AccountNetworkRelayRoles[] {
  return baselineRoles().map((relay) =>
    relay.url === INBOX_A ? { ...relay, url: INBOX_B } : relay
  )
}

function bothKindsChangedRoles(): AccountNetworkRelayRoles[] {
  return inboxChangedRoles().map((relay) =>
    relay.url === RELAY_A ? { ...relay, publish: false } : relay
  )
}

interface SignerHarness {
  signer: {
    readonly authMethod: "nip07"
    getPublicKey(): Promise<string>
    signEvent(
      event: Omit<SignedPublicNostrEvent, "id" | "sig">
    ): Promise<SignedPublicNostrEvent>
  }
  getPublicKeyCalls: number
  signedDrafts: Array<Omit<SignedPublicNostrEvent, "id" | "sig">>
  signedEvents: SignedPublicNostrEvent[]
}

function createSignerHarness(input: {
  log: string[]
  cancelSignatureAt?: number
}): SignerHarness {
  const harness: SignerHarness = {
    getPublicKeyCalls: 0,
    signedDrafts: [],
    signedEvents: [],
    signer: {
      authMethod: "nip07",
      async getPublicKey() {
        harness.getPublicKeyCalls += 1
        input.log.push("signer:pubkey")
        return ACCOUNT
      },
      async signEvent(event) {
        harness.signedDrafts.push(structuredClone(event))
        input.log.push(`sign:${event.kind}`)
        if (harness.signedDrafts.length === input.cancelSignatureAt) {
          throw new NostrSignerError("authorization_denied")
        }
        const signed = signedEvent({
          kind: event.kind,
          createdAt: event.created_at,
          tags: event.tags.map((tag) => [...tag]),
        })
        harness.signedEvents.push(structuredClone(signed))
        return signed
      },
    },
  }
  return harness
}

type PublishBehavior = "acked" | "rejected" | "timed_out" | "throw"
type ReadbackBehavior = "observed" | "absent" | "timed_out" | "throw"

interface ExecutionOptions {
  initialSnapshot?: AccountNetworkMutationSnapshot
  planForKind?: (kind: number) => readonly string[]
  beforeRestage?: (
    repository: AccountNetworkMutationRepository
  ) => Promise<void> | void
  publishBehavior?: (input: {
    kind: number
    relayUrl: string
    attempt: number
  }) => PublishBehavior
  readbackBehavior?: (input: {
    kind: number
    relayUrl: string
    attempt: number
  }) => ReadbackBehavior
  filterEligibleRelayUrls?: (
    relayUrls: readonly string[],
    ownerSelectedRelayUrls: readonly string[],
    authenticatedPubkey: string | null
  ) => string[]
  stageError?: Error
}

interface ExecutionHarness {
  repository: AccountNetworkMutationRepository
  baseRepository: AccountNetworkMutationRepository
  dependencies: AccountNetworkMutationDependencies
  log: string[]
  publishCalls: Array<{
    relayUrl: string
    signedEvent: SignedPublicNostrEvent
    ownerSelectedRelayUrls: readonly string[]
    authenticatedPubkey: string | null
  }>
  readbackCalls: Array<{
    relayUrl: string
    eventId: string
    kind: number
    ownerSelectedRelayUrls: readonly string[]
    authenticatedPubkey: string | null
  }>
  restageInputs: Array<{
    signedEvent: SignedPublicNostrEvent
    expectedPublishRelayUrls: readonly string[]
    publishRelayUrls: readonly string[]
  }>
}

function createExecutionHarness(
  fixture: ReturnType<typeof createFixture>,
  options: ExecutionOptions = {}
): ExecutionHarness {
  const log: string[] = []
  const publishCalls: ExecutionHarness["publishCalls"] = []
  const readbackCalls: ExecutionHarness["readbackCalls"] = []
  const restageInputs: ExecutionHarness["restageInputs"] = []
  const baseRepository = createInMemoryAccountNetworkMutationRepository([
    {
      pubkey: ACCOUNT,
      snapshot: options.initialSnapshot ?? fixture.snapshot,
    },
  ])
  const repository: AccountNetworkMutationRepository = {
    get: async (pubkey) => await baseRepository.get(pubkey),
    stage: async (input) => {
      log.push("stage:start")
      if (options.stageError) throw options.stageError
      const staged = await baseRepository.stage(input)
      log.push("stage:committed")
      return staged
    },
    restageInboxDistribution: async (input) => {
      log.push("restage:start")
      if (options.stageError) throw options.stageError
      restageInputs.push(structuredClone(input))
      await options.beforeRestage?.(baseRepository)
      const staged = await baseRepository.restageInboxDistribution(input)
      log.push("restage:committed")
      return staged
    },
    recordOutcomes: async (input) => await baseRepository.recordOutcomes(input),
  }
  const publishedById = new Map<string, SignedPublicNostrEvent>()
  const publishAttempts = new Map<string, number>()
  const readbackAttempts = new Map<string, number>()
  const dependencies: AccountNetworkMutationDependencies = {
    repository,
    reconcile: async () => structuredClone(fixture.reconciliation),
    resolveRelayPlan: ({ kind }) => options.planForKind?.(kind) ?? [PLAN_A],
    filterEligibleRelayUrls: async (
      _pubkey,
      relayUrls,
      ownerSelectedRelayUrls,
      authenticatedPubkey
    ) =>
      options.filterEligibleRelayUrls?.(
        relayUrls,
        ownerSelectedRelayUrls,
        authenticatedPubkey
      ) ?? [...relayUrls],
    publishToRelay: async (input) => {
      const key = `${input.signedEvent.kind}:${input.relayUrl}`
      const attempt = (publishAttempts.get(key) ?? 0) + 1
      publishAttempts.set(key, attempt)
      log.push(`publish:${input.signedEvent.kind}:${input.relayUrl}`)
      publishCalls.push({
        relayUrl: input.relayUrl,
        signedEvent: structuredClone(input.signedEvent),
        ownerSelectedRelayUrls: [...(input.ownerSelectedRelayUrls ?? [])],
        authenticatedPubkey: input.authenticatedPubkey ?? null,
      })
      publishedById.set(
        input.signedEvent.id,
        structuredClone(input.signedEvent)
      )
      const behavior =
        options.publishBehavior?.({
          kind: input.signedEvent.kind,
          relayUrl: input.relayUrl,
          attempt,
        }) ?? "acked"
      if (behavior === "throw") throw new Error("publish unavailable")
      return behavior
    },
    fetchEvents: async (filter, readOptions) => {
      const relayUrl = readOptions.relayUrls[0]!
      const eventId = filter.ids?.[0]
      const kind = filter.kinds?.[0]
      if (!eventId || kind === undefined) {
        throw new Error("readback harness requires one event id and kind")
      }
      const key = `${kind}:${relayUrl}`
      const attempt = (readbackAttempts.get(key) ?? 0) + 1
      readbackAttempts.set(key, attempt)
      log.push(`readback:${kind}:${relayUrl}`)
      readbackCalls.push({
        relayUrl,
        eventId,
        kind,
        ownerSelectedRelayUrls: [...(readOptions.ownerSelectedRelayUrls ?? [])],
        authenticatedPubkey: readOptions.authenticatedPubkey ?? null,
      })
      const behavior =
        options.readbackBehavior?.({ kind, relayUrl, attempt }) ?? "observed"
      if (behavior === "throw") throw new Error("readback unavailable")
      const event = publishedById.get(eventId)
      const observed = behavior === "observed" && event !== undefined
      return {
        events: observed ? [structuredClone(event)] : [],
        eventSourceRelayUrls: observed ? { [eventId]: [relayUrl] } : {},
        relays: [
          {
            relayUrl,
            status: behavior === "timed_out" ? "failed" : "success",
            eventCount: observed ? 1 : 0,
            rejectedEventCount: 0,
          },
        ],
        eventsVerified: true,
      }
    },
    now: () => MUTATION_AT,
  }
  return {
    repository,
    baseRepository,
    dependencies,
    log,
    publishCalls,
    readbackCalls,
    restageInputs,
  }
}

beforeEach(() => {
  __resetAccountNetworkMutationLocksForTests()
})

describe("account network mutation", () => {
  it("makes exactly zero, one, or two signer requests for the changed kinds", async () => {
    const cases = [
      { roles: baselineRoles(), expectedKinds: 0 },
      { roles: ownerChangedRoles(), expectedKinds: 1 },
      { roles: bothKindsChangedRoles(), expectedKinds: 2 },
    ]

    for (const testCase of cases) {
      __resetAccountNetworkMutationLocksForTests()
      const fixture = createFixture()
      const execution = createExecutionHarness(fixture)
      const signer = createSignerHarness({ log: execution.log })
      const reviewed = reviewAccountNetworkMutation(
        fixture.reconciliation,
        action(testCase.roles)
      )

      expect(reviewed.changedKinds).toHaveLength(testCase.expectedKinds)
      expect(reviewed.signerRequestCount).toBe(testCase.expectedKinds)
      const result = await publishAccountNetworkMutation({
        reviewed,
        ...(testCase.expectedKinds > 0 ? { signer: signer.signer } : {}),
        dependencies: execution.dependencies,
      })

      expect(signer.signedDrafts).toHaveLength(testCase.expectedKinds)
      expect(signer.getPublicKeyCalls).toBe(testCase.expectedKinds > 0 ? 1 : 0)
      expect(result.status).toBe(
        testCase.expectedKinds === 0 ? "no_change" : "staged"
      )
    }
  })

  it("accepts one Publish relay with a redundancy warning and rejects zero", () => {
    const fixture = createFixture()
    const onePublishRelay = baselineRoles().map((relay) =>
      relay.url === RELAY_A ? { ...relay, publish: false } : relay
    )
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(onePublishRelay)
    )
    expect(reviewed.warnings).toEqual(["single_relay_no_redundancy"])

    const noPublishRelay = baselineRoles().map((relay) =>
      relay.url === RELAY_A || relay.url === RELAY_B
        ? { ...relay, publish: false }
        : relay
    )
    expect(() =>
      reviewAccountNetworkMutation(
        fixture.reconciliation,
        action(noPublishRelay)
      )
    ).toThrow("without a Publish relay")
  })

  it("accepts an authenticated owner's ws relay as the sole Publish relay", async () => {
    const fixture = createFixture()
    const ownerWs = "ws://owner-selected.example"
    const relays = baselineRoles()
      .map((relay) => ({ ...relay, publish: false }))
      .concat({
        url: ownerWs,
        read: false,
        publish: true,
        privateInbox: false,
      })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(relays)
    )
    const seenOwnerSubsets: string[][] = []
    const execution = createExecutionHarness(fixture, {
      planForKind: (kind) =>
        kind === EVENT_KINDS.RELAY_LIST ? [ownerWs, PLAN_A] : [PLAN_A],
      filterEligibleRelayUrls: (relayUrls, ownerSelectedRelayUrls) => {
        seenOwnerSubsets.push([...ownerSelectedRelayUrls])
        return relayUrls.filter(
          (relayUrl) =>
            relayUrl.startsWith("wss://") ||
            ownerSelectedRelayUrls.includes(relayUrl)
        )
      },
    })
    const signer = createSignerHarness({ log: execution.log })

    await publishAccountNetworkMutation({
      reviewed,
      authenticatedPubkey: ACCOUNT,
      signer: signer.signer,
      dependencies: execution.dependencies,
    })

    expect(reviewed.warnings).toEqual(["single_relay_no_redundancy"])
    expect(signer.signedDrafts[0]?.tags).toContainEqual(["r", ownerWs, "write"])
    expect(execution.publishCalls.map((call) => call.relayUrl)).toContain(
      ownerWs
    )
    expect(execution.readbackCalls.map((call) => call.relayUrl)).toContain(
      ownerWs
    )
    expect(
      execution.publishCalls
        .filter((call) => call.relayUrl === ownerWs)
        .every((call) => call.ownerSelectedRelayUrls.includes(ownerWs))
    ).toBe(true)
    expect(
      execution.readbackCalls
        .filter((call) => call.relayUrl === ownerWs)
        .every((call) => call.ownerSelectedRelayUrls.includes(ownerWs))
    ).toBe(true)
    expect(seenOwnerSubsets.some((urls) => urls.includes(ownerWs))).toBe(true)
    expect(
      [...execution.publishCalls, ...execution.readbackCalls]
        .filter((call) => call.relayUrl === ownerWs)
        .every((call) => call.authenticatedPubkey === ACCOUNT)
    ).toBe(true)
  })

  it("retries an exact staged owner ws relay without admitting remote ws targets", async () => {
    const fixture = createFixture()
    const ownerWs = "ws://owner-retry.example"
    const remoteWs = "ws://remote-plan.example"
    const relays = baselineRoles()
      .map((relay) => ({ ...relay, publish: false }))
      .concat({
        url: ownerWs,
        read: false,
        publish: true,
        privateInbox: false,
      })
    let deliveryRound = 1
    const execution = createExecutionHarness(fixture, {
      planForKind: (kind) =>
        kind === EVENT_KINDS.RELAY_LIST
          ? [ownerWs, remoteWs, PLAN_A]
          : [PLAN_A],
      filterEligibleRelayUrls: (relayUrls, ownerSelectedRelayUrls) =>
        relayUrls.filter(
          (relayUrl) =>
            relayUrl.startsWith("wss://") ||
            ownerSelectedRelayUrls.includes(relayUrl)
        ),
      publishBehavior: ({ kind, relayUrl }) =>
        kind === EVENT_KINDS.RELAY_LIST &&
        relayUrl === ownerWs &&
        deliveryRound === 1
          ? "timed_out"
          : "acked",
      readbackBehavior: ({ kind, relayUrl }) =>
        kind === EVENT_KINDS.RELAY_LIST &&
        relayUrl === ownerWs &&
        deliveryRound === 1
          ? "timed_out"
          : "observed",
    })
    const signer = createSignerHarness({ log: execution.log })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(relays)
    )

    await publishAccountNetworkMutation({
      reviewed,
      authenticatedPubkey: ACCOUNT,
      signer: signer.signer,
      dependencies: execution.dependencies,
    })
    const afterFirstAttempt = await execution.baseRepository.get(ACCOUNT)
    const pending = afterFirstAttempt.ownerRelayList?.pendingDistribution
    expect(pending).toBeDefined()
    const exactSignedBytes = structuredClone(pending!.signedEvent)

    deliveryRound = 2
    execution.publishCalls.splice(0)
    execution.readbackCalls.splice(0)
    await retryAccountNetworkMutation({
      pubkey: ACCOUNT,
      authenticatedPubkey: ACCOUNT,
      kind: EVENT_KINDS.RELAY_LIST,
      dependencies: execution.dependencies,
    })

    expect(execution.publishCalls).toEqual([
      expect.objectContaining({
        relayUrl: ownerWs,
        signedEvent: exactSignedBytes,
        ownerSelectedRelayUrls: [ownerWs],
      }),
    ])
    expect(execution.readbackCalls).toEqual([
      expect.objectContaining({
        relayUrl: ownerWs,
        eventId: exactSignedBytes.id,
        ownerSelectedRelayUrls: [ownerWs],
      }),
    ])
    expect(
      [...execution.publishCalls, ...execution.readbackCalls].some(
        (call) => call.relayUrl === remoteWs
      )
    ).toBe(false)
    expect(signer.signedDrafts).toHaveLength(1)
  })

  it("drops a staged owner ws relay after authentication changes while retaining wss retry", async () => {
    const fixture = createFixture()
    const ownerWs = "ws://owner-auth-changed.example"
    const remoteWs = "ws://remote-auth-changed.example"
    const relays = baselineRoles()
      .map((relay) => ({ ...relay, publish: false }))
      .concat({
        url: ownerWs,
        read: false,
        publish: true,
        privateInbox: false,
      })
    let deliveryRound = 1
    const execution = createExecutionHarness(fixture, {
      planForKind: (kind) =>
        kind === EVENT_KINDS.RELAY_LIST
          ? [ownerWs, remoteWs, PLAN_A]
          : [PLAN_A],
      filterEligibleRelayUrls: (
        relayUrls,
        ownerSelectedRelayUrls,
        authenticatedPubkey
      ) =>
        relayUrls.filter(
          (relayUrl) =>
            relayUrl.startsWith("wss://") ||
            (authenticatedPubkey === ACCOUNT &&
              ownerSelectedRelayUrls.includes(relayUrl))
        ),
      publishBehavior: () => (deliveryRound === 1 ? "timed_out" : "acked"),
      readbackBehavior: () => (deliveryRound === 1 ? "timed_out" : "observed"),
    })
    const signer = createSignerHarness({ log: execution.log })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(relays)
    )

    await publishAccountNetworkMutation({
      reviewed,
      authenticatedPubkey: ACCOUNT,
      signer: signer.signer,
      dependencies: execution.dependencies,
    })
    const pending = (await execution.baseRepository.get(ACCOUNT)).ownerRelayList
      ?.pendingDistribution
    expect(pending).toBeDefined()
    const exactSignedBytes = structuredClone(pending!.signedEvent)

    deliveryRound = 2
    execution.publishCalls.splice(0)
    execution.readbackCalls.splice(0)
    await retryAccountNetworkMutation({
      pubkey: ACCOUNT,
      authenticatedPubkey: "b".repeat(64),
      kind: EVENT_KINDS.RELAY_LIST,
      dependencies: execution.dependencies,
    })

    expect(execution.publishCalls).toEqual([
      expect.objectContaining({
        relayUrl: PLAN_A,
        signedEvent: exactSignedBytes,
        ownerSelectedRelayUrls: [],
        authenticatedPubkey: null,
      }),
    ])
    expect(execution.readbackCalls).toEqual([
      expect.objectContaining({
        relayUrl: PLAN_A,
        eventId: exactSignedBytes.id,
        ownerSelectedRelayUrls: [],
        authenticatedPubkey: null,
      }),
    ])
    expect(
      [...execution.publishCalls, ...execution.readbackCalls].some((call) =>
        [ownerWs, remoteWs].includes(call.relayUrl)
      )
    ).toBe(false)
    expect(signer.signedDrafts).toHaveLength(1)
  })

  it("requires a replacement in the same action before removing the last usable inbox", () => {
    const fixture = createFixture()
    const withoutInbox = baselineRoles().filter(
      (relay) => relay.url !== INBOX_A
    )
    expect(() =>
      reviewAccountNetworkMutation(
        fixture.reconciliation,
        action(withoutInbox, [INBOX_A])
      )
    ).toThrow("Choose a replacement")

    const replacement = [
      ...withoutInbox,
      {
        url: INBOX_B,
        read: false,
        publish: false,
        privateInbox: true,
      },
    ]
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(replacement, [INBOX_A])
    )
    expect(reviewed.changedKinds).toEqual([EVENT_KINDS.PRIVATE_MESSAGE_RELAYS])
  })

  it("requires a replacement when only retained recovery keeps the inbox usable", () => {
    const fixture = createFixture()
    fixture.reconciliation.inboxDeclaration = {
      ...fixture.reconciliation.inboxDeclaration,
      state: "lookup_partial",
      relayUrls: [],
      retainedReadRelayUrls: [INBOX_A],
      stale: true,
      observation: {
        coverage: "partial",
        attemptedRelayUrls: [PLAN_A],
        successfulRelayUrls: [],
        failedRelayUrls: [PLAN_A],
        eventSourceRelayUrls: [],
      },
    }

    const withoutInbox = baselineRoles().filter(
      (relay) => relay.url !== INBOX_A
    )
    expect(() =>
      reviewAccountNetworkMutation(
        fixture.reconciliation,
        action(withoutInbox, [INBOX_A])
      )
    ).toThrow("Choose a replacement")
  })

  it("requires a replacement when only legacy recovery keeps the inbox usable", () => {
    const fixture = createFixture({ legacyInboxRecoveryRelayUrls: [INBOX_A] })
    fixture.reconciliation.inboxDeclaration = {
      ...fixture.reconciliation.inboxDeclaration,
      state: "not_observed",
      relayUrls: [],
      stale: false,
      eventId: undefined,
      eventCreatedAt: undefined,
      sourceRelayUrls: undefined,
      sharedSourceRelayUrls: undefined,
    }

    const withoutInbox = baselineRoles().filter(
      (relay) => relay.url !== INBOX_A
    )
    expect(() =>
      reviewAccountNetworkMutation(
        fixture.reconciliation,
        action(withoutInbox, [INBOX_A])
      )
    ).toThrow("Choose a replacement")
  })

  it("requires a current replacement even when a different recovery-only inbox survives", () => {
    const fixture = createFixture({
      cutoverRecoveryRelayUrls: [INBOX_B],
    })
    const withoutCurrentInbox = baselineRoles().filter(
      (relay) => relay.url !== INBOX_A
    )

    expect(() =>
      reviewAccountNetworkMutation(
        fixture.reconciliation,
        action(withoutCurrentInbox, [INBOX_A])
      )
    ).toThrow("Choose a replacement")
  })

  it("allows an unrelated relay-role change while recovery-only inboxes remain", () => {
    const fixture = createFixture({
      cutoverRecoveryRelayUrls: [INBOX_A],
    })
    fixture.reconciliation.inboxDeclaration = {
      ...fixture.reconciliation.inboxDeclaration,
      state: "signed_empty",
      relayUrls: [],
      retainedReadRelayUrls: [],
      cutoverRecoveryRelayUrls: [INBOX_A],
    }
    const unrelatedRoleChange = ownerChangedRoles().map((relay) =>
      relay.url === INBOX_A ? { ...relay, privateInbox: false } : relay
    )

    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(unrelatedRoleChange)
    )

    expect(reviewed.changedKinds).toEqual([EVENT_KINDS.RELAY_LIST])
    expect(reviewed.previousInboxRelayUrls).toEqual([])
  })

  it("allows another role to change when the account has no usable inbox", () => {
    const fixture = createFixture()
    fixture.reconciliation.inboxDeclaration = {
      ...fixture.reconciliation.inboxDeclaration,
      state: "not_observed",
      relayUrls: [],
      retainedReadRelayUrls: [],
      cutoverRecoveryRelayUrls: [],
      eventId: undefined,
      eventCreatedAt: undefined,
    }
    const unrelatedRoleChange = ownerChangedRoles().map((relay) =>
      relay.url === INBOX_A ? { ...relay, privateInbox: false } : relay
    )

    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(unrelatedRoleChange)
    )

    expect(reviewed.changedKinds).toEqual([EVENT_KINDS.RELAY_LIST])
  })

  it("preserves retained signed tag order instead of local display order", async () => {
    const fixture = createFixture()
    const reversedDisplayOrder = [
      baselineRoles()[1]!,
      baselineRoles()[2]!,
      { ...baselineRoles()[0]!, publish: false },
    ]
    const execution = createExecutionHarness(fixture)
    const signer = createSignerHarness({ log: execution.log })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(reversedDisplayOrder)
    )

    await publishAccountNetworkMutation({
      reviewed,
      signer: signer.signer,
      dependencies: execution.dependencies,
    })

    const relayListDraft = signer.signedDrafts.find(
      (draft) => draft.kind === EVENT_KINDS.RELAY_LIST
    )
    expect(relayListDraft?.tags).toEqual([
      ["r", RELAY_A, "read"],
      ["r", RELAY_B],
    ])
  })

  it("commits all checkpoints before the first network attempt", async () => {
    const fixture = createFixture()
    const execution = createExecutionHarness(fixture)
    const signer = createSignerHarness({ log: execution.log })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(bothKindsChangedRoles())
    )

    await publishAccountNetworkMutation({
      reviewed,
      signer: signer.signer,
      dependencies: execution.dependencies,
    })

    const stagedAt = execution.log.indexOf("stage:committed")
    const firstNetworkAttempt = execution.log.findIndex(
      (entry) => entry.startsWith("publish:") || entry.startsWith("readback:")
    )
    expect(stagedAt).toBeGreaterThan(-1)
    expect(firstNetworkAttempt).toBeGreaterThan(stagedAt)
  })

  it("reserves shared inbox targets before bounded eligible owner Publish targets", async () => {
    const fixture = createFixture()
    const shared = [PLAN_B, PLAN_A]
    const ownerTargets = Array.from(
      { length: 8 },
      (_, index) => `wss://owner-${index + 1}.example`
    )
    const ineligibleOwnerTarget = ownerTargets[0]!
    const roles = [
      ...inboxChangedRoles(),
      ...ownerTargets.map((url) => ({
        url,
        read: false,
        publish: true,
        privateInbox: false,
      })),
    ]
    const execution = createExecutionHarness(fixture, {
      planForKind: (kind) =>
        kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS ? shared : [PLAN_A],
      filterEligibleRelayUrls: (relayUrls) =>
        relayUrls.filter((relayUrl) => relayUrl !== ineligibleOwnerTarget),
      readbackBehavior: ({ kind, relayUrl }) =>
        kind !== EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
          ? "observed"
          : relayUrl === PLAN_B
            ? "observed"
            : relayUrl === PLAN_A
              ? "absent"
              : "timed_out",
    })
    const signer = createSignerHarness({ log: execution.log })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(roles)
    )

    await publishAccountNetworkMutation({
      reviewed,
      signer: signer.signer,
      dependencies: execution.dependencies,
    })

    const retained = await execution.baseRepository.get(ACCOUNT)
    const pending = retained.inboxDeclaration?.pendingDistribution
    expect(pending?.publishRelayUrls).toHaveLength(8)
    expect(pending?.publishRelayUrls.slice(0, 2)).toEqual(shared)
    expect(pending?.publishRelayUrls).not.toContain(ineligibleOwnerTarget)
    expect(pending?.confirmationRelayUrls).toEqual([...shared].sort())
    expect(
      retained.inboxDeclaration?.cutoverRecoveries?.[0]
        ?.confirmationAttempts?.[0]
    ).toMatchObject({
      relayUrls: [...shared].sort(),
      completedRelayUrls: [...shared].sort(),
      observedRelayUrls: [PLAN_B],
    })
    expect(
      retained.inboxDeclaration?.cutoverRecoveries?.[0]?.readbackObservedAt
    ).toBe(MUTATION_AT)
    expect(execution.log.indexOf("stage:committed")).toBeLessThan(
      execution.log.findIndex(
        (entry) => entry.startsWith("publish:") || entry.startsWith("readback:")
      )
    )
  })

  it("retires an exact legacy review candidate only after kind:10002 staging", async () => {
    const fixture = createFixture()
    fixture.reconciliation.legacyMigration = "review_required"
    fixture.reconciliation.legacyReviewCandidate = {
      pubkey: ACCOUNT,
      relayScope: `account:${ACCOUNT}`,
      draft: {
        version: 1,
        entries: [],
        updatedAt: 1,
      },
      sourceFingerprint: "fnv1a64:1:0000000000000001",
      source: "legacy_app_scopes",
    }
    const execution = createExecutionHarness(fixture)
    execution.dependencies.completeLegacyDraftMigration = async (input) => {
      expect(input.candidate).toEqual(
        fixture.reconciliation.legacyReviewCandidate
      )
      expect(input.disposition).toBe("publish_staged")
      execution.log.push("migration:completed")
      return "completed"
    }
    const signer = createSignerHarness({ log: execution.log })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(ownerChangedRoles())
    )

    const result = await publishAccountNetworkMutation({
      reviewed,
      signer: signer.signer,
      dependencies: execution.dependencies,
    })

    expect(result.legacyMigrationCompletion).toBe("completed")
    expect(execution.log.indexOf("migration:completed")).toBeGreaterThan(
      execution.log.indexOf("stage:committed")
    )
    expect(execution.log.indexOf("migration:completed")).toBeLessThan(
      execution.log.findIndex((entry) => entry.startsWith("publish:"))
    )
  })

  it("does no I/O or durable write when the second signature is cancelled", async () => {
    const fixture = createFixture()
    const execution = createExecutionHarness(fixture)
    const before = await execution.baseRepository.get(ACCOUNT)
    const signer = createSignerHarness({
      log: execution.log,
      cancelSignatureAt: 2,
    })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(bothKindsChangedRoles())
    )

    await expect(
      publishAccountNetworkMutation({
        reviewed,
        signer: signer.signer,
        dependencies: execution.dependencies,
      })
    ).rejects.toMatchObject({ code: "authorization_denied" })
    expect(signer.signedDrafts).toHaveLength(2)
    expect(execution.log).not.toContain("stage:start")
    expect(execution.publishCalls).toHaveLength(0)
    expect(execution.readbackCalls).toHaveLength(0)
    expect(await execution.baseRepository.get(ACCOUNT)).toEqual(before)
  })

  it("rejects a mismatched signer before signing, staging, or relay I/O", async () => {
    const fixture = createFixture()
    const execution = createExecutionHarness(fixture)
    const signer = createSignerHarness({ log: execution.log })
    signer.signer.getPublicKey = async () => getPublicKey(generateSecretKey())
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(ownerChangedRoles())
    )

    await expect(
      publishAccountNetworkMutation({
        reviewed,
        signer: signer.signer,
        dependencies: execution.dependencies,
      })
    ).rejects.toMatchObject({ code: "signer_mismatch" })
    expect(signer.signedDrafts).toHaveLength(0)
    expect(execution.log).not.toContain("stage:start")
    expect(execution.publishCalls).toHaveLength(0)
    expect(execution.readbackCalls).toHaveLength(0)
  })

  it("rejects signer-mutated output before staging or relay I/O", async () => {
    const fixture = createFixture()
    const execution = createExecutionHarness(fixture)
    const signer = createSignerHarness({ log: execution.log })
    signer.signer.signEvent = async (event) =>
      signedEvent({
        kind: event.kind,
        createdAt: event.created_at,
        tags: [...event.tags.map((tag) => [...tag]), ["mutated"]],
      })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(ownerChangedRoles())
    )

    await expect(
      publishAccountNetworkMutation({
        reviewed,
        signer: signer.signer,
        dependencies: execution.dependencies,
      })
    ).rejects.toMatchObject({ code: "invalid_signature" })
    expect(execution.log).not.toContain("stage:start")
    expect(execution.publishCalls).toHaveLength(0)
    expect(execution.readbackCalls).toHaveLength(0)
  })

  it("rejects a future-skewed frontier before asking for a signature", async () => {
    const fixture = createFixture({ ownerCreatedAt: 1_000 })
    const execution = createExecutionHarness(fixture)
    const signer = createSignerHarness({ log: execution.log })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(ownerChangedRoles())
    )

    await expect(
      publishAccountNetworkMutation({
        reviewed,
        signer: signer.signer,
        dependencies: execution.dependencies,
      })
    ).rejects.toMatchObject({ code: "evidence_changed" })
    expect(signer.getPublicKeyCalls).toBe(1)
    expect(signer.signedDrafts).toHaveLength(0)
    expect(execution.log).not.toContain("stage:start")
    expect(execution.publishCalls).toHaveLength(0)
    expect(execution.readbackCalls).toHaveLength(0)
  })

  it("does no network I/O or durable change when atomic staging fails", async () => {
    const fixture = createFixture()
    const execution = createExecutionHarness(fixture, {
      stageError: new Error("stage unavailable"),
    })
    const before = await execution.baseRepository.get(ACCOUNT)
    const signer = createSignerHarness({ log: execution.log })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(ownerChangedRoles())
    )

    await expect(
      publishAccountNetworkMutation({
        reviewed,
        signer: signer.signer,
        dependencies: execution.dependencies,
      })
    ).rejects.toThrow("stage unavailable")
    expect(signer.signedDrafts).toHaveLength(1)
    expect(execution.log).toContain("stage:start")
    expect(execution.log).not.toContain("stage:committed")
    expect(execution.publishCalls).toHaveLength(0)
    expect(execution.readbackCalls).toHaveLength(0)
    expect(await execution.baseRepository.get(ACCOUNT)).toEqual(before)
  })

  it("keeps one kind pending without blocking the other kind", async () => {
    const fixture = createFixture()
    const execution = createExecutionHarness(fixture, {
      publishBehavior: ({ kind }) =>
        kind === EVENT_KINDS.RELAY_LIST ? "throw" : "acked",
      readbackBehavior: ({ kind }) =>
        kind === EVENT_KINDS.RELAY_LIST ? "timed_out" : "observed",
    })
    const signer = createSignerHarness({ log: execution.log })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(bothKindsChangedRoles())
    )

    const result = await publishAccountNetworkMutation({
      reviewed,
      signer: signer.signer,
      dependencies: execution.dependencies,
    })
    const retained = await execution.baseRepository.get(ACCOUNT)

    expect(retained.ownerRelayList?.pendingDistribution).toBeDefined()
    expect(
      retained.ownerRelayList?.pendingDistribution?.relayOutcomes[0]
    ).toMatchObject({
      publishStatus: "timed_out",
      readbackStatus: "timed_out",
    })
    expect(retained.inboxDeclaration?.pendingDistribution).toBeUndefined()
    expect(
      result.checkpoints.find(
        (checkpoint) => checkpoint.kind === EVENT_KINDS.RELAY_LIST
      )?.pending
    ).toBe(true)
    expect(
      result.checkpoints.find(
        (checkpoint) => checkpoint.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
      )?.pending
    ).toBe(false)
    expect(
      execution.publishCalls.map((call) => ({
        kind: call.signedEvent.kind,
        relayUrl: call.relayUrl,
      }))
    ).toEqual([
      { kind: EVENT_KINDS.RELAY_LIST, relayUrl: PLAN_A },
      { kind: EVENT_KINDS.RELAY_LIST, relayUrl: RELAY_B },
      { kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS, relayUrl: PLAN_A },
      { kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS, relayUrl: RELAY_B },
    ])
  })

  it("retries exact staged bytes only against unresolved targets", async () => {
    const fixture = createFixture()
    let deliveryRound = 1
    const execution = createExecutionHarness(fixture, {
      planForKind: (kind) =>
        kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
          ? [PLAN_A, PLAN_B]
          : [PLAN_A],
      publishBehavior: ({ relayUrl }) =>
        deliveryRound === 1 && relayUrl === PLAN_B ? "timed_out" : "acked",
      readbackBehavior: ({ relayUrl }) =>
        deliveryRound === 1
          ? relayUrl === PLAN_A
            ? "observed"
            : "timed_out"
          : "absent",
    })
    const signer = createSignerHarness({ log: execution.log })
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(inboxChangedRoles())
    )

    const firstResult = await publishAccountNetworkMutation({
      reviewed,
      signer: signer.signer,
      dependencies: execution.dependencies,
    })
    const afterFirstAttempt = await execution.baseRepository.get(ACCOUNT)
    const pending = afterFirstAttempt.inboxDeclaration?.pendingDistribution
    expect(firstResult.checkpoints[0]?.pending).toBe(true)
    expect(pending).toBeDefined()
    const exactSignedBytes = structuredClone(pending!.signedEvent)
    const stagedAt = pending!.stagedAt

    deliveryRound = 2
    execution.publishCalls.splice(0)
    execution.readbackCalls.splice(0)
    const retryResult = await retryAccountNetworkMutation({
      pubkey: ACCOUNT,
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      dependencies: execution.dependencies,
    })

    expect(execution.publishCalls.map((call) => call.relayUrl)).toEqual([
      PLAN_B,
    ])
    expect(execution.readbackCalls.map((call) => call.relayUrl)).toEqual([
      PLAN_B,
      RELAY_A,
      RELAY_B,
    ])
    expect(execution.publishCalls[0]?.signedEvent).toEqual(exactSignedBytes)
    expect(signer.signedDrafts).toHaveLength(1)
    expect(retryResult.checkpoints[0]).toMatchObject({
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      pending: false,
      signedEvent: exactSignedBytes,
    })
    expect(
      execution.log.filter((entry) => entry === "stage:committed")
    ).toHaveLength(1)
    expect(stagedAt).toBe(MUTATION_AT)
    expect(
      (await execution.baseRepository.get(ACCOUNT)).inboxDeclaration
        ?.pendingDistribution
    ).toBeUndefined()
  })

  it("does not copy an earlier pending recovery into a later cutover clock", async () => {
    const fixture = createFixture()
    const firstExecution = createExecutionHarness(fixture, {
      readbackBehavior: ({ kind }) =>
        kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS ? "absent" : "observed",
    })
    const firstSigner = createSignerHarness({ log: firstExecution.log })
    const firstReviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(inboxChangedRoles())
    )
    const firstResult = await publishAccountNetworkMutation({
      reviewed: firstReviewed,
      signer: firstSigner.signer,
      dependencies: firstExecution.dependencies,
    })
    const afterFirst = await firstExecution.baseRepository.get(ACCOUNT)
    const pendingB = afterFirst.inboxDeclaration?.pendingDistribution
    expect(firstResult.checkpoints[0]?.pending).toBe(true)
    expect(pendingB?.signedEvent.tags).toEqual([["relay", INBOX_B]])
    if (!pendingB)
      throw new Error("Expected the B replacement to remain pending")

    const secondFixture = {
      ...fixture,
      snapshot: afterFirst,
      reconciliation: {
        ...structuredClone(fixture.reconciliation),
        inboxDeclaration: {
          pubkey: ACCOUNT,
          state: "distribution_pending" as const,
          relayUrls: [],
          retainedReadRelayUrls: [INBOX_A],
          cutoverRecoveryRelayUrls: [INBOX_A],
          stale: false,
          fetchedAt: MUTATION_AT,
          eventId: pendingB.signedEvent.id,
          eventCreatedAt: pendingB.signedEvent.created_at,
          sourceRelayUrls: [],
          sharedSourceRelayUrls: [],
          pendingRelayUrls: [INBOX_B],
          pendingPublishRelayUrls: [...pendingB.publishRelayUrls],
          pendingRelayOutcomes: structuredClone(pendingB.relayOutcomes),
          observation: {
            coverage: "complete" as const,
            attemptedRelayUrls: [PLAN_A],
            successfulRelayUrls: [PLAN_A],
            failedRelayUrls: [],
            eventId: pendingB.signedEvent.id,
            eventSourceRelayUrls: [],
          },
        },
      },
    }
    const rolesForC = inboxChangedRoles().map((relay) =>
      relay.url === INBOX_B ? { ...relay, url: INBOX_C } : relay
    )
    const secondReviewed = reviewAccountNetworkMutation(
      secondFixture.reconciliation,
      action(rolesForC)
    )
    expect(secondReviewed.previousInboxRelayUrls).toEqual([INBOX_B])

    const secondExecution = createExecutionHarness(secondFixture, {
      initialSnapshot: afterFirst,
    })
    const secondSigner = createSignerHarness({ log: secondExecution.log })
    const secondResult = await publishAccountNetworkMutation({
      reviewed: secondReviewed,
      signer: secondSigner.signer,
      dependencies: secondExecution.dependencies,
    })
    const afterSecond = await secondExecution.baseRepository.get(ACCOUNT)
    const replacementC = secondResult.checkpoints[0]?.signedEvent
    if (!replacementC) throw new Error("Expected the C replacement checkpoint")
    const firstBatch = afterSecond.inboxDeclaration?.cutoverRecoveries?.find(
      (recovery) => recovery.replacementEventId === pendingB.signedEvent.id
    )
    const secondBatch = afterSecond.inboxDeclaration?.cutoverRecoveries?.find(
      (recovery) => recovery.replacementEventId === replacementC.id
    )

    expect(firstBatch).toMatchObject({
      relayUrls: [INBOX_A],
      confirmationAttempts: [
        expect.objectContaining({ completedRelayUrls: [PLAN_A] }),
      ],
    })
    expect(
      firstBatch?.confirmationAttempts?.[0]?.observedRelayUrls
    ).toBeUndefined()
    expect(firstBatch?.readbackObservedAt).toBeUndefined()
    expect(secondBatch).toMatchObject({
      relayUrls: [INBOX_B],
      confirmationAttempts: [
        expect.objectContaining({ observedRelayUrls: [PLAN_A] }),
      ],
      readbackObservedAt: MUTATION_AT,
      expiresAt: MUTATION_AT + INBOX_DECLARATION_CUTOVER_GRACE_MS,
    })
    expect(
      afterSecond.inboxDeclaration?.cutoverRecoveries?.filter((recovery) =>
        recovery.relayUrls.includes(INBOX_A)
      )
    ).toHaveLength(1)
  })

  it("honors a rotated pending plan before durably restaging current shared targets", async () => {
    const fixture = createFixture()
    const stagedInbox = applyInboxDeclarationDistributionStage(
      fixture.snapshot.inboxDeclaration,
      {
        pubkey: ACCOUNT,
        signedEvent: fixture.inboxEvent,
        publishRelayUrls: [PLAN_A],
        confirmationRelayUrls: [PLAN_A],
        relayOutcomes: [
          {
            relayUrl: PLAN_A,
            publishStatus: "pending",
            publishAttemptCount: 0,
            readbackStatus: "pending",
            readbackAttemptCount: 0,
          },
        ],
        previousRelayUrls: [INBOX_C],
        cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
        expectedCurrentEventId: fixture.inboxEvent.id,
        stagedAt: OBSERVED_AT + 1,
      }
    )
    const initialSnapshot = {
      ...fixture.snapshot,
      inboxDeclaration: stagedInbox,
    }
    const execution = createExecutionHarness(fixture, {
      initialSnapshot,
      planForKind: () => [PLAN_B],
    })

    await redistributeAccountNetworkInboxDeclaration({
      pubkey: ACCOUNT,
      dependencies: execution.dependencies,
    })

    expect(execution.publishCalls.map((call) => call.relayUrl)).toEqual([
      PLAN_A,
      PLAN_B,
    ])
    expect(execution.readbackCalls.map((call) => call.relayUrl)).toEqual([
      PLAN_A,
      PLAN_B,
    ])
    expect(execution.restageInputs).toEqual([
      expect.objectContaining({
        signedEvent: fixture.inboxEvent,
        expectedPublishRelayUrls: [PLAN_A],
        publishRelayUrls: [PLAN_B],
      }),
    ])
    expect(execution.log.indexOf(`readback:10050:${PLAN_A}`)).toBeLessThan(
      execution.log.indexOf("restage:committed")
    )
    expect(execution.log.indexOf("restage:committed")).toBeLessThan(
      execution.log.indexOf(`publish:10050:${PLAN_B}`)
    )
    expect(
      execution.publishCalls.every(
        (call) => call.signedEvent.id === fixture.inboxEvent.id
      )
    ).toBe(true)
  })

  it("filters a concurrent whole removal only from the new immutable recovery attempt", async () => {
    const fixture = createFixture()
    const stagedInbox = applyInboxDeclarationDistributionStage(
      fixture.snapshot.inboxDeclaration,
      {
        pubkey: ACCOUNT,
        signedEvent: fixture.inboxEvent,
        publishRelayUrls: [PLAN_A],
        confirmationRelayUrls: [PLAN_A],
        relayOutcomes: [
          {
            relayUrl: PLAN_A,
            publishStatus: "pending",
            publishAttemptCount: 0,
            readbackStatus: "pending",
            readbackAttemptCount: 0,
          },
        ],
        previousRelayUrls: [INBOX_C],
        cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
        expectedCurrentEventId: fixture.inboxEvent.id,
        stagedAt: OBSERVED_AT + 1,
      }
    )
    const execution = createExecutionHarness(fixture, {
      initialSnapshot: {
        ...fixture.snapshot,
        inboxDeclaration: stagedInbox,
      },
      planForKind: () => [PLAN_B, RELAY_A],
      publishBehavior: ({ relayUrl }) =>
        relayUrl === PLAN_A ? "timed_out" : "acked",
      readbackBehavior: ({ relayUrl }) =>
        relayUrl === PLAN_A ? "timed_out" : "observed",
      beforeRestage: async (repository) => {
        await repository.stage({
          pubkey: ACCOUNT,
          expectedRelayListEventId: fixture.ownerEvent.id,
          expectedInboxDeclarationEventId: fixture.inboxEvent.id,
          expectedExcludedRelayUrls: [],
          checkpoints: [],
          previousInboxRelayUrls: [],
          removedRelayUrls: [PLAN_B],
          stagedAt: MUTATION_AT - 1,
        })
      },
    })

    const result = await redistributeAccountNetworkInboxDeclaration({
      pubkey: ACCOUNT,
      dependencies: execution.dependencies,
    })
    const retained = await execution.baseRepository.get(ACCOUNT)
    const recovery = retained.inboxDeclaration?.cutoverRecoveries?.[0]

    expect(result.checkpoints[0]?.pending).toBe(false)
    expect(execution.restageInputs).toEqual([
      expect.objectContaining({
        expectedPublishRelayUrls: [PLAN_A],
        publishRelayUrls: [RELAY_A, PLAN_B],
      }),
    ])
    expect(execution.publishCalls.map((call) => call.relayUrl)).toEqual([
      PLAN_A,
      RELAY_A,
    ])
    expect(execution.readbackCalls.map((call) => call.relayUrl)).toEqual([
      PLAN_A,
      RELAY_A,
    ])
    expect(recovery?.confirmationAttempts).toEqual([
      {
        relayUrls: [PLAN_A],
        stagedAt: OBSERVED_AT + 1,
      },
      {
        relayUrls: [RELAY_A],
        completedRelayUrls: [RELAY_A],
        observedRelayUrls: [RELAY_A],
        stagedAt: MUTATION_AT,
      },
    ])
    expect(
      recovery?.confirmationAttempts?.some((attempt) =>
        attempt.relayUrls.includes(PLAN_B)
      )
    ).toBe(false)
    expect(retained.localState.exclusions).toEqual([
      expect.objectContaining({ relayUrl: PLAN_B }),
    ])
  })

  it("leaves the prior recovery attempt untouched when concurrent exclusions remove every restage target", async () => {
    const fixture = createFixture()
    const stagedInbox = applyInboxDeclarationDistributionStage(
      fixture.snapshot.inboxDeclaration,
      {
        pubkey: ACCOUNT,
        signedEvent: fixture.inboxEvent,
        publishRelayUrls: [PLAN_A],
        confirmationRelayUrls: [PLAN_A],
        relayOutcomes: [
          {
            relayUrl: PLAN_A,
            publishStatus: "pending",
            publishAttemptCount: 0,
            readbackStatus: "pending",
            readbackAttemptCount: 0,
          },
        ],
        previousRelayUrls: [INBOX_C],
        cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
        expectedCurrentEventId: fixture.inboxEvent.id,
        stagedAt: OBSERVED_AT + 1,
      }
    )
    const repository = createInMemoryAccountNetworkMutationRepository([
      {
        pubkey: ACCOUNT,
        snapshot: {
          ...fixture.snapshot,
          inboxDeclaration: stagedInbox,
        },
      },
    ])
    await repository.stage({
      pubkey: ACCOUNT,
      expectedRelayListEventId: fixture.ownerEvent.id,
      expectedInboxDeclarationEventId: fixture.inboxEvent.id,
      expectedExcludedRelayUrls: [],
      checkpoints: [],
      previousInboxRelayUrls: [],
      removedRelayUrls: [PLAN_B],
      stagedAt: MUTATION_AT - 1,
    })
    const before = await repository.get(ACCOUNT)

    await expect(
      repository.restageInboxDistribution({
        pubkey: ACCOUNT,
        signedEvent: fixture.inboxEvent,
        expectedPublishRelayUrls: [PLAN_A],
        publishRelayUrls: [PLAN_B],
        stagedAt: MUTATION_AT,
      })
    ).rejects.toMatchObject({ code: "no_publish_targets" })

    const retained = await repository.get(ACCOUNT)
    expect(retained.inboxDeclaration).toEqual(before.inboxDeclaration)
    expect(
      retained.inboxDeclaration?.cutoverRecoveries?.[0]?.confirmationAttempts
    ).toEqual([
      {
        relayUrls: [PLAN_A],
        stagedAt: OBSERVED_AT + 1,
      },
    ])
    expect(retained.localState.exclusions).toEqual([
      expect.objectContaining({ relayUrl: PLAN_B }),
    ])
  })

  it("recovers a dead old plan through a fresh immutable shared attempt", async () => {
    const fixture = createFixture()
    const stagedInbox = applyInboxDeclarationDistributionStage(
      fixture.snapshot.inboxDeclaration,
      {
        pubkey: ACCOUNT,
        signedEvent: fixture.inboxEvent,
        publishRelayUrls: [PLAN_A],
        confirmationRelayUrls: [PLAN_A],
        relayOutcomes: [
          {
            relayUrl: PLAN_A,
            publishStatus: "pending",
            publishAttemptCount: 0,
            readbackStatus: "pending",
            readbackAttemptCount: 0,
          },
        ],
        previousRelayUrls: [INBOX_C],
        cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
        expectedCurrentEventId: fixture.inboxEvent.id,
        stagedAt: OBSERVED_AT + 1,
      }
    )
    const execution = createExecutionHarness(fixture, {
      initialSnapshot: {
        ...fixture.snapshot,
        inboxDeclaration: stagedInbox,
      },
      planForKind: () => [PLAN_B],
      publishBehavior: ({ relayUrl }) =>
        relayUrl === PLAN_A ? "throw" : "acked",
      readbackBehavior: ({ relayUrl }) =>
        relayUrl === PLAN_A ? "timed_out" : "observed",
    })

    const result = await redistributeAccountNetworkInboxDeclaration({
      pubkey: ACCOUNT,
      dependencies: execution.dependencies,
    })
    const retained = await execution.baseRepository.get(ACCOUNT)
    const recovery = retained.inboxDeclaration?.cutoverRecoveries?.[0]

    expect(result.checkpoints[0]?.pending).toBe(false)
    expect(execution.publishCalls.map((call) => call.relayUrl)).toEqual([
      PLAN_A,
      PLAN_B,
    ])
    expect(recovery?.confirmationAttempts).toEqual([
      {
        relayUrls: [PLAN_A],
        stagedAt: OBSERVED_AT + 1,
      },
      {
        relayUrls: [PLAN_B],
        completedRelayUrls: [PLAN_B],
        observedRelayUrls: [PLAN_B],
        stagedAt: MUTATION_AT,
      },
    ])
    expect(recovery?.readbackObservedAt).toBe(MUTATION_AT)
    expect(recovery?.expiresAt).toBe(
      MUTATION_AT + INBOX_DECLARATION_CUTOVER_GRACE_MS
    )
    expect(execution.restageInputs[0]?.signedEvent).toEqual(fixture.inboxEvent)
  })

  it("redistributes the exact retained inbox declaration without a signer", async () => {
    const fixture = createFixture()
    const execution = createExecutionHarness(fixture, {
      planForKind: () => [PLAN_A, PLAN_B],
    })

    const result = await redistributeAccountNetworkInboxDeclaration({
      pubkey: ACCOUNT,
      dependencies: execution.dependencies,
    })

    expect(execution.log.indexOf("restage:committed")).toBeLessThan(
      execution.log.indexOf(
        `publish:${EVENT_KINDS.PRIVATE_MESSAGE_RELAYS}:${PLAN_A}`
      )
    )
    expect(execution.publishCalls).toHaveLength(2)
    expect(
      execution.publishCalls.every(
        (call) => call.signedEvent.id === fixture.inboxEvent.id
      )
    ).toBe(true)
    expect(result.checkpoints[0]).toMatchObject({
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      pending: false,
      signedEvent: fixture.inboxEvent,
    })
  })

  it("owns signer-free local order and capability evidence without changing roles", async () => {
    const repository = createInMemoryAccountNetworkLocalStateRepository(
      [],
      () => 1
    )
    await reorderAccountNetworkRelays({
      pubkey: ACCOUNT,
      relayUrls: [RELAY_B, RELAY_A],
      dependencies: { repository, now: () => MUTATION_AT },
    })
    await recordAccountNetworkRelayScans({
      pubkey: ACCOUNT,
      relayScans: [],
      dependencies: { repository, now: () => MUTATION_AT + 1 },
    })

    expect(
      (
        await orderEquivalentAccountRelayOperations({
          accountPubkey: ACCOUNT,
          repository,
          operations: [
            { relayUrl: RELAY_A, equivalenceKey: "read", value: RELAY_A },
            { relayUrl: RELAY_B, equivalenceKey: "read", value: RELAY_B },
          ],
        })
      ).map((operation) => operation.value)
    ).toEqual([RELAY_B, RELAY_A])
    expect((await repository.get(ACCOUNT))?.relayScans).toEqual([])
  })

  it("commits a signer-free whole removal and immediately excludes its recovery relay", async () => {
    const removedRelayUrl = INBOX_B
    const fixture = createFixture({
      cutoverRecoveryRelayUrls: [removedRelayUrl],
    })
    const execution = createExecutionHarness(fixture)
    const prunedLegacyRecoveryUrls: string[][] = []
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(baselineRoles(), [removedRelayUrl])
    )

    expect(reviewed.changedKinds).toEqual([])
    expect(reviewed.signerRequestCount).toBe(0)
    const result = await publishAccountNetworkMutation({
      reviewed,
      dependencies: {
        ...execution.dependencies,
        removeLegacyReadRecoveryRelayUrls: (input) => {
          prunedLegacyRecoveryUrls.push([...input.relayUrls])
          return "updated"
        },
      },
    })
    const retained = await execution.baseRepository.get(ACCOUNT)

    expect(result).toMatchObject({
      status: "staged",
      checkpoints: [],
      localStateChanged: true,
      legacyRecoveryRemoval: "updated",
    })
    expect(prunedLegacyRecoveryUrls).toEqual([[removedRelayUrl]])
    expect(execution.publishCalls).toHaveLength(0)
    expect(execution.readbackCalls).toHaveLength(0)
    expect(retained.inboxDeclaration?.cutoverRecoveries).toEqual([
      expect.objectContaining({
        relayUrls: [removedRelayUrl],
        policyBlockedRelayUrls: [removedRelayUrl],
      }),
    ])
    expect(retained.localState.exclusions).toEqual([
      expect.objectContaining({ relayUrl: removedRelayUrl }),
    ])

    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository([retained.localState])
    expect(
      await filterEligibleAccountRelayUrls({
        accountPubkey: ACCOUNT,
        candidateRelayUrls: [removedRelayUrl, RELAY_A],
        repository: localStateRepository,
      })
    ).toEqual([RELAY_A])
  })

  it("aborts on stale review evidence and on a changed durable frontier", async () => {
    const fixture = createFixture()
    const requestedAction = action(ownerChangedRoles())
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      requestedAction
    )
    const changed = createFixture({ ownerCreatedAt: 102 })

    const staleExecution = createExecutionHarness(fixture)
    staleExecution.dependencies.reconcile = async () =>
      structuredClone(changed.reconciliation)
    const staleSigner = createSignerHarness({ log: staleExecution.log })
    await expect(
      publishAccountNetworkMutation({
        reviewed,
        signer: staleSigner.signer,
        dependencies: staleExecution.dependencies,
      })
    ).rejects.toMatchObject({ code: "evidence_changed" })
    expect(staleSigner.signedDrafts).toHaveLength(0)
    expect(staleExecution.log).not.toContain("stage:start")
    expect(staleExecution.publishCalls).toHaveLength(0)

    __resetAccountNetworkMutationLocksForTests()
    const frontierExecution = createExecutionHarness(fixture, {
      initialSnapshot: changed.snapshot,
    })
    const durableBefore = await frontierExecution.baseRepository.get(ACCOUNT)
    const frontierSigner = createSignerHarness({ log: frontierExecution.log })
    await expect(
      publishAccountNetworkMutation({
        reviewed,
        signer: frontierSigner.signer,
        dependencies: frontierExecution.dependencies,
      })
    ).rejects.toMatchObject({ code: "evidence_changed" })
    expect(frontierSigner.signedDrafts).toHaveLength(1)
    expect(frontierExecution.log).toContain("stage:start")
    expect(frontierExecution.log).not.toContain("stage:committed")
    expect(frontierExecution.publishCalls).toHaveLength(0)
    expect(await frontierExecution.baseRepository.get(ACCOUNT)).toEqual(
      durableBefore
    )
  })

  it("rejects a stale review after a concurrent whole-relay removal before signer access", async () => {
    const fixture = createFixture()
    const reviewed = reviewAccountNetworkMutation(
      fixture.reconciliation,
      action(ownerChangedRoles())
    )
    const concurrentSnapshot = structuredClone(fixture.snapshot)
    concurrentSnapshot.localState = applyAccountNetworkRelayExclusion(
      concurrentSnapshot.localState,
      {
        relayUrl: RELAY_A,
        relayListFrontier: {
          eventId: fixture.ownerEvent.id,
          createdAt: fixture.ownerEvent.created_at,
        },
        inboxDeclarationFrontier: {
          eventId: fixture.inboxEvent.id,
          createdAt: fixture.inboxEvent.created_at,
        },
        committedAt: MUTATION_AT - 1,
      }
    )
    const execution = createExecutionHarness(fixture, {
      initialSnapshot: concurrentSnapshot,
    })
    const signer = createSignerHarness({ log: execution.log })

    await expect(
      publishAccountNetworkMutation({
        reviewed,
        signer: signer.signer,
        dependencies: execution.dependencies,
      })
    ).rejects.toMatchObject({ code: "evidence_changed" })

    expect(signer.getPublicKeyCalls).toBe(0)
    expect(signer.signedDrafts).toHaveLength(0)
    expect(execution.log).not.toContain("stage:start")
    expect(execution.publishCalls).toHaveLength(0)
    expect(execution.readbackCalls).toHaveLength(0)
    expect(
      (await execution.baseRepository.get(ACCOUNT)).localState.exclusions
    ).toEqual([expect.objectContaining({ relayUrl: RELAY_A })])
  })
})
