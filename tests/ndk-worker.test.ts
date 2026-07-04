import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetNdkTestState,
  __resetRelayHealth,
  disconnectNdk,
  EVENT_KINDS,
  fetchEventsFanout,
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
    class FakeWebSocket {
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
            data: JSON.stringify(["EVENT", subId, rawEvent]),
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
})
