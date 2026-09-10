import { useEffect, useMemo, useRef } from "react"
import type { NDKSigner } from "@nostr-dev-kit/ndk"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  inspectOwnPrivateMessageRelayReadiness,
  type OwnPrivateMessageRelayReadiness,
} from "../protocol/messaging"
import {
  publishAccountNetworkMutation,
  redistributeAccountNetworkInboxDeclaration,
  retryAccountNetworkMutation,
  reviewAccountNetworkMutation,
  type AccountNetworkMutationDependencies,
  type AccountNetworkMutationResult,
  type AccountNetworkRelayRoles,
  type ReviewedAccountNetworkMutation,
} from "../protocol/account-network-mutation"
import { EVENT_KINDS } from "../protocol/kinds"
import type { AccountNetworkPreferencesReconciliation } from "../protocol/network-preferences"
import { createNdkNostrEventSigner } from "../protocol/ndk-nostr-event-signer"
import { NostrSignerError } from "../protocol/nostr-event-signer"
import {
  invalidateInboxDeclaration,
  sharedInboxDiscoveryRelayUrls,
  type InboxDeclarationResolution,
} from "../protocol/private-message-routing"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "../protocol/relay-settings"
import { useAuth } from "../context/AuthContext"
import { useConduitSession } from "../context/ConduitSessionContext"

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
  if (
    resolution.state === "not_observed" ||
    resolution.state === "signed_empty" ||
    resolution.state === "malformed"
  ) {
    throw new Error(
      "The declaration was accepted but is not discoverable yet. Retry the readiness check."
    )
  }
  if (
    expected &&
    ((resolution.eventId !== undefined &&
      resolution.eventId !== expected.eventId) ||
      (resolution.observation?.coverage === "complete" &&
        resolution.observation.eventId !== expected.eventId))
  ) {
    throw new Error(
      "The declaration was accepted but is not discoverable yet. Retry the readiness check."
    )
  }
  if (resolution.state !== "declared") {
    return { confirmed: false }
  }
  if (!expected) return { confirmed: !resolution.stale }

  const actualRelays = [
    ...normalizeSecureOrIsolatedE2eRelayUrls(resolution.relayUrls),
  ].sort()
  const expectedRelays = [
    ...normalizeSecureOrIsolatedE2eRelayUrls(expected.relayUrls),
  ].sort()
  const successfulSources = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(
      resolution.observation?.successfulRelayUrls ?? []
    )
  )
  const canonicalSharedSources = new Set(sharedInboxDiscoveryRelayUrls())
  const durableSharedSources = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(
      resolution.sharedSourceRelayUrls ?? []
    ).filter((relayUrl) => canonicalSharedSources.has(relayUrl))
  )
  const exactSourceObservedThisRun = normalizeSecureOrIsolatedE2eRelayUrls(
    resolution.observation?.eventSourceRelayUrls ?? []
  ).some(
    (relayUrl) =>
      successfulSources.has(relayUrl) && durableSharedSources.has(relayUrl)
  )
  return {
    confirmed:
      resolution.eventId === expected.eventId &&
      resolution.observation?.eventId === expected.eventId &&
      exactSourceObservedThisRun &&
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
  /** Relays in the current declaration; empty unless status is ready. */
  declaredRelayUrls: string[]
  /** Last usable declaration retained only as recovery evidence. */
  retainedRelayUrls: string[]
  /** True when readiness comes from a cached declaration during a degraded lookup. */
  stale: boolean
  /** A complete shared lookup permits an explicit redistribution/repair. */
  distributionRepairable: boolean
  isLoading: boolean
  isRefetching: boolean
  /** Non-null when the readiness lookup itself rejected (signer/transport). */
  error: string | null
  refetch: () => void
  /** Publish a selected repair or redistribute the exact retained event. */
  publishDeclaration: (relayUrls: readonly string[]) => void
  publishing: boolean
  publishError: string | null
  publishSuccess: boolean
  /** True when the publish succeeded but the fresh read-back was degraded. */
  publishConfirmationPending: boolean
  resetPublishState: () => void
}

interface AccountMutationAuthority {
  authGeneration: number
  method: "nip07" | "nip46" | null
  pubkey: string | null
  relayScope: string | null
  sessionPubkey: string | null
  signer: NDKSigner | null
  status: string
}

