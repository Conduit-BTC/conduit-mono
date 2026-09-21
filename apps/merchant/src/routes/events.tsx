import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router"
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  getNdk,
  readEventMarketReadyReceipts,
  useAuth,
  useConduitSession,
  type EventMarketOrganizerClaim,
} from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SignedActionStatus,
  Skeleton,
  type SignedActionStatusState,
} from "@conduit/ui"
import { MerchantEventsTimeline } from "../components/MerchantEventsTimeline"
import { MerchantEventMarketPanel } from "../components/MerchantEventMarketPanel"
import { OrganizerEventMarketEditor } from "../components/OrganizerEventMarketEditor"
import {
  OrganizerHandoffReceiptQueue,
  type OrganizerHandoffMerchandiseRead,
} from "../components/OrganizerHandoffReceiptQueue"
import {
  OrganizerEventMarketDeliveryList,
  OrganizerEventMarketPanel,
} from "../components/OrganizerEventMarketPanel"
import {
  loadOrganizerEventMarketDeliveryOutbox,
  mergeOrganizerEventMarketDeliveryState,
  organizerEventMarketReferenceWithAllDeliveryRelayHints,
  organizerEventMarketReferenceWithDeliveryRelayHints,
  organizerEventMarketReferencesMatch,
  organizerEventMarketToForm,
  parseOrganizerEventMarketReference,
  publishMerchantOrganizerEventMarket,
  publishMerchantOrganizerMembership,
  publishMerchantOrganizerOrderAcceptance,
  reconcileAcknowledgedMerchantOrganizerCollectionEvidence,
  resolveOrganizerEventMarket,
  retryMerchantOrganizerRecord,
  saveOrganizerEventMarketDelivery,
  type MerchantOrganizerEventMarket,
  type MerchantOrganizerParticipation,
  type MerchantOrganizerPublishResult,
  type MerchantOrganizerRecordDelivery,
} from "../lib/event-market"
import type { OrganizerEventMarketFormValues } from "../lib/event-market-form"
import {
  findSavedOrganizerEventMarketReference,
  expectedOrganizerEventMarketFrontier,
  expectedOrganizerEventMarketFrontiersAfterMembership,
  expectedOrganizerEventMarketFrontiersAfterRetry,
  loadSavedOrganizerEventMarkets,
  organizerEventMarketDeletionRetiresDelivery,
  organizerEventMarketReachesExpectedFrontiers,
  organizerEventMarketRetryRemainsCurrent,
  rememberOrganizerEventMarket,
  selectOrganizerEventMarketResolution,
  shouldResolveOrganizerEventMarketReference,
  type OrganizerCollectionMembershipAction,
  type SavedOrganizerEventMarketReference,
} from "../lib/event-market-workflow"
import { parseMerchantEventsSearch } from "../lib/market-links"
import {
  getMerchantEventSellerDiscoveryState,
  getSettledMerchantEventMarketRead,
  merchantEventMarketEssentialsQueryOptions,
  merchantEventMarketQueryIdentity,
  merchantEventMarketQueryOptions,
} from "../lib/merchant-event-query"
import {
  acknowledgeOrganizerHandoff,
  loadEventMarketHandoffDeliveries,
  resolveOrganizerHandoffAckReadiness,
  resolveOrganizerHandoffMerchandise,
} from "../lib/event-market-handoff"

export const Route = createFileRoute("/events")({
  validateSearch: parseMerchantEventsSearch,
  component: EventsLayout,
})

