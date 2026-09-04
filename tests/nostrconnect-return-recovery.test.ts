import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
  type Filter,
} from "nostr-tools"
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44"
import { BunkerSigner } from "nostr-tools/nip46"
import {
  SimplePool,
  useWebSocketImplementation as configureWebSocket,
} from "nostr-tools/pool"

import {
  pairRemoteSignerFromNostrConnect,
  type RemoteSignerConnection,
  type RemoteBunkerSigner,
  type RemoteSignerKeyVault,
  type RemoteSignerTimers,
} from "../packages/core/src/protocol/remote-signer"

const RELAYS = ["wss://first.example", "wss://second.example"]
const keyVault: RemoteSignerKeyVault = {
  prepare: async () => undefined,
  store: async () => undefined,
  load: async () => null,
  remove: async () => undefined,
}

class VisibleDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible"

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state
    this.dispatchEvent(new globalThis.Event("visibilitychange"))
  }
}

class ManualTimers implements RemoteSignerTimers {
  readonly callbacks = new Map<
    object,
    { callback: () => void; delay: number }
  >()
  readonly delays: number[] = []

  setTimeout(callback: () => void, delay: number): object {
    const handle = {}
    this.callbacks.set(handle, { callback, delay })
    this.delays.push(delay)
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as object)
  }

  fire(delay: number): void {
    const scheduled = [...this.callbacks].find(
      ([, task]) => task.delay === delay
    )
    expect(Boolean(scheduled)).toBe(true)
    if (!scheduled) return
    this.callbacks.delete(scheduled[0])
    scheduled[1].callback()
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}

