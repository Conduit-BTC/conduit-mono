import { useEffect, useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  inspectOwnPrivateMessageRelayReadiness,
  publishPrivateMessageRelayDeclaration,
  redistributePrivateMessageRelayDeclaration,
  redistributePrivateMessageRelayDeclarationAcrossPlans,
  type OwnPrivateMessageRelayReadiness,
} from "../protocol/messaging"
import { areSameSignedInboxDeclarationEvent } from "../protocol/inbox-declaration-evidence"
import { getNdk } from "../protocol/ndk"
import {
  getCachedInboxDeclarationEvidence,
  inboxDeclarationPublishRelayUrls,
  invalidateInboxDeclaration,
  MAX_DECLARED_INBOX_WRITE_RELAYS,
  readRetainedInboxDeclarationEvidence,
  resolveInboxDeclaration,
  sharedInboxDiscoveryRelayUrls,
  type InboxDeclarationResolution,
} from "../protocol/private-message-routing"
import {
  normalizeSecureOrIsolatedE2eRelayUrls,
  subscribeRelaySettingsChanges,
} from "../protocol/relay-settings"

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

  const publishMutation = useMutation({
    mutationFn: async (intent: {
      relayUrls: readonly string[]
      reviewedEventId: string | null
      reviewedState: OwnPrivateMessageRelayReadiness["state"] | null
      reviewedStale: boolean
      reviewedDistributionRepairable: boolean
    }) => {
      const { relayUrls } = intent
      if (!pubkey) throw new Error("Signer not connected")
      const ndk = getNdk()

      const sharedRelayUrls = sharedInboxDiscoveryRelayUrls()
      // Reconcile network, durable, and process evidence at the explicit click
      // boundary. Render-time readiness may have been superseded by another
      // tab and must never authorize a stale replacement or redistribution.
      const readiness = await inspectOwnPrivateMessageRelayReadiness(pubkey, {
        relayUrls: sharedRelayUrls,
      })
      if (
        readiness.state === "lookup_partial" ||
        readiness.state === "lookup_unavailable"
      ) {
        throw new Error(
          "Private inbox evidence changed or is unavailable. Retry the readiness check."
        )
      }
      if (
        readiness.state === "distribution_pending" &&
        !readiness.distributionRepairable
      ) {
        throw new Error(
          "The pending declaration cannot be retried until shared discovery completes."
        )
      }
      if (
        (readiness.state === "ready" ||
          readiness.state === "signed_empty" ||
          readiness.state === "malformed") &&
        readiness.stale &&
        !readiness.distributionRepairable
      ) {
        throw new Error(
          "The retained declaration is stale. Retry the readiness check before publishing."
        )
      }

      const evidence = getCachedInboxDeclarationEvidence(pubkey)
      const currentEventId = evidence?.current.signedEvent.id ?? null
      const inspectedEventId = "eventId" in readiness ? readiness.eventId : null
      const currentStale = "stale" in readiness ? readiness.stale : false
      const currentDistributionRepairable =
        "distributionRepairable" in readiness
          ? readiness.distributionRepairable
          : false
      if (
        intent.reviewedEventId !== currentEventId ||
        inspectedEventId !== currentEventId ||
        intent.reviewedState !== readiness.state ||
        intent.reviewedStale !== currentStale ||
        intent.reviewedDistributionRepairable !== currentDistributionRepairable
      ) {
        throw new Error(
          "Private inbox evidence changed after this action was reviewed. Review the current state and try again."
        )
      }

      let expectedRelayUrls = [...relayUrls]
      let publishedEvent: Awaited<
        ReturnType<typeof publishPrivateMessageRelayDeclaration>
      >
      const exactRedistribution = Boolean(
        (readiness?.state === "ready" ||
          readiness?.state === "distribution_pending") &&
        readiness.distributionRepairable
      )
      if (exactRedistribution) {
        const durableEvidence =
          await readRetainedInboxDeclarationEvidence(pubkey)
        if (
          !evidence ||
          !durableEvidence ||
          durableEvidence.current.state !== "declared" ||
          durableEvidence.current.signedEvent.id !== currentEventId ||
          !areSameSignedInboxDeclarationEvent(
            evidence.current.signedEvent,
            durableEvidence.current.signedEvent
          )
        ) {
          throw new Error(
            "The retained declaration is unavailable. Retry the readiness check."
          )
        }
        const effectiveRelays = normalizeSecureOrIsolatedE2eRelayUrls(
          durableEvidence.current.secureRelayUrls
        ).slice(0, MAX_DECLARED_INBOX_WRITE_RELAYS)
        const selected = [
          ...normalizeSecureOrIsolatedE2eRelayUrls(relayUrls),
        ].sort()
        const effective = [...effectiveRelays].sort()
        if (
          selected.length !== effective.length ||
          selected.some((relayUrl, index) => relayUrl !== effective[index])
        ) {
          throw new Error(
            "Redistribution must preserve the retained declaration relay set"
          )
        }
        const pendingPublishRelayUrls =
          durableEvidence.pendingDistribution?.publishRelayUrls
        const processPending = evidence.pendingDistribution
        if (
          readiness.state === "distribution_pending" &&
          (Boolean(processPending) !== Boolean(pendingPublishRelayUrls) ||
            (processPending &&
              pendingPublishRelayUrls &&
              (!areSameSignedInboxDeclarationEvent(
                processPending.signedEvent,
                durableEvidence.pendingDistribution?.signedEvent
              ) ||
                processPending.publishRelayUrls.length !==
                  pendingPublishRelayUrls.length ||
                processPending.publishRelayUrls.some(
                  (relayUrl, index) =>
                    relayUrl !== pendingPublishRelayUrls[index]
                ))))
        ) {
          throw new Error(
            "The retained declaration is unavailable. Retry the readiness check."
          )
        }
        publishedEvent = pendingPublishRelayUrls
          ? await redistributePrivateMessageRelayDeclarationAcrossPlans({
              pubkey,
              signedEvent: durableEvidence.current.signedEvent,
              ndk,
              storedPublishRelayUrls: pendingPublishRelayUrls,
              currentSharedRelayUrls: sharedRelayUrls,
            })
          : await redistributePrivateMessageRelayDeclaration({
              pubkey,
              signedEvent: durableEvidence.current.signedEvent,
              ndk,
              publishRelayUrls: inboxDeclarationPublishRelayUrls(),
            })
        expectedRelayUrls = [...durableEvidence.current.secureRelayUrls]
      } else {
        if (!ndk.signer) throw new Error("Signer not connected")
        if (readiness.state !== "not_observed" && !evidence) {
          throw new Error(
            "The retained declaration frontier is unavailable. Retry the readiness check."
          )
        }
        publishedEvent = await publishPrivateMessageRelayDeclaration({
          pubkey,
          signer: ndk.signer,
          ndk,
          relayUrls,
          frontierCreatedAt: evidence?.current.signedEvent.created_at ?? null,
          expectedFrontierEventId: currentEventId,
        })
      }

      // Read back fresh before reporting confirmed; a publish ACK alone does
      // not prove the declaration is discoverable. The publish primed the
      // declaration cache, so a degraded lookup falls back to it instead of
      // failing a publish that relays already accepted.
      const resolution = await resolveInboxDeclaration(pubkey, {
        freshnessMs: 0,
        relayUrls: sharedRelayUrls,
        sharedConfirmationRelayUrls: sharedRelayUrls,
        allowLocalRelayUrlsForPubkey: pubkey,
      })
      return verifyDeclarationReadBack(resolution, {
        eventId: publishedEvent.id,
        relayUrls: expectedRelayUrls,
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
      publishMutation.mutate({
        relayUrls,
        reviewedEventId:
          readiness && "eventId" in readiness ? readiness.eventId : null,
        reviewedState: readiness?.state ?? null,
        reviewedStale:
          readiness && "stale" in readiness ? readiness.stale : false,
        reviewedDistributionRepairable:
          readiness && "distributionRepairable" in readiness
            ? readiness.distributionRepairable
            : false,
      })
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
