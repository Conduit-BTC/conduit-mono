import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { schnorr } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { hexToBytes } from "../packages/core/node_modules/@noble/curves/utils.js"
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools/pure"
import { __resetPublicReaderTestState } from "../packages/core/src/protocol/relay-reader"
import { parseProductEvent } from "../packages/core/src/protocol/products"
import { parseProductSupplierAllocationTags } from "../packages/core/src/protocol/product-supplier-allocation"
import * as signedEvents from "../packages/core/src/protocol/signed-event"
import {
  admitPublicEvent,
  isVerifiedNostrEvent,
} from "../packages/core/src/protocol/verified-public-event"

const originalWorker = globalThis.Worker
beforeEach(__resetPublicReaderTestState)
afterEach(() => {
  __resetPublicReaderTestState()
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: originalWorker,
  })
})

describe("supplier allocation public admission ownership", () => {
  for (const marked of [false, true]) {
    it(`reuses exact public proof for ${marked ? "marked" : "unmarked"} listings while independently checking clones`, async () => {
      const secret = generateSecretKey()
      const merchant = getPublicKey(secret)
      const supplier = getPublicKey(generateSecretKey())
      const raw = finalizeEvent(
        {
          kind: 30402,
          created_at: 1_800_000_000,
          content: "Synthetic supplier admission fixture",
          tags: [
            ["d", "supplier-admission"],
            ["title", "Supplier admission"],
            ["price", "1000", "SAT"],
            ["type", "simple", "digital"],
            ...(marked
              ? [
                  ["conduit_supplier_allocation", "1"],
                  ["zap", merchant, "wss://relay.conduit.market", "3"],
                  ["zap", supplier, "wss://relay.conduit.market", "1"],
                ]
              : []),
          ],
        },
        secret
      )
      // Genuine worker-side cryptography establishes admission without warming
      // the separate synchronous private-signature cache.
      class VerifyingWorker {
        onmessage: ((event: MessageEvent) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        postMessage(message: { reqId: number; items: (typeof raw)[] }): void {
          const valid = message.items.map(
            (event) =>
              getEventHash(event) === event.id &&
              schnorr.verify(
                hexToBytes(event.sig),
                hexToBytes(event.id),
                hexToBytes(event.pubkey)
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
      const result = await admitPublicEvent(raw)
      if (result.status !== "verified") throw new Error("Fixture not admitted")
      const admitted = result.event
      const privateVerification = spyOn(
        signedEvents,
        "isValidSignedPublicNostrEvent"
      )
      const signatureVerification = spyOn(schnorr, "verify")
      try {
        const product = parseProductEvent(admitted)
        expect(product.signedProductEvent).toBe(admitted)
        expect(product.supplierAllocation?.revisionEventId).toBe(admitted.id)
        expect(product.supplierAllocation?.state).toBe(
          marked ? "valid" : "absent"
        )
        expect(privateVerification).not.toHaveBeenCalled()
        expect(signatureVerification).not.toHaveBeenCalled()

        const clone = structuredClone(admitted)
        expect(isVerifiedNostrEvent(clone)).toBe(false)
        const allocation = parseProductSupplierAllocationTags({
          merchantPubkey: merchant,
          tags: clone.tags,
          signedRevisionEvent: clone,
        })
        expect(allocation.revisionEventId).toBe(admitted.id)
        expect(privateVerification).toHaveBeenCalledTimes(1)
        expect(signatureVerification).toHaveBeenCalledTimes(1)

        const changed = { ...clone, content: "Changed synthetic fields" }
        const invalid = parseProductSupplierAllocationTags({
          merchantPubkey: merchant,
          tags: changed.tags,
          signedRevisionEvent: changed,
        })
        expect(invalid.revisionEvent).toBeUndefined()
        expect(privateVerification).toHaveBeenCalledTimes(2)
        expect(isVerifiedNostrEvent(changed)).toBe(false)
      } finally {
        signatureVerification.mockRestore()
        privateVerification.mockRestore()
      }
    })
  }
})
