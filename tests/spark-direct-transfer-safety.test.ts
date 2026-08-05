import { describe, expect, it } from "bun:test"

import { BrowserSparkDirectTransferSafetyStore } from "../apps/market/src/lib/spark-direct-transfer-safety"

describe("Spark direct-transfer safety storage", () => {
  it("persists only the content-free attempt marker", () => {
    const values = new Map<string, string>()
    const store = new BrowserSparkDirectTransferSafetyStore({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    })

    store.put("identity scope", {
      attemptId: "attempt-123",
      createdAt: 1_722_799_200_000,
    })

    expect([...values.keys()]).toEqual([
      "conduit:spark-direct-transfer-safety:v2:identity%20scope",
    ])
    expect([...values.values()]).toEqual([
      '{"version":2,"attemptId":"attempt-123","createdAt":1722799200000}',
    ])
    expect(store.get("identity scope")).toEqual({
      attemptId: "attempt-123",
      createdAt: 1_722_799_200_000,
    })

    store.delete("identity scope")
    expect(store.get("identity scope")).toBeNull()
  })

  it("fails closed when persisted safety state is corrupt", () => {
    const store = new BrowserSparkDirectTransferSafetyStore({
      getItem: () => '{"version":2,"attemptId":"","createdAt":0}',
      setItem: () => undefined,
      removeItem: () => undefined,
    })

    expect(() => store.get("wallet-personal")).toThrow(
      "Spark transfer safety state is invalid."
    )
  })
})
