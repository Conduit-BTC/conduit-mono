import { describe, expect, it } from "bun:test"

import {
  ensureSparkPrivateModeReady,
  type SparkPrivateModeReadinessInput,
} from "@conduit/core"

function readinessInput(
  overrides: Partial<SparkPrivateModeReadinessInput> = {}
): SparkPrivateModeReadinessInput {
  let now = 0
  return {
    wallet: {
      async setPrivacyEnabled() {
        return undefined
      },
      async getWalletSettings() {
        return { privateEnabled: true }
      },
      async getSparkAddress() {
        return "spark-address"
      },
    },
    createPublicReader: () => ({
      async getAvailableBalance() {
        return 0n
      },
      async getOwnedBalance() {
        return 0n
      },
      async getTransfers() {
        return { transfers: [] }
      },
    }),
    convergenceTimeoutMs: 1_000,
    readTimeoutMs: 100,
    observationIntervalMs: 100,
    requiredConsecutiveObservations: 3,
    readWithTimeout: async (read) => read,
    wait: async (milliseconds) => {
      now += milliseconds
    },
    now: () => now,
    ...overrides,
  }
}

describe("Spark private-mode readiness", () => {
  it("does not start public reads when the private setting cannot be confirmed", async () => {
    let publicReaderCreated = false
    let addressRead = false
    const input = readinessInput({
      wallet: {
        async setPrivacyEnabled() {
          return { privateEnabled: true }
        },
        async getWalletSettings() {
          return { privateEnabled: false }
        },
        async getSparkAddress() {
          addressRead = true
          return "spark-address"
        },
      },
      createPublicReader: () => {
        publicReaderCreated = true
        throw new Error("should not read")
      },
    })

    await expect(ensureSparkPrivateModeReady(input)).rejects.toThrow(
      "Spark private mode could not be verified."
    )
    expect(addressRead).toBe(false)
    expect(publicReaderCreated).toBe(false)
  })

  it("requires consecutive hidden reads after a visible observation", async () => {
    const available = [0n, 0n, 12n, 0n, 0n, 0n]
    let observation = 0
    const waits: number[] = []
    const input = readinessInput({
      createPublicReader: () => ({
        async getAvailableBalance() {
          const value = available[observation] ?? 0n
          observation += 1
          return value
        },
        async getOwnedBalance() {
          return 0n
        },
        async getTransfers() {
          return { transfers: [] }
        },
      }),
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
      now: () => 0,
    })

    await ensureSparkPrivateModeReady(input)

    expect(observation).toBe(6)
    expect(waits).toEqual([100, 100, 100, 100, 100])
  })

  it("fails closed when every public observation is unavailable", async () => {
    let now = 0
    let reads = 0
    const input = readinessInput({
      convergenceTimeoutMs: 300,
      readWithTimeout: async () => {
        reads += 1
        throw new Error("read unavailable")
      },
      wait: async (milliseconds) => {
        now += milliseconds
      },
      now: () => now,
    })

    await expect(ensureSparkPrivateModeReady(input)).rejects.toThrow(
      "Spark private mode could not be confirmed before the readiness deadline."
    )
    expect(reads).toBe(9)
  })
})
