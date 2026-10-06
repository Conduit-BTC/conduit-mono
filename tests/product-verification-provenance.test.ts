import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { schnorr } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { hexToBytes } from "../packages/core/node_modules/@noble/curves/utils.js"
import { finalizeEvent, getEventHash } from "nostr-tools"

import {
  __resetPublicReaderTestState,
  __setPublicReaderVerifyTimeoutMsForTests,
  fetchSignedEventsFanoutDetailed,
  isValidSignedPublicNostrEvent,
  parseProductEvent,
  productSchema,
  verifySignedEvents,
} from "@conduit/core"

const originalWorker = globalThis.Worker
const originalWebSocket = globalThis.WebSocket
beforeEach(__resetPublicReaderTestState)
afterEach(() => {
  __resetPublicReaderTestState()
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: originalWorker,
  })
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  })
})

function signedProduct() {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: 123,
      content: "A signed listing",
      tags: [
        ["d", "worker-product"],
        ["title", "Worker product"],
        ["price", "100", "SATS"],
        ["image", "https://example.com/product.png"],
      ],
    },
    Uint8Array.from([...new Uint8Array(31), 1])
  )
}

describe("product verification provenance", () => {
  for (const verdicts of [[], [true, true], ["true"]]) {
    it(`rejects a malformed worker verdict vector ${JSON.stringify(verdicts)}`, async () => {
      const event = signedProduct()
      class MalformedWorker {
        onmessage: ((event: MessageEvent) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        postMessage(message: { reqId: number }): void {
          queueMicrotask(() =>
            this.onmessage?.({
              data: { reqId: message.reqId, valid: verdicts },
            } as MessageEvent)
          )
        }
        terminate(): void {}
      }
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        writable: true,
        value: MalformedWorker,
      })
      await expect(verifySignedEvents([event])).rejects.toThrow("worker failed")
    })
  }

  it("starts each execution deadline only when its batch is posted", async () => {
    const firstEvent = signedProduct()
    const secondEvent = finalizeEvent(
      { ...firstEvent, created_at: 124 },
      Uint8Array.from([...new Uint8Array(31), 1])
    )
    const posted: Array<{ reqId: number; items: (typeof firstEvent)[] }> = []
    const worker: { current?: HoldingWorker } = {}
    let terminations = 0
    class HoldingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      constructor() {
        worker.current = this
      }
      postMessage(message: (typeof posted)[number]): void {
        posted.push(message)
      }
      terminate(): void {
        terminations++
      }
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: HoldingWorker,
    })
    // The first posted batch retains its longer execution deadline. The next
    // batch must survive in the queue longer than its own execution budget.
    __setPublicReaderVerifyTimeoutMsForTests(1_000)
    const first = verifySignedEvents([firstEvent])
    __setPublicReaderVerifyTimeoutMsForTests(10)
    const second = verifySignedEvents([secondEvent])
    const completion = Promise.all([first, second])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(posted).toHaveLength(1)
    expect(terminations).toBe(0)
    worker.current!.onmessage?.({
      data: { reqId: posted[0]!.reqId, valid: [true] },
    } as MessageEvent)
    expect(posted).toHaveLength(2)
    worker.current!.onmessage?.({
      data: { reqId: posted[1]!.reqId, valid: [true] },
    } as MessageEvent)
    expect((await completion).map((result) => result.events[0]?.id)).toEqual([
      firstEvent.id,
      secondEvent.id,
    ])
    expect(terminations).toBe(0)
  })

  it("bounds queued worker memory without starting browser-thread verification", async () => {
    const event = signedProduct()
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
    let posts = 0
    class HoldingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      postMessage(): void {
        posts++
      }
      terminate(): void {}
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: HoldingWorker,
    })
    const controller = new AbortController()
    const verify = spyOn(schnorr, "verify")
    const pending = Array.from({ length: 128 }, () =>
      verifySignedEvents([event], { signal: controller.signal })
    )
    const completion = Promise.allSettled(pending)
    try {
      await expect(verifySignedEvents([event])).rejects.toThrow("queue is full")
      expect(posts).toBe(1)
      expect(verify).not.toHaveBeenCalled()
    } finally {
      controller.abort()
      await completion
      verify.mockRestore()
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("rejects a worker reply for a queued batch that was never posted", async () => {
    const valid = signedProduct()
    const invalid = { ...valid, sig: "0".repeat(128) }
    let firstRequestId = 0
    const worker: { current?: HoldingWorker } = {}
    class HoldingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      constructor() {
        worker.current = this
      }
      postMessage(message: { reqId: number }): void {
        firstRequestId = message.reqId
      }
      terminate(): void {}
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: HoldingWorker,
    })
    const first = verifySignedEvents([valid])
    const queued = verifySignedEvents([invalid])
    const completion = Promise.allSettled([first, queued])
    worker.current!.onmessage?.({
      data: { reqId: firstRequestId + 1, valid: [true] },
    } as MessageEvent)
    expect((await completion).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ])
    expect(isValidSignedPublicNostrEvent(invalid)).toBe(false)
  })

  it("does not perform browser-thread crypto when a worker is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
    const event = signedProduct()
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    })
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: undefined,
    })
    const verify = spyOn(schnorr, "verify")
    try {
      await expect(verifySignedEvents([event])).rejects.toThrow(
        "worker is unavailable"
      )
      expect(verify).not.toHaveBeenCalled()
    } finally {
      verify.mockRestore()
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("reuses admitted signed bytes through the parser and schema without Schnorr on the consumer", async () => {
    const event = signedProduct()
    class VerifyingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      postMessage(message: { reqId: number; items: (typeof event)[] }): void {
        const valid = message.items.map(
          (item) =>
            getEventHash(item) === item.id &&
            schnorr.verify(
              hexToBytes(item.sig),
              hexToBytes(item.id),
              hexToBytes(item.pubkey)
            )
        )
        queueMicrotask(() =>
          this.onmessage?.({
            data: { reqId: message.reqId, valid },
          } as MessageEvent)
        )
      }
      terminate(): void {}
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: VerifyingWorker,
    })
    const admitted = (await verifySignedEvents([event])).events[0]
    expect(admitted).toBeDefined()

    const verify = spyOn(schnorr, "verify")
    try {
      const product = parseProductEvent(admitted)
      expect(product.signedProductEvent?.id).toBe(event.id)
      expect(productSchema.safeParse(structuredClone(product)).success).toBe(
        false
      )
      expect(verify).not.toHaveBeenCalled()
      for (const changed of [
        { ...event, content: "tampered" },
        { ...event, sig: "0".repeat(128) },
        { ...event, pubkey: "0".repeat(64) },
        { ...event, created_at: 124 },
        { ...event, kind: 1 },
        { ...event, tags: [["d", "different-coordinate"]] },
      ]) {
        expect(isValidSignedPublicNostrEvent(changed)).toBe(false)
        expect(
          productSchema.safeParse({ ...product, signedProductEvent: changed })
            .success
        ).toBe(false)
      }
    } finally {
      verify.mockRestore()
    }
  })

  it("preserves signed snapshots while rejecting caller mutations during admission", async () => {
    const cached = signedProduct()
    expect(isValidSignedPublicNostrEvent(cached)).toBe(true)
    const fresh = finalizeEvent(
      { ...cached, tags: [["d", "different"]] },
      Uint8Array.from([...new Uint8Array(31), 1])
    )
    let release!: () => void
    class HoldingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      postMessage(message: { reqId: number; items: (typeof cached)[] }): void {
        release = () =>
          this.onmessage?.({
            data: {
              reqId: message.reqId,
              valid: message.items.map(
                (item) =>
                  getEventHash(item) === item.id &&
                  schnorr.verify(
                    hexToBytes(item.sig),
                    hexToBytes(item.id),
                    hexToBytes(item.pubkey)
                  )
              ),
            },
          } as MessageEvent)
      }
      terminate(): void {}
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: HoldingWorker,
    })
    const admission = verifySignedEvents([cached, fresh])
    cached.content = "changed while waiting"
    release()
    const admitted = (await admission).events
    expect(admitted.map((event) => event.id)).toEqual([cached.id, fresh.id])
    expect(admitted[0]?.content).toBe("A signed listing")
    expect(admitted[0]).not.toBe(cached)
    expect(isValidSignedPublicNostrEvent(cached)).toBe(false)
  })

  it("retains admitted object provenance when the bounded lookup cache evicts its event", async () => {
    const event = signedProduct()
    class VerifyingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      postMessage(message: { reqId: number; items: (typeof event)[] }): void {
        const valid = message.items.map(
          (item) =>
            getEventHash(item) === item.id &&
            schnorr.verify(
              hexToBytes(item.sig),
              hexToBytes(item.id),
              hexToBytes(item.pubkey)
            )
        )
        queueMicrotask(() =>
          this.onmessage?.({
            data: { reqId: message.reqId, valid },
          } as MessageEvent)
        )
      }
      terminate(): void {}
    }
    class RelaySocket {
      static OPEN = 1
      readyState = 0
      onopen: (() => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor() {
        queueMicrotask(() => {
          this.readyState = 1
          this.onopen?.()
        })
      }
      send(payload: string): void {
        const [kind, id] = JSON.parse(payload)
        if (kind !== "REQ") return
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify(["EVENT", id, event]),
          } as MessageEvent)
          this.onmessage?.({
            data: JSON.stringify(["EOSE", id]),
          } as MessageEvent)
        })
      }
      close(): void {
        this.readyState = 3
        this.onclose?.()
      }
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: VerifyingWorker,
    })
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: RelaySocket,
    })
    const admitted = await fetchSignedEventsFanoutDetailed(
      { kinds: [30402] },
      {
        relayUrls: ["wss://provenance.example"],
        reuseRelayConnections: false,
        connectTimeoutMs: 100,
        fetchTimeoutMs: 100,
      }
    )
    expect(admitted.events).toHaveLength(1)
    for (let index = 0; index < 24; index++) {
      const filler = finalizeEvent(
        {
          kind: 0,
          created_at: 123 + index,
          tags: [],
          content: "x".repeat(400_000),
        },
        Uint8Array.from([...new Uint8Array(31), 1])
      )
      expect((await verifySignedEvents([filler])).events).toHaveLength(1)
    }
    const verify = spyOn(schnorr, "verify")
    try {
      const parsed = parseProductEvent(admitted.events[0])
      expect(parsed.signedProductEvent?.id).toBe(event.id)
      expect(productSchema.safeParse(parsed).success).toBe(true)
      expect(verify).not.toHaveBeenCalled()
    } finally {
      verify.mockRestore()
    }
  }, 20_000)
})
