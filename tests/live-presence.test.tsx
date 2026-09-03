import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { renderToStaticMarkup } from "react-dom/server"
import {
  LivePresenceIndicator,
  getLivePresenceLabel,
} from "../apps/market/src/components/LivePresenceIndicator"
import {
  LIVE_PRESENCE_MAX_RECONNECT_ATTEMPTS,
  LIVE_PRESENCE_MAX_COUNT,
  buildLivePresenceWebSocketUrl,
  hashLivePresenceScope,
  isLivePresencePermitted,
  parseLivePresenceCount,
  resolveLivePresenceWebSocketUrl,
  startLivePresenceSession,
  type LivePresenceRuntime,
  type LivePresenceSocket,
} from "../apps/market/src/lib/live-presence"

type SocketEventType = "close" | "error" | "message" | "open"

class FakePresenceSocket implements LivePresenceSocket {
  readyState = 0
  closeCalls: Array<{ code?: number; reason?: string }> = []
  private readonly listeners = new Map<
    SocketEventType,
    Array<(event: { data?: unknown }) => void>
  >()

  addEventListener(
    type: SocketEventType,
    listener: (event: { data?: unknown }) => void
  ): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 2
    this.closeCalls.push({ code, reason })
  }

  emit(type: SocketEventType, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

function createRuntime(initial?: { online?: boolean; visible?: boolean }) {
  let online = initial?.online ?? true
  let visible = initial?.visible ?? true
  let nextTimerId = 1
  const activityListeners = new Set<() => void>()
  const timers = new Map<number, { callback: () => void; delayMs: number }>()
  const sockets: FakePresenceSocket[] = []
  const urls: string[] = []

  const runtime: LivePresenceRuntime = {
    createSocket: (url) => {
      const socket = new FakePresenceSocket()
      sockets.push(socket)
      urls.push(url)
      return socket
    },
    isOnline: () => online,
    isVisible: () => visible,
    schedule: (callback, delayMs) => {
      const timerId = nextTimerId
      nextTimerId += 1
      timers.set(timerId, { callback, delayMs })
      return timerId
    },
    cancel: (timerId) => {
      timers.delete(timerId)
    },
    subscribeActivity: (listener) => {
      activityListeners.add(listener)
      return () => activityListeners.delete(listener)
    },
  }

  return {
    activityListenerCount: () => activityListeners.size,
    fireActivity: () => {
      for (const listener of activityListeners) listener()
    },
    nextTimer: () => {
      const next = timers.entries().next().value as
        [number, { callback: () => void; delayMs: number }] | undefined
      if (!next) return null
      timers.delete(next[0])
      next[1].callback()
      return next[1].delayMs
    },
    pendingTimerCount: () => timers.size,
    runtime,
    setOnline: (value: boolean) => {
      online = value
    },
    setVisible: (value: boolean) => {
      visible = value
    },
    sockets,
    urls,
  }
}

const SCOPE_HASH = "a".repeat(64)
const ENDPOINT = "wss://presence.example.com"

describe("live presence privacy boundary", () => {
  it("hashes deployment host, page type, and canonical ID into a 64-hex scope", async () => {
    const productHash = await hashLivePresenceScope({
      canonicalId: "30402:abc:hat",
      hostname: "PREVIEW.EXAMPLE.COM",
      pageType: "product",
    })
    const repeatedHash = await hashLivePresenceScope({
      canonicalId: "30402:abc:hat",
      hostname: "preview.example.com",
      pageType: "product",
    })
    const storeHash = await hashLivePresenceScope({
      canonicalId: "30402:abc:hat",
      hostname: "preview.example.com",
      pageType: "store",
    })

    expect(productHash).toMatch(/^[0-9a-f]{64}$/)
    expect(repeatedHash).toBe(productHash)
    expect(storeHash).not.toBe(productHash)
  })

  it("accepts only credential-free WSS base URLs without query data", () => {
    const userInfoUrl = new URL("wss://presence.example.com")
    userInfoUrl.username = ["viewer", "name"].join("-")
    userInfoUrl.password = ["access", "value"].join("-")

    expect(resolveLivePresenceWebSocketUrl("wss://presence.example.com/")).toBe(
      ENDPOINT
    )
    expect(
      resolveLivePresenceWebSocketUrl("ws://presence.example.com")
    ).toBeNull()
    expect(
      resolveLivePresenceWebSocketUrl("wss://presence.example.com?viewer=1")
    ).toBeNull()
    expect(resolveLivePresenceWebSocketUrl(userInfoUrl.toString())).toBeNull()
  })

  it("puts only the opaque scope hash in the presence URL", () => {
    expect(buildLivePresenceWebSocketUrl(ENDPOINT, SCOPE_HASH)).toBe(
      `${ENDPOINT}/v1/presence/${SCOPE_HASH}`
    )
    expect(() =>
      buildLivePresenceWebSocketUrl(ENDPOINT, "30402:abc:hat")
    ).toThrow()
  })

  it("honors Global Privacy Control even when the feature is enabled", () => {
    expect(
      isLivePresencePermitted({
        featureEnabled: true,
        globalPrivacyControl: true,
      })
    ).toBe(false)
    expect(
      isLivePresencePermitted({
        featureEnabled: true,
        globalPrivacyControl: false,
      })
    ).toBe(true)
  })
})

describe("live presence count messages", () => {
  it("accepts an exact nonnegative integer count", () => {
    expect(parseLivePresenceCount('{"count":0}')).toBe(0)
    expect(parseLivePresenceCount('{"count":21}')).toBe(21)
  })

  it("rejects malformed, ambiguous, and binary messages", () => {
    expect(parseLivePresenceCount('{"count":2.5}')).toBeNull()
    expect(parseLivePresenceCount('{"count":-1}')).toBeNull()
    expect(parseLivePresenceCount('{"count":"2"}')).toBeNull()
    expect(parseLivePresenceCount('{"count":2,"viewer":"abc"}')).toBeNull()
    expect(
      parseLivePresenceCount(
        JSON.stringify({ count: LIVE_PRESENCE_MAX_COUNT + 1 })
      )
    ).toBeNull()
    expect(parseLivePresenceCount("not json")).toBeNull()
    expect(parseLivePresenceCount(new Uint8Array([1, 2]))).toBeNull()
  })
})

describe("live presence connection lifecycle", () => {
  it("connects only while the page is visible and online", () => {
    const browser = createRuntime({ online: false })
    const counts: Array<number | null> = []
    const stop = startLivePresenceSession({
      endpoint: ENDPOINT,
      scopeHash: SCOPE_HASH,
      runtime: browser.runtime,
      onCount: (count) => counts.push(count),
    })

    expect(browser.sockets).toHaveLength(0)
    browser.setOnline(true)
    browser.fireActivity()
    expect(browser.sockets).toHaveLength(1)

    browser.sockets[0]!.emit("message", '{"count":3}')
    expect(counts.at(-1)).toBe(3)

    browser.setVisible(false)
    browser.fireActivity()
    expect(browser.sockets[0]!.closeCalls).toEqual([
      { code: 1000, reason: "Presence inactive" },
    ])
    expect(counts.at(-1)).toBeNull()

    browser.sockets[0]!.emit("message", '{"count":99}')
    expect(counts.at(-1)).toBeNull()

    browser.setVisible(true)
    browser.fireActivity()
    expect(browser.sockets).toHaveLength(2)

    stop()
    expect(browser.sockets[1]!.closeCalls).toEqual([
      { code: 1000, reason: "Presence inactive" },
    ])
    expect(browser.activityListenerCount()).toBe(0)
  })

  it("ignores stale sockets and bounds consecutive reconnects", () => {
    const browser = createRuntime()
    const counts: Array<number | null> = []
    const stop = startLivePresenceSession({
      endpoint: ENDPOINT,
      scopeHash: SCOPE_HASH,
      runtime: browser.runtime,
      onCount: (count) => counts.push(count),
    })

    const firstSocket = browser.sockets[0]!
    firstSocket.emit("close")
    expect(browser.pendingTimerCount()).toBe(1)
    expect(browser.nextTimer()).toBe(1_000)

    firstSocket.emit("message", '{"count":99}')
    expect(counts).not.toContain(99)
    browser.sockets[1]!.emit("message", '{"count":2}')
    expect(counts.at(-1)).toBe(2)

    for (
      let attempt = 0;
      attempt < LIVE_PRESENCE_MAX_RECONNECT_ATTEMPTS;
      attempt += 1
    ) {
      browser.sockets.at(-1)!.emit("close")
      expect(browser.pendingTimerCount()).toBe(1)
      browser.nextTimer()
    }
    browser.sockets.at(-1)!.emit("close")

    expect(browser.sockets).toHaveLength(
      LIVE_PRESENCE_MAX_RECONNECT_ATTEMPTS + 2
    )
    expect(browser.pendingTimerCount()).toBe(0)
    stop()
  })
})

describe("LivePresenceIndicator", () => {
  it("uses exact singular and plural product/store copy", () => {
    expect(getLivePresenceLabel(1, "product")).toBe(
      "1 visitor is looking at this product"
    )
    expect(getLivePresenceLabel(20, "product")).toBe(
      "20 visitors are looking at this product"
    )
    expect(getLivePresenceLabel(1, "store")).toBe(
      "1 visitor is browsing this store"
    )
    expect(getLivePresenceLabel(8, "store")).toBe(
      "8 visitors are browsing this store"
    )
  })

  it("renders a polite status with the exact-session caveat", () => {
    const markup = renderToStaticMarkup(
      <LivePresenceIndicator count={20} pageType="product" />
    )

    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain("tabular-nums")
    expect(markup).toContain("20 visitors are looking at this product")
    expect(markup).toContain("exact number of active page sessions")
  })

  it("hides loading, disconnected, and zero states", () => {
    expect(
      renderToStaticMarkup(
        <LivePresenceIndicator count={null} pageType="store" />
      )
    ).toBe("")
    expect(
      renderToStaticMarkup(<LivePresenceIndicator count={0} pageType="store" />)
    ).toBe("")
  })

  it("wires product variations and normalized storefront keys", async () => {
    const productRoute = await readFile(
      "apps/market/src/routes/products/$productId.tsx",
      "utf8"
    )
    const storeRoute = await readFile(
      "apps/market/src/routes/store/$pubkey.tsx",
      "utf8"
    )

    expect(productRoute).toContain("canonicalId: selectedProduct?.id")
    expect(storeRoute).toContain("canonicalId: normalizedStorePubkey")
  })
})
