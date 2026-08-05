import { describe, expect, it } from "bun:test"

import {
  SparkWalletSessionLeaseUnavailableError,
  acquireSparkWalletManagerSessionLease,
  acquireSparkWalletSessionLease,
  assertSparkWalletRegistrationSessionAvailable,
  runWithSparkWalletOperationLock,
  type SparkWalletOperationLockManager,
  type SparkWalletSessionLockManager,
} from "../apps/market/src/lib/spark-wallet-lease"

class MemoryLockManager implements SparkWalletSessionLockManager {
  readonly #held = new Set<string>()

  async request<T>(
    name: string,
    _options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T> {
    if (this.#held.has(name)) {
      return callback(null)
    }
    this.#held.add(name)
    try {
      return await callback({ name })
    } finally {
      this.#held.delete(name)
    }
  }
}

describe("Spark wallet session lease", () => {
  it("excludes the same wallet session while keeping other wallets isolated", async () => {
    const locks = new MemoryLockManager()
    const primary = await acquireSparkWalletSessionLease(
      "wallet-primary",
      locks
    )

    await expect(
      acquireSparkWalletSessionLease("wallet-primary", locks)
    ).rejects.toBeInstanceOf(SparkWalletSessionLeaseUnavailableError)

    const travel = await acquireSparkWalletSessionLease("wallet-travel", locks)
    await travel.release()
    await primary.release()

    const reopened = await acquireSparkWalletSessionLease(
      "wallet-primary",
      locks
    )
    await reopened.release()
  })

  it("fails closed in a browser when Web Locks is unavailable", async () => {
    await expect(
      acquireSparkWalletSessionLease("wallet-primary", null, true)
    ).rejects.toBeInstanceOf(SparkWalletSessionLeaseUnavailableError)
  })

  it("excludes duplicate wallet identities and protects active registrations", async () => {
    const locks = new MemoryLockManager()
    const primary = await acquireSparkWalletManagerSessionLease(
      "wallet-primary",
      "identity-a",
      locks
    )

    await expect(
      acquireSparkWalletManagerSessionLease("wallet-copy", "identity-a", locks)
    ).rejects.toBeInstanceOf(SparkWalletSessionLeaseUnavailableError)
    await expect(
      assertSparkWalletRegistrationSessionAvailable("wallet-primary", locks)
    ).rejects.toBeInstanceOf(SparkWalletSessionLeaseUnavailableError)

    const travel = await acquireSparkWalletManagerSessionLease(
      "wallet-travel",
      "identity-b",
      locks
    )
    await travel.release()
    await primary.release()

    await expect(
      assertSparkWalletRegistrationSessionAvailable("wallet-primary", locks)
    ).resolves.toBeUndefined()
  })

  it("serializes wallet operations without blocking a different wallet", async () => {
    const locks = new QueuedLockManager()
    const firstHold = deferred<void>()
    const firstStarted = deferred<void>()
    const calls: string[] = []

    const first = runWithSparkWalletOperationLock(
      "wallet-primary",
      async () => {
        calls.push("primary:first")
        firstStarted.resolve(undefined)
        await firstHold.promise
      },
      locks
    )
    await firstStarted.promise
    const second = runWithSparkWalletOperationLock(
      "wallet-primary",
      async () => {
        calls.push("primary:second")
      },
      locks
    )
    await runWithSparkWalletOperationLock(
      "wallet-travel",
      async () => {
        calls.push("travel")
      },
      locks
    )

    expect(calls).toEqual(["primary:first", "travel"])
    firstHold.resolve(undefined)
    await Promise.all([first, second])
    expect(calls).toEqual(["primary:first", "travel", "primary:second"])
  })

  it("releases the wallet operation lock after an error", async () => {
    const locks = new QueuedLockManager()

    await expect(
      runWithSparkWalletOperationLock(
        "wallet-primary",
        async () => {
          throw new Error("operation failed")
        },
        locks
      )
    ).rejects.toThrow("operation failed")
    await expect(
      runWithSparkWalletOperationLock(
        "wallet-primary",
        async () => "retried",
        locks
      )
    ).resolves.toBe("retried")
  })
})

class QueuedLockManager implements SparkWalletOperationLockManager {
  readonly #tails = new Map<string, Promise<void>>()

  async request<T>(
    name: string,
    _options: { mode: "exclusive" },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T> {
    const previous = this.#tails.get(name) ?? Promise.resolve()
    let release: () => void = () => undefined
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => hold)
    this.#tails.set(name, tail)
    await previous
    try {
      return await callback({ name })
    } finally {
      release()
      if (this.#tails.get(name) === tail) {
        this.#tails.delete(name)
      }
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}
