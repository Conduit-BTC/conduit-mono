import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetRelayListTestOverrides,
  __resetRelayPublishTestOverrides,
  __setRelayListTestOverrides,
  __setRelayPublishTestOverrides,
  applyE2eRelayIsolation,
  CANONICAL_APP_WRITE_RELAYS,
  CANONICAL_COMMERCE_DISCOVERY_RELAYS,
  config,
  createInMemoryOwnerRelayListEvidenceRepository,
  deriveRelayOutcomes,
  EVENT_KINDS,
  planPublishRelays,
  publishSignedEventToRelay,
  publishWithPlanner,
  setActiveRelaySettingsScope,
  type PublishWithPlannerInput,
  type RelayList,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  __resetNdkTestState,
  getNdk,
  refreshNdkRelaySettingsWhenIdle,
  refreshNdkRelaySettings,
  removeSigner,
  setSigner,
} from "../packages/core/src/protocol/ndk"
import {
  emptyAccountNetworkLocalState,
  type AccountNetworkLocalStateRepository,
} from "../packages/core/src/protocol/account-network-local-state"

const NOW = 1_700_000_000_000
const AUTHOR_SECRET = Uint8Array.from([...new Uint8Array(31), 21])
const OTHER_AUTHOR_SECRET = Uint8Array.from([...new Uint8Array(31), 22])
const AUTHOR_PUBKEY = getPublicKey(AUTHOR_SECRET)
const OTHER_AUTHOR_PUBKEY = getPublicKey(OTHER_AUTHOR_SECRET)
const APP_WRITE_ATTEMPT_RELAYS = CANONICAL_APP_WRITE_RELAYS.map(
  (url) => `${url}/`
)
const originalConfig = structuredClone(config)

async function durableOwnerRelayListRepository(tags: string[][]) {
  const repository = createInMemoryOwnerRelayListEvidenceRepository()
  const signedEvent = finalizeEvent(
    {
      kind: EVENT_KINDS.RELAY_LIST,
      created_at: Math.floor(NOW / 1_000),
      tags,
      content: "",
    },
    AUTHOR_SECRET
  )
  await repository.reconcile({
    pubkey: AUTHOR_PUBKEY,
    observations: [
      {
        signedEvent,
        sourceRelayUrls: ["wss://discovery.example"],
        observedAt: NOW,
        completeObservedAt: NOW,
      },
    ],
    lookup: {
      observedAt: NOW,
      coverage: "complete",
      hadEvent: true,
      eventId: signedEvent.id,
    },
  })
  return repository
}

function accountNetworkState(
  pubkey: string,
  excludedRelayUrls: readonly string[],
  routingPolicy: Partial<
    ReturnType<typeof emptyAccountNetworkLocalState>["routingPolicy"]
  > = {}
) {
  const state = emptyAccountNetworkLocalState(pubkey)
  return {
    ...state,
    routingPolicy: { ...state.routingPolicy, ...routingPolicy },
    exclusions: excludedRelayUrls.map((relayUrl, index) => ({
      relayUrl,
      committedAt: NOW + index,
      relayListFrontier: { eventId: null, createdAt: null },
      inboxDeclarationFrontier: { eventId: null, createdAt: null },
    })),
  }
}

function signedTestEvent(input: {
  kind?: number
  tags?: string[][]
  content?: string
  publish: (relaySet: unknown, timeoutMs?: number) => Promise<unknown>
}): NDKEvent {
  const event = new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: input.kind ?? 1,
        created_at: 1_700_000_000,
        tags: input.tags ?? [],
        content: input.content ?? "test",
      },
      AUTHOR_SECRET
    )
  )
  event.publish = input.publish as never
  return event
}

function signedRawTestEvent(
  input: {
    kind?: number
    tags?: string[][]
    content?: string
  } = {}
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: input.kind ?? 1,
      created_at: 1_700_000_000,
      tags: input.tags ?? [],
      content: input.content ?? "test",
    },
    AUTHOR_SECRET
  )
}

function authenticatedPublishInput(
  relayUrls: readonly string[],
  overrides: {
    event?: NDKEvent
    input?: Partial<
      Omit<PublishWithPlannerInput, "intent" | "exclusiveRelayUrls">
    >
  } = {}
): { event: NDKEvent; input: PublishWithPlannerInput } {
  return {
    event:
      overrides.event ??
      signedTestEvent({
        kind: EVENT_KINDS.GIFT_WRAP,
        publish: async () => new Set(),
      }),
    input: {
      intent: "recipient_event",
      authorPubkey: AUTHOR_PUBKEY,
      authenticatedPubkey: AUTHOR_PUBKEY,
      accountPubkey: AUTHOR_PUBKEY,
      accountNetworkLocalStateRepository: {
        get: async (pubkey) => accountNetworkState(pubkey, []),
      },
      recipientPubkeys: [OTHER_AUTHOR_PUBKEY],
      exclusiveRelayUrls: relayUrls,
      deliveryMode: "critical",
      relayAuthentication: {
        expectedPubkey: AUTHOR_PUBKEY,
        sessionScope: {},
        signer: {
          authMethod: "nip07",
          getPublicKey: async () => AUTHOR_PUBKEY,
          signEvent: async () => signedRawTestEvent({ kind: 22_242 }),
        },
      },
      ...overrides.input,
    },
  }
}

function installRelayPublishWebSocket(
  options: {
    accepted?: boolean
    authTransportFailureRelayUrl?: string
    closeAfterResponse?: boolean
    closeBeforeResponse?: boolean
    closeDelayMs?: number
    reason?: string
    responseDelayMs?: number
    responseEventId?: string
  } = {}
): {
  counters: { closed: number; opened: number }
  openedUrls: string[]
  sentEvents: SignedPublicNostrEvent[]
  restore: () => void
} {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "WebSocket"
  )
  const counters = { closed: 0, opened: 0 }
  const openedUrls: string[] = []
  const sentEvents: SignedPublicNostrEvent[] = []

  class AcknowledgingWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = AcknowledgingWebSocket.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null

    constructor(readonly url: string) {
      counters.opened += 1
      openedUrls.push(url)
      queueMicrotask(() => {
        if (this.readyState !== AcknowledgingWebSocket.CONNECTING) return
        this.readyState = AcknowledgingWebSocket.OPEN
        this.onopen?.(new Event("open"))
      })
    }

    send(payload: string): void {
      const frame = JSON.parse(payload) as [
        string,
        SignedPublicNostrEvent | undefined,
      ]
      if (
        frame[0] === "AUTH" &&
        this.url === options.authTransportFailureRelayUrl
      ) {
        throw new Error("AUTH frame transport failed")
      }
      if (frame[0] !== "EVENT" || !frame[1]?.id) return
      sentEvents.push(frame[1])
      if (this.url === options.authTransportFailureRelayUrl) {
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify(["AUTH", "relay-auth-challenge"]),
          } as MessageEvent<string>)
        })
        return
      }
      if (options.closeBeforeResponse) {
        queueMicrotask(() => this.close())
        return
      }
      const respond = () => {
        this.onmessage?.({
          data: JSON.stringify([
            "OK",
            options.responseEventId ?? frame[1]?.id,
            options.accepted ?? true,
            options.reason ?? "",
          ]),
        } as MessageEvent<string>)
        if (options.closeAfterResponse) this.close()
      }
      if ((options.responseDelayMs ?? 0) > 0) {
        setTimeout(respond, options.responseDelayMs)
      } else {
        queueMicrotask(respond)
      }
    }

    close(): void {
      if (
        this.readyState === AcknowledgingWebSocket.CLOSING ||
        this.readyState === AcknowledgingWebSocket.CLOSED
      ) {
        return
      }
      this.readyState = AcknowledgingWebSocket.CLOSING
      setTimeout(() => {
        this.readyState = AcknowledgingWebSocket.CLOSED
        counters.closed += 1
        this.onclose?.(new Event("close"))
      }, options.closeDelayMs ?? 0)
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: AcknowledgingWebSocket,
  })

  return {
    counters,
    openedUrls,
    sentEvents,
    restore: () => {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "WebSocket", originalDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, "WebSocket")
      }
    },
  }
}

