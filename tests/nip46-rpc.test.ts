import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
  type Filter,
} from "nostr-tools"
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44"

import {
  ConduitNip46Signer,
  Nip46TransportError,
  type Nip46RpcPool,
  type Nip46RpcSubscription,
} from "../packages/core/src/protocol/nip46-rpc"

const RELAYS = ["wss://first.example", "wss://second.example"]

interface SubscriptionRecord {
  relay: string
  filter: Filter
  subscription: Nip46RpcSubscription
  closed: boolean
}

class FakePool implements Nip46RpcPool {
  readonly subscriptions: SubscriptionRecord[] = []
  readonly published: Event[] = []
  readonly subscribeFailures = new Set<string>()
  readonly publishFailures = new Set<string>()
  destroyed = false

  subscribe(
    relays: string[],
    filter: Filter,
    subscription: Nip46RpcSubscription
  ): { close: () => void } {
    expect(relays).toHaveLength(1)
    if (this.subscribeFailures.has(relays[0]!)) {
      throw new Error(`subscription failure: ${relays[0]}`)
    }
    const record: SubscriptionRecord = {
      relay: relays[0]!,
      filter,
      subscription,
      closed: false,
    }
    this.subscriptions.push(record)
    return {
      close: () => {
        record.closed = true
      },
    }
  }

  publish(relays: string[], event: Event): Promise<string>[] {
    this.published.push(event)
    return relays.map((relay) =>
      this.publishFailures.has(relay)
        ? Promise.reject(new Error(`connection failure: ${relay}`))
        : Promise.resolve("saved")
    )
  }

  closeRelay(relay: string): void {
    const record = [...this.subscriptions]
      .reverse()
      .find((candidate) => candidate.relay === relay && !candidate.closed)
    expect(record).toBeDefined()
    if (!record) return
    record.closed = true
    record.subscription.onclose?.([{ url: relay, reason: "connection closed" }])
  }

  emit(relay: string, event: Event): void {
    const record = [...this.subscriptions]
      .reverse()
      .find((candidate) => candidate.relay === relay && !candidate.closed)
    expect(record).toBeDefined()
    record?.subscription.onevent(event)
  }

  destroy(): void {
    this.destroyed = true
  }
}

function createHarness(
  options: { onauth?: (url: string) => void; pool?: FakePool } = {}
) {
  const clientKey = generateSecretKey()
  const remoteKey = generateSecretKey()
  const remotePubkey = getPublicKey(remoteKey)
  const clientPubkey = getPublicKey(clientKey)
  const pool = options.pool ?? new FakePool()
  const signer = new ConduitNip46Signer(
    clientKey,
    {
      pubkey: remotePubkey,
      relays: RELAYS,
      secret: null,
    },
    { pool, onauth: options.onauth }
  )

  function readRequest(index = pool.published.length - 1): {
    event: Event
    id: string
    method: string
  } {
    const event = pool.published[index]!
    const payload = JSON.parse(
      decrypt(event.content, getConversationKey(remoteKey, event.pubkey))
    ) as { id: string; method: string }
    return { event, id: payload.id, method: payload.method }
  }

  function response(id: string, payload: Record<string, unknown>): Event {
    return finalizeEvent(
      {
        kind: 24133,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", clientPubkey]],
        content: encrypt(
          JSON.stringify({ id, ...payload }),
          getConversationKey(remoteKey, clientPubkey)
        ),
      },
      remoteKey
    )
  }

  function unreadableResponse(): Event {
    return finalizeEvent(
      {
        kind: 24133,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", clientPubkey]],
        content: "not-nip44-ciphertext",
      },
      remoteKey
    )
  }

  return { signer, pool, readRequest, response, unreadableResponse }
}

