import {
  attachEventSourceRelayUrl,
  getEventSourceRelayUrls,
  verifySignedEventBatches,
  verifySignedEvents as admitObservedEvents,
} from "@conduit/core/protocol/relay-reader"
import { afterEach, describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools"
import {
  admitPublicEvent,
  isVerifiedNostrEvent,
  verifySignedEvents,
  __resetPublicEventVerificationForTests,
} from "../packages/core/src/protocol/verified-public-event"
import { parseProductEvent } from "../packages/core/src/protocol/products"
import { isValidSignedPublicNostrEvent } from "../packages/core/src/protocol/signed-event"

const secret = generateSecretKey()
const fixture = (content = 'Unicode 🛒\n"exact"') =>
  finalizeEvent(
    {
      kind: 30402,
      created_at: 123,
      tags: [
        ["d", "admission"],
        ["title", "Signed fixture"],
        ["price", "1", "SAT"],
      ],
      content,
    },
    secret
  )
afterEach(__resetPublicEventVerificationForTests)

describe("immutable public admission", () => {
  it("mints only frozen snapshots and rejects cloned or forged parser inputs", async () => {
    const raw = fixture()
    const result = await admitPublicEvent(raw)
    expect(result.status).toBe("verified")
    if (result.status !== "verified") throw new Error("admission failed")
    expect(isVerifiedNostrEvent(raw)).toBe(false)
    expect(isVerifiedNostrEvent(result.event)).toBe(true)
    expect(Object.isFrozen(result.event)).toBe(true)
    expect(Object.isFrozen(result.event.tags)).toBe(true)
    expect(result.event.tags.every(Object.isFrozen)).toBe(true)
    const clone = structuredClone(result.event)
    expect(isVerifiedNostrEvent(clone)).toBe(false)
    expect(() => parseProductEvent(clone)).toThrow("admitted")
    expect(
      isVerifiedNostrEvent({ ...raw, verified: true, eventsVerified: true })
    ).toBe(false)
    expect((await admitPublicEvent(clone)).status).toBe("verified")
  })

  it("binds every signed field, without ID-only positive or negative trust", async () => {
    const raw = fixture()
    for (const mutated of [
      { ...raw, id: "0".repeat(64) },
      { ...raw, sig: "0".repeat(128) },
      { ...raw, pubkey: "0".repeat(64) },
      { ...raw, created_at: 124 },
      { ...raw, kind: 1 },
      { ...raw, tags: [["d", "changed"]] },
      { ...raw, content: "changed" },
    ])
      expect((await admitPublicEvent(mutated)).status).toBe("invalid")
    expect((await admitPublicEvent(raw)).status).toBe("verified")
    expect(
      (await admitPublicEvent({ ...raw, content: "changed" })).status
    ).toBe("invalid")
  })

  it("reuses a signature verdict without granting public proof or accepting changed bytes", async () => {
    const raw = fixture()
    expect(isValidSignedPublicNostrEvent(raw)).toBe(true)
    expect(isValidSignedPublicNostrEvent(structuredClone(raw))).toBe(true)
    expect(isVerifiedNostrEvent(raw)).toBe(false)
    expect(() => parseProductEvent(raw as never)).toThrow("admitted")
    for (const mutated of [
      { ...raw, id: "0".repeat(64) },
      { ...raw, sig: "0".repeat(128) },
      { ...raw, pubkey: "0".repeat(64) },
      { ...raw, created_at: 124 },
      { ...raw, kind: 1 },
      { ...raw, tags: [["d", "changed"]] },
      { ...raw, content: "changed" },
    ])
      expect(isValidSignedPublicNostrEvent(mutated)).toBe(false)
    expect(isVerifiedNostrEvent(raw)).toBe(false)
    expect((await admitPublicEvent(raw)).status).toBe("verified")
  })

  it("snapshots a whole batch before yielding and keeps raw restoration untrusted", async () => {
    const raw = fixture()
    const promise = verifySignedEvents([raw])
    raw.tags[0][1] = "mutated after call"
    const result = await promise
    expect(result.events[0]?.tags[0][1]).toBe("admission")
    const stored = JSON.parse(JSON.stringify(result.events[0]))
    expect(isVerifiedNostrEvent(stored)).toBe(false)
    expect((await admitPublicEvent(stored)).status).toBe("verified")
  })

  it("reports cancellation distinctly and never treats it as invalid", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(
      await admitPublicEvent(fixture(), { signal: controller.signal })
    ).toEqual({ status: "cancelled" })
  })

  it.each([64, 512] as const)(
    "preserves order and exact source association across %i-event batches",
    async (batchSize) => {
      const first = fixture("first")
      const middle = fixture("middle")
      const last = fixture("last")
      const tampered = { ...first, content: "tampered" }
      attachEventSourceRelayUrl(first, "wss://first.example")
      attachEventSourceRelayUrl(last, "wss://last.example")
      attachEventSourceRelayUrl(tampered, "wss://forged.example")
      const initialBatch = [first, ...Array(batchSize - 1).fill(middle)]
      const events = await verifySignedEventBatches(
        [...initialBatch, tampered, last],
        { batchSize }
      )
      expect(events.map((event) => event.id)).toEqual(
        [...initialBatch, last].map((event) => event.id)
      )
      expect(events.every(isVerifiedNostrEvent)).toBe(true)
      expect(getEventSourceRelayUrls(events[0]!)).toEqual([
        "wss://first.example",
      ])
      expect(getEventSourceRelayUrls(events.at(-1)!)).toEqual([
        "wss://last.example",
      ])
      expect(isVerifiedNostrEvent(last)).toBe(false)
    }
  )

  it.each(["before", "during"] as const)(
    "throws a native AbortError when cancelled %s batched admission",
    async (when) => {
      const controller = new AbortController()
      if (when === "before") controller.abort()
      const raw = fixture()
      const pending = verifySignedEventBatches(Array(65).fill(raw), {
        signal: controller.signal,
        batchSize: 64,
      })
      if (when === "during") controller.abort()
      await expect(pending).rejects.toBeInstanceOf(DOMException)
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(isVerifiedNostrEvent(raw)).toBe(false)
    }
  )

  it("executes the real bundled worker with full envelopes", async () => {
    const build = await Bun.build({
      entrypoints: [
        new URL(
          "../packages/core/src/protocol/verify-worker.ts",
          import.meta.url
        ).pathname,
      ],
      target: "browser",
      minify: true,
    })
    expect(build.success).toBe(true)
    const path = `/tmp/conduit-verification-worker-${process.pid}.js`
    await Bun.write(path, build.outputs[0])
    const worker = new Worker(path, { type: "module" })
    try {
      const raw = fixture()
      const result = await new Promise<{ reqId: number; valid: boolean[] }>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("built worker timed out")),
            5000
          )
          worker.onmessage = (message) => {
            clearTimeout(timeout)
            resolve(message.data)
          }
          worker.onerror = (error) => {
            clearTimeout(timeout)
            reject(error)
          }
          worker.postMessage({
            reqId: 17,
            items: [
              raw,
              { ...raw, content: "tampered" },
              { ...raw, sig: "0".repeat(128) },
            ],
          })
        }
      )
      expect(result).toEqual({ reqId: 17, valid: [true, false, false] })
    } finally {
      worker.terminate()
    }
  })
})

it("preserves every exact duplicate source while rejecting forged-source bytes", async () => {
  const first = fixture()
  const second = structuredClone(first)
  const forged = { ...first, content: "tampered" }
  attachEventSourceRelayUrl(first, "wss://first.example")
  attachEventSourceRelayUrl(second, "wss://second.example")
  attachEventSourceRelayUrl(forged, "wss://forged.example")
  const result = await admitObservedEvents([first, second, forged])
  expect(result.events).toHaveLength(2)
  for (const event of result.events)
    expect(getEventSourceRelayUrls(event)).toEqual([
      "wss://first.example",
      "wss://second.example",
    ])
})

it("binds source observations before mutable wire inputs change", async () => {
  const raw = fixture()
  attachEventSourceRelayUrl(raw, "wss://original.example")
  const pending = admitObservedEvents([raw])
  raw.content = "changed during admission"
  attachEventSourceRelayUrl(raw, "wss://late.example")
  const result = await pending
  expect(result.events).toHaveLength(1)
  expect(getEventSourceRelayUrls(result.events[0]!)).toEqual([
    "wss://original.example",
  ])
})