function relayList(
  pubkey: string,
  overrides: Partial<RelayList> = {}
): RelayList {
  return {
    pubkey,
    readRelayUrls: [],
    writeRelayUrls: [],
    eventCreatedAt: 1,
    cachedAt: NOW,
    ...overrides,
  }
}

describe("planPublishRelays", () => {
  beforeEach(() => {
    __setRelayListTestOverrides({
      now: () => NOW,
    })
  })

  afterEach(() => {
    Object.assign(config, structuredClone(originalConfig))
    __resetRelayListTestOverrides()
    __resetRelayPublishTestOverrides()
    setActiveRelaySettingsScope(null)
    __resetNdkTestState()
  })

  it("returns an author plan with no recipient hints", async () => {
    const plan = await planPublishRelays({
      intent: "author_event",
      authorPubkey: "alice",
    })
    expect(plan.intent).toBe("author_event")
    expect(plan.broadcastRelayUrls).toEqual([])
    // primary may be empty when user has no configured write relays.
    expect(Array.isArray(plan.primaryRelayUrls)).toBe(true)
  })

  it("admits only an explicitly owner-selected ws target in an exclusive plan", async () => {
    const ownerWs = "ws://owner-inbox.example"
    const remoteWs = "ws://remote-inbox.example"

    expect(
      await planPublishRelays({
        intent: "recipient_event",
        authorPubkey: AUTHOR_PUBKEY,
        authenticatedPubkey: AUTHOR_PUBKEY,
        accountPubkey: AUTHOR_PUBKEY,
        exclusiveRelayUrls: [ownerWs, remoteWs],
        ownerSelectedRelayUrls: [ownerWs],
      })
    ).toMatchObject({ primaryRelayUrls: [ownerWs] })
    expect(
      await planPublishRelays({
        intent: "recipient_event",
        authorPubkey: AUTHOR_PUBKEY,
        authenticatedPubkey: AUTHOR_PUBKEY,
        accountPubkey: AUTHOR_PUBKEY,
        exclusiveRelayUrls: [remoteWs],
      })
    ).toMatchObject({ primaryRelayUrls: [] })
  })

  it("uses one foreground NIP-42 writer for an exclusive gift-wrap publish", async () => {
    const relayUrl = "wss://auth.nostr1.com"
    let ndkPublishCalls = 0
    let exactWriteCalls = 0
    const fixture = authenticatedPublishInput([relayUrl], {
      event: signedTestEvent({
        kind: EVENT_KINDS.GIFT_WRAP,
        publish: async () => {
          ndkPublishCalls += 1
          return new Set()
        },
      }),
    })
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async (input) => {
        exactWriteCalls += 1
        expect(input.relayUrl).toBe(relayUrl)
        expect(input.signedEvent).toEqual(fixture.event.rawEvent())
        expect(input.timeoutMs).toBe(15_000)
        expect(input.authorization?.expectedPubkey).toBe(AUTHOR_PUBKEY)
        expect(input.authorization?.signer).toBe(
          fixture.input.relayAuthentication?.signer
        )
        return "acked"
      },
    })

    const result = await publishWithPlanner(fixture.event, fixture.input)

    expect(result.attemptedRelayUrls).toEqual([relayUrl])
    expect(result.successfulRelayUrls).toEqual([relayUrl])
    expect(result.failedRelayUrls).toEqual([])
    expect(exactWriteCalls).toBe(1)
    expect(ndkPublishCalls).toBe(0)
  })

  it("continues to a later exact relay after an AUTH-frame transport failure", async () => {
    const firstRelay = "wss://first-auth-transport.example"
    const secondRelay = "wss://second-auth-transport.example"
    const socket = installRelayPublishWebSocket({
      authTransportFailureRelayUrl: firstRelay,
    })

    try {
      const fixture = authenticatedPublishInput([firstRelay, secondRelay], {
        input: {
          relayAuthentication: {
            expectedPubkey: AUTHOR_PUBKEY,
            sessionScope: {},
            signer: {
              authMethod: "nip07",
              getPublicKey: async () => AUTHOR_PUBKEY,
              signEvent: async (event) =>
                finalizeEvent(
                  {
                    kind: event.kind,
                    created_at: event.created_at,
                    tags: event.tags,
                    content: event.content,
                  },
                  AUTHOR_SECRET
                ),
            },
          },
        },
      })

      const result = await publishWithPlanner(fixture.event, fixture.input)

      expect(socket.openedUrls).toEqual([firstRelay, secondRelay])
      expect(result.successfulRelayUrls).toEqual([secondRelay])
      expect(result.failedRelayUrls).toEqual([firstRelay])
    } finally {
      socket.restore()
    }
  })

  it("retains an exact relay rejection after another authenticated target ACKs", async () => {
    const acceptedRelay = "wss://accepted-auth-write.example"
    const rejectedRelay = "wss://rejected-auth-write.example"
    const fixture = authenticatedPublishInput([acceptedRelay, rejectedRelay])
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async ({ relayUrl }) =>
        relayUrl === acceptedRelay ? "acked" : "rejected",
    })

    const result = await publishWithPlanner(fixture.event, fixture.input)

    expect(result.successfulRelayUrls).toEqual([acceptedRelay])
    expect(result.failedRelayUrls).toEqual([rejectedRelay])
    expect(result.rejectedRelayUrls).toEqual([rejectedRelay])
    expect(result.relayFailureMessages[rejectedRelay]).toBe(
      "Relay rejected the event"
    )
  })

  it("does not repeat an auth-capable exact write after its bounded timeout", async () => {
    const relayUrl = "wss://auth.nostr1.com"
    let exactWriteCalls = 0
    const fixture = authenticatedPublishInput([relayUrl])
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async () => {
        exactWriteCalls += 1
        return "timed_out"
      },
    })

    await expect(
      publishWithPlanner(fixture.event, fixture.input)
    ).rejects.toThrow("required exclusive relay set")

    expect(exactWriteCalls).toBe(1)
  })

  it("suppresses later auth prompts after a session-level signer failure and permits a fresh retry", async () => {
    const firstRelay = "wss://first-auth-prompt.example"
    const secondRelay = "wss://second-auth-prompt.example"
    const attempts: string[] = []
    const fixture = authenticatedPublishInput([firstRelay, secondRelay])
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async (input) => {
        attempts.push(input.relayUrl)
        input.authorization?.onSignerFailure?.()
        return "timed_out"
      },
    })
    const publish = async () =>
      await publishWithPlanner(fixture.event, fixture.input)

    await expect(publish()).rejects.toThrow("required exclusive relay set")
    expect(attempts).toEqual([firstRelay])

    await expect(publish()).rejects.toThrow("required exclusive relay set")
    expect(attempts).toEqual([firstRelay, firstRelay])
  })

  it("rejects relay authentication without matching foreground account authority", async () => {
    let exactWriteCalls = 0
    const fixture = authenticatedPublishInput(["wss://auth.nostr1.com"], {
      input: { authenticatedPubkey: OTHER_AUTHOR_PUBKEY },
    })
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async () => {
        exactWriteCalls += 1
        return "acked"
      },
    })

    await expect(
      publishWithPlanner(fixture.event, fixture.input)
    ).rejects.toThrow("active foreground account")
    expect(exactWriteCalls).toBe(0)
  })

  it("rechecks each authenticated target after an earlier write commits an exclusion", async () => {
    const firstRelay = "wss://first-auth-write.example"
    const excludedRelay = "wss://excluded-auth-write.example"
    let exclusionCommitted = false
    const attempts: string[] = []
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) =>
        accountNetworkState(pubkey, exclusionCommitted ? [excludedRelay] : []),
    }
    const fixture = authenticatedPublishInput([firstRelay, excludedRelay], {
      input: { accountNetworkLocalStateRepository: repository },
    })
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async ({ relayUrl }) => {
        attempts.push(relayUrl)
        exclusionCommitted = true
        return "acked"
      },
    })

    const result = await publishWithPlanner(fixture.event, fixture.input)

    expect(attempts).toEqual([firstRelay])
    expect(result.attemptedRelayUrls).toEqual([firstRelay])
    expect(result.successfulRelayUrls).toEqual([firstRelay])
    expect(result.failedRelayUrls).toEqual([])
  })

  it("preserves an authenticated relay ACK when account authority changes before the next target", async () => {
    const firstRelay = "wss://first-auth-session.example"
    const secondRelay = "wss://second-auth-session.example"
    const attempts: string[] = []
    let current = true
    const fixture = authenticatedPublishInput([firstRelay, secondRelay], {
      input: { shouldContinue: () => current },
    })
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async ({ relayUrl }) => {
        attempts.push(relayUrl)
        current = false
        return "acked"
      },
    })

    const result = await publishWithPlanner(fixture.event, fixture.input)

    expect(attempts).toEqual([firstRelay])
    expect(result.attemptedRelayUrls).toEqual([firstRelay])
    expect(result.successfulRelayUrls).toEqual([firstRelay])
    expect(result.failedRelayUrls).toEqual([])
  })

  it("preserves an authenticated relay ACK when the next eligibility read fails", async () => {
    const firstRelay = "wss://first-auth-eligibility.example"
    const secondRelay = "wss://second-auth-eligibility.example"
    const attempts: string[] = []
    let firstRelayAcked = false
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        if (firstRelayAcked) throw new Error("eligibility storage unavailable")
        return accountNetworkState(pubkey, [])
      },
    }
    const fixture = authenticatedPublishInput([firstRelay, secondRelay], {
      input: { accountNetworkLocalStateRepository: repository },
    })
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async ({ relayUrl }) => {
        attempts.push(relayUrl)
        firstRelayAcked = true
        return "acked"
      },
    })

    const result = await publishWithPlanner(fixture.event, fixture.input)

    expect(attempts).toEqual([firstRelay])
    expect(result.attemptedRelayUrls).toEqual([firstRelay])
    expect(result.successfulRelayUrls).toEqual([firstRelay])
    expect(result.failedRelayUrls).toEqual([])
  })

  it("binds durable signed owner membership instead of stale self hints", async () => {
    const currentRelayUrl = "wss://current-owner.example"
    const staleRelayUrls = Array.from(
      { length: 4 },
      (_, index) => `wss://stale-owner-${index}.example`
    )
    __setRelayPublishTestOverrides({
      ownerRelayListEvidenceRepository: await durableOwnerRelayListRepository([
        ["r", currentRelayUrl],
      ]),
    })
    setActiveRelaySettingsScope(`account:${"f".repeat(64)}`)
    __setRelayListTestOverrides({
      now: () => NOW,
      loadCached: async (pubkey) =>
        pubkey === AUTHOR_PUBKEY
          ? relayList(AUTHOR_PUBKEY, { writeRelayUrls: staleRelayUrls })
          : undefined,
    })

    const plan = await planPublishRelays({
      intent: "author_event",
      authorPubkey: AUTHOR_PUBKEY,
      authenticatedPubkey: AUTHOR_PUBKEY,
      accountPubkey: AUTHOR_PUBKEY,
      accountNetworkLocalStateRepository: {
        get: async (pubkey) =>
          accountNetworkState(pubkey, [], { appRelaysEnabled: false }),
      },
    })

    expect(plan.primaryRelayUrls).toEqual([currentRelayUrl])
    expect(plan.signedRelayListAuthoritative).toBe(true)
  })

  it("publishes through an owner-selected ws relay without admitting remote ws", async () => {
    const ownerWs = "ws://owner-publish.example"
    const remoteWs = "ws://remote-recipient.example"
    const attempts: string[][] = []
    __setRelayPublishTestOverrides({
      ownerRelayListEvidenceRepository: await durableOwnerRelayListRepository([
        ["r", ownerWs, "write"],
      ]),
    })
    const event = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) =>
        accountNetworkState(pubkey, [], { appRelaysEnabled: false }),
    }

    const result = await publishWithPlanner(event, {
      intent: "author_event",
      authorPubkey: AUTHOR_PUBKEY,
      authenticatedPubkey: AUTHOR_PUBKEY,
      accountPubkey: AUTHOR_PUBKEY,
      accountNetworkLocalStateRepository: repository,
      extraRelayUrls: [remoteWs],
    })

    expect(result.attemptedRelayUrls).toEqual([ownerWs])
    expect(attempts).toEqual([[`${ownerWs}/`]])
  })

  it("does not broaden signed owner authority when App Relays are disabled and no Publish relay is declared", async () => {
    const cases = [[], [["r", "wss://read-only-owner.example", "read"]]]

    for (const tags of cases) {
      __setRelayPublishTestOverrides({
        ownerRelayListEvidenceRepository:
          await durableOwnerRelayListRepository(tags),
      })
      let publishCalls = 0
      const event = signedTestEvent({
        publish: async () => {
          publishCalls += 1
          return new Set()
        },
      })

      await expect(
        publishWithPlanner(event, {
          intent: "author_event",
          authorPubkey: AUTHOR_PUBKEY,
          authenticatedPubkey: AUTHOR_PUBKEY,
          accountPubkey: AUTHOR_PUBKEY,
          accountNetworkLocalStateRepository: {
            get: async (pubkey) =>
              accountNetworkState(pubkey, [], { appRelaysEnabled: false }),
          },
        })
      ).rejects.toThrow("signed Network settings have no usable Publish relay")
      expect(publishCalls).toBe(0)
    }
  })

  it("never infers account authority from the ambient active scope", async () => {
    setActiveRelaySettingsScope(`account:${"f".repeat(64)}`)

    const plan = await planPublishRelays({
      intent: "author_event",
      authorPubkey: AUTHOR_PUBKEY,
      authenticatedPubkey: AUTHOR_PUBKEY,
    })

    expect(plan.signedRelayListAuthoritative).not.toBe(true)
  })

  it("merges recipient read relays into a recipient_event primary set", async () => {
    __setRelayListTestOverrides({
      now: () => NOW,
      loadCached: async (pubkey) => {
        if (pubkey === "bob") {
          return {
            pubkey: "bob",
            readRelayUrls: ["wss://bob-read.conduit.market"],
            writeRelayUrls: ["wss://bob-write.conduit.market"],
            eventCreatedAt: 1,
            sourceRelayUrls: undefined,
            cachedAt: NOW,
          }
        }
        return undefined
      },
    })

    const plan = await planPublishRelays({
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
    })

    expect(plan.intent).toBe("recipient_event")
    expect(plan.primaryRelayUrls).toContain("wss://bob-read.conduit.market")
  })

  it("uses every recipient relay for critical delivery jobs", async () => {
    const relays = Array.from(
      { length: 6 },
      (_, index) => `wss://bob-read-${index}.conduit.market`
    )
    __setRelayListTestOverrides({
      now: () => NOW,
      loadCached: async (pubkey) =>
        pubkey === "bob"
          ? {
              pubkey: "bob",
              readRelayUrls: relays,
              writeRelayUrls: [],
              eventCreatedAt: 1,
              sourceRelayUrls: undefined,
              cachedAt: NOW,
            }
          : undefined,
    })

    const standard = await planPublishRelays({
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
    })
    const critical = await planPublishRelays({
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
      deliveryMode: "critical",
    })

    expect(standard.primaryRelayUrls).toEqual(relays.slice(0, 4))
    expect(critical.primaryRelayUrls).toEqual(relays)
  })

  it("falls back gracefully when no cached relay list is present", async () => {
    __setRelayListTestOverrides({
      now: () => NOW,
      loadCached: async () => undefined,
    })

    const plan = await planPublishRelays({
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
    })

    // No recipient hint, so primary should still seed from user write relays.
    expect(plan.intent).toBe("recipient_event")
    expect(Array.isArray(plan.broadcastRelayUrls)).toBe(true)
  })

  // Mark relay list usage helper as used to avoid lint flag.
  it("relayList helper compiles", () => {
    expect(relayList("zz").pubkey).toBe("zz")
  })

  it("refuses an invalid signed event before planning any relay", async () => {
    let planned = false
    const rawEvent = finalizeEvent(
      { kind: 1, created_at: 1_700_000_000, tags: [], content: "hello" },
      AUTHOR_SECRET
    )
    const event = new NDKEvent(undefined, {
      ...rawEvent,
      sig: "0".repeat(128),
    })
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => {
        planned = true
        return {
          intent: "author_event",
          primaryRelayUrls: [],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        }
      },
    })

    await expect(
      publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).rejects.toThrow("invalid signed Nostr event")
    expect(planned).toBe(false)
  })

  it("refuses an author event signed by a different account", async () => {
    let planned = false
    const event = new NDKEvent(
      undefined,
      finalizeEvent(
        { kind: 1, created_at: 1_700_000_000, tags: [], content: "hello" },
        AUTHOR_SECRET
      )
    )
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => {
        planned = true
        return {
          intent: "author_event",
          primaryRelayUrls: [],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        }
      },
    })

    await expect(
      publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: OTHER_AUTHOR_PUBKEY,
      })
    ).rejects.toThrow("signed by a different account")
    expect(planned).toBe(false)
  })

  it("allows a single Publish relay before planning relays", async () => {
    const event = signedTestEvent({
      kind: EVENT_KINDS.RELAY_LIST,
      tags: [["r", "wss://only.conduit.market"]],
      content: "",
      publish: async () => new Set(),
    })
    await expect(
      publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).resolves.toBeDefined()
  })

  it("uses the app write relay for NIP-65 publishes without a planner target", async () => {
    const publishAttempts: string[][] = []

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(
        signedTestEvent({
          kind: EVENT_KINDS.RELAY_LIST,
          tags: [
            ["r", "wss://one.conduit.market"],
            ["r", "wss://two.conduit.market", "write"],
          ],
          publish: async (relaySet: unknown) => {
            const relayUrls = [
              ...((relaySet as { relayUrls?: Set<string> | string[] })
                .relayUrls ?? []),
            ]
            publishAttempts.push(relayUrls)
            return new Set(relayUrls.map((url) => ({ url })))
          },
        }),
        {
          intent: "author_event",
          authorPubkey: AUTHOR_PUBKEY,
        }
      )
    ).resolves.toMatchObject({
      successfulRelayUrls: CANONICAL_APP_WRITE_RELAYS,
    })

    expect(publishAttempts).toEqual([APP_WRITE_ATTEMPT_RELAYS])
  })

  it("refuses tiny contact-list publishes before planning relays", async () => {
    let planned = false
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => {
        planned = true
        return {
          intent: "author_event",
          primaryRelayUrls: ["wss://relay.conduit.market"],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        }
      },
    })

    await expect(
      publishWithPlanner(
        {
          kind: EVENT_KINDS.CONTACT_LIST,
          content: "",
          tags: [["p", "alice"]],
        } as never,
        {
          intent: "author_event",
          authorPubkey: "alice",
        }
      )
    ).rejects.toThrow("Refusing to publish a tiny follow list")
    expect(planned).toBe(false)
  })

  it("cancels before relay publication when the signer session changes", async () => {
    let current = true
    let publishes = 0
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => {
        current = false
        return {
          intent: "author_event",
          primaryRelayUrls: ["wss://relay.example"],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        }
      },
    })

    await expect(
      publishWithPlanner(
        signedTestEvent({
          publish: async () => {
            publishes += 1
            return new Set()
          },
        }),
        {
          intent: "author_event",
          authorPubkey: AUTHOR_PUBKEY,
          shouldContinue: () => current,
        }
      )
    ).rejects.toThrow("signer session changed")
    expect(publishes).toBe(0)
  })

  it("cancels before final planner publication when account policy loading changes the session", async () => {
    const relayUrl = "ws://owner-final-publish.example"
    const ownerRelayListEvidenceRepository =
      await durableOwnerRelayListRepository([["r", relayUrl, "write"]])
    let current = true
    let durableReads = 0
    let publishes = 0
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        durableReads += 1
        if (durableReads === 2) current = false
        return accountNetworkState(pubkey, [])
      },
    }
    __setRelayPublishTestOverrides({
      ownerRelayListEvidenceRepository,
      planPublishRelays: async () => ({
        intent: "author_event",
        signedRelayListAuthoritative: true,
        primaryRelayUrls: [relayUrl],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(
        signedTestEvent({
          publish: async () => {
            publishes += 1
            return new Set()
          },
        }),
        {
          intent: "author_event",
          authorPubkey: AUTHOR_PUBKEY,
          authenticatedPubkey: AUTHOR_PUBKEY,
          accountPubkey: AUTHOR_PUBKEY,
          accountNetworkLocalStateRepository: repository,
          shouldContinue: () => current,
        }
      )
    ).rejects.toThrow("signer session changed")
    expect(durableReads).toBe(2)
    expect(publishes).toBe(0)
  })

  it("keeps a primary-accepted publish successful when the session changes before broadcast", async () => {
    const primaryRelay = "wss://primary.conduit.market"
    const broadcastRelay = "wss://broadcast.conduit.market"
    const attempts: string[][] = []
    let current = true

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [broadcastRelay],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(
      signedTestEvent({
        publish: async (relaySet: unknown) => {
          const relayUrls = [
            ...((relaySet as { relayUrls?: Set<string> | string[] })
              .relayUrls ?? []),
          ]
          attempts.push(relayUrls)
          current = false
          return new Set(relayUrls.map((url) => ({ url })))
        },
      }),
      {
        intent: "author_event",
        authorPubkey: AUTHOR_PUBKEY,
        shouldContinue: () => current,
      }
    )

    expect(attempts).toEqual([[`${primaryRelay}/`]])
    expect(result.successfulRelayUrls).toEqual([primaryRelay])
    expect(result.attemptedRelayUrls).not.toContain(broadcastRelay)
  })

  it("does not let broadcast success mask recipient primary failure", async () => {
    const primaryRelay = "wss://recipient.conduit.market"
    const broadcastRelay = "wss://sender.conduit.market"
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        if (relayUrls.some((url) => url.startsWith(primaryRelay))) {
          throw new Error("recipient relay failed")
        }
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [broadcastRelay],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "recipient_event",
        authorPubkey: "alice",
        recipientPubkeys: ["bob"],
      })
    ).rejects.toThrow("no primary relay accepted")

    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.[0]).toStartWith(primaryRelay)
  })

  it("returns broadcast failures as diagnostics after primary delivery succeeds", async () => {
    const primaryRelay = "wss://recipient.conduit.market"
    const broadcastRelay = "wss://sender.conduit.market"
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        if (relayUrls.some((url) => url.startsWith(broadcastRelay))) {
          throw new Error("broadcast relay failed")
        }
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [broadcastRelay],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
    })

    expect(result.successfulRelayUrls).toEqual([primaryRelay])
    expect(result.failedRelayUrls).toEqual([broadcastRelay])
  })

  it("drops private extra relay hints that the authenticated planner did not select", async () => {
    const primaryRelay = "wss://recipient.conduit.market"
    const publicExtraRelay = "wss://public-extra.conduit.market"
    const privateExtraRelay = "wss://127.0.0.1:7447"
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "recipient_event",
      authorPubkey: "alice",
      authenticatedPubkey: "alice",
      recipientPubkeys: ["bob"],
      extraRelayUrls: [privateExtraRelay, publicExtraRelay],
    })

    expect(result.plan.primaryRelayUrls).toEqual([
      primaryRelay,
      publicExtraRelay,
    ])
    expect(result.attemptedRelayUrls).not.toContain(privateExtraRelay)
  })

  it("drops post-planner public write hints during E2E isolation", async () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    const attemptedRelaySets: string[][] = []
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attemptedRelaySets.push(relayUrls)
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: ["wss://planner-bypass.example"],
        broadcastRelayUrls: ["wss://broadcast-bypass.example"],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "author_event",
      authorPubkey: AUTHOR_PUBKEY,
      accountPubkey: AUTHOR_PUBKEY,
      accountNetworkLocalStateRepository: {
        get: async (pubkey) => accountNetworkState(pubkey, []),
      },
      extraRelayUrls: ["wss://relay.damus.io"],
    })

    expect(result.plan.primaryRelayUrls).toEqual([isolatedRelayUrl])
    expect(result.plan.broadcastRelayUrls).toEqual([])
    expect(attemptedRelaySets).toEqual([[`${isolatedRelayUrl}/`]])
    expect(result.attemptedRelayUrls).toEqual([isolatedRelayUrl])
  })

  it("preserves a private extra hint already selected for the authenticated user", async () => {
    const recipientRelay = "wss://recipient.conduit.market"
    const authenticatedLocalRelay = "wss://127.0.0.1:7447"
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [recipientRelay],
        broadcastRelayUrls: [authenticatedLocalRelay],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "recipient_event",
      authorPubkey: "alice",
      authenticatedPubkey: "alice",
      recipientPubkeys: ["bob"],
      extraRelayUrls: [authenticatedLocalRelay],
    })

    expect(result.plan.primaryRelayUrls).toEqual([
      recipientRelay,
      authenticatedLocalRelay,
    ])
    expect(result.attemptedRelayUrls).toContain(authenticatedLocalRelay)
  })

  it("refuses to publish a gift wrap without an exclusive private-message plan", async () => {
    let attempted = false
    const fakeEvent = signedTestEvent({
      kind: EVENT_KINDS.GIFT_WRAP,
      publish: async () => {
        attempted = true
        return new Set()
      },
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "recipient_event",
        authorPubkey: "alice",
        recipientPubkeys: ["bob"],
        extraRelayUrls: ["wss://inbox-10050.conduit.market"],
      })
    ).rejects.toThrow(
      "Gift wraps require an exclusive private-message relay plan"
    )
    expect(attempted).toBe(false)
  })

  it("never leaves the exclusive relay set after every declared relay rejects", async () => {
    const exclusiveRelay = "wss://declared-inbox.conduit.market"
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
      kind: EVENT_KINDS.GIFT_WRAP,
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        throw new Error("declared inbox rejected the wrap")
      },
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "recipient_event",
        authorPubkey: "alice",
        recipientPubkeys: ["bob"],
        deliveryMode: "critical",
        exclusiveRelayUrls: [exclusiveRelay],
        extraRelayUrls: ["wss://must-not-be-used.conduit.market"],
      })
    ).rejects.toThrow("required exclusive relay set")

    expect(attempts).toEqual([[`${exclusiveRelay}/`], [`${exclusiveRelay}/`]])
  })

  it("publishes an immutable signed snapshot over one isolated socket", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()
    const relayUrl = "wss://durable-delete.conduit.market"
    const signedEvent = signedRawTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
    })
    const expectedEvent = {
      id: signedEvent.id,
      pubkey: signedEvent.pubkey,
      created_at: signedEvent.created_at,
      kind: signedEvent.kind,
      tags: signedEvent.tags.map((tag) => [...tag]),
      content: signedEvent.content,
      sig: signedEvent.sig,
    }

    try {
      const publish = publishSignedEventToRelay({
        signedEvent,
        relayUrl,
        authorPubkey: AUTHOR_PUBKEY,
      })
      signedEvent.id = "f".repeat(64)
      signedEvent.tags[0]![1] = "mutated-after-publish"
      signedEvent.content = "mutated-after-publish"

      await expect(publish).resolves.toBe("acked")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fakeWebSocket.sentEvents).toEqual([expectedEvent])
      expect(fakeWebSocket.openedUrls).toEqual([relayUrl])
      expect(fakeWebSocket.counters).toEqual({ opened: 1, closed: 1 })
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("cancels an exact owner-selected publish when account policy loading changes the session", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()
    const relayUrl = "ws://owner-exact-publish.example"
    const signedEvent = signedRawTestEvent({ kind: EVENT_KINDS.DELETION })
    let current = true
    let durableReads = 0
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        durableReads += 1
        current = false
        return accountNetworkState(pubkey, [])
      },
    }

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent,
          relayUrl,
          authorPubkey: AUTHOR_PUBKEY,
          authenticatedPubkey: AUTHOR_PUBKEY,
          ownerSelectedRelayUrls: [relayUrl],
          accountPubkey: AUTHOR_PUBKEY,
          accountNetworkLocalStateRepository: repository,
          shouldContinue: () => current,
        })
      ).rejects.toThrow("signer session changed")
      expect(durableReads).toBe(1)
      expect(fakeWebSocket.counters.opened).toBe(0)
      expect(fakeWebSocket.sentEvents).toEqual([])
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("keeps an in-flight exact publish isolated from ambient NDK resets", async () => {
    const fakeWebSocket = installRelayPublishWebSocket({ responseDelayMs: 20 })
    const relayUrl = "wss://durable-isolated.conduit.market"
    const signedEvent = signedRawTestEvent({ kind: EVENT_KINDS.DELETION })

    try {
      const publish = publishSignedEventToRelay({
        signedEvent,
        relayUrl,
        authorPubkey: AUTHOR_PUBKEY,
      })
      await Promise.resolve()
      expect(fakeWebSocket.sentEvents).toHaveLength(1)

      refreshNdkRelaySettings("merchant:replacement")

      await expect(publish).resolves.toBe("acked")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fakeWebSocket.counters).toEqual({ opened: 1, closed: 1 })
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("preserves the shared signer and NDK during a same-session publish refresh", async () => {
    const relayUrl = "wss://same-session-publish.example"
    let markPublishStarted!: () => void
    let releasePublish = () => undefined
    const publishStarted = new Promise<void>((resolve) => {
      markPublishStarted = resolve
    })
    const publishBlocked = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    const event = signedTestEvent({
      publish: async (relaySet: unknown) => {
        markPublishStarted()
        await publishBlocked
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [relayUrl],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })
    const ndk = getNdk()
    const signer = {
      user: async () => ndk.getUser({ pubkey: AUTHOR_PUBKEY }),
    } as NDKSigner
    const signerLease = setSigner(signer)

    try {
      const publishing = publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: AUTHOR_PUBKEY,
        authenticatedPubkey: AUTHOR_PUBKEY,
      })
      await publishStarted

      expect(event.ndk).toBe(ndk)
      refreshNdkRelaySettingsWhenIdle(`account:${AUTHOR_PUBKEY}`)
      expect(getNdk()).toBe(ndk)
      expect(ndk.signer).toBe(signer)

      releasePublish()
      await expect(publishing).resolves.toMatchObject({
        attemptedRelayUrls: [relayUrl],
        successfulRelayUrls: [relayUrl],
      })
    } finally {
      releasePublish()
      removeSigner(signerLease)
    }
  })

  it("closes the isolated socket after a failed attempt", async () => {
    const fakeWebSocket = installRelayPublishWebSocket({
      closeBeforeResponse: true,
    })
    const signedEvent = signedRawTestEvent({ kind: EVENT_KINDS.DELETION })

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent,
          relayUrl: "wss://durable-timeout.conduit.market",
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).resolves.toBe("timed_out")
      expect(fakeWebSocket.counters).toEqual({ opened: 1, closed: 1 })
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("uses independent sockets for immediate sequential retries", async () => {
    const fakeWebSocket = installRelayPublishWebSocket({ closeDelayMs: 20 })
    const relayUrl = "wss://sequential-durable.conduit.market"
    const signedEvent = signedRawTestEvent({ kind: EVENT_KINDS.DELETION })

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          publishSignedEventToRelay({
            signedEvent,
            relayUrl,
            authorPubkey: AUTHOR_PUBKEY,
          })
        ).resolves.toBe("acked")
      }

      expect(fakeWebSocket.counters.opened).toBe(2)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(fakeWebSocket.counters.closed).toBe(2)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("isolates concurrent publishes to the same relay and event", async () => {
    const fakeWebSocket = installRelayPublishWebSocket({ responseDelayMs: 10 })
    const relayUrl = "wss://concurrent-durable.conduit.market"
    const signedEvent = signedRawTestEvent({ kind: EVENT_KINDS.DELETION })

    try {
      await expect(
        Promise.all([
          publishSignedEventToRelay({
            signedEvent,
            relayUrl,
            authorPubkey: AUTHOR_PUBKEY,
          }),
          publishSignedEventToRelay({
            signedEvent,
            relayUrl,
            authorPubkey: AUTHOR_PUBKEY,
          }),
        ])
      ).resolves.toEqual(["acked", "acked"])
      expect(fakeWebSocket.counters.opened).toBe(2)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fakeWebSocket.counters.closed).toBe(2)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("preserves an authenticated author's exact local relay target", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()
    const relayUrl = "ws://owner-selected.example"
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => accountNetworkState(pubkey, []),
    }

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl,
          authorPubkey: AUTHOR_PUBKEY,
          authenticatedPubkey: AUTHOR_PUBKEY,
          accountPubkey: AUTHOR_PUBKEY,
          ownerSelectedRelayUrls: [relayUrl],
          accountNetworkLocalStateRepository: repository,
        })
      ).resolves.toBe("acked")
      expect(fakeWebSocket.openedUrls).toEqual([relayUrl])
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("publishes only to the configured loopback during E2E isolation", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl: isolatedRelayUrl,
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).resolves.toBe("acked")
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl: "wss://relay.damus.io",
          authorPubkey: AUTHOR_PUBKEY,
          authenticatedPubkey: AUTHOR_PUBKEY,
        })
      ).rejects.toThrow("configured E2E loopback relay target")
      expect(fakeWebSocket.openedUrls).toEqual([isolatedRelayUrl])
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("rejects an exact insecure relay outside the authenticated author context", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl: "ws://127.0.0.1:7777",
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).rejects.toThrow("public or authenticated relay target")
      expect(fakeWebSocket.counters.opened).toBe(0)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("rejects caller-asserted owner ws authority without the account boundary", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()
    const relayUrl = "ws://owner-without-account.example"

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl,
          authorPubkey: AUTHOR_PUBKEY,
          authenticatedPubkey: AUTHOR_PUBKEY,
          ownerSelectedRelayUrls: [relayUrl],
        })
      ).rejects.toThrow("public or authenticated relay target")
      expect(fakeWebSocket.counters.opened).toBe(0)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("rejects remote ws even when an authenticated account is present", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()
    const remoteWs = "ws://remote-recipient.example"

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl: remoteWs,
          authorPubkey: AUTHOR_PUBKEY,
          authenticatedPubkey: AUTHOR_PUBKEY,
          accountPubkey: AUTHOR_PUBKEY,
          ownerSelectedRelayUrls: ["ws://different-owner-selection.example"],
          accountNetworkLocalStateRepository: {
            get: async (pubkey) => accountNetworkState(pubkey, []),
          },
        })
      ).rejects.toThrow("public or authenticated relay target")
      expect(fakeWebSocket.counters.opened).toBe(0)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("rejects an exact private WSS relay outside the authenticated author context", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl: "wss://127.0.0.1:7447",
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).rejects.toThrow("public or authenticated relay target")
      expect(fakeWebSocket.counters.opened).toBe(0)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("preserves an authenticated author's exact private WSS target", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()
    const relayUrl = "wss://127.0.0.1:7447"
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => accountNetworkState(pubkey, []),
    }

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl,
          authorPubkey: AUTHOR_PUBKEY,
          authenticatedPubkey: AUTHOR_PUBKEY,
          accountPubkey: AUTHOR_PUBKEY,
          ownerSelectedRelayUrls: [relayUrl],
          accountNetworkLocalStateRepository: repository,
        })
      ).resolves.toBe("acked")
      expect(fakeWebSocket.openedUrls).toEqual([relayUrl])
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("refuses a mismatched author before constructing a socket", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl: "wss://author-mismatch.conduit.market",
          authorPubkey: OTHER_AUTHOR_PUBKEY,
        })
      ).rejects.toThrow("signed by a different account")
      expect(fakeWebSocket.counters.opened).toBe(0)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("refuses an invalid signed event before constructing a socket", async () => {
    const fakeWebSocket = installRelayPublishWebSocket()
    const signedEvent = signedRawTestEvent({ kind: EVENT_KINDS.DELETION })
    signedEvent.sig = "0".repeat(128)

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent,
          relayUrl: "wss://invalid-event.conduit.market",
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).rejects.toThrow("invalid signed Nostr event")
      expect(fakeWebSocket.counters.opened).toBe(0)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("ignores an OK for another event id and keeps the result retryable", async () => {
    const fakeWebSocket = installRelayPublishWebSocket({
      closeAfterResponse: true,
      responseEventId: "f".repeat(64),
    })

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl: "wss://wrong-ack.conduit.market",
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).resolves.toBe("timed_out")
      expect(fakeWebSocket.counters.closed).toBe(1)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("classifies a NIP-01 OK-false reason as an explicit rejection", async () => {
    const fakeWebSocket = installRelayPublishWebSocket({
      accepted: false,
      reason: "blocked: deletion denied",
    })

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl: "wss://durable-reject.conduit.market",
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).resolves.toBe("rejected")
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("treats a NIP-01 duplicate response as an idempotent acknowledgement", async () => {
    const fakeWebSocket = installRelayPublishWebSocket({
      accepted: false,
      reason: "duplicate: already have this event",
    })

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl: "wss://durable-duplicate.conduit.market",
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).resolves.toBe("acked")
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("keeps an unprefixed OK-false response retryable", async () => {
    const fakeWebSocket = installRelayPublishWebSocket({
      accepted: false,
      reason: "could not store event",
    })

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent: signedRawTestEvent({ kind: EVENT_KINDS.DELETION }),
          relayUrl: "wss://durable-ambiguous.conduit.market",
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).resolves.toBe("timed_out")
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("retries non-NIP-65 author events on public fallback relays when configured writes fail", async () => {
    const primaryRelay = "wss://configured-write.conduit.market"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
      kind: EVENT_KINDS.PRODUCT,
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        if (relayUrls.includes(normalizedPrimaryRelay)) {
          throw new Error("configured write relay failed")
        }
        return new Set(relayUrls.slice(0, 1).map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "author_event",
      authorPubkey: AUTHOR_PUBKEY,
    })

    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toEqual([normalizedPrimaryRelay])
    expect(attempts[1]?.length).toBeGreaterThan(0)
    expect(attempts[1]).not.toContain(normalizedPrimaryRelay)
    for (const relayUrl of CANONICAL_COMMERCE_DISCOVERY_RELAYS) {
      expect(attempts[1]).toContain(`${relayUrl}/`)
    }
    expect(result.successfulRelayUrls.length).toBe(1)
    expect(result.failedRelayUrls).toContain(primaryRelay)
  })

  it("does not broaden an authoritative author plan after its relay fails", async () => {
    const primaryRelay = "wss://authoritative-write.conduit.market"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
      kind: EVENT_KINDS.PRODUCT,
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        throw new Error("authoritative write relay failed")
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        signedRelayListAuthoritative: true,
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "author_event",
        authorPubkey: AUTHOR_PUBKEY,
        authenticatedPubkey: AUTHOR_PUBKEY,
      })
    ).rejects.toThrow("no primary relay accepted")
    expect(attempts).toEqual([[normalizedPrimaryRelay]])
  })

  it("falls back to the app write relay for NIP-65 after configured writes fail", async () => {
    const primaryRelay = "wss://configured-write.conduit.market"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
      kind: EVENT_KINDS.RELAY_LIST,
      tags: [
        ["r", "wss://one.conduit.market"],
        ["r", "wss://two.conduit.market", "write"],
      ],
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        if (relayUrls.includes(normalizedPrimaryRelay)) {
          throw new Error("configured write relay failed")
        }
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "author_event",
      authorPubkey: AUTHOR_PUBKEY,
    })

    expect(result.successfulRelayUrls).toEqual(CANONICAL_APP_WRITE_RELAYS)
    expect(attempts).toEqual([
      [normalizedPrimaryRelay],
      APP_WRITE_ATTEMPT_RELAYS,
    ])
  })

  it("includes relay failure reasons in publish diagnostics", async () => {
    const primaryRelay = "wss://configured-write.conduit.market"
    const fakeEvent = signedTestEvent({
      kind: EVENT_KINDS.RELAY_LIST,
      tags: [
        ["r", "wss://one.conduit.market"],
        ["r", "wss://two.conduit.market", "write"],
      ],
      publish: async () => {
        throw new Error("relay rejected the event kind")
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "author_event",
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).rejects.toThrow(
      "wss://configured-write.conduit.market (relay rejected the event kind)"
    )
  })

  it("retries critical recipient primary relays with a longer timeout", async () => {
    const primaryRelay = "wss://recipient.conduit.market"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: { relayUrls: string[]; timeoutMs: number | undefined }[] =
      []
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown, timeoutMs?: number) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push({ relayUrls, timeoutMs })
        if (attempts.length === 1) {
          throw new Error("recipient relay was slow")
        }
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
      deliveryMode: "critical",
    })

    expect(attempts).toEqual([
      { relayUrls: [normalizedPrimaryRelay], timeoutMs: 10_000 },
      { relayUrls: [normalizedPrimaryRelay], timeoutMs: 15_000 },
    ])
    expect(result.successfulRelayUrls).toEqual([primaryRelay])
    expect(result.failedRelayUrls).toEqual([])
  })

  it("broadens critical recipient delivery to fallback relays after primary retry fails", async () => {
    const primaryRelay = "wss://recipient.conduit.market"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        if (relayUrls.includes(normalizedPrimaryRelay)) {
          throw new Error("recipient relay failed")
        }
        return new Set(relayUrls.slice(0, 1).map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
      deliveryMode: "critical",
    })

    expect(attempts).toHaveLength(3)
    expect(attempts[0]).toEqual([normalizedPrimaryRelay])
    expect(attempts[1]).toEqual([normalizedPrimaryRelay])
    expect(attempts[2]?.length).toBeGreaterThan(0)
    expect(attempts[2]).toContain(APP_WRITE_ATTEMPT_RELAYS[0])
    expect(result.successfulRelayUrls).toEqual([CANONICAL_APP_WRITE_RELAYS[0]])
    expect(result.failedRelayUrls).toContain(primaryRelay)
  })

  it("backfills a capped publish after source policy suppresses the preview target", async () => {
    const personalRelayUrl = "wss://personal-disabled-write.example"
    const appRelayUrl = "wss://app-enabled-write.example"
    const attempts: string[][] = []
    const event = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        signedRelayListAuthoritative: true,
        primaryRelayUrls: [personalRelayUrl],
        primaryCandidateRelayUrls: [personalRelayUrl, appRelayUrl],
        maxPrimaryRelayAttempts: 1,
        broadcastRelayUrls: [],
        broadcastCandidateRelayUrls: [],
        parkedRelayUrls: [],
        appRelayUrls: [appRelayUrl],
        personalRelayUrls: [personalRelayUrl],
      }),
    })

    const result = await publishWithPlanner(event, {
      intent: "author_event",
      authorPubkey: AUTHOR_PUBKEY,
      authenticatedPubkey: AUTHOR_PUBKEY,
      accountPubkey: AUTHOR_PUBKEY,
      accountNetworkLocalStateRepository: {
        get: async (pubkey) =>
          accountNetworkState(pubkey, [], {
            appRelaysEnabled: true,
            personalRelaysEnabled: false,
          }),
      },
    })

    expect(attempts).toEqual([[`${appRelayUrl}/`]])
    expect(result.attemptedRelayUrls).toEqual([appRelayUrl])
  })

  it("filters a stale publish plan by explicit account without changing other or public callers", async () => {
    const relayUrl = "wss://stale-publish-plan.conduit.market"
    const attempts: string[][] = []
    const queriedPubkeys: string[] = []
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        queriedPubkeys.push(pubkey)
        return accountNetworkState(
          pubkey,
          pubkey === AUTHOR_PUBKEY ? [relayUrl] : []
        )
      },
    }
    const event = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        signedRelayListAuthoritative: true,
        primaryRelayUrls: [relayUrl],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: AUTHOR_PUBKEY,
        accountPubkey: AUTHOR_PUBKEY,
        accountNetworkLocalStateRepository: repository,
      })
    ).rejects.toThrow("no primary relay accepted")
    await expect(
      publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: AUTHOR_PUBKEY,
        accountPubkey: OTHER_AUTHOR_PUBKEY,
        accountNetworkLocalStateRepository: repository,
      })
    ).resolves.toMatchObject({ attemptedRelayUrls: [relayUrl] })
    const explicitAccountQueryCount = queriedPubkeys.length
    await expect(
      publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: AUTHOR_PUBKEY,
        accountNetworkLocalStateRepository: repository,
      })
    ).resolves.toMatchObject({ attemptedRelayUrls: [relayUrl] })

    expect(attempts).toEqual([[`${relayUrl}/`], [`${relayUrl}/`]])
    expect(queriedPubkeys).toHaveLength(explicitAccountQueryCount)
    expect(new Set(queriedPubkeys)).toEqual(
      new Set([AUTHOR_PUBKEY, OTHER_AUTHOR_PUBKEY])
    )
  })

  it("re-checks a broadcast target after the primary attempt commits its removal", async () => {
    const primaryRelay = "wss://primary-before-removal.conduit.market"
    const broadcastRelay = "wss://removed-broadcast.conduit.market"
    const attempts: string[][] = []
    let removalCommitted = false
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) =>
        accountNetworkState(pubkey, removalCommitted ? [broadcastRelay] : []),
    }
    const event = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        removalCommitted = true
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [broadcastRelay],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(event, {
      intent: "author_event",
      authorPubkey: AUTHOR_PUBKEY,
      accountPubkey: AUTHOR_PUBKEY,
      accountNetworkLocalStateRepository: repository,
    })

    expect(attempts).toEqual([[`${primaryRelay}/`]])
    expect(result.attemptedRelayUrls).toEqual([primaryRelay])
    expect(result.successfulRelayUrls).toEqual([primaryRelay])
    expect(result.failedRelayUrls).toEqual([])
  })

  it("refuses an excluded exclusive target without entering NDK publish", async () => {
    const relayUrl = "wss://excluded-private-inbox.conduit.market"
    let publishCalls = 0
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => accountNetworkState(pubkey, [relayUrl]),
    }
    const event = signedTestEvent({
      kind: EVENT_KINDS.GIFT_WRAP,
      publish: async () => {
        publishCalls += 1
        return new Set()
      },
    })

    await expect(
      publishWithPlanner(event, {
        intent: "recipient_event",
        authorPubkey: "alice",
        recipientPubkeys: ["bob"],
        exclusiveRelayUrls: [relayUrl],
        accountPubkey: AUTHOR_PUBKEY,
        accountNetworkLocalStateRepository: repository,
      })
    ).rejects.toThrow("required exclusive relay set")
    expect(publishCalls).toBe(0)
  })

  it("suppresses retry and recipient fallback relays removed after the primary attempt", async () => {
    const primaryRelay = "wss://removed-between-attempts.conduit.market"
    const excludedAfterCommit = Array.from(
      new Set([
        primaryRelay,
        ...config.appWriteRelayUrls,
        ...config.commerceDmFallbackRelayUrls,
      ])
    )
    const attempts: string[][] = []
    let removalCommitted = false
    let durableReads = 0
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        durableReads += 1
        return accountNetworkState(
          pubkey,
          removalCommitted ? excludedAfterCommit : []
        )
      },
    }
    const event = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        removalCommitted = true
        throw new Error("primary failed after local removal committed")
      },
    })
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(event, {
        intent: "recipient_event",
        authorPubkey: "alice",
        recipientPubkeys: ["bob"],
        deliveryMode: "critical",
        accountPubkey: AUTHOR_PUBKEY,
        accountNetworkLocalStateRepository: repository,
      })
    ).rejects.toThrow("no account-eligible relay target remains")

    expect(attempts).toEqual([[`${primaryRelay}/`]])
    expect(durableReads).toBeGreaterThanOrEqual(3)
  })

  it("suppresses an excluded exact publish without inferring the account from its author", async () => {
    const relayUrl = "wss://excluded-exact-publish.conduit.market"
    const fakeWebSocket = installRelayPublishWebSocket()
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => accountNetworkState(pubkey, [relayUrl]),
    }
    const signedEvent = signedRawTestEvent({ kind: EVENT_KINDS.DELETION })

    try {
      await expect(
        publishSignedEventToRelay({
          signedEvent,
          relayUrl,
          authorPubkey: AUTHOR_PUBKEY,
          accountPubkey: AUTHOR_PUBKEY,
          accountNetworkLocalStateRepository: repository,
        })
      ).rejects.toThrow("exact relay is not eligible")
      expect(fakeWebSocket.counters.opened).toBe(0)

      await expect(
        publishSignedEventToRelay({
          signedEvent,
          relayUrl,
          authorPubkey: AUTHOR_PUBKEY,
          accountNetworkLocalStateRepository: repository,
        })
      ).resolves.toBe("acked")
      expect(fakeWebSocket.openedUrls).toEqual([relayUrl])
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("does not fall through to NDK default publishing without an approved target", async () => {
    let publishCalls = 0
    const fakeEvent = signedTestEvent({
      publish: async () => {
        publishCalls += 1
        return new Set()
      },
    })
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "recipient_event",
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).rejects.toThrow("without an approved relay target")
    expect(publishCalls).toBe(0)
  })
})

