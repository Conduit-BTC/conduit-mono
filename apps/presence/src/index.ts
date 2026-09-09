const PRESENCE_PATH_PATTERN = /^\/v1\/presence\/([0-9a-f]{64})$/
const PRESENCE_SOURCE_KEY_PATTERN = /^[0-9a-f]{64}$/
const CLOUDFLARE_CLIENT_IP_PATTERN = /^[0-9a-fA-F:.]{2,64}$/
const OPEN_READY_STATE = 1
// Route every page room through one preview gateway. Room hashes tag sockets;
// they never select or create additional Durable Object instances.
const PRESENCE_GATEWAY_OBJECT_NAME = "preview-v1"
const PRESENCE_SOURCE_KEY_HEADER = "x-conduit-presence-source-key"
const MINIMUM_ABUSE_HMAC_KEY_LENGTH = 32
export const PRESENCE_HEARTBEAT_REQUEST = '{"type":"ping"}'
export const PRESENCE_HEARTBEAT_RESPONSE = '{"type":"pong"}'
export const PRESENCE_GATEWAY_CONNECTION_LIMIT = 512
export const PRESENCE_SOURCE_CONNECTION_LIMIT = 8
const MAX_BROADCAST_CORRECTION_PASSES = 8

const allowedMarketPreviewSuffixes = [
  ".conduit-market.pages.dev",
  ".conduit-market-coo.pages.dev",
] as const

interface PresenceRoomNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

export interface PresenceEnv {
  PRESENCE_ROOMS: PresenceRoomNamespace
  PRESENCE_ABUSE_HMAC_KEY: string
}

export interface PresenceRoomState {
  acceptWebSocket(webSocket: WebSocket, tags?: string[]): void
  getWebSockets(tag?: string): WebSocket[]
  setWebSocketAutoResponse?(
    requestResponsePair: WebSocketRequestResponsePair
  ): void
}

type PresenceWebSocketPairFactory = () => readonly [WebSocket, WebSocket]
type PresenceHeartbeatPairFactory = () => WebSocketRequestResponsePair

type PresenceSocketAttachment = {
  roomKey: string
  sourceKey: string
}

function createPresenceWebSocketPair(): readonly [WebSocket, WebSocket] {
  const pair = new WebSocketPair()
  return [pair[0], pair[1]]
}

function createPresenceHeartbeatPair(): WebSocketRequestResponsePair {
  return new WebSocketRequestResponsePair(
    PRESENCE_HEARTBEAT_REQUEST,
    PRESENCE_HEARTBEAT_RESPONSE
  )
}

function bytesToLowercaseHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

async function createPresenceSourceKey(
  request: Request,
  hmacSecret: string
): Promise<string | null> {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim()
  if (
    !clientIp ||
    !CLOUDFLARE_CLIENT_IP_PATTERN.test(clientIp) ||
    hmacSecret.length < MINIMUM_ABUSE_HMAC_KEY_LENGTH
  ) {
    return null
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(hmacSecret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    )
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(clientIp)
    )
    return bytesToLowercaseHex(new Uint8Array(digest))
  } catch {
    return null
  }
}

function jsonResponse(body: Record<string, string>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  })
}

function hasOnePreviewLabel(hostname: string, suffix: string): boolean {
  if (!hostname.endsWith(suffix)) return false
  const label = hostname.slice(0, -suffix.length)
  return label.length > 0 && !label.includes(".")
}

export function isAllowedPresenceOrigin(rawOrigin: string | null): boolean {
  if (!rawOrigin) return false

  try {
    const origin = new URL(rawOrigin)
    if (
      origin.protocol !== "https:" ||
      origin.port ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      rawOrigin !== origin.origin
    ) {
      return false
    }

    const hostname = origin.hostname.toLowerCase()
    return allowedMarketPreviewSuffixes.some((suffix) =>
      hasOnePreviewLabel(hostname, suffix)
    )
  } catch {
    return false
  }
}

export function getPresenceRoomKey(requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }

  if (url.search || url.hash) return null
  return PRESENCE_PATH_PATTERN.exec(url.pathname)?.[1] ?? null
}

function isWebSocketUpgradeRequest(request: Request): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    request.body === null &&
    !request.headers.has("cookie") &&
    !request.headers.has("content-length") &&
    !request.headers.has("transfer-encoding") &&
    !request.headers.has("sec-websocket-protocol")
  )
}

export async function handlePresenceRequest(
  request: Request,
  env: PresenceEnv
): Promise<Response> {
  const requestUrl = new URL(request.url)

  if (
    request.method === "GET" &&
    requestUrl.pathname === "/health" &&
    !requestUrl.search &&
    !requestUrl.hash
  ) {
    return jsonResponse({ status: "ok" }, 200)
  }

  const roomKey = getPresenceRoomKey(request.url)
  if (!roomKey) return jsonResponse({ error: "not_found" }, 404)
  if (!isAllowedPresenceOrigin(request.headers.get("origin"))) {
    return jsonResponse({ error: "origin_not_allowed" }, 403)
  }
  if (!isWebSocketUpgradeRequest(request)) {
    return jsonResponse({ error: "websocket_upgrade_required" }, 426)
  }

  const sourceKey = await createPresenceSourceKey(
    request,
    env.PRESENCE_ABUSE_HMAC_KEY
  )
  if (!sourceKey) {
    return jsonResponse({ error: "admission_unavailable" }, 503)
  }

  const gatewayId = env.PRESENCE_ROOMS.idFromName(PRESENCE_GATEWAY_OBJECT_NAME)
  return env.PRESENCE_ROOMS.get(gatewayId).fetch(
    new Request(request, {
      headers: {
        origin: request.headers.get("origin") ?? "",
        [PRESENCE_SOURCE_KEY_HEADER]: sourceKey,
        upgrade: "websocket",
      },
    })
  )
}

