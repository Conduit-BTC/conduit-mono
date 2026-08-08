import { useEffect, useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  inspectOwnPrivateMessageRelayReadiness,
  publishPrivateMessageRelayDeclaration,
  type OwnPrivateMessageRelayReadiness,
} from "../protocol/messaging"
import { getNdk } from "../protocol/ndk"
import {
  invalidateInboxDeclaration,
  resolveInboxDeclaration,
  secureRelayUrls,
  type InboxDeclarationResolution,
} from "../protocol/private-message-routing"
import { subscribeRelaySettingsChanges } from "../protocol/relay-settings"

/**
 * NIP-17 inbox declaration readiness + repair (CND-208).
 *
 * Network settings is the only surface that publishes or repairs the
 * kind-10050 declaration. Publishing is always an explicit, signed action:
 * this hook never signs without a caller-triggered mutation. After a publish,
 * the exact signed event is read back from discovery relays before the account
 * is reported ready.
 */

export const INBOX_DECLARATION_QUERY_KEY = "inbox-declaration"

export interface DeclarationReadBackResult {
  /** True when a fresh lookup confirmed the declaration on relays. */
  confirmed: boolean
}

export interface ExpectedInboxDeclaration {
  eventId: string
  relayUrls: readonly string[]
}

/**
 * Judge a post-publish read-back. A complete read that cannot find the
 * declaration is a real failure; a degraded lookup that fell back to the
 * primed cache means the publish succeeded but confirmation is pending.
 */
export function verifyDeclarationReadBack(
  resolution: InboxDeclarationResolution,
  expected?: ExpectedInboxDeclaration
): DeclarationReadBackResult {
  if (resolution.state === "not_declared" || resolution.state === "malformed") {
    throw new Error(
      "The declaration was accepted but is not discoverable yet. Retry the readiness check."
    )
  }
  if (resolution.state !== "declared" || resolution.stale) {
    return { confirmed: false }
  }
  if (!expected) return { confirmed: true }

  const actualRelays = [...secureRelayUrls(resolution.relayUrls)].sort()
  const expectedRelays = [...secureRelayUrls(expected.relayUrls)].sort()
  return {
    confirmed:
      resolution.eventId === expected.eventId &&
      actualRelays.length === expectedRelays.length &&
      actualRelays.every(
        (relayUrl, index) => relayUrl === expectedRelays[index]
      ),
  }
}

export interface UseInboxDeclarationOptions {
  enabled?: boolean
  /** Account relay-settings scope used to refresh discovery after relay import. */
  relayScope?: string | null
}

export type InboxDeclarationStatus =
  | "loading"
  | "ready"
  | "not_declared"
  | "malformed"
  | "lookup_partial"
  | "lookup_unavailable"

export interface UseInboxDeclarationResult {
  readiness: OwnPrivateMessageRelayReadiness | undefined
  /** Derived presentational status; lookup rejections map to lookup_unavailable. */
  status: InboxDeclarationStatus
  /** Relays in the current declaration; empty unless status is ready. */
  declaredRelayUrls: string[]
  /** True when readiness comes from a cached declaration during a degraded lookup. */
  stale: boolean
  isLoading: boolean
  isRefetching: boolean
  /** Non-null when the readiness lookup itself rejected (signer/transport). */
  error: string | null
  refetch: () => void
  /** Sign and publish an exact declaration for the selected relays. */
  publishDeclaration: (relayUrls: readonly string[]) => void
  publishing: boolean
  publishError: string | null
  publishSuccess: boolean
  /** True when the publish succeeded but the fresh read-back was degraded. */
  publishConfirmationPending: boolean
  resetPublishState: () => void
}

export function useInboxDeclaration(
  pubkey: string | null | undefined,
  options: UseInboxDeclarationOptions = {}
): UseInboxDeclarationResult {
  const queryClient = useQueryClient()
  const queryKey = useMemo(
    () => [INBOX_DECLARATION_QUERY_KEY, pubkey ?? "none"],
    [pubkey]
  )

  const readinessQuery = useQuery({
    queryKey,
    enabled: !!pubkey && (options.enabled ?? true),
    queryFn: () => inspectOwnPrivateMessageRelayReadiness(pubkey!),
    staleTime: 30_000,
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

  const publishMutation = useMutation({
    mutationFn: async (relayUrls: readonly string[]) => {
      if (!pubkey) throw new Error("Signer not connected")
      const ndk = getNdk()
      if (!ndk.signer) throw new Error("Signer not connected")

      const publishedEvent = await publishPrivateMessageRelayDeclaration({
        pubkey,
        signer: ndk.signer,
        ndk,
        relayUrls,
      })

      // Read back fresh before reporting confirmed; a publish ACK alone does
      // not prove the declaration is discoverable. The publish primed the
      // declaration cache, so a degraded lookup falls back to it instead of
      // failing a publish that relays already accepted.
      const resolution = await resolveInboxDeclaration(pubkey, {
        freshnessMs: 0,
      })
      return verifyDeclarationReadBack(resolution, {
        eventId: publishedEvent.id,
        relayUrls,
      })
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey })
    },
  })

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
    declaredRelayUrls: readiness?.state === "ready" ? readiness.relayUrls : [],
    stale: readiness?.state === "ready" && readiness.stale,
    isLoading: readinessQuery.isLoading,
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
    publishDeclaration: (relayUrls) => {
      publishMutation.mutate(relayUrls)
    },
    publishing: publishMutation.isPending,
    publishError:
      publishMutation.error instanceof Error
        ? publishMutation.error.message
        : publishMutation.error
          ? "Could not publish the inbox declaration"
          : null,
    publishSuccess: publishMutation.isSuccess,
    publishConfirmationPending: publishMutation.data
      ? !publishMutation.data.confirmed
      : false,
    resetPublishState: () => {
      publishMutation.reset()
    },
  }
}
