import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { createInMemoryAccountNetworkLocalStateRepository } from "../packages/core/src/protocol/account-network-local-state"
import {
  bindProtectedInboxHistoryCursor,
  visitProtectedInboxHistoryPage,
} from "../packages/core/src/protocol/protected-inbox-history"
import {
  readProtectedInbox,
  type ProtectedInboxReadResult,
  type ReadProtectedInboxOptions,
} from "../packages/core/src/protocol/protected-inbox-read"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type {
  NostrEventSigner,
  SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"
import {
  WebSocketCommerceRelayExecutor,
  type RelayWebSocket,
} from "../packages/core/src/protocol/relay-executor"

const ACCOUNT_KEY = generateSecretKey()
const WRAPPER_KEY = generateSecretKey()
const ACCOUNT = getPublicKey(ACCOUNT_KEY)
const RELAY = "wss://inbox.example"

function authorization() {
  const signer: NostrEventSigner = {
    authMethod: "nip07",
    getPublicKey: async () => ACCOUNT,
    signEvent: async (event) => finalizeEvent(event, ACCOUNT_KEY),
  }
  installProtectedReadSigner(signer, ACCOUNT, () => true)
  const value = getProtectedReadAuthorization(ACCOUNT)
  if (!value) throw new Error("Expected authorization")
  return value
}

function wrap(index: number, createdAt: number): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: 1_059,
      created_at: createdAt,
      tags: [["p", ACCOUNT]],
      content: `synthetic-${index}`,
    },
    WRAPPER_KEY
  )
}

function result(
  events: SignedNostrEvent[],
  status: "complete" | "partial" | "unavailable" = "complete",
  eose = status === "complete"
): ProtectedInboxReadResult {
  return {
    events,
    coverage: status,
    auth: {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status:
        status === "complete"
          ? "success"
          : status === "partial"
            ? "partial"
            : "unavailable",
      observations: eose ? [{ type: "eose", relayIndex: 0 }] : [],
      relays: [
        {
          relayIndex: 0,
          status: status === "complete" ? "success" : "failed",
          auth: "not_challenged",
          eventCount: events.length,
          duplicateCount: 0,
          malformedCount: 0,
          unusableCount: 0,
        },
      ],
      attemptedCount: 1,
      completedCount: status === "complete" ? 1 : 0,
      failedCount: status === "complete" ? 0 : 1,
      authoritativeEmpty: status === "complete" && events.length === 0,
    },
  }
}

function boundedRead(events: SignedNostrEvent[]) {
  const calls: ReadProtectedInboxOptions[] = []
  const read = async (
    options: ReadProtectedInboxOptions
  ): Promise<ProtectedInboxReadResult> => {
    calls.push(options)
    const selected = events
      .filter(
        (event) =>
          (options.since === undefined || event.created_at >= options.since) &&
          (options.until === undefined || event.created_at <= options.until)
      )
      .sort(
        (left, right) =>
          right.created_at - left.created_at || left.id.localeCompare(right.id)
      )
      .slice(0, options.limit)
    return result(selected)
  }
  return { read, calls }
}

beforeEach(() => __resetProtectedReadSigner())
afterEach(() => __resetProtectedReadSigner())

