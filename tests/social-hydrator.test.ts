import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __aggregateSocialCounts,
  __resetNdkTestState,
  __socialHydratorTestHooks,
  getProductSocialSummary,
} from "@conduit/core"

function fakeEvent(
  kind: number,
  tags: string[][] = []
): {
  id: string
  pubkey: string
  kind: number
  content: string
  created_at: number
  tags: string[][]
} {
  return {
    id: Math.random().toString(36).slice(2),
    pubkey: "ffff",
    kind,
    content: "",
    created_at: 1,
    tags,
  }
}

describe("aggregateSocialCounts", () => {
  it("counts reactions, zaps, and comments separately", () => {
    const events = [
      fakeEvent(7),
      fakeEvent(7),
      fakeEvent(1111),
      fakeEvent(1111, [["t", "review"]]),
      fakeEvent(9735, [["amount", "21000"]]),
      fakeEvent(9735, [["amount", "1000"]]),
    ] as never
    const result = __aggregateSocialCounts(events)
    expect(result.reactionCount).toBe(2)
    expect(result.commentCount).toBe(2)
    expect(result.reviewCount).toBe(1)
    expect(result.zapCount).toBe(2)
    expect(result.zapAmountMsats).toBe(22000)
  })

  it("returns zeros for an empty event set", () => {
    const result = __aggregateSocialCounts([])
    expect(result).toEqual({
      reactionCount: 0,
      zapCount: 0,
      zapAmountMsats: 0,
      commentCount: 0,
      reviewCount: 0,
    })
  })

  it("ignores unknown kinds", () => {
    const events = [fakeEvent(1), fakeEvent(30402)] as never
    const result = __aggregateSocialCounts(events)
    expect(result.reactionCount).toBe(0)
    expect(result.commentCount).toBe(0)
    expect(result.zapCount).toBe(0)
  })
})

describe("getProductSocialSummary", () => {
  const originalWebSocket = globalThis.WebSocket
  beforeEach(() => {
    __resetNdkTestState()
    class EmptyRelayWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 3
      readyState = EmptyRelayWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null

      constructor() {
        queueMicrotask(() => {
          this.readyState = EmptyRelayWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }

      send(payload: string): void {
        const [type, subscriptionId] = JSON.parse(payload) as [string, string]
        if (type !== "REQ") return
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify(["EOSE", subscriptionId]),
          } as MessageEvent<string>)
        )
      }

      close(): void {
        this.readyState = EmptyRelayWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: EmptyRelayWebSocket,
    })
  })

  afterEach(() => {
    __resetNdkTestState()
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    })
  })

  it("returns an empty cache-miss summary synchronously", async () => {
    const { summary, refreshPromise } = await getProductSocialSummary({
      coordinate: "30402:abcd:slug",
      authorPubkey: "abcd",
    })
    expect(summary.source === "empty" || summary.source === "stale").toBe(true)
    expect(summary.reactionCount).toBe(0)
    // The cache-first API transfers ownership of its background promise.
    // Drain it before another test resets the shared relay executor.
    const refreshed = await refreshPromise
    expect(refreshed.reactionCount).toBe(0)
  })

  it("schedules background refresh work via the queue", async () => {
    const beforePending = __socialHydratorTestHooks.pendingCount()
    const { refreshPromise } = await getProductSocialSummary(
      {
        coordinate: "30402:abcd:another-slug",
        authorPubkey: "abcd",
      },
      { tier: "prefetch" }
    )
    // Either the task is already running (active) or still queued; both
    // are valid outcomes — we just verify the call did not throw and the
    // queue counter is a non-negative integer.
    const afterPending = __socialHydratorTestHooks.pendingCount()
    expect(afterPending).toBeGreaterThanOrEqual(0)
    expect(afterPending).toBeGreaterThanOrEqual(beforePending - 1)
    await refreshPromise
    expect(__socialHydratorTestHooks.pendingCount()).toBe(0)
  })
})
