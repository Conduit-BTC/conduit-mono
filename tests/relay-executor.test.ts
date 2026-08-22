import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools"
import {
  __resetProtectedReadSigner,
  clearProtectedReadAuthenticationSuppression,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
  removeProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import {
  NostrSignerError,
  type NostrEventSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"
import {
  WebSocketCommerceRelayExecutor,
  type PlainNostrFilter,
  type RelayQueryResult,
  type RelayWebSocket,
} from "../packages/core/src/protocol/relay-executor"
import { readProtectedInbox } from "../packages/core/src/protocol/protected-inbox-read"

const PRIVATE_KEY_A = new Uint8Array(32).fill(1)
const PRIVATE_KEY_B = new Uint8Array(32).fill(2)
const PUBKEY_A = getPublicKey(PRIVATE_KEY_A)
const PUBKEY_B = getPublicKey(PRIVATE_KEY_B)

type RelayFrame = unknown[]

interface FakeRelayBehavior {
  autoOpen?: boolean
  synchronousOpenFrame?: boolean
  onOpen?(socket: FakeRelaySocket): void
  onSend?(socket: FakeRelaySocket, frame: RelayFrame): void
}

class FakeRelaySocket implements RelayWebSocket {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent | Event) => void) | null = null
  readonly sent: RelayFrame[] = []
  closed = false

  constructor(
    readonly url: string,
    private readonly behavior: FakeRelayBehavior
  ) {
    queueMicrotask(() => {
      if (this.closed || this.behavior.autoOpen === false) return
      this.readyState = 1
      this.onopen?.(new Event("open"))
      if (this.behavior.synchronousOpenFrame) this.behavior.onOpen?.(this)
      else queueMicrotask(() => this.behavior.onOpen?.(this))
    })
  }

  send(payload: string): void {
    const frame = JSON.parse(payload) as RelayFrame
    this.sent.push(frame)
    this.behavior.onSend?.(this, frame)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.onclose?.(new Event("close"))
  }

  open(): void {
    if (this.closed || this.readyState === 1) return
    this.readyState = 1
    this.onopen?.(new Event("open"))
    queueMicrotask(() => this.behavior.onOpen?.(this))
  }

  transportError(): void {
    this.onerror?.(new Event("error"))
  }

  relay(frame: RelayFrame): void {
    this.raw(JSON.stringify(frame))
  }

  raw(payload: string): void {
    this.onmessage?.({ data: payload } as MessageEvent<string>)
  }

  transportClose(): void {
    this.close()
  }
}

class FakeRelayHarness {
  readonly sockets: FakeRelaySocket[] = []
  private readonly behaviors = new Map<string, FakeRelayBehavior>()

  at(url: string, behavior: FakeRelayBehavior): this {
    this.behaviors.set(url, behavior)
    return this
  }

  createWebSocket = (url: string): RelayWebSocket => {
    const behavior = this.behaviors.get(url)
    if (!behavior) throw new Error(`No fake relay behavior for ${url}`)
    const socket = new FakeRelaySocket(url, behavior)
    this.sockets.push(socket)
    return socket
  }
}

const executors: WebSocketCommerceRelayExecutor[] = []

function createExecutor(
  harness: FakeRelayHarness,
  now = 1_700_000_123_456
): WebSocketCommerceRelayExecutor {
  let subscription = 0
  const executor = new WebSocketCommerceRelayExecutor({
    createWebSocket: harness.createWebSocket,
    now: () => now,
    createSubscriptionId: () => `test-sub-${++subscription}`,
  })
  executors.push(executor)
  return executor
}

function createSigner(
  privateKey: Uint8Array,
  options: {
    onSign?: (event: UnsignedNostrEvent) => void
    failure?: NostrSignerError
  } = {}
): NostrEventSigner {
  const pubkey = getPublicKey(privateKey)
  return {
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => {
      options.onSign?.(event)
      if (options.failure) throw options.failure
      return finalizeEvent(
        {
          kind: event.kind,
          pubkey: event.pubkey,
          created_at: event.created_at,
          tags: event.tags.map((tag) => [...tag]),
          content: event.content,
        },
        privateKey
      )
    },
  }
}

function authorize(
  signer = createSigner(PRIVATE_KEY_A),
  pubkey = PUBKEY_A,
  policy: "required" | "when_challenged" = "when_challenged",
  hasAuthority: () => boolean = () => true
) {
  const lease = installProtectedReadSigner(signer, pubkey, hasAuthority)
  const authorization = getProtectedReadAuthorization(pubkey, policy)
  if (!authorization) throw new Error("Expected active authorization")
  return { authorization, lease }
}

function protectedRequest(
  pubkey = PUBKEY_A,
  relayUrls = ["wss://protected.example"]
) {
  return {
    relayUrls,
    operation: "private_inbox_read" as const,
    filters: [{ kinds: [1_059], "#p": [pubkey], limit: 100 }],
  }
}

function publicRequest(
  relayUrls = ["wss://public.example"],
  filters?: PlainNostrFilter[]
) {
  return {
    relayUrls,
    operation: "public_read" as const,
    filters: filters ?? [{ kinds: [1], limit: 20 }],
  }
}

function giftWrap(content = "gift wrap"): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: 1_059,
      created_at: 1_700_000_000,
      tags: [["p", PUBKEY_A]],
      content,
    },
    PRIVATE_KEY_B
  )
}

function respondToAuth(
  socket: FakeRelaySocket,
  frame: RelayFrame,
  accepted = true
): void {
  const event = frame[1] as SignedNostrEvent
  socket.relay(["OK", event.id, accepted, accepted ? "" : "auth rejected"])
}

function source(result: RelayQueryResult, relayIndex = 0) {
  const value = result.relays.find((relay) => relay.relayIndex === relayIndex)
  if (!value) throw new Error(`Missing relay result ${relayIndex}`)
  return value
}

beforeEach(() => {
  __resetProtectedReadSigner()
})

afterEach(() => {
  for (const executor of executors.splice(0)) executor.dispose()
  __resetProtectedReadSigner()
})

