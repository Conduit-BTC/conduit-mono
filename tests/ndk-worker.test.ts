import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  type Event as NostrEvent,
} from "nostr-tools"
import {
  __resetNdkTestState,
  __setNdkVerifyTimeoutMsForTests,
  __resetRelayHealth,
  applyE2eRelayIsolation,
  config,
  disconnectNdk,
  EVENT_KINDS,
  fetchEventsFanout,
  fetchEventsFanoutDetailed,
  getRelayHealth,
  verifySignedPublicNostrEvents,
} from "@conduit/core"

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

function sequencedRelayWebSocket(
  relayEvents: unknown[],
  options: {
    sendEose?: boolean
    onCloseRequest?: () => void
  } = {}
) {
  return class SequencedWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = SequencedWebSocket.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null

    constructor() {
      queueMicrotask(() => {
        this.readyState = SequencedWebSocket.OPEN
        this.onopen?.(new Event("open"))
      })
    }

    send(payload: string): void {
      const parsed = JSON.parse(payload) as [string, string]
      if (parsed[0] === "CLOSE") {
        options.onCloseRequest?.()
        return
      }
      if (parsed[0] !== "REQ") return
      const subId = parsed[1]

      queueMicrotask(() => {
        for (const event of relayEvents) {
          this.onmessage?.({
            data: JSON.stringify(["EVENT", subId, event]),
          } as MessageEvent<string>)
        }
        if (options.sendEose !== false) {
          this.onmessage?.({
            data: JSON.stringify(["EOSE", subId]),
          } as MessageEvent<string>)
        }
      })
    }

    close(): void {
      this.readyState = SequencedWebSocket.CLOSED
      this.onclose?.(new Event("close"))
    }
  }
}

