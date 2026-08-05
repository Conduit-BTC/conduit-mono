import { describe, expect, it, mock } from "bun:test"

import {
  finalizeCommittedWalletMutation,
  LatestWalletReloadCoordinator,
  reconcileWalletSynchronizationError,
  WALLET_STORAGE_INITIALIZATION_ERROR,
  WALLET_STORAGE_SYNCHRONIZATION_ERROR,
  WalletInitializationCoordinator,
} from "../apps/market/src/lib/wallet-initialization"

describe("WalletInitializationCoordinator", () => {
  it("deduplicates concurrent initialization across hook consumers", async () => {
    let finish: (() => void) | null = null
    const operation = mock(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const coordinator = new WalletInitializationCoordinator()

    const first = coordinator.run(operation)
    const second = coordinator.run(operation)
    expect(operation).toHaveBeenCalledTimes(1)
    finish?.()
    await Promise.all([first, second])
  })

  it("surfaces a failure and permits an explicit retry", async () => {
    const operation = mock()
      .mockRejectedValueOnce(new Error("migration failed"))
      .mockResolvedValueOnce(undefined)
    const coordinator = new WalletInitializationCoordinator()

    await expect(coordinator.run(operation)).rejects.toThrow("migration failed")
    await expect(coordinator.run(operation)).resolves.toBeUndefined()
    expect(operation).toHaveBeenCalledTimes(2)
  })
})

describe("LatestWalletReloadCoordinator", () => {
  it("keeps a superseded reload pending until the latest reload commits", async () => {
    const oldLoad = deferred<string>()
    const newLoad = deferred<string>()
    const committed: string[] = []
    const coordinator = new LatestWalletReloadCoordinator()
    const reload = async (load: () => Promise<string>) => {
      const result = await coordinator.run(load, (value) =>
        committed.push(value)
      )
      await coordinator.waitForLatest()
      return result
    }

    const oldRun = reload(() => oldLoad.promise)
    const newRun = reload(() => newLoad.promise)

    oldLoad.resolve("stale registry/default/labels")
    await Promise.resolve()

    expect(await isSettled(oldRun)).toBe(false)
    expect(committed).toEqual([])

    newLoad.resolve("new registry/default/labels")
    await expect(newRun).resolves.toBe("committed")
    await expect(oldRun).resolves.toBe("superseded")
    expect(committed).toEqual(["new registry/default/labels"])
  })

  it("surfaces the latest failure to every reload waiting on it", async () => {
    const oldLoad = deferred<string>()
    const newLoad = deferred<string>()
    const coordinator = new LatestWalletReloadCoordinator()
    const reload = async (load: () => Promise<string>) => {
      const result = await coordinator.run(load, () => undefined)
      await coordinator.waitForLatest()
      return result
    }

    const oldRun = reload(() => oldLoad.promise)
    const newRun = reload(() => newLoad.promise)
    oldLoad.reject(new Error("stale read failed"))
    await Promise.resolve()

    expect(await isSettled(oldRun)).toBe(false)

    newLoad.reject(new Error("current read failed"))
    const outcomes = await Promise.allSettled([oldRun, newRun])

    expect(outcomes).toEqual([
      { status: "rejected", reason: new Error("current read failed") },
      { status: "rejected", reason: new Error("current read failed") },
    ])
  })
})

describe("finalizeCommittedWalletMutation", () => {
  it("broadcasts before refresh and contains a post-commit refresh failure", async () => {
    const refresh = deferred<void>()
    const events: string[] = []

    const completion = finalizeCommittedWalletMutation({
      notifyChanged() {
        events.push("notified")
      },
      reload() {
        events.push("reload-started")
        return refresh.promise
      },
    })

    expect(events).toEqual(["notified", "reload-started"])
    refresh.reject(new Error("post-commit reload failed"))
    await expect(completion).resolves.toBe("refresh_failed")
  })

  it("reports a successful post-commit refresh", async () => {
    await expect(
      finalizeCommittedWalletMutation({
        notifyChanged() {},
        async reload() {},
      })
    ).resolves.toBe("refreshed")
  })
})

describe("reconcileWalletSynchronizationError", () => {
  it("clears only a recovered synchronization failure", () => {
    expect(
      reconcileWalletSynchronizationError(
        WALLET_STORAGE_SYNCHRONIZATION_ERROR,
        "succeeded"
      )
    ).toBeNull()
    expect(
      reconcileWalletSynchronizationError(
        WALLET_STORAGE_INITIALIZATION_ERROR,
        "succeeded"
      )
    ).toBe(WALLET_STORAGE_INITIALIZATION_ERROR)
  })

  it("does not hide an initialization failure behind a channel failure", () => {
    expect(reconcileWalletSynchronizationError(null, "failed")).toBe(
      WALLET_STORAGE_SYNCHRONIZATION_ERROR
    )
    expect(
      reconcileWalletSynchronizationError(
        WALLET_STORAGE_INITIALIZATION_ERROR,
        "failed"
      )
    ).toBe(WALLET_STORAGE_INITIALIZATION_ERROR)
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending")
  return (
    (await Promise.race([
      promise.then(() => true),
      Promise.resolve(pending),
    ])) !== pending
  )
}
