import { describe, expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools/pure"
import { publishSignedEventFrameToRelay } from "../packages/core/src/protocol/relay-writer"

const SECRET = Uint8Array.from([...new Uint8Array(31), 23])

function signedEvent() {
  return finalizeEvent(
    {
      kind: 5,
      created_at: 1_700_000_000,
      tags: [["e", "a".repeat(64)]],
      content: "",
    },
    SECRET
  )
}

class WriterTestSocket {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  closeCalls = 0
  throwOnSend = false
  onSend?: () => void

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event("open"))
  }

  send(): void {
    if (this.throwOnSend) throw new Error("send failed")
    this.onSend?.()
  }

  message(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>)
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
  }
}

describe("exact relay writer", () => {
  it("turns constructor failures into a retryable result", async () => {
    await expect(
      publishSignedEventFrameToRelay({
        relayUrl: "wss://constructor-failure.conduit.market",
        signedEvent: signedEvent(),
        timeoutMs: 10,
        createWebSocket: () => {
          throw new Error("constructor failed")
        },
      })
    ).resolves.toBe("timed_out")
  })

  it("closes a connected socket when sending throws", async () => {
    const socket = new WriterTestSocket()
    socket.throwOnSend = true
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://send-failure.conduit.market",
      signedEvent: signedEvent(),
      timeoutMs: 10,
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()

    await expect(result).resolves.toBe("timed_out")
    expect(socket.closeCalls).toBe(1)
  })

  it("enforces one total connect-and-ack deadline", async () => {
    const socket = new WriterTestSocket()
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://silent.conduit.market",
      signedEvent: signedEvent(),
      timeoutMs: 5,
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()

    await expect(result).resolves.toBe("timed_out")
    expect(socket.closeCalls).toBe(1)
  })

  it("bounds malformed relay response frames", async () => {
    const socket = new WriterTestSocket()
    socket.onSend = () => {
      for (let index = 0; index < 65; index += 1) socket.message("[]")
    }
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://frame-flood.conduit.market",
      signedEvent: signedEvent(),
      timeoutMs: 50,
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()

    await expect(result).resolves.toBe("timed_out")
    expect(socket.closeCalls).toBe(1)
  })

  it("bounds total relay response bytes", async () => {
    const socket = new WriterTestSocket()
    socket.onSend = () => socket.message("x".repeat(256 * 1024 + 1))
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://byte-flood.conduit.market",
      signedEvent: signedEvent(),
      timeoutMs: 50,
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()

    await expect(result).resolves.toBe("timed_out")
    expect(socket.closeCalls).toBe(1)
  })
})
