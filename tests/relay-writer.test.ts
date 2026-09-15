import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { applyE2eRelayIsolation, config } from "@conduit/core"
import { publishSignedEventFrameToRelay } from "../packages/core/src/protocol/relay-writer"
import { waitForVisibleDocument } from "../packages/core/src/protocol/interactive-signer"
import type { NostrEventSigner } from "../packages/core/src/protocol/nostr-event-signer"

const SECRET = Uint8Array.from([...new Uint8Array(31), 23])
const AUTH_SECRET = generateSecretKey()
const AUTH_PUBKEY = getPublicKey(AUTH_SECRET)
const AUTH_SESSION_SCOPE = {}
const originalConfig = structuredClone(config)

function signedEvent() {
  return finalizeEvent(
    {
      kind: 5,
      created_at: 1_700_000_000,
      tags: [["e", "a".repeat(64)]],
      content: "",
    },
    SECRET
  )
}

class WriterTestSocket {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  closeCalls = 0
  throwOnSend = false
  sentPayloads: string[] = []
  onSend?: (payload: string) => void

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event("open"))
  }

  send(payload: string): void {
    if (this.throwOnSend) throw new Error("send failed")
    this.sentPayloads.push(payload)
    this.onSend?.(payload)
  }

  message(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>)
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
  }
}

