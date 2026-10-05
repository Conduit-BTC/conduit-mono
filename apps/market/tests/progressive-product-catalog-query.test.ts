import { describe, expect, it } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"

import { createProgressiveCatalogQuery } from "../src/lib/progressiveProductFrontier"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Expected catalog state was not observed")
}

describe("shared progressive product catalog query", () => {
  it("shares one in-flight read and warm result across consumers", async () => {
    const client = new QueryClient()
    const key = ["catalog", "same-scope"] as const
    const held = deferred<string[]>()
    let reads = 0
    const queryFn = createProgressiveCatalogQuery({
      queryClient: client,
      queryKey: key,
      isCurrent: () => true,
      read: async (onProgress) => {
        reads += 1
        onProgress(["first-product"])
        return await held.promise
      },
    })
    const options = { queryKey: key, queryFn, staleTime: 60_000, retry: false }
    const first = new QueryObserver(client, options)
    const second = new QueryObserver(client, options)
    const stopFirst = first.subscribe(() => undefined)
    const stopSecond = second.subscribe(() => undefined)

    await until(
      () =>
        first.getCurrentResult().data?.[0] === "first-product" &&
        second.getCurrentResult().data?.[0] === "first-product"
    )
    expect(reads).toBe(1)
    expect(first.getCurrentResult().isFetching).toBe(true)
    held.resolve(["first-product", "second-product"])
    await until(() => second.getCurrentResult().data?.length === 2)
    stopFirst()
    stopSecond()

    const returning = new QueryObserver(client, options)
    const stopReturning = returning.subscribe(() => undefined)
    expect(returning.getCurrentResult().data).toEqual([
      "first-product",
      "second-product",
    ])
    expect(reads).toBe(1)
    stopReturning()
    client.clear()
  })

  it("keeps the old frontier until progress and applies empty retraction", async () => {
    const client = new QueryClient()
    const key = ["catalog", "refresh"] as const
    const held = deferred<string[]>()
    let reads = 0
    let emitRefresh: ((products: string[]) => void) | undefined
    const queryFn = createProgressiveCatalogQuery({
      queryClient: client,
      queryKey: key,
      isCurrent: () => true,
      read: async (onProgress) => {
        reads += 1
        if (reads === 1) return ["old-product"]
        emitRefresh = onProgress
        return await held.promise
      },
    })
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn,
      staleTime: 60_000,
      retry: false,
    })
    const stop = observer.subscribe(() => undefined)
    await until(() => observer.getCurrentResult().data?.[0] === "old-product")

    const refresh = observer.refetch()
    await until(() => emitRefresh !== undefined)
    expect(observer.getCurrentResult().data).toEqual(["old-product"])
    emitRefresh?.([])
    await until(() => observer.getCurrentResult().data?.length === 0)
    held.resolve([])
    await refresh
    expect(observer.getCurrentResult().data).toEqual([])
    stop()
    client.clear()
  })

  it("coalesces simultaneous explicit refreshes from two consumers", async () => {
    const client = new QueryClient()
    const key = ["catalog", "shared-refresh"] as const
    const held = deferred<string[]>()
    let reads = 0
    const queryFn = createProgressiveCatalogQuery({
      queryClient: client,
      queryKey: key,
      isCurrent: () => true,
      read: async () => {
        reads += 1
        return reads === 1 ? ["old-product"] : await held.promise
      },
    })
    const options = { queryKey: key, queryFn, staleTime: 60_000, retry: false }
    const first = new QueryObserver(client, options)
    const second = new QueryObserver(client, options)
    const stopFirst = first.subscribe(() => undefined)
    const stopSecond = second.subscribe(() => undefined)
    await until(() => first.getCurrentResult().data?.[0] === "old-product")

    const firstRefresh = first.refetch({ cancelRefetch: false })
    const secondRefresh = second.refetch({ cancelRefetch: false })
    await until(() => reads === 2)
    expect(first.getCurrentResult().data).toEqual(["old-product"])
    held.resolve(["new-product"])
    await Promise.all([firstRefresh, secondRefresh])
    expect(reads).toBe(2)
    expect(second.getCurrentResult().data).toEqual(["new-product"])
    stopFirst()
    stopSecond()
    client.clear()
  })

  it("isolates a new scope from cancelled progress in the previous scope", async () => {
    const client = new QueryClient()
    const oldKey = ["catalog", "old-authors"] as const
    const nextKey = ["catalog", "new-authors"] as const
    const oldHeld = deferred<string[]>()
    let emitOld: ((products: string[]) => void) | undefined
    const oldQuery = createProgressiveCatalogQuery({
      queryClient: client,
      queryKey: oldKey,
      isCurrent: () => true,
      read: async (onProgress) => {
        emitOld = onProgress
        return await oldHeld.promise
      },
    })
    const oldObserver = new QueryObserver(client, {
      queryKey: oldKey,
      queryFn: oldQuery,
      retry: false,
    })
    const stopOld = oldObserver.subscribe(() => undefined)
    await until(() => emitOld !== undefined)
    stopOld()
    await client.cancelQueries({ queryKey: oldKey })
    emitOld?.(["stale-product"])
    oldHeld.resolve(["stale-product"])

    const nextQuery = createProgressiveCatalogQuery({
      queryClient: client,
      queryKey: nextKey,
      isCurrent: () => true,
      read: async () => ["new-product"],
    })
    const nextObserver = new QueryObserver(client, {
      queryKey: nextKey,
      queryFn: nextQuery,
      retry: false,
    })
    const stopNext = nextObserver.subscribe(() => undefined)
    await until(
      () => nextObserver.getCurrentResult().data?.[0] === "new-product"
    )
    expect(nextObserver.getCurrentResult().data).toEqual(["new-product"])
    expect(client.getQueryData(oldKey)).toBeUndefined()
    stopNext()
    client.clear()
  })
})