function EventsLayout() {
  const { event } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  useEffect(() => {
    if (!event) return
    void navigate({
      to: "/events/$collectionRef",
      params: { collectionRef: event },
      search: {},
      replace: true,
    })
  }, [event, navigate])

  if (event) {
    return (
      <div
        className="flex min-h-48 items-center justify-center gap-2 text-sm text-[var(--text-muted)]"
        aria-busy="true"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Opening event…
      </div>
    )
  }

  return <Outlet />
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

type OrganizerMembershipMutationInput = {
  item: MerchantOrganizerParticipation
  action: OrganizerCollectionMembershipAction
  market: MerchantOrganizerEventMarket
  reference: string
}

type OrganizerRetryMutationInput = {
  record: MerchantOrganizerRecordDelivery
  deliveries: readonly MerchantOrganizerRecordDelivery[]
  reference: string
  title?: string
  savedReference?: SavedOrganizerEventMarketReference
}

function expectedEventMarketFrontiers(
  records: readonly MerchantOrganizerRecordDelivery[]
): Partial<SavedOrganizerEventMarketReference> {
  return Object.assign({}, ...records.map(expectedOrganizerEventMarketFrontier))
}

function titleEventMarketFrontiers(
  records: readonly MerchantOrganizerRecordDelivery[]
): Partial<SavedOrganizerEventMarketReference> {
  const frontiers = expectedEventMarketFrontiers(records)
  if (
    !frontiers.expectedCollectionCoordinate ||
    frontiers.expectedCollectionCreatedAt === undefined ||
    !frontiers.expectedCollectionEventId ||
    !frontiers.expectedCalendarCoordinate ||
    frontiers.expectedCalendarCreatedAt === undefined ||
    !frontiers.expectedCalendarEventId
  ) {
    return {}
  }
  return {
    titleCollectionCoordinate: frontiers.expectedCollectionCoordinate,
    titleCollectionCreatedAt: frontiers.expectedCollectionCreatedAt,
    titleCollectionEventId: frontiers.expectedCollectionEventId,
    titleCalendarCoordinate: frontiers.expectedCalendarCoordinate,
    titleCalendarCreatedAt: frontiers.expectedCalendarCreatedAt,
    titleCalendarEventId: frontiers.expectedCalendarEventId,
  }
}

export function EventsDirectoryPage() {
  const { pubkey } = useAuth()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const merchantPubkey = pubkey ?? ""
  const organizerMutationPending =
    useIsMutating({
      predicate: (mutation) =>
        mutation.options.scope?.id ===
        `merchant-organizer-event-authority:${merchantPubkey}`,
    }) > 0
  function openEvent(reference: string): void {
    void navigate({
      to: "/events/$collectionRef",
      params: { collectionRef: reference },
      search: {},
    })
  }

  function createEvent(): void {
    void navigate({ to: "/events/new", search: {} })
  }

  return (
    <div className="mx-auto max-w-[68rem] space-y-6 py-2 sm:py-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-balance font-display text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
            Events
          </h1>
          <p className="mt-2 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Find events where you can sell, or create and manage an event of
            your own.
          </p>
        </div>
        <Button
          type="button"
          onClick={createEvent}
          disabled={organizerMutationPending}
        >
          <Plus aria-hidden="true" />
          Create event
        </Button>
      </header>

      <MerchantEventsTimeline
        merchantPubkey={merchantPubkey}
        search={{ relation: search.relation }}
        onSearchChange={(next) =>
          navigate({
            to: "/events",
            search: {
              relation:
                !next.relation || next.relation === "all"
                  ? undefined
                  : next.relation,
            },
            replace: true,
          })
        }
        onOpen={openEvent}
        onCreate={createEvent}
        createDisabled={organizerMutationPending}
      />
    </div>
  )
}

export function FindEventsPanel({
  merchantPubkey,
  authenticatedPubkey,
  shouldContinue,
  initialReference,
}: {
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  initialReference: string
}) {
  const queryClient = useQueryClient()
  const session = useConduitSession()
  const { authGeneration } = useAuth()
  const queryScopeToken = `${session.relayScope ?? "no-relay-scope"}:${authenticatedPubkey ?? "disconnected"}:${authGeneration}`
  const queryScopeTokenRef = useRef(queryScopeToken)
  useLayoutEffect(() => {
    queryScopeTokenRef.current = queryScopeToken
  }, [queryScopeToken])
  const selectedReference = initialReference

  const marketQueryScope = {
    relayScope: session.relayScope,
    authenticatedPubkey,
    authGeneration,
  }
  const selectedMarketQuery = useQuery({
    ...merchantEventMarketEssentialsQueryOptions(
      queryClient,
      selectedReference,
      marketQueryScope,
      () => shouldContinue() && queryScopeTokenRef.current === queryScopeToken
    ),
    enabled:
      session.relaySettingsReady && !!merchantPubkey && !!selectedReference,
  })
  const selectedRead = selectedMarketQuery.data?.read ?? null
  const selectedMarket =
    selectedRead && !("terminal" in selectedRead) ? selectedRead : null
  const settledRead = getSettledMerchantEventMarketRead(selectedMarketQuery)
  const selectedMarketActionReady =
    !!settledRead && !("terminal" in settledRead)
  const selectedParticipationQuery = useQuery({
    ...merchantEventMarketQueryOptions(
      queryClient,
      selectedReference,
      marketQueryScope,
      () => shouldContinue() && queryScopeTokenRef.current === queryScopeToken
    ),
    enabled:
      session.relaySettingsReady &&
      !!merchantPubkey &&
      !!selectedReference &&
      selectedMarketActionReady,
  })
  const selectedParticipationRead = selectedParticipationQuery.data?.read
  const selectedParticipationMarket =
    selectedParticipationRead && !("terminal" in selectedParticipationRead)
      ? selectedParticipationRead
      : null

  return (
    <div className="space-y-6">
      {!!selectedReference && selectedMarketQuery.isPending && (
        <div
          className="space-y-4"
          aria-busy="true"
          aria-label="Loading event details"
          role="status"
        >
          <span className="sr-only">Loading current event details…</span>
          <Skeleton className="aspect-[3/1] w-full rounded-xl" />
          <Skeleton className="h-10 w-2/3 max-w-xl" />
          <Skeleton className="h-5 w-1/2 max-w-md" />
          <Skeleton className="h-5 w-1/3 max-w-xs" />
        </div>
      )}

      {!!selectedReference &&
        selectedMarketQuery.isError &&
        !selectedMarket && (
          <Card>
            <CardHeader>
              <CardTitle>Event details couldn't be confirmed</CardTitle>
              <CardDescription className="text-pretty">
                The event is not shown because its organizer, schedule, links,
                or supporting records could not be verified.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                type="button"
                variant="outline"
                onClick={() => selectedMarketQuery.refetch()}
              >
                Retry event details
              </Button>
            </CardContent>
          </Card>
        )}

      {selectedRead && "terminal" in selectedRead ? (
        <Card>
          <CardHeader>
            <CardTitle>Event is no longer available</CardTitle>
            <CardDescription className="text-pretty">
              The organizer deleted the signed event record. It remains
              addressable for history, but selling actions are unavailable.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {selectedMarket && (
        <MerchantEventMarketPanel
          merchantPubkey={merchantPubkey}
          authenticatedPubkey={authenticatedPubkey}
          shouldContinue={shouldContinue}
          market={selectedMarket}
          participationMarket={selectedParticipationMarket}
          actionReady={selectedMarketActionReady}
          refreshing={selectedMarketQuery.isFetching}
          sellerDiscoveryState={getMerchantEventSellerDiscoveryState({
            data: selectedParticipationQuery.data,
            isError: selectedParticipationQuery.isError,
            isFetching:
              !selectedMarketActionReady ||
              selectedParticipationQuery.isFetching,
          })}
          onRefreshSellers={() => {
            void selectedParticipationQuery.refetch()
          }}
          onRefresh={async () => {
            await selectedMarketQuery.refetch()
            void selectedParticipationQuery.refetch()
          }}
        />
      )}
    </div>
  )
}

export function MyEventsPanel({
  organizerPubkey,
  authenticatedPubkey,
  shouldContinue,
  initialReference,
  startCreate = false,
  onPublished,
  onCreateDismiss,
}: {
  organizerPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  initialReference?: string
  startCreate?: boolean
  onPublished?: (reference: string) => void
  onCreateDismiss?: () => void
}) {
  const initiatingPanelMounted = useRef(true)
  useLayoutEffect(() => {
    initiatingPanelMounted.current = true
    return () => {
      initiatingPanelMounted.current = false
    }
  }, [])
  const queryClient = useQueryClient()
  const session = useConduitSession()
  const { authGeneration } = useAuth()
  const queryScopeToken = `${session.relayScope ?? "no-relay-scope"}:${authenticatedPubkey ?? "disconnected"}:${authGeneration}`
  const queryScopeTokenRef = useRef(queryScopeToken)
  useLayoutEffect(() => {
    queryScopeTokenRef.current = queryScopeToken
  }, [queryScopeToken])
  const organizerAuthorityMutationScope = useMemo(
    () => ({ id: `merchant-organizer-event-authority:${organizerPubkey}` }),
    [organizerPubkey]
  )
  const [savedReferences, setSavedReferences] = useState<
    SavedOrganizerEventMarketReference[]
  >(() => loadSavedOrganizerEventMarkets(organizerPubkey))
  const [selectedReference, setSelectedReference] = useState(
    initialReference ?? ""
  )
  const [editorOpen, setEditorOpen] = useState(startCreate)
  const [editingMarket, setEditingMarket] =
    useState<MerchantOrganizerEventMarket | null>(null)
  const [publishState, setPublishState] = useState<SignedActionStatusState>(
    startCreate ? "dirty" : "idle"
  )
  const [publishError, setPublishError] = useState("")
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [handoffDeliveryRevision, setHandoffDeliveryRevision] = useState(0)
  const [deliveriesByReference, setDeliveriesByReference] = useState<
    Record<string, MerchantOrganizerRecordDelivery[]>
  >(() => loadOrganizerEventMarketDeliveryOutbox(organizerPubkey))
  const handoffAckDeliveries = useMemo(() => {
    void handoffDeliveryRevision
    return organizerPubkey
      ? loadEventMarketHandoffDeliveries(organizerPubkey).filter(
          (delivery) => delivery.record.messageType === "organizer_handoff_ack"
        )
      : []
  }, [handoffDeliveryRevision, organizerPubkey])

  useEffect(() => {
    if (!initialReference) return
    try {
      const parsed = parseOrganizerEventMarketReference(initialReference)
      if (parsed.coordinate.split(":")[1] !== organizerPubkey) return
      const saved = rememberOrganizerEventMarket(organizerPubkey, {
        reference: parsed.naddr,
        savedAt: Date.now(),
      })
      setSavedReferences(saved)
      setSelectedReference(
        findSavedOrganizerEventMarketReference(saved, parsed.coordinate)
          ?.reference ?? parsed.naddr
      )
    } catch {
      // Route validation and the exact-read state own invalid-link feedback.
    }
  }, [initialReference, organizerPubkey])

  const selectedIdentity = useMemo(() => {
    if (!selectedReference) return null
    try {
      return parseOrganizerEventMarketReference(selectedReference)
    } catch {
      return null
    }
  }, [selectedReference])
  const selectedSavedReference = selectedReference
    ? findSavedOrganizerEventMarketReference(savedReferences, selectedReference)
    : undefined
  const shouldResolveSelectedReference =
    shouldResolveOrganizerEventMarketReference(
      undefined,
      selectedSavedReference
    )
  const selectedQueryReference =
    selectedReference || `30405:${organizerPubkey}:new-event`
  const selectedQueryScope = {
    relayScope: session.relayScope,
    authenticatedPubkey,
    authGeneration,
  }
  const selectedPublishMarketQuery = useQuery({
    ...merchantEventMarketEssentialsQueryOptions(
      queryClient,
      selectedQueryReference,
      selectedQueryScope,
      () => shouldContinue() && queryScopeTokenRef.current === queryScopeToken
    ),
    enabled:
      session.relaySettingsReady &&
      !!organizerPubkey &&
      !!selectedReference &&
      shouldResolveSelectedReference,
  })
  const selectedPublishRead = selectedPublishMarketQuery.data?.read
  const selectedPublishSettledRead = getSettledMerchantEventMarketRead(
    selectedPublishMarketQuery
  )
  const selectedPublishMarket =
    selectedPublishRead && !("terminal" in selectedPublishRead)
      ? selectedPublishRead
      : null
  const selectedMarketQuery = useQuery({
    ...merchantEventMarketQueryOptions(
      queryClient,
      selectedQueryReference,
      selectedQueryScope,
      () => shouldContinue() && queryScopeTokenRef.current === queryScopeToken
    ),
    enabled:
      session.relaySettingsReady &&
      !!organizerPubkey &&
      !!selectedReference &&
      shouldResolveSelectedReference &&
      !!selectedPublishSettledRead &&
      !("terminal" in selectedPublishSettledRead),
  })
  const selectedPublishDeletion =
    selectedPublishRead && "terminal" in selectedPublishRead
      ? selectedPublishRead
      : undefined
  const selectedProgressRead =
    selectedPublishDeletion ?? selectedMarketQuery.data?.read
  const selectedSettledRead =
    getSettledMerchantEventMarketRead(selectedMarketQuery)
  const selectedResolution =
    selectOrganizerEventMarketResolution(
      undefined,
      selectedProgressRead,
      selectedSavedReference
    ) ?? null
  const selectedDeletion =
    selectedResolution?.state === "deleted" && "terminal" in selectedResolution
      ? selectedResolution
      : null
  const selectedReadDeleted = !!selectedDeletion
  const selectedReadReconciliationPending =
    selectedResolution?.state === "pending"
  const selectedMarket =
    selectedResolution &&
    !selectedReadDeleted &&
    !selectedReadReconciliationPending &&
    !("terminal" in selectedResolution)
      ? selectedResolution
      : null

  const selectedPresentedMarket = useMemo(
    () =>
      selectedMarket
        ? reconcileAcknowledgedMerchantOrganizerCollectionEvidence(
            selectedMarket,
            deliveriesByReference[selectedIdentity?.coordinate ?? ""] ?? []
          )
        : null,
    [deliveriesByReference, selectedIdentity?.coordinate, selectedMarket]
  )
  const selectedReferenceResolutionPending =
    shouldResolveSelectedReference && !selectedSettledRead
  const selectedMembershipActionableMarket =
    !selectedReferenceResolutionPending &&
    selectedPresentedMarket &&
    organizerEventMarketReachesExpectedFrontiers(
      selectedPresentedMarket,
      selectedSavedReference
    )
      ? selectedPresentedMarket
      : null
  const selectedHandoffActionableMarket =
    !selectedReferenceResolutionPending &&
    selectedMarket &&
    organizerEventMarketReachesExpectedFrontiers(
      selectedMarket,
      selectedSavedReference
    )
      ? selectedMarket
      : null
  const handoffReceiptsQuery = useQuery({
    queryKey: [
      "merchant-organizer-handoff-receipts",
      organizerPubkey || "none",
      selectedHandoffActionableMarket?.collectionCoordinate ?? "none",
    ],
    enabled:
      !!organizerPubkey &&
      !!selectedHandoffActionableMarket &&
      selectedHandoffActionableMarket.organizerPubkey === organizerPubkey,
    queryFn: () =>
      readEventMarketReadyReceipts({
        organizerPubkey,
        collectionCoordinate:
          selectedHandoffActionableMarket!.collectionCoordinate,
      }),
    retry: false,
    refetchInterval: 30_000,
  })
  const handoffClaims = useMemo(
    () => handoffReceiptsQuery.data?.data ?? [],
    [handoffReceiptsQuery.data?.data]
  )
  const handoffClaimIds = handoffClaims
    .map((claim) => claim.receipt.id)
    .sort()
    .join(":")
  const handoffMerchandiseQuery = useQuery({
    queryKey: [
      "merchant-organizer-handoff-merchandise",
      organizerPubkey || "none",
      authenticatedPubkey ?? "disconnected",
      selectedHandoffActionableMarket?.collectionCoordinate ?? "none",
      handoffClaimIds || "none",
    ],
    enabled:
      !!organizerPubkey &&
      !!selectedHandoffActionableMarket &&
      selectedHandoffActionableMarket.organizerPubkey === organizerPubkey &&
      handoffClaims.length > 0,
    queryFn: async ({ signal }) => {
      const entries = await Promise.all(
        handoffClaims.map(async (claim) => {
          try {
            return [
              claim.receipt.id,
              {
                resolution: await resolveOrganizerHandoffMerchandise({
                  organizerPubkey,
                  authenticatedPubkey,
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
      return Object.fromEntries(entries) as Record<
        string,
        OrganizerHandoffMerchandiseRead
      >
    },
    retry: false,
    refetchInterval: 30_000,
  })
  const handoffAckReadinessByReceiptId = useMemo(() => {
    if (!handoffReceiptsQuery.data || !selectedHandoffActionableMarket) {
      return {}
    }
    return Object.fromEntries(
      handoffClaims.map((claim) => [
        claim.receipt.id,
        resolveOrganizerHandoffAckReadiness({
          claim,
          market: selectedHandoffActionableMarket.source,
          merchandise:
            handoffMerchandiseQuery.data?.[claim.receipt.id]?.resolution,
        }),
      ])
    )
  }, [
    handoffClaims,
    handoffMerchandiseQuery.data,
    handoffReceiptsQuery.data,
    selectedHandoffActionableMarket,
  ])

  async function refreshMarketQueries(reference: string): Promise<void> {
    const scope = {
      relayScope: session.relayScope,
      authenticatedPubkey,
      authGeneration,
    }
    const fullIdentity = merchantEventMarketQueryIdentity(
      reference,
      scope,
      "full"
    )
    const essentialsIdentity = merchantEventMarketQueryIdentity(
      reference,
      scope,
      "essentials"
    )
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: essentialsIdentity.queryKey }),
      queryClient.invalidateQueries({ queryKey: fullIdentity.queryKey }),
    ])
  }

  function rememberDelivery(
    reference: string,
    record: MerchantOrganizerRecordDelivery
  ): void {
    const coordinate = parseOrganizerEventMarketReference(reference).coordinate
    saveOrganizerEventMarketDelivery(organizerPubkey, coordinate, record)
    setDeliveriesByReference((current) =>
      mergeOrganizerEventMarketDeliveryState(current, coordinate, record)
    )
  }

  function updateInitiatingEventSelection(
    initiatingReference: string,
    nextReference: string
  ): void {
    setSelectedReference((current) =>
      current &&
      organizerEventMarketReferencesMatch(current, initiatingReference)
        ? nextReference
        : current
    )
  }

  const publishMutation = useMutation({
    scope: organizerAuthorityMutationScope,
    mutationFn: (input: {
      form: OrganizerEventMarketFormValues
      existing: MerchantOrganizerEventMarket | null
    }) =>
      publishMerchantOrganizerEventMarket({
        organizerPubkey,
        authenticatedPubkey,
        shouldContinue,
        form: input.form,
        existing: input.existing,
        onSignedEvent: (record, reference) => {
          if (record.record === "collection") setPublishState("publishing")
          const saved = rememberOrganizerEventMarket(organizerPubkey, {
            reference,
            title: input.form.title,
            savedAt: Date.now(),
            ...expectedOrganizerEventMarketFrontier(record),
          })
          setSavedReferences(saved)
          setSelectedReference(
            findSavedOrganizerEventMarketReference(saved, reference)
              ?.reference ?? reference
          )
          rememberDelivery(reference, record)
        },
        onSignedRecord: (record, reference) => {
          setPublishState("publishing")
          rememberDelivery(reference, record)
          const hintedReference =
            organizerEventMarketReferenceWithAllDeliveryRelayHints(reference, [
              record,
            ])
          const saved = rememberOrganizerEventMarket(organizerPubkey, {
            reference: hintedReference,
            title: input.form.title,
            savedAt: Date.now(),
            ...expectedOrganizerEventMarketFrontier(record),
          })
          setSavedReferences(saved)
          setSelectedReference(
            findSavedOrganizerEventMarketReference(saved, hintedReference)
              ?.reference ?? hintedReference
          )
        },
      }),
    onMutate: () => {
      setPublishError("")
      setPublishState("awaiting_signature")
    },
    onSuccess: async (
      result: MerchantOrganizerPublishResult,
      input: {
        form: OrganizerEventMarketFormValues
        existing: MerchantOrganizerEventMarket | null
      }
    ) => {
      const reference = result.naddr
      const saved = rememberOrganizerEventMarket(organizerPubkey, {
        reference,
        title: input.form.title,
        savedAt: Date.now(),
        ...titleEventMarketFrontiers(result.records),
        ...expectedEventMarketFrontiers(result.records),
        replaceExpectedRecordFrontiers: true,
      })
      setSavedReferences(saved)
      for (const record of result.records) {
        rememberDelivery(result.collectionCoordinate, record)
      }
      setSelectedReference(
        findSavedOrganizerEventMarketReference(saved, reference)?.reference ??
          reference
      )
      setPublishState("success")
      setEditorOpen(false)
      setEditingMarket(null)
      await refreshMarketQueries(reference)
      if (initiatingPanelMounted.current && shouldContinue()) {
        onPublished?.(reference)
      }
    },
    onError: (error) => {
      setPublishError(
        errorMessage(
          error,
          "The organizer event records could not be published."
        )
      )
      setPublishState("error")
    },
  })

  const membershipMutation = useMutation({
    scope: organizerAuthorityMutationScope,
    mutationFn: (input: OrganizerMembershipMutationInput) =>
      publishMerchantOrganizerMembership({
        organizerPubkey,
        authenticatedPubkey,
        shouldContinue,
        market: input.market,
        item: input.item,
        action: input.action,
        onSignedEvent: (record, reference, currentMarket) => {
          const saved = rememberOrganizerEventMarket(organizerPubkey, {
            reference,
            title: input.market.title,
            savedAt: Date.now(),
            ...expectedOrganizerEventMarketFrontiersAfterMembership(
              record,
              currentMarket
            ),
          })
          setSavedReferences(saved)
          updateInitiatingEventSelection(
            input.reference,
            findSavedOrganizerEventMarketReference(saved, reference)
              ?.reference ?? reference
          )
          rememberDelivery(reference, record)
        },
      }),
    onSuccess: (delivery, input) => {
      const reference = organizerEventMarketReferenceWithDeliveryRelayHints(
        input.reference,
        delivery
      )
      const saved = rememberOrganizerEventMarket(organizerPubkey, {
        reference,
        title: input.market.title,
        savedAt: Date.now(),
        ...expectedOrganizerEventMarketFrontiersAfterRetry(
          delivery,
          findSavedOrganizerEventMarketReference(
            loadSavedOrganizerEventMarkets(organizerPubkey),
            reference
          )
        ),
      })
      setSavedReferences(saved)
      const nextReference =
        findSavedOrganizerEventMarketReference(saved, reference)?.reference ??
        reference
      updateInitiatingEventSelection(input.reference, nextReference)
      rememberDelivery(reference, delivery)
      void refreshMarketQueries(nextReference)
    },
  })

  const lifecycleMutation = useMutation({
    scope: organizerAuthorityMutationScope,
    mutationFn: (input: {
      market: MerchantOrganizerEventMarket
      reference: string
      orderAcceptance: "open" | "closed"
    }) =>
      publishMerchantOrganizerOrderAcceptance({
        organizerPubkey,
        authenticatedPubkey,
        shouldContinue,
        market: input.market,
        orderAcceptance: input.orderAcceptance,
        onSignedEvent: (record, reference, currentMarket) => {
          rememberDelivery(reference, record)
          const saved = rememberOrganizerEventMarket(organizerPubkey, {
            reference,
            title: input.market.title,
            savedAt: Date.now(),
            ...expectedOrganizerEventMarketFrontiersAfterMembership(
              record,
              currentMarket
            ),
          })
          setSavedReferences(saved)
          updateInitiatingEventSelection(
            input.reference,
            findSavedOrganizerEventMarketReference(saved, reference)
              ?.reference ?? reference
          )
        },
      }),
    onSuccess: (delivery, input) => {
      rememberDelivery(input.reference, delivery)
      const reference = organizerEventMarketReferenceWithDeliveryRelayHints(
        input.reference,
        delivery
      )
      const saved = rememberOrganizerEventMarket(organizerPubkey, {
        reference,
        title: input.market.title,
        savedAt: Date.now(),
        ...expectedOrganizerEventMarketFrontiersAfterRetry(
          delivery,
          findSavedOrganizerEventMarketReference(
            loadSavedOrganizerEventMarkets(organizerPubkey),
            reference
          )
        ),
      })
      setSavedReferences(saved)
      const nextReference =
        findSavedOrganizerEventMarketReference(saved, reference)?.reference ??
        reference
      updateInitiatingEventSelection(input.reference, nextReference)
      void refreshMarketQueries(nextReference)
    },
  })

  const retryMutation = useMutation({
    scope: organizerAuthorityMutationScope,
    mutationFn: (input: OrganizerRetryMutationInput) =>
      retryMerchantOrganizerRecord({
        organizerPubkey,
        authenticatedPubkey,
        shouldContinue,
        record: input.record,
      }),
    onSuccess: async (delivery, input) => {
      const latestSavedReferences =
        loadSavedOrganizerEventMarkets(organizerPubkey)
      const latestSavedReference =
        findSavedOrganizerEventMarketReference(
          latestSavedReferences,
          input.reference
        ) ?? input.savedReference
      const coordinate = parseOrganizerEventMarketReference(
        input.reference
      ).coordinate
      const latestDeliveries =
        loadOrganizerEventMarketDeliveryOutbox(organizerPubkey)[coordinate] ??
        []
      const latestDelivery = latestDeliveries.find(
        (candidate) => candidate.record === delivery.record
      )
      const retryRemainsCurrent = organizerEventMarketRetryRemainsCurrent(
        delivery,
        latestSavedReference,
        latestDelivery
      )
      const reference = organizerEventMarketReferenceWithAllDeliveryRelayHints(
        latestSavedReference?.reference ?? input.reference,
        [...input.deliveries, ...latestDeliveries, delivery]
      )
      const saved = rememberOrganizerEventMarket(organizerPubkey, {
        reference,
        title: latestSavedReference?.title ?? input.title,
        savedAt: Date.now(),
        ...(retryRemainsCurrent
          ? expectedOrganizerEventMarketFrontiersAfterRetry(
              delivery,
              latestSavedReference
            )
          : {}),
      })
      setSavedReferences(saved)
      const nextReference =
        findSavedOrganizerEventMarketReference(saved, reference)?.reference ??
        reference
      updateInitiatingEventSelection(input.reference, nextReference)
      if (retryRemainsCurrent) {
        rememberDelivery(reference, delivery)
      } else if (latestDelivery) {
        setDeliveriesByReference((current) =>
          mergeOrganizerEventMarketDeliveryState(
            current,
            coordinate,
            latestDelivery
          )
        )
      }
      await refreshMarketQueries(input.reference)
    },
  })

  function retryDelivery(record: MerchantOrganizerRecordDelivery): void {
    if (
      organizerAuthorityMutationPending ||
      !selectedReference ||
      (selectedDeletion &&
        organizerEventMarketDeletionRetiresDelivery(selectedDeletion, record))
    ) {
      return
    }
    retryMutation.mutate({
      record,
      deliveries,
      reference: selectedReference,
      title: selectedMarket?.title ?? selectedSavedReference?.title,
      savedReference: selectedSavedReference,
    })
  }

  const handoffAckMutation = useMutation({
    scope: organizerAuthorityMutationScope,
    mutationFn: async (claim: EventMarketOrganizerClaim) => {
      const ndk = getNdk()
      if (!ndk.signer) throw new Error("Organizer signer is not connected.")
      if (!selectedReference) {
        throw new Error("Choose an organizer event before handing out items.")
      }
      const initiatingReference = selectedReference
      const receiptReadResult = await handoffReceiptsQuery.refetch()
      const receiptRead = receiptReadResult.data
      if (!receiptRead) {
        throw new Error("Current organizer receipt evidence is unavailable.")
      }
      const freshClaim = receiptRead.data.find(
        (candidate) => candidate.receipt.id === claim.receipt.id
      )
      if (!freshClaim) {
        throw new Error("The exact organizer receipt is no longer current.")
      }
      const merchandise = await resolveOrganizerHandoffMerchandise({
        organizerPubkey,
        authenticatedPubkey,
        claim: freshClaim,
        shouldContinue,
      })
      const freshMarket = await resolveOrganizerEventMarket(
        initiatingReference,
        organizerPubkey,
        authenticatedPubkey,
        undefined,
        shouldContinue
      )
      const latestSavedReference =
        findSavedOrganizerEventMarketReference(
          loadSavedOrganizerEventMarkets(organizerPubkey),
          initiatingReference
        ) ?? selectedSavedReference
      if (
        !organizerEventMarketReachesExpectedFrontiers(
          freshMarket,
          latestSavedReference
        )
      ) {
        throw new Error(
          "The latest signed event records are not yet readable. Refresh the event before handing out items."
        )
      }
      return acknowledgeOrganizerHandoff({
        organizerPubkey,
        claim: freshClaim,
        market: freshMarket.source,
        merchandise,
        signer: ndk.signer,
        transport: { authenticatedPubkey, shouldContinue },
      })
    },
    onSuccess: async () => {
      setHandoffDeliveryRevision((revision) => revision + 1)
      await Promise.all([
        handoffReceiptsQuery.refetch(),
        handoffMerchandiseQuery.refetch(),
      ])
    },
    onError: () => {
      setHandoffDeliveryRevision((revision) => revision + 1)
    },
  })

  const organizerAuthorityMutationPending =
    publishMutation.isPending ||
    membershipMutation.isPending ||
    lifecycleMutation.isPending ||
    retryMutation.isPending ||
    handoffAckMutation.isPending
  const organizerMutationPendingOutsideHandoff =
    publishMutation.isPending ||
    membershipMutation.isPending ||
    lifecycleMutation.isPending ||
    retryMutation.isPending

  const selectedReadPending =
    !!selectedReference &&
    !selectedMarket &&
    !selectedReadDeleted &&
    !selectedReadReconciliationPending &&
    selectedMarketQuery.isPending
  const selectedReadError =
    selectedMarket || selectedReadDeleted || selectedReadReconciliationPending
      ? null
      : selectedMarketQuery.error
  const selectedMarketBehindExpectedFrontier =
    !!selectedPresentedMarket && !selectedMembershipActionableMarket
  const deliveries = selectedReference
    ? (deliveriesByReference[selectedIdentity?.coordinate ?? ""] ?? [])
    : []
  const retryableDeliveries = selectedDeletion
    ? deliveries.filter(
        (delivery) =>
          !organizerEventMarketDeletionRetiresDelivery(
            selectedDeletion,
            delivery
          )
      )
    : deliveries

  function openEdit(): void {
    if (
      organizerAuthorityMutationPending ||
      !selectedMembershipActionableMarket
    ) {
      return
    }
    setEditingMarket(selectedMembershipActionableMarket)
    setPublishState("idle")
    setPublishError("")
    setEditorOpen(true)
  }

  async function copyShareLink(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedUrl(url)
      window.setTimeout(
        () => setCopiedUrl((current) => (current === url ? null : current)),
        2_000
      )
    } catch {
      setCopiedUrl(null)
    }
  }

  return (
    <div className="space-y-6">
      {publishState !== "idle" && !editorOpen && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
          <SignedActionStatus
            state={publishState}
            successMessage="Organizer records were signed. Delivery status is updating."
            errorMessage={publishError}
          />
        </div>
      )}

      {!selectedMarket && retryableDeliveries.length > 0 && (
        <OrganizerEventMarketDeliveryList
          deliveries={retryableDeliveries}
          actionsDisabled={organizerAuthorityMutationPending}
          retryingRecord={
            retryMutation.isPending
              ? (retryMutation.variables?.record.record ?? null)
              : null
          }
          onRetryDelivery={retryDelivery}
        />
      )}

      {membershipMutation.isError && (
        <div
          className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error"
          role="alert"
        >
          {errorMessage(
            membershipMutation.error,
            "The organizer collection update failed."
          )}
        </div>
      )}

      {retryMutation.isError && (
        <div
          className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error"
          role="alert"
        >
          {errorMessage(retryMutation.error, "Relay delivery retry failed.")}
        </div>
      )}

      {selectedReadPending && (
        <div
          className="flex min-h-48 items-center justify-center gap-2 text-sm text-[var(--text-muted)]"
          aria-busy="true"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading current event details...
        </div>
      )}

      {!selectedReadPending && selectedReadDeleted && (
        <Card>
          <CardHeader>
            <CardTitle>Event deleted</CardTitle>
            <CardDescription>
              Signed deletion evidence was found for this organizer event. Its
              products and pickup actions are no longer available.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {!selectedReadPending && selectedReadReconciliationPending && (
        <Card data-testid="organizer-event-reconciliation-pending">
          <CardHeader>
            <CardTitle>Latest event records still need verification</CardTitle>
            <CardDescription>
              The newest signed event records disagree. Updating the event and
              changing product acceptance stay disabled until one current graph
              is verified.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              disabled={selectedMarketQuery.isFetching}
              onClick={() => selectedMarketQuery.refetch()}
            >
              Retry latest event records
            </Button>
          </CardContent>
        </Card>
      )}

      {!selectedReadPending && selectedReadError && (
        <Card>
          <CardHeader>
            <CardTitle>Event details couldn't be confirmed</CardTitle>
            <CardDescription>
              Updating the event and changing product acceptance remain
              unavailable until its current signed records can be verified.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              onClick={() => selectedMarketQuery.refetch()}
            >
              Retry event details
            </Button>
          </CardContent>
        </Card>
      )}

      {selectedMarketBehindExpectedFrontier && (
        <div
          className="rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-3 text-sm text-[var(--text-primary)]"
          role={
            selectedMarketQuery.isPending || selectedMarketQuery.isFetching
              ? undefined
              : "alert"
          }
          aria-busy={
            selectedMarketQuery.isPending || selectedMarketQuery.isFetching
          }
        >
          <div className="font-medium">
            Showing earlier signed event evidence
          </div>
          <p className="mt-1 text-[var(--text-secondary)]">
            {selectedMarketQuery.isPending || selectedMarketQuery.isFetching
              ? "The latest published event records are still being resolved. Updating the event and changing product acceptance stay disabled until they are verified."
              : "The latest published event records could not be verified. Refresh before updating the event or changing product acceptance."}
          </p>
          {!selectedMarketQuery.isPending &&
            !selectedMarketQuery.isFetching && (
              <Button
                type="button"
                className="mt-3"
                variant="outline"
                onClick={() => selectedMarketQuery.refetch()}
              >
                Retry latest event records
              </Button>
            )}
        </div>
      )}

      {!selectedReadPending && !selectedReadError && selectedMarket && (
        <>
          <OrganizerEventMarketPanel
            market={selectedPresentedMarket ?? selectedMarket}
            accountPubkey={organizerPubkey}
            authenticatedPubkey={authenticatedPubkey}
            shouldContinue={shouldContinue}
            deliveries={deliveries}
            copiedUrl={copiedUrl}
            refreshing={selectedMarketQuery.isFetching}
            membershipPending={organizerAuthorityMutationPending}
            actionsDisabled={
              !selectedMembershipActionableMarket ||
              organizerAuthorityMutationPending
            }
            deliveryRetryDisabled={organizerAuthorityMutationPending}
            retryingRecord={
              retryMutation.isPending
                ? (retryMutation.variables?.record.record ?? null)
                : null
            }
            onCopy={(url) => void copyShareLink(url)}
            onEdit={openEdit}
            lifecyclePending={lifecycleMutation.isPending}
            lifecycleError={
              lifecycleMutation.isError
                ? errorMessage(
                    lifecycleMutation.error,
                    "Event availability could not be updated."
                  )
                : undefined
            }
            onOrderAcceptance={(orderAcceptance) => {
              if (
                organizerAuthorityMutationPending ||
                !selectedMembershipActionableMarket ||
                !selectedReference
              )
                return
              lifecycleMutation.mutate({
                market: selectedMembershipActionableMarket,
                reference: selectedReference,
                orderAcceptance,
              })
            }}
            onRefresh={() => {
              void refreshMarketQueries(selectedReference)
            }}
            onMembership={(item, action) => {
              if (
                organizerAuthorityMutationPending ||
                !selectedMembershipActionableMarket ||
                !selectedReference
              ) {
                return
              }
              membershipMutation.mutate({
                item,
                action,
                market: selectedMembershipActionableMarket,
                reference: selectedReference,
              })
            }}
            onRetryDelivery={retryDelivery}
          />
          {selectedPublishMarket && (
            <MerchantEventMarketPanel
              merchantPubkey={organizerPubkey}
              authenticatedPubkey={authenticatedPubkey}
              shouldContinue={shouldContinue}
              market={selectedPublishMarket}
              participationMarket={
                selectedHandoffActionableMarket ??
                selectedPresentedMarket ??
                selectedMarket
              }
              actionReady={
                !!selectedPublishSettledRead &&
                !("terminal" in selectedPublishSettledRead)
              }
              refreshing={selectedPublishMarketQuery.isFetching}
              onRefresh={() => refreshMarketQueries(selectedReference)}
              compact
            />
          )}
          {selectedHandoffActionableMarket && (
            <OrganizerHandoffReceiptQueue
              organizerPubkey={organizerPubkey}
              authenticatedPubkey={authenticatedPubkey}
              shouldContinue={shouldContinue}
              claims={handoffClaims}
              ackDeliveries={handoffAckDeliveries}
              merchandiseReads={handoffMerchandiseQuery.data ?? {}}
              merchandiseLoading={handoffMerchandiseQuery.isFetching}
              ackReadinessByReceiptId={handoffAckReadinessByReceiptId}
              loading={handoffReceiptsQuery.isFetching}
              stale={handoffReceiptsQuery.data?.stale ?? false}
              decryptFailureCount={
                handoffReceiptsQuery.data?.decryptFailureCount ?? 0
              }
              discoveryEvidenceComplete={
                !!handoffReceiptsQuery.data &&
                !handoffReceiptsQuery.data.stale &&
                handoffReceiptsQuery.data.decryptFailureCount === 0 &&
                handoffReceiptsQuery.data.inbox?.declarationState ===
                  "declared" &&
                handoffReceiptsQuery.data.inbox?.coverage === "complete"
              }
              error={handoffReceiptsQuery.isError}
              actionError={
                handoffAckMutation.isError
                  ? errorMessage(
                      handoffAckMutation.error,
                      "The organizer handoff update could not be delivered."
                    )
                  : undefined
              }
              actionsDisabled={organizerMutationPendingOutsideHandoff}
              pendingReceiptId={
                handoffAckMutation.isPending
                  ? (handoffAckMutation.variables?.receipt.id ?? null)
                  : null
              }
              onAcknowledge={(claim) => {
                if (!organizerMutationPendingOutsideHandoff) {
                  handoffAckMutation.mutate(claim)
                }
              }}
              onRefresh={() => {
                void Promise.all([
                  handoffReceiptsQuery.refetch(),
                  handoffMerchandiseQuery.refetch(),
                ])
              }}
            />
          )}
        </>
      )}

      <OrganizerEventMarketEditor
        key={`${editorOpen ? "open" : "closed"}:${editingMarket?.collectionCoordinate ?? "new"}`}
        open={editorOpen}
        initialForm={
          editingMarket ? organizerEventMarketToForm(editingMarket) : null
        }
        actionState={publishState}
        actionError={publishError}
        onOpenChange={(open) => {
          setEditorOpen(open)
          if (!open) setEditingMarket(null)
          if (!open && startCreate && !editingMarket) onCreateDismiss?.()
        }}
        onSubmit={(form) => {
          publishMutation.mutate({ form, existing: editingMarket })
        }}
      />
    </div>
  )
}
