import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { schnorr } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { hexToBytes } from "../packages/core/node_modules/@noble/curves/utils.js"
import { finalizeEvent, getEventHash } from "nostr-tools"

import {
  __resetPublicReaderTestState,
  fetchSignedEventsFanoutDetailed,
  isValidSignedPublicNostrEvent,
  parseProductEvent,
  productSchema,
  verifySignedEvents,
} from "@conduit/core"

const originalWorker = globalThis.Worker
const originalWebSocket = globalThis.WebSocket
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
  it("rejects a worker reply for a queued batch that was never posted", async () => {
    const valid = signedProduct()
    const invalid = { ...valid, sig: "0".repeat(128) }
    let firstRequestId = 0
    let worker!: HoldingWorker
    class HoldingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      constructor() {
        worker = this
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
    worker.onmessage?.({
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
    expect((await verifySignedEvents([event])).events).toHaveLength(
      1
    )

    const verify = spyOn(schnorr, "verify")
    try {
      const product = parseProductEvent(event)
      expect(product.signedProductEvent?.id).toBe(event.id)
      expect(productSchema.safeParse(structuredClone(product)).success).toBe(
        true
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

  it("rejects cached bytes mutated while another event is awaiting admission", async () => {
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
    expect((await admission).events.map((event) => event.id)).toEqual([
      fresh.id,
    ])
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
      expect(
        (await verifySignedEvents([filler])).events
      ).toHaveLength(1)
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
  })
})
