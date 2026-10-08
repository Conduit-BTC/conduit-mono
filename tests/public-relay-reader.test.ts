import { isVerifiedNostrEvent } from "@conduit/core"
import { afterEach, expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools/pure"
import {
  __resetPublicReaderTestState,
  fetchSignedEventsFanoutDetailed,
  fetchPublicEventsProgressive,
  PublicRelayReadCancelledError,
  refreshPublicRelayConnectionsWhenIdle,
  type PublicRelayReadResult,
} from "../packages/core/src/protocol/relay-reader"

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
const signed = finalizeEvent(
  { kind: 0, content: "{}", tags: [], created_at: 100 },
  new Uint8Array(32).fill(7)
)
const sockets: Socket[] = []
let respond: (socket: Socket, id: string) => void
class Socket {
  static OPEN = 1
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  sent: unknown[][] = []
  constructor(readonly url: string) {
    sockets.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.(new Event("open"))
    })
  }
  send(payload: string) {
    const frame = JSON.parse(payload)
    this.sent.push(frame)
    if (frame[0] === "REQ") queueMicrotask(() => respond(this, frame[1]))
  }
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
  }
  close() {
    this.readyState = 3
  }
}
function install(handler: typeof respond) {
  sockets.length = 0
  respond = handler
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: Socket,
  })
}
const options = (relayUrls = ["wss://first.example"]) => ({
  relayUrls,
  skipHealthFilter: true,
  reuseRelayConnections: false,
  fetchTimeoutMs: 10,
  connectTimeoutMs: 10,
})
afterEach(() => {
  __resetPublicReaderTestState()
  if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

it("idle refresh waits for a scoped read's asynchronous progress callback", async () => {
  install((socket, id) => socket.emit(["EOSE", id]))
  let entered!: () => void
  let finishProgress!: () => void
  const progressEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  const progressReleased = new Promise<void>((resolve) => {
    finishProgress = resolve
  })
  const pending = fetchSignedEventsFanoutDetailed(
    { kinds: [0] },
    {
      ...options(),
      reuseRelayConnections: true,
      socketScope: { createWebSocket: (url) => new Socket(url) },
      onRelayProgress: async () => {
        entered()
        await progressReleased
      },
    }
  )
  await progressEntered
  refreshPublicRelayConnectionsWhenIdle()
  try {
    expect(sockets[0].readyState).toBe(Socket.OPEN)
  } finally {
    finishProgress()
  }
  await expect(pending).resolves.toMatchObject({ readCoverage: "complete" })
  expect(sockets[0].readyState).toBe(3)
})

it("keeps duplicate provenance before deduplication and exposes only signed wire data", async () => {
  install((socket, id) => {
    socket.emit(["EVENT", id, signed])
    socket.emit(["EOSE", id])
  })
  const read = await fetchSignedEventsFanoutDetailed(
    { kinds: [0] },
    options(["wss://first.example", "wss://second.example"])
  )
  expect(read.events).toHaveLength(1)
  expect(Object.keys(read.events[0]).sort()).toEqual(
    Object.keys(signed)
      .filter((key) => key !== "verified")
      .sort()
  )
  expect("rawEvent" in read.events[0]).toBe(false)
  expect(read.eventSourceRelayUrls[signed.id].sort()).toEqual([
    "wss://first.example",
    "wss://second.example",
  ])
  expect(read.attemptedRelayUrls).toEqual(read.admittedRelayUrls)
  expect(read.relays.map((source) => source.outcome)).toEqual(["eose", "eose"])
  expect(read.readCoverage).toBe("complete")
  expect(read.globalAbsence).toBe(false)
})

it("keeps scoped empty complete distinct from unavailable and malformed evidence", async () => {
  install((socket, id) => socket.emit(["EOSE", id]))
  const empty = await fetchSignedEventsFanoutDetailed({ kinds: [0] }, options())
  expect(empty.readCoverage).toBe("complete")
  expect(empty.events).toEqual([])
  expect(empty.freshness).toBe("current")
  expect(empty.globalAbsence).toBe(false)
  const noTargets = await fetchSignedEventsFanoutDetailed(
    { kinds: [0] },
    options([])
  )
  expect(noTargets.readCoverage).toBe("unavailable")
  install((socket, id) => {
    socket.emit(["EVENT", id, { bad: true }])
    socket.emit(["EOSE", id])
  })
  const malformed = await fetchSignedEventsFanoutDetailed(
    { kinds: [0] },
    options()
  )
  expect(malformed.readCoverage).toBe("partial")
  expect(malformed.relays[0]).toMatchObject({
    outcome: "malformed",
    malformedEventCount: 1,
  })
})

for (const [label, payload] of [
  ["missing", undefined],
  ["null", null],
  ["false", false],
  ["zero", 0],
  ["empty string", ""],
  ["invalid object", { bad: true }],
] as const) {
  it(`keeps ${label} EVENT payload evidence partial after EOSE`, async () => {
    install((socket, id) => {
      socket.emit(
        payload === undefined ? ["EVENT", id] : ["EVENT", id, payload]
      )
      socket.emit(["EOSE", id])
    })
    const read = await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      options()
    )
    expect(read.events).toEqual([])
    expect(read.readCoverage).toBe("partial")
    expect(read.globalAbsence).toBe(false)
    expect(read.relays[0]).toMatchObject({
      status: "partial",
      outcome: "malformed",
      malformedEventCount: 1,
      eoseReceived: true,
    })
  })
}

for (const [reason, outcome] of [
  ["auth-required: fixture", "auth_required"],
  ["restricted: fixture", "rejected"],
  ["error: fixture", "closed"],
] as const) {
  it(`reports ${outcome} without borrowing a signer or authenticating`, async () => {
    install((socket, id) => {
      socket.emit(["AUTH", "fixture"])
      socket.emit(["CLOSED", id, reason])
    })
    const read = await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      options()
    )
    expect(read.relays[0].outcome).toBe(outcome)
    expect(read.readCoverage).toBe("unavailable")
    expect(
      sockets
        .flatMap((socket) => socket.sent)
        .some((frame) => frame[0] === "AUTH")
    ).toBe(false)
  })
}

