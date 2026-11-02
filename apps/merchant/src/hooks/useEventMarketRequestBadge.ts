import { liveQuery } from "dexie"
import { useEffect, useMemo, useState } from "react"
import { useAuth, useCommerceInbox } from "@conduit/core"
import { resolveEventMarketRoster } from "@conduit/core/protocol/event-market-roster"
import { loadRetainedSignedEventMarketEvidence } from "@conduit/core/protocol/event-market-roster-read"
import {
  getObservedEventRequests,
  projectEventRequestBadge,
  type ObservedEventRoster,
} from "../lib/event-market-request-badge"

const MAX_OBSERVED_REQUEST_MARKETS = 64

/** Observe already-owned inbox/cache evidence; never starts a relay read or poller. */
export function useEventMarketRequestBadge() {
  const {
    pubkey,
    accountPubkey,
    status,
    signerReadiness,
    authGeneration,
    isAuthGenerationCurrent,
    isAccountIdentityCurrent,
  } = useAuth()
  const principal =
    status === "connected" &&
    signerReadiness === "ready" &&
    pubkey === accountPubkey
      ? pubkey
      : null
  const inbox = useCommerceInbox(principal, !!principal, false)
  const requests = useMemo(
    () =>
      getObservedEventRequests(principal, inbox.snapshot?.directMessages ?? []),
    [principal, inbox.snapshot]
  )
  const coordinateKey = JSON.stringify([...requests.keys()].sort())
  const scope = useMemo(
    () => ({ principal, authGeneration, coordinateKey }),
    [principal, authGeneration, coordinateKey]
  )
  const [observed, setObserved] = useState<{
    scope: typeof scope
    rosters: Map<string, ObservedEventRoster>
  } | null>(null)
  useEffect(() => {
    if (!scope.principal) return
    let active = true
    const isCurrent = () =>
      active &&
      isAuthGenerationCurrent(scope.authGeneration) &&
      isAccountIdentityCurrent(scope.principal!)
    const coordinates = (JSON.parse(scope.coordinateKey) as string[]).slice(
      0,
      MAX_OBSERVED_REQUEST_MARKETS
    )
    if (!coordinates.length) return
    const subscription = liveQuery(async () => {
      const rows = await Promise.all(
        coordinates.map(async (coordinate) => {
          const retained =
            await loadRetainedSignedEventMarketEvidence(coordinate)
          const result = resolveEventMarketRoster({
            coordinate,
            revisions: retained,
            deletions: retained,
          })
          const roster: ObservedEventRoster =
            result.state === "current"
              ? {
                  state: "current",
                  merchants: result.market.merchants.map((row) => row.pubkey),
                }
              : { state: "unresolved" }
          return [coordinate, roster] as const
        })
      )
      return new Map(rows)
    }).subscribe({
      next: (rosters) => {
        if (isCurrent()) setObserved({ scope, rosters })
      },
      error: () => {
        if (isCurrent()) setObserved({ scope, rosters: new Map() })
      },
    })
    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [scope, isAuthGenerationCurrent, isAccountIdentityCurrent])
  return projectEventRequestBadge(
    requests,
    observed?.scope === scope ? observed.rosters : new Map()
  )
}
