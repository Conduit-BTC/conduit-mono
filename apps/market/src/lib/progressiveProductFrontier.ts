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
 * Apply one cumulative progressive snapshot as the complete current frontier.
 *
 * The previous value is accepted explicitly so callers cannot accidentally
 * turn this transition back into an append/merge operation. An empty snapshot
 * is meaningful: it retracts products removed by newly observed tombstones.
 */
export function replaceProgressiveProductFrontier<T>(
  _currentProducts: readonly T[],
  snapshotProducts: T[]
): T[] {
  return snapshotProducts
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

export function selectAuthoritativeQueryFrontier<T>(input: {
  hasAuthoritativeNetworkSnapshot: boolean
  networkData: T | undefined
  cachedData: T | undefined
}): T | undefined {
  return input.hasAuthoritativeNetworkSnapshot
    ? input.networkData
    : input.cachedData
}

export async function runProgressiveReadPass<T>(input: {
  readFast: () => Promise<T>
  readCompletion?: () => Promise<T>
  commitResult: (result: T, isFetching: boolean) => void
  shouldContinue?: () => boolean
}): Promise<void> {
  const fastResult = await input.readFast()
  if (input.shouldContinue && !input.shouldContinue()) return
  input.commitResult(fastResult, input.readCompletion !== undefined)
  if (
    !input.readCompletion ||
    (input.shouldContinue && !input.shouldContinue())
  ) {
    return
  }

  const completionResult = await input.readCompletion()
  if (input.shouldContinue && !input.shouldContinue()) return
  input.commitResult(completionResult, false)
}

/**
 * A refresh nonce may restart the same catalog read without weakening its
 * last settled frontier. A genuinely different catalog scope must establish
 * its own frontier instead.
 */
export function canCarryAuthoritativeProgressiveSnapshot(input: {
  previousCatalogKey: string
  nextCatalogKey: string
  hasSnapshot: boolean
}): boolean {
  return input.hasSnapshot && input.previousCatalogKey === input.nextCatalogKey
}
