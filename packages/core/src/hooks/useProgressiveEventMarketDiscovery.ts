import { useLayoutEffect, useMemo, useRef } from "react"
import {
  hashKey,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query"
import {
  discoverFutureEventMarkets,
  type FutureEventMarketDiscoveryResult,
} from "../protocol/event-market-roster-read"

type DiscoveryInput = Omit<
  Parameters<typeof discoverFutureEventMarkets>[0],
  "signal" | "onProgress"
>

function retainUnrefreshedRows(
  prior: FutureEventMarketDiscoveryResult | undefined,
  next: FutureEventMarketDiscoveryResult
): FutureEventMarketDiscoveryResult {
  if (!prior) return next
  const currentCoordinates = new Set(
    next.markets.map((read) => read.coordinate)
  )
  const unrefreshed = prior.markets
    .filter((read) => !currentCoordinates.has(read.coordinate))
    .map((read) => ({
      ...read,
      coverage: "stale" as const,
      ...(read.calendar ? { calendarCoverage: "stale" as const } : {}),
      ...(read.schedule ? { scheduleCoverage: "stale" as const } : {}),
    }))
  return {
    markets: [...next.markets, ...unrefreshed].sort((left, right) =>
      left.coordinate.localeCompare(right.coordinate)
    ),
    coverage: unrefreshed.length ? "partial" : next.coverage,
  }
}

/** Shared query boundary: provisional rows never outlive their active scope/run. */
export function createProgressiveEventMarketDiscoveryQuery(input: {
  queryClient: QueryClient
  queryKey: QueryKey
  discoveryInput: DiscoveryInput
  isCurrent: () => boolean
  discover?: typeof discoverFutureEventMarkets
}) {
  let run = 0
  return async ({
    signal,
  }: {
    signal: AbortSignal
  }): Promise<FutureEventMarketDiscoveryResult> => {
    const currentRun = ++run
    let active = true
    let observed =
      input.queryClient.getQueryData<FutureEventMarketDiscoveryResult>(
        input.queryKey
      )
    const assertCurrent = () => {
      if (
        !active ||
        signal.aborted ||
        run !== currentRun ||
        !input.isCurrent() ||
        input.discoveryInput.shouldContinue?.() === false
      )
        throw new DOMException(
          "Event Market query scope changed.",
          "AbortError"
        )
    }
    assertCurrent()
    try {
      const result = await (input.discover ?? discoverFutureEventMarkets)({
        ...input.discoveryInput,
        signal,
        shouldContinue: () =>
          active &&
          !signal.aborted &&
          run === currentRun &&
          input.isCurrent() &&
          input.discoveryInput.shouldContinue?.() !== false,
        onProgress: (progress) => {
          assertCurrent()
          observed = retainUnrefreshedRows(observed, {
            ...progress,
            coverage: "partial",
          })
          input.queryClient.setQueryData(input.queryKey, observed)
        },
      })
      assertCurrent()
      return retainUnrefreshedRows(observed, result)
    } finally {
      active = false
    }
  }
}

export function useProgressiveEventMarketDiscovery(input: {
  queryKey: QueryKey
  discoveryInput: DiscoveryInput
  enabled: boolean
  refetchInterval?: number
}) {
  const queryClient = useQueryClient()
  const scope = hashKey(input.queryKey)
  const activeScope = useRef(scope)
  useLayoutEffect(() => {
    activeScope.current = scope
    return () => {
      activeScope.current = ""
    }
  }, [scope])
  const queryFn = useMemo(
    () =>
      createProgressiveEventMarketDiscoveryQuery({
        queryClient,
        queryKey: input.queryKey,
        discoveryInput: input.discoveryInput,
        isCurrent: () => activeScope.current === scope,
        // Query keys include every input that changes read authority or authors.
        // Reuse the same run fence during ordinary observer renders.
      }),
    // Every changing discovery input is included in the caller's scoped key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, scope]
  )
  return useQuery({
    queryKey: input.queryKey,
    queryFn,
    enabled: input.enabled,
    retry: false,
    refetchInterval: input.refetchInterval,
  })
}