describe("NDK-neutral relay executor NIP-42 state machine", () => {
  it("authenticates an immediate challenge before issuing the protected REQ", async () => {
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "challenge-immediate"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.status).toBe("success")
    expect(source(result).auth).toBe("succeeded")
    expect(harness.sockets[0]?.sent.map((frame) => frame[0])).toEqual([
      "AUTH",
      "REQ",
      "CLOSE",
    ])
  })

  it("handles AUTH plus auth-required CLOSED after the first REQ and retries with a new subscription", async () => {
    let firstSubscription = ""
    let authenticated = false
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "REQ" && !authenticated) {
          firstSubscription = String(frame[1])
          socket.relay(["AUTH", "challenge-after-req"])
          socket.relay(["CLOSED", frame[1], "auth-required: authenticate"])
        } else if (frame[0] === "AUTH") {
          authenticated = true
          respondToAuth(socket, frame)
        } else if (frame[0] === "REQ") {
          expect(frame[1]).not.toBe(firstSubscription)
          socket.relay(["EOSE", frame[1]])
        }
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.status).toBe("success")
    expect(source(result).auth).toBe("succeeded")
    expect(
      harness.sockets[0]?.sent.filter((frame) => frame[0] === "REQ")
    ).toHaveLength(2)
  })

  it("does not treat EOSE from a challenged pre-auth subscription as completion", async () => {
    let requestCount = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") {
          requestCount += 1
          if (requestCount === 1) {
            socket.relay(["AUTH", "challenge-before-old-eose"])
            socket.relay(["EOSE", frame[1]])
          } else {
            socket.relay(["EOSE", frame[1]])
          }
        }
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.status).toBe("success")
    expect(source(result).auth).toBe("succeeded")
    expect(requestCount).toBe(2)
  })

  it("creates an exact, current, valid kind-22242 event for the normalized relay URL", async () => {
    const signedDrafts: UnsignedNostrEvent[] = []
    const signer = createSigner(PRIVATE_KEY_A, {
      onSign: (event) => signedDrafts.push(event),
    })
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "exact-challenge"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness, 1_700_000_123_456)
    const { authorization } = authorize(signer)

    await executor.query(
      protectedRequest(PUBKEY_A, ["WSS://PROTECTED.EXAMPLE/"]),
      { authorization }
    )

    const authFrame = harness.sockets[0]?.sent.find(
      (frame) => frame[0] === "AUTH"
    )
    const authEvent = authFrame?.[1] as SignedNostrEvent
    expect(signedDrafts).toEqual([
      {
        kind: 22_242,
        pubkey: PUBKEY_A,
        created_at: 1_700_000_123,
        tags: [
          ["relay", "wss://protected.example"],
          ["challenge", "exact-challenge"],
        ],
        content: "",
      },
    ])
    expect(verifyEvent(authEvent)).toBe(true)
    expect(authEvent.id).toHaveLength(64)
  })

  it("treats a matching negative OK as authentication rejection", async () => {
    let enforcementEnabled = true
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => {
        if (enforcementEnabled) socket.relay(["AUTH", "negative-ok"])
      },
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame, false)
        if (frame[0] === "REQ" && !enforcementEnabled) {
          socket.relay(["EOSE", frame[1]])
        }
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.status).toBe("unavailable")
    expect(result.authoritativeEmpty).toBe(false)
    expect(source(result)).toMatchObject({
      status: "failed",
      auth: "authentication_rejected",
      failure: "authentication_rejected",
    })
    expect(signCalls).toBe(1)

    const suppressedPoll = await executor.query(protectedRequest(), {
      authorization,
    })
    expect(source(suppressedPoll).failure).toBe("authentication_rejected")
    expect(signCalls).toBe(1)

    enforcementEnabled = false
    const rollbackRead = await executor.query(protectedRequest(), {
      authorization,
    })
    expect(rollbackRead.status).toBe("success")
    expect(rollbackRead.authoritativeEmpty).toBe(true)
    expect(source(rollbackRead).auth).toBe("not_challenged")
    expect(signCalls).toBe(1)
  })

  it("suppresses repeated prompts when transport fails after AUTH is sent", async () => {
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "transport-after-auth"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") socket.transportError()
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    const first = await executor.query(protectedRequest(), { authorization })
    expect(source(first).failure).toBe("transport_unavailable")
    expect(signCalls).toBe(1)

    const second = await executor.query(protectedRequest(), { authorization })
    expect(source(second).failure).toBe("transport_unavailable")
    expect(signCalls).toBe(1)
  })

  it("suppresses repeated prompts when transport closes during signing", async () => {
    let signCalls = 0
    let markSignStarted!: () => void
    let releaseSign!: () => void
    const signStarted = new Promise<void>((resolve) => {
      markSignStarted = resolve
    })
    const signPending = new Promise<void>((resolve) => {
      releaseSign = resolve
    })
    const signer: NostrEventSigner = {
      authMethod: "nip07",
      getPublicKey: async () => PUBKEY_A,
      signEvent: async (event) => {
        signCalls += 1
        markSignStarted()
        await signPending
        return finalizeEvent(event, PRIVATE_KEY_A)
      },
    }
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "close-during-sign"]),
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(signer)

    const pending = executor.query(protectedRequest(), { authorization })
    await signStarted
    harness.sockets[0]?.transportClose()

    const first = await pending
    expect(source(first).failure).toBe("transport_unavailable")
    expect(signCalls).toBe(1)

    releaseSign()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const second = await executor.query(protectedRequest(), { authorization })
    expect(source(second).failure).toBe("transport_unavailable")
    expect(signCalls).toBe(1)
  })

  it("suppresses repeated prompts when accepted AUTH closes synchronously", async () => {
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "accepted-then-close"]),
      onSend: (socket, frame) => {
        if (frame[0] !== "AUTH") return
        respondToAuth(socket, frame)
        socket.transportClose()
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    const first = await executor.query(protectedRequest(), { authorization })
    expect(source(first).failure).toBe("transport_unavailable")
    expect(signCalls).toBe(1)

    const second = await executor.query(protectedRequest(), { authorization })
    expect(source(second).failure).toBe("transport_unavailable")
    expect(signCalls).toBe(1)
  })

  it("suppresses repeated prompts after invalid signer output", async () => {
    let signCalls = 0
    const signer: NostrEventSigner = {
      authMethod: "nip07",
      getPublicKey: async () => PUBKEY_A,
      signEvent: async (event) => {
        signCalls += 1
        return finalizeEvent({ ...event, content: "unexpected" }, PRIVATE_KEY_A)
      },
    }
    const harness = new FakeRelayHarness()
      .at("wss://protected.example", {
        onOpen: (socket) => socket.relay(["AUTH", "invalid-signer-output"]),
      })
      .at("wss://other.example", {
        onOpen: (socket) => socket.relay(["AUTH", "other-challenge"]),
      })
    const executor = createExecutor(harness)
    const { authorization } = authorize(signer)

    const first = await executor.query(protectedRequest(), { authorization })
    expect(source(first).failure).toBe("signer_unavailable")
    expect(signCalls).toBe(1)

    const second = await executor.query(
      protectedRequest(PUBKEY_A, ["wss://other.example"]),
      { authorization }
    )
    expect(source(second).failure).toBe("signer_unavailable")
    expect(signCalls).toBe(1)
  })

  it("does not accept auth-required CLOSED without a challenge", async () => {
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") {
          socket.relay(["CLOSED", frame[1], "auth-required: challenge missing"])
        }
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.status).toBe("unavailable")
    expect(source(result)).toMatchObject({
      auth: "authentication_required",
      failure: "missing_challenge",
    })
    expect(
      executor.getAuthenticationEvidence(
        "wss://protected.example",
        authorization.sessionScope
      )
    ).toBe("unavailable")

    const summaryHarness = new FakeRelayHarness().at(
      "wss://protected.example",
      {
        onSend: (socket, frame) => {
          if (frame[0] === "REQ") {
            socket.relay([
              "CLOSED",
              frame[1],
              "auth-required: challenge missing",
            ])
          }
        },
      }
    )
    const inbox = await readProtectedInbox({
      principalPubkey: PUBKEY_A,
      relayUrls: ["wss://protected.example"],
      limit: 10,
      authorization,
      executor: createExecutor(summaryHarness),
    })
    expect(inbox.auth).toMatchObject({
      state: "unavailable",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 1,
      failure: "authentication_required",
    })
  })

  it("distinguishes authentication timeout from query timeout", async () => {
    const protectedHarness = new FakeRelayHarness().at(
      "wss://protected.example",
      {
        onOpen: (socket) => socket.relay(["AUTH", "ignored-auth"]),
      }
    )
    const protectedExecutor = createExecutor(protectedHarness)
    const { authorization } = authorize()
    const authResult = await protectedExecutor.query(protectedRequest(), {
      authorization,
      authTimeoutMs: 10,
      queryTimeoutMs: 100,
    })

    expect(source(authResult).failure).toBe("authentication_timed_out")
    expect(authResult.observations).toContainEqual({
      type: "timeout",
      relayIndex: 0,
      phase: "auth",
    })

    const publicHarness = new FakeRelayHarness().at("wss://public.example", {})
    const publicExecutor = createExecutor(publicHarness)
    const queryResult = await publicExecutor.query(publicRequest(), {
      queryTimeoutMs: 10,
    })
    expect(source(queryResult).failure).toBe("query_timed_out")
    expect(queryResult.observations).toContainEqual({
      type: "timeout",
      relayIndex: 0,
      phase: "query",
    })
  })

  it("discards an authenticated socket after protected query timeout", async () => {
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "query-timeout"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    const first = await executor.query(protectedRequest(), {
      authorization,
      queryTimeoutMs: 10,
    })
    expect(source(first)).toMatchObject({
      auth: "succeeded",
      failure: "query_timed_out",
    })
    expect(harness.sockets[0]?.closed).toBe(true)

    const second = await executor.query(protectedRequest(), {
      authorization,
      queryTimeoutMs: 10,
    })
    expect(source(second).failure).toBe("query_timed_out")
    expect(harness.sockets).toHaveLength(2)
    expect(harness.sockets[1]?.closed).toBe(true)
    expect(signCalls).toBe(1)

    expect(clearProtectedReadAuthenticationSuppression(PUBKEY_A)).toBe(true)
    const explicitRetry = await executor.query(protectedRequest(), {
      authorization,
      queryTimeoutMs: 10,
    })
    expect(source(explicitRetry).failure).toBe("query_timed_out")
    expect(signCalls).toBe(2)
  })

  it("distinguishes connection timeout from authentication timeout", async () => {
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      autoOpen: false,
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(protectedRequest(), {
      authorization,
      connectTimeoutMs: 10,
      authTimeoutMs: 100,
    })

    expect(source(result)).toMatchObject({
      auth: "not_challenged",
      failure: "transport_unavailable",
    })
    expect(result.observations).toContainEqual({
      type: "timeout",
      relayIndex: 0,
      phase: "connect",
    })
    expect(
      result.observations.some(
        (observation) =>
          observation.type === "timeout" && observation.phase === "auth"
      )
    ).toBe(false)
  })

  it("suppresses repeated signer prompts after denial until explicit retry", async () => {
    let signCalls = 0
    const legacyWrap = giftWrap("legacy relay fallback")
    const harness = new FakeRelayHarness()
      .at("wss://protected.example", {
        onOpen: (socket) => socket.relay(["AUTH", "denied"]),
      })
      .at("wss://legacy.example", {
        onSend: (socket, frame) => {
          if (frame[0] !== "REQ") return
          socket.relay(["EVENT", frame[1], legacyWrap])
          socket.relay(["EOSE", frame[1]])
        },
      })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, {
        onSign: () => signCalls++,
        failure: new NostrSignerError("authorization_denied"),
      })
    )

    const first = await executor.query(protectedRequest(), { authorization })

    expect(source(first)).toMatchObject({
      auth: "signer_authorization_denied",
      failure: "signer_authorization_denied",
    })
    expect(signCalls).toBe(1)
    expect(
      harness.sockets[0]?.sent.filter((frame) => frame[0] === "REQ")
    ).toHaveLength(0)

    const second = await executor.query(protectedRequest(), { authorization })
    expect(source(second).failure).toBe("signer_authorization_denied")
    expect(signCalls).toBe(1)
    expect(harness.sockets).toHaveLength(2)

    const legacyFallback = await executor.query(
      protectedRequest(PUBKEY_A, ["wss://legacy.example"]),
      { authorization }
    )
    expect(legacyFallback.status).toBe("success")
    expect(legacyFallback.events.map((event) => event.id)).toEqual([
      legacyWrap.id,
    ])
    expect(source(legacyFallback).auth).toBe("not_challenged")
    expect(signCalls).toBe(1)

    expect(clearProtectedReadAuthenticationSuppression(PUBKEY_A)).toBe(true)
    const explicitRetry = await executor.query(protectedRequest(), {
      authorization,
    })
    expect(source(explicitRetry).failure).toBe("signer_authorization_denied")
    expect(signCalls).toBe(2)
    expect(
      harness.sockets.filter((socket) =>
        socket.url.includes("protected.example")
      )
    ).toHaveLength(3)
  })

  it("serializes concurrent relay prompts and stops after the first denial", async () => {
    let signCalls = 0
    const firstRelayUrl = "wss://one.example"
    const secondRelayUrl = "wss://two.example"
    const relayUrls = [firstRelayUrl, secondRelayUrl]
    const harness = new FakeRelayHarness()
      .at(firstRelayUrl, {
        onOpen: (socket) => socket.relay(["AUTH", "one-denied"]),
      })
      .at(secondRelayUrl, {
        onOpen: (socket) => socket.relay(["AUTH", "two-denied"]),
      })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, {
        onSign: () => signCalls++,
        failure: new NostrSignerError("authorization_denied"),
      })
    )

    const result = await executor.query(protectedRequest(PUBKEY_A, relayUrls), {
      authorization,
    })

    expect(result.relays).toHaveLength(2)
    expect(result.relays.every((relay) => relay.status === "failed")).toBe(true)
    expect(
      result.relays.every(
        (relay) => relay.failure === "signer_authorization_denied"
      )
    ).toBe(true)
    expect(signCalls).toBe(1)
  })

  it("suppresses repeated signer prompts after auth OK timeout", async () => {
    let signCalls = 0
    const harness = new FakeRelayHarness()
      .at("wss://protected.example", {
        onOpen: (socket) => socket.relay(["AUTH", "auth-ok-timeout"]),
      })
      .at("wss://healthy.example", {
        onOpen: (socket) => socket.relay(["AUTH", "healthy-auth"]),
        onSend: (socket, frame) => {
          if (frame[0] === "AUTH") respondToAuth(socket, frame)
          if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
        },
      })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, {
        onSign: () => signCalls++,
      })
    )

    const first = await executor.query(protectedRequest(), {
      authorization,
      authTimeoutMs: 10,
    })
    expect(source(first).failure).toBe("authentication_timed_out")
    expect(signCalls).toBe(1)
    expect(
      harness.sockets[0]?.sent.filter((frame) => frame[0] === "AUTH")
    ).toHaveLength(1)

    const healthy = await executor.query(
      protectedRequest(PUBKEY_A, ["wss://healthy.example"]),
      { authorization }
    )
    expect(healthy.status).toBe("success")
    expect(source(healthy).auth).toBe("succeeded")
    expect(signCalls).toBe(2)

    const second = await executor.query(protectedRequest(), { authorization })
    expect(source(second).failure).toBe("authentication_timed_out")
    expect(signCalls).toBe(2)
    expect(harness.sockets).toHaveLength(3)
  })

  it("keeps explicit retry cleared after a timed-out signer resolves late", async () => {
    let signCalls = 0
    let releaseFirstSign!: () => void
    const firstSignPending = new Promise<void>((resolve) => {
      releaseFirstSign = resolve
    })
    const delayedSigner: NostrEventSigner = {
      authMethod: "nip07",
      getPublicKey: async () => PUBKEY_A,
      signEvent: async (event) => {
        signCalls += 1
        if (signCalls === 1) await firstSignPending
        return finalizeEvent(event, PRIVATE_KEY_A)
      },
    }
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "delayed-signer"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(delayedSigner)

    const first = await executor.query(protectedRequest(), {
      authorization,
      authTimeoutMs: 10,
    })
    expect(source(first).failure).toBe("authentication_timed_out")
    expect(signCalls).toBe(1)

    expect(clearProtectedReadAuthenticationSuppression(PUBKEY_A)).toBe(true)
    const retry = executor.query(protectedRequest(), {
      authorization,
      authTimeoutMs: 1_000,
    })

    const result = await retry
    expect(result.status).toBe("success")
    expect(source(result)).toMatchObject({
      status: "success",
      auth: "succeeded",
    })
    expect(signCalls).toBe(2)
    expect(
      harness.sockets[0]?.sent.filter((frame) => frame[0] === "AUTH")
    ).toHaveLength(0)
    expect(
      harness.sockets[1]?.sent.filter((frame) => frame[0] === "AUTH")
    ).toHaveLength(1)

    releaseFirstSign()
    await Promise.resolve()
    await Promise.resolve()
    expect(
      harness.sockets[0]?.sent.filter((frame) => frame[0] === "AUTH")
    ).toHaveLength(0)
  })

  it("never requests a signature for public reads", async () => {
    let signCalls = 0
    installProtectedReadSigner(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ }),
      PUBKEY_A,
      () => true
    )
    const harness = new FakeRelayHarness().at("wss://public.example", {
      onOpen: (socket) => socket.relay(["AUTH", "public-optional"]),
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)

    const result = await executor.query(publicRequest())

    expect(result.status).toBe("success")
    expect(signCalls).toBe(0)
    expect(harness.sockets[0]?.sent.some((frame) => frame[0] === "AUTH")).toBe(
      false
    )
  })

  it("settles public auth-required CLOSED without signing or recording auth evidence", async () => {
    let signCalls = 0
    const lease = installProtectedReadSigner(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ }),
      PUBKEY_A,
      () => true
    )
    const authorization = getProtectedReadAuthorization(PUBKEY_A)
    expect(authorization).not.toBeNull()
    const harness = new FakeRelayHarness().at("wss://public.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") {
          socket.relay(["CLOSED", frame[1], "auth-required: protected only"])
        }
      },
    })
    const executor = createExecutor(harness)

    const result = await executor.query(publicRequest())

    expect(source(result)).toMatchObject({
      auth: "authentication_required",
      failure: "missing_challenge",
    })
    expect(signCalls).toBe(0)
    expect(
      executor.getAuthenticationEvidence(
        "wss://public.example",
        authorization!.sessionScope
      )
    ).toBeUndefined()
    removeProtectedReadSigner(lease)
  })

  it("rejects kind-1059 inbox filters mislabeled as public reads", async () => {
    const harness = new FakeRelayHarness()
    const executor = createExecutor(harness)

    await expect(
      executor.query(
        publicRequest(
          ["wss://public.example"],
          [{ kinds: [1_059], "#p": [PUBKEY_A] }]
        )
      )
    ).rejects.toThrow("explicit kind allowlist")
    await expect(
      executor.query(
        publicRequest(["wss://public.example"], [{ "#p": [PUBKEY_A] }])
      )
    ).rejects.toThrow("explicit kind allowlist")
    await expect(
      executor.query(
        publicRequest(
          ["wss://public.example"],
          [{ kinds: [1, 1_059], "#p": [PUBKEY_A] }]
        )
      )
    ).rejects.toThrow("explicit kind allowlist")
    expect(harness.sockets).toHaveLength(0)
  })

  it("defensively drops protected events sent to a public subscription", async () => {
    const wrap = giftWrap("public-boundary-bypass")
    const harness = new FakeRelayHarness().at("wss://public.example", {
      onSend: (socket, frame) => {
        if (frame[0] !== "REQ") return
        socket.relay(["EVENT", frame[1], wrap])
        socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)

    const result = await executor.query(publicRequest())

    expect(result.events).toEqual([])
    expect(source(result).unusableCount).toBe(1)
    expect(result.authoritativeEmpty).toBe(false)
  })

  it("rejects cross-recipient protected filters before connecting", async () => {
    const harness = new FakeRelayHarness()
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    await expect(
      executor.query(protectedRequest(PUBKEY_B), { authorization })
    ).rejects.toThrow("recipient-scoped kind 1059")
    expect(harness.sockets).toHaveLength(0)
  })

  it("rejects every protected filter field outside the narrow inbox allowlist", async () => {
    const harness = new FakeRelayHarness().at("wss://protected.example", {})
    const executor = createExecutor(harness)
    const { authorization } = authorize()
    const invalidFilters: PlainNostrFilter[] = [
      { kinds: [1_059], "#p": [PUBKEY_A], authors: [PUBKEY_A], limit: 10 },
      { kinds: [1_059], "#p": [PUBKEY_A], search: "private text", limit: 10 },
      { kinds: [1_059], "#p": [PUBKEY_A], limit: 0 },
      { kinds: [1_059], "#p": [PUBKEY_A], limit: 1_001 },
      {
        kinds: [1_059],
        "#p": [PUBKEY_A],
        limit: 10,
        unknown: "not-allowed",
      } as PlainNostrFilter,
      { kinds: [1_059], "#p": [PUBKEY_A], since: 20, until: 10, limit: 10 },
    ]

    for (const filter of invalidFilters) {
      await expect(
        executor.query(
          {
            relayUrls: ["wss://protected.example"],
            filters: [filter],
            operation: "private_inbox_read",
          },
          { authorization }
        )
      ).rejects.toThrow("recipient-scoped kind 1059")
    }
    expect(harness.sockets).toHaveLength(0)
  })

  it("rejects a private read without active signer authorization before connecting", async () => {
    const harness = new FakeRelayHarness()
    const executor = createExecutor(harness)

    await expect(executor.query(protectedRequest())).rejects.toThrow(
      "requires active authorization"
    )
    expect(harness.sockets).toHaveLength(0)
  })

  it("deduplicates concurrent authentication on one account-scoped connection", async () => {
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "shared-challenge"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    const results = await Promise.all([
      executor.query(protectedRequest(), { authorization }),
      executor.query(protectedRequest(), { authorization }),
    ])

    expect(results.map((result) => result.status)).toEqual([
      "success",
      "success",
    ])
    expect(signCalls).toBe(1)
    expect(
      harness.sockets
        .flatMap((socket) => socket.sent)
        .filter((frame) => frame[0] === "AUTH")
    ).toHaveLength(1)
  })

  it("keeps an aborted signer serialized until timeout, then recovers on retry", async () => {
    let releaseFirstSignature!: () => void
    const firstSignature = new Promise<void>((resolve) => {
      releaseFirstSignature = resolve
    })
    let signCalls = 0
    const slowFirstSigner: NostrEventSigner = {
      authMethod: "nip07",
      getPublicKey: async () => PUBKEY_A,
      signEvent: async (event) => {
        signCalls += 1
        if (signCalls === 1) await firstSignature
        return finalizeEvent(event, PRIVATE_KEY_A)
      },
    }
    const challengeAndComplete: FakeRelayBehavior = {
      onOpen: (socket) => socket.relay(["AUTH", "abort-serialized"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    }
    const harness = new FakeRelayHarness()
      .at("wss://a.example", challengeAndComplete)
      .at("wss://b.example", challengeAndComplete)
      .at("wss://c.example", challengeAndComplete)
    const executor = createExecutor(harness)
    const { authorization } = authorize(slowFirstSigner)
    const abortController = new AbortController()

    const firstQuery = executor.query(
      protectedRequest(PUBKEY_A, ["wss://a.example"]),
      {
        authorization,
        signal: abortController.signal,
        authTimeoutMs: 20,
      }
    )
    for (let step = 0; step < 10 && signCalls === 0; step += 1) {
      await Promise.resolve()
    }
    expect(signCalls).toBe(1)

    const secondQuery = executor.query(
      protectedRequest(PUBKEY_A, ["wss://b.example"]),
      { authorization, authTimeoutMs: 1_000 }
    )
    abortController.abort()
    expect((await firstQuery).status).toBe("aborted")
    await Promise.resolve()
    await Promise.resolve()
    expect(signCalls).toBe(1)

    const backgroundResult = await secondQuery
    expect(source(backgroundResult).failure).toBe("authentication_timed_out")
    expect(signCalls).toBe(1)

    expect(clearProtectedReadAuthenticationSuppression(PUBKEY_A)).toBe(true)
    const explicitRetry = await executor.query(
      protectedRequest(PUBKEY_A, ["wss://c.example"]),
      { authorization, authTimeoutMs: 1_000 }
    )
    expect(explicitRetry.status).toBe("success")
    expect(signCalls).toBe(2)
    expect(
      harness.sockets[0]?.sent.filter((frame) => frame[0] === "AUTH")
    ).toHaveLength(0)
    expect(
      harness.sockets[2]?.sent.filter((frame) => frame[0] === "AUTH")
    ).toHaveLength(1)

    releaseFirstSignature()
    await Promise.resolve()
    await Promise.resolve()
    expect(
      harness.sockets[0]?.sent.filter((frame) => frame[0] === "AUTH")
    ).toHaveLength(0)
  })

  it("serializes relay challenges and drops timed-out queued signer prompts", async () => {
    let releaseFirstSignature!: () => void
    const firstSignature = new Promise<void>((resolve) => {
      releaseFirstSignature = resolve
    })
    let signCalls = 0
    const slowSigner: NostrEventSigner = {
      authMethod: "nip07",
      getPublicKey: async () => PUBKEY_A,
      signEvent: async (event) => {
        signCalls += 1
        await firstSignature
        return finalizeEvent(event, PRIVATE_KEY_A)
      },
    }
    const challengeOnOpen: FakeRelayBehavior = {
      onOpen: (socket) => socket.relay(["AUTH", "queued-challenge"]),
    }
    const harness = new FakeRelayHarness()
      .at("wss://a.example", challengeOnOpen)
      .at("wss://b.example", challengeOnOpen)
    const executor = createExecutor(harness)
    const { authorization } = authorize(slowSigner)

    const result = await executor.query(
      protectedRequest(PUBKEY_A, ["wss://a.example", "wss://b.example"]),
      { authorization, authTimeoutMs: 10 }
    )
    releaseFirstSignature()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result.status).toBe("unavailable")
    expect(signCalls).toBe(1)
    expect(
      harness.sockets
        .flatMap((socket) => socket.sent)
        .some((frame) => frame[0] === "AUTH")
    ).toBe(false)
  })

  it("reauthenticates with a new challenge after reconnect", async () => {
    let connectionCount = 0
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => {
        connectionCount += 1
        socket.relay(["AUTH", `challenge-${connectionCount}`])
      },
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    await executor.query(protectedRequest(), { authorization })
    executor.closeAuthenticatedRelay("wss://protected.example")
    await executor.query(protectedRequest(), { authorization })

    expect(harness.sockets).toHaveLength(2)
    expect(harness.sockets[0]?.closed).toBe(true)
    expect(signCalls).toBe(2)
  })

  it("closes authenticated connections when their signer lease is revoked", async () => {
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "revoked"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization, lease } = authorize()
    await executor.query(protectedRequest(), { authorization })

    removeProtectedReadSigner(lease)

    expect(harness.sockets[0]?.closed).toBe(true)
    expect(
      executor.getAuthenticationEvidence(
        "wss://protected.example",
        authorization.sessionScope
      )
    ).toBeUndefined()
  })

  it("revokes every session socket as soon as the synchronous authority fence changes", async () => {
    let authorityCurrent = true
    const harness = new FakeRelayHarness()
    for (const [url, challenge] of [
      ["wss://one.example", "one"],
      ["wss://two.example", "two"],
    ] as const) {
      harness.at(url, {
        onOpen: (socket) => socket.relay(["AUTH", challenge]),
        onSend: (socket, frame) => {
          if (frame[0] === "AUTH") respondToAuth(socket, frame)
          if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
        },
      })
    }
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A),
      PUBKEY_A,
      "when_challenged",
      () => authorityCurrent
    )
    const first = await executor.query(
      {
        ...protectedRequest(),
        relayUrls: ["wss://one.example", "wss://two.example"],
      },
      { authorization }
    )
    expect(first.status).toBe("success")
    expect(harness.sockets.every((socket) => !socket.closed)).toBe(true)

    authorityCurrent = false
    const touched = executor.query(
      { ...protectedRequest(), relayUrls: ["wss://one.example"] },
      { authorization }
    )

    await expect(touched).rejects.toThrow("authority is unavailable")
    expect(harness.sockets.every((socket) => socket.closed)).toBe(true)
    expect(
      executor.getAuthenticationEvidence(
        "wss://one.example",
        authorization.sessionScope
      )
    ).toBeUndefined()
    expect(
      executor.getAuthenticationEvidence(
        "wss://two.example",
        authorization.sessionScope
      )
    ).toBeUndefined()
    expect(getProtectedReadAuthorization(PUBKEY_A)).toBeNull()
  })

  it("isolates sockets and challenges across account switches", async () => {
    let connections = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", `account-${++connections}`]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const first = authorize(createSigner(PRIVATE_KEY_A), PUBKEY_A)
    await executor.query(protectedRequest(PUBKEY_A), {
      authorization: first.authorization,
    })

    const second = authorize(createSigner(PRIVATE_KEY_B), PUBKEY_B)
    await executor.query(protectedRequest(PUBKEY_B), {
      authorization: second.authorization,
    })

    expect(harness.sockets).toHaveLength(2)
    expect(harness.sockets[0]?.closed).toBe(true)
    expect(harness.sockets[1]?.closed).toBe(false)
  })

  it("preserves useful events and reports partial coverage when another relay cannot authenticate", async () => {
    const validEvent = finalizeEvent(
      {
        kind: 1_059,
        created_at: 1_700_000_000,
        tags: [["p", PUBKEY_A]],
        content: "gift wrap",
      },
      PRIVATE_KEY_B
    )
    const harness = new FakeRelayHarness()
      .at("wss://a.example", {
        onOpen: (socket) => socket.relay(["AUTH", "a"]),
        onSend: (socket, frame) => {
          if (frame[0] === "AUTH") respondToAuth(socket, frame)
          if (frame[0] === "REQ") {
            socket.relay(["EVENT", frame[1], validEvent])
            socket.relay(["EOSE", frame[1]])
          }
        },
      })
      .at("wss://b.example", {
        onSend: (socket, frame) => {
          if (frame[0] === "REQ") {
            socket.relay(["CLOSED", frame[1], "auth-required: no challenge"])
          }
        },
      })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(
      protectedRequest(PUBKEY_A, ["wss://a.example", "wss://b.example"]),
      { authorization }
    )

    expect(result.status).toBe("partial")
    expect(result.events.map((event) => event.id)).toEqual([validEvent.id])
    expect(result.authoritativeEmpty).toBe(false)
    expect(result.completedCount).toBe(1)
    expect(result.failedCount).toBe(1)
  })

  it("never reports an authoritative empty result when all protected relays are unavailable", async () => {
    const missingChallenge: FakeRelayBehavior = {
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") {
          socket.relay(["CLOSED", frame[1], "auth-required: unavailable"])
        }
      },
    }
    const harness = new FakeRelayHarness()
      .at("wss://a.example", missingChallenge)
      .at("wss://b.example", missingChallenge)
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(
      protectedRequest(PUBKEY_A, ["wss://a.example", "wss://b.example"]),
      { authorization }
    )

    expect(result.status).toBe("unavailable")
    expect(result.events).toEqual([])
    expect(result.authoritativeEmpty).toBe(false)
    expect(result.failedCount).toBe(2)
  })

  it("bounds successive fresh challenge loops", async () => {
    let challenge = 0
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") {
          const nextChallenge = `loop-${++challenge}`
          setTimeout(() => socket.relay(["AUTH", nextChallenge]), 0)
        }
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    const result = await executor.query(protectedRequest(), {
      authorization,
      maxAuthAttempts: 2,
      queryTimeoutMs: 100,
    })

    expect(source(result)).toMatchObject({
      auth: "challenge_replayed",
      failure: "challenge_loop",
    })
    expect(
      harness.sockets[0]?.sent.filter((frame) => frame[0] === "AUTH")
    ).toHaveLength(2)
    expect(signCalls).toBe(2)

    const suppressedPoll = await executor.query(protectedRequest(), {
      authorization,
      maxAuthAttempts: 2,
      queryTimeoutMs: 100,
    })
    expect(source(suppressedPoll).failure).toBe("challenge_loop")
    expect(signCalls).toBe(2)
  })

  it("rejects a previously used challenge replayed on the same connection", async () => {
    const challenges = ["first", "second", "first"]
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") {
          const challenge = challenges.shift()
          if (challenge) {
            setTimeout(() => socket.relay(["AUTH", challenge]), 0)
          }
        }
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(protectedRequest(), {
      authorization,
      maxAuthAttempts: 3,
      queryTimeoutMs: 100,
    })

    expect(source(result).failure).toBe("challenge_replayed")
  })

  it("discards pre-auth events and the retired subscription when authentication is rejected", async () => {
    const event = giftWrap("pre-auth")
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") {
          socket.relay(["EVENT", frame[1], event])
          socket.relay(["AUTH", "challenge-after-event"])
          socket.relay(["CLOSED", frame[1], "auth-required:"])
        }
        if (frame[0] === "AUTH") respondToAuth(socket, frame, false)
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.status).toBe("unavailable")
    expect(result.events).toEqual([])
    expect(source(result).eventCount).toBe(0)
    expect(result.authoritativeEmpty).toBe(false)
  })

  it("keeps protected relay observations content-free", async () => {
    const event = giftWrap("private-diagnostic-payload")
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "private-observation"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") {
          socket.relay(["EVENT", frame[1], event])
          socket.relay(["EOSE", frame[1]])
        }
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const inbox = await readProtectedInbox({
      principalPubkey: PUBKEY_A,
      relayUrls: ["wss://protected.example"],
      limit: 10,
      authorization,
      executor,
    })

    expect(inbox.events).toHaveLength(1)
    expect(inbox.events[0]).toMatchObject({
      id: event.id,
      content: event.content,
      pubkey: event.pubkey,
      tags: event.tags,
    })
    expect("events" in inbox.relayResult).toBe(false)
    const serialized = JSON.stringify(inbox.relayResult)
    expect(serialized).not.toContain(event.content)
    expect(serialized).not.toContain(event.pubkey)
    expect(serialized).not.toContain(event.id)
    expect(serialized).not.toContain("private-observation")
    expect(serialized).not.toContain("wss://protected.example")
    expect(serialized).not.toContain(PUBKEY_A)
    expect(serialized).not.toContain('"#p"')
    expect(
      inbox.relayResult.observations.find(
        (observation) => observation.type === "event"
      )
    ).toEqual({ type: "event", relayIndex: 0 })
  })

  it("does not commit anonymous events when the protected policy requires authentication", async () => {
    const event = giftWrap("required-policy")
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") {
          socket.relay(["EVENT", frame[1], event])
          socket.relay(["EOSE", frame[1]])
        }
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A),
      PUBKEY_A,
      "required"
    )

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.events).toEqual([])
    expect(source(result).failure).toBe("authentication_required")
    expect(result.authoritativeEmpty).toBe(false)
  })

  it("checks the synchronous session authority fence before accepting terminal frames", async () => {
    let authorityCurrent = true
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "revision-fence"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") {
          authorityCurrent = false
          socket.relay(["EOSE", frame[1]])
        }
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A),
      PUBKEY_A,
      "when_challenged",
      () => authorityCurrent
    )

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.status).toBe("unavailable")
    expect(result.events).toEqual([])
    expect(source(result)).toMatchObject({
      auth: "authority_changed",
      failure: "authority_changed",
    })
  })

  it("clears aggregate protected events if authority changes after one relay completes", async () => {
    let authorityCurrent = true
    let pendingSocket: FakeRelaySocket | undefined
    const event = giftWrap("aggregate-fence")
    const harness = new FakeRelayHarness()
      .at("wss://a.example", {
        onOpen: (socket) => socket.relay(["AUTH", "aggregate-a"]),
        onSend: (socket, frame) => {
          if (frame[0] === "AUTH") respondToAuth(socket, frame)
          if (frame[0] === "REQ") {
            socket.relay(["EVENT", frame[1], event])
            socket.relay(["EOSE", frame[1]])
            setTimeout(() => {
              authorityCurrent = false
              pendingSocket?.transportClose()
            }, 0)
          }
        },
      })
      .at("wss://b.example", {
        onOpen: (socket) => {
          pendingSocket = socket
        },
      })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A),
      PUBKEY_A,
      "when_challenged",
      () => authorityCurrent
    )

    const result = await executor.query(
      protectedRequest(PUBKEY_A, ["wss://a.example", "wss://b.example"]),
      { authorization }
    )

    expect(result.status).toBe("unavailable")
    expect(result.events).toEqual([])
    expect(result.authoritativeEmpty).toBe(false)
    expect(
      result.observations.some((observation) => observation.type === "event")
    ).toBe(false)
  })

  it("snapshots recipient filters before asynchronous connection work", async () => {
    const wireRecipients: string[] = []
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      autoOpen: false,
      onSend: (socket, frame) => {
        if (frame[0] !== "REQ") return
        const filter = frame[2] as { "#p"?: string[] }
        wireRecipients.push(filter["#p"]?.[0] ?? "")
        socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()
    const request = protectedRequest()

    const pending = executor.query(request, { authorization })
    request.filters[0]!["#p"]![0] = PUBKEY_B
    harness.sockets[0]?.open()
    const result = await pending

    expect(result.status).toBe("success")
    expect(wireRecipients).toEqual([PUBKEY_A])
  })

  it("ignores unrelated OK frames until the matching authentication acknowledgement", async () => {
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "matching-ok"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") {
          socket.relay(["OK", "f".repeat(64), false, "unrelated"])
          respondToAuth(socket, frame)
        }
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.status).toBe("success")
    expect(source(result).auth).toBe("succeeded")
    expect(
      result.observations.filter((observation) => observation.type === "ok")
    ).toHaveLength(2)
  })

  it("retries a fresh challenge that supersedes an in-flight signature", async () => {
    let socket: FakeRelaySocket | undefined
    let signCalls = 0
    const signer: NostrEventSigner = {
      authMethod: "nip07",
      getPublicKey: async () => PUBKEY_A,
      signEvent: async (event) => {
        signCalls += 1
        if (signCalls === 1) socket?.relay(["AUTH", "fresh-challenge"])
        return finalizeEvent(event, PRIVATE_KEY_A)
      },
    }
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (value) => {
        socket = value
        value.relay(["AUTH", "old-challenge"])
      },
      onSend: (value, frame) => {
        if (frame[0] === "AUTH") respondToAuth(value, frame)
        if (frame[0] === "REQ") value.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(signer)

    const result = await executor.query(protectedRequest(), {
      authorization,
      maxAuthAttempts: 2,
    })

    expect(result.status).toBe("success")
    expect(signCalls).toBe(2)
    expect(source(result).auth).toBe("succeeded")
  })

  it("reconnects and clears connection-bound evidence after an idle socket close", async () => {
    let challenge = 0
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", `idle-${++challenge}`]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    await executor.query(protectedRequest(), { authorization })
    expect(
      executor.getAuthenticationEvidence(
        "wss://protected.example",
        authorization.sessionScope
      )
    ).toBe("succeeded")
    harness.sockets[0]?.transportClose()
    expect(
      executor.getAuthenticationEvidence(
        "wss://protected.example",
        authorization.sessionScope
      )
    ).toBeUndefined()
    const second = await executor.query(protectedRequest(), { authorization })

    expect(second.status).toBe("success")
    expect(harness.sockets).toHaveLength(2)
    expect(signCalls).toBe(2)
  })

  it("settles a socket send failure as one typed relay failure", async () => {
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (_socket, frame) => {
        if (frame[0] === "REQ") throw new Error("send failed")
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.status).toBe("unavailable")
    expect(source(result).failure).toBe("transport_unavailable")
  })

  it("does not classify an immediate socket error as a connection timeout", async () => {
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      autoOpen: false,
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()
    const pending = executor.query(protectedRequest(), {
      authorization,
      connectTimeoutMs: 100,
    })
    harness.sockets[0]?.transportError()

    const result = await pending

    expect(source(result).failure).toBe("transport_unavailable")
    expect(
      result.observations.some((observation) => observation.type === "timeout")
    ).toBe(false)
  })

  it("aborts before connection and during a slow signer without a late AUTH", async () => {
    const preAbortedHarness = new FakeRelayHarness()
    const preAbortedExecutor = createExecutor(preAbortedHarness)
    const preAborted = new AbortController()
    preAborted.abort()
    const { authorization } = authorize()

    const early = await preAbortedExecutor.query(protectedRequest(), {
      authorization,
      signal: preAborted.signal,
    })
    expect(early.status).toBe("aborted")
    expect(preAbortedHarness.sockets).toHaveLength(0)

    let release!: () => void
    const signing = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowSigner: NostrEventSigner = {
      authMethod: "nip07",
      getPublicKey: async () => PUBKEY_A,
      signEvent: async (event) => {
        await signing
        return finalizeEvent(event, PRIVATE_KEY_A)
      },
    }
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "abort-signing"]),
    })
    const executor = createExecutor(harness)
    const next = authorize(slowSigner)
    const controller = new AbortController()
    const pending = executor.query(protectedRequest(), {
      authorization: next.authorization,
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    const aborted = await pending
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(aborted.status).toBe("aborted")
    expect(harness.sockets[0]?.sent.some((frame) => frame[0] === "AUTH")).toBe(
      false
    )
  })

  it("closes an orphaned connecting socket on abort but preserves a shared waiter", async () => {
    const singleHarness = new FakeRelayHarness().at("wss://protected.example", {
      autoOpen: false,
    })
    const singleExecutor = createExecutor(singleHarness)
    const singleAuthorization = authorize().authorization
    const singleAbort = new AbortController()
    const single = singleExecutor.query(protectedRequest(), {
      authorization: singleAuthorization,
      signal: singleAbort.signal,
    })
    await Promise.resolve()
    singleAbort.abort()
    expect((await single).status).toBe("aborted")
    expect(singleHarness.sockets[0]?.closed).toBe(true)
    expect(
      singleExecutor.getAuthenticationEvidence(
        "wss://protected.example",
        singleAuthorization.sessionScope
      )
    ).toBeUndefined()

    const sharedHarness = new FakeRelayHarness().at("wss://protected.example", {
      autoOpen: false,
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const sharedExecutor = createExecutor(sharedHarness)
    const sharedAuthorization = authorize().authorization
    const firstAbort = new AbortController()
    const first = sharedExecutor.query(protectedRequest(), {
      authorization: sharedAuthorization,
      signal: firstAbort.signal,
    })
    const second = sharedExecutor.query(protectedRequest(), {
      authorization: sharedAuthorization,
    })
    await Promise.resolve()
    firstAbort.abort()
    expect((await first).status).toBe("aborted")
    expect(sharedHarness.sockets[0]?.closed).toBe(false)
    sharedHarness.sockets[0]?.open()
    expect((await second).status).toBe("success")
    expect(sharedHarness.sockets).toHaveLength(1)
  })

  it("never signs a challenge twice after AUTH is sent and the caller aborts", async () => {
    let signCalls = 0
    let authSent!: () => void
    const sent = new Promise<void>((resolve) => {
      authSent = resolve
    })
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "abort-after-send"]),
      onSend: (_socket, frame) => {
        if (frame[0] === "AUTH") authSent()
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )
    const controller = new AbortController()
    const first = executor.query(protectedRequest(), {
      authorization,
      signal: controller.signal,
    })
    await sent
    controller.abort()
    expect((await first).status).toBe("aborted")

    const second = await executor.query(protectedRequest(), { authorization })
    expect(source(second).failure).toBe("challenge_replayed")
    expect(signCalls).toBe(1)

    const third = await executor.query(protectedRequest(), { authorization })
    expect(source(third).failure).toBe("challenge_replayed")
    expect(signCalls).toBe(1)
  })

  it("does not re-sign an A challenge after A to B to A supersession", async () => {
    const signedChallenges: string[] = []
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "challenge-a"]),
      onSend: (socket, frame) => {
        if (frame[0] !== "AUTH") return
        const event = frame[1] as SignedNostrEvent
        const challenge = event.tags.find((tag) => tag[0] === "challenge")?.[1]
        if (challenge === "challenge-a") {
          socket.relay(["AUTH", "challenge-b"])
          return
        }
        respondToAuth(socket, frame)
        socket.relay(["AUTH", "challenge-a"])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, {
        onSign: (event) => {
          signedChallenges.push(
            event.tags.find((tag) => tag[0] === "challenge")?.[1] ?? ""
          )
        },
      })
    )

    const result = await executor.query(protectedRequest(), { authorization })

    expect(source(result).failure).toBe("challenge_replayed")
    expect(signedChallenges).toEqual(["challenge-a", "challenge-b"])
  })

  it("maps restricted subscriptions separately and clears live success evidence", async () => {
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "restricted-after-auth"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] === "REQ") {
          socket.relay(["CLOSED", frame[1], "restricted: policy"])
        }
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    const result = await executor.query(protectedRequest(), { authorization })

    expect(source(result)).toMatchObject({
      auth: "succeeded",
      failure: "subscription_rejected",
    })
    expect(signCalls).toBe(1)
    expect(harness.sockets[0]?.closed).toBe(true)
    expect(
      executor.getAuthenticationEvidence(
        "wss://protected.example",
        authorization.sessionScope
      )
    ).toBeUndefined()

    const suppressedPoll = await executor.query(protectedRequest(), {
      authorization,
    })
    expect(source(suppressedPoll).failure).toBe("subscription_rejected")
    expect(signCalls).toBe(1)
  })

  it("keeps malformed-only EOSE non-authoritative and closes the bad source", async () => {
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "malformed-after-auth"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] !== "REQ") return
        socket.relay(["EVENT", frame[1], { id: "invalid" }])
        socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.status).toBe("unavailable")
    expect(result.authoritativeEmpty).toBe(false)
    expect(source(result).failure).toBe("protocol_invalid")
    expect(harness.sockets[0]?.closed).toBe(true)
    expect(signCalls).toBe(1)

    const suppressedPoll = await executor.query(protectedRequest(), {
      authorization,
    })
    expect(source(suppressedPoll).failure).toBe("protocol_invalid")
    expect(signCalls).toBe(1)
  })

  it("suppresses repeated prompts after an authenticated protocol limit", async () => {
    let signCalls = 0
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "limit-after-auth"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame)
        if (frame[0] !== "REQ") return
        for (let index = 0; index < 4; index += 1) {
          socket.relay(["EOSE", `unmatched-${index}`])
        }
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize(
      createSigner(PRIVATE_KEY_A, { onSign: () => signCalls++ })
    )

    const first = await executor.query(protectedRequest(), {
      authorization,
      maxFramesPerRelay: 3,
    })
    expect(source(first).failure).toBe("protocol_limit_exceeded")
    expect(signCalls).toBe(1)

    const suppressedPoll = await executor.query(protectedRequest(), {
      authorization,
      maxFramesPerRelay: 3,
    })
    expect(source(suppressedPoll).failure).toBe("protocol_limit_exceeded")
    expect(signCalls).toBe(1)
  })

  it("fails a protected connection poisoned by an invalid early AUTH frame", async () => {
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      synchronousOpenFrame: true,
      onOpen: (socket) => socket.relay(["AUTH", ""]),
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)
    const { authorization } = authorize()

    const result = await executor.query(protectedRequest(), { authorization })

    expect(result.events).toEqual([])
    expect(source(result).failure).toBe("challenge_invalid")
    expect(harness.sockets[0]?.sent.some((frame) => frame[0] === "REQ")).toBe(
      false
    )

    const summaryHarness = new FakeRelayHarness().at(
      "wss://protected.example",
      {
        synchronousOpenFrame: true,
        onOpen: (socket) => socket.relay(["AUTH", ""]),
      }
    )
    const inbox = await readProtectedInbox({
      principalPubkey: PUBKEY_A,
      relayUrls: ["wss://protected.example"],
      limit: 10,
      authorization,
      executor: createExecutor(summaryHarness),
    })
    expect(inbox.auth).toMatchObject({
      state: "unavailable",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 1,
      failure: "challenge_invalid",
    })
  })

  it("rejects an oversized raw frame before parsing and evicts an idle pooled socket", async () => {
    const oversized = "x".repeat(2 * 1024 * 1024 + 1)
    const activeHarness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") socket.raw(oversized)
      },
    })
    const activeExecutor = createExecutor(activeHarness)
    const { authorization } = authorize()

    const active = await activeExecutor.query(protectedRequest(), {
      authorization,
    })
    expect(active.status).toBe("unavailable")
    expect(activeHarness.sockets[0]?.closed).toBe(true)

    const idleHarness = new FakeRelayHarness().at("wss://public.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") socket.relay(["EOSE", frame[1]])
      },
    })
    const idleExecutor = createExecutor(idleHarness)
    await idleExecutor.query(publicRequest())
    idleHarness.sockets[0]?.raw(oversized)
    expect(idleHarness.sockets[0]?.closed).toBe(true)
    await idleExecutor.query(publicRequest())
    expect(idleHarness.sockets).toHaveLength(2)
  })

  it("clears evidence-only failures on relay and scope cleanup", async () => {
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onOpen: (socket) => socket.relay(["AUTH", "cleanup-rejection"]),
      onSend: (socket, frame) => {
        if (frame[0] === "AUTH") respondToAuth(socket, frame, false)
      },
    })
    const executor = createExecutor(harness)
    const first = authorize()
    await executor.query(protectedRequest(), {
      authorization: first.authorization,
    })
    expect(
      executor.getAuthenticationEvidence(
        "wss://protected.example",
        first.authorization.sessionScope
      )
    ).toBe("rejected")
    executor.closeAuthenticatedRelay("wss://protected.example")
    expect(
      executor.getAuthenticationEvidence(
        "wss://protected.example",
        first.authorization.sessionScope
      )
    ).toBeUndefined()

    const second = authorize()
    await executor.query(protectedRequest(), {
      authorization: second.authorization,
    })
    expect(
      executor.getAuthenticationEvidence(
        "wss://protected.example",
        second.authorization.sessionScope
      )
    ).toBe("rejected")
    executor.closeAllAuthenticated()
    expect(
      executor.getAuthenticationEvidence(
        "wss://protected.example",
        second.authorization.sessionScope
      )
    ).toBeUndefined()
  })

  it("marks a protected inbox read capped when 200 events fill its limit", async () => {
    const events = Array.from({ length: 200 }, (_, index) =>
      giftWrap(`bounded-gift-wrap-${index}`)
    )
    const harness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] !== "REQ") return
        for (const event of events) {
          socket.relay(["EVENT", frame[1], event])
        }
        socket.relay(["EOSE", frame[1]])
      },
    })
    const { authorization } = authorize()

    const inbox = await readProtectedInbox({
      principalPubkey: PUBKEY_A,
      relayUrls: ["wss://protected.example"],
      limit: 200,
      authorization,
      executor: createExecutor(harness),
    })

    expect(inbox.events).toHaveLength(200)
    expect(inbox.relayResult.status).toBe("success")
    expect(inbox.capped).toBe(true)
    expect(inbox.coverage).toBe("partial")
  })

  it("bounds unmatched frames, event floods, and per-relay bytes", async () => {
    const unmatchedHarness = new FakeRelayHarness().at(
      "wss://protected.example",
      {
        onSend: (socket, frame) => {
          if (frame[0] !== "REQ") return
          for (let index = 0; index < 4; index += 1) {
            socket.relay(["EOSE", `unmatched-${index}`])
          }
        },
      }
    )
    const unmatchedExecutor = createExecutor(unmatchedHarness)
    const first = authorize()
    const unmatched = await unmatchedExecutor.query(protectedRequest(), {
      authorization: first.authorization,
      maxFramesPerRelay: 3,
    })
    expect(source(unmatched).failure).toBe("protocol_limit_exceeded")

    const floodEvents = [giftWrap("one"), giftWrap("two"), giftWrap("three")]
    const eventHarness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] !== "REQ") return
        for (const event of floodEvents) {
          socket.relay(["EVENT", frame[1], event])
        }
      },
    })
    const eventExecutor = createExecutor(eventHarness)
    const second = authorize()
    const flooded = await eventExecutor.query(protectedRequest(), {
      authorization: second.authorization,
      maxEventsPerRelay: 2,
    })
    expect(source(flooded).failure).toBe("protocol_limit_exceeded")
    expect(flooded.events).toEqual([])

    const byteHarness = new FakeRelayHarness().at("wss://protected.example", {
      onSend: (socket, frame) => {
        if (frame[0] === "REQ") {
          socket.relay(["NOTICE", "x".repeat(100)])
        }
      },
    })
    const byteExecutor = createExecutor(byteHarness)
    const third = authorize()
    const bytes = await byteExecutor.query(protectedRequest(), {
      authorization: third.authorization,
      maxBytesPerRelay: 20,
    })
    expect(source(bytes).failure).toBe("protocol_limit_exceeded")
  })

  it("refuses guest or unclassified signers before a protected socket exists", () => {
    const signer = createSigner(PRIVATE_KEY_A)
    delete (signer as { authMethod?: string }).authMethod

    expect(() =>
      installProtectedReadSigner(signer, PUBKEY_A, () => true)
    ).toThrow("NIP-07 or NIP-46")
  })

  it("counts malformed, duplicate, and filter-mismatched events without returning them", async () => {
    const valid = finalizeEvent(
      {
        kind: 1,
        created_at: 1_700_000_000,
        tags: [],
        content: "valid",
      },
      PRIVATE_KEY_A
    )
    const wrongKind = finalizeEvent(
      {
        kind: 2,
        created_at: 1_700_000_000,
        tags: [],
        content: "wrong",
      },
      PRIVATE_KEY_A
    )
    const harness = new FakeRelayHarness().at("wss://public.example", {
      onSend: (socket, frame) => {
        if (frame[0] !== "REQ") return
        socket.raw("not-json")
        socket.relay(["EVENT", frame[1], { ...valid, sig: "0".repeat(128) }])
        socket.relay(["EVENT", frame[1], wrongKind])
        socket.relay(["EVENT", frame[1], valid])
        socket.relay(["EVENT", frame[1], valid])
        socket.relay(["EOSE", frame[1]])
      },
    })
    const executor = createExecutor(harness)

    const result = await executor.query(publicRequest())

    expect(result.events.map((event) => event.id)).toEqual([valid.id])
    expect(source(result)).toMatchObject({
      eventCount: 1,
      duplicateCount: 1,
      malformedCount: 2,
      unusableCount: 1,
    })
  })
})

