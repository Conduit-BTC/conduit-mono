import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, type Event as NostrEvent } from "nostr-tools"
import {
  __resetNdkTestState,
  __resetRelayHealth,
  disconnectNdk,
  EVENT_KINDS,
  fetchEventsFanout,
  fetchEventsFanoutDetailed,
  getRelayHealth,
} from "@conduit/core"

function eventIdFor(input: {
  pubkey: string
  createdAt: number
  kind: number
  tags: string[][]
  content: string
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        0,
        input.pubkey,
        input.createdAt,
        input.kind,
        input.tags,
        input.content,
      ])
    )
    .digest("hex")
}

const rawEvent = (() => {
  const pubkey = "11".repeat(32)
  const createdAt = 10
  const kind = EVENT_KINDS.PROFILE
  const tags: string[][] = []
  const content = JSON.stringify({ name: "worker fallback" })

  return {
    id: eventIdFor({ pubkey, createdAt, kind, tags, content }),
    pubkey,
    created_at: createdAt,
    kind,
    tags,
    content,
    sig: "00".repeat(64),
  }
})()

function fakeRelayWebSocket(relayEvent: NostrEvent) {
  return class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = FakeWebSocket.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null

    constructor() {
      setTimeout(() => {
        this.readyState = FakeWebSocket.OPEN
        this.onopen?.(new Event("open"))
      }, 0)
    }

    send(payload: string): void {
      const parsed = JSON.parse(payload) as [string, string]
      if (parsed[0] !== "REQ") return
      const subId = parsed[1]

      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify(["EVENT", subId, relayEvent]),
        } as MessageEvent<string>)
        this.onmessage?.({
          data: JSON.stringify(["EOSE", subId]),
        } as MessageEvent<string>)
      }, 0)
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.(new Event("close"))
    }
  }
}

describe("NDK relay worker verification fallback", () => {
  const originalWebSocket = globalThis.WebSocket
  const originalWorker = globalThis.Worker
  let workerPostMessages = 0
  let workerTerminates = 0

  beforeEach(() => {
    __resetNdkTestState()
    __resetRelayHealth()
    workerPostMessages = 0
    workerTerminates = 0
  })

  afterEach(() => {
    disconnectNdk()
    __resetNdkTestState()
    __resetRelayHealth()
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: originalWorker,
    })
  })

  it("falls back immediately when the verification worker errors after postMessage", async () => {
    const FakeWebSocket = fakeRelayWebSocket(rawEvent)

    class FailingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      postMessage(): void {
        workerPostMessages += 1
        queueMicrotask(() => this.onerror?.(new Event("error")))
      }

      terminate(): void {
        workerTerminates += 1
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: FailingWorker,
    })

    const result = await Promise.race([
      fetchEventsFanout(
        { kinds: [EVENT_KINDS.PROFILE] },
        {
          relayUrls: ["wss://relay.example"],
          connectTimeoutMs: 50,
          fetchTimeoutMs: 50,
        }
      ).then((events) => ({ status: "resolved" as const, events })),
      new Promise<{ status: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ status: "timeout" }), 250)
      ),
    ])

    expect(result.status).toBe("resolved")
    if (result.status === "resolved") {
      expect(result.events).toEqual([])
    }
    expect(workerPostMessages).toBe(1)
    expect(workerTerminates).toBe(1)
  })

  it("verifies a valid hex-encoded Nostr signature in the sync fallback", async () => {
    const validEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 10,
        tags: [],
        content: JSON.stringify({ name: "valid sync fallback" }),
      },
      Uint8Array.from([...new Uint8Array(31), 1])
    )

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: fakeRelayWebSocket(validEvent),
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const events = await fetchEventsFanout(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://relay.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )

    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe(validEvent.id)
  })

  it("preserves relay failure status separately from an empty event set", async () => {
    class FailingWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = FailingWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null

      constructor() {
        queueMicrotask(() => this.onerror?.(new Event("error")))
      }

      send(): void {}
      close(): void {
        this.readyState = FailingWebSocket.CLOSED
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FailingWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://offline.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )

    expect(result.events).toEqual([])
    expect(result.relays).toEqual([
      {
        relayUrl: "wss://offline.example",
        status: "failed",
        eventCount: 0,
      },
    ])
  })

  it("can isolate relay connections between server requests", async () => {
    const validEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 10,
        tags: [],
        content: JSON.stringify({ name: "isolated relay read" }),
      },
      Uint8Array.from([...new Uint8Array(31), 1])
    )
    const sockets: Array<{ readyState: number }> = []
    const FakeWebSocket = fakeRelayWebSocket(validEvent)

    class TrackingWebSocket extends FakeWebSocket {
      constructor() {
        super()
        sockets.push(this)
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    for (let request = 0; request < 2; request += 1) {
      const result = await fetchEventsFanoutDetailed(
        { kinds: [EVENT_KINDS.PROFILE] },
        {
          relayUrls: ["wss://relay.example"],
          connectTimeoutMs: 50,
          fetchTimeoutMs: 50,
          reuseRelayConnections: false,
        }
      )
      expect(result.events).toHaveLength(1)
    }

    expect(sockets).toHaveLength(2)
    expect(sockets.every((socket) => socket.readyState === 3)).toBe(true)
  })

  it("preserves verified events but reports partial when a relay closes before EOSE", async () => {
    const validEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 10,
        tags: [],
        content: JSON.stringify({ name: "partial relay read" }),
      },
      Uint8Array.from([...new Uint8Array(31), 1])
    )

    class ClosingWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = ClosingWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null

      constructor() {
        queueMicrotask(() => {
          this.readyState = ClosingWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }

      send(payload: string): void {
        const parsed = JSON.parse(payload) as [string, string]
        if (parsed[0] !== "REQ") return
        const subId = parsed[1]
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify(["EVENT", subId, validEvent]),
          } as MessageEvent<string>)
          this.onmessage?.({
            data: JSON.stringify([
              "CLOSED",
              subId,
              "relay closed subscription",
            ]),
          } as MessageEvent<string>)
        })
      }

      close(): void {
        this.readyState = ClosingWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: ClosingWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const relayUrl = "wss://partial.example"
    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: [relayUrl],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.id).toBe(validEvent.id)
    expect(result.relays).toEqual([
      {
        relayUrl,
        status: "partial",
        eventCount: 1,
      },
    ])
    expect(getRelayHealth(relayUrl)).toMatchObject({
      consecutiveFailures: 1,
      lastSuccessAt: null,
    })
  })
})
