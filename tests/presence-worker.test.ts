import { describe, expect, it } from "bun:test"

import {
  PresenceRoom,
  PRESENCE_ROOM_CONNECTION_LIMIT,
  getPresenceRoomKey,
  handlePresenceRequest,
  isAllowedPresenceOrigin,
  type PresenceEnv,
  type PresenceRoomState,
} from "../apps/presence/src"

const ROOM_KEY = "a".repeat(64)
const MARKET_PREVIEW_ORIGIN = "https://test.conduit-market.pages.dev"

class FakeSocket {
  readyState = 1
  readonly messages: string[] = []
  closeCode: number | null = null
  failNextSend = false
  readonly failOnSendNumbers = new Set<number>()
  sendAttempts = 0

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
}

class FakeRoomState {
  readonly sockets: FakeSocket[] = []

  acceptWebSocket(socket: WebSocket): void {
    this.sockets.push(socket as unknown as FakeSocket)
  }

  getWebSockets(): WebSocket[] {
    return this.sockets as unknown as WebSocket[]
  }
}

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket
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

  it("routes a valid opaque room key without forwarding page identity", async () => {
    let selectedName: string | null = null
    let forwardedUrl: string | null = null
    const env: PresenceEnv = {
      PRESENCE_ROOMS: {
        idFromName(name) {
          selectedName = name
          return { toString: () => "room-id" } as DurableObjectId
        },
        get() {
          return {
            async fetch(request: Request) {
              forwardedUrl = request.url
              return new Response(null, { status: 204 })
            },
          } as DurableObjectStub
        },
      },
    }

    const response = await handlePresenceRequest(
      new Request(`https://presence.example/v1/presence/${ROOM_KEY}`, {
        headers: { origin: MARKET_PREVIEW_ORIGIN, upgrade: "websocket" },
      }),
      env
    )

    expect(response.status).toBe(204)
    expect(selectedName).toBe(ROOM_KEY)
    expect(forwardedUrl).toBe(
      `https://presence.example/v1/presence/${ROOM_KEY}`
    )
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
    expect(server.messages).toEqual(['{"count":1}'])
  })

  it("rejects another connection when a room reaches its ceiling", () => {
    const state = new FakeRoomState()
    for (let index = 0; index < PRESENCE_ROOM_CONNECTION_LIMIT; index += 1) {
      state.sockets.push(new FakeSocket())
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
    expect(state.sockets).toHaveLength(PRESENCE_ROOM_CONNECTION_LIMIT)
  })

  it("broadcasts exact join and leave counts to open sockets", () => {
    const state = new FakeRoomState()
    const first = new FakeSocket()
    const second = new FakeSocket()
    state.sockets.push(first)
    const room = new PresenceRoom(state)

    room.webSocketClose({ readyState: 3 } as WebSocket)
    expect(first.messages).toEqual(['{"count":1}'])

    state.sockets.push(second)
    room.webSocketClose({ readyState: 3 } as WebSocket)
    expect(first.messages.at(-1)).toBe('{"count":2}')
    expect(second.messages.at(-1)).toBe('{"count":2}')

    first.readyState = 3
    room.webSocketClose(asWebSocket(first))
    expect(second.messages.at(-1)).toBe('{"count":1}')
  })

  it("removes failed sends from the corrected count", () => {
    const state = new FakeRoomState()
    const failed = new FakeSocket()
    const healthy = new FakeSocket()
    failed.failNextSend = true
    state.sockets.push(failed, healthy)
    const room = new PresenceRoom(state)

    room.webSocketClose({ readyState: 3 } as WebSocket)

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
    state.sockets.push(firstFailure, secondFailure, healthy)
    const room = new PresenceRoom(state)

    room.webSocketClose({ readyState: 3 } as WebSocket)

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
    state.sockets.push(active, invalid)
    const room = new PresenceRoom(state)

    room.webSocketMessage(asWebSocket(invalid))
    expect(invalid.closeCode).toBe(1008)
    expect(active.messages.at(-1)).toBe('{"count":1}')

    room.webSocketError(asWebSocket(invalid))
    expect(active.messages.at(-1)).toBe('{"count":1}')
  })
})
