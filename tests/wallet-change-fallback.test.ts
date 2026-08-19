import { describe, expect, it } from "bun:test"

import {
  notifyWalletChangeFallback,
  subscribeToWalletChangeFallback,
  type WalletChangeFallbackRuntime,
} from "../apps/market/src/lib/wallet-change-fallback"

const STORAGE_KEY = "conduit:wallets-change:v1"

class FakeStorageEventTarget {
  readonly listeners = new Set<(event: unknown) => void>()

  addEventListener(_type: "storage", listener: (event: unknown) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(
    _type: "storage",
    listener: (event: unknown) => void
  ): void {
    this.listeners.delete(listener)
  }

  dispatch(event: unknown): void {
    for (const listener of this.listeners) listener(event)
  }
}

function runtime(input: {
  target: FakeStorageEventTarget
  createBroadcastChannel?: () => Pick<BroadcastChannel, "close">
  setItem?: (key: string, value: string) => void
}): WalletChangeFallbackRuntime {
  return {
    createBroadcastChannel: input.createBroadcastChannel,
    eventTarget: input.target,
    storage: {
      setItem: input.setItem ?? (() => undefined),
    },
    createToken: () => "opaque-change-token",
  }
}

describe("wallet change storage fallback", () => {
  it("filters storage changes and cleans up", () => {
    const target = new FakeStorageEventTarget()
    let calls = 0
    const unsubscribe = subscribeToWalletChangeFallback(() => {
      calls += 1
    }, runtime({ target }))

    target.dispatch({ key: "unrelated", newValue: "opaque-change-token" })
    target.dispatch({ key: STORAGE_KEY, newValue: null })
    expect(calls).toBe(0)

    target.dispatch({ key: STORAGE_KEY, newValue: "opaque-change-token" })
    expect(calls).toBe(1)

    unsubscribe()
    target.dispatch({ key: STORAGE_KEY, newValue: "another-token" })
    expect(calls).toBe(1)
    expect(target.listeners.size).toBe(0)
  })

  it("defers to Dexie after successfully probing BroadcastChannel", () => {
    const target = new FakeStorageEventTarget()
    let writes = 0
    let closes = 0
    const fallbackRuntime = runtime({
      target,
      createBroadcastChannel: () => ({
        close() {
          closes += 1
        },
      }),
      setItem: () => {
        writes += 1
      },
    })
    const unsubscribe = subscribeToWalletChangeFallback(
      () => undefined,
      fallbackRuntime
    )

    notifyWalletChangeFallback(fallbackRuntime)

    expect(writes).toBe(0)
    expect(closes).toBe(1)
    expect(target.listeners.size).toBe(1)
    unsubscribe()
  })

  it("falls back when BroadcastChannel construction fails", () => {
    const target = new FakeStorageEventTarget()
    const writes: Array<[string, string]> = []
    let calls = 0
    const fallbackRuntime = runtime({
      target,
      createBroadcastChannel: () => {
        throw new Error("BroadcastChannel unavailable")
      },
      setItem: (key, value) => {
        writes.push([key, value])
        target.dispatch({ key, newValue: value })
      },
    })
    const unsubscribe = subscribeToWalletChangeFallback(() => {
      calls += 1
    }, fallbackRuntime)

    notifyWalletChangeFallback(fallbackRuntime)

    expect(writes).toEqual([[STORAGE_KEY, "opaque-change-token"]])
    expect(calls).toBe(1)
    unsubscribe()
  })

  it("contains storage failures", () => {
    const target = new FakeStorageEventTarget()
    expect(() =>
      notifyWalletChangeFallback(
        runtime({
          target,
          setItem: () => {
            throw new Error("storage unavailable")
          },
        })
      )
    ).not.toThrow()
  })
})
