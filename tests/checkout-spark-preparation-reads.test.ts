import { describe, expect, it } from "bun:test"
import { mapCheckoutSparkPreparationReads } from "../packages/core/src/protocol/checkout-spark-preparation-reads"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("checkout Spark bounded preparation reads", () => {
  it.each(["failure", "revoked"])(
    "stops queued reads and drains all admitted reads after %s",
    async (reason) => {
      const held = Array.from({ length: 8 }, () => deferred<number>())
      const calls: number[] = []
      let active = true
      let settled = false
      let failure: unknown
      const providerError = new Error("Synthetic read unavailable")
      const operation = mapCheckoutSparkPreparationReads(
        held,
        () => {
          if (!active) throw new Error("Preparation revoked")
        },
        async (gate) => {
          calls.push(held.indexOf(gate))
          return gate.promise
        }
      ).then(
        () => {
          settled = true
        },
        (error: unknown) => {
          failure = error
          settled = true
        }
      )
      expect(calls).toEqual([0, 1, 2, 3])
      if (reason === "revoked") {
        active = false
        held[0]!.resolve(0)
      } else held[0]!.reject(providerError)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(calls).toEqual([0, 1, 2, 3])
      held[1]!.resolve(1)
      held[2]!.reject(new Error("Synthetic later failure"))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      held[3]!.resolve(3)
      await operation
      expect(failure).toEqual(
        reason === "failure" ? providerError : new Error("Preparation revoked")
      )
      expect(calls).toEqual([0, 1, 2, 3])
    }
  )

  it("preserves input order when independent reads finish in reverse order", async () => {
    const held = Array.from({ length: 4 }, () => deferred<number>())
    const operation = mapCheckoutSparkPreparationReads(
      held,
      () => {},
      (gate) => gate.promise
    )
    for (const index of [3, 2, 1, 0]) held[index]!.resolve(index)
    expect(await operation).toEqual([0, 1, 2, 3])
  })

  it("admits no read when authority was already revoked", async () => {
    let calls = 0
    await expect(
      mapCheckoutSparkPreparationReads(
        [1],
        () => {
          throw new Error("Preparation revoked")
        },
        async () => {
          calls++
          return 1
        }
      )
    ).rejects.toThrow("Preparation revoked")
    expect(calls).toBe(0)
  })
})
