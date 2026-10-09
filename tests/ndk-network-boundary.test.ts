import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { config } from "../packages/core/src/config"
import {
  mergeRelayTargets,
  relayTargetsFromUrls,
} from "../packages/core/src/protocol/relay-authority"
import { createInMemoryOwnerRelayListEvidenceRepository } from "../packages/core/src/protocol/owner-relay-list-evidence"
import { admitFixture } from "./helpers/public-event"
import {
  __resetPublicReaderTestState,
  fetchSignedEventsFanoutDetailed,
} from "../packages/core/src/protocol/relay-reader"
import {
  emptyAccountNetworkLocalState,
  type AccountNetworkLocalStateRepository,
} from "../packages/core/src/protocol/account-network-local-state"
import { createDefaultAccountNetworkRoutingPolicy } from "../packages/core/src/protocol/account-network-routing-policy"

const ACCOUNT_A_SECRET = generateSecretKey()
const ACCOUNT_A = getPublicKey(ACCOUNT_A_SECRET)
const ACCOUNT_B = "b".repeat(64)

const publicTargets = (relayUrls: readonly string[]) =>
  relayTargetsFromUrls(relayUrls, { kind: "public_hint", operation: "read" })

async function ownerReadEvidence(relayUrls: readonly string[]) {
  const repository = createInMemoryOwnerRelayListEvidenceRepository()
  const signedEvent = await admitFixture(
    finalizeEvent(
      {
        kind: 10002,
        created_at: 100,
        tags: relayUrls.map((url) => ["r", url, "read"]),
        content: "",
      },
      ACCOUNT_A_SECRET
    )
  )
  await repository.reconcile({
    pubkey: ACCOUNT_A,
    observations: [{ signedEvent }],
    lookup: {
      observedAt: 100,
      coverage: "complete",
      hadEvent: true,
      eventId: signedEvent.id,
    },
  })
  return repository
}

const ownerTargets = (relayUrls: readonly string[]) =>
  relayTargetsFromUrls(relayUrls, {
    kind: "owner_nip65",
    operation: "read",
    ownerPubkey: ACCOUNT_A,
    selection: "read",
  })

function accountNetworkState(
  pubkey: string,
  excludedRelayUrls: readonly string[],
  preferredRelayOrder: readonly string[] = []
) {
  const state = emptyAccountNetworkLocalState(pubkey)
  return {
    ...state,
    exclusions: excludedRelayUrls.map((relayUrl, index) => ({
      relayUrl,
      committedAt: 1_700_000_000_000 + index,
      relayListFrontier: { eventId: null, createdAt: null },
      inboxDeclarationFrontier: { eventId: null, createdAt: null },
    })),
    preferredRelayOrder: [...preferredRelayOrder],
  }
}

function installEoseWebSocket(options: { deferEose?: boolean } = {}): {
  openedUrls: string[]
  waitForOpenedCount: (count: number) => Promise<void>
  releaseEose: () => void
  restore: () => void
} {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "WebSocket"
  )
  const openedUrls: string[] = []
  const openedWaiters: Array<{
    count: number
    resolve: () => void
  }> = []
  const pendingEose: Array<() => void> = []
  let deferEose = options.deferEose ?? false

  class EoseWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = EoseWebSocket.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null

    constructor(readonly url: string) {
      openedUrls.push(url)
      for (const waiter of openedWaiters.splice(0)) {
        if (openedUrls.length >= waiter.count) {
          waiter.resolve()
        } else {
          openedWaiters.push(waiter)
        }
      }
      queueMicrotask(() => {
        if (this.readyState !== EoseWebSocket.CONNECTING) return
        this.readyState = EoseWebSocket.OPEN
        this.onopen?.(new Event("open"))
      })
    }

    send(payload: string): void {
      const frame = JSON.parse(payload) as [string, string]
      if (frame[0] !== "REQ") return
      const emitEose = () => {
        if (this.readyState !== EoseWebSocket.OPEN) return
        this.onmessage?.({
          data: JSON.stringify(["EOSE", frame[1]]),
        } as MessageEvent<string>)
      }
      if (deferEose) {
        pendingEose.push(emitEose)
      } else {
        queueMicrotask(emitEose)
      }
    }

    close(): void {
      if (this.readyState === EoseWebSocket.CLOSED) return
      this.readyState = EoseWebSocket.CLOSED
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: EoseWebSocket,
  })

  return {
    openedUrls,
    waitForOpenedCount: (count) => {
      if (openedUrls.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => {
        openedWaiters.push({ count, resolve })
      })
    },
    releaseEose: () => {
      deferEose = false
      for (const emitEose of pendingEose.splice(0)) {
        queueMicrotask(emitEose)
      }
    },
    restore: () => {
      __resetPublicReaderTestState()
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "WebSocket", originalDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, "WebSocket")
      }
    },
  }
}

