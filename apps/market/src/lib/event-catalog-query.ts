import { hashKey, queryOptions, type QueryClient } from "@tanstack/react-query"
import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
} from "@conduit/core"
import {
  loadRawEventCatalog,
  type RawEventCatalog,
} from "./event-market-adapter"

import { eventCatalogCacheCoherence } from "./event-catalog-cache-coherence"

export type EventCatalogQueryScope = {
  relayScope: string | null | undefined
  authenticatedPubkey: string | null
  authGeneration: number
}

export function eventCatalogQueryIdentity(
  reference: string,
  scope: EventCatalogQueryScope
) {
  const decoded = decodeEventMarketReference(reference, [30405])
  const hints = [...new Set(decoded?.relayHints ?? [])].sort()
  return {
    reference: decoded
      ? encodeEventMarketNaddr(decoded.coordinate, hints)
      : reference,
    queryKey: [
      "event-market",
      scope.relayScope ?? "no-relay-scope",
      scope.authenticatedPubkey,
      scope.authGeneration,
      decoded?.coordinate ?? reference,
      hints,
    ] as const,
  }
}

export function eventCatalogQueryOptions(
  client: QueryClient,
  reference: string,
  scope: EventCatalogQueryScope,
  shouldContinue: () => boolean,
  loader: typeof loadRawEventCatalog = loadRawEventCatalog
) {
  const identity = eventCatalogQueryIdentity(reference, scope)
  const coherence = eventCatalogCacheCoherence(client)
  const ownerKey = hashKey(identity.queryKey)
  const reconcile = (raw: RawEventCatalog) => coherence.reconcile(raw, ownerKey)
  return queryOptions({
    queryKey: identity.queryKey,
    queryFn: async ({ signal }) => {
      const active = () => !signal.aborted && shouldContinue()
      // A cancelled read can retain a successful progress snapshot. Its event
      // verification belongs to that read, never to the new transport.
      const retained = client.getQueryData<RawEventCatalog>(identity.queryKey)
      if (retained?.resolutionComplete) {
        client.setQueryData(identity.queryKey, {
          ...retained,
          resolutionComplete: false,
        })
      }
      const result = await loader(identity.reference, {
        authenticatedPubkey: scope.authenticatedPubkey,
        shouldContinue: active,
        signal,
        onProgress: (snapshot: RawEventCatalog) => {
          if (active())
            client.setQueryData<RawEventCatalog>(
              identity.queryKey,
              reconcile({
                ...snapshot,
                complete: false,
              })
            )
        },
      })
      if (!active())
        throw new DOMException("Event catalog read cancelled", "AbortError")
      await coherence.settled(result, ownerKey, signal)
      if (!active())
        throw new DOMException("Event catalog read cancelled", "AbortError")
      return reconcile(result)
    },
    select: reconcile,
    // Reuse a completed read across detail/card mounts and short return visits.
    // Incomplete snapshots remain stale so an interrupted read is resumed.
    staleTime: (query) => (query.state.data?.complete ? 60_000 : 0),
    gcTime: 30 * 60_000,
    // A completed catalog stays quiet on focus, even after its freshness
    // window expires. Interrupted and failed reads still use focus as a
    // recovery signal.
    refetchOnWindowFocus: (query) => !query.state.data?.complete,
    retry: false,
  })
}
