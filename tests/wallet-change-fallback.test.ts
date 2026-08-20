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
  it("filters storage changes, accepts legacy tokens, and cleans up", () => {
    const target = new FakeStorageEventTarget()
    let calls = 0
    const unsubscribe = subscribeToWalletChangeFallback(() => {
      calls += 1
    }, runtime({ target }))

    target.dispatch({ key: "unrelated", newValue: "opaque-change-token" })
    target.dispatch({ key: STORAGE_KEY, newValue: null })
    expect(calls).toBe(0)

    target.dispatch({ key: STORAGE_KEY, newValue: "legacy-opaque-token" })
    expect(calls).toBe(1)

    unsubscribe()
    target.dispatch({ key: STORAGE_KEY, newValue: "another-token" })
    expect(calls).toBe(1)
    expect(target.listeners.size).toBe(0)
  })

  it("reloads only the mixed-capability and storage-only receiver paths", () => {
    expect(
      runTransportCase({ writerBroadcast: true, receiverBroadcast: true })
    ).toMatchObject({ calls: 0, tokenPrefix: "dexie-broadcast:" })
    expect(
      runTransportCase({ writerBroadcast: true, receiverBroadcast: false })
    ).toMatchObject({ calls: 1, tokenPrefix: "dexie-broadcast:" })
    expect(
      runTransportCase({ writerBroadcast: false, receiverBroadcast: true })
    ).toMatchObject({ calls: 1, tokenPrefix: "storage-fallback:" })
    expect(
      runTransportCase({ writerBroadcast: false, receiverBroadcast: false })
    ).toMatchObject({ calls: 1, tokenPrefix: "storage-fallback:" })
  })

  it("treats legacy tokens and a failed probe close as storage fallback", () => {
    const target = new FakeStorageEventTarget()
    let calls = 0
    let writtenValue = ""
    const unsubscribe = subscribeToWalletChangeFallback(
      () => {
        calls += 1
      },
      runtime({ target, createBroadcastChannel: broadcastChannel(true) })
    )

    target.dispatch({ key: STORAGE_KEY, newValue: "legacy-token" })
    expect(calls).toBe(1)

    notifyWalletChangeFallback(
      runtime({
        target,
        createBroadcastChannel: () => ({
          close() {
            throw new Error("BroadcastChannel close failed")
          },
        }),
        setItem: (key, value) => {
          writtenValue = value
          target.dispatch({ key, newValue: value })
        },
      })
    )

    expect(writtenValue).toStartWith("storage-fallback:")
    expect(calls).toBe(2)
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

function runTransportCase(input: {
  writerBroadcast: boolean
  receiverBroadcast: boolean
}): { calls: number; tokenPrefix: string } {
  const target = new FakeStorageEventTarget()
  let calls = 0
  let writtenValue = ""
  const receiverRuntime = runtime({
    target,
    createBroadcastChannel: broadcastChannel(input.receiverBroadcast),
  })
  const unsubscribe = subscribeToWalletChangeFallback(() => {
    calls += 1
  }, receiverRuntime)
  const writerRuntime = runtime({
    target,
    createBroadcastChannel: broadcastChannel(input.writerBroadcast),
    setItem: (key, value) => {
      writtenValue = value
      target.dispatch({ key, newValue: value })
    },
  })

  notifyWalletChangeFallback(writerRuntime)
  unsubscribe()

  return {
    calls,
    tokenPrefix: writtenValue.slice(0, writtenValue.lastIndexOf(":") + 1),
  }
}

function broadcastChannel(
  available: boolean
): () => Pick<BroadcastChannel, "close"> {
  return () => {
    if (!available) {
      throw new Error("BroadcastChannel unavailable")
    }
    return { close() {} }
  }
}
