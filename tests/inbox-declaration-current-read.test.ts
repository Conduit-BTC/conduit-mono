import { afterEach, describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  __resetInboxDeclarationCache,
  resolveInboxDeclaration,
  sharedInboxDiscoveryRelayUrls,
} from "../packages/core/src/protocol/private-message-routing"
import {
  applyInboxDeclarationDistributionStage,
  createInMemoryInboxDeclarationEvidenceRepository,
  INBOX_DECLARATION_CUTOVER_GRACE_MS,
  INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
} from "../packages/core/src/protocol/inbox-declaration-evidence"
import {
  __resetPublicReaderTestState,
  fetchPublicEventsWithDiagnostics,
  type PublicRelayReadDiagnosticsResult,
} from "../packages/core/src/protocol/relay-reader"
import { admitFixture } from "./helpers/public-event"

const NOW = 1_800_000_000_000
const [FIRST, SECOND] = sharedInboxDiscoveryRelayUrls()

function readerFixture(
  mode:
    | "complete"
    | "timeout"
    | "degraded"
    | "resource_cap"
    | "malformed"
    | "unsigned"
    | "cutover"
) {
  const declaration = finalizeEvent(
    {
      kind: 10_050,
      created_at: NOW / 1_000,
      tags:
        mode === "malformed"
          ? [["relay", "ftp://not-an-inbox.example"], ["relay"]]
          : [["relay", "wss://current.inbox.conduit.market"]],
      content: "",
    },
    generateSecretKey()
  )
  const sockets: Socket[] = []
  class Socket {
    readyState = 0
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null

    constructor(readonly url: string) {
      sockets.push(this)
      queueMicrotask(() => {
        if (this.readyState === 3) return
        this.readyState = 1
        this.onopen?.(new Event("open"))
      })
    }

    send(payload: string) {
      const frame = JSON.parse(payload) as unknown[]
      if (frame[0] !== "REQ") return
      const id = String(frame[1])
      queueMicrotask(() => {
        if (mode === "degraded" && this.url === SECOND) {
          this.onerror?.(new Event("error"))
          return
        }
        this.emit([
          "EVENT",
          id,
          mode === "unsigned"
            ? { ...declaration, sig: undefined }
            : declaration,
        ])
        if (mode === "resource_cap") {
          for (let index = 0; index < 256; index++)
            this.emit(["EVENT", id, declaration])
        }
        if (mode !== "timeout") this.emit(["EOSE", id])
      })
    }

    emit(frame: unknown[]) {
      this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
    }

    close() {
      this.readyState = 3
    }
  }

  let diagnostics: PublicRelayReadDiagnosticsResult | undefined
  let repository = createInMemoryInboxDeclarationEvidenceRepository()
  const queries: {
    limit?: number
    ids?: string[]
    maxEventsPerRelay?: number
  }[] = []
  const relayUrls = mode === "degraded" ? [FIRST!, SECOND!] : [FIRST!]
  return {
    declaration,
    sockets,
    queries,
    repository: () => repository,
    diagnostics: () => diagnostics,
    resolve: async () => {
      if (mode === "cutover") {
        const staged = applyInboxDeclarationDistributionStage(
          undefined,
          {
            pubkey: declaration.pubkey,
            signedEvent: await admitFixture(declaration),
            publishRelayUrls: [FIRST!],
            previousRelayUrls: ["wss://previous.inbox.conduit.market"],
            cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
            cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
            expectedCurrentEventId: null,
            stagedAt: NOW - 1,
          },
          () => NOW
        )
        repository = createInMemoryInboxDeclarationEvidenceRepository([staged])
      }
      return resolveInboxDeclaration(declaration.pubkey, {
        now: () => NOW,
        relayUrls,
        evidenceRepository: repository,
        fetchEventsWithDiagnostics: async (filter, options) => {
          queries.push({
            limit: filter.limit,
            ids: filter.ids,
            maxEventsPerRelay: options?.maxEventsPerRelay,
          })
          diagnostics = await fetchPublicEventsWithDiagnostics(filter, {
            ...options,
            socketScope: { createWebSocket: (url) => new Socket(url) },
            reuseRelayConnections: false,
            connectTimeoutMs: 100,
            fetchTimeoutMs: 100,
          })
          return diagnostics
        },
      })
    },
  }
}

