const PRESENCE_PATH_PATTERN = /^\/v1\/presence\/([0-9a-f]{64})$/
const OPEN_READY_STATE = 1
export const PRESENCE_ROOM_CONNECTION_LIMIT = 512
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
}

export interface PresenceRoomState {
  acceptWebSocket(webSocket: WebSocket): void
  getWebSockets(): WebSocket[]
}

type PresenceWebSocketPairFactory = () => readonly [WebSocket, WebSocket]

function createPresenceWebSocketPair(): readonly [WebSocket, WebSocket] {
  const pair = new WebSocketPair()
  return [pair[0], pair[1]]
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

  const roomId = env.PRESENCE_ROOMS.idFromName(roomKey)
  return env.PRESENCE_ROOMS.get(roomId).fetch(request)
}

export class PresenceRoom {
  constructor(
    private readonly state: PresenceRoomState,
    _env?: PresenceEnv,
    private readonly createWebSocketPair: PresenceWebSocketPairFactory = createPresenceWebSocketPair
  ) {}

  fetch(request: Request): Response {
    if (!isAllowedPresenceOrigin(request.headers.get("origin"))) {
      return jsonResponse({ error: "origin_not_allowed" }, 403)
    }
    if (
      !getPresenceRoomKey(request.url) ||
      !isWebSocketUpgradeRequest(request)
    ) {
      return jsonResponse({ error: "websocket_upgrade_required" }, 426)
    }
    if (this.getOpenSockets().length >= PRESENCE_ROOM_CONNECTION_LIMIT) {
      return jsonResponse({ error: "room_at_capacity" }, 429)
    }

    const [client, server] = this.createWebSocketPair()
    this.state.acceptWebSocket(server)
    this.broadcastCount()

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  webSocketMessage(webSocket: WebSocket): void {
    this.closeSocket(webSocket, 1008, "Client messages are not accepted")
    this.broadcastCount(webSocket)
  }

  webSocketClose(webSocket: WebSocket): void {
    this.broadcastCount(webSocket)
  }

  webSocketError(webSocket: WebSocket): void {
    this.closeSocket(webSocket, 1011, "WebSocket error")
    this.broadcastCount(webSocket)
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
    excludedSockets: ReadonlySet<WebSocket> = new Set()
  ): WebSocket[] {
    return this.state
      .getWebSockets()
      .filter(
        (socket) =>
          !excludedSockets.has(socket) && socket.readyState === OPEN_READY_STATE
      )
  }

  private broadcastCount(excludedSocket?: WebSocket): void {
    const excludedSockets = new Set<WebSocket>()
    if (excludedSocket) excludedSockets.add(excludedSocket)

    for (let pass = 0; pass < MAX_BROADCAST_CORRECTION_PASSES; pass += 1) {
      const openSockets = this.getOpenSockets(excludedSockets)
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
