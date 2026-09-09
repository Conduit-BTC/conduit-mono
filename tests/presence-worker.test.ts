import { describe, expect, it } from "bun:test"

import {
  PresenceRoom,
  PRESENCE_GATEWAY_CONNECTION_LIMIT,
  PRESENCE_HEARTBEAT_REQUEST,
  PRESENCE_HEARTBEAT_RESPONSE,
  PRESENCE_SOURCE_CONNECTION_LIMIT,
  getPresenceRoomKey,
  handlePresenceRequest,
  isAllowedPresenceOrigin,
  type PresenceEnv,
  type PresenceRoomState,
} from "../apps/presence/src"

const ROOM_KEY = "a".repeat(64)
const SECOND_ROOM_KEY = "b".repeat(64)
const SOURCE_KEY = "c".repeat(64)
const SECOND_SOURCE_KEY = "d".repeat(64)
const SOURCE_KEY_HEADER = "x-conduit-presence-source-key"
const TEST_ABUSE_HMAC_KEY = "test-only-presence-abuse-hmac-key"
const MARKET_PREVIEW_ORIGIN = "https://test.conduit-market.pages.dev"

class FakeSocket {
  readyState = 1
  readonly messages: string[] = []
  closeCode: number | null = null
  failNextSend = false
  readonly failOnSendNumbers = new Set<number>()
  sendAttempts = 0
  private attachment: unknown = null

  send(message: string): void {
    this.sendAttempts += 1
    if (this.failNextSend || this.failOnSendNumbers.has(this.sendAttempts)) {
      this.failNextSend = false
      throw new Error("send failed")
    }
    this.messages.push(message)
  }

  close(code: number): void {
    this.closeCode = code
    this.readyState = 2
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment
  }

  deserializeAttachment(): unknown {
    return this.attachment
  }
}

class FakeRoomState {
  readonly sockets: FakeSocket[] = []
  private readonly tags = new Map<FakeSocket, Set<string>>()

  addSocket(
    socket: FakeSocket,
    roomKey = ROOM_KEY,
    sourceKey = SOURCE_KEY
  ): void {
    socket.serializeAttachment({ roomKey, sourceKey })
    this.acceptWebSocket(asWebSocket(socket), [roomKey])
  }

  acceptWebSocket(socket: WebSocket, tags: string[] = []): void {
    const fakeSocket = socket as unknown as FakeSocket
    this.sockets.push(fakeSocket)
    this.tags.set(fakeSocket, new Set(tags))
  }

  getWebSockets(tag?: string): WebSocket[] {
    const sockets = tag
      ? this.sockets.filter((socket) => this.tags.get(socket)?.has(tag))
      : this.sockets
    return sockets as unknown as WebSocket[]
  }
}

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket
}

function closedSocket(roomKey = ROOM_KEY, sourceKey = SOURCE_KEY): WebSocket {
  const socket = new FakeSocket()
  socket.serializeAttachment({ roomKey, sourceKey })
  socket.readyState = 3
  return asWebSocket(socket)
}

function gatewayUpgradeHeaders(sourceKey = SOURCE_KEY): HeadersInit {
  return {
    origin: MARKET_PREVIEW_ORIGIN,
    [SOURCE_KEY_HEADER]: sourceKey,
    upgrade: "websocket",
  }
}

function edgeUpgradeHeaders(clientIp = "192.0.2.1"): HeadersInit {
  return {
    "cf-connecting-ip": clientIp,
    origin: MARKET_PREVIEW_ORIGIN,
    upgrade: "websocket",
  }
}

