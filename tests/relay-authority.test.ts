import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { config } from "@conduit/core/config"
import {
  createInMemoryAccountNetworkLocalStateRepository,
  filterEligibleAccountRelayTargets,
} from "@conduit/core/protocol/account-network-local-state"
import { setAccountNetworkRoutingSourceEnabled } from "@conduit/core/protocol/account-network-routing-policy"
import {
  mergeRelayTargets,
  relayTargetsFromUrls,
  selectRelayTargets,
} from "@conduit/core/protocol/relay-authority"
import {
  __resetOwnerRelayListEvidenceForTests,
  createInMemoryOwnerRelayListEvidenceRepository,
  readRetainedOwnerRelayList,
  reconcileOwnerRelayListEvidence,
} from "@conduit/core/protocol/owner-relay-list-evidence"
import { createInMemoryInboxDeclarationEvidenceRepository } from "@conduit/core/protocol/inbox-declaration-evidence"
import {
  __resetInboxDeclarationCache,
  primeInboxDeclarationEvidence,
  readRetainedInboxDeclarationEvidence,
} from "@conduit/core/protocol/private-message-routing"
import {
  planRelayReads,
  planRelayWrites,
} from "@conduit/core/protocol/relay-planner"
import {
  __resetPublicReaderTestState,
  fetchSignedEventsFanoutDetailed,
} from "@conduit/core/protocol/relay-reader"
import {
  __resetRelayPublishTestOverrides,
  __setRelayPublishTestOverrides,
  publishSignedEventToRelay,
} from "@conduit/core/protocol/relay-publish"
import { admitFixture } from "./helpers/public-event"

const secret = generateSecretKey()
const owner = getPublicKey(secret)
const other = getPublicKey(generateSecretKey())
const ownerWs = "ws://owner-selected.example"
const appRelay = config.appReadRelayUrls[0]!

afterEach(() => {
  __resetPublicReaderTestState()
  __resetRelayPublishTestOverrides()
  __resetOwnerRelayListEvidenceForTests()
  __resetInboxDeclarationCache()
})

async function signedOwnerSelection() {
  return await admitFixture(
    finalizeEvent(
      {
        kind: 10002,
        created_at: 1_700_000_000,
        tags: [["r", ownerWs]],
        content: "",
      },
      secret
    )
  )
}

async function signedOverlapSelection() {
  return await admitFixture(
    finalizeEvent(
      {
        kind: 10002,
        created_at: 1_700_000_001,
        tags: [["r", appRelay]],
        content: "",
      },
      secret
    )
  )
}