it("preserves verified partial events without EOSE and distinguishes disconnect", async () => {
  install((socket, id) => socket.emit(["EVENT", id, signed]))
  const timedOut = await fetchSignedEventsFanoutDetailed(
    { kinds: [0] },
    options()
  )
  expect(timedOut.events.map((event) => event.id)).toEqual([signed.id])
  expect(timedOut.relays[0]).toMatchObject({
    status: "partial",
    outcome: "timeout",
  })
  install((socket) => socket.onclose?.(new Event("close")))
  const disconnected = await fetchSignedEventsFanoutDetailed(
    { kinds: [0] },
    options()
  )
  expect(disconnected.relays[0].outcome).toBe("disconnected")
})

it("does not let forged id or signature establish complete evidence", async () => {
  install((socket, id) => {
    socket.emit(["EVENT", id, { ...signed, content: "altered" }])
    socket.emit(["EVENT", id, { ...signed, sig: "0".repeat(128) }])
    socket.emit(["EOSE", id])
  })
  const read = await fetchSignedEventsFanoutDetailed({ kinds: [0] }, options())
  expect(read.events).toEqual([])
  expect(read.relays[0]).toMatchObject({
    status: "partial",
    outcome: "verification_failed",
    rejectedEventCount: 2,
  })
  expect(read.readCoverage).toBe("partial")
})

it("retains completed source evidence on cancellation and stops active subscriptions", async () => {
  const controller = new AbortController()
  install((socket, id) => {
    if (socket.url.includes("first")) {
      socket.emit(["EVENT", id, signed])
      socket.emit(["EOSE", id])
    }
  })
  let first!: () => void
  const progress = new Promise<void>((resolve) => {
    first = resolve
  })
  const read = fetchSignedEventsFanoutDetailed(
    { kinds: [0] },
    {
      ...options(["wss://first.example", "wss://second.example"]),
      fetchTimeoutMs: 1000,
      signal: controller.signal,
      onProgress: () => first(),
    }
  )
  await progress
  controller.abort()
  try {
    await read
    throw new Error("expected cancellation")
  } catch (error) {
    expect(error).toBeInstanceOf(PublicRelayReadCancelledError)
    const result = (error as PublicRelayReadCancelledError).result
    expect(result.readCoverage).toBe("cancelled")
    expect(result.events.map((event) => event.id)).toEqual([signed.id])
    expect(result.relays.map((source) => source.outcome).sort()).toEqual([
      "cancelled",
      "eose",
    ])
  }
  expect(sockets.every((socket) => socket.readyState === 3)).toBe(true)
  expect(
    sockets.every((socket) => socket.sent.some((frame) => frame[0] === "CLOSE"))
  ).toBe(true)
})

it("progressive discovery carries the same result vocabulary without claiming final coverage", async () => {
  install((socket, id) => {
    socket.emit(["EVENT", id, signed])
    socket.emit(["EOSE", id])
  })
  const snapshots: PublicRelayReadResult[] = []
  const events = await fetchPublicEventsProgressive(
    { kinds: [0] },
    options(),
    ({ result }) => {
      snapshots.push(result!)
    }
  )
  expect(events).toHaveLength(1)
  expect(snapshots[0]).toMatchObject({
    phase: "progressive",
    readCoverage: "partial",
    globalAbsence: false,
  })
  expect(snapshots[0].events.every(isVerifiedNostrEvent)).toBe(true)
  expect(snapshots[0].eventSourceRelayUrls?.[signed.id]).toEqual([
    "wss://first.example",
  ])
})

it("rejects protected filters before public I/O and discards unsolicited wraps", async () => {
  install((socket, id) => {
    socket.emit(["EVENT", id, { ...signed, kind: 1059 }])
    socket.emit(["EOSE", id])
  })
  await expect(
    fetchSignedEventsFanoutDetailed({ kinds: [1059] }, options())
  ).rejects.toThrow("protected inbox")
  expect(sockets).toHaveLength(0)
  const read = await fetchSignedEventsFanoutDetailed({}, options())
  expect(read.events).toEqual([])
  expect(read.relays[0]?.unusableEventCount).toBe(1)
})

it.each([
  [
    { maxFramesPerRelay: 1 },
    (socket: Socket) => {
      socket.emit(["EOSE", "other"])
      socket.emit(["EOSE", "other"])
    },
  ],
  [
    { maxBytesPerRelay: 10 },
    (socket: Socket) => socket.emit(["NOTICE", "bounded traffic"]),
  ],
  [
    { maxEventsPerRelay: 1 },
    (socket: Socket, id: string) => {
      socket.emit(["EVENT", id, signed])
      socket.emit(["EVENT", id, signed])
    },
  ],
])(
  "retains caller resource bounds through the shared transport (%j)",
  async (bounds, send) => {
    install((socket, id) => send(socket, id))
    const read = await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      { ...options(), ...bounds }
    )
    expect(read.relays[0]?.outcome).toBe("resource_limit")
    expect(read.readCoverage).not.toBe("complete")
  }
)