describe("NDK network boundary", () => {
  it("rechecks live owner authority after final policy reads before opening ws", async () => {
    const ownerWs = "ws://owner-session-race.example"
    const opened = installEoseWebSocket()
    let resolvePolicyRead: (() => void) | null = null
    let sessionCurrent = true
    const policyReadStarted = new Promise<void>((resolve) => {
      resolvePolicyRead = resolve
    })
    let releasePolicyRead: (() => void) | null = null
    const policyReadReleased = new Promise<void>((resolve) => {
      releasePolicyRead = resolve
    })
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        resolvePolicyRead?.()
        await policyReadReleased
        return accountNetworkState(pubkey, [])
      },
    }
    const ownerRelayListEvidenceRepository = await ownerReadEvidence([ownerWs])

    try {
      const read = fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [ownerWs],
          relayTargets: ownerTargets([ownerWs]),
          accountPubkey: ACCOUNT_A,
          authenticatedPubkey: ACCOUNT_A,
          ownerRelayListEvidenceRepository,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
          shouldContinue: () => sessionCurrent,
        }
      )

      await policyReadStarted
      sessionCurrent = false
      releasePolicyRead?.()

      await expect(read).rejects.toMatchObject({ code: "authority_changed" })
      expect(opened.openedUrls).toEqual([])
    } finally {
      opened.restore()
    }
  })

  it("rechecks live owner authority after a queued read reaches final admission", async () => {
    const blockerRelayUrls = Array.from(
      { length: 8 },
      (_, index) => `wss://queued-read-blocker-${index}.example`
    )
    const ownerWs = "ws://queued-owner-session-race.example"
    const opened = installEoseWebSocket({ deferEose: true })
    let sessionCurrent = true
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => accountNetworkState(pubkey, []),
    }
    const ownerRelayListEvidenceRepository = await ownerReadEvidence([ownerWs])

    try {
      const blockers = blockerRelayUrls.map((relayUrl) =>
        fetchSignedEventsFanoutDetailed(
          { kinds: [1] },
          {
            relayUrls: [relayUrl],
            reuseRelayConnections: false,
          }
        )
      )
      await opened.waitForOpenedCount(blockerRelayUrls.length)

      const queuedOwnerRead = fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [ownerWs],
          relayTargets: ownerTargets([ownerWs]),
          accountPubkey: ACCOUNT_A,
          authenticatedPubkey: ACCOUNT_A,
          ownerRelayListEvidenceRepository,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
          shouldContinue: () => sessionCurrent,
        }
      )

      sessionCurrent = false
      opened.releaseEose()

      await expect(queuedOwnerRead).rejects.toMatchObject({
        code: "authority_changed",
      })
      await Promise.all(blockers)
      expect(opened.openedUrls).toEqual(blockerRelayUrls)
    } finally {
      opened.releaseEose()
      opened.restore()
    }
  })

  it("opens owner-selected ws relays only with exact owner provenance", async () => {
    const ownerWs = "ws://owner-selected.example"
    const remoteWs = "ws://remote-derived.example"
    const opened = installEoseWebSocket()
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => accountNetworkState(pubkey, []),
    }
    const ownerRelayListEvidenceRepository = await ownerReadEvidence([ownerWs])

    try {
      const ownerRead = await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [ownerWs, remoteWs],
          relayTargets: ownerTargets([ownerWs, remoteWs]),
          accountPubkey: ACCOUNT_A,
          authenticatedPubkey: ACCOUNT_A,
          ownerRelayListEvidenceRepository,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )
      expect(ownerRead.relays.map(({ relayUrl }) => relayUrl)).toEqual([
        ownerWs,
      ])

      await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [ownerWs],
          relayTargets: ownerTargets([ownerWs]),
          accountPubkey: ACCOUNT_A,
          authenticatedPubkey: ACCOUNT_B,
          ownerRelayListEvidenceRepository,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )
      await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [ownerWs],
          relayTargets: ownerTargets([ownerWs]),
          accountPubkey: ACCOUNT_A,
          authenticatedPubkey: ACCOUNT_A,
          ownerRelayListEvidenceRepository,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )
      await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [ownerWs],
          relayTargets: ownerTargets([ownerWs]),
          reuseRelayConnections: false,
        }
      )

      const excludedRepository: Pick<
        AccountNetworkLocalStateRepository,
        "get"
      > = {
        get: async (pubkey) => accountNetworkState(pubkey, [ownerWs]),
      }
      await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [ownerWs],
          relayTargets: ownerTargets([ownerWs]),
          accountPubkey: ACCOUNT_A,
          authenticatedPubkey: ACCOUNT_A,
          ownerRelayListEvidenceRepository,
          accountNetworkLocalStateRepository: excludedRepository,
          reuseRelayConnections: false,
        }
      )
      await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [ownerWs],
          relayTargets: ownerTargets([ownerWs]),
          accountPubkey: ACCOUNT_A,
          authenticatedPubkey: ACCOUNT_A,
          ownerRelayListEvidenceRepository,
          accountNetworkLocalStateRepository: {
            get: async () => {
              throw new Error("durable policy unavailable")
            },
          },
          reuseRelayConnections: false,
        }
      )

      expect(opened.openedUrls).toEqual([ownerWs, ownerWs])
    } finally {
      opened.restore()
    }
  })

  it("keeps independent remote authority when its URL overlaps a disabled local source", async () => {
    const remoteOverlap = "wss://relay.ditto.pub"
    const appOnly = config.appReadRelayUrls.find(
      (url) => url !== remoteOverlap
    )!
    const opened = installEoseWebSocket()
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => ({
        ...accountNetworkState(pubkey, []),
        routingPolicy: {
          ...createDefaultAccountNetworkRoutingPolicy(),
          appRelaysEnabled: false,
          appRelaysTouched: true,
        },
      }),
    }

    try {
      const result = await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [appOnly, remoteOverlap],
          relayTargets: mergeRelayTargets(
            relayTargetsFromUrls([appOnly, remoteOverlap], {
              kind: "app",
              operation: "read",
              bucket: "general_read",
            }),
            relayTargetsFromUrls([remoteOverlap], {
              kind: "remote_nip65",
              operation: "read",
              pubkey: ACCOUNT_B,
            })
          ),
          accountPubkey: ACCOUNT_A,
          authenticatedPubkey: ACCOUNT_A,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )

      expect(result.relays.map(({ relayUrl }) => relayUrl)).toEqual([
        remoteOverlap,
      ])
      expect(opened.openedUrls).toEqual([remoteOverlap])
    } finally {
      opened.restore()
    }
  })

  it("applies whole-relay exclusions only to the explicit account", async () => {
    const relayUrl = "wss://stale-read-plan.conduit.market"
    const opened = installEoseWebSocket()
    const queriedPubkeys: string[] = []
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        queriedPubkeys.push(pubkey)
        return accountNetworkState(
          pubkey,
          pubkey === ACCOUNT_A ? [relayUrl] : []
        )
      },
    }

    try {
      const excluded = await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [relayUrl],
          relayTargets: publicTargets([relayUrl]),
          accountPubkey: ACCOUNT_A,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )
      const otherAccount = await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [relayUrl],
          relayTargets: publicTargets([relayUrl]),
          accountPubkey: ACCOUNT_B,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )
      const accountPolicyReads = queriedPubkeys.length
      const publicRead = await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [relayUrl],
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )

      expect(excluded.relays).toMatchObject([])
      expect(otherAccount.relays).toMatchObject([
        {
          relayUrl,
          status: "success",
          eventCount: 0,
        },
      ])
      expect(publicRead.relays).toMatchObject(otherAccount.relays)
      expect(opened.openedUrls).toEqual([relayUrl, relayUrl])
      expect(new Set(queriedPubkeys)).toEqual(new Set([ACCOUNT_A, ACCOUNT_B]))
      expect(queriedPubkeys).toHaveLength(accountPolicyReads)
    } finally {
      opened.restore()
    }
  })

  it("backfills a bounded read after source policy suppresses an earlier candidate", async () => {
    const personalRelayUrl = "wss://personal-disabled.conduit.market"
    const appRelayUrl = config.appReadRelayUrls[0]!
    const opened = installEoseWebSocket()
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => ({
        ...accountNetworkState(pubkey, []),
        routingPolicy: {
          ...createDefaultAccountNetworkRoutingPolicy(),
          personalRelaysEnabled: false,
          personalRelaysTouched: true,
        },
      }),
    }
    const ownerRelayListEvidenceRepository = await ownerReadEvidence([
      personalRelayUrl,
    ])

    try {
      const result = await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [personalRelayUrl, appRelayUrl],
          relayTargets: mergeRelayTargets(
            ownerTargets([personalRelayUrl]),
            relayTargetsFromUrls([appRelayUrl], {
              kind: "app",
              operation: "read",
              bucket: "general_read",
            })
          ),
          maxRelayAttempts: 1,
          accountPubkey: ACCOUNT_A,
          authenticatedPubkey: ACCOUNT_A,
          ownerRelayListEvidenceRepository,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )

      expect(opened.openedUrls).toEqual([appRelayUrl])
      expect(result.relays.map(({ relayUrl }) => relayUrl)).toEqual([
        appRelayUrl,
      ])
      expect(result.admittedRelayUrls).toEqual([appRelayUrl])
    } finally {
      opened.restore()
    }
  })

  it("re-reads eligibility when queued fanout work reaches its relay slot", async () => {
    const relayUrls = Array.from(
      { length: 9 },
      (_, index) => `wss://queued-${index}.conduit.market`
    )
    const removedRelayUrl = relayUrls.at(-1)!
    const opened = installEoseWebSocket()
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        return accountNetworkState(
          pubkey,
          opened.openedUrls.length >= relayUrls.length - 1
            ? [removedRelayUrl]
            : []
        )
      },
    }

    try {
      const result = await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls,
          relayTargets: publicTargets(relayUrls),
          accountPubkey: ACCOUNT_A,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )

      expect(opened.openedUrls).toEqual(relayUrls.slice(0, -1))
      expect(result.admittedRelayUrls).toEqual(relayUrls.slice(0, -1))
      expect(result.attemptedRelayUrls).toEqual(relayUrls.slice(0, -1))
      expect(result.relays.map(({ relayUrl }) => relayUrl)).toEqual(
        relayUrls.slice(0, -1)
      )
    } finally {
      opened.restore()
    }
  })

  it("preserves the operation's selected order at final account read admission", async () => {
    const relayUrls = [
      "wss://first-order.conduit.market",
      "wss://second-order.conduit.market",
      "wss://third-order.conduit.market",
    ]
    const preferredRelayOrder = [relayUrls[2]!, relayUrls[0]!, relayUrls[1]!]
    const opened = installEoseWebSocket()
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) =>
        accountNetworkState(pubkey, [], preferredRelayOrder),
    }

    try {
      const result = await fetchSignedEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls,
          relayTargets: publicTargets(relayUrls),
          accountPubkey: ACCOUNT_A,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )

      expect(opened.openedUrls).toEqual(relayUrls)
      expect(result.relays.map(({ relayUrl }) => relayUrl)).toEqual(relayUrls)
      expect(new Set(result.relays.map(({ relayUrl }) => relayUrl))).toEqual(
        new Set(relayUrls)
      )
    } finally {
      opened.restore()
    }
  })

  it("keeps contact-list reads on Conduit's planned verified reader", async () => {
    const [follows, merchantTrust] = await Promise.all([
      Bun.file("packages/core/src/protocol/follows.ts").text(),
      Bun.file("apps/market/src/hooks/useMerchantTrustContext.ts").text(),
    ])

    expect(follows).not.toContain(".fetchEvents(")
    expect(merchantTrust).not.toContain(".fetchEvents(")
    expect(follows).toContain("fetchSignedEventsFanoutDetailed")
    expect(follows).toContain("skipHealthFilter: true")
  })

  it("does not connect a shared NDK pool or use bare default publishing", async () => {
    const [sessionContext, relayPublisher] = await Promise.all([
      Bun.file("packages/core/src/context/ConduitSessionContext.tsx").text(),
      Bun.file("packages/core/src/protocol/relay-publish.ts").text(),
    ])

    expect(sessionContext).not.toContain("void connectNdk(")
    expect(relayPublisher).not.toContain("await event.publish()")
    expect(relayPublisher).toContain(
      "Refusing to publish without an approved relay target."
    )
  })

  it("refetches the signed-in profile after authenticated relay activation", async () => {
    const [sessionContext, header] = await Promise.all([
      Bun.file("packages/core/src/context/ConduitSessionContext.tsx").text(),
      Bun.file("apps/market/src/components/MarketHeader.tsx").text(),
    ])

    expect(sessionContext).toContain("!relaySettingsReady ||")
    expect(sessionContext).toContain("session.relayScope")
    expect(sessionContext).toContain("void refetchProfile()")
    expect(sessionContext).toContain(
      "profileRelayScopeRef.current === profileScope"
    )
    expect(sessionContext).toContain("subscribeRelaySettingsChanges")
    expect(sessionContext).toContain("scope !== activeScopeRef.current")
    expect(sessionContext).toContain("profileRefreshReadyRef.current")
    expect(header).not.toContain("subscribeRelaySettingsChanges")
    expect(header).not.toContain("useConduitSession")
  })
})
