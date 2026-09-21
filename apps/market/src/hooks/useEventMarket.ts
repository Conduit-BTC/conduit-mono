import { useLayoutEffect, useMemo, useRef } from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import {
  normalizePubkey,
  useAuth,
  useConduitSession,
  type PricingRateInput,
} from "@conduit/core"
import { getEventCatalogQueryDisplayState } from "../lib/event-catalog-query-state"
import { eventCatalogQueryOptions } from "../lib/event-catalog-query"

export type UseEventCatalogsOptions = {
  /** Load only organizer-listed products authored by this merchant first. */
  selectedMerchantPubkey?: string
  enabled?: boolean
}

/** All event consumers observe the same scoped, rate-independent raw query. */
export function useEventCatalogs(
  references: readonly string[],
  rateInput: PricingRateInput = null,
  options: UseEventCatalogsOptions = {}
) {
  const client = useQueryClient()
  const session = useConduitSession()
  const { authGeneration } = useAuth()
  const authenticatedPubkey =
    session.mode === "signed_in" ? session.pubkey : null
  const selectedMerchantPubkey =
    options.selectedMerchantPubkey === undefined
      ? undefined
      : (normalizePubkey(options.selectedMerchantPubkey) ??
        options.selectedMerchantPubkey.trim().toLowerCase())
  const scopeToken = JSON.stringify([
    session.relayScope,
    authenticatedPubkey,
    authGeneration,
    selectedMerchantPubkey ?? "all-merchants",
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
          selectedMerchantPubkey,
        },
        () => currentScope.current === scopeToken
      ),
      enabled: session.relaySettingsReady && options.enabled !== false,
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
  rateInput: PricingRateInput = null,
  options: UseEventCatalogsOptions = {}
) {
  const references = useMemo(() => [collectionRef], [collectionRef])
  return useEventCatalogs(references, rateInput, options)[0]!
}
