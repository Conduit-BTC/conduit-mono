import { describe, expect, it, mock } from "bun:test"
import type { WalletDescriptor } from "@conduit/core"

import {
  getRemovedWalletIdsForProvider,
  LatestWalletReloadCoordinator,
  reconcileWalletSynchronizationError,
  WALLET_STORAGE_INITIALIZATION_ERROR,
  WALLET_STORAGE_SYNCHRONIZATION_ERROR,
  WalletDescriptorSubscriptionCoordinator,
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

describe("WalletDescriptorSubscriptionCoordinator", () => {
  it("keeps a terminal observer error visible until Retry starts a new generation", async () => {
    const coordinator = new WalletDescriptorSubscriptionCoordinator()
    const generation = coordinator.start()
    const reload = deferred<void>()
    let synchronizationError: string | null = null
    const applyOutcome = (
      targetGeneration: number,
      outcome: "succeeded" | "failed"
    ) => {
      if (coordinator.accepts(targetGeneration, outcome)) {
        synchronizationError = reconcileWalletSynchronizationError(
          synchronizationError,
          outcome
        )
      }
    }
    const lateReload = reload.promise.then(() =>
      applyOutcome(generation, "succeeded")
    )

    expect(coordinator.markFailed(generation)).toBe(true)
    applyOutcome(generation, "failed")
    expect(synchronizationError).toBe(WALLET_STORAGE_SYNCHRONIZATION_ERROR)
    expect(coordinator.acceptsCurrent("succeeded")).toBe(false)

    reload.resolve(undefined)
    await lateReload
    expect(synchronizationError).toBe(WALLET_STORAGE_SYNCHRONIZATION_ERROR)

    const retryGeneration = coordinator.start()
    expect(coordinator.markFailed(generation)).toBe(false)
    applyOutcome(retryGeneration, "succeeded")
    expect(synchronizationError).toBeNull()
  })
})

describe("getRemovedWalletIdsForProvider", () => {
  it("finds only removed sessions for the requested provider", () => {
    expect(
      getRemovedWalletIdsForProvider(
        [wallet("nwc-a", "nwc"), wallet("spark-a", "spark")],
        [wallet("nwc-b", "nwc"), wallet("spark-a", "spark")],
        "nwc"
      )
    ).toEqual(["nwc-a"])
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

  it("does not hide an initialization failure behind a subscription failure", () => {
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

function wallet(
  id: string,
  providerId: WalletDescriptor["providerId"]
): WalletDescriptor {
  return {
    id,
    kind: providerId === "nwc" ? "connected" : "portable",
    providerId,
    label: id,
    network: "mainnet",
    capabilities: ["pay_invoice"],
    status: "registered",
    defaultIntents: [],
    createdAt: 1,
    updatedAt: 1,
  }
}
