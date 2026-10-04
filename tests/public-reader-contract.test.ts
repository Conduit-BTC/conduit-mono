import { afterEach, expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools/pure"
import {
  __resetPublicReaderTestState,
  attachEventSourceRelayUrl,
  closePublicRelayConnections,
  fetchPublicEventsWithDiagnostics,
  fetchSignedEventsFanoutDetailed,
  getEventSourceRelayUrls,
  mergeEventSourceRelayUrls,
  refreshPublicRelayConnectionsWhenIdle,
  verifySignedEvents,
  type PublicRelayReadResult,
} from "../packages/core/src/protocol/relay-reader"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  cacheSignedProductListingEvent,
  cacheSignedProductDeletionEvent,
} from "../packages/core/src/protocol/commerce"
import {
  __resetOwnerRelayListEvidenceForTests,
  createInMemoryOwnerRelayListEvidenceRepository,
  resolveOwnerRelayList,
} from "../packages/core/src/protocol/owner-relay-list-evidence"
import {
  __resetInboxDeclarationCache,
  resolveInboxDeclaration,
} from "../packages/core/src/protocol/private-message-routing"
import {
  __resetFollowListTestState,
  readLatestFollowLists,
} from "../packages/core/src/protocol/follows"
import { createInMemoryInboxDeclarationEvidenceRepository } from "../packages/core/src/protocol/inbox-declaration-evidence"
import { WebSocketCommerceRelayExecutor } from "../packages/core/src/protocol/relay-executor"

// Optional unchanged-main reference. The same wire fixture and normalized
// comparison run in a separate process; main is not the ground-truth oracle.
const referenceRoot = process.env.PR606_REFERENCE_ROOT
const reference = referenceRoot
  ? await import(`${referenceRoot}/packages/core/src/protocol/ndk.ts`)
  : undefined
const read: typeof fetchSignedEventsFanoutDetailed = reference
  ? reference.fetchEventsFanoutDetailed
  : fetchSignedEventsFanoutDetailed
const sources: typeof getEventSourceRelayUrls = reference
  ? reference.getEventSourceRelayUrls
  : getEventSourceRelayUrls
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
const A = "wss://contract-a.conduit.market"
const B = "wss://contract-b.conduit.market"
const C = "wss://contract-c.conduit.market"
const sign = (created_at: number, kind = 0, tags: string[][] = []) =>
  finalizeEvent(
    { kind, created_at, tags, content: "" },
    new Uint8Array(32).fill(19)
  )
