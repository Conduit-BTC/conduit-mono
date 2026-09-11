import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "../context/AuthContext"
import { useConduitSession } from "../context/ConduitSessionContext"
import {
  inspectOwnPrivateMessageRelayReadiness,
  type OwnPrivateMessageRelayReadiness,
} from "../protocol/messaging"
import { invalidateInboxDeclaration } from "../protocol/private-message-routing"
import { subscribeRelaySettingsChanges } from "../protocol/relay-settings"

/**
 * Read-only NIP-17 inbox-declaration readiness.
 *
 * Account Network settings is the sole owner of declaration review, signing,
 * durable staging, delivery, exact readback, retry, and redistribution. This
 * hook intentionally exposes observation only so messaging surfaces cannot
 * become a second mutation door.
 */

export const INBOX_DECLARATION_QUERY_KEY = "inbox-declaration"

export interface UseInboxDeclarationOptions {
  enabled?: boolean
  /** Account relay-settings scope used to refresh after a signed projection. */
  relayScope?: string | null
}

export type InboxDeclarationStatus =
  | "loading"
  | "ready"
  | "distribution_pending"
  | "not_observed"
  | "signed_empty"
  | "malformed"
  | "lookup_partial"
  | "lookup_unavailable"

export interface UseInboxDeclarationResult {
  readiness: OwnPrivateMessageRelayReadiness | undefined
  /** Derived presentational status; lookup rejections map to lookup_unavailable. */
  status: InboxDeclarationStatus
  /** Relays in the current declaration; empty unless a declaration is usable. */
  declaredRelayUrls: string[]
  /** Last usable declaration retained only as recovery evidence. */
  retainedRelayUrls: string[]
  /** True when readiness comes from retained evidence during a degraded lookup. */
  stale: boolean
  /** A complete shared lookup permits Network settings to offer exact repair. */
  distributionRepairable: boolean
  isLoading: boolean
  isRefetching: boolean
  /** Non-null when the readiness lookup itself rejected. */
  error: string | null
  refetch: () => void
}

interface AccountReadAuthority {
  authGeneration: number
  pubkey: string | null
  relayScope: string | null
  sessionPubkey: string | null
  status: string
}

function sameAccountReadAuthority(
  current: AccountReadAuthority,
  expected: AccountReadAuthority
): boolean {
  return (
    current.authGeneration === expected.authGeneration &&
    current.pubkey === expected.pubkey &&
    current.relayScope === expected.relayScope &&
    current.sessionPubkey === expected.sessionPubkey &&
    current.status === expected.status
  )
}

export function useInboxDeclaration(
  pubkey: string | null | undefined,
  options: UseInboxDeclarationOptions = {}
): UseInboxDeclarationResult {
  const auth = useAuth()
  const session = useConduitSession()
  const authorityRef = useRef<AccountReadAuthority>({
    authGeneration: auth.authGeneration,
    pubkey: auth.pubkey,
    relayScope: session.relayScope,
    sessionPubkey: session.pubkey,
    status: auth.status,
  })
  const queryClient = useQueryClient()
  const queryKey = useMemo(
    () => [INBOX_DECLARATION_QUERY_KEY, pubkey ?? "none"],
    [pubkey]
  )
  useLayoutEffect(() => {
    authorityRef.current = {
      authGeneration: auth.authGeneration,
      pubkey: auth.pubkey,
      relayScope: session.relayScope,
      sessionPubkey: session.pubkey,
      status: auth.status,
    }
  }, [
    auth.authGeneration,
    auth.pubkey,
    auth.status,
    session.pubkey,
    session.relayScope,
  ])

  const readinessQuery = useQuery({
    queryKey,
    enabled: !!pubkey && (options.enabled ?? true),
    queryFn: ({ signal }) => {
      const expectedAuthority: AccountReadAuthority = {
        authGeneration: auth.authGeneration,
        pubkey: auth.pubkey,
        relayScope: session.relayScope,
        sessionPubkey: session.pubkey,
        status: auth.status,
      }
      return inspectOwnPrivateMessageRelayReadiness(pubkey!, {
        authenticatedPubkey:
          expectedAuthority.status === "connected" &&
          expectedAuthority.pubkey === pubkey &&
          expectedAuthority.sessionPubkey === pubkey
            ? pubkey
            : null,
        signal,
        shouldContinue: () =>
          !signal.aborted &&
          sameAccountReadAuthority(authorityRef.current, expectedAuthority),
      })
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  useEffect(() => {
    if (!pubkey || !(options.enabled ?? true)) return
    const relayScope = options.relayScope?.trim() || null
    return subscribeRelaySettingsChanges((changedScope) => {
      if (changedScope !== relayScope) return
      invalidateInboxDeclaration(pubkey)
      void queryClient.invalidateQueries({ queryKey })
    })
  }, [options.enabled, options.relayScope, pubkey, queryClient, queryKey])

  const readiness = readinessQuery.data
  const status: InboxDeclarationStatus = readinessQuery.isLoading
    ? "loading"
    : readinessQuery.error
      ? "lookup_unavailable"
      : readiness?.state === "ready"
        ? "ready"
        : (readiness?.state ?? "loading")

  return {
    readiness,
    status,
    declaredRelayUrls:
      readiness?.state === "ready" ||
      readiness?.state === "distribution_pending"
        ? readiness.relayUrls
        : [],
    retainedRelayUrls:
      readiness?.state === "signed_empty" ||
      readiness?.state === "malformed" ||
      readiness?.state === "distribution_pending"
        ? readiness.retainedRelayUrls
        : [],
    stale:
      readiness?.state === "ready" ||
      readiness?.state === "distribution_pending" ||
      readiness?.state === "signed_empty" ||
      readiness?.state === "malformed"
        ? readiness.stale
        : false,
    distributionRepairable:
      readiness?.state === "ready" ||
      readiness?.state === "distribution_pending" ||
      readiness?.state === "signed_empty" ||
      readiness?.state === "malformed"
        ? readiness.distributionRepairable
        : false,
    // Disabled TanStack queries are pending without being "loading". Keep the
    // public hook aligned with its own status projection so consumers cannot
    // render a not-configured state before the account projection is ready.
    isLoading: status === "loading",
    isRefetching: readinessQuery.isRefetching,
    error:
      readinessQuery.error instanceof Error
        ? readinessQuery.error.message
        : readinessQuery.error
          ? "Inbox declaration lookup failed"
          : null,
    refetch: () => {
      void readinessQuery.refetch()
    },
  }
}
