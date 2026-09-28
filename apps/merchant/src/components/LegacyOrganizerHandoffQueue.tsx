import { useLayoutEffect, useMemo, useRef, useState } from "react"
import type { NDKSigner } from "@nostr-dev-kit/ndk"
import { useQuery } from "@tanstack/react-query"
import {
  decodeEventMarketReference,
  getEventMarket,
  getNdk,
  readEventMarketReadyReceipts,
  useAuth,
  useConduitSession,
  type EventMarketOrganizerClaim,
  type EventMarketPrivateTransportOptions,
} from "@conduit/core"
import {
  acknowledgeOrganizerHandoff,
  loadEventMarketHandoffDeliveries,
  resolveOrganizerHandoffAckReadiness,
  resolveOrganizerHandoffMerchandise,
  retryStoredOrganizerHandoffAck,
} from "../lib/event-market-handoff"
import {
  OrganizerHandoffReceiptQueue,
  type OrganizerHandoffMerchandiseRead,
} from "./OrganizerHandoffReceiptQueue"

const handoffDependencies = {
  read: readEventMarketReadyReceipts,
  market: getEventMarket,
  merchandise: resolveOrganizerHandoffMerchandise,
  signer: async (): Promise<NDKSigner> => {
    const ndk = await getNdk()
    if (!ndk.signer) throw new Error("Organizer signer is not connected.")
    return ndk.signer
  },
}

/** Named legacy fulfillment compatibility; this never writes public event records. */
export async function fulfillLegacyOrganizerClaim(
  input: {
    organizerPubkey: string
    collectionCoordinate: string
    claim: EventMarketOrganizerClaim
    shouldContinue: () => boolean
    storage?: Storage
    transport?: EventMarketPrivateTransportOptions
  },
  dependencies = handoffDependencies
) {
  const decoded = decodeEventMarketReference(
    input.collectionCoordinate,
    [30405]
  )
  if (!decoded || decoded.authorPubkey !== input.organizerPubkey)
    throw new Error("This historical event does not belong to the organizer.")
  function assertCurrent() {
    if (!input.shouldContinue()) throw new Error("Organizer session changed.")
  }
  assertCurrent()
  const transport = {
    ...input.transport,
    authenticatedPubkey: input.organizerPubkey,
    shouldContinue: input.shouldContinue,
  }
  const saved = loadEventMarketHandoffDeliveries(
    input.organizerPubkey,
    input.storage
  ).find(
    (delivery) =>
      delivery.record.messageType === "organizer_handoff_ack" &&
      delivery.record.graph.collection.coordinate === decoded.coordinate &&
      delivery.record.readyReceiptId === input.claim.receipt.id.toLowerCase()
  )
  if (saved)
    return retryStoredOrganizerHandoffAck({
      organizerPubkey: input.organizerPubkey,
      delivery: saved,
      storage: input.storage,
      transport,
    })
  const receipts = await dependencies.read({
    organizerPubkey: input.organizerPubkey,
    collectionCoordinate: decoded.coordinate,
  })
  assertCurrent()
  const claim = receipts.data.find(
    (candidate) => candidate.receipt.id === input.claim.receipt.id
  )
  if (!claim)
    throw new Error("The exact organizer receipt is no longer current.")
  const merchandise = await dependencies.merchandise({
    organizerPubkey: input.organizerPubkey,
    authenticatedPubkey: input.organizerPubkey,
    claim,
    shouldContinue: input.shouldContinue,
  })
  assertCurrent()
  const market = await dependencies.market({
    reference: decoded.coordinate,
    authenticatedPubkey: input.organizerPubkey,
    shouldContinue: input.shouldContinue,
  })
  assertCurrent()
  const gate = resolveOrganizerHandoffAckReadiness({
    claim,
    market,
    merchandise,
  })
  if (gate.state !== "ready")
    throw new Error(`Historical handoff is blocked: ${gate.reason}.`)
  const signer = await dependencies.signer()
  assertCurrent()
  return acknowledgeOrganizerHandoff({
    organizerPubkey: input.organizerPubkey,
    claim,
    market,
    merchandise,
    signer,
    storage: input.storage,
    transport,
  })
}

