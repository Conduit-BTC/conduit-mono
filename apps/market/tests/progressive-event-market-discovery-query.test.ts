import { describe, expect, it } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  discoverFutureEventMarkets,
  createProgressiveEventMarketDiscoveryQuery,
  type FutureEventMarketDiscoveryResult,
} from "@conduit/core"
import {
  deferred,
  until,
  fixture,
} from "../../../tests/helpers/future-market-discovery-fixture"

describe("shared progressive timeline query boundary", () => {
  it("publishes signed discovery rows through a real QueryObserver before completion", async () => {
    const state = fixture(),
      held = deferred<void>(),
      plan = state.dependencies.plan
    state.dependencies.plan = async (input) => {
      if (input.organizerPubkey === state.records[1]!.author) await held.promise
      return plan(input)
    }
    const client = new QueryClient(),
      key = ["timeline", "account", "relay-scope", 1]
    const queryFn = createProgressiveEventMarketDiscoveryQuery({
      queryClient: client,
      queryKey: key,
      discoveryInput: {
        organizerPubkeys: state.records.map((record) => record.author),
      },
      isCurrent: () => true,
      discover: (input) =>
        discoverFutureEventMarkets(input, state.dependencies),
    })
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn,
      enabled: false,
      retry: false,
    })
    const snapshots: FutureEventMarketDiscoveryResult[] = []
    const unsubscribe = observer.subscribe((result) => {
      if (result.data) snapshots.push(result.data)
    })
    const result = client.fetchQuery({ queryKey: key, queryFn, retry: false })
    await until(() => snapshots.some((value) => value.markets.length === 1))
    expect(observer.getCurrentResult().isFetching).toBe(true)
    expect(observer.getCurrentResult().data?.coverage).toBe("partial")
    held.resolve()
    expect((await result).markets).toHaveLength(2)
    unsubscribe()
    client.clear()
  })
  it("retains unrefreshed rows as stale and lets explicit negatives replace them", async () => {
    const state = fixture(),
      initial = await discoverFutureEventMarkets(
        { organizerPubkeys: state.records.map((record) => record.author) },
        state.dependencies
      )
    const client = new QueryClient(),
      key = ["timeline"]
    client.setQueryData(key, initial)
    const held = deferred<void>()
    let emit!: Parameters<typeof discoverFutureEventMarkets>[0]["onProgress"]
    const queryFn = createProgressiveEventMarketDiscoveryQuery({
      queryClient: client,
      queryKey: key,
      discoveryInput: { organizerPubkeys: [] },
      isCurrent: () => true,
      discover: async (input) => {
        emit = input.onProgress
        await held.promise
        return { markets: [], coverage: "complete" }
      },
    })
    const result = client.fetchQuery({ queryKey: key, queryFn, retry: false })
    await until(() => !!emit)
    const deleted = {
      ...initial.markets[0]!,
      resolution: { state: "deleted" as const, deletionEventIds: [] },
    }
    emit!({ markets: [deleted], coverage: "partial" })
    const progress = client.getQueryData<FutureEventMarketDiscoveryResult>(key)!
    expect(
      progress.markets.find((read) => read.coordinate === deleted.coordinate)
        ?.resolution.state
    ).toBe("deleted")
    expect(
      progress.markets.find((read) => read.coordinate !== deleted.coordinate)
        ?.coverage
    ).toBe("stale")
    held.resolve()
    const final = await result
    expect(
      final.markets.find((read) => read.coordinate === deleted.coordinate)
        ?.resolution.state
    ).toBe("deleted")
    client.clear()
  })
  it.each(["account", "auth generation", "relay scope"])(
    "rejects late progress and final data after a %s switch",
    async () => {
      const client = new QueryClient(),
        key = ["timeline", "old-scope"],
        held = deferred<void>()
      let current = true,
        emit!: Parameters<typeof discoverFutureEventMarkets>[0]["onProgress"]
      const queryFn = createProgressiveEventMarketDiscoveryQuery({
        queryClient: client,
        queryKey: key,
        discoveryInput: { organizerPubkeys: [] },
        isCurrent: () => current,
        discover: async (input) => {
          emit = input.onProgress
          await held.promise
          return { markets: [], coverage: "complete" }
        },
      })
      const result = client.fetchQuery({ queryKey: key, queryFn, retry: false })
      await until(() => !!emit)
      current = false
      expect(() => emit!({ markets: [], coverage: "partial" })).toThrow(
        "scope changed"
      )
      expect(client.getQueryData(key)).toBeUndefined()
      held.resolve()
      await expect(result).rejects.toMatchObject({ name: "AbortError" })
      client.clear()
    }
  )
})
