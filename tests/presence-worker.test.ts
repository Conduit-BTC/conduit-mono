import { describe, expect, it } from "bun:test"

import {
  PresenceRoom,
  PRESENCE_GATEWAY_CONNECTION_LIMIT,
  getPresenceRoomKey,
  handlePresenceRequest,
  isAllowedPresenceOrigin,
  type PresenceEnv,
  type PresenceRoomState,
} from "../apps/presence/src"

const ROOM_KEY = "a".repeat(64)
const SECOND_ROOM_KEY = "b".repeat(64)
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

  addSocket(socket: FakeSocket, roomKey = ROOM_KEY): void {
    socket.serializeAttachment(roomKey)
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

function closedSocket(roomKey = ROOM_KEY): WebSocket {
  const socket = new FakeSocket()
  socket.serializeAttachment(roomKey)
  socket.readyState = 3
  return asWebSocket(socket)
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
    const env: PresenceEnv = {
      PRESENCE_ROOMS: {
        idFromName(name) {
          selectedNames.push(name)
          return { toString: () => "room-id" } as DurableObjectId
        },
        get() {
          return {
            async fetch(request: Request) {
              forwardedUrls.push(request.url)
              return new Response(null, { status: 204 })
            },
          } as DurableObjectStub
        },
      },
    }

    const responses = await Promise.all(
      [ROOM_KEY, SECOND_ROOM_KEY].map((roomKey) =>
        handlePresenceRequest(
          new Request(`https://presence.example/v1/presence/${roomKey}`, {
            headers: { origin: MARKET_PREVIEW_ORIGIN, upgrade: "websocket" },
          }),
          env
        )
      )
    )

    expect(responses.map((response) => response.status)).toEqual([204, 204])
    expect(selectedNames).toEqual(["preview-v1", "preview-v1"])
    expect(forwardedUrls).toEqual([
      `https://presence.example/v1/presence/${ROOM_KEY}`,
      `https://presence.example/v1/presence/${SECOND_ROOM_KEY}`,
    ])
  })
})

describe("presence room counts", () => {
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
        headers: { origin: MARKET_PREVIEW_ORIGIN, upgrade: "websocket" },
      })
    )

    expect(response.status).toBe(101)
    expect(state.sockets).toEqual([server])
    expect(server.deserializeAttachment()).toBe(ROOM_KEY)
    expect(server.messages).toEqual(['{"count":1}'])
  })

  it("rejects another connection when the global gateway reaches its ceiling", () => {
    const state = new FakeRoomState()
    for (let index = 0; index < PRESENCE_GATEWAY_CONNECTION_LIMIT; index += 1) {
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
      new Request(`https://presence.example/v1/presence/${ROOM_KEY}`, {
        headers: { origin: MARKET_PREVIEW_ORIGIN, upgrade: "websocket" },
      })
    )

    expect(response.status).toBe(429)
    expect(createdPair).toBe(false)
    expect(state.sockets).toHaveLength(PRESENCE_GATEWAY_CONNECTION_LIMIT)
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

  it("closes clients that send messages and excludes errored sockets", () => {
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