describe("Conduit NIP-46 RPC transport", () => {
  it("cleans up and reports an immediate all-relay publish failure", async () => {
    const { signer, pool } = createHarness()
    pool.publishFailures.add(RELAYS[0]!)
    pool.publishFailures.add(RELAYS[1]!)
    const failures: Nip46TransportError[] = []
    signer.onLifecycleFailure((failure) => failures.push(failure))

    await expect(signer.sendRequest("ping", [])).rejects.toMatchObject({
      code: "unavailable",
    })

    expect(signer.hasPendingRequests()).toBe(false)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.code).toBe("unavailable")
  })

  it("keeps a request usable after one relay subscription and publish path fail", async () => {
    const { signer, pool, readRequest, response } = createHarness()
    const failures: Nip46TransportError[] = []
    signer.onLifecycleFailure((failure) => failures.push(failure))
    pool.closeRelay(RELAYS[0]!)
    pool.publishFailures.add(RELAYS[0]!)

    const pending = signer.sendRequest("ping", [])
    const request = readRequest()
    pool.emit(RELAYS[1]!, response(request.id, { result: "pong" }))

    await expect(pending).resolves.toBe("pong")
    expect(failures).toHaveLength(0)
    expect(signer.hasPendingRequests()).toBe(false)
  })

  it("keeps the route usable when one response subscription cannot open", async () => {
    const pool = new FakePool()
    pool.subscribeFailures.add(RELAYS[0]!)
    const { signer, readRequest, response } = createHarness({ pool })

    const pending = signer.sendRequest("ping", [])
    const request = readRequest()
    pool.emit(RELAYS[1]!, response(request.id, { result: "pong" }))

    await expect(pending).resolves.toBe("pong")
  })

  it("refuses to construct a transport with no response subscription", () => {
    const pool = new FakePool()
    for (const relay of RELAYS) pool.subscribeFailures.add(relay)

    expect(() => createHarness({ pool })).toThrow(Nip46TransportError)
  })

  it("marks the transport unavailable when every response subscription closes", async () => {
    const { signer, pool } = createHarness()
    const failures: Nip46TransportError[] = []
    signer.onLifecycleFailure((failure) => failures.push(failure))

    pool.closeRelay(RELAYS[0]!)
    expect(failures).toHaveLength(0)
    pool.closeRelay(RELAYS[1]!)

    expect(failures).toHaveLength(1)
    expect(failures[0]?.code).toBe("unavailable")
    await expect(signer.sendRequest("ping", [])).rejects.toMatchObject({
      code: "unavailable",
    })
  })

  it("settles a raw null result instead of stranding the request", async () => {
    const { signer, pool, readRequest, response } = createHarness()

    const pending = signer.sendRequest("switch_relays", [])
    const request = readRequest()
    pool.emit(RELAYS[0]!, response(request.id, { result: null }))

    await expect(pending).resolves.toBeNull()
    expect(signer.hasPendingRequests()).toBe(false)
  })

  it("accepts conventional null errors and preserves an empty result", async () => {
    const { signer, pool, readRequest, response } = createHarness()

    const pending = signer.sendRequest("nip44_decrypt", [])
    const request = readRequest()
    pool.emit(RELAYS[0]!, response(request.id, { result: "", error: null }))

    await expect(pending).resolves.toBe("")
    expect(signer.hasPendingRequests()).toBe(false)
  })

  it("keeps auth_url interim responses pending until a final result arrives", async () => {
    const authUrls: string[] = []
    const harness = createHarness({ onauth: (url) => authUrls.push(url) })

    const pending = harness.signer.sendRequest("connect", [])
    const request = harness.readRequest()
    const onauth = "https://signer.example/approve"
    harness.pool.emit(
      RELAYS[0]!,
      harness.response(request.id, { result: "auth_url", error: onauth })
    )
    expect(harness.signer.hasPendingRequests()).toBe(true)
    expect(authUrls).toEqual([onauth])
    expect(harness.pool.published).toHaveLength(1)

    harness.pool.emit(
      RELAYS[1]!,
      harness.response(request.id, { result: "ack" })
    )
    await expect(pending).resolves.toBe("ack")
    expect(harness.pool.published).toHaveLength(1)
  })

  it("classifies rejection separately from an unsupported method", async () => {
    const { signer, pool, readRequest, response } = createHarness()
    const rejected = signer.sendRequest("sign_event", [])
    const rejectedRequest = readRequest()
    pool.emit(
      RELAYS[0]!,
      response(rejectedRequest.id, { error: "permission denied" })
    )
    await expect(rejected).rejects.toMatchObject({ code: "rejected" })

    const unsupported = signer.sendRequest("nip04_encrypt", [])
    const unsupportedRequest = readRequest()
    pool.emit(
      RELAYS[0]!,
      response(unsupportedRequest.id, { error: "unsupported method" })
    )
    await expect(unsupported).rejects.toMatchObject({ code: "unsupported" })

    const next = signer.sendRequest("ping", [])
    const nextRequest = readRequest()
    pool.emit(RELAYS[1]!, response(nextRequest.id, { result: "pong" }))
    await expect(next).resolves.toBe("pong")
  })

  it("fails closed on an authenticated but unreadable response", async () => {
    const { signer, pool, unreadableResponse } = createHarness()
    const pending = signer.sendRequest("ping", [])

    pool.emit(RELAYS[0]!, unreadableResponse())

    await expect(pending).rejects.toMatchObject({ code: "invalid_response" })
    expect(signer.hasPendingRequests()).toBe(false)
  })

  it("rejects a malformed matching response and clears every pending request", async () => {
    const { signer, pool, readRequest, response } = createHarness()
    const first = signer.sendRequest("ping", [])
    const firstRequest = readRequest()
    const second = signer.sendRequest("get_public_key", [])
    void readRequest()

    pool.emit(
      RELAYS[0]!,
      response(firstRequest.id, { result: { unexpected: true } })
    )

    await expect(first).rejects.toMatchObject({ code: "invalid_response" })
    await expect(second).rejects.toMatchObject({ code: "invalid_response" })
    expect(signer.hasPendingRequests()).toBe(false)
  })

  it("fences late responses after cancellation without affecting a later request", async () => {
    const { signer, pool, readRequest, response } = createHarness()
    const controller = new AbortController()
    const first = signer.sendRequest("ping", [], {
      signal: controller.signal,
    })
    const firstRequest = readRequest()
    controller.abort()
    await expect(first).rejects.toMatchObject({ code: "unavailable" })

    pool.emit(RELAYS[0]!, response(firstRequest.id, { result: "pong" }))
    const second = signer.sendRequest("ping", [])
    const secondRequest = readRequest()
    expect(secondRequest.id).not.toBe(firstRequest.id)
    pool.emit(RELAYS[1]!, response(secondRequest.id, { result: "pong" }))

    await expect(second).resolves.toBe("pong")
    expect(signer.hasPendingRequests()).toBe(false)
  })

  it("ignores unknown and duplicate responses", async () => {
    const { signer, pool, readRequest, response } = createHarness()
    pool.emit(RELAYS[0]!, response("unknown", { result: "pong" }))

    const pending = signer.sendRequest("ping", [])
    const request = readRequest()
    const reply = response(request.id, { result: "pong" })
    pool.emit(RELAYS[0]!, reply)
    pool.emit(RELAYS[1]!, reply)

    await expect(pending).resolves.toBe("pong")
    expect(signer.hasPendingRequests()).toBe(false)
  })

  it("ignores malformed relay events without stranding the real response", async () => {
    const { signer, pool, readRequest, response } = createHarness()
    const pending = signer.sendRequest("ping", [])
    const request = readRequest()

    pool.emit(RELAYS[0]!, { tags: [null] } as unknown as Event)
    pool.emit(RELAYS[1]!, response(request.id, { result: "pong" }))

    await expect(pending).resolves.toBe("pong")
  })

  it("settles every pending request when the transport closes", async () => {
    const { signer } = createHarness()
    const first = signer.sendRequest("ping", [])
    const second = signer.sendRequest("get_public_key", [])

    await signer.close()

    await expect(first).rejects.toMatchObject({ code: "unavailable" })
    await expect(second).rejects.toMatchObject({ code: "unavailable" })
    expect(signer.hasPendingRequests()).toBe(false)
  })

  it("restarts subscriptions on resume and fences ambiguous in-flight work", async () => {
    const { signer, pool } = createHarness()
    const pending = signer.sendRequest("sign_event", ["{}"])
    const originalSubscriptionCount = pool.subscriptions.length

    signer.resume()

    await expect(pending).rejects.toMatchObject({ code: "unavailable" })
    expect(pool.subscriptions.length).toBe(
      originalSubscriptionCount + RELAYS.length
    )
    for (const subscription of pool.subscriptions.slice(-RELAYS.length)) {
      expect(subscription.filter.limit).not.toBe(0)
      expect(subscription.filter.since).toBeNumber()
    }
  })

  it("ignores delayed close callbacks from superseded subscriptions", async () => {
    const { signer, pool, readRequest, response } = createHarness()
    const original = pool.subscriptions.slice()
    const failures: Nip46TransportError[] = []
    signer.onLifecycleFailure((failure) => failures.push(failure))

    signer.resume()
    for (const subscription of original) {
      subscription.subscription.onclose?.([
        { url: subscription.relay, reason: "superseded" },
      ])
    }

    const pending = signer.sendRequest("ping", [])
    const request = readRequest()
    pool.emit(RELAYS[0]!, response(request.id, { result: "pong" }))
    await expect(pending).resolves.toBe("pong")
    expect(failures).toEqual([])
  })
})