const first = sign(200)
const second = sign(100)
const canonicalKeys = [
  "id",
  "pubkey",
  "created_at",
  "kind",
  "tags",
  "content",
  "sig",
].sort()
let reply: (socket: Socket, id: string) => void
const sockets: Socket[] = []
class Socket {
  static OPEN = 1
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  sent: unknown[][] = []
  constructor(readonly url: string) {
    sockets.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.(new Event("open"))
    })
  }
  send(payload: string) {
    if (this.readyState !== 1) throw new Error("closed fixture socket")
    const frame = JSON.parse(payload) as unknown[]
    this.sent.push(frame)
    if (frame[0] === "REQ") queueMicrotask(() => reply(this, String(frame[1])))
  }
  emit(frame: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
  }
  close() {
    this.readyState = 3
  }
}
function install(handler: typeof reply) {
  reply = handler
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: Socket,
  })
}
const options = (relayUrls = [A, B]) => ({
  relayUrls,
  skipHealthFilter: true,
  reuseRelayConnections: false,
  connectTimeoutMs: 100,
  fetchTimeoutMs: 100,
})
function normalize(result: PublicRelayReadResult) {
  return {
    events: result.events
      .map((event) => {
        const raw =
          "rawEvent" in event
            ? (event as unknown as { rawEvent(): typeof event }).rawEvent()
            : event
        return {
          id: raw.id,
          keys: Object.keys(raw).sort(),
          sources: sources(event).sort(),
        }
      })
      .sort((left, right) => left.id.localeCompare(right.id)),
    sources:
      result.eventSourceRelayUrls ??
      Object.fromEntries(
        result.events.map((event) => [event.id, sources(event).sort()])
      ),
    relays: result.relays
      .map(({ relayUrl, status, eventCount }) => ({
        relayUrl,
        status,
        eventCount,
      }))
      .sort((left, right) => left.relayUrl.localeCompare(right.relayUrl)),
  }
}
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("fixture barrier not reached")),
      2000
    )
    release = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  return { promise, release }
}
afterEach(() => {
  __resetPublicReaderTestState()
  reference?.__resetNdkTestState()
  __resetCommerceTestOverrides()
  __resetOwnerRelayListEvidenceForTests()
  __resetInboxDeclarationCache()
  __resetFollowListTestState()
  sockets.length = 0
  if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

for (const injected of [[B], B, 42, { relay: B }]) {
  it(`CON-01 wire extras preserve signed data and only actual deliveries (${JSON.stringify(injected)})`, async () => {
    install((socket, id) => {
      if (socket.url === A)
        socket.emit([
          "EVENT",
          id,
          {
            ...first,
            __conduitSourceRelayUrls: injected,
            rawEvent: "hostile",
            verified: true,
            relay: B,
            sourceRelayUrls: [B],
          },
        ])
      socket.emit(["EOSE", id])
    })
    const result = normalize(await read({ kinds: [0] }, options()))
    expect(result.events).toEqual([
      { id: first.id, keys: canonicalKeys, sources: [A] },
    ])
    expect(result.sources).toEqual({ [first.id]: [A] })
    expect(result.relays).toEqual([
      { relayUrl: A, status: "success", eventCount: 1 },
      { relayUrl: B, status: "success", eventCount: 0 },
    ])
  })
}

it("CON-02 duplicate/cache deliveries never borrow forged or previous-read provenance", async () => {
  install((socket, id) => {
    if (socket.url !== C)
      socket.emit(["EVENT", id, { ...first, __conduitSourceRelayUrls: [C] }])
    socket.emit(["EOSE", id])
  })
  const duplicate = normalize(await read({ kinds: [0] }, options([A, B, C])))
  expect(duplicate.events).toEqual([
    { id: first.id, keys: canonicalKeys, sources: [A, B] },
  ])
  expect(duplicate.sources).toEqual({ [first.id]: [A, B] })
  const cached = normalize(await read({ kinds: [0] }, options([B, C])))
  expect(cached.events).toEqual([
    { id: first.id, keys: canonicalKeys, sources: [B] },
  ])
  expect(cached.sources).toEqual({ [first.id]: [B] })
})

it("CON-03 duplicate proofs cannot starve distinct events on cold or warm verification", async () => {
  install((socket, id) => {
    for (let index = 0; index < 512; index++) socket.emit(["EVENT", id, first])
    socket.emit(["EVENT", id, second])
    socket.emit(["EOSE", id])
  })
  for (let round = 0; round < 2; round++) {
    const result = await read({ kinds: [0], limit: 200 }, options([A]))
    // Main also drops the second event on a cold proof cache. Record that
    // historical disagreement (warm main also spends the copy limit), grounding the candidate in
    // the two distinct, valid fixture events.
    const expected = reference ? [first.id] : [first.id, second.id]
    expect(result.events.map((event) => event.id)).toEqual(expected)
    expect(result.relays[0].status).toBe(
      reference && round === 0 ? "partial" : "success"
    )

    if (!reference) {
      expect(result.readCoverage).toBe("complete")
      expect(result.relays[0].duplicateEventCount).toBe(511)
      expect(result.relays[0].eventCount).toBe(2)
      const diagnostics = await fetchPublicEventsWithDiagnostics(
        { kinds: [0], limit: 200 },
        options([A])
      )
      expect(diagnostics.cappedRelayUrls).toEqual([])
    }
  }
})

it("CON-06 executor planning/refresh/retirement schedule compares main with fixture ground truth", async () => {
  const Executor: typeof WebSocketCommerceRelayExecutor = referenceRoot
    ? (
        await import(
          `${referenceRoot}/packages/core/src/protocol/relay-executor.ts`
        )
      ).WebSocketCommerceRelayExecutor
    : WebSocketCommerceRelayExecutor
  const started = barrier()
  let requests = 0
  install((socket, id) => {
    if (socket.url === B) socket.emit(["EOSE", id])
    else if (++requests === 8) started.release()
  })
  const executor = new Executor({ createWebSocket: (url) => new Socket(url) })
  const sibling = new Executor({ createWebSocket: (url) => new Socket(url) })
  try {
    const pending = executor.query(
      {
        operation: "public_read",
        relayUrls: Array.from(
          { length: 9 },
          (_, index) => `wss://comparison-${index}.example`
        ),
        filters: [{ kinds: [0] }],
      },
      { queryTimeoutMs: 500 }
    )
    if (reference) reference.refreshNdkRelaySettingsWhenIdle()
    else refreshPublicRelayConnectionsWhenIdle()
    await started.promise
    const siblingRead = sibling.query({
      operation: "public_read",
      relayUrls: [B],
      filters: [{ kinds: [0] }],
    })
    executor.closeAll()
    const result = await pending
    await expect(siblingRead).resolves.toMatchObject({ status: "success" })
    const owned = sockets.filter((socket) =>
      socket.url.startsWith("wss://comparison-")
    )
    expect(owned).toHaveLength(reference ? 9 : 8)
    expect(owned.every((socket) => socket.readyState === 3)).toBe(true)
    if (!reference) expect(result.status).toBe("aborted")
    console.log(
      JSON.stringify({
        contractReference: reference ? "main" : "candidate",
        ownedSockets: owned.length,
        openOwnedSockets: owned.filter((socket) => socket.readyState === 1)
          .length,
        retirementStatus: result.status,
      })
    )
    await expect(
      executor.query({
        operation: "public_read",
        relayUrls: [B],
        filters: [{ kinds: [0] }],
      })
    ).resolves.toMatchObject({ status: "success" })
  } finally {
    executor.dispose()
    sibling.dispose()
  }
})

if (!reference) {
  it("CON-01 standalone verification canonicalizes both proof paths and isolates trusted provenance", async () => {
    for (let round = 0; round < 2; round++) {
      const input = {
        ...first,
        __conduitSourceRelayUrls: [B],
        rawEvent: "hostile",
      }
      const { events } = await verifySignedEvents([input])
      expect(events).toHaveLength(1)
      expect(Object.keys(events[0]).sort()).toEqual(canonicalKeys)
      expect(getEventSourceRelayUrls(events[0])).toEqual([])
      expect(events[0]).not.toBe(input)
      expect(events[0].tags).not.toBe(input.tags)
    }
    const trusted = { ...first }
    attachEventSourceRelayUrl(trusted, A)
    const verified = (await verifySignedEvents([trusted])).events[0]
    expect(getEventSourceRelayUrls(verified)).toEqual([A])
    attachEventSourceRelayUrl(verified, B)
    expect(getEventSourceRelayUrls(trusted)).toEqual([A])
    const target = { ...first, __conduitSourceRelayUrls: [C] }
    mergeEventSourceRelayUrls(target, verified)
    expect(getEventSourceRelayUrls(target)).toEqual([A, B])
  })

  it("CON-01 verification snapshots signed content and nested tags before asynchronous work", async () => {
    const input = { ...first, tags: [["t", "original"]] }
    const signedInput = {
      ...sign(201, 0, input.tags),
      tags: input.tags.map((tag) => [...tag]),
    }
    const original = JSON.parse(JSON.stringify(signedInput))
    const pending = verifySignedEvents([signedInput])
    signedInput.content = "unsigned mutation"
    signedInput.tags[0][1] = "unsigned tag mutation"
    const result = await pending
    expect(result.events).toEqual([original])
    expect(result.events[0].tags).not.toBe(signedInput.tags)
  })

  it("CON-03 three copies of one declaration do not imply a distinct-event cap", async () => {
    const declaration = sign(210, 10002, [["r", A]])
    install((socket, id) => {
      for (let index = 0; index < 3; index++)
        socket.emit(["EVENT", id, declaration])
      socket.emit(["EOSE", id])
    })
    const result = await fetchPublicEventsWithDiagnostics(
      { kinds: [10002], limit: 3 },
      options([A])
    )
    expect(result.events).toHaveLength(1)
    expect(result.readCoverage).toBe("complete")
    expect(result.cappedRelayUrls).toEqual([])
  })

  it("CON-03 follow coverage counts distinct signed revisions rather than copies", async () => {
    const follow = sign(240, 3, [["p", second.pubkey]])
    install((socket, id) => {
      if (socket.url === A)
        for (let index = 0; index < 10; index++)
          socket.emit(["EVENT", id, follow])
      socket.emit(["EOSE", id])
    })
    const result = await readLatestFollowLists(
      { pubkeys: [follow.pubkey] },
      {
        now: () => 300_000,
        resolveRelayLists: async () =>
          new Map([
            [
              follow.pubkey,
              {
                pubkey: follow.pubkey,
                readRelayUrls: [A],
                writeRelayUrls: [A],
                eventCreatedAt: 1,
                lookupState: "network",
                cachedAt: 1,
              },
            ],
          ]),
      }
    )
    expect(result.authors[0].capped).toBe(false)
    expect(result.authors[0].coverage).toBe("complete")
    expect(result.authors[0].eventSourceRelayUrls).toEqual([A])
    expect(
      result.authors[0].relays.find((relay) => relay.relayUrl === A)?.eventCount
    ).toBe(1)
  })

  it("CON-08 declaration owners cannot confirm an event on an empty successful source", async () => {
    let declaration = sign(220, 10002, [["r", A]])
    install((socket, id) => {
      if (socket.url === A)
        for (let index = 0; index < 3; index++)
          socket.emit([
            "EVENT",
            id,
            {
              ...declaration,
              __conduitSourceRelayUrls: [B],
              rawEvent: "hostile",
            },
          ])
      socket.emit(["EOSE", id])
    })
    const owner = await resolveOwnerRelayList(declaration.pubkey, {
      relayUrls: [A, B],
      evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
    })
    expect(owner.observation.coverage).toBe("complete")
    expect(owner.observation.eventSourceRelayUrls).toEqual([A])
    expect(owner.current?.sourceRelayUrls).toEqual([A])
    declaration = sign(230, 10050, [["relay", A]])
    const inbox = await resolveInboxDeclaration(declaration.pubkey, {
      relayUrls: [A, B],
      sharedConfirmationRelayUrls: [A, B],
      evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
    })
    expect(inbox.observation?.coverage).toBe("complete")
    expect(inbox.observation?.eventSourceRelayUrls).toEqual([A])
    expect(inbox.sourceRelayUrls).toEqual([A])
    // These fixture sources are outside the canonical shared-confirmation set.
    expect(inbox.sharedSourceRelayUrls).toEqual([])
  })

  it("CON-08 canonical delivery reaches product/deletion cache consumers with only observed provenance", async () => {
    __setCommerceTestOverrides({
      putCachedProducts: async () => {},
      putCachedProductTombstones: async () => {},
    })
    const product = sign(300, 30402, [
      ["d", "contract"],
      ["title", "Contract fixture"],
      ["price", "1", "SATS"],
      ["type", "simple", "physical"],
    ])
    const deletion = sign(400, 5, [
      ["e", product.id],
      ["k", "30402"],
    ])
    install((socket, id) => {
      if (socket.url === A)
        for (const event of [product, deletion])
          socket.emit([
            "EVENT",
            id,
            { ...event, rawEvent: "hostile", __conduitSourceRelayUrls: [B] },
          ])
      socket.emit(["EOSE", id])
    })
    const result = await read({ kinds: [30402, 5] }, options())
    const record = await cacheSignedProductListingEvent(
      result.events.find((event) => event.kind === 30402)!
    )
    expect(record.sourceRelayUrls).toEqual([A])
    const tombstones = await cacheSignedProductDeletionEvent(
      result.events.find((event) => event.kind === 5)!
    )
    expect(tombstones.length).toBeGreaterThan(0)
    expect(
      tombstones.every(
        (row) => JSON.stringify(row.sourceRelayUrls) === JSON.stringify([A])
      )
    ).toBe(true)
  })

  for (const retirement of ["caller", "scope"] as const) {
    it(`CON-05 ${retirement} retirement inside connection callback sends no late REQ`, async () => {
      install(() => {})
      const controller = new AbortController()
      const scope = { createWebSocket: (url: string) => new Socket(url) }
      const pending = read(
        { kinds: [0] },
        {
          ...options([A]),
          reuseRelayConnections: true,
          socketScope: scope,
          signal: controller.signal,
          onConnection: () =>
            retirement === "caller"
              ? controller.abort()
              : closePublicRelayConnections(scope),
        }
      )
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(
        sockets
          .flatMap((socket) => socket.sent)
          .filter((frame) => frame[0] === "REQ")
      ).toEqual([])
    })
  }

  it("CON-05 cumulative callback cancellation fences the per-source callback", async () => {
    install((socket, id) => socket.emit(["EOSE", id]))
    const controller = new AbortController()
    let calls = 0
    await expect(
      read(
        { kinds: [0] },
        {
          ...options([A]),
          signal: controller.signal,
          onProgress: () => controller.abort(),
          onRelayProgress: () => {
            calls++
          },
        }
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toBe(0)
  })

  for (const phase of ["connection", "cumulative", "async"] as const) {
    it(`CON-05 current authority loss in ${phase} callback stops subsequent work`, async () => {
      install((socket, id) => socket.emit(["EOSE", id]))
      let current = true
      let sourceCallbacks = 0
      const scope = { createWebSocket: (url: string) => new Socket(url) }
      const pending = read(
        { kinds: [0] },
        {
          ...options([A]),
          socketScope: scope,
          shouldContinue: () => current,
          onConnection: () => {
            if (phase === "connection") current = false
          },
          onProgress: () => {
            if (phase === "cumulative") current = false
          },
          onRelayProgress: async () => {
            sourceCallbacks++
            if (phase === "async") current = false
          },
        }
      )
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(sourceCallbacks).toBe(phase === "async" ? 1 : 0)
      if (phase === "connection")
        expect(
          sockets
            .flatMap((socket) => socket.sent)
            .filter((frame) => frame[0] === "REQ")
        ).toEqual([])
    })
  }

  it("CON-06 explicit retirement immediately closes sockets while awaiting a cooperative callback", async () => {
    install((socket, id) => socket.emit(["EOSE", id]))
    const entered = barrier()
    const released = barrier()
    const scope = { createWebSocket: (url: string) => new Socket(url) }
    let settled = false
    const pending = read(
      { kinds: [0] },
      {
        ...options([A]),
        socketScope: scope,
        reuseRelayConnections: true,
        onRelayProgress: async () => {
          entered.release()
          await released.promise
        },
      }
    ).then(
      () => {
        settled = true
        return null
      },
      (error: unknown) => {
        settled = true
        return error
      }
    )
    await entered.promise
    try {
      closePublicRelayConnections(scope)
      await Promise.resolve()
      expect(sockets.every((socket) => socket.readyState === 3)).toBe(true)
      expect(settled).toBe(false)
    } finally {
      released.release()
    }
    expect(await pending).toMatchObject({ name: "AbortError" })
  })

  it("CON-06 refresh plus saturated queue retirement preserves sibling ownership and reuse", async () => {
    const eightStarted = barrier()
    const callbackEntered = barrier()
    const callbackReleased = barrier()
    let requests = 0
    install((socket, id) => {
      if (socket.url === B) {
        socket.emit(["EOSE", id])
        return
      }
      if (++requests === 8) eightStarted.release()
    })
    const executor = new WebSocketCommerceRelayExecutor({
      createWebSocket: (url) => new Socket(url),
    })
    const pending = executor.query(
      {
        operation: "public_read",
        relayUrls: Array.from(
          { length: 9 },
          (_, index) => `wss://saturated-${index}.example`
        ),
        filters: [{ kinds: [0] }],
      },
      { queryTimeoutMs: 500 }
    )
    const scope = { createWebSocket: (url: string) => new Socket(url) }
    const sibling = read(
      { kinds: [0] },
      {
        ...options([B]),
        reuseRelayConnections: true,
        socketScope: scope,
        onRelayProgress: async () => {
          callbackEntered.release()
          await callbackReleased.promise
        },
      }
    )
    const siblingSettled = sibling.then(() => true)
    try {
      await eightStarted.promise
      refreshPublicRelayConnectionsWhenIdle()
      executor.closeAll()
      await expect(pending).resolves.toMatchObject({ status: "aborted" })
      await callbackEntered.promise
      expect(
        sockets.filter((socket) => socket.url.startsWith("wss://saturated-"))
      ).toHaveLength(8)
      expect(
        sockets
          .filter((socket) => socket.url.startsWith("wss://saturated-"))
          .every((socket) => socket.readyState === 3)
      ).toBe(true)
      expect(sockets.find((socket) => socket.url === B)?.readyState).toBe(1)
      callbackReleased.release()
      await siblingSettled
      expect(sockets.every((socket) => socket.readyState === 3)).toBe(true)
      await expect(
        executor.query({
          operation: "public_read",
          relayUrls: [B],
          filters: [{ kinds: [0] }],
        })
      ).resolves.toMatchObject({ status: "success" })
    } finally {
      callbackReleased.release()
      executor.dispose()
      await siblingSettled
    }
  })
}
