import { describe, expect, it } from "bun:test"
import { NWCWalletService } from "@getalby/sdk/nwc"

import { trackNwcServiceWork } from "../e2e/helpers/deterministic-nwc-wallet"

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("NWC fixture shutdown", () => {
  it("waits for a callback and the later publication acknowledgement", async () => {
    const service = new NWCWalletService({ relayUrls: ["ws://127.0.0.1:1"] })
    const request = deferred()
    const acknowledgement = deferred()
    const publicationStarted = deferred()
    let onEvent!: NonNullable<
      Parameters<typeof service.pool.subscribe>[2]["onevent"]
    >
    service.pool.subscribe = (_relays, _filter, params) => {
      onEvent = params.onevent!
      return { close() {} }
    }
    service.pool.publish = () => {
      publicationStarted.resolve()
      return [acknowledgement.promise.then(() => "accepted")]
    }
    const drain = trackNwcServiceWork(service)
    const event = {} as Parameters<typeof service.pool.publish>[1]
    service.pool.subscribe(
      [],
      {},
      {
        onevent: async () => {
          await request.promise
          // The SDK does not await its response publication.
          void Promise.any(service.pool.publish([], event))
        },
      }
    )
    onEvent(event)
    let drained = false
    const closing = drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    request.resolve()
    await publicationStarted.promise
    expect(drained).toBe(false)
    acknowledgement.resolve()
    await closing
    expect(drained).toBe(true)
  })

  it("preserves publication rejection and fails shutdown without retaining its contents", async () => {
    const service = new NWCWalletService({ relayUrls: ["ws://127.0.0.1:1"] })
    const acknowledgement = deferred()
    const publication = acknowledgement.promise.then(() => "accepted")
    service.pool.publish = () => [publication]
    const drain = trackNwcServiceWork(service)
    const returned = service.pool.publish(
      [],
      {} as Parameters<typeof service.pool.publish>[1]
    )
    expect(returned[0]).toBe(publication)
    const observed = Promise.allSettled(returned)
    acknowledgement.reject(new Error("private response must not escape"))
    await observed
    await expect(drain()).rejects.toThrow(
      "Deterministic NWC operation failed at wallet_close."
    )
  })
})
