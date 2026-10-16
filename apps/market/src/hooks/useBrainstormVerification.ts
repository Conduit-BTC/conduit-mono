import { useQuery } from "@tanstack/react-query"
import { normalizePubkey } from "@conduit/core"
import { fetchBrainstormVerification } from "../lib/brainstorm-verification"

export function useBrainstormVerification(
  pubkey: string,
  enabled: boolean
): boolean {
  const hexPubkey = normalizePubkey(pubkey)
  const query = useQuery({
    queryKey: ["brainstorm-verification", hexPubkey],
    enabled: enabled && !!hexPubkey,
    queryFn: ({ signal }) => fetchBrainstormVerification(hexPubkey!, signal),
    staleTime: 60 * 60 * 1_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
  return enabled && query.data === true
}