describe("deriveRelayOutcomes", () => {
  const A = "wss://a.conduit.market"
  const B = "wss://b.conduit.market"
  const C = "wss://c.conduit.market"

  it("marks every attempted relay as successful when all are acked", () => {
    const result = deriveRelayOutcomes({
      attemptedRelayUrls: [A, B],
      publishedUrls: [A, B],
    })
    expect(result.successfulRelayUrls.sort()).toEqual([A, B].sort())
    expect(result.failedRelayUrls).toEqual([])
  })

  it("marks unacked attempted relays as failed (timeout case)", () => {
    const result = deriveRelayOutcomes({
      attemptedRelayUrls: [A, B, C],
      publishedUrls: [A],
    })
    expect(result.successfulRelayUrls).toEqual([A])
    expect(result.failedRelayUrls.sort()).toEqual([B, C].sort())
  })

  it("honors partial-failure split from NDKPublishError", () => {
    // NDK acked A; reported explicit error for B; C silently dropped.
    const result = deriveRelayOutcomes({
      attemptedRelayUrls: [A, B, C],
      publishedUrls: [A],
      failedUrls: [B],
    })
    expect(result.successfulRelayUrls).toEqual([A])
    expect(result.failedRelayUrls.sort()).toEqual([B, C].sort())
  })

  it("does not double-count: success wins over failure for the same URL", () => {
    // Defensive: should the report list a URL in both buckets, treat it as
    // success so we don't punish a relay that actually accepted the event.
    const result = deriveRelayOutcomes({
      attemptedRelayUrls: [A, B],
      publishedUrls: [A],
      failedUrls: [A, B],
    })
    expect(result.successfulRelayUrls).toEqual([A])
    expect(result.failedRelayUrls).toEqual([B])
  })

  it("ignores URLs not in the attempted set", () => {
    const result = deriveRelayOutcomes({
      attemptedRelayUrls: [A],
      publishedUrls: [B],
      failedUrls: [C],
    })
    expect(result.successfulRelayUrls).toEqual([])
    expect(result.failedRelayUrls).toEqual([A])
  })
})
