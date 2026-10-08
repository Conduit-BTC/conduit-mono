import { afterEach, expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools/pure"
import {
  __resetPublicReaderTestState,
  attachEventSourceRelayUrl,
  closePublicRelayConnections,
  fetchPublicEventsWithDiagnostics,
  fetchPublicEventsProgressive,
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
  getMarketplaceProductsProgressive,
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
  sharedInboxDiscoveryRelayUrls,
} from "../packages/core/src/protocol/private-message-routing"
import { relayTargetsFromUrls } from "../packages/core/src/protocol/relay-authority"
import {
  __resetFollowListTestState,
  readLatestFollowLists,
} from "../packages/core/src/protocol/follows"
import { createInMemoryInboxDeclarationEvidenceRepository } from "../packages/core/src/protocol/inbox-declaration-evidence"
import { getRelayHealth } from "../packages/core/src/protocol/relay-health"
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
      if (this.readyState === 3) return
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

it("account grants authorize candidates without widening the requested read scope", async () => {
  install((socket, id) => socket.emit(["EOSE", id]))
  const accountOptions = {
    ...options(),
    accountPubkey: "a".repeat(64),
    relayTargets: relayTargetsFromUrls([A, B], {
      kind: "public_hint",
      operation: "read",
    }),
    accountNetworkLocalStateRepository: { get: async () => undefined },
  }
  const none = await fetchSignedEventsFanoutDetailed(
    { kinds: [0] },
    { ...accountOptions, relayUrls: [] }
  )
  expect(none.attemptedRelayUrls).toEqual([])
  expect(sockets).toHaveLength(0)
  const bounded = await fetchSignedEventsFanoutDetailed(
    { kinds: [0] },
    { ...accountOptions, relayUrls: [B] }
  )
  expect(bounded.attemptedRelayUrls).toEqual([B])
  expect(sockets.map((socket) => socket.url)).toEqual([B])
})

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
    const [sharedA, sharedB] = sharedInboxDiscoveryRelayUrls()
    expect(sharedA).toBeDefined()
    expect(sharedB).toBeDefined()
    let declaration = sign(220, 10002, [["r", sharedA!]])
    install((socket, id) => {
      if (socket.url === sharedA)
        for (let index = 0; index < 3; index++)
          socket.emit([
            "EVENT",
            id,
            {
              ...declaration,
              __conduitSourceRelayUrls: [sharedB],
              rawEvent: "hostile",
            },
          ])
      socket.emit(["EOSE", id])
    })
    const owner = await resolveOwnerRelayList(declaration.pubkey, {
      relayUrls: [sharedA!, sharedB!],
      evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
    })
    expect(owner.observation.coverage).toBe("complete")
    expect(owner.observation.eventSourceRelayUrls).toEqual([sharedA])
    expect(owner.current?.sourceRelayUrls).toEqual([sharedA])
    declaration = sign(230, 10050, [["relay", sharedA!]])
    const inbox = await resolveInboxDeclaration(declaration.pubkey, {
      relayUrls: [sharedA!, sharedB!],
      sharedConfirmationRelayUrls: [sharedA!, sharedB!],
      evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
    })
    // Three duplicate deliveries hit the kind-10050 limit on the observed
    // source; the empty sibling is complete but cannot confirm that event.
    expect(inbox.observation?.coverage).toBe("partial")
    expect(inbox.observation?.eventSourceRelayUrls).toEqual([sharedA])
    expect(inbox.sourceRelayUrls).toEqual([sharedA])
    expect(inbox.sharedSourceRelayUrls).toEqual([sharedA])
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

  for (const maxRelayAttempts of [undefined, 2]) {
    for (const retirement of ["caller", "scope"] as const) {
      it(`CON-06 ${retirement} retirement drains a started callback across sibling cancellation (attempts=${maxRelayAttempts ?? "all"})`, async () => {
        const entered = barrier()
        const released = barrier()
        const siblingStarted = barrier()
        install((socket, id) => {
          if (socket.url === A) socket.emit(["EOSE", id])
          else if (socket.url === B) siblingStarted.release()
        })
        const controller = new AbortController()
        const scope = { createWebSocket: (url: string) => new Socket(url) }
        let settled = false
        let callbackFinished = false
        const pending = read(
          { kinds: [0] },
          {
            ...options([A, B, C]),
            maxRelayAttempts,
            signal: controller.signal,
            socketScope: scope,
            reuseRelayConnections: true,
            onRelayProgress: async () => {
              entered.release()
              await released.promise
              callbackFinished = true
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
        try {
          await Promise.all([entered.promise, siblingStarted.promise])
          refreshPublicRelayConnectionsWhenIdle()
          if (retirement === "caller") controller.abort()
          else closePublicRelayConnections(scope)
          // Drain sibling cancellation and its promise reactions without
          // releasing the already-started callback.
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          expect(settled).toBe(false)
          expect(callbackFinished).toBe(false)
          expect(sockets.every((socket) => socket.readyState === 3)).toBe(
            retirement === "scope"
          )
          if (maxRelayAttempts !== undefined)
            expect(sockets.some((socket) => socket.url === C)).toBe(false)
        } finally {
          released.release()
          await pending
        }
        expect(callbackFinished).toBe(true)
        expect(await pending).toMatchObject({ name: "AbortError" })
        expect(sockets.every((socket) => socket.readyState === 3)).toBe(true)
      })
    }
  }

  it("CON-06 callback failure cancels sibling I/O, drains started callbacks and preserves the original error", async () => {
    const entered = barrier()
    const released = barrier()
    const failingSource = barrier()
    const idleSource = barrier()
    const failure = new Error("fixture progress failure")
    let failingSocket: Socket
    let failingId = ""
    install((socket, id) => {
      if (socket.url === A) socket.emit(["EOSE", id])
      else if (socket.url === B) {
        failingSocket = socket
        failingId = id
        failingSource.release()
      } else idleSource.release()
    })
    const scope = { createWebSocket: (url: string) => new Socket(url) }
    let settled = false
    let callbackFinished = false
    const pending = read(
      { kinds: [0] },
      {
        ...options([A, B, C]),
        socketScope: scope,
        reuseRelayConnections: true,
        onRelayProgress: async ({ relayUrl }) => {
          if (relayUrl === B) throw failure
          entered.release()
          await released.promise
          callbackFinished = true
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
    try {
      await Promise.all([
        entered.promise,
        failingSource.promise,
        idleSource.promise,
      ])
      refreshPublicRelayConnectionsWhenIdle()
      failingSocket!.emit(["EOSE", failingId])
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      expect(callbackFinished).toBe(false)
      expect(
        sockets
          .find((socket) => socket.url === C)
          ?.sent.some((frame) => frame[0] === "CLOSE")
      ).toBe(true)
      expect(sockets.every((socket) => socket.readyState === 1)).toBe(true)
    } finally {
      released.release()
      await pending
    }
    expect(callbackFinished).toBe(true)
    expect(await pending).toBe(failure)
    expect(sockets.every((socket) => socket.readyState === 3)).toBe(true)
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

if (!reference) {
  const note = sign(50, 1)
  for (const fixture of [
    {
      name: "disjoint bounded",
      filters: [
        { kinds: [0], limit: 1 },
        { kinds: [1], limit: 1 },
      ],
      payload: [first, second, note],
      expected: [first, note],
    },
    {
      name: "overlapping bounded",
      filters: [
        { kinds: [0], limit: 1 },
        { kinds: [0], limit: 1 },
      ],
      payload: [first, second],
      expected: [first],
    },
    {
      name: "bounded and unbounded",
      filters: [{ kinds: [0], limit: 1 }, { kinds: [1] }],
      payload: [first, second, note],
      expected: [first, note],
    },
    {
      name: "zero and bounded",
      filters: [
        { kinds: [0], limit: 0 },
        { kinds: [1], limit: 1 },
      ],
      payload: [first, note],
      expected: [note],
    },
    {
      name: "zero only",
      filters: [{ kinds: [0], limit: 0 }],
      payload: [first],
      expected: [],
    },
  ]) {
    it(`CON-03 selects each ${fixture.name} filter independently`, async () => {
      install((socket, id) => {
        for (const event of fixture.payload) socket.emit(["EVENT", id, event])
        socket.emit(["EOSE", id])
      })
      const result = await read(fixture.filters, options([A]))
      expect(result.events.map((event) => event.id)).toEqual(
        fixture.expected.map((event) => event.id)
      )
      expect(result.relays[0].eventCount).toBe(fixture.expected.length)
      expect(result.readCoverage).toBe("complete")
    })
  }

  it("CON-03 progressive catalog coverage counts signed revisions rather than delivery copies", async () => {
    const product = sign(Math.floor(Date.now() / 1000), 30402, [
      ["d", "progress-copies"],
      ["title", "Progress fixture"],
      ["price", "1", "SATS"],
      ["type", "simple", "physical"],
      ["image", "https://cdn.conduit.market/conduit-test/product.png"],
    ])
    install((socket, id) => {
      const req = socket.sent.find(
        (frame) => frame[0] === "REQ" && frame[1] === id
      )!
      const limit = (req[2] as { limit: number }).limit
      for (let i = 0; i < limit; i++) socket.emit(["EVENT", id, product])
      socket.emit(["EOSE", id])
    })
    const sourceCounts: number[] = []
    __setCommerceTestOverrides({
      getCachedProducts: async () => [],
      putCachedProducts: async () => {},
      getCachedProductTombstones: async () => [],
      putCachedProductTombstones: async () => {},
      fetchPublicEventsProgressive: async (filter, opts, progress) =>
        await fetchPublicEventsProgressive(
          filter,
          { ...opts, ...options([A]) },
          async (value) => {
            sourceCounts.push(value.events.length)
            await progress(value)
          }
        ),
    })
    const result = await getMarketplaceProductsProgressive(
      { limit: 1 },
      () => {}
    )
    expect(result.data).toHaveLength(1)
    expect(sourceCounts).toEqual([1])
    expect(result.meta).toMatchObject({ capped: false, degraded: false })
  })

  it("CON-03 executor reports selected duplicates once, including copies delivered after a full limit", async () => {
    install((socket, id) => {
      for (const event of [first, first, first])
        socket.emit(["EVENT", id, event])
      socket.emit(["EOSE", id])
    })
    const executor = new WebSocketCommerceRelayExecutor({
      createWebSocket: (url) => new Socket(url),
    })
    try {
      const result = await executor.query({
        operation: "public_read",
        filters: [{ kinds: [0], limit: 1 }],
        relayUrls: [A, B],
      })
      expect(result.events).toHaveLength(1)
      expect(
        result.relays.map(({ eventCount, duplicateCount }) => ({
          eventCount,
          duplicateCount,
        }))
      ).toEqual([
        { eventCount: 1, duplicateCount: 2 },
        { eventCount: 0, duplicateCount: 3 },
      ])
      expect(
        result.observations.filter((item) => item.type === "duplicate")
      ).toHaveLength(5)
    } finally {
      executor.dispose()
    }
  })

  for (const withEvent of [false, true]) {
    it(`CON-05 authority loss after EOSE revokes ${withEvent ? "verified" : "empty"} output before callbacks`, async () => {
      let current = true
      let callbacks = 0
      install((socket, id) => {
        if (withEvent) socket.emit(["EVENT", id, first])
        socket.emit(["EOSE", id])
        current = false
      })
      await expect(
        read(
          { kinds: [0] },
          {
            ...options([A]),
            shouldContinue: () => current,
            onProgress: () => {
              callbacks++
            },
          }
        )
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(callbacks).toBe(0)
    })
  }

  it("CON-05 revoked authority cannot return an empty plan as a successful call", async () => {
    await expect(
      read({ kinds: [0] }, { ...options([]), shouldContinue: () => false })
    ).rejects.toMatchObject({ code: "authority_changed" })
  })

  it("CON-08 revoked declaration read cannot persist owner evidence", async () => {
    const event = sign(500, 10002, [["r", A]])
    let current = true
    let writes = 0
    const repository = createInMemoryOwnerRelayListEvidenceRepository()
    install((socket, id) => {
      socket.emit(["EVENT", id, event])
      socket.emit(["EOSE", id])
      current = false
    })
    await expect(
      resolveOwnerRelayList(event.pubkey, {
        relayUrls: [A],
        shouldContinue: () => current,
        evidenceRepository: {
          get: repository.get,
          reconcile: async (input) => {
            writes++
            return await repository.reconcile(input)
          },
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(writes).toBe(0)
  })

  it("CON-05 connection callback errors preserve identity and avoid relay failure penalties", async () => {
    install((socket, id) => socket.emit(["EOSE", id]))
    const failure = new Error("connection observer failed")
    const before = getRelayHealth(A)
    await expect(
      read(
        { kinds: [0] },
        {
          ...options([A]),
          onConnection: () => {
            throw failure
          },
        }
      )
    ).rejects.toBe(failure)
    expect(getRelayHealth(A)).toEqual(before)
    expect(sockets[0].sent.some((frame) => frame[0] === "REQ")).toBe(false)
  })

  for (const retirement of ["scope", "global"] as const) {
    for (const reuseRelayConnections of [false, true]) {
      it(`CON-06 ${retirement} retirement closes ${reuseRelayConnections ? "pooled" : "private"} sockets while callbacks drain`, async () => {
        install((socket, id) => socket.emit(["EOSE", id]))
        const entered = barrier(),
          released = barrier()
        const scope = { createWebSocket: (url: string) => new Socket(url) }
        let settled = false
        const pending = read(
          { kinds: [0] },
          {
            ...options([A]),
            socketScope: scope,
            reuseRelayConnections,
            onRelayProgress: async () => {
              entered.release()
              await released.promise
            },
          }
        )
          .then(
            () => null,
            (error: unknown) => error
          )
          .finally(() => {
            settled = true
          })
        await entered.promise
        try {
          closePublicRelayConnections(
            retirement === "scope" ? scope : undefined
          )
          expect(sockets.every((socket) => socket.readyState === 3)).toBe(true)
          expect(settled).toBe(false)
        } finally {
          released.release()
        }
        expect(await pending).toMatchObject({ name: "AbortError" })
      })

      it(`CON-06 socket factory cannot register after ${retirement} retirement with reuse=${reuseRelayConnections}`, async () => {
        install(() => {})
        const scope = {
          createWebSocket: (url: string) => {
            const socket = new Socket(url)
            closePublicRelayConnections(
              retirement === "scope" ? scope : undefined
            )
            return socket
          },
        }
        await expect(
          read(
            { kinds: [0] },
            { ...options([A]), socketScope: scope, reuseRelayConnections }
          )
        ).rejects.toMatchObject({ name: "AbortError" })
        expect(sockets.every((socket) => socket.readyState === 3)).toBe(true)
        expect(
          sockets
            .flatMap((socket) => socket.sent)
            .some((frame) => frame[0] === "REQ")
        ).toBe(false)
      })
    }
  }

  for (const phase of ["planning", "admission"] as const) {
    it(`CON-06 retirement abandons blocked ${phase} policy reads and permits sibling work`, async () => {
      install((socket, id) => socket.emit(["EOSE", id]))
      const entered = barrier(),
        released = barrier()
      let gets = 0
      const urls = Array.from(
        { length: 8 },
        (_, i) => `wss://policy-${i}.example`
      )
      const scope = { createWebSocket: (url: string) => new Socket(url) }
      const pending = read(
        { kinds: [0] },
        {
          ...options(urls),
          relayTargets: relayTargetsFromUrls(urls, {
            kind: "public_hint",
            operation: "read",
          }),
          socketScope: scope,
          accountPubkey: first.pubkey,
          accountNetworkLocalStateRepository: {
            get: async () => {
              gets++
              if (phase === "admission" && gets === 1) return undefined
              if (gets === (phase === "planning" ? 1 : 9)) entered.release()
              await released.promise
              return undefined
            },
          },
        }
      ).then(
        () => null,
        (error: unknown) => error
      )
      await entered.promise
      try {
        closePublicRelayConnections(scope)
        const result = await Promise.race([
          pending,
          new Promise((resolve) =>
            setTimeout(
              () => resolve("policy still owns retired operation"),
              100
            )
          ),
        ])
        expect(result).toMatchObject({ name: "AbortError" })
        expect((await read({ kinds: [0] }, options([B]))).readCoverage).toBe(
          "complete"
        )
        expect(sockets.every((socket) => socket.url === B)).toBe(true)
      } finally {
        released.release()
        await pending
      }
      await Promise.resolve()
      expect(sockets.every((socket) => socket.url === B)).toBe(true)
    })
  }
}

it("CON-03 multi-filter comparison keeps main truncation separate from fixture selection truth", async () => {
  const Executor: typeof WebSocketCommerceRelayExecutor = referenceRoot
    ? (
        await import(
          `${referenceRoot}/packages/core/src/protocol/relay-executor.ts`
        )
      ).WebSocketCommerceRelayExecutor
    : WebSocketCommerceRelayExecutor
  const note = sign(50, 1)
  install((socket, id) => {
    for (const event of [first, second, note]) socket.emit(["EVENT", id, event])
    socket.emit(["EOSE", id])
  })
  const executor = new Executor({ createWebSocket: (url) => new Socket(url) })
  try {
    const result = await executor.query({
      relayUrls: [A],
      operation: "public_read",
      filters: [
        { kinds: [0], limit: 1 },
        { kinds: [1], limit: 1 },
      ],
    })
    expect(result.events.map((event) => event.id)).toEqual(
      reference ? [first.id, second.id] : [first.id, note.id]
    )
    expect(result.status).toBe(reference ? "partial" : "success")
    expect(result.relays[0].failure).toBe(
      reference ? "protocol_limit_exceeded" : undefined
    )
  } finally {
    executor.dispose()
  }
})