// The relay forwards live events only. In particular, it never stores or replays
// ephemeral kind-24133 approvals. All signing and NIP-44 checks use nostr-tools.
function createRelayHarness() {
  const signerKey = generateSecretKey()
  const signerPubkey = getPublicKey(signerKey)
  const userPubkey = getPublicKey(generateSecretKey())
  let publicKeyResponse = userPubkey
  const sockets: RelaySocket[] = []
  const methods: string[] = []

  function response(clientPubkey: string, result: string, id = "approval") {
    return finalizeEvent(
      {
        kind: 24133,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", clientPubkey]],
        content: encrypt(
          JSON.stringify({ id, result }),
          getConversationKey(signerKey, clientPubkey)
        ),
      },
      signerKey
    )
  }

  function publish(event: Event): number {
    let deliveries = 0
    for (const socket of sockets) {
      if (socket.readyState !== RelaySocket.OPEN || socket.suspended) continue
      for (const [id, filters] of socket.subscriptions) {
        if (
          filters.some(
            (filter) =>
              filter.kinds?.includes(event.kind) &&
              filter["#p"]?.some((pubkey) =>
                event.tags.some((tag) => tag[0] === "p" && tag[1] === pubkey)
              ) &&
              (!filter.authors || filter.authors.includes(event.pubkey))
          )
        ) {
          deliveries++
          socket.receive(["EVENT", id, event])
        }
      }
    }
    return deliveries
  }

  class RelaySocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readyState = RelaySocket.CONNECTING
    onopen: (() => void) | null = null
    onclose: ((event: { message: string }) => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    readonly subscriptions = new Map<string, Filter[]>()
    suspended = false

    constructor(readonly url: string) {
      sockets.push(this)
      queueMicrotask(() => {
        if (this.readyState !== RelaySocket.CONNECTING) return
        this.readyState = RelaySocket.OPEN
        this.onopen?.()
      })
    }

    receive(message: unknown[]): void {
      queueMicrotask(() => {
        if (this.readyState === RelaySocket.OPEN && !this.suspended) {
          this.onmessage?.({ data: JSON.stringify(message) })
        }
      })
    }

    send(serialized: string): void {
      const [type, idOrEvent, ...filters] = JSON.parse(serialized)
      if (type === "REQ") {
        this.subscriptions.set(idOrEvent, filters)
        this.receive(["EOSE", idOrEvent])
      } else if (type === "CLOSE") {
        this.subscriptions.delete(idOrEvent)
      } else if (type === "EVENT") {
        const event = idOrEvent as Event
        expect(verifyEvent(event)).toBe(true)
        this.receive(["OK", event.id, true, ""])
        const request = JSON.parse(
          decrypt(event.content, getConversationKey(signerKey, event.pubkey))
        ) as { id: string; method: string }
        methods.push(request.method)
        publish(
          response(
            event.pubkey,
            request.method === "get_public_key" ? publicKeyResponse : "ack",
            request.id
          )
        )
      }
    }

    close(): void {
      if (this.readyState === RelaySocket.CLOSED) return
      this.readyState = RelaySocket.CLOSED
      this.subscriptions.clear()
      this.onclose?.({ message: "connection closed" })
    }
  }

  return {
    Socket: RelaySocket,
    sockets,
    methods,
    signerPubkey,
    userPubkey,
    setPublicKeyResponse: (value: string) => {
      publicKeyResponse = value
    },
    listeningCount: () =>
      sockets.filter(
        (socket) =>
          socket.readyState === RelaySocket.OPEN &&
          !socket.suspended &&
          socket.subscriptions.size > 0
      ).length,
    approve: (uri: string, result?: string) => {
      const parsed = new URL(uri)
      return publish(
        response(parsed.hostname, result ?? parsed.searchParams.get("secret")!)
      )
    },
    rejectSubscriptions: () => {
      for (const socket of sockets) {
        for (const id of [...socket.subscriptions.keys()]) {
          socket.receive(["CLOSED", id, "error: temporary interruption"])
          socket.subscriptions.delete(id)
        }
      }
    },
  }
}

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup() {
  const document = new VisibleDocument()
  const relay = createRelayHarness()
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document"
  )
  const originalWebSocket = Object.getOwnPropertyDescriptor(
    globalThis,
    "WebSocket"
  )
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  })
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: relay.Socket,
  })
  configureWebSocket(relay.Socket)
  cleanups.push(() => {
    for (const socket of relay.sockets) socket.close()
    for (const [name, descriptor] of [
      ["document", originalDocument],
      ["WebSocket", originalWebSocket],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    configureWebSocket(globalThis.WebSocket)
  })
  return { document, relay }
}

function beginPairing(
  timeoutMs = 2000,
  timers?: RemoteSignerTimers,
  options: {
    now?: () => number
    onCandidate?: (
      signer: RemoteBunkerSigner,
      index: number
    ) => Promise<RemoteBunkerSigner>
  } = {}
) {
  const controller = new AbortController()
  const uris: string[] = []
  let keyCount = 0
  let candidateCount = 0
  let connection: RemoteSignerConnection | undefined
  let failure: unknown
  const pending = pairRemoteSignerFromNostrConnect(RELAYS, {
    keyVault,
    signal: controller.signal,
    timeoutMs,
    timers,
    now: options.now,
    generateClientPrivateKey: () => {
      keyCount++
      return generateSecretKey()
    },
    onNostrConnectUri: (uri) => uris.push(uri),
    createNostrConnectSigner: (key, uri, params, signal) => {
      // The library bundles a private WebSocket implementation into nip46.
      // Supply only the transport seam; the actual fromURI handshake is used.
      const pool = params.pool ?? new SimplePool()
      if (!params.pool) cleanups.push(() => pool.destroy())
      const index = candidateCount++
      return BunkerSigner.fromURI(key, uri, { ...params, pool }, signal).then(
        (signer) => options.onCandidate?.(signer, index) ?? signer
      )
    },
  }).then(
    (result) => {
      connection = result
    },
    (error: unknown) => {
      failure = error
    }
  )
  cleanups.push(async () => {
    controller.abort()
    await pending
    await connection?.bunkerSigner.close()
  })
  return {
    controller,
    uris,
    pending,
    keyCount: () => keyCount,
    connection: () => connection,
    failure: () => failure,
  }
}

describe("Nostr Connect return recovery with the real signer library", () => {
  it("accepts live approval and verifies the connected user without re-pairing", async () => {
    const { relay } = setup()
    const pairing = beginPairing()
    await until(() => relay.listeningCount() === 2)
    relay.approve(pairing.uris[0]!)
    await pairing.pending
    expect(pairing.failure()).toBeUndefined()
    expect(pairing.connection()?.session.userPubkey === relay.userPubkey).toBe(
      true
    )
    expect(
      pairing.connection()?.session.remoteSignerPubkey === relay.signerPubkey
    ).toBe(true)
    expect(pairing.connection()?.bunkerSigner.bp.secret).toBeNull()
    expect(pairing.keyCount()).toBe(1)
  })

  it("keeps the same request after a lost ephemeral approval and closed sockets", async () => {
    const { document, relay } = setup()
    const pairing = beginPairing()
    await until(() => relay.listeningCount() === 2)
    const originalSockets = [...relay.sockets]
    document.setVisibility("hidden")
    for (const socket of originalSockets) socket.close()
    expect(relay.approve(pairing.uris[0]!)).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pairing.failure()).toBeUndefined()
    document.setVisibility("visible")
    await until(() => relay.listeningCount() === 2)
    expect(pairing.failure()).toBeUndefined()
    expect(pairing.uris).toHaveLength(1)
    expect(pairing.keyCount()).toBe(1)
    relay.approve(pairing.uris[0]!)
    await pairing.pending
    expect(pairing.connection()?.session.userPubkey === relay.userPubkey).toBe(
      true
    )
    expect(relay.methods.includes("logout")).toBe(false)
  })

  it("replaces apparently-open stale sockets on return without changing the request", async () => {
    const { document, relay } = setup()
    const pairing = beginPairing()
    await until(() => relay.listeningCount() === 2)
    const originalSockets = [...relay.sockets]
    document.setVisibility("hidden")
    for (const socket of originalSockets) socket.suspended = true
    expect(relay.approve(pairing.uris[0]!)).toBe(0)
    document.setVisibility("visible")
    await until(() => relay.listeningCount() === 2)
    expect(originalSockets.every((socket) => socket.readyState === 3)).toBe(
      true
    )
    expect(pairing.uris).toHaveLength(1)
    expect(pairing.keyCount()).toBe(1)
    relay.approve(pairing.uris[0]!)
    await pairing.pending
    expect(pairing.connection()?.session.userPubkey === relay.userPubkey).toBe(
      true
    )
  })

  it("retries a relay-closed listener with the same request and the original deadline", async () => {
    const { relay } = setup()
    const timers = new ManualTimers()
    const pairing = beginPairing(2000, timers)
    await until(() => relay.listeningCount() === 2)
    relay.rejectSubscriptions()
    await until(
      () => timers.delays.includes(1000) || pairing.failure() !== undefined
    )
    expect(pairing.failure()).toBeUndefined()
    timers.fire(1000)
    await until(() => relay.listeningCount() === 2)
    expect(timers.delays.filter((delay) => delay === 2000)).toHaveLength(1)
    expect(pairing.uris).toHaveLength(1)
    expect(pairing.keyCount()).toBe(1)
    relay.approve(pairing.uris[0]!)
    await pairing.pending
    expect(pairing.connection()?.session.userPubkey === relay.userPubkey).toBe(
      true
    )
  })

  it("ignores a valid encrypted approval with a different secret", async () => {
    const { relay } = setup()
    const pairing = beginPairing()
    await until(() => relay.listeningCount() === 2)
    relay.approve(pairing.uris[0]!, "not-this-pairing-secret")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pairing.connection()).toBeUndefined()
    expect(pairing.failure()).toBeUndefined()
    expect(relay.methods).toHaveLength(0)
    relay.approve(pairing.uris[0]!)
    await pairing.pending
    expect(pairing.connection()?.session.userPubkey === relay.userPubkey).toBe(
      true
    )
  })

  it("rejects a malformed user identity after an otherwise valid approval", async () => {
    const { relay } = setup()
    relay.setPublicKeyResponse("invalid-public-key")
    const pairing = beginPairing()
    await until(() => relay.listeningCount() === 2)
    relay.approve(pairing.uris[0]!)
    await pairing.pending
    expect(pairing.connection()).toBeUndefined()
    expect(pairing.failure()).toMatchObject({ code: "invalid_response" })
    expect(relay.sockets.every((socket) => socket.readyState === 3)).toBe(true)
  })

  it("closes a late superseded signer without logging out the winning pairing", async () => {
    const { document, relay } = setup()
    let obsolete: RemoteBunkerSigner | undefined
    let release: ((signer: RemoteBunkerSigner) => void) | undefined
    let obsoleteClosed = false
    const late = new Promise<RemoteBunkerSigner>((resolve) => {
      release = resolve
    })
    const pairing = beginPairing(2000, undefined, {
      onCandidate: async (signer, index) => {
        if (index !== 0) return signer
        const close = signer.close.bind(signer)
        signer.close = async () => {
          obsoleteClosed = true
          await close()
        }
        obsolete = signer
        return late
      },
    })
    await until(() => relay.listeningCount() === 2)
    relay.approve(pairing.uris[0]!)
    await until(() => obsolete !== undefined)
    document.setVisibility("hidden")
    document.setVisibility("visible")
    await until(() => relay.sockets.length > 2 && relay.listeningCount() === 2)
    release?.(obsolete!)
    await until(() => obsoleteClosed)
    expect(pairing.connection()).toBeUndefined()
    expect(pairing.failure()).toBeUndefined()
    expect(relay.methods.includes("logout")).toBe(false)
    relay.approve(pairing.uris[0]!)
    await pairing.pending
    expect(pairing.connection()?.bunkerSigner === obsolete).toBe(false)
    expect(pairing.connection()?.session.userPubkey === relay.userPubkey).toBe(
      true
    )
    expect(pairing.keyCount()).toBe(1)
    expect(relay.methods.includes("logout")).toBe(false)
  })

  for (const ending of ["cancel", "timeout"] as const) {
    it(`closes every listener on ${ending} and cannot revive on a later return`, async () => {
      const { document, relay } = setup()
      const timers = new ManualTimers()
      const pairing = beginPairing(2000, timers)
      await until(() => relay.listeningCount() === 2)
      document.setVisibility("hidden")
      if (ending === "cancel") pairing.controller.abort()
      else timers.fire(2000)
      await pairing.pending
      expect(pairing.failure()).toMatchObject({
        code: ending === "cancel" ? "rejected" : "timeout",
      })
      expect(relay.sockets.every((socket) => socket.readyState === 3)).toBe(
        true
      )
      const socketCount = relay.sockets.length
      document.setVisibility("visible")
      expect(relay.approve(pairing.uris[0]!)).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(relay.sockets).toHaveLength(socketCount)
      expect(pairing.connection()).toBeUndefined()
      expect(timers.callbacks.size).toBe(0)
    })
  }

  it("expires on return when suspension delayed the timeout callback", async () => {
    const { document, relay } = setup()
    const timers = new ManualTimers()
    let now = 0
    const pairing = beginPairing(2000, timers, { now: () => now })
    await until(() => relay.listeningCount() === 2)
    document.setVisibility("hidden")
    now = 2001
    document.setVisibility("visible")
    await pairing.pending
    expect(pairing.failure()).toMatchObject({ code: "timeout" })
    expect(pairing.keyCount()).toBe(1)
    expect(relay.sockets).toHaveLength(2)
    expect(relay.sockets.every((socket) => socket.readyState === 3)).toBe(true)
    expect(timers.callbacks.size).toBe(0)
  })

  it("stops return listeners after success and releases sockets when the signer closes", async () => {
    const { document, relay } = setup()
    const pairing = beginPairing()
    await until(() => relay.listeningCount() === 2)
    relay.approve(pairing.uris[0]!)
    await pairing.pending
    const socketCount = relay.sockets.length
    document.setVisibility("hidden")
    document.setVisibility("visible")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relay.sockets).toHaveLength(socketCount)
    await pairing.connection()?.bunkerSigner.close()
    expect(relay.sockets.every((socket) => socket.readyState === 3)).toBe(true)
  })
})
