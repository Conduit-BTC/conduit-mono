import { afterEach, beforeEach, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  __resetNdkTestState,
  fetchEventsFanoutDetailed,
} from "../packages/core/src/protocol/ndk"
import {
  __resetRelayHealth,
  getRelayHealth,
  isRelayRateLimited,
  partitionByHealth,
  recordRelayRateLimit,
  recordRelaySuccess,
} from "../packages/core/src/protocol/relay-health"

const relay = "wss://relay.conduit.market"
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
let onRequest: (socket: TestSocket, id: string) => void
let requests: string[]
let connections: number

class TestSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  constructor() {
    connections++
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.(new Event("open"))
    })
  }
  send(payload: string) {
    const [type, id] = JSON.parse(payload)
    if (type === "REQ") {
      requests.push(id)
      onRequest(this, id)
    }
  }
  emit(frame: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
  }
  close() {
    this.readyState = 3
  }
}

beforeEach(() => {
  __resetNdkTestState()
  __resetRelayHealth()
  requests = []
  connections = 0
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TestSocket,
  })
})
afterEach(() => {
  __resetNdkTestState()
  __resetRelayHealth()
  if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

const read = () =>
  fetchEventsFanoutDetailed(
    { kinds: [1] },
    { relayUrls: [relay], skipHealthFilter: true, fetchTimeoutMs: 1_000 }
  )

for (const message of [
  "rate limited: subscription requests",
  "rate-limited: request budget exhausted",
]) {
  it(`ends throttled reads promptly for NOTICE ${message}`, async () => {
    onRequest = (socket) =>
      queueMicrotask(() => socket.emit(["NOTICE", message]))
    const progress: unknown[] = []
    const result = await fetchEventsFanoutDetailed(
      { kinds: [1] },
      {
        relayUrls: [relay],
        onProgress: (snapshot) => progress.push(snapshot.relays),
        fetchTimeoutMs: 1_000,
      }
    )
    expect(result.relays).toEqual([
      {
        relayUrl: relay,
        status: "failed",
        eventCount: 0,
        failureReason: "rate_limited",
      },
    ])
    expect(progress).toEqual([result.relays])
    expect(isRelayRateLimited(relay)).toBe(true)
    // Explicit plans and health-filter bypasses must not bypass a throttle.
    expect((await read()).relays).toEqual(result.relays)
    expect(requests).toHaveLength(1)
    expect(connections).toBe(1)
  })
}

it("keeps verified partial observations when CLOSED reports throttling", async () => {
  const signed = finalizeEvent(
    { kind: 1, created_at: 100, tags: [], content: "Synthetic public fixture" },
    generateSecretKey()
  )
  onRequest = (socket, id) =>
    queueMicrotask(() => {
      socket.emit(["EVENT", id, signed])
      socket.emit(["CLOSED", id, "rate-limited: slow down"])
    })
  const result = await read()
  expect(result.events.map((event) => event.id)).toEqual([signed.id])
  expect(result.relays[0]).toEqual({
    relayUrl: relay,
    status: "partial",
    eventCount: 1,
    failureReason: "rate_limited",
  })
  expect(isRelayRateLimited(relay)).toBe(true)
  recordRelaySuccess(relay)
  expect(isRelayRateLimited(relay)).toBe(true)
  await read()
  expect(requests).toHaveLength(1)
})

it("suppresses queued requests after a shared connection receives a throttle", async () => {
  onRequest = (socket) => {
    if (requests.length === 1)
      queueMicrotask(() =>
        socket.emit(["NOTICE", "rate limited: subscription requests"])
      )
  }
  const results = await Promise.all(Array.from({ length: 12 }, read))
  expect(
    results.every(
      (result) => result.relays[0]?.failureReason === "rate_limited"
    )
  ).toBe(true)
  expect(requests.length).toBeLessThanOrEqual(8)
  expect(connections).toBe(1)
})

it("resumes reads after the throttle window expires", async () => {
  recordRelayRateLimit(relay, Date.now() - 60_001)
  onRequest = (socket, id) => queueMicrotask(() => socket.emit(["EOSE", id]))
  expect((await read()).relays[0]?.status).toBe("success")
  expect(requests).toHaveLength(1)
})

it("does not extend generic cooldown when every active subscription receives throttle CLOSED", async () => {
  onRequest = (socket) => {
    if (requests.length === 8)
      queueMicrotask(() => {
        for (const id of requests)
          socket.emit(["CLOSED", id, "rate-limited: subscription budget"])
      })
  }
  const results = await Promise.all(Array.from({ length: 8 }, read))
  expect(requests).toHaveLength(8)
  expect(
    results.every(
      (result) => result.relays[0]?.failureReason === "rate_limited"
    )
  ).toBe(true)
  const health = getRelayHealth(relay)!
  expect(health.consecutiveFailures).toBe(0)
  expect(health.cooldownUntil).toBeNull()
  expect(partitionByHealth([relay], health.rateLimitUntil!)).toEqual({
    healthy: [relay],
    parked: [],
  })
})

it("ignores informational NOTICE frames and unrelated subscription CLOSED frames", async () => {
  onRequest = (socket, id) =>
    queueMicrotask(() => {
      socket.emit(["NOTICE", "Welcome to this relay"])
      socket.emit(["CLOSED", "unrelated", "rate-limited: another subscription"])
      socket.emit(["EOSE", id])
    })
  expect((await read()).relays[0]?.status).toBe("success")
  expect(isRelayRateLimited(relay)).toBe(false)
})
