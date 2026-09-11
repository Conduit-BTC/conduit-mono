import { useLayoutEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  useAuth,
  useConduitSession,
  type PricingRateInput,
} from "@conduit/core"
import { loadEventCatalog } from "../lib/event-market-adapter"

export function useEventMarket(
  collectionRef: string,
  rateInput: PricingRateInput = null
) {
  const session = useConduitSession()
  const { authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey =
    session.mode === "signed_in" ? session.pubkey : null
  const rateVersion =
    rateInput && typeof rateInput === "object" ? rateInput.fetchedAt : null
  return useQuery({
    queryKey: [
      "event-market",
      session.relayScope ?? "no-relay-scope",
      collectionRef,
      rateVersion,
    ],
    queryFn: () =>
      loadEventCatalog(
        collectionRef,
        rateInput,
        authenticatedPubkey,
        () => authGenerationRef.current === authGeneration
      ),
    enabled: session.relaySettingsReady,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  })
}