export class PresenceRoom {
  constructor(
    private readonly state: PresenceRoomState,
    _env?: PresenceEnv,
    private readonly createWebSocketPair: PresenceWebSocketPairFactory = createPresenceWebSocketPair,
    createHeartbeatPair: PresenceHeartbeatPairFactory = createPresenceHeartbeatPair
  ) {
    this.state.setWebSocketAutoResponse?.(createHeartbeatPair())
  }

  fetch(request: Request): Response {
    if (!isAllowedPresenceOrigin(request.headers.get("origin"))) {
      return jsonResponse({ error: "origin_not_allowed" }, 403)
    }
    const roomKey = getPresenceRoomKey(request.url)
    if (!roomKey || !isWebSocketUpgradeRequest(request)) {
      return jsonResponse({ error: "websocket_upgrade_required" }, 426)
    }
    const sourceKey = request.headers.get(PRESENCE_SOURCE_KEY_HEADER)
    if (!sourceKey || !PRESENCE_SOURCE_KEY_PATTERN.test(sourceKey)) {
      return jsonResponse({ error: "admission_required" }, 403)
    }

    const attachedSockets = this.state.getWebSockets()
    if (
      attachedSockets.filter(
        (socket) => this.getSocketAttachment(socket)?.sourceKey === sourceKey
      ).length >= PRESENCE_SOURCE_CONNECTION_LIMIT
    ) {
      return jsonResponse({ error: "source_at_capacity" }, 429)
    }
    if (attachedSockets.length >= PRESENCE_GATEWAY_CONNECTION_LIMIT) {
      return jsonResponse({ error: "gateway_at_capacity" }, 429)
    }

    const [client, server] = this.createWebSocketPair()
    server.serializeAttachment({ roomKey, sourceKey })
    this.state.acceptWebSocket(server, [roomKey])
    this.broadcastCount(roomKey)

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  webSocketMessage(webSocket: WebSocket): void {
    const roomKey = this.getSocketRoomKey(webSocket)
    this.closeSocket(webSocket, 1008, "Unsupported client message")
    if (roomKey) this.broadcastCount(roomKey, webSocket)
  }

  webSocketClose(webSocket: WebSocket): void {
    const roomKey = this.getSocketRoomKey(webSocket)
    if (roomKey) this.broadcastCount(roomKey, webSocket)
  }

  webSocketError(webSocket: WebSocket): void {
    const roomKey = this.getSocketRoomKey(webSocket)
    this.closeSocket(webSocket, 1011, "WebSocket error")
    if (roomKey) this.broadcastCount(roomKey, webSocket)
  }

  private getSocketRoomKey(webSocket: WebSocket): string | null {
    const attachment: unknown = webSocket.deserializeAttachment()
    if (
      typeof attachment === "string" &&
      PRESENCE_PATH_PATTERN.test(`/v1/presence/${attachment}`)
    ) {
      return attachment
    }
    return this.getSocketAttachment(webSocket)?.roomKey ?? null
  }

  private getSocketAttachment(
    webSocket: WebSocket
  ): PresenceSocketAttachment | null {
    const attachment: unknown = webSocket.deserializeAttachment()
    if (!attachment || typeof attachment !== "object") return null

    const record = attachment as Record<string, unknown>
    return Object.keys(record).length === 2 &&
      typeof record.roomKey === "string" &&
      PRESENCE_SOURCE_KEY_PATTERN.test(record.roomKey) &&
      typeof record.sourceKey === "string" &&
      PRESENCE_SOURCE_KEY_PATTERN.test(record.sourceKey)
      ? { roomKey: record.roomKey, sourceKey: record.sourceKey }
      : null
  }

  private closeSocket(
    webSocket: WebSocket,
    code: number,
    reason: string
  ): void {
    try {
      webSocket.close(code, reason)
    } catch {
      // A concurrent close can make the socket terminal before this callback.
    }
  }

  private getOpenSockets(
    roomKey: string,
    excludedSockets: ReadonlySet<WebSocket> = new Set()
  ): WebSocket[] {
    return this.state
      .getWebSockets(roomKey)
      .filter(
        (socket) =>
          !excludedSockets.has(socket) && socket.readyState === OPEN_READY_STATE
      )
  }

  private broadcastCount(roomKey: string, excludedSocket?: WebSocket): void {
    const excludedSockets = new Set<WebSocket>()
    if (excludedSocket) excludedSockets.add(excludedSocket)

    for (let pass = 0; pass < MAX_BROADCAST_CORRECTION_PASSES; pass += 1) {
      const openSockets = this.getOpenSockets(roomKey, excludedSockets)
      const payload = JSON.stringify({ count: openSockets.length })
      let sendFailed = false

      for (const socket of openSockets) {
        try {
          socket.send(payload)
        } catch {
          sendFailed = true
          excludedSockets.add(socket)
          this.closeSocket(socket, 1011, "WebSocket send failed")
        }
      }

      if (!sendFailed) return
    }
  }
}

export default {
  fetch(request: Request, env: PresenceEnv): Promise<Response> {
    return handlePresenceRequest(request, env)
  },
}