describe("relay executor dependency boundary", () => {
  it("propagates invalid streaming requests instead of silently ending", async () => {
    const executor = createExecutor(new FakeRelayHarness())
    const stream = executor.req({
      relayUrls: [],
      filters: [],
      operation: "public_read",
    })
    const iterator = stream[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toThrow(
      "Relay request requires relays and filters"
    )
  })

  it("aborts relay work when a streaming consumer stops early", async () => {
    const harness = new FakeRelayHarness().at("wss://public.example", {})
    const executor = createExecutor(harness)

    for await (const observation of executor.req(publicRequest(), {
      queryTimeoutMs: 1_000,
    })) {
      expect(observation.type).toBe("connection")
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.sockets[0]?.sent.some((frame) => frame[0] === "CLOSE")).toBe(
      true
    )
  })

  it("keeps the executor and authorization modules free of NDK imports", async () => {
    const sources = await Promise.all(
      [
        "packages/core/src/protocol/relay-executor.ts",
        "packages/core/src/protocol/protected-read-authorization.ts",
        "packages/core/src/protocol/protected-inbox-read.ts",
        "packages/core/src/protocol/nostr-event-signer.ts",
      ].map((path) => Bun.file(path).text())
    )

    for (const sourceText of sources) {
      expect(sourceText).not.toContain("@nostr-dev-kit/ndk")
      expect(sourceText).not.toMatch(/\bNDK(?:Event|Relay|Subscription)\b/)
    }
  })
})
