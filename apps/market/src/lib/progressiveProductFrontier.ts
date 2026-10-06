import type { QueryClient, QueryKey } from "@tanstack/react-query"

/**
 * Choose the product frontier rendered by Market.
 *
 * Once a progressive read has emitted a cumulative snapshot, that snapshot is
 * authoritative even when it is empty. Falling back to stale network/cache
 * rows after an empty snapshot would resurrect a product retracted by a later
 * tombstone.
 */
export function selectProgressiveProductFrontier<T>(input: {
  hasAuthoritativeProgressiveSnapshot: boolean
  hasAuthoritativeNetworkSnapshot: boolean
  progressiveProducts: T[]
  networkProducts: T[]
  cachedProducts: T[]
}): T[] {
  if (input.hasAuthoritativeProgressiveSnapshot) {
    return input.progressiveProducts
  }
  if (input.hasAuthoritativeNetworkSnapshot) return input.networkProducts
  if (input.progressiveProducts.length > 0) return input.progressiveProducts
  return input.networkProducts.length > 0
    ? input.networkProducts
    : input.cachedProducts
}

/**
 * Treat settled query data as authoritative while the same query refetches.
 * Placeholder data belongs to a previous query key, so it cannot establish
 * the frontier for the new key until that read settles.
 */
export function hasAuthoritativeQuerySnapshot(input: {
  hasData: boolean
  isPlaceholderData: boolean
}): boolean {
  return input.hasData && !input.isPlaceholderData
}

/** One query owns a catalog stream, so matching consumers share its in-flight read. */
export function createProgressiveCatalogQuery<T>(input: {
  queryClient: QueryClient
  queryKey: QueryKey
  read: (onProgress: (snapshot: T) => void, signal: AbortSignal) => Promise<T>
  isCurrent: () => boolean
}): (context: { signal: AbortSignal }) => Promise<T> {
  return async ({ signal }) => {
    let pending: T | undefined
    let flushHandle: number | null = null
    let active = true
    const isCurrent = () => active && !signal.aborted && input.isCurrent()
    const flush = () => {
      flushHandle = null
      if (!isCurrent() || pending === undefined) return
      input.queryClient.setQueryData(input.queryKey, pending)
      pending = undefined
    }
    const schedule = () => {
      if (flushHandle !== null) return
      flushHandle =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(flush)
          : (setTimeout(flush, 16) as unknown as number)
    }
    const clearScheduled = () => {
      if (flushHandle === null) return
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(flushHandle)
      } else {
        clearTimeout(flushHandle)
      }
      flushHandle = null
    }

    try {
      const result = await input.read((snapshot) => {
        if (!isCurrent()) return
        pending = snapshot
        schedule()
      }, signal)
      signal.throwIfAborted()
      if (!input.isCurrent())
        throw new DOMException("Catalog scope changed", "AbortError")
      return result
    } catch (error) {
      // Keep the latest authoritative cumulative result if later relays fail.
      if (isCurrent() && pending !== undefined) flush()
      throw error
    } finally {
      active = false
      clearScheduled()
    }
  }
}