describe("relay authority", () => {
  it("selects normalized operation order without losing independent grants or granting a URL", () => {
    const source = "wss://source.example"
    const targets = [
      ...relayTargetsFromUrls([appRelay], {
        kind: "app",
        operation: "read",
        bucket: "general_read",
      }),
      ...relayTargetsFromUrls([source], {
        kind: "public_hint",
        operation: "read",
      }),
      ...relayTargetsFromUrls([`${appRelay}/`], {
        kind: "owner_nip65",
        operation: "read",
        ownerPubkey: owner,
        selection: "read",
      }),
    ]
    const selected = selectRelayTargets(targets, [
      source,
      `${appRelay}/`,
      appRelay,
      "wss://ungranted.example",
    ])
    expect(selected.map((target) => target.url)).toEqual([source, appRelay])
    expect(selected[1]?.grants.map((grant) => grant.kind)).toEqual([
      "app",
      "owner_nip65",
    ])
    expect(selectRelayTargets(targets, [])).toEqual([])
    expect(selectRelayTargets(targets).map((target) => target.url)).toEqual([
      appRelay,
      source,
    ])
  })

  it("keeps per-source grants when the planner deduplicates a shared URL", () => {
    const relayLists = new Map([
      [
        other,
        {
          pubkey: other,
          readRelayUrls: [appRelay],
          writeRelayUrls: [appRelay],
          eventCreatedAt: 1,
          cachedAt: 1,
        },
      ],
    ])
    const reads = planRelayReads({
      intent: "general",
      authors: [other],
      relayLists,
      maxRelays: 20,
      skipHealthFilter: true,
    })
    expect(
      reads.relayTargets
        .find((target) => target.url === appRelay)
        ?.grants.map((grant) => grant.kind)
    ).toContain("app")
    expect(
      reads.relayTargets
        .find((target) => target.url === appRelay)
        ?.grants.map((grant) => grant.kind)
    ).toContain("remote_nip65")
    const writes = planRelayWrites({
      intent: "recipient_event",
      recipientPubkeys: [other],
      relayLists,
      skipHealthFilter: true,
    })
    expect(
      writes.primaryRelayTargets.find((target) => target.url === appRelay)
        ?.grants
    ).toEqual([{ kind: "remote_nip65", operation: "write", pubkey: other }])
  })

  it("preserves overlapping grants and applies the App switch only to the App grant", async () => {
    const state = createInMemoryAccountNetworkLocalStateRepository()
    const targets = mergeRelayTargets(
      relayTargetsFromUrls([appRelay], {
        kind: "app",
        operation: "read",
        bucket: "general_read",
      }),
      relayTargetsFromUrls([appRelay], {
        kind: "remote_nip65",
        operation: "read",
        pubkey: other,
      })
    )
    expect(targets).toHaveLength(1)
    expect(targets[0]?.grants).toHaveLength(2)
    expect(
      (
        await filterEligibleAccountRelayTargets({
          accountPubkey: owner,
          targets,
          operation: "read",
          repository: state,
        })
      )[0]?.grants
    ).toHaveLength(2)

    await state.updateRoutingPolicy(owner, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "app", false)
    )
    expect(
      (
        await filterEligibleAccountRelayTargets({
          accountPubkey: owner,
          targets,
          operation: "read",
          repository: state,
        })
      )[0]?.grants
    ).toEqual([{ kind: "remote_nip65", operation: "read", pubkey: other }])
  })

  it("keeps an overlapping App and owner target alive through either single-layer switch, then honors whole removal", async () => {
    const event = await signedOverlapSelection()
    const evidence = createInMemoryOwnerRelayListEvidenceRepository()
    await evidence.reconcile({
      pubkey: owner,
      observations: [{ signedEvent: event }],
      lookup: {
        observedAt: Date.now(),
        coverage: "complete",
        hadEvent: true,
        eventId: event.id,
      },
    })
    const state = createInMemoryAccountNetworkLocalStateRepository()
    const targets = mergeRelayTargets(
      relayTargetsFromUrls([appRelay], {
        kind: "app",
        operation: "read",
        bucket: "general_read",
      }),
      relayTargetsFromUrls([appRelay], {
        kind: "owner_nip65",
        operation: "read",
        ownerPubkey: owner,
        selection: "read",
      })
    )
    const admitted = async () =>
      await filterEligibleAccountRelayTargets({
        accountPubkey: owner,
        authenticatedPubkey: owner,
        targets,
        operation: "read",
        repository: state,
        ownerRelayListEvidenceRepository: evidence,
      })
    expect((await admitted())[0]?.grants).toHaveLength(2)
    await state.updateRoutingPolicy(owner, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "app", false)
    )
    expect((await admitted())[0]?.grants.map((grant) => grant.kind)).toEqual([
      "owner_nip65",
    ])
    await state.updateRoutingPolicy(owner, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "app", true)
    )
    await state.updateRoutingPolicy(owner, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "personal", false)
    )
    expect((await admitted())[0]?.grants.map((grant) => grant.kind)).toEqual([
      "app",
    ])
    await state.update(owner, (current) => ({
      ...current,
      exclusions: [
        {
          relayUrl: appRelay,
          committedAt: Date.now(),
          relayListFrontier: { eventId: null, createdAt: null },
          inboxDeclarationFrontier: { eventId: null, createdAt: null },
        },
      ],
    }))
    expect(await admitted()).toEqual([])
  })

  it("requires same-account signed selection for an owner ws target at the real reader boundary", async () => {
    const event = await signedOwnerSelection()
    const evidence = createInMemoryOwnerRelayListEvidenceRepository()
    await reconcileOwnerRelayListEvidence(
      {
        pubkey: owner,
        observations: [{ signedEvent: event }],
        lookup: {
          observedAt: Date.now(),
          coverage: "complete",
          hadEvent: true,
          eventId: event.id,
        },
      },
      evidence
    )
    const state = createInMemoryAccountNetworkLocalStateRepository()
    const targets = relayTargetsFromUrls([ownerWs], {
      kind: "owner_nip65",
      operation: "read",
      ownerPubkey: owner,
      selection: "read",
    })
    const opened: string[] = []
    class Socket {
      readyState = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null
      constructor(url: string) {
        opened.push(url)
        queueMicrotask(() => {
          this.readyState = 1
          this.onopen?.(new Event("open"))
        })
      }
      send(payload: string) {
        const frame = JSON.parse(payload) as unknown[]
        if (frame[0] === "REQ")
          queueMicrotask(() =>
            this.onmessage?.({
              data: JSON.stringify(["EOSE", frame[1]]),
            } as MessageEvent<string>)
          )
      }
      close() {
        this.readyState = 3
      }
    }
    const options = {
      accountPubkey: owner,
      relayTargets: targets,
      accountNetworkLocalStateRepository: state,
      ownerRelayListEvidenceRepository: evidence,
      socketScope: { createWebSocket: (url: string) => new Socket(url) },
      reuseRelayConnections: false,
      skipHealthFilter: true,
      connectTimeoutMs: 50,
      fetchTimeoutMs: 50,
    }
    await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      {
        ...options,
        authenticatedPubkey: other,
      }
    )
    expect(opened).toEqual([])
    await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      {
        ...options,
        authenticatedPubkey: owner,
      }
    )
    expect(opened).toEqual([ownerWs])
    await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      {
        ...options,
        authenticatedPubkey: owner,
        ownerRelayListEvidenceRepository: {
          get: async () => {
            throw new Error("verifier unavailable")
          },
        },
      }
    )
    expect(opened).toEqual([ownerWs, ownerWs])
    await state.updateRoutingPolicy(owner, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "personal", false)
    )
    await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      {
        ...options,
        authenticatedPubkey: owner,
      }
    )
    expect(opened).toEqual([ownerWs, ownerWs])
  })

  it("rejects an exact owner ws publish with naked URL authority and admits its signed grant", async () => {
    const event = await signedOwnerSelection()
    const evidence = createInMemoryOwnerRelayListEvidenceRepository()
    await evidence.reconcile({
      pubkey: owner,
      observations: [{ signedEvent: event }],
      lookup: {
        observedAt: Date.now(),
        coverage: "complete",
        hadEvent: true,
        eventId: event.id,
      },
    })
    const state = createInMemoryAccountNetworkLocalStateRepository()
    const writes: string[] = []
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async ({ relayUrl }) => {
        writes.push(relayUrl)
        return "acked"
      },
    })
    const base = {
      relayUrl: ownerWs,
      signedEvent: event,
      authorPubkey: owner,
      accountPubkey: owner,
      authenticatedPubkey: owner,
      accountNetworkLocalStateRepository: state,
      ownerRelayListEvidenceRepository: evidence,
    }
    await expect(
      publishSignedEventToRelay({
        ...base,
        ownerSelectedRelayUrls: [ownerWs],
      })
    ).rejects.toThrow()
    expect(writes).toEqual([])
    await expect(
      publishSignedEventToRelay({
        ...base,
        relayTarget: {
          url: ownerWs,
          grants: [
            {
              kind: "owner_selection",
              operation: "write",
              ownerPubkey: owner,
              eventKind: 10002,
              eventId: event.id,
            },
          ],
        },
      })
    ).resolves.toBe("acked")
    expect(writes).toEqual([ownerWs])
  })

  it("uses only admitted same-account owner evidence when durable verification is unavailable", async () => {
    const event = await signedOwnerSelection()
    const repository = createInMemoryOwnerRelayListEvidenceRepository()
    await reconcileOwnerRelayListEvidence(
      {
        pubkey: owner,
        observations: [{ signedEvent: event }],
        lookup: {
          observedAt: Date.now(),
          coverage: "complete",
          hadEvent: true,
          eventId: event.id,
        },
      },
      repository
    )
    const state = createInMemoryAccountNetworkLocalStateRepository()
    const target = relayTargetsFromUrls([ownerWs], {
      kind: "owner_nip65",
      operation: "read",
      ownerPubkey: owner,
      selection: "read",
    })
    const unavailable = {
      get: async () => {
        throw new Error("verification unavailable")
      },
    }
    const admitted = async (
      pubkey: string,
      evidenceRepository: typeof unavailable | typeof repository
    ) =>
      await filterEligibleAccountRelayTargets({
        accountPubkey: pubkey,
        authenticatedPubkey: pubkey,
        targets: relayTargetsFromUrls([ownerWs], {
          kind: "owner_nip65",
          operation: "read",
          ownerPubkey: pubkey,
          selection: "read",
        }),
        operation: "read",
        repository: state,
        ownerRelayListEvidenceRepository: evidenceRepository,
      })
    expect(await admitted(owner, unavailable)).toEqual(target)
    expect(await admitted(other, unavailable)).toEqual([])
    await expect(
      readRetainedOwnerRelayList(other, {
        durableOnly: true,
        durableEvidenceRepository: unavailable,
      })
    ).rejects.toThrow("verification unavailable")

    const empty = await admitFixture(
      finalizeEvent(
        {
          kind: 10002,
          created_at: event.created_at + 1,
          tags: [],
          content: "",
        },
        secret
      )
    )
    await repository.reconcile({
      pubkey: owner,
      observations: [{ signedEvent: empty }],
      lookup: {
        observedAt: Date.now(),
        coverage: "complete",
        hadEvent: true,
        eventId: empty.id,
      },
    })
    expect(await admitted(owner, repository)).toEqual([])
  })

  it("retains admitted inbox and recipient grants through storage outage but honors readable signed empty", async () => {
    const inboxUrl = "wss://owner-inbox-fallback.example"
    const event = await admitFixture(
      finalizeEvent(
        {
          kind: 10050,
          created_at: 1_700_000_100,
          tags: [["relay", inboxUrl]],
          content: "",
        },
        secret
      )
    )
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const record = await repository.merge({
      pubkey: owner,
      signedEvent: event,
      observedAt: Date.now(),
    })
    primeInboxDeclarationEvidence(record)
    const state = createInMemoryAccountNetworkLocalStateRepository()
    const unavailable = {
      get: async () => {
        throw new Error("storage unavailable")
      },
    }
    const ownerTarget = relayTargetsFromUrls([inboxUrl], {
      kind: "owner_nip17",
      operation: "read",
      ownerPubkey: owner,
    })
    const recipientTarget = relayTargetsFromUrls([inboxUrl], {
      kind: "recipient_nip17",
      operation: "write",
      recipientPubkey: owner,
      eventId: event.id,
    })
    const admitted = async (
      targets: typeof ownerTarget,
      operation: "read" | "write",
      evidenceRepository: typeof unavailable | typeof repository
    ) =>
      await filterEligibleAccountRelayTargets({
        accountPubkey: owner,
        authenticatedPubkey: owner,
        targets,
        operation,
        repository: state,
        inboxDeclarationEvidenceRepository: evidenceRepository,
      })
    expect(await admitted(ownerTarget, "read", unavailable)).toEqual(
      ownerTarget
    )
    expect(await admitted(recipientTarget, "write", unavailable)).toEqual(
      recipientTarget
    )
    expect(
      await admitted(
        relayTargetsFromUrls([inboxUrl], {
          kind: "recipient_nip17",
          operation: "write",
          recipientPubkey: owner,
          eventId: "f".repeat(64),
        }),
        "write",
        unavailable
      )
    ).toEqual([])
    await expect(
      readRetainedInboxDeclarationEvidence(other, {
        durableEvidenceRepository: unavailable,
      })
    ).rejects.toThrow("storage unavailable")
    expect(
      await filterEligibleAccountRelayTargets({
        accountPubkey: other,
        authenticatedPubkey: other,
        targets: relayTargetsFromUrls([inboxUrl], {
          kind: "owner_nip17",
          operation: "read",
          ownerPubkey: other,
        }),
        operation: "read",
        repository: state,
        inboxDeclarationEvidenceRepository: unavailable,
      })
    ).toEqual([])

    const empty = await admitFixture(
      finalizeEvent(
        {
          kind: 10050,
          created_at: event.created_at + 1,
          tags: [],
          content: "",
        },
        secret
      )
    )
    await repository.merge({
      pubkey: owner,
      signedEvent: empty,
      observedAt: Date.now(),
    })
    expect(await admitted(ownerTarget, "read", repository)).toEqual([])
    expect(await admitted(recipientTarget, "write", repository)).toEqual([])
  })
})
