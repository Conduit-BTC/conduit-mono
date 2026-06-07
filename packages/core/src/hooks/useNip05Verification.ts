import { useQuery } from "@tanstack/react-query"
import {
  getNip05Verification,
  parseNip05Identifier,
  type Nip05VerificationResult,
} from "../protocol/nip05"

export type Nip05TrustStatus =
  | "absent"
  | "checking"
  | "valid"
  | "invalid"
  | "unknown"

export interface UseNip05VerificationResult {
  status: Nip05TrustStatus
  verification: Nip05VerificationResult | null
  isChecking: boolean
}

export function useNip05Verification(
  pubkey: string | null | undefined,
  nip05: string | null | undefined,
  options: { enabled?: boolean } = {}
): UseNip05VerificationResult {
  const trimmedNip05 = nip05?.trim() ?? ""
  const enabled = (options.enabled ?? true) && !!pubkey && !!trimmedNip05

  const query = useQuery({
    queryKey: ["nip05-verification", pubkey ?? "", trimmedNip05],
    enabled,
    queryFn: () =>
      getNip05Verification({
        pubkey: pubkey!,
        nip05: trimmedNip05,
      }),
    staleTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  })

  if (!trimmedNip05) {
    return {
      status: "absent",
      verification: null,
      isChecking: false,
    }
  }

  if (!parseNip05Identifier(trimmedNip05)) {
    return {
      status: "invalid",
      verification: null,
      isChecking: false,
    }
  }

  if (!query.data) {
    return {
      status: query.isLoading || query.isFetching ? "checking" : "unknown",
      verification: null,
      isChecking: query.isLoading || query.isFetching,
    }
  }

  return {
    status: query.data.status,
    verification: query.data,
    isChecking: query.isFetching,
  }
}