function sameAccountMutationAuthority(
  current: AccountMutationAuthority,
  expected: AccountMutationAuthority
): boolean {
  return (
    current.authGeneration === expected.authGeneration &&
    current.method === expected.method &&
    current.pubkey === expected.pubkey &&
    current.relayScope === expected.relayScope &&
    current.sessionPubkey === expected.sessionPubkey &&
    current.signer === expected.signer &&
    current.status === expected.status
  )
}

function rolesForInboxDeclarationReview(
  reconciliation: AccountNetworkPreferencesReconciliation,
  inboxRelayUrls: readonly string[]
): AccountNetworkRelayRoles[] {
  const rolesByUrl = new Map<string, AccountNetworkRelayRoles>()
  for (const preference of reconciliation.ownerRelayList.preferences) {
    rolesByUrl.set(preference.url, {
      url: preference.url,
      read: preference.readEnabled,
      publish: preference.writeEnabled,
      privateInbox: false,
    })
  }
  for (const relayUrl of inboxRelayUrls) {
    const current = rolesByUrl.get(relayUrl)
    rolesByUrl.set(relayUrl, {
      url: relayUrl,
      read: current?.read ?? false,
      publish: current?.publish ?? false,
      privateInbox: true,
    })
  }
  return [...rolesByUrl.values()]
}

/** Review a kind:10050-only edit while preserving the current NIP-65 roles. */
export function reviewInboxDeclarationAccountMutation(
  reconciliation: AccountNetworkPreferencesReconciliation,
  relayUrls: readonly string[]
): ReviewedAccountNetworkMutation {
  const reviewed = reviewAccountNetworkMutation(reconciliation, {
    type: "set_roles",
    relays: rolesForInboxDeclarationReview(reconciliation, relayUrls),
  })
  if (
    reviewed.changedKinds.includes(EVENT_KINDS.RELAY_LIST) ||
    reviewed.signerRequestCount > 1
  ) {
    throw new Error(
      "Publish the current relay list first, then review the Private inbox change again."
    )
  }
  return reviewed
}

export type InboxDeclarationAccountMutationPlan =
  | { type: "publish"; reviewed: ReviewedAccountNetworkMutation }
  | { type: "redistribute" }
  | { type: "retry" }

export function planInboxDeclarationAccountMutation(input: {
  reconciliation: AccountNetworkPreferencesReconciliation
  readiness: OwnPrivateMessageRelayReadiness | undefined
  relayUrls: readonly string[]
}): InboxDeclarationAccountMutationPlan {
  const currentRelayUrls =
    input.reconciliation.inboxDeclaration.state === "distribution_pending"
      ? (input.reconciliation.inboxDeclaration.pendingRelayUrls ?? [])
      : input.reconciliation.inboxDeclaration.state === "declared"
        ? input.reconciliation.inboxDeclaration.relayUrls
        : []
  const current = [
    ...normalizeSecureOrIsolatedE2eRelayUrls(currentRelayUrls),
  ].sort()
  const selected = [
    ...normalizeSecureOrIsolatedE2eRelayUrls(input.relayUrls),
  ].sort()
  const inboxUnchanged =
    current.length === selected.length &&
    current.every((relayUrl, index) => relayUrl === selected[index])
  if (
    inboxUnchanged &&
    input.reconciliation.inboxDeclaration.state === "distribution_pending"
  ) {
    return { type: "retry" }
  }
  if (
    inboxUnchanged &&
    input.readiness &&
    "distributionRepairable" in input.readiness &&
    input.readiness.distributionRepairable &&
    (input.readiness.state === "ready" ||
      input.readiness.state === "distribution_pending")
  ) {
    if (
      input.readiness.eventId !== input.reconciliation.inboxDeclaration.eventId
    ) {
      throw new Error(
        "Private inbox evidence changed after this action was reviewed. Review the current state and try again."
      )
    }
    return { type: "redistribute" }
  }
  return {
    type: "publish",
    reviewed: reviewInboxDeclarationAccountMutation(
      input.reconciliation,
      input.relayUrls
    ),
  }
}

function inboxMutationConfirmed(result: AccountNetworkMutationResult): boolean {
  const checkpoint = result.checkpoints.find(
    (entry) => entry.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
  )
  return !checkpoint?.pending
}

