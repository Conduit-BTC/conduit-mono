/**
 * Choose the product frontier rendered by Market.
 *
 * Once a progressive read has emitted a cumulative snapshot, that snapshot is
 * authoritative even when it is empty. Falling back to stale network/cache
 * rows after an empty snapshot would resurrect a product retracted by a later
 * tombstone.
 */
export function selectProgressiveProductFrontier<T>(input: {
  hasAuthoritativeSnapshot: boolean
  progressiveProducts: T[]
  networkProducts: T[]
  cachedProducts: T[]
}): T[] {
  if (input.hasAuthoritativeSnapshot || input.progressiveProducts.length > 0) {
    return input.progressiveProducts
  }
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

export function hasAuthoritativeProductFrontier(input: {
  hasProgressiveSnapshot: boolean
  hasCompletedNetworkResult: boolean
}): boolean {
  return input.hasProgressiveSnapshot || input.hasCompletedNetworkResult
}
