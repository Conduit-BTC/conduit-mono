import { afterEach, describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import { createInMemoryAccountNetworkLocalStateRepository } from "../packages/core/src/protocol/account-network-local-state"
import {
  visitProtectedInboxHistoryPage,
  type ProtectedInboxHistoryCursor,
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
import type { SignedNostrEvent } from "../packages/core/src/protocol/nostr-event-signer"
import type {
  CommerceRelayExecutor,
  RelayRequest,
} from "../packages/core/src/protocol/relay-executor"

const TEST_KEY = new Uint8Array(32).fill(21)
const PRINCIPAL = getPublicKey(TEST_KEY)
const RELAY = "wss://owner-inbox.example"

afterEach(() => __resetProtectedReadSigner())

function authorize(hasAuthority: () => boolean = () => true) {
  installProtectedReadSigner(
    {
      authMethod: "nip07",
      getPublicKey: async () => PRINCIPAL,
      signEvent: async (event) => finalizeEvent(event, TEST_KEY),
    },
    PRINCIPAL,
    hasAuthority
  )
  const authorization = getProtectedReadAuthorization(PRINCIPAL)
  if (!authorization) throw new Error("Synthetic signer authorization missing")
  return authorization
}

function wrap(createdAt: number, index: number): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: 1_059,
      created_at: createdAt,
      tags: [["p", PRINCIPAL]],
      content: `test-only-encrypted-${index}`,
    },
    TEST_KEY
  )
}

function protectedResult(
  events: SignedNostrEvent[],
  eventCount = events.length,
  coverage: ProtectedInboxReadResult["coverage"] = "complete"
): ProtectedInboxReadResult {
  const status = coverage === "complete" ? "success" : coverage
  return {
    events,
    coverage,
    auth: {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status,
      observations: [],
      relays: [
        {
          relayIndex: 0,
          status: coverage === "complete" ? "success" : "partial",
          auth: "not_challenged",
          eventCount,
          duplicateCount: 0,
          malformedCount: 0,
          unusableCount: 0,
        },
      ],
      attemptedCount: 1,
      completedCount: coverage === "complete" ? 1 : 0,
      failedCount: coverage === "unavailable" ? 1 : 0,
      authoritativeEmpty: events.length === 0 && coverage === "complete",
    },
  }
}

function options(
  authorization: ReturnType<typeof authorize>,
  read: (input: ReadProtectedInboxOptions) => Promise<ProtectedInboxReadResult>,
  visit: (event: SignedNostrEvent) => Promise<void>,
  cursor?: ProtectedInboxHistoryCursor
) {
  return {
    principalPubkey: PRINCIPAL,
    relayUrl: RELAY,
    declaredRelayUrls: [RELAY],
    authorization,
    read,
    visit,
    ...(cursor ? { cursor } : {}),
  }
}

