import { afterEach, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  __resetPublicReaderTestState,
  fetchSignedEventsFanoutDetailed,
} from "../packages/core/src/protocol/relay-reader"
import { WebSocketCommerceRelayExecutor } from "../packages/core/src/protocol/relay-executor"

const originalWebSocket = Object.getOwnPropertyDescriptor(
  globalThis,
  "WebSocket"
)
const secretKey = generateSecretKey()
const newest = finalizeEvent(
  { kind: 0, content: "newest", tags: [], created_at: 200 },
  secretKey
)
const older = finalizeEvent(
  { kind: 0, content: "older", tags: [], created_at: 100 },
  secretKey
)
const wrongKind = finalizeEvent(
  { kind: 1, content: "outside filter", tags: [], created_at: 150 },
  secretKey
)
let responseEvents = [newest, newest, older]

class DuplicateRelaySocket {
  static OPEN = 1
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null

  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = DuplicateRelaySocket.OPEN
      this.onopen?.(new Event("open"))
    })
  }

  send(payload: string): void {
    const frame = JSON.parse(payload) as unknown[]
    if (frame[0] !== "REQ") return
    const subscriptionId = frame[1]
    queueMicrotask(() => {
      for (const event of responseEvents) {
        this.onmessage?.({
          data: JSON.stringify(["EVENT", subscriptionId, event]),
        } as MessageEvent<string>)
      }
      this.onmessage?.({
        data: JSON.stringify(["EOSE", subscriptionId]),
      } as MessageEvent<string>)
    })
  }

  close(): void {
    this.readyState = 3
  }
}

afterEach(() => {
  __resetPublicReaderTestState()
  responseEvents = [newest, newest, older]
  if (originalWebSocket)
    Object.defineProperty(globalThis, "WebSocket", originalWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

it("counts unique events toward the filter limit while retaining duplicate evidence", async () => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: DuplicateRelaySocket,
  })

  const read = await fetchSignedEventsFanoutDetailed(
    { kinds: [0], limit: 2 },
    {
      relayUrls: ["wss://duplicate.example"],
      skipHealthFilter: true,
      reuseRelayConnections: false,
      connectTimeoutMs: 50,
      fetchTimeoutMs: 50,
    }
  )

  expect(read.events.map((event) => event.id)).toEqual([newest.id, older.id])
  expect(read.relays[0]).toMatchObject({
    status: "success",
    outcome: "eose",
    duplicateEventCount: 1,
  })
  expect(read.eventSourceRelayUrls).toEqual({
    [newest.id]: ["wss://duplicate.example"],
    [older.id]: ["wss://duplicate.example"],
  })
  expect(read.readCoverage).toBe("complete")
})

it("keeps reader and executor coverage aligned for out-of-filter events", async () => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: DuplicateRelaySocket,
  })
  const query = {
    filters: [{ kinds: [0] }],
    operation: "public_read" as const,
  }
  const makeExecutor = () =>
    new WebSocketCommerceRelayExecutor({
      createWebSocket: (url) => new DuplicateRelaySocket(url),
    })

  responseEvents = [wrongKind]
  const emptyExecutor = makeExecutor()
  try {
    const empty = await emptyExecutor.query({
      ...query,
      relayUrls: ["wss://unusable-empty.example"],
    })
    expect(empty.events).toEqual([])
    expect(empty.publicRead?.readCoverage).toBe("partial")
    expect(empty.relays[0]).toMatchObject({
      status: "failed",
      failure: "protocol_invalid",
      unusableCount: 1,
    })
    expect(empty.status).toBe("unavailable")
    expect(empty.authoritativeEmpty).toBe(false)
  } finally {
    emptyExecutor.dispose()
  }

  responseEvents = [newest, wrongKind]
  const partialExecutor = makeExecutor()
  try {
    const partial = await partialExecutor.query({
      ...query,
      relayUrls: ["wss://unusable-with-valid.example"],
    })
    expect(partial.events.map((event) => event.id)).toEqual([newest.id])
    expect(partial.publicRead?.readCoverage).toBe("partial")
    expect(partial.relays[0]).toMatchObject({
      status: "partial",
      failure: "protocol_invalid",
      unusableCount: 1,
      eventCount: 1,
    })
    expect(partial.status).toBe("partial")
    expect(partial.authoritativeEmpty).toBe(false)
  } finally {
    partialExecutor.dispose()
  }
})
