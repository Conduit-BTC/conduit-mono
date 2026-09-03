export type LivePresencePageType = "product" | "store"

export const DEFAULT_LIVE_PRESENCE_WEBSOCKET_URL = ""

export const LIVE_PRESENCE_MAX_RECONNECT_ATTEMPTS = 5
export const LIVE_PRESENCE_MAX_COUNT = 512

const LIVE_PRESENCE_RECONNECT_BASE_DELAY_MS = 1_000
const LIVE_PRESENCE_RECONNECT_MAX_DELAY_MS = 16_000
const LIVE_PRESENCE_SCOPE_HASH_PATTERN = /^[0-9a-f]{64}$/

type LivePresenceSocketEventType = "close" | "error" | "message" | "open"

export interface LivePresenceSocket {
  readonly readyState: number
  addEventListener(
    type: LivePresenceSocketEventType,
    listener: (event: { data?: unknown }) => void
  ): void
  close(code?: number, reason?: string): void
}

export interface LivePresenceRuntime {
  createSocket(url: string): LivePresenceSocket
  isOnline(): boolean
  isVisible(): boolean
  schedule(callback: () => void, delayMs: number): number
  cancel(handle: number): void
  subscribeActivity(listener: () => void): () => void
}

export interface LivePresenceSessionOptions {
  endpoint: string
  scopeHash: string
  runtime: LivePresenceRuntime
  onCount(count: number | null): void
}

function bytesToLowercaseHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

export async function hashLivePresenceScope(input: {
  canonicalId: string
  hostname: string
  pageType: LivePresencePageType
  subtle?: SubtleCrypto
}): Promise<string> {
  const canonicalId = input.canonicalId.trim()
  const hostname = input.hostname.trim().toLowerCase()
  if (!canonicalId || !hostname) {
    throw new Error("Live presence requires a hostname and canonical page ID")
  }

  const subtle = input.subtle ?? globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("Live presence requires Web Crypto")
  }

  const scopeInput = JSON.stringify([
    "conduit-live-presence-v1",
    hostname,
    input.pageType,
    canonicalId,
  ])
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(scopeInput)
  )
  return bytesToLowercaseHex(new Uint8Array(digest))
}

export function resolveLivePresenceWebSocketUrl(
  override = import.meta.env.VITE_PRESENCE_WS_URL
): string | null {
  const candidate = override?.trim() || DEFAULT_LIVE_PRESENCE_WEBSOCKET_URL
  if (!candidate) return null

  try {
    const url = new URL(candidate)
    if (
      url.protocol !== "wss:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null
    }

    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    return url.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

export function buildLivePresenceWebSocketUrl(
  endpoint: string,
  scopeHash: string
): string {
  const resolvedEndpoint = resolveLivePresenceWebSocketUrl(endpoint)
  if (!resolvedEndpoint || !LIVE_PRESENCE_SCOPE_HASH_PATTERN.test(scopeHash)) {
    throw new Error("Invalid live presence endpoint or scope hash")
  }

  const url = new URL(resolvedEndpoint)
  const basePath = url.pathname.replace(/\/+$/, "")
  url.pathname = `${basePath}/v1/presence/${scopeHash}`
  return url.toString()
}

export function parseLivePresenceCount(message: unknown): number | null {
  if (typeof message !== "string") return null

  try {
    const value: unknown = JSON.parse(message)
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null
    }

    const record = value as Record<string, unknown>
    const count = record.count
    if (
      Object.keys(record).length !== 1 ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > LIVE_PRESENCE_MAX_COUNT
    ) {
      return null
    }

    return count
  } catch {
    return null
  }
}

export function isLivePresencePermitted(input: {
  featureEnabled: boolean
  globalPrivacyControl: boolean
}): boolean {
  return input.featureEnabled && !input.globalPrivacyControl
}

export function startLivePresenceSession(
  options: LivePresenceSessionOptions
): () => void {
  let disposed = false
  let socket: LivePresenceSocket | null = null
  let retryHandle: number | null = null
  let reconnectAttempts = 0
  let wasActive = options.runtime.isVisible() && options.runtime.isOnline()

  const clearRetry = () => {
    if (retryHandle === null) return
    options.runtime.cancel(retryHandle)
    retryHandle = null
  }

  const closeSocket = () => {
    const activeSocket = socket
    socket = null
    if (!activeSocket) return

    try {
      activeSocket.close(1000, "Presence inactive")
    } catch {
      // The socket is already closing or closed.
    }
  }

  const isActive = () =>
    !disposed && options.runtime.isVisible() && options.runtime.isOnline()

  const scheduleReconnect = () => {
    if (
      !isActive() ||
      retryHandle !== null ||
      reconnectAttempts >= LIVE_PRESENCE_MAX_RECONNECT_ATTEMPTS
    ) {
      return
    }

    const delayMs = Math.min(
      LIVE_PRESENCE_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts,
      LIVE_PRESENCE_RECONNECT_MAX_DELAY_MS
    )
    reconnectAttempts += 1
    retryHandle = options.runtime.schedule(() => {
      retryHandle = null
      connect()
    }, delayMs)
  }

  const handleDisconnect = (disconnectedSocket: LivePresenceSocket) => {
    if (disposed || socket !== disconnectedSocket) return
    socket = null
    options.onCount(null)
    try {
      disconnectedSocket.close()
    } catch {
      // The socket is already closing or closed.
    }
    scheduleReconnect()
  }

  const connect = () => {
    if (!isActive() || socket || retryHandle !== null) return

    let nextSocket: LivePresenceSocket
    try {
      nextSocket = options.runtime.createSocket(
        buildLivePresenceWebSocketUrl(options.endpoint, options.scopeHash)
      )
    } catch {
      options.onCount(null)
      scheduleReconnect()
      return
    }

    socket = nextSocket
    nextSocket.addEventListener("message", (event) => {
      if (disposed || socket !== nextSocket) return
      const count = parseLivePresenceCount(event.data)
      if (count === null) return
      reconnectAttempts = 0
      options.onCount(count)
    })
    nextSocket.addEventListener("close", () => {
      handleDisconnect(nextSocket)
    })
    nextSocket.addEventListener("error", () => {
      handleDisconnect(nextSocket)
    })
  }

  const handleActivityChange = () => {
    const active = options.runtime.isVisible() && options.runtime.isOnline()
    if (!active) {
      wasActive = false
      clearRetry()
      closeSocket()
      options.onCount(null)
      return
    }

    if (!wasActive) reconnectAttempts = 0
    wasActive = true
    connect()
  }

  const unsubscribeActivity =
    options.runtime.subscribeActivity(handleActivityChange)
  if (wasActive) connect()

  return () => {
    disposed = true
    clearRetry()
    closeSocket()
    unsubscribeActivity()
  }
}