describe("protected inbox history page", () => {
  it("adds inclusive bounds without weakening the exact kind, recipient or protected authority", async () => {
    const authorization = authorize()
    let request: RelayRequest | null = null
    const executor: CommerceRelayExecutor = {
      async *req() {},
      async query(input) {
        request = input
        return {
          status: "success",
          events: [],
          observations: [],
          relays: [],
          attemptedCount: 0,
          completedCount: 0,
          failedCount: 0,
          authoritativeEmpty: false,
        }
      },
    }
    await readProtectedInbox({
      principalPubkey: PRINCIPAL,
      relayUrls: [RELAY],
      ownerSelectedRelayUrls: [RELAY],
      appRelayUrls: [],
      limit: 50,
      since: 100,
      until: 200,
      authorization,
      executor,
      accountNetworkLocalStateRepository:
        createInMemoryAccountNetworkLocalStateRepository(),
    })
    expect(request?.operation).toBe("private_inbox_read")
    expect(request?.filters).toEqual([
      {
        kinds: [1_059],
        "#p": [PRINCIPAL],
        since: 100,
        until: 200,
        limit: 50,
      },
    ])
    await expect(
      readProtectedInbox({
        principalPubkey: PRINCIPAL,
        relayUrls: [RELAY],
        limit: 50,
        since: 201,
        until: 200,
        authorization,
        executor,
      })
    ).rejects.toThrow("time bounds are invalid")
  })

  it("visits a clean short page without returning private wraps", async () => {
    const authorization = authorize()
    const events = [wrap(200, 1), wrap(199, 2)]
    const visited: string[] = []
    const result = await visitProtectedInboxHistoryPage(
      options(
        authorization,
        async (input) => {
          expect(input.relayUrls).toEqual([RELAY])
          expect(input.ownerSelectedRelayUrls).toEqual([RELAY])
          expect(input.appRelayUrls).toEqual([])
          expect(input.limit).toBe(50)
          expect(input.authorization).toBe(authorization)
          return protectedResult(events)
        },
        async (event) => {
          visited.push(event.id)
        }
      )
    )
    expect(visited).toEqual(events.map((event) => event.id))
    expect(result).toEqual({
      status: "source_eose",
      visitedCount: 2,
      nextCursor: null,
    })
    expect(JSON.stringify(result)).not.toContain("test-only-encrypted")
  })

  it("checks the inclusive timestamp tie before advancing to older wraps", async () => {
    const authorization = authorize()
    const events = Array.from({ length: 50 }, (_, index) =>
      wrap(200 - index, index)
    )
    const seen: ReadProtectedInboxOptions[] = []
    const visited: string[] = []
    const result = await visitProtectedInboxHistoryPage(
      options(
        authorization,
        async (input) => {
          seen.push(input)
          return input.since === undefined
            ? protectedResult(events)
            : protectedResult([events[49]!])
        },
        async (event) => {
          visited.push(event.id)
        }
      )
    )
    expect(
      seen.map(({ limit, since, until }) => ({ limit, since, until }))
    ).toEqual([
      { limit: 50, since: undefined, until: undefined },
      { limit: 512, since: 151, until: 151 },
    ])
    expect(visited).toHaveLength(50)
    expect(result).toEqual({
      status: "advanced",
      visitedCount: 50,
      nextCursor: {
        sessionScope: authorization.sessionScope,
        relayUrl: RELAY,
        until: 150,
      },
    })
  })

  it("refuses an overfull same-second tie instead of skipping unseen wraps", async () => {
    const authorization = authorize()
    const events = Array.from({ length: 50 }, (_, index) => wrap(100, index))
    const extra = wrap(100, 50)
    let visits = 0
    const result = await visitProtectedInboxHistoryPage(
      options(
        authorization,
        async (input) =>
          input.since === undefined
            ? protectedResult(events)
            : protectedResult([...events, extra]),
        async () => {
          visits += 1
        }
      )
    )
    expect(result.status).toBe("capped")
    expect(result.nextCursor).toBeNull()
    expect(visits).toBe(0)
  })

  it("resumes only on the same session and relay, keeping later EOSE scoped", async () => {
    const authorization = authorize()
    const events = Array.from({ length: 50 }, (_, index) =>
      wrap(200 - index, index)
    )
    const read = async (input: ReadProtectedInboxOptions) => {
      if (input.since !== undefined) return protectedResult([events[49]!])
      return input.until === undefined
        ? protectedResult(events)
        : protectedResult([wrap(100, 60)])
    }
    const first = await visitProtectedInboxHistoryPage(
      options(authorization, read, async () => {})
    )
    expect(first.status).toBe("advanced")
    const second = await visitProtectedInboxHistoryPage(
      options(authorization, read, async () => {}, first.nextCursor!)
    )
    expect(second).toEqual({
      status: "source_eose",
      visitedCount: 1,
      nextCursor: null,
    })
    expect(
      Object.keys(second).some(
        (key) => key.includes("global") || key === "complete"
      )
    ).toBe(false)
    await expect(
      visitProtectedInboxHistoryPage(
        options(authorization, read, async () => {}, {
          sessionScope: "another-session",
          relayUrl: RELAY,
          until: 150,
        })
      )
    ).rejects.toThrow("cursor is invalid")
  })

  it("retains the old cursor when reads degrade or visit budget expires", async () => {
    const authorization = authorize()
    const cursor = {
      sessionScope: authorization.sessionScope,
      relayUrl: RELAY,
      until: 150,
    }
    const partial = await visitProtectedInboxHistoryPage(
      options(
        authorization,
        async () => protectedResult([wrap(100, 1)], 1, "partial"),
        async () => {
          throw new Error("Should not inspect partial read")
        },
        cursor
      )
    )
    expect(partial).toEqual({
      status: "partial",
      visitedCount: 0,
      nextCursor: cursor,
    })
    let currentMs = 0
    const visited: string[] = []
    const budget = await visitProtectedInboxHistoryPage({
      ...options(
        authorization,
        async () => protectedResult([wrap(100, 2), wrap(99, 3)]),
        async (event) => {
          visited.push(event.id)
          currentMs = 15_000
        },
        cursor
      ),
      now: () => currentMs,
    })
    expect(visited).toHaveLength(1)
    expect(budget).toEqual({
      status: "partial",
      visitedCount: 1,
      nextCursor: cursor,
    })
  })

  it("does not interpret an inconsistent relay event count as a clean EOSE", async () => {
    const authorization = authorize()
    let visited = false
    const result = await visitProtectedInboxHistoryPage(
      options(
        authorization,
        async () => protectedResult([], 49),
        async () => {
          visited = true
        }
      )
    )
    expect(result).toEqual({
      status: "partial",
      visitedCount: 0,
      nextCursor: null,
    })
    expect(visited).toBe(false)
  })

  it("rejects undeclared relays and revocation before a visitor sees a wrap", async () => {
    let active = true
    const authorization = authorize(() => active)
    let reads = 0
    await expect(
      visitProtectedInboxHistoryPage({
        ...options(
          authorization,
          async () => {
            reads += 1
            return protectedResult([])
          },
          async () => {}
        ),
        declaredRelayUrls: ["wss://other.example"],
      })
    ).rejects.toThrow("not owner-selected")
    expect(reads).toBe(0)
    const read = async () => {
      active = false
      return protectedResult([wrap(100, 1)])
    }
    let visited = false
    await expect(
      visitProtectedInboxHistoryPage(
        options(authorization, read, async () => {
          visited = true
        })
      )
    ).rejects.toThrow("authority is unavailable")
    expect(visited).toBe(false)
  })
})
