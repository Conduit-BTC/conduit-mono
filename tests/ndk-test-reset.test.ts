import { expect, it, spyOn } from "bun:test"
import { NDKRelaySet } from "@nostr-dev-kit/ndk"
import {
  __resetNdkTestState,
  disconnectNdk,
  getNdk,
} from "../packages/core/src/protocol/ndk"

it("test reset closes compatibility sockets and cancels their background monitors", async () => {
  __resetNdkTestState()
  disconnectNdk()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
  const sockets: TestWebSocket[] = []
  const intervals = spyOn(globalThis, "setInterval")
  const clearIntervals = spyOn(globalThis, "clearInterval")

  class TestWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = TestWebSocket.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null

    constructor() {
      super()
      sockets.push(this)
      queueMicrotask(() => {
        if (this.readyState !== TestWebSocket.CONNECTING) return
        this.readyState = TestWebSocket.OPEN
        this.onopen?.(new Event("open"))
      })
    }

    close(): void {
      this.readyState = TestWebSocket.CLOSED
      this.onclose?.(new Event("close"))
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TestWebSocket,
  })

  try {
    const ndk = getNdk()
    const relayUrls = ["wss://reset-a.example", "wss://reset-b.example"]
    // Reusing a relay set connects its existing relay even when event.publish
    // is stubbed. Exercise that compatibility-publisher boundary directly.
    NDKRelaySet.fromRelayUrls(relayUrls, ndk)
    NDKRelaySet.fromRelayUrls(relayUrls, ndk)
    await Promise.resolve()
    expect(sockets).toHaveLength(2)
    expect(sockets[0]?.readyState).toBe(TestWebSocket.OPEN)
    const monitorHandles = intervals.mock.results.map((result) => result.value)
    expect(monitorHandles.length).toBeGreaterThan(0)

    __resetNdkTestState()

    await Promise.resolve()
    expect(sockets.map((socket) => socket.readyState)).toEqual([
      TestWebSocket.CLOSED,
      TestWebSocket.CLOSED,
    ])
    for (const handle of monitorHandles) {
      expect(clearIntervals).toHaveBeenCalledWith(handle)
    }
    expect(getNdk()).not.toBe(ndk)
    expect(getNdk().pool.relays.size).toBe(0)
    __resetNdkTestState()
    expect(sockets).toHaveLength(2)
  } finally {
    __resetNdkTestState()
    intervals.mockRestore()
    clearIntervals.mockRestore()
    if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor)
    else Reflect.deleteProperty(globalThis, "WebSocket")
  }
})
