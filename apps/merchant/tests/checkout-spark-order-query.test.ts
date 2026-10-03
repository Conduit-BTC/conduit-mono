import { describe, expect, it } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import {
  checkoutSparkOrderSettlementQueryOptions,
  NO_CHECKOUT_SPARK_ORDER_BINDINGS,
} from "../src/lib/checkout-spark-order-query"

const principal = "a".repeat(64)
const input = {
  enabled: true,
  pubkey: principal,
  authGeneration: 1,
  isAuthGenerationCurrent: (generation: number) => generation === 1,
  orderIds: ["second", "first", "second"],
}

describe("local Merchant router settlement queries", () => {
  it("deduplicates/order-normalizes reads and separates accounts and sessions", async () => {
    const calls: unknown[] = []
    const options = checkoutSparkOrderSettlementQueryOptions(
      input,
      async (...args) => {
        calls.push(args)
        return NO_CHECKOUT_SPARK_ORDER_BINDINGS
      }
    )
    await options.queryFn({ signal: new AbortController().signal })
    expect(calls).toEqual([[principal, ["first", "second"]]])
    expect(options.queryKey).toEqual(
      checkoutSparkOrderSettlementQueryOptions({
        ...input,
        orderIds: ["first", "second"],
      }).queryKey
    )
    expect(options.queryKey).not.toEqual(
      checkoutSparkOrderSettlementQueryOptions({
        ...input,
        authGeneration: 2,
      }).queryKey
    )
    expect(options.queryKey).not.toEqual(
      checkoutSparkOrderSettlementQueryOptions({
        ...input,
        pubkey: "b".repeat(64),
      }).queryKey
    )
  })

  it("does not read while disabled, signed out, empty, or already aborted", async () => {
    let reads = 0
    const read = async () => {
      reads += 1
      return NO_CHECKOUT_SPARK_ORDER_BINDINGS
    }
    for (const unavailable of [
      { ...input, enabled: false },
      { ...input, pubkey: null },
      { ...input, orderIds: [] },
    ]) {
      const options = checkoutSparkOrderSettlementQueryOptions(
        unavailable,
        read
      )
      expect(options.enabled).toBe(false)
      expect(
        await options.queryFn({ signal: new AbortController().signal })
      ).toBe(NO_CHECKOUT_SPARK_ORDER_BINDINGS)
    }
    const abort = new AbortController()
    abort.abort()
    await checkoutSparkOrderSettlementQueryOptions(input, read).queryFn({
      signal: abort.signal,
    })
    expect(reads).toBe(0)
  })

  it("suppresses an in-flight local read after the session is aborted", async () => {
    let finish!: () => void
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    const result: typeof NO_CHECKOUT_SPARK_ORDER_BINDINGS = []
    const options = checkoutSparkOrderSettlementQueryOptions(
      input,
      async () => {
        await held
        return result
      }
    )
    const abort = new AbortController()
    const pending = options.queryFn({ signal: abort.signal })
    abort.abort()
    finish()
    expect(await pending).toBe(NO_CHECKOUT_SPARK_ORDER_BINDINGS)
  })

  it("drops a read when auth is revoked before React or the query sees the change", async () => {
    let current = true
    let finish!: () => void
    let reads = 0
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    const result: typeof NO_CHECKOUT_SPARK_ORDER_BINDINGS = []
    const request = { ...input, isAuthGenerationCurrent: () => current }
    const options = checkoutSparkOrderSettlementQueryOptions(
      request,
      async () => {
        reads += 1
        await held
        return result
      }
    )
    const signal = new AbortController().signal
    const pending = options.queryFn({ signal })
    current = false
    finish()
    expect(signal.aborted).toBe(false)
    expect(await pending).toBe(NO_CHECKOUT_SPARK_ORDER_BINDINGS)
    expect(checkoutSparkOrderSettlementQueryOptions(request).enabled).toBe(
      false
    )
    await options.queryFn({ signal })
    expect(reads).toBe(1)
  })

  it("retains prior verified local results if a refresh fails", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let unavailable = false
    const retained: typeof NO_CHECKOUT_SPARK_ORDER_BINDINGS = []
    const options = checkoutSparkOrderSettlementQueryOptions(
      input,
      async () => {
        if (unavailable) throw new Error("Local read unavailable")
        return retained
      }
    )
    try {
      await client.fetchQuery(options)
      unavailable = true
      await expect(
        client.fetchQuery({ ...options, staleTime: 0 })
      ).rejects.toThrow("Local read unavailable")
      expect(client.getQueryData(options.queryKey)).toBe(retained)
      expect(
        client.getQueryData(
          checkoutSparkOrderSettlementQueryOptions({
            ...input,
            authGeneration: 2,
          }).queryKey
        )
      ).toBeUndefined()
    } finally {
      client.clear()
    }
  })

  it("uses short-lived foreground-only caching and one hook on both surfaces", async () => {
    const options = checkoutSparkOrderSettlementQueryOptions(input)
    expect(options.gcTime).toBe(0)
    expect(options.refetchIntervalInBackground).toBe(false)
    expect(options.refetchInterval).toBe(30_000)
    const hook = await Bun.file(
      "apps/merchant/src/hooks/useCheckoutSparkOrderSettlements.ts"
    ).text()
    expect(hook).toMatch(/const bindings = active\s*\?/)
    expect(hook).toContain(
      "projectCheckoutSparkOrderSettlements(conversations, bindings)"
    )
    for (const name of ["index", "orders"]) {
      const route = await Bun.file(
        `apps/merchant/src/routes/${name}.tsx`
      ).text()
      expect(route).toContain("useCheckoutSparkOrderSettlements({")
      expect(route).toContain(
        "enabled: quantumRouterEnabled && signerConnected"
      )
      expect(route).toContain(
        "const quantumRouterEnabled = isQuantumRouterEnabled()"
      )
      expect(route).not.toContain("isLocalCheckoutSparkRecoveryRehearsal")
      expect(route).toContain("settlement={getOrderSettlement(conversation)}")
    }
    const home = await Bun.file("apps/merchant/src/routes/index.tsx").text()
    expect(home).toMatch(
      /getMerchantConversationQueue\(\s*conversation,\s*getOrderSettlement\(conversation\)/
    )
    expect(home).toMatch(
      /resolveDashboardPresetRange\(preset, now\),\s*orderSettlementBindings/
    )
  })
})