export function LegacyOrganizerHandoffQueue({
  organizerPubkey,
  collectionCoordinate,
}: {
  organizerPubkey: string
  collectionCoordinate: string
}) {
  const {
    accountPubkey,
    pubkey,
    signerReadiness,
    authGeneration,
    isAuthGenerationCurrent,
  } = useAuth()
  const session = useConduitSession()
  const active = useRef(true)
  const running = useRef(false)
  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const ownerReady =
    accountPubkey === organizerPubkey &&
    pubkey === organizerPubkey &&
    signerReadiness === "ready"
  const shouldContinue = () =>
    active.current && isAuthGenerationCurrent(authGeneration)
  const [revision, setRevision] = useState(0)
  const [pendingReceiptId, setPendingReceiptId] = useState<string | null>(null)
  const [actionError, setActionError] = useState("")
  const ackDeliveries = useMemo(() => {
    void revision
    return loadEventMarketHandoffDeliveries(organizerPubkey).filter(
      (delivery) =>
        delivery.record.messageType === "organizer_handoff_ack" &&
        delivery.record.graph.collection.coordinate === collectionCoordinate
    )
  }, [organizerPubkey, collectionCoordinate, revision])
  const scope = [
    organizerPubkey,
    collectionCoordinate,
    session.relayScope,
    authGeneration,
  ]
  const receipts = useQuery({
    queryKey: ["legacy-organizer-handoff-receipts", ...scope],
    enabled: ownerReady && session.relaySettingsReady,
    queryFn: async ({ signal }) => {
      if (signal.aborted || !shouldContinue())
        throw new Error("Organizer session changed.")
      const result = await readEventMarketReadyReceipts({
        organizerPubkey,
        collectionCoordinate,
      })
      if (signal.aborted || !shouldContinue())
        throw new Error("Organizer session changed.")
      return result
    },
    retry: false,
    refetchInterval: 30_000,
  })
  const claims = receipts.data?.data ?? []
  const graph = useQuery({
    queryKey: ["legacy-organizer-handoff-graph", ...scope],
    enabled: ownerReady && session.relaySettingsReady && claims.length > 0,
    queryFn: ({ signal }) =>
      getEventMarket({
        reference: collectionCoordinate,
        authenticatedPubkey: organizerPubkey,
        signal,
        shouldContinue: () => !signal.aborted && shouldContinue(),
      }),
    retry: false,
  })
  const merchandise = useQuery({
    // Core verification certificates belong to the exact result object.
    structuralSharing: false,
    queryKey: [
      "legacy-organizer-handoff-merchandise",
      ...scope,
      claims
        .map((claim) => claim.receipt.id)
        .sort()
        .join(":"),
    ],
    enabled: ownerReady && session.relaySettingsReady && claims.length > 0,
    queryFn: async ({ signal }) =>
      Object.fromEntries(
        await Promise.all(
          claims.map(async (claim) => {
            try {
              return [
                claim.receipt.id,
                {
                  resolution: await resolveOrganizerHandoffMerchandise({
                    organizerPubkey,
                    authenticatedPubkey: organizerPubkey,
                    claim,
                    signal,
                    shouldContinue: () => !signal.aborted && shouldContinue(),
                  }),
                  error: false,
                },
              ] as const
            } catch {
              return [claim.receipt.id, { error: true }] as const
            }
          })
        )
      ) as Record<string, OrganizerHandoffMerchandiseRead>,
    retry: false,
  })
  const readiness = Object.fromEntries(
    claims.map((claim) => [
      claim.receipt.id,
      graph.data
        ? resolveOrganizerHandoffAckReadiness({
            claim,
            market: graph.data,
            merchandise: merchandise.data?.[claim.receipt.id]?.resolution,
          })
        : undefined,
    ])
  )
  function refresh() {
    void receipts.refetch()
    if (claims.length) {
      void graph.refetch()
      void merchandise.refetch()
    }
  }
  async function acknowledge(claim: EventMarketOrganizerClaim) {
    if (!ownerReady || running.current || !shouldContinue()) return
    running.current = true
    setPendingReceiptId(claim.receipt.id)
    setActionError("")
    try {
      await fulfillLegacyOrganizerClaim({
        organizerPubkey,
        collectionCoordinate,
        claim,
        shouldContinue,
      })
      if (shouldContinue()) refresh()
    } catch (cause) {
      if (shouldContinue())
        setActionError(
          cause instanceof Error
            ? cause.message
            : "The historical handoff update could not be delivered."
        )
    } finally {
      running.current = false
      if (shouldContinue()) {
        setRevision((current) => current + 1)
        setPendingReceiptId(null)
      }
    }
  }
  return (
    <OrganizerHandoffReceiptQueue
      organizerPubkey={organizerPubkey}
      authenticatedPubkey={ownerReady ? organizerPubkey : null}
      shouldContinue={shouldContinue}
      claims={claims}
      ackDeliveries={ackDeliveries}
      merchandiseReads={merchandise.data ?? {}}
      merchandiseLoading={merchandise.isFetching}
      ackReadinessByReceiptId={readiness}
      loading={receipts.isFetching}
      stale={receipts.data?.stale ?? false}
      decryptFailureCount={receipts.data?.decryptFailureCount ?? 0}
      discoveryEvidenceComplete={
        !!receipts.data &&
        !receipts.data.stale &&
        receipts.data.decryptFailureCount === 0 &&
        receipts.data.inbox?.declarationState === "declared" &&
        receipts.data.inbox?.coverage === "complete"
      }
      error={receipts.isError}
      actionError={actionError}
      freshActionsDisabled={!ownerReady || pendingReceiptId !== null}
      retryActionsDisabled={!ownerReady || pendingReceiptId !== null}
      pendingReceiptId={pendingReceiptId}
      onAcknowledge={(claim) => void acknowledge(claim)}
      onRefresh={refresh}
    />
  )
}