describe("presence Worker request boundary", () => {
  it("accepts only exact Market preview-project origins", () => {
    for (const origin of [
      "https://branch.conduit-market.pages.dev",
      "https://a1b2c3.conduit-market-coo.pages.dev",
    ]) {
      expect(isAllowedPresenceOrigin(origin)).toBe(true)
    }

    for (const origin of [
      null,
      "http://shop.conduit.market",
      "https://shop.conduit.market",
      "https://sell.conduit.market",
      "https://conduit-market.pages.dev",
      "https://conduit-market-coo.pages.dev",
      "https://nested.branch.conduit-market.pages.dev",
      "https://branch.conduit-market.pages.dev.evil.example",
      "https://branch.conduit-market.pages.dev:444",
      "https://localhost:7000",
    ]) {
      expect(isAllowedPresenceOrigin(origin)).toBe(false)
    }
  })

  it("accepts only a query-free lowercase room key", () => {
    expect(
      getPresenceRoomKey(`https://presence.example/v1/presence/${ROOM_KEY}`)
    ).toBe(ROOM_KEY)
    expect(
      getPresenceRoomKey(`https://presence.example/v1/presence/${ROOM_KEY}?x=1`)
    ).toBeNull()
    expect(
      getPresenceRoomKey(
        `https://presence.example/v1/presence/${ROOM_KEY.toUpperCase()}`
      )
    ).toBeNull()
    expect(
      getPresenceRoomKey("https://presence.example/v1/presence/short")
    ).toBeNull()
  })

  it("serves a content-free health response", async () => {
    const response = await handlePresenceRequest(
      new Request("https://presence.example/health"),
      {} as PresenceEnv
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ status: "ok" })
  })

  it("rejects non-upgrade, cookie-bearing, and unauthorized requests", async () => {
    const makeRequest = (headers: HeadersInit) =>
      new Request(`https://presence.example/v1/presence/${ROOM_KEY}`, {
        headers,
      })

    const env = {} as PresenceEnv
    expect(
      (
        await handlePresenceRequest(
          makeRequest({ origin: MARKET_PREVIEW_ORIGIN }),
          env
        )
      ).status
    ).toBe(426)
    expect(
      (
        await handlePresenceRequest(
          makeRequest({
            cookie: "viewer=1",
            origin: MARKET_PREVIEW_ORIGIN,
            upgrade: "websocket",
          }),
          env
        )
      ).status
    ).toBe(426)
    expect(
      (
        await handlePresenceRequest(
          makeRequest({
            origin: "https://evil.example",
            upgrade: "websocket",
          }),
          env
        )
      ).status
    ).toBe(403)
  })

  it("routes every opaque room key through one bounded gateway object", async () => {
    const selectedNames: string[] = []
    const forwardedUrls: string[] = []
    const forwardedHeaders: Array<Record<string, string | null>> = []
    const env: PresenceEnv = {
      PRESENCE_ABUSE_HMAC_KEY: TEST_ABUSE_HMAC_KEY,
      PRESENCE_ROOMS: {
        idFromName(name) {
          selectedNames.push(name)
          return { toString: () => "room-id" } as DurableObjectId
        },
        get() {
          return {
            async fetch(request: Request) {
              forwardedUrls.push(request.url)
              forwardedHeaders.push({
                clientIp: request.headers.get("cf-connecting-ip"),
                origin: request.headers.get("origin"),
                sourceKey: request.headers.get(SOURCE_KEY_HEADER),
                userAgent: request.headers.get("user-agent"),
              })
              return new Response(null, { status: 204 })
            },
          } as DurableObjectStub
        },
      },
    }

    const makeRequest = (roomKey: string, clientIp: string) =>
      new Request(`https://presence.example/v1/presence/${roomKey}`, {
        headers: {
          ...edgeUpgradeHeaders(clientIp),
          "user-agent": "not-forwarded",
        },
      })
    const responses = [
      await handlePresenceRequest(makeRequest(ROOM_KEY, "192.0.2.1"), env),
      await handlePresenceRequest(
        makeRequest(SECOND_ROOM_KEY, "192.0.2.1"),
        env
      ),
      await handlePresenceRequest(makeRequest(ROOM_KEY, "192.0.2.2"), env),
    ]

    expect(responses.map((response) => response.status)).toEqual([
      204, 204, 204,
    ])
    expect(selectedNames).toEqual(["preview-v1", "preview-v1", "preview-v1"])
    expect(forwardedUrls).toEqual([
      `https://presence.example/v1/presence/${ROOM_KEY}`,
      `https://presence.example/v1/presence/${SECOND_ROOM_KEY}`,
      `https://presence.example/v1/presence/${ROOM_KEY}`,
    ])
    expect(forwardedHeaders).toHaveLength(3)
    expect(forwardedHeaders[0]?.clientIp).toBeNull()
    expect(forwardedHeaders[0]?.userAgent).toBeNull()
    expect(forwardedHeaders[0]?.origin).toBe(MARKET_PREVIEW_ORIGIN)
    expect(forwardedHeaders[0]?.sourceKey).toMatch(/^[0-9a-f]{64}$/)
    expect(forwardedHeaders[1]?.sourceKey).toBe(forwardedHeaders[0]?.sourceKey)
    expect(forwardedHeaders[2]?.sourceKey).not.toBe(
      forwardedHeaders[0]?.sourceKey
    )
  })

  it("fails closed when private source admission data is unavailable", async () => {
    const makeRequest = (headers: HeadersInit) =>
      new Request(`https://presence.example/v1/presence/${ROOM_KEY}`, {
        headers,
      })
    const unreachableRooms = {
      idFromName() {
        throw new Error("must not select a gateway")
      },
      get() {
        throw new Error("must not select a gateway")
      },
    }

    expect(
      (
        await handlePresenceRequest(makeRequest(edgeUpgradeHeaders()), {
          PRESENCE_ABUSE_HMAC_KEY: "short",
          PRESENCE_ROOMS: unreachableRooms,
        })
      ).status
    ).toBe(503)
    expect(
      (
        await handlePresenceRequest(
          makeRequest({
            origin: MARKET_PREVIEW_ORIGIN,
            upgrade: "websocket",
          }),
          {
            PRESENCE_ABUSE_HMAC_KEY: TEST_ABUSE_HMAC_KEY,
            PRESENCE_ROOMS: unreachableRooms,
          }
        )
      ).status
    ).toBe(503)
  })
})