describe("NDK relay worker verification fallback", () => {
  const originalWebSocket = globalThis.WebSocket
  const originalWorker = globalThis.Worker
  const originalConfig = structuredClone(config)
  let workerPostMessages = 0
  let workerTerminates = 0

  beforeEach(() => {
    __resetNdkTestState()
    __resetRelayHealth()
    workerPostMessages = 0
    workerTerminates = 0
  })

  afterEach(() => {
    Object.assign(config, structuredClone(originalConfig))
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

  it("forces explicit fanout reads onto loopback during E2E isolation", async () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    const openedRelayUrls: string[] = []
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))

    class RecordingWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = RecordingWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null

      constructor(readonly url: string) {
        openedRelayUrls.push(url)
        queueMicrotask(() => {
          this.readyState = RecordingWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }

      send(payload: string): void {
        const frame = JSON.parse(payload) as [string, string]
        if (frame[0] !== "REQ") return
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify(["EOSE", frame[1]]),
          } as MessageEvent<string>)
        })
      }

      close(): void {
        this.readyState = RecordingWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: RecordingWebSocket,
    })

    await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://relay.damus.io"],
        skipHealthFilter: true,
        reuseRelayConnections: false,
      }
    )

    expect(openedRelayUrls).toEqual([isolatedRelayUrl])
  })

  it("fails closed when the verification worker errors after postMessage", async () => {
    const validEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 10,
        tags: [],
        content: JSON.stringify({ name: "worker failure" }),
      },
      Uint8Array.from([...new Uint8Array(31), 1])
    )
    const FakeWebSocket = fakeRelayWebSocket(validEvent)

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

  it("verifies an EOSE-complete private wrap when the worker queue is saturated", async () => {
    const validEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.GIFT_WRAP,
        created_at: 10,
        tags: [["p", "1".repeat(64)]],
        content: "bounded-test-ciphertext",
      },
      Uint8Array.from([...new Uint8Array(31), 1])
    )
    const invalidEvent = { ...validEvent, sig: "0".repeat(128) }

    class HoldingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      postMessage(): void {
        workerPostMessages += 1
      }

      terminate(): void {
        workerTerminates += 1
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: sequencedRelayWebSocket([invalidEvent, validEvent]),
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: HoldingWorker,
    })

    const saturatedBatches = Array.from({ length: 7 }, () =>
      verifySignedPublicNostrEvents([validEvent]).catch(() => ({
        events: [],
        truncated: false,
      }))
    )
    expect(workerPostMessages).toBe(7)

    try {
      const result = await fetchEventsFanoutDetailed(
        {
          kinds: [EVENT_KINDS.GIFT_WRAP],
          "#p": ["1".repeat(64)],
        },
        {
          relayUrls: ["wss://saturated-verifier.example"],
          connectTimeoutMs: 50,
          fetchTimeoutMs: 50,
          reuseRelayConnections: false,
        }
      )

      expect(result.events.map((event) => event.id)).toEqual([validEvent.id])
      expect(result.relays).toEqual([
        {
          relayUrl: "wss://saturated-verifier.example",
          status: "success",
          eventCount: 1,
          rejectedEventCount: 1,
        },
      ])
    } finally {
      __resetNdkTestState()
      await Promise.all(saturatedBatches)
    }
  })

  it("reserves relay-read capacity for bounded verification fallback", async () => {
    const validEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.GIFT_WRAP,
        created_at: 10,
        tags: [["p", "1".repeat(64)]],
        content: "reserved-fallback-test",
      },
      Uint8Array.from([...new Uint8Array(31), 1])
    )
    const invalidEvent = { ...validEvent, sig: "0".repeat(128) }

    class HoldingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      postMessage(): void {
        workerPostMessages += 1
      }

      terminate(): void {
        workerTerminates += 1
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: sequencedRelayWebSocket([invalidEvent, validEvent]),
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: HoldingWorker,
    })

    const occupiedReads = Array.from({ length: 7 }, (_, index) =>
      fetchEventsFanoutDetailed(
        { kinds: [EVENT_KINDS.GIFT_WRAP], "#p": ["1".repeat(64)] },
        {
          relayUrls: [`wss://occupied-verifier-${index}.example`],
          connectTimeoutMs: 50,
          fetchTimeoutMs: 50,
          reuseRelayConnections: false,
        }
      )
    )

    let exactRead: ReturnType<typeof fetchEventsFanoutDetailed> | null = null
    try {
      const workerDeadline = Date.now() + 250
      while (workerPostMessages < 7 && Date.now() < workerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(workerPostMessages).toBe(7)

      exactRead = fetchEventsFanoutDetailed(
        { kinds: [EVENT_KINDS.GIFT_WRAP], "#p": ["1".repeat(64)] },
        {
          relayUrls: ["wss://reserved-verifier.example"],
          connectTimeoutMs: 50,
          fetchTimeoutMs: 50,
          reuseRelayConnections: false,
        }
      )
      const result = await Promise.race([
        exactRead.then((value) => ({ state: "resolved" as const, value })),
        new Promise<{ state: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ state: "timeout" }), 250)
        ),
      ])

      expect(result.state).toBe("resolved")
      if (result.state === "resolved") {
        expect(result.value.events.map((event) => event.id)).toEqual([
          validEvent.id,
        ])
        expect(result.value.relays).toEqual([
          {
            relayUrl: "wss://reserved-verifier.example",
            status: "success",
            eventCount: 1,
            rejectedEventCount: 1,
          },
        ])
      }
    } finally {
      __resetNdkTestState()
      await Promise.allSettled(
        exactRead ? [...occupiedReads, exactRead] : occupiedReads
      )
    }
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

  it("verifies bounded embedded events through the shared async pipeline", async () => {
    const first = finalizeEvent(
      {
        kind: EVENT_KINDS.ZAP_REQUEST,
        created_at: 10,
        tags: [],
        content: "",
      },
      Uint8Array.from([...new Uint8Array(31), 1])
    )
    const second = finalizeEvent(
      {
        kind: EVENT_KINDS.ZAP_REQUEST,
        created_at: 11,
        tags: [],
        content: "",
      },
      Uint8Array.from([...new Uint8Array(31), 2])
    )

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await verifySignedPublicNostrEvents([first, second], {
      maxEvents: 1,
    })

    expect(result.events.map(({ id }) => id)).toEqual([first.id])
    expect(result.truncated).toBe(true)
  })

  it("rejects signed events with non-canonical NIP-01 fields", async () => {
    const secret = Uint8Array.from([...new Uint8Array(31), 1])
    const canonical = finalizeEvent(
      {
        kind: EVENT_KINDS.ZAP_REQUEST,
        created_at: 10,
        tags: [],
        content: "canonical signature case",
      },
      secret
    )
    const uppercaseSignature = {
      ...canonical,
      sig: canonical.sig.replace(/[a-f]/g, (character) =>
        character.toUpperCase()
      ),
    }
    const fractionalTimestamp = finalizeEvent(
      {
        kind: EVENT_KINDS.ZAP_REQUEST,
        created_at: 10.5,
        tags: [],
        content: "",
      },
      secret
    )
    const outOfRangeKind = finalizeEvent(
      {
        kind: 65_536,
        created_at: 10,
        tags: [],
        content: "",
      },
      secret
    )
    const emptyTag = finalizeEvent(
      {
        kind: EVENT_KINDS.ZAP_REQUEST,
        created_at: 10,
        tags: [[]],
        content: "",
      },
      secret
    )

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await verifySignedPublicNostrEvents([
      uppercaseSignature,
      fractionalTimestamp,
      outOfRangeKind,
      emptyTag,
    ])

    expect(result.events).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it("does not let an invalid signature reuse a cached valid event id", async () => {
    const validEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.ZAP_REQUEST,
        created_at: 10,
        tags: [],
        content: "",
      },
      Uint8Array.from([...new Uint8Array(31), 1])
    )
    const invalidSignature = {
      ...validEvent,
      sig: "0".repeat(128),
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const cached = await verifySignedPublicNostrEvents([validEvent])
    const forged = await verifySignedPublicNostrEvents([invalidSignature])

    expect(cached.events.map(({ id }) => id)).toEqual([validEvent.id])
    expect(forged.events).toEqual([])
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
    expect(result.eventsVerified).toBe(true)
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

  it("closes shared relay connections when resetting NDK test state", async () => {
    const firstEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 10,
        tags: [],
        content: JSON.stringify({ name: "first test connection" }),
      },
      generateSecretKey()
    )
    const secondEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 11,
        tags: [],
        content: JSON.stringify({ name: "second test connection" }),
      },
      generateSecretKey()
    )
    const FirstWebSocket = fakeRelayWebSocket(firstEvent)
    const SecondWebSocket = fakeRelayWebSocket(secondEvent)
    let firstSocketCount = 0
    let secondSocketCount = 0

    class TrackingFirstWebSocket extends FirstWebSocket {
      constructor() {
        super()
        firstSocketCount += 1
      }
    }

    class TrackingSecondWebSocket extends SecondWebSocket {
      constructor() {
        super()
        secondSocketCount += 1
      }
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingFirstWebSocket,
    })

    const firstRead = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://shared-reset.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )
    expect(firstRead.events.map((event) => event.id)).toEqual([firstEvent.id])

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingSecondWebSocket,
    })
    __resetNdkTestState()

    const secondRead = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://shared-reset.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )

    expect(secondRead.events.map((event) => event.id)).toEqual([secondEvent.id])
    expect(firstSocketCount).toBe(1)
    expect(secondSocketCount).toBe(1)
  })

  it("bounds a capped read when a relay omits EOSE", async () => {
    const secret = Uint8Array.from([...new Uint8Array(31), 1])
    const relayEvents = [
      finalizeEvent(
        {
          kind: EVENT_KINDS.PROFILE,
          created_at: 11,
          tags: [],
          content: JSON.stringify({ name: "first" }),
        },
        secret
      ),
      finalizeEvent(
        {
          kind: EVENT_KINDS.PROFILE,
          created_at: 10,
          tags: [],
          content: JSON.stringify({ name: "second" }),
        },
        secret
      ),
    ]
    let closeRequests = 0

    class FloodingWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = FloodingWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null

      constructor() {
        queueMicrotask(() => {
          this.readyState = FloodingWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }

      send(payload: string): void {
        const parsed = JSON.parse(payload) as [string, string]
        if (parsed[0] === "CLOSE") {
          closeRequests += 1
          return
        }
        if (parsed[0] !== "REQ") return
        const subId = parsed[1]
        queueMicrotask(() => {
          for (const event of relayEvents) {
            this.onmessage?.({
              data: JSON.stringify(["EVENT", subId, event]),
            } as MessageEvent<string>)
          }
        })
      }

      close(): void {
        this.readyState = FloodingWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FloodingWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE], limit: 1 },
      {
        relayUrls: ["wss://flooding.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 100,
      }
    )

    expect(result.events).toHaveLength(1)
    expect(result.relays[0]).toMatchObject({
      status: "partial",
      eventCount: 1,
    })
    expect(closeRequests).toBe(1)
  })

  it("ignores invalid frames before accepting a valid matching event", async () => {
    const secret = Uint8Array.from([...new Uint8Array(31), 1])
    const validEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 11,
        tags: [],
        content: JSON.stringify({ name: "valid after invalid" }),
      },
      secret
    )
    const invalidEvent = {
      ...validEvent,
      sig: "00".repeat(64),
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: sequencedRelayWebSocket([invalidEvent, validEvent]),
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE], limit: 1 },
      {
        relayUrls: ["wss://invalid-first.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )

    expect(result.events.map((event) => event.id)).toEqual([validEvent.id])
    expect(result.relays).toEqual([
      {
        relayUrl: "wss://invalid-first.example",
        status: "success",
        eventCount: 1,
        rejectedEventCount: 1,
      },
    ])
  })

  it("applies relay limits after ordering valid events newest first", async () => {
    const secret = Uint8Array.from([...new Uint8Array(31), 1])
    const olderEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 10,
        tags: [],
        content: JSON.stringify({ name: "older profile" }),
      },
      secret
    )
    const newerEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 11,
        tags: [],
        content: JSON.stringify({ name: "newer profile" }),
      },
      secret
    )

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: sequencedRelayWebSocket([olderEvent, newerEvent]),
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE], limit: 1 },
      {
        relayUrls: ["wss://out-of-order.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )

    expect(result.events.map((event) => event.id)).toEqual([newerEvent.id])
    expect(result.relays[0]).toMatchObject({
      status: "success",
      eventCount: 1,
    })
  })

  it("ignores valid non-matching frames before enforcing the requested limit", async () => {
    const secret = Uint8Array.from([...new Uint8Array(31), 1])
    const nonMatchingEvent = finalizeEvent(
      {
        kind: 1,
        created_at: 12,
        tags: [],
        content: "not a profile",
      },
      secret
    )
    const matchingEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 11,
        tags: [],
        content: JSON.stringify({ name: "matching profile" }),
      },
      secret
    )

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: sequencedRelayWebSocket([nonMatchingEvent, matchingEvent]),
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE], limit: 1 },
      {
        relayUrls: ["wss://nonmatching-first.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )

    expect(result.events.map((event) => event.id)).toEqual([matchingEvent.id])
    expect(result.relays).toEqual([
      {
        relayUrl: "wss://nonmatching-first.example",
        status: "success",
        eventCount: 1,
      },
    ])
  })

  it("reports raw-frame guard saturation as partial instead of complete", async () => {
    let closeRequests = 0
    const malformedFrames = Array.from({ length: 300 }, () => ({
      kind: "invalid",
    }))

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: sequencedRelayWebSocket(malformedFrames, {
        sendEose: false,
        onCloseRequest: () => {
          closeRequests += 1
        },
      }),
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE], limit: 1 },
      {
        relayUrls: ["wss://malformed-flood.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 100,
      }
    )

    expect(result.events).toEqual([])
    expect(result.relays).toEqual([
      {
        relayUrl: "wss://malformed-flood.example",
        status: "partial",
        eventCount: 0,
      },
    ])
    expect(closeRequests).toBe(1)
  })

  it("cancels an active relay subscription without waiting for its timeout", async () => {
    let closeRequests = 0
    let markRequestSeen: (() => void) | undefined
    const requestSeen = new Promise<void>((resolve) => {
      markRequestSeen = resolve
    })

    class HangingWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = HangingWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null

      constructor() {
        queueMicrotask(() => {
          this.readyState = HangingWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }

      send(payload: string): void {
        const [type] = JSON.parse(payload) as [string]
        if (type === "REQ") markRequestSeen?.()
        if (type === "CLOSE") closeRequests += 1
      }

      close(): void {
        this.readyState = HangingWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: HangingWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const controller = new AbortController()
    const read = fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://abort-active.example"],
        connectTimeoutMs: 500,
        fetchTimeoutMs: 5_000,
        signal: controller.signal,
      }
    )
    await requestSeen
    controller.abort()

    await expect(read).rejects.toMatchObject({ name: "AbortError" })
    expect(closeRequests).toBe(1)
  })

  it("removes an aborted queued read before it opens a relay connection", async () => {
    const constructedUrls: string[] = []
    let requestCount = 0
    let markAllActive: (() => void) | undefined
    const allActive = new Promise<void>((resolve) => {
      markAllActive = resolve
    })

    class QueuedWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = QueuedWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null

      constructor(url: string) {
        constructedUrls.push(url)
        queueMicrotask(() => {
          this.readyState = QueuedWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }

      send(payload: string): void {
        const [type] = JSON.parse(payload) as [string]
        if (type !== "REQ") return
        requestCount += 1
        if (requestCount === 8) markAllActive?.()
      }

      close(): void {
        this.readyState = QueuedWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: QueuedWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const activeController = new AbortController()
    const activeRead = fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: Array.from(
          { length: 8 },
          (_, index) => `wss://active-${index}.example`
        ),
        connectTimeoutMs: 500,
        fetchTimeoutMs: 5_000,
        signal: activeController.signal,
      }
    )
    await allActive

    const queuedController = new AbortController()
    const queuedRead = fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://queued.example"],
        connectTimeoutMs: 500,
        fetchTimeoutMs: 5_000,
        signal: queuedController.signal,
      }
    )
    queuedController.abort()

    await expect(queuedRead).rejects.toMatchObject({ name: "AbortError" })
    expect(constructedUrls).not.toContain("wss://queued.example")

    activeController.abort()
    await expect(activeRead).rejects.toMatchObject({ name: "AbortError" })
  })

  it("degrades queue-capacity rejection per relay without poisoning later reads", async () => {
    const constructedUrls: string[] = []
    const retainedEvent = {
      kind: EVENT_KINDS.PROFILE,
      created_at: 10,
      tags: [],
      content: JSON.stringify({ name: "retained during saturation" }),
      pubkey:
        "fcc22954ef7f44a34c04c3bae8ed496284c62a50eafa93afb0f33ba8fbc09c24",
      id: "ba28098af19de7a52fb993aa7d81357e88bc0570e6f8485d1fbc2a2a3fd86efa",
      sig: "ddc645e1c37b458803e1a455296465382979f3629f550fbef1eafbc167b11078b52848d739d4b2fc55c1da36900e4060a24d15b76a6d32d968ee7afc564316d4",
    } satisfies NostrEvent
    let liveRequests = 0
    let maximumLiveRequests = 0

    class CapacityWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = CapacityWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null
      private readonly liveSubIds = new Set<string>()

      constructor(private readonly url: string) {
        constructedUrls.push(url)
        queueMicrotask(() => {
          this.readyState = CapacityWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }

      send(payload: string): void {
        const parsed = JSON.parse(payload) as [string, string]
        const [type, subId] = parsed
        if (type === "CLOSE") {
          if (this.liveSubIds.delete(subId)) liveRequests -= 1
          return
        }
        if (type !== "REQ") return

        if (!this.liveSubIds.has(subId)) {
          this.liveSubIds.add(subId)
          liveRequests += 1
          maximumLiveRequests = Math.max(maximumLiveRequests, liveRequests)
        }
        const relayEvent =
          this.url === "wss://capacity-0.example" ? retainedEvent : undefined
        if (!relayEvent && this.url !== "wss://normal-read.example") return

        queueMicrotask(() => {
          if (relayEvent) {
            this.onmessage?.({
              data: JSON.stringify(["EVENT", subId, relayEvent]),
            } as MessageEvent<string>)
          }
          this.onmessage?.({
            data: JSON.stringify(["EOSE", subId]),
          } as MessageEvent<string>)
        })
      }

      close(): void {
        this.readyState = CapacityWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: CapacityWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const relayUrls = Array.from(
      { length: 137 },
      (_, index) => `wss://capacity-${index}.example`
    )
    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls,
        connectTimeoutMs: 5,
        fetchTimeoutMs: 5,
        reuseRelayConnections: false,
      }
    )

    expect(result.events.map(({ id }) => id)).toEqual([retainedEvent.id])
    expect(result.relays.map(({ relayUrl }) => relayUrl)).toEqual(relayUrls)
    expect(result.relays).toContainEqual({
      relayUrl: "wss://capacity-0.example",
      status: "success",
      eventCount: 1,
    })
    expect(constructedUrls).not.toContain("wss://capacity-136.example")
    expect(result.relays).toContainEqual({
      relayUrl: "wss://capacity-136.example",
      status: "failed",
      eventCount: 0,
    })
    expect(getRelayHealth("wss://capacity-136.example")).toBeUndefined()
    expect(maximumLiveRequests).toBeLessThanOrEqual(8)

    const laterRead = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://normal-read.example"],
        connectTimeoutMs: 5,
        fetchTimeoutMs: 5,
        reuseRelayConnections: false,
      }
    )
    expect(laterRead.relays).toEqual([
      {
        relayUrl: "wss://normal-read.example",
        status: "success",
        eventCount: 0,
      },
    ])
  })

  it("cancels pending worker verification and clears stale crypto work", async () => {
    const validEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 10,
        tags: [],
        content: JSON.stringify({ name: "cancel verification" }),
      },
      Uint8Array.from([...new Uint8Array(31), 1])
    )
    let workerTerminates = 0
    let markWorkerPosted: (() => void) | undefined
    const workerPosted = new Promise<void>((resolve) => {
      markWorkerPosted = resolve
    })

    class HangingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      postMessage(): void {
        markWorkerPosted?.()
      }

      terminate(): void {
        workerTerminates += 1
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: sequencedRelayWebSocket([validEvent]),
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: HangingWorker,
    })

    const controller = new AbortController()
    const cancelledRead = fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://abort-verification.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
        signal: controller.signal,
      }
    )
    await workerPosted
    controller.abort()

    await expect(cancelledRead).rejects.toMatchObject({ name: "AbortError" })
    await Promise.resolve()
    expect(workerTerminates).toBe(1)

    class RespondingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      postMessage(message: {
        reqId: number
        items: Array<{ id: string }>
      }): void {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              reqId: message.reqId,
              valid: message.items.map(() => true),
            },
          } as MessageEvent)
        )
      }

      terminate(): void {}
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: RespondingWorker,
    })

    const recovered = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://abort-verification.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )
    expect(recovered.events.map((event) => event.id)).toEqual([validEvent.id])
  })

  it("falls back to bounded verification when a worker times out", async () => {
    const validEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PROFILE,
        created_at: 10,
        tags: [],
        content: JSON.stringify({ name: "worker timeout" }),
      },
      Uint8Array.from([...new Uint8Array(31), 1])
    )
    let workerTerminates = 0

    class HangingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      postMessage(): void {}

      terminate(): void {
        workerTerminates += 1
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: sequencedRelayWebSocket([
        { ...validEvent, sig: "0".repeat(128) },
        validEvent,
      ]),
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: HangingWorker,
    })
    __setNdkVerifyTimeoutMsForTests(10)

    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE] },
      {
        relayUrls: ["wss://verification-timeout.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )
    await Promise.resolve()

    expect(result.events.map((event) => event.id)).toEqual([validEvent.id])
    expect(result.relays).toEqual([
      {
        relayUrl: "wss://verification-timeout.example",
        status: "success",
        eventCount: 1,
        rejectedEventCount: 1,
      },
    ])
    expect(workerTerminates).toBe(1)
  })

  it("rejects an oversized relay frame as an incomplete transport read", async () => {
    let socketCloses = 0

    class OversizedFrameWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = OversizedFrameWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null

      constructor() {
        queueMicrotask(() => {
          this.readyState = OversizedFrameWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }

      send(payload: string): void {
        const [type] = JSON.parse(payload) as [string]
        if (type !== "REQ") return
        queueMicrotask(() =>
          this.onmessage?.({
            data: "x".repeat(600_000),
          } as MessageEvent<string>)
        )
      }

      close(): void {
        socketCloses += 1
        this.readyState = OversizedFrameWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: OversizedFrameWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE], limit: 1 },
      {
        relayUrls: ["wss://oversized-frame.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 50,
      }
    )

    expect(result.events).toEqual([])
    expect(result.relays).toEqual([
      {
        relayUrl: "wss://oversized-frame.example",
        status: "failed",
        eventCount: 0,
      },
    ])
    expect(socketCloses).toBe(1)
  })

  it("bounds cumulative event data across individually allowed frames", async () => {
    let closeRequests = 0
    const largeMatchingFrame = {
      id: "00".repeat(32),
      pubkey: "11".repeat(32),
      created_at: 10,
      kind: EVENT_KINDS.PROFILE,
      tags: [],
      content: "x".repeat(300_000),
      sig: "00".repeat(64),
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: sequencedRelayWebSocket(
        Array.from({ length: 40 }, () => largeMatchingFrame),
        {
          sendEose: false,
          onCloseRequest: () => {
            closeRequests += 1
          },
        }
      ),
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE], limit: 500 },
      {
        relayUrls: ["wss://cumulative-frame-budget.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 100,
      }
    )

    expect(result.events).toEqual([])
    expect(result.relays).toHaveLength(1)
    expect(result.relays[0]).toMatchObject({
      relayUrl: "wss://cumulative-frame-budget.example",
      status: "partial",
      eventCount: 0,
    })
    expect(result.relays[0]?.rejectedEventCount).toBeGreaterThan(0)
    expect(closeRequests).toBe(1)
  })

  it("bounds connection traffic that does not target a live subscription", async () => {
    let socketCloses = 0

    class NoticeFloodWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = NoticeFloodWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null

      constructor() {
        queueMicrotask(() => {
          this.readyState = NoticeFloodWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }

      send(payload: string): void {
        const [type] = JSON.parse(payload) as [string]
        if (type !== "REQ") return
        queueMicrotask(() => {
          for (let index = 0; index < 10_050; index += 1) {
            this.onmessage?.({
              data: JSON.stringify(["NOTICE", "not a subscription id"]),
            } as MessageEvent<string>)
          }
        })
      }

      close(): void {
        socketCloses += 1
        this.readyState = NoticeFloodWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: NoticeFloodWebSocket,
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const result = await fetchEventsFanoutDetailed(
      { kinds: [EVENT_KINDS.PROFILE], limit: 1 },
      {
        relayUrls: ["wss://notice-flood.example"],
        connectTimeoutMs: 50,
        fetchTimeoutMs: 100,
      }
    )

    expect(result.events).toEqual([])
    expect(result.relays).toEqual([
      {
        relayUrl: "wss://notice-flood.example",
        status: "failed",
        eventCount: 0,
      },
    ])
    expect(socketCloses).toBe(1)
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