afterEach(() => {
  __resetInboxDeclarationCache()
  __resetPublicReaderTestState()
})

describe("current signed inbox declaration through the real public reader", () => {
  it("keeps a single matching declaration plus EOSE current, not capped or stale", async () => {
    const fixture = readerFixture("complete")
    const result = await fixture.resolve()
    expect(result.state).toBe("declared")
    expect(result.eventId).toBe(fixture.declaration.id)
    expect(fixture.diagnostics()?.readCoverage).toBe("complete")
    expect(fixture.diagnostics()?.relays[0]?.outcome).toBe("eose")
    expect(result.observation?.coverage).toBe("complete")
    expect(result.stale).toBe(false)
    expect(fixture.diagnostics()?.cappedRelayUrls).toEqual([])
    expect(fixture.queries).toEqual([
      { limit: undefined, ids: undefined, maxEventsPerRelay: 256 },
    ])
    expect(result.sourceRelayUrls).toEqual([FIRST!])
    expect(fixture.sockets.every((socket) => socket.readyState === 3)).toBe(
      true
    )
  })

  for (const mode of ["timeout", "degraded", "resource_cap"] as const) {
    it(`retains signed authority but keeps ${mode} evidence incomplete and stale`, async () => {
      const fixture = readerFixture(mode)
      const result = await fixture.resolve()
      expect(result.state).toBe("declared")
      expect(result.eventId).toBe(fixture.declaration.id)
      expect(result.observation?.coverage).toBe(
        mode === "timeout" ? "unavailable" : "partial"
      )
      expect(result.stale).toBe(true)
      expect(result.sourceRelayUrls).toEqual(mode === "timeout" ? [] : [FIRST!])
      expect(fixture.sockets.every((socket) => socket.readyState === 3)).toBe(
        true
      )
    })
  }

  it("confirms exact staged cutover bytes with EOSE before starting the recovery clock", async () => {
    const fixture = readerFixture("cutover")
    const result = await fixture.resolve()
    expect(result.state).toBe("declared")
    expect(result.stale).toBe(false)
    expect(
      fixture.queries.find((query) => query.ids?.[0] === fixture.declaration.id)
    ).toEqual({
      ids: [fixture.declaration.id],
      limit: 1,
      maxEventsPerRelay: undefined,
    })
    expect(fixture.queries.filter((query) => !query.ids)).toEqual([
      { limit: undefined, ids: undefined, maxEventsPerRelay: 256 },
    ])
    const saved = await fixture.repository().get(fixture.declaration.pubkey)
    expect(saved?.pendingDistribution).toBeUndefined()
    expect(saved?.cutoverRecoveries?.[0]).toMatchObject({
      readbackObservedAt: NOW,
      expiresAt: NOW + INBOX_DECLARATION_CUTOVER_GRACE_MS,
    })
  })

  it("keeps a genuinely signed malformed frontier distinct from missing evidence", async () => {
    const fixture = readerFixture("malformed")
    const result = await fixture.resolve()
    expect(result.state).toBe("malformed")
    expect(result.eventId).toBe(fixture.declaration.id)
    expect(result.observation?.coverage).toBe("complete")
    expect(result.relayUrls).toEqual([])
  })

  it("rejects unsigned wire data without inventing scoped absence or authority", async () => {
    const fixture = readerFixture("unsigned")
    const result = await fixture.resolve()
    expect(result.state).toBe("lookup_unavailable")
    expect(result.observation?.coverage).toBe("unavailable")
    expect(result.eventId).toBeUndefined()
    expect(result.relayUrls).toEqual([])
    expect(
      await fixture.repository().get(fixture.declaration.pubkey)
    ).toBeUndefined()
  })
})