function authSigner(secret = AUTH_SECRET): NostrEventSigner {
  return {
    authMethod: "nip07",
    getPublicKey: async () => getPublicKey(secret),
    signEvent: async (event) =>
      finalizeEvent(
        {
          kind: event.kind,
          created_at: event.created_at,
          tags: event.tags,
          content: event.content,
        },
        secret
      ),
  }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe("exact relay writer", () => {
  afterEach(() => {
    Object.assign(config, structuredClone(originalConfig))
  })

  it("forces explicit writer targets onto loopback during E2E isolation", async () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    const socket = new WriterTestSocket()
    let openedRelayUrl: string | undefined
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))

    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://relay.damus.io",
      signedEvent: signedEvent(),
      timeoutMs: 10,
      createWebSocket: (relayUrl) => {
        openedRelayUrl = relayUrl
        return socket as unknown as WebSocket
      },
    })

    expect(openedRelayUrl).toBe(isolatedRelayUrl)
    socket.onerror?.(new Event("error"))
    await expect(result).resolves.toBe("timed_out")
  })

  it("preserves an explicit secure writer target outside E2E isolation", async () => {
    const publicRelayUrl = "wss://relay.damus.io"
    const socket = new WriterTestSocket()
    let openedRelayUrl: string | undefined

    const result = publishSignedEventFrameToRelay({
      relayUrl: publicRelayUrl,
      signedEvent: signedEvent(),
      timeoutMs: 10,
      createWebSocket: (relayUrl) => {
        openedRelayUrl = relayUrl
        return socket as unknown as WebSocket
      },
    })

    expect(openedRelayUrl).toBe(publicRelayUrl)
    socket.onerror?.(new Event("error"))
    await expect(result).resolves.toBe("timed_out")
  })

  it("turns constructor failures into a retryable result", async () => {
    await expect(
      publishSignedEventFrameToRelay({
        relayUrl: "wss://constructor-failure.conduit.market",
        signedEvent: signedEvent(),
        timeoutMs: 10,
        createWebSocket: () => {
          throw new Error("constructor failed")
        },
      })
    ).resolves.toBe("timed_out")
  })

  it("closes a connected socket when sending throws", async () => {
    const socket = new WriterTestSocket()
    socket.throwOnSend = true
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://send-failure.conduit.market",
      signedEvent: signedEvent(),
      timeoutMs: 10,
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()

    await expect(result).resolves.toBe("timed_out")
    expect(socket.closeCalls).toBe(1)
  })

  it("enforces one total connect-and-ack deadline", async () => {
    const socket = new WriterTestSocket()
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://silent.conduit.market",
      signedEvent: signedEvent(),
      timeoutMs: 5,
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()

    await expect(result).resolves.toBe("timed_out")
    expect(socket.closeCalls).toBe(1)
  })

  it("bounds malformed relay response frames", async () => {
    const socket = new WriterTestSocket()
    socket.onSend = () => {
      for (let index = 0; index < 65; index += 1) socket.message("[]")
    }
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://frame-flood.conduit.market",
      signedEvent: signedEvent(),
      timeoutMs: 50,
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()

    await expect(result).resolves.toBe("timed_out")
    expect(socket.closeCalls).toBe(1)
  })

  it("bounds total relay response bytes", async () => {
    const socket = new WriterTestSocket()
    socket.onSend = () => socket.message("x".repeat(256 * 1024 + 1))
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://byte-flood.conduit.market",
      signedEvent: signedEvent(),
      timeoutMs: 50,
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()

    await expect(result).resolves.toBe("timed_out")
    expect(socket.closeCalls).toBe(1)
  })

  it("authenticates once and retries the exact signed event on the same relay", async () => {
    const relayUrl = "wss://auth.nostr1.com/"
    const event = signedEvent()
    const socket = new WriterTestSocket()
    const result = publishSignedEventFrameToRelay({
      relayUrl,
      signedEvent: event,
      timeoutMs: 100,
      authorization: {
        expectedPubkey: AUTH_PUBKEY,
        signer: authSigner(),
        sessionScope: AUTH_SESSION_SCOPE,
        now: () => 1_700_000_100_000,
      },
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()
    socket.message(
      JSON.stringify(["OK", event.id, false, "auth-required: sign in"])
    )
    socket.message(JSON.stringify(["AUTH", "challenge-1"]))
    await nextTask()

    expect(socket.sentPayloads).toHaveLength(2)
    const firstEventFrame = JSON.parse(socket.sentPayloads[0]!)
    const authFrame = JSON.parse(socket.sentPayloads[1]!)
    expect(firstEventFrame).toEqual([
      "EVENT",
      JSON.parse(JSON.stringify(event)),
    ])
    expect(authFrame[0]).toBe("AUTH")
    expect(authFrame[1]).toMatchObject({
      pubkey: AUTH_PUBKEY,
      kind: 22_242,
      created_at: 1_700_000_100,
      tags: [
        ["relay", relayUrl],
        ["challenge", "challenge-1"],
      ],
      content: "",
    })

    socket.message(JSON.stringify(["OK", authFrame[1].id, true, ""]))
    expect(JSON.parse(socket.sentPayloads[2]!)).toEqual(firstEventFrame)
    socket.message(JSON.stringify(["OK", event.id, true, ""]))

    await expect(result).resolves.toBe("acked")
    expect(socket.closeCalls).toBe(1)
  })

  it("does not sign a superseding challenge on one write connection", async () => {
    const socket = new WriterTestSocket()
    let signerCalls = 0
    const signer = authSigner()
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://auth.nostr1.com/",
      signedEvent: signedEvent(),
      timeoutMs: 100,
      authorization: {
        expectedPubkey: AUTH_PUBKEY,
        signer: {
          ...signer,
          signEvent: async (event) => {
            signerCalls += 1
            return await signer.signEvent(event)
          },
        },
        sessionScope: AUTH_SESSION_SCOPE,
      },
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()
    socket.message(JSON.stringify(["AUTH", "challenge-1"]))
    await nextTask()
    socket.message(JSON.stringify(["AUTH", "challenge-2"]))

    await expect(result).resolves.toBe("timed_out")
    expect(signerCalls).toBe(1)
    expect(socket.closeCalls).toBe(1)
  })

  it("does not invoke the auth signer after account authority changes", async () => {
    const socket = new WriterTestSocket()
    let signerCalls = 0
    const signer = authSigner()
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://auth.nostr1.com/",
      signedEvent: signedEvent(),
      timeoutMs: 100,
      authorization: {
        expectedPubkey: AUTH_PUBKEY,
        signer: {
          ...signer,
          signEvent: async (event) => {
            signerCalls += 1
            return await signer.signEvent(event)
          },
        },
        sessionScope: AUTH_SESSION_SCOPE,
        shouldContinue: () => false,
      },
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()
    socket.message(JSON.stringify(["AUTH", "challenge-1"]))

    await expect(result).resolves.toBe("timed_out")
    expect(signerCalls).toBe(0)
    expect(socket.closeCalls).toBe(1)
  })

  it("rejects an auth event signed by a different account", async () => {
    const socket = new WriterTestSocket()
    const wrongSecret = generateSecretKey()
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://auth.nostr1.com/",
      signedEvent: signedEvent(),
      timeoutMs: 100,
      authorization: {
        expectedPubkey: AUTH_PUBKEY,
        signer: {
          ...authSigner(),
          signEvent: authSigner(wrongSecret).signEvent,
        },
        sessionScope: AUTH_SESSION_SCOPE,
      },
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()
    socket.message(JSON.stringify(["AUTH", "challenge-1"]))

    await expect(result).resolves.toBe("timed_out")
    expect(socket.sentPayloads).toHaveLength(1)
    expect(socket.closeCalls).toBe(1)
  })

  it("cancels a hidden visibility wait before it can dispatch a stale signer request", async () => {
    let visibilityState: DocumentVisibilityState = "hidden"
    const listeners = new Set<() => void>()
    const visibilityDocument = {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: (_type: "visibilitychange", listener: () => void) => {
        listeners.add(listener)
      },
      removeEventListener: (
        _type: "visibilitychange",
        listener: () => void
      ) => {
        listeners.delete(listener)
      },
    }
    const socket = new WriterTestSocket()
    let signerCalls = 0
    const signer = authSigner()
    const result = publishSignedEventFrameToRelay({
      relayUrl: "wss://auth.nostr1.com/",
      signedEvent: signedEvent(),
      timeoutMs: 5,
      authorization: {
        expectedPubkey: AUTH_PUBKEY,
        signer: {
          ...signer,
          signEvent: async (event) => {
            signerCalls += 1
            return await signer.signEvent(event)
          },
        },
        sessionScope: {},
        waitForSignerVisibility: async (signal) =>
          await waitForVisibleDocument(visibilityDocument, signal),
      },
      createWebSocket: () => socket as unknown as WebSocket,
    })

    socket.open()
    socket.message(JSON.stringify(["AUTH", "hidden-challenge"]))
    await expect(result).resolves.toBe("timed_out")
    expect(listeners.size).toBe(0)

    visibilityState = "visible"
    for (const listener of listeners) listener()
    await nextTask()
    expect(signerCalls).toBe(0)
  })

  it("keeps a timed-out signer request serialized across relay writers", async () => {
    let releaseFirstSignature!: () => void
    const firstSignature = new Promise<void>((resolve) => {
      releaseFirstSignature = resolve
    })
    let signerCalls = 0
    const signer = authSigner()
    const slowSigner: NostrEventSigner = {
      ...signer,
      signEvent: async (event) => {
        signerCalls += 1
        if (signerCalls === 1) await firstSignature
        return await signer.signEvent(event)
      },
    }
    const sessionScope = {}
    const firstSocket = new WriterTestSocket()
    const firstResult = publishSignedEventFrameToRelay({
      relayUrl: "wss://first-auth.example/",
      signedEvent: signedEvent(),
      timeoutMs: 10,
      authorization: {
        expectedPubkey: AUTH_PUBKEY,
        signer: slowSigner,
        sessionScope,
      },
      createWebSocket: () => firstSocket as unknown as WebSocket,
    })
    firstSocket.open()
    firstSocket.message(JSON.stringify(["AUTH", "first-challenge"]))
    for (let step = 0; step < 10 && signerCalls === 0; step += 1) {
      await Promise.resolve()
    }
    expect(signerCalls).toBe(1)
    await expect(firstResult).resolves.toBe("timed_out")

    const secondSocket = new WriterTestSocket()
    const secondResult = publishSignedEventFrameToRelay({
      relayUrl: "wss://second-auth.example/",
      signedEvent: signedEvent(),
      timeoutMs: 10,
      authorization: {
        expectedPubkey: AUTH_PUBKEY,
        signer: slowSigner,
        sessionScope,
      },
      createWebSocket: () => secondSocket as unknown as WebSocket,
    })
    secondSocket.open()
    secondSocket.message(JSON.stringify(["AUTH", "second-challenge"]))
    await expect(secondResult).resolves.toBe("timed_out")
    expect(signerCalls).toBe(1)

    releaseFirstSignature()
    await nextTask()
    expect(signerCalls).toBe(1)
  })
})