describe("protected inbox history paging", () => {
  it("visits more than 400 signed wrappers across descending windows without an age cutoff", async () => {
    const auth = authorization()
    const events = Array.from({ length: 430 }, (_, index) =>
      wrap(index, 1_700_000_000 - Math.floor(index / 23))
    )
    const { read, calls } = boundedRead(events)
    const seen = new Set<string>()
    let cursor: Awaited<
      ReturnType<typeof visitProtectedInboxHistoryPage>
    >["nextCursor"] = null
    let status = ""
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const page = await visitProtectedInboxHistoryPage({
        principalPubkey: ACCOUNT,
        relayUrl: RELAY,
        authorizedRelayUrls: [RELAY],
        authorization: auth,
        ...(cursor ? { cursor } : {}),
        read,
        visit: async (event) => {
          expect(seen.has(event.id)).toBe(false)
          seen.add(event.id)
        },
      })
      status = page.status
      cursor = page.nextCursor
      if (status === "source_eose") {
        expect(page.range.eose).toBe(true)
        break
      }
      expect(status).toBe("advanced")
    }
    expect(status).toBe("source_eose")
    expect(seen.size).toBe(430)
    expect(calls.every((call) => call.relayUrls.length === 1)).toBe(true)
    expect(calls.every((call) => call.principalPubkey === ACCOUNT)).toBe(true)
  })

  it("deduplicates the inclusive boundary and processes 430 same-second wraps", async () => {
    const auth = authorization()
    const events = Array.from({ length: 430 }, (_, index) =>
      wrap(index, 1_650_000_000)
    )
    const { read, calls } = boundedRead(events)
    const seen = new Set<string>()
    const page = await visitProtectedInboxHistoryPage({
      principalPubkey: ACCOUNT,
      relayUrl: RELAY,
      authorizedRelayUrls: [RELAY],
      authorization: auth,
      read,
      visit: async (event) => {
        expect(seen.has(event.id)).toBe(false)
        seen.add(event.id)
      },
    })
    expect(page.status).toBe("advanced")
    expect(page.visitedCount).toBe(430)
    expect(page.nextCursor?.until).toBe(1_649_999_999)
    expect(page.range.observedCount).toBe(430)
    expect(calls[1]?.since).toBe(1_650_000_000)
    expect(calls[1]?.until).toBe(1_650_000_000)
  })

  it("keeps its cursor on incomplete coverage while retaining valid positive observations", async () => {
    const auth = authorization()
    const events = Array.from({ length: 512 }, (_, index) =>
      wrap(index, 1_650_000_000)
    )
    const { read } = boundedRead(events)
    const visited: string[] = []
    const options = {
      principalPubkey: ACCOUNT,
      relayUrl: RELAY,
      authorizedRelayUrls: [RELAY],
      authorization: auth,
      visit: async (event: SignedNostrEvent) => {
        visited.push(event.id)
      },
    }
    const capped = await visitProtectedInboxHistoryPage({ ...options, read })
    expect(capped.status).toBe("capped")
    expect(capped.nextCursor).toBeNull()
    expect(visited).toHaveLength(512)
    visited.length = 0

    const partial = await visitProtectedInboxHistoryPage({
      ...options,
      read: async () => result(events.slice(0, 10), "partial", false),
    })
    expect(partial.status).toBe("partial")
    expect(partial.range.eose).toBe(false)
    expect(visited).toHaveLength(10)
    expect(partial.nextCursor).toBeNull()
    visited.length = 0

    let calls = 0
    const boundaryPartial = await visitProtectedInboxHistoryPage({
      ...options,
      read: async () => {
        calls += 1
        return calls === 1
          ? result(events.slice(0, 50))
          : result(events.slice(0, 10), "partial", false)
      },
    })
    expect(boundaryPartial.status).toBe("partial")
    expect(boundaryPartial.nextCursor).toBeNull()
    expect(visited).toHaveLength(50)
    visited.length = 0
    const invalid = { ...events[0]!, content: "tampered" }
    const mixed = await visitProtectedInboxHistoryPage({
      ...options,
      read: async () => result([invalid, events[1]!], "partial", false),
    })
    expect(mixed.status).toBe("partial")
    expect(mixed.nextCursor).toBeNull()
    expect(visited).toEqual([events[1]!.id])
  })

  it("rebinds a stored cursor to current signer authority and rejects stale scope", async () => {
    const first = authorization()
    const stored = { relayUrl: RELAY, until: 1_650_000_000 }
    const stale = bindProtectedInboxHistoryCursor(stored, first)
    const current = authorization()
    const { read } = boundedRead([])
    await expect(
      visitProtectedInboxHistoryPage({
        principalPubkey: ACCOUNT,
        relayUrl: RELAY,
        authorizedRelayUrls: [RELAY],
        authorization: current,
        cursor: stale,
        read,
        visit: async () => {},
      })
    ).rejects.toThrow("cursor is invalid")
    const rebound = bindProtectedInboxHistoryCursor(stored, current)
    const page = await visitProtectedInboxHistoryPage({
      principalPubkey: ACCOUNT,
      relayUrl: RELAY,
      authorizedRelayUrls: [RELAY],
      authorization: current,
      cursor: rebound,
      read,
      visit: async () => {},
    })
    expect(page.status).toBe("source_eose")
    expect(page.range.until).toBe(stored.until)
  })
})

class Socket implements RelayWebSocket {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent | Event) => void) | null = null
  readonly sent: unknown[][] = []
  private eoseSent = false

  constructor(private readonly event: SignedNostrEvent) {
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.(new Event("open"))
      this.relay(["AUTH", "test-challenge"])
    })
  }

  send(payload: string): void {
    const frame = JSON.parse(payload) as unknown[]
    this.sent.push(frame)
    if (frame[0] === "AUTH") {
      const authEvent = frame[1] as SignedNostrEvent
      queueMicrotask(() => this.relay(["OK", authEvent.id, true, ""]))
    }
    if (frame[0] === "REQ") {
      const sub = frame[1]
      this.relay(["EVENT", sub, this.event])
      queueMicrotask(() => {
        this.eoseSent = true
        this.relay(["EOSE", sub])
      })
    }
  }

  get didSendEose(): boolean {
    return this.eoseSent
  }

  close(): void {
    this.readyState = 3
    this.onclose?.(new Event("close"))
  }

  private relay(frame: unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
  }
}

it("streams a signed recipient wrapper after NIP-42 auth and before EOSE", async () => {
  const auth = authorization()
  const event = wrap(1, 1_700_000_000)
  let socket: Socket | null = null
  const executor = new WebSocketCommerceRelayExecutor({
    createWebSocket: () => {
      socket = new Socket(event)
      return socket
    },
    now: () => 1_700_000_000_000,
    createSubscriptionId: () => "history-test",
  })
  try {
    const observed: SignedNostrEvent[] = []
    let beforeEose = false
    const read = await readProtectedInbox({
      principalPubkey: ACCOUNT,
      relayUrls: [RELAY],
      ownerSelectedRelayUrls: [RELAY],
      limit: 10,
      since: 1_699_999_999,
      until: 1_700_000_001,
      authorization: auth,
      executor,
      accountNetworkLocalStateRepository:
        createInMemoryAccountNetworkLocalStateRepository(),
      onEvent: (received) => {
        observed.push(received)
        beforeEose = socket?.didSendEose === false
      },
    })
    expect(read.coverage).toBe("complete")
    expect(observed.map((value) => value.id)).toEqual([event.id])
    expect(beforeEose).toBe(true)
    const req = socket?.sent.find((frame) => frame[0] === "REQ")
    expect(req?.[2]).toMatchObject({
      kinds: [1_059],
      "#p": [ACCOUNT],
      since: 1_699_999_999,
      until: 1_700_000_001,
    })
  } finally {
    executor.dispose()
  }
})
