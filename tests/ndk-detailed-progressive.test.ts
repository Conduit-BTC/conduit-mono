import { expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  __resetNdkTestState,
  fetchEventsFanoutDetailed,
  type FetchEventsFanoutResult,
} from "../packages/core/src/protocol/ndk"

it("emits only verified cumulative relay results before the slow relay finishes", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
  const signed = finalizeEvent(
    { kind: 1, content: "Public test", tags: [], created_at: 100 },
    generateSecretKey()
  )
  const invalid = { ...signed, content: "Modified content" }
  const fast = "wss://relay.damus.io"
  const slow = "wss://nos.lol"
  let releaseSlow!: () => void
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve
  })
  let firstProgress!: (value: FetchEventsFanoutResult) => void
  const first = new Promise<FetchEventsFanoutResult>((resolve) => {
    firstProgress = resolve
  })
  const snapshots: FetchEventsFanoutResult[] = []
  class TestSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    readyState = 0
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null
    constructor(readonly url: string) {
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.(new Event("open"))
      })
    }
    send(payload: string) {
      const [type, id] = JSON.parse(payload)
      if (type !== "REQ") return
      const emit = () => {
        if (this.readyState !== 1) return
        if (this.url.startsWith(fast)) {
          this.onmessage?.({
            data: JSON.stringify(["EVENT", id, invalid]),
          } as MessageEvent<string>)
          this.onmessage?.({
            data: JSON.stringify(["EVENT", id, signed]),
          } as MessageEvent<string>)
        }
        this.onmessage?.({
          data: JSON.stringify(["EOSE", id]),
        } as MessageEvent<string>)
      }
      if (this.url.startsWith(slow)) void slowGate.then(emit)
      else queueMicrotask(emit)
    }
    close() {
      this.readyState = 3
    }
  }
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TestSocket,
  })
  try {
    let finished = false
    const read = fetchEventsFanoutDetailed(
      { kinds: [1] },
      {
        relayUrls: [fast, slow],
        skipHealthFilter: true,
        reuseRelayConnections: false,
        onProgress: (value) => {
          snapshots.push(value)
          firstProgress(value)
        },
      }
    ).then((value) => {
      finished = true
      return value
    })
    const preview = await first
    expect(finished).toBe(false)
    expect(preview.eventsVerified).toBe(true)
    expect(preview.events.map((event) => event.id)).toEqual([signed.id])
    expect(preview.events[0]?.content).toBe("Public test")
    expect(preview.relays).toHaveLength(1)
    expect(preview.relays[0]?.rejectedEventCount).toBe(1)
    releaseSlow()
    const final = await read
    expect(final.relays).toHaveLength(2)
    expect(snapshots.at(-1)?.events.map((event) => event.id)).toEqual([
      signed.id,
    ])
    expect(snapshots.at(-1)?.relays).toHaveLength(2)
  } finally {
    releaseSlow()
    __resetNdkTestState()
    if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor)
    else Reflect.deleteProperty(globalThis, "WebSocket")
  }
})
