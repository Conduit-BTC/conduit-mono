import { describe, expect, it } from "bun:test"

import {
  getRemovedWalletIdsForProvider,
  notifyWalletsChanged,
  subscribeToWalletChanges,
  type WalletChangeBroadcastChannel,
  type WalletChangeRuntime,
} from "../apps/market/src/lib/wallet-change-channel"
import { LatestWalletReloadCoordinator } from "../apps/market/src/lib/wallet-initialization"
import type { WalletDescriptor } from "@conduit/core"

class FakeEventTarget {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(event: unknown): boolean {
    const type = (event as { type?: string }).type
    if (!type) return false
    for (const listener of this.listeners.get(type) ?? []) listener(event)
    return true
  }
}

class FakeBroadcastBus {
  readonly channels = new Set<FakeBroadcastChannel>()

  create = (): WalletChangeBroadcastChannel => {
    const channel = new FakeBroadcastChannel(this)
    this.channels.add(channel)
    return channel
  }
}

class FakeBroadcastChannel implements WalletChangeBroadcastChannel {
  readonly listeners = new Set<(event: unknown) => void>()
  closed = false

  constructor(private readonly bus: FakeBroadcastBus) {}

  postMessage(message: unknown): void {
    for (const channel of this.bus.channels) {
      if (channel !== this && !channel.closed) {
        for (const listener of channel.listeners) {
          listener({ data: message })
        }
      }
    }
  }

  addEventListener(_type: "message", listener: (event: unknown) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(
    _type: "message",
    listener: (event: unknown) => void
  ): void {
    this.listeners.delete(listener)
  }

  close(): void {
    this.closed = true
    this.bus.channels.delete(this)
  }
}

function runtime(
  target: FakeEventTarget,
  bus: FakeBroadcastBus,
  sourceId: string
): WalletChangeRuntime {
  return {
    sourceId,
    eventTarget: target,
    createEvent: (type) => ({ type }),
    createBroadcastChannel: bus.create,
    createToken: () => "opaque-change-token",
  }
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

describe("wallet change channel", () => {
  it("notifies the current document and other tabs, then cleans up", () => {
    const firstTarget = new FakeEventTarget()
    const secondTarget = new FakeEventTarget()
    const bus = new FakeBroadcastBus()
    let firstCalls = 0
    let secondCalls = 0
    const unsubscribeFirst = subscribeToWalletChanges(
      () => {
        firstCalls += 1
      },
      runtime(firstTarget, bus, "first-tab")
    )
    const unsubscribeSecond = subscribeToWalletChanges(
      () => {
        secondCalls += 1
      },
      runtime(secondTarget, bus, "second-tab")
    )

    notifyWalletsChanged(runtime(firstTarget, bus, "first-tab"))
    expect(firstCalls).toBe(1)
    expect(secondCalls).toBe(1)

    unsubscribeSecond()
    notifyWalletsChanged(runtime(firstTarget, bus, "first-tab"))
    expect(firstCalls).toBe(2)
    expect(secondCalls).toBe(1)

    unsubscribeFirst()
    expect(bus.channels.size).toBe(0)
  })

  it("contains and reports an asynchronous listener failure", async () => {
    const target = new FakeEventTarget()
    const bus = new FakeBroadcastBus()
    const failure = new Error("latest reload failed")
    let reported: unknown = null
    const unsubscribe = subscribeToWalletChanges(
      async () => {
        throw failure
      },
      runtime(target, bus, "current-tab"),
      {
        onError(error) {
          reported = error
        },
      }
    )

    notifyWalletsChanged(runtime(target, bus, "current-tab"))
    await Promise.resolve()
    await Promise.resolve()

    expect(reported).toBe(failure)
    unsubscribe()
  })

  it("reports recovery after a later authoritative reload succeeds", async () => {
    const target = new FakeEventTarget()
    const bus = new FakeBroadcastBus()
    const loads = [deferred<void>(), deferred<void>()]
    const coordinator = new LatestWalletReloadCoordinator()
    let loadIndex = 0
    let initializationError: string | null = null
    const failed = deferred<void>()
    const recovered = deferred<void>()
    const unsubscribe = subscribeToWalletChanges(
      async () => {
        const load = loads[loadIndex++]
        if (!load) throw new Error("Unexpected reload.")
        await coordinator.run(
          () => load.promise,
          () => undefined
        )
        await coordinator.waitForLatest()
      },
      runtime(target, bus, "current-tab"),
      {
        onSuccess() {
          initializationError = null
          recovered.resolve(undefined)
        },
        onError() {
          initializationError =
            "Wallet storage could not be initialized on this device."
          failed.resolve(undefined)
        },
      }
    )

    notifyWalletsChanged(runtime(target, bus, "current-tab"))
    loads[0]!.reject(new Error("reload failed"))
    await failed.promise
    expect(initializationError).toBe(
      "Wallet storage could not be initialized on this device."
    )

    notifyWalletsChanged(runtime(target, bus, "current-tab"))
    loads[1]!.resolve(undefined)
    await recovered.promise
    expect(initializationError).toBeNull()
    unsubscribe()
  })

  it("does not report a superseded success over the latest failure", async () => {
    const target = new FakeEventTarget()
    const bus = new FakeBroadcastBus()
    const loads = [deferred<void>(), deferred<void>()]
    const coordinator = new LatestWalletReloadCoordinator()
    let loadIndex = 0
    let successCount = 0
    let initializationError: string | null = null
    const failed = deferred<void>()
    const unsubscribe = subscribeToWalletChanges(
      async () => {
        const load = loads[loadIndex++]
        if (!load) throw new Error("Unexpected reload.")
        await coordinator.run(
          () => load.promise,
          () => undefined
        )
        await coordinator.waitForLatest()
      },
      runtime(target, bus, "current-tab"),
      {
        onSuccess() {
          successCount += 1
          initializationError = null
        },
        onError() {
          initializationError =
            "Wallet storage could not be initialized on this device."
          failed.resolve(undefined)
        },
      }
    )

    notifyWalletsChanged(runtime(target, bus, "current-tab"))
    notifyWalletsChanged(runtime(target, bus, "current-tab"))
    loads[0]!.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(successCount).toBe(0)

    loads[1]!.reject(new Error("latest reload failed"))
    await failed.promise
    expect(successCount).toBe(0)
    expect(initializationError).toBe(
      "Wallet storage could not be initialized on this device."
    )
    unsubscribe()
  })

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