describe("presence room counts", () => {
  it("configures a content-free hibernation heartbeat", () => {
    const state = new FakeRoomState()
    const configuredPairs: WebSocketRequestResponsePair[] = []
    const heartbeatPair = {
      request: PRESENCE_HEARTBEAT_REQUEST,
      response: PRESENCE_HEARTBEAT_RESPONSE,
    } as WebSocketRequestResponsePair
    const stateWithAutoResponse: PresenceRoomState = {
      acceptWebSocket: (socket, tags) => state.acceptWebSocket(socket, tags),
      getWebSockets: (tag) => state.getWebSockets(tag),
      setWebSocketAutoResponse: (pair) => configuredPairs.push(pair),
    }

    new PresenceRoom(
      stateWithAutoResponse,
      undefined,
      undefined,
      () => heartbeatPair
    )

    expect(configuredPairs).toEqual([heartbeatPair])
    expect(heartbeatPair.request).toBe('{"type":"ping"}')
    expect(heartbeatPair.response).toBe('{"type":"pong"}')
  })

  it("accepts an upgrade and sends the self-inclusive initial count", () => {
    const state = new FakeRoomState()
    const client = new FakeSocket()
    const server = new FakeSocket()
    const room = new PresenceRoom(state as PresenceRoomState, undefined, () => [
      asWebSocket(client),
      asWebSocket(server),
    ])

    const response = room.fetch(
      new Request(`https://presence.example/v1/presence/${ROOM_KEY}`, {
        headers: gatewayUpgradeHeaders(),
      })
    )

    expect(response.status).toBe(101)
    expect(state.sockets).toEqual([server])
    expect(server.deserializeAttachment()).toEqual({
      roomKey: ROOM_KEY,
      sourceKey: SOURCE_KEY,
    })
    expect(server.messages).toEqual(['{"count":1}'])
  })

  it("rejects another connection when the global gateway reaches its ceiling", () => {
    const state = new FakeRoomState()
    for (let index = 0; index < PRESENCE_GATEWAY_CONNECTION_LIMIT; index += 1) {
      state.addSocket(
        new FakeSocket(),
        index % 2 === 0 ? ROOM_KEY : SECOND_ROOM_KEY,
        index.toString(16).padStart(64, "0")
      )
    }
    let createdPair = false
    const room = new PresenceRoom(state as PresenceRoomState, undefined, () => {
      createdPair = true
      return [asWebSocket(new FakeSocket()), asWebSocket(new FakeSocket())]
    })

    const response = room.fetch(
      new Request(`https://presence.example/v1/presence/${ROOM_KEY}`, {
        headers: gatewayUpgradeHeaders(),
      })
    )

    expect(response.status).toBe(429)
    expect(createdPair).toBe(false)
    expect(state.sockets).toHaveLength(PRESENCE_GATEWAY_CONNECTION_LIMIT)
  })

  it("limits one private source across every room in the shared gateway", () => {
    const state = new FakeRoomState()
    for (let index = 0; index < PRESENCE_SOURCE_CONNECTION_LIMIT; index += 1) {
      state.addSocket(
        new FakeSocket(),
        index % 2 === 0 ? ROOM_KEY : SECOND_ROOM_KEY
      )
    }
    let createdPair = false
    const room = new PresenceRoom(state as PresenceRoomState, undefined, () => {
      createdPair = true
      return [asWebSocket(new FakeSocket()), asWebSocket(new FakeSocket())]
    })

    const response = room.fetch(
      new Request(`https://presence.example/v1/presence/${SECOND_ROOM_KEY}`, {
        headers: gatewayUpgradeHeaders(),
      })
    )

    expect(response.status).toBe(429)
    expect(createdPair).toBe(false)
    expect(state.sockets).toHaveLength(PRESENCE_SOURCE_CONNECTION_LIMIT)

    const alternateSourceResponse = room.fetch(
      new Request(`https://presence.example/v1/presence/${SECOND_ROOM_KEY}`, {
        headers: gatewayUpgradeHeaders(SECOND_SOURCE_KEY),
      })
    )
    expect(alternateSourceResponse.status).toBe(101)
    expect(createdPair).toBe(true)
  })

  it("broadcasts exact join and leave counts to open sockets", () => {
    const state = new FakeRoomState()
    const first = new FakeSocket()
    const second = new FakeSocket()
    state.addSocket(first)
    const room = new PresenceRoom(state)

    room.webSocketClose(closedSocket())
    expect(first.messages).toEqual(['{"count":1}'])

    state.addSocket(second)
    room.webSocketClose(closedSocket())
    expect(first.messages.at(-1)).toBe('{"count":2}')
    expect(second.messages.at(-1)).toBe('{"count":2}')

    first.readyState = 3
    room.webSocketClose(asWebSocket(first))
    expect(second.messages.at(-1)).toBe('{"count":1}')
  })

  it("keeps counts isolated between rooms inside the shared gateway", () => {
    const state = new FakeRoomState()
    const firstRoomSocket = new FakeSocket()
    const secondRoomSocket = new FakeSocket()
    state.addSocket(firstRoomSocket, ROOM_KEY)
    state.addSocket(secondRoomSocket, SECOND_ROOM_KEY)
    const room = new PresenceRoom(state)

    room.webSocketClose(closedSocket(ROOM_KEY))
    expect(firstRoomSocket.messages).toEqual(['{"count":1}'])
    expect(secondRoomSocket.messages).toEqual([])

    room.webSocketClose(closedSocket(SECOND_ROOM_KEY))
    expect(firstRoomSocket.messages).toEqual(['{"count":1}'])
    expect(secondRoomSocket.messages).toEqual(['{"count":1}'])
  })

  it("removes failed sends from the corrected count", () => {
    const state = new FakeRoomState()
    const failed = new FakeSocket()
    const healthy = new FakeSocket()
    failed.failNextSend = true
    state.addSocket(failed)
    state.addSocket(healthy)
    const room = new PresenceRoom(state)

    room.webSocketClose(closedSocket())

    expect(failed.closeCode).toBe(1011)
    expect(healthy.messages).toEqual(['{"count":2}', '{"count":1}'])
  })

  it("repeats correction when another socket fails on the next pass", () => {
    const state = new FakeRoomState()
    const firstFailure = new FakeSocket()
    const secondFailure = new FakeSocket()
    const healthy = new FakeSocket()
    firstFailure.failOnSendNumbers.add(1)
    secondFailure.failOnSendNumbers.add(2)
    state.addSocket(firstFailure)
    state.addSocket(secondFailure)
    state.addSocket(healthy)
    const room = new PresenceRoom(state)

    room.webSocketClose(closedSocket())

    expect(firstFailure.closeCode).toBe(1011)
    expect(secondFailure.closeCode).toBe(1011)
    expect(healthy.messages).toEqual([
      '{"count":3}',
      '{"count":2}',
      '{"count":1}',
    ])
  })

  it("closes non-heartbeat messages and excludes errored sockets", () => {
    const state = new FakeRoomState()
    const active = new FakeSocket()
    const invalid = new FakeSocket()
    state.addSocket(active)
    state.addSocket(invalid)
    const room = new PresenceRoom(state)

    room.webSocketMessage(asWebSocket(invalid))
    expect(invalid.closeCode).toBe(1008)
    expect(active.messages.at(-1)).toBe('{"count":1}')

    room.webSocketError(asWebSocket(invalid))
    expect(active.messages.at(-1)).toBe('{"count":1}')
  })
})