export function useInboxDeclaration(
  pubkey: string | null | undefined,
  options: UseInboxDeclarationOptions = {}
): UseInboxDeclarationResult {
  const auth = useAuth()
  const session = useConduitSession()
  const authorityRef = useRef<AccountMutationAuthority>({
    authGeneration: auth.authGeneration,
    method: auth.method,
    pubkey: auth.pubkey,
    relayScope: session.relayScope,
    sessionPubkey: session.pubkey,
    signer: auth.signer,
    status: auth.status,
  })
  const queryClient = useQueryClient()
  const queryKey = useMemo(
    () => [INBOX_DECLARATION_QUERY_KEY, pubkey ?? "none"],
    [pubkey]
  )
  const mutationContextKey = JSON.stringify([
    pubkey ?? null,
    options.relayScope?.trim() ?? null,
  ])
  const mutationContextKeyRef = useRef(mutationContextKey)

  useEffect(() => {
    authorityRef.current = {
      authGeneration: auth.authGeneration,
      method: auth.method,
      pubkey: auth.pubkey,
      relayScope: session.relayScope,
      sessionPubkey: session.pubkey,
      signer: auth.signer,
      status: auth.status,
    }
  }, [
    auth.authGeneration,
    auth.method,
    auth.pubkey,
    auth.signer,
    auth.status,
    session.pubkey,
    session.relayScope,
  ])

  useEffect(() => {
    mutationContextKeyRef.current = mutationContextKey
  }, [mutationContextKey])

  const readinessQuery = useQuery({
    queryKey,
    enabled: !!pubkey && (options.enabled ?? true),
    queryFn: () => inspectOwnPrivateMessageRelayReadiness(pubkey!),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  const publishMutation = useMutation({
    mutationFn: async (intent: { relayUrls: readonly string[] }) => {
      if (!pubkey) throw new Error("Signer not connected")
      const accountNetworkPreferences = session.accountNetworkPreferences
      const reconciliation = accountNetworkPreferences.reconciliation
      if (
        session.mode !== "signed_in" ||
        session.pubkey !== pubkey ||
        session.relayScope !== options.relayScope?.trim() ||
        reconciliation?.projection.pubkey !== pubkey ||
        reconciliation.projection.relayScope !== options.relayScope?.trim()
      ) {
        throw new Error(
          "The active Network account changed. Reload and try again."
        )
      }
      if (accountNetworkPreferences.status !== "ready") {
        throw new Error(
          "Network evidence is still refreshing. Wait for the current account check and try again."
        )
      }
      const plan = planInboxDeclarationAccountMutation({
        reconciliation,
        readiness: readinessQuery.data,
        relayUrls: intent.relayUrls,
      })
      const expectedAuthority = { ...authorityRef.current }
      const expectedContextKey = mutationContextKey
      const shouldContinue = (): boolean =>
        mutationContextKeyRef.current === expectedContextKey &&
        sameAccountMutationAuthority(authorityRef.current, expectedAuthority)
      if (
        expectedAuthority.status !== "connected" ||
        expectedAuthority.pubkey !== pubkey ||
        expectedAuthority.sessionPubkey !== pubkey ||
        expectedAuthority.relayScope !== options.relayScope?.trim()
      ) {
        throw new NostrSignerError("authority_changed")
      }
      const dependencies: AccountNetworkMutationDependencies = {
        shouldContinue,
      }
      let result: AccountNetworkMutationResult
      if (plan.type === "retry") {
        result = await retryAccountNetworkMutation({
          pubkey,
          authenticatedPubkey: pubkey,
          kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
          dependencies,
        })
      } else if (plan.type === "redistribute") {
        result = await redistributeAccountNetworkInboxDeclaration({
          pubkey,
          authenticatedPubkey: pubkey,
          dependencies,
        })
      } else {
        result = await publishAccountNetworkMutation({
          reviewed: plan.reviewed,
          authenticatedPubkey: pubkey,
          ...(plan.reviewed.signerRequestCount > 0
            ? {
                signer:
                  expectedAuthority.signer && expectedAuthority.method
                    ? createNdkNostrEventSigner(
                        expectedAuthority.signer,
                        pubkey,
                        expectedAuthority.method
                      )
                    : undefined,
              }
            : {}),
          dependencies,
        })
      }
      if (!shouldContinue()) throw new NostrSignerError("authority_changed")
      return { confirmed: inboxMutationConfirmed(result) }
    },
    onSettled: async () => {
      if (pubkey) invalidateInboxDeclaration(pubkey)
      session.accountNetworkPreferences.refetch()
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
    // render a not-configured state before relay settings enable the lookup.
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
    publishDeclaration: (relayUrls) => {
      publishMutation.mutate({ relayUrls })
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
