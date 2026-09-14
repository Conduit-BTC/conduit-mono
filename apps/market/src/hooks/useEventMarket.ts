import { useLayoutEffect, useMemo, useRef } from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import {
  useAuth,
  useConduitSession,
  type PricingRateInput,
} from "@conduit/core"
import { getEventCatalogQueryDisplayState } from "../lib/event-catalog-query-state"
import { eventCatalogQueryOptions } from "../lib/event-catalog-query"

/** All event consumers observe the same scoped, rate-independent raw query. */
export function useEventCatalogs(
  references: readonly string[],
  rateInput: PricingRateInput = null
) {
  const client = useQueryClient()
  const session = useConduitSession()
  const { authGeneration } = useAuth()
  const authenticatedPubkey =
    session.mode === "signed_in" ? session.pubkey : null
  const scopeToken = JSON.stringify([
    session.relayScope,
    authenticatedPubkey,
    authGeneration,
  ])
  const currentScope = useRef(scopeToken)
  useLayoutEffect(() => {
    currentScope.current = scopeToken
  }, [scopeToken])
  const queries = useQueries({
    queries: references.map((reference) => ({
      ...eventCatalogQueryOptions(
        client,
        reference,
        {
          relayScope: session.relayScope,
          authenticatedPubkey,
          authGeneration,
        },
        () => currentScope.current === scopeToken
      ),
      enabled: session.relaySettingsReady,
    })),
  })
  return queries.map((query, index) => ({
    ...query,
    queryIdentity: JSON.stringify([scopeToken, references[index]]),
    ...getEventCatalogQueryDisplayState(
      query,
      rateInput,
      session.relaySettingsReady
    ),
  }))
}

export function useEventMarket(
  collectionRef: string,
  rateInput: PricingRateInput = null
) {
  const references = useMemo(() => [collectionRef], [collectionRef])
  return useEventCatalogs(references, rateInput)[0]!
}
