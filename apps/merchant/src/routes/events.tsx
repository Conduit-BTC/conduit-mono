import { useEffect, useMemo, useState } from "react"
import { CalendarDays, Loader2, Plus, Search } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getNdk,
  readEventMarketReadyReceipts,
  useAuth,
  type EventMarketOrganizerClaim,
} from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SignedActionStatus,
  type SignedActionStatusState,
} from "@conduit/ui"
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
  listOrganizerEventMarkets,
  loadOrganizerEventMarketDeliveryOutbox,
  mergeOrganizerEventMarketDeliveryState,
  organizerEventMarketReferencesMatch,
  organizerEventMarketToForm,
  parseOrganizerEventMarketReference,
  publishMerchantOrganizerEventMarket,
  publishMerchantOrganizerMembership,
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
  loadSavedOrganizerEventMarkets,
  rememberOrganizerEventMarket,
  type OrganizerCollectionMembershipAction,
  type SavedOrganizerEventMarketReference,
} from "../lib/event-market-workflow"
import { getEventMarketUrl } from "../lib/market-links"
import {
  acknowledgeOrganizerHandoff,
  loadEventMarketHandoffDeliveries,
  resolveOrganizerHandoffAckReadiness,
  resolveOrganizerHandoffMerchandise,
} from "../lib/event-market-handoff"
import { requireAuth } from "../lib/auth"

export const Route = createFileRoute("/events")({
  beforeLoad: () => {
    requireAuth()
  },
  component: OrganizerEventsPage,
})

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

function referenceLabel(
  reference: SavedOrganizerEventMarketReference,
  markets: readonly MerchantOrganizerEventMarket[]
): string {
  return (
    markets.find((market) =>
      organizerEventMarketReferencesMatch(
        market.collectionCoordinate,
        reference.reference
      )
    )?.title ??
    reference.title ??
    "Saved event market"
  )
}

function OrganizerEventsPage() {
  const { pubkey } = useAuth()
  const organizerPubkey = pubkey ?? ""
  const queryClient = useQueryClient()
  const [savedReferences, setSavedReferences] = useState<
    SavedOrganizerEventMarketReference[]
  >(() => loadSavedOrganizerEventMarkets(organizerPubkey))
  const [selectedReference, setSelectedReference] = useState("")
  const [importValue, setImportValue] = useState("")
  const [importError, setImportError] = useState("")
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingMarket, setEditingMarket] =
    useState<MerchantOrganizerEventMarket | null>(null)
  const [publishState, setPublishState] =
    useState<SignedActionStatusState>("idle")
  const [publishError, setPublishError] = useState("")
  const [copied, setCopied] = useState(false)
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

  const marketsQuery = useQuery({
    queryKey: ["merchant-organizer-event-markets", organizerPubkey || "none"],
    enabled: !!organizerPubkey,
    queryFn: () => listOrganizerEventMarkets(organizerPubkey),
    refetchInterval: 30_000,
  })
  const markets = useMemo(() => marketsQuery.data ?? [], [marketsQuery.data])

  useEffect(() => {
    setSavedReferences(loadSavedOrganizerEventMarkets(organizerPubkey))
    setDeliveriesByReference(
      loadOrganizerEventMarketDeliveryOutbox(organizerPubkey)
    )
    setSelectedReference("")
  }, [organizerPubkey])

  useEffect(() => {
    if (!organizerPubkey || markets.length === 0) return
    let next = loadSavedOrganizerEventMarkets(organizerPubkey)
    for (const market of markets) {
      if (
        next.some((reference) =>
          organizerEventMarketReferencesMatch(
            reference.reference,
            market.collectionCoordinate
          )
        )
      ) {
        continue
      }
      next = rememberOrganizerEventMarket(organizerPubkey, {
        reference: market.collectionCoordinate,
        title: market.title,
        savedAt: market.collectionCreatedAt ?? Date.now(),
      })
    }
    setSavedReferences(next)
  }, [markets, organizerPubkey])

  useEffect(() => {
    if (selectedReference || savedReferences.length === 0) return
    setSelectedReference(savedReferences[0]!.reference)
  }, [savedReferences, selectedReference])

  const selectedIdentity = useMemo(() => {
    if (!selectedReference) return null
    try {
      return parseOrganizerEventMarketReference(selectedReference)
    } catch {
      return null
    }
  }, [selectedReference])
  const selectedFromList =
    selectedIdentity?.relayHints.length === 0
      ? markets.find(
          (market) =>
            market.collectionCoordinate === selectedIdentity.coordinate
        )
      : undefined
  const selectedMarketQuery = useQuery({
    queryKey: [
      "merchant-organizer-event-market",
      organizerPubkey || "none",
      selectedReference || "none",
    ],
    enabled: !!organizerPubkey && !!selectedReference && !selectedFromList,
    queryFn: () =>
      resolveOrganizerEventMarket(selectedReference, organizerPubkey),
    retry: false,
  })
  const selectedMarket = selectedFromList ?? selectedMarketQuery.data ?? null
  const handoffReceiptsQuery = useQuery({
    queryKey: [
      "merchant-organizer-handoff-receipts",
      organizerPubkey || "none",
      selectedMarket?.collectionCoordinate ?? "none",
    ],
    enabled:
      !!organizerPubkey &&
      !!selectedMarket &&
      selectedMarket.organizerPubkey === organizerPubkey,
    queryFn: () =>
      readEventMarketReadyReceipts({
        organizerPubkey,
        collectionCoordinate: selectedMarket!.collectionCoordinate,
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
      selectedMarket?.collectionCoordinate ?? "none",
      handoffClaimIds || "none",
    ],
    enabled:
      !!organizerPubkey &&
      !!selectedMarket &&
      selectedMarket.organizerPubkey === organizerPubkey &&
      handoffClaims.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        handoffClaims.map(async (claim) => {
          try {
            return [
              claim.receipt.id,
              {
                resolution: await resolveOrganizerHandoffMerchandise({
                  organizerPubkey,
                  claim,
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
    if (!handoffReceiptsQuery.data || !selectedMarket) return {}
    return Object.fromEntries(
      handoffClaims.map((claim) => [
        claim.receipt.id,
        resolveOrganizerHandoffAckReadiness({
          claim,
          read: handoffReceiptsQuery.data!,
          market: selectedMarket.source,
          merchandise:
            handoffMerchandiseQuery.data?.[claim.receipt.id]?.resolution,
        }),
      ])
    )
  }, [
    handoffClaims,
    handoffMerchandiseQuery.data,
    handoffReceiptsQuery.data,
    selectedMarket,
  ])

  async function refreshMarketQueries(reference?: string): Promise<void> {
    await queryClient.invalidateQueries({
      queryKey: ["merchant-organizer-event-markets", organizerPubkey],
    })
    if (reference) {
      await queryClient.invalidateQueries({
        queryKey: [
          "merchant-organizer-event-market",
          organizerPubkey,
          reference,
        ],
      })
    }
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

  const publishMutation = useMutation({
    mutationFn: (input: {
      form: OrganizerEventMarketFormValues
      existing: MerchantOrganizerEventMarket | null
    }) =>
      publishMerchantOrganizerEventMarket({
        organizerPubkey,
        form: input.form,
        existing: input.existing,
        onSignedEvent: (record, reference) => {
          setPublishState("publishing")
          const saved = rememberOrganizerEventMarket(organizerPubkey, {
            reference,
            title: input.form.title,
            savedAt: Date.now(),
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
        },
      }),
    onMutate: () => {
      setPublishError("")
      setPublishState("awaiting_signature")
    },
    onSuccess: async (result: MerchantOrganizerPublishResult) => {
      const reference = result.collectionCoordinate
      const saved = rememberOrganizerEventMarket(organizerPubkey, {
        reference,
        title: editingMarket?.title,
        savedAt: Date.now(),
      })
      setSavedReferences(saved)
      for (const record of result.records) rememberDelivery(reference, record)
      setSelectedReference(
        findSavedOrganizerEventMarketReference(saved, reference)?.reference ??
          reference
      )
      setPublishState("success")
      setEditorOpen(false)
      setEditingMarket(null)
      await refreshMarketQueries(reference)
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
    mutationFn: (input: {
      item: MerchantOrganizerParticipation
      action: OrganizerCollectionMembershipAction
    }) => {
      if (!selectedMarket) throw new Error("Choose an event market first.")
      return publishMerchantOrganizerMembership({
        organizerPubkey,
        market: selectedMarket,
        item: input.item,
        action: input.action,
        onSignedEvent: (record, reference) => {
          rememberDelivery(reference, record)
        },
      })
    },
    onSuccess: async (delivery) => {
      if (!selectedReference) return
      rememberDelivery(selectedReference, delivery)
      await refreshMarketQueries(selectedReference)
    },
  })

  const retryMutation = useMutation({
    mutationFn: (delivery: MerchantOrganizerRecordDelivery) =>
      retryMerchantOrganizerRecord({
        organizerPubkey,
        record: delivery,
      }),
    onSuccess: (delivery) => {
      if (!selectedReference) return
      rememberDelivery(selectedReference, delivery)
    },
  })

  const handoffAckMutation = useMutation({
    mutationFn: async (claim: EventMarketOrganizerClaim) => {
      const ndk = getNdk()
      if (!ndk.signer) throw new Error("Organizer signer is not connected.")
      if (!selectedReference) {
        throw new Error("Choose an organizer event before handing out items.")
      }
      const [receiptReadResult, freshMarket] = await Promise.all([
        handoffReceiptsQuery.refetch(),
        resolveOrganizerEventMarket(selectedReference, organizerPubkey),
      ])
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
        claim: freshClaim,
      })
      return acknowledgeOrganizerHandoff({
        organizerPubkey,
        claim: freshClaim,
        read: receiptRead,
        market: freshMarket.source,
        merchandise,
        signer: ndk.signer,
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

  const allReferences = useMemo(() => {
    const next = [...savedReferences]
    for (const market of markets) {
      if (
        !next.some((reference) =>
          organizerEventMarketReferencesMatch(
            reference.reference,
            market.collectionCoordinate
          )
        )
      ) {
        next.push({
          reference: market.collectionCoordinate,
          title: market.title,
          savedAt: market.collectionCreatedAt ?? 0,
        })
      }
    }
    return next
  }, [markets, savedReferences])

  const selectedReadPending =
    !!selectedReference && !selectedFromList && selectedMarketQuery.isPending
  const selectedReadError = selectedMarketQuery.error
  const deliveries = selectedReference
    ? (deliveriesByReference[selectedIdentity?.coordinate ?? ""] ?? [])
    : []

  function handleImport(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    try {
      const reference = parseOrganizerEventMarketReference(importValue).naddr
      const saved = rememberOrganizerEventMarket(organizerPubkey, {
        reference,
        savedAt: Date.now(),
      })
      setSavedReferences(saved)
      setSelectedReference(
        findSavedOrganizerEventMarketReference(saved, reference)?.reference ??
          reference
      )
      setImportValue("")
      setImportError("")
    } catch (error) {
      setImportError(
        errorMessage(error, "Paste a valid event catalog naddr or share link.")
      )
    }
  }

  function openCreate(): void {
    setEditingMarket(null)
    setPublishState("dirty")
    setPublishError("")
    setEditorOpen(true)
  }

  function openEdit(): void {
    if (!selectedMarket) return
    setEditingMarket(selectedMarket)
    setPublishState("dirty")
    setPublishError("")
    setEditorOpen(true)
  }

  async function copyShareLink(market: MerchantOrganizerEventMarket) {
    try {
      await navigator.clipboard.writeText(getEventMarketUrl(market.naddr))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="mx-auto max-w-[68rem] space-y-6 py-2 sm:py-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-secondary-400">
            <CalendarDays className="h-4 w-4" />
            Organizer workspace
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
            Event markets
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
            Publish an organizer-owned event and product collection. Offering
            organizer handoff is optional; merchants can instead run their own
            signed booth pickup.
          </p>
        </div>
        <Button type="button" onClick={openCreate}>
          <Plus />
          Create event
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Open an organizer catalog</CardTitle>
          <CardDescription>
            Relay discovery is bounded. You can also reopen an organizer-owned
            kind-30405 catalog from its canonical naddr or Market share link.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="event-market-selector">Your saved events</Label>
            <Select
              value={selectedReference || undefined}
              onValueChange={setSelectedReference}
              disabled={allReferences.length === 0}
            >
              <SelectTrigger id="event-market-selector">
                <SelectValue
                  placeholder={
                    marketsQuery.isPending
                      ? "Checking relays..."
                      : "No saved event markets"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {allReferences.map((reference) => (
                  <SelectItem
                    key={reference.reference}
                    value={reference.reference}
                  >
                    {referenceLabel(reference, markets)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <form className="grid gap-1.5" onSubmit={handleImport}>
            <Label htmlFor="event-market-import">Catalog naddr or link</Label>
            <div className="flex gap-2">
              <Input
                id="event-market-import"
                value={importValue}
                onChange={(event) => setImportValue(event.target.value)}
                placeholder="naddr1... or https://..."
                aria-invalid={!!importError}
              />
              <Button
                type="submit"
                variant="outline"
                disabled={!importValue.trim()}
              >
                <Search />
                Open
              </Button>
            </div>
            {importError && (
              <p className="text-xs leading-5 text-error" role="alert">
                {importError}
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      {publishState !== "idle" && !editorOpen && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
          <SignedActionStatus
            state={publishState}
            successMessage="Organizer records were signed and delivered. Relay evidence is refreshing."
            errorMessage={publishError}
          />
        </div>
      )}

      {!selectedMarket && deliveries.length > 0 && (
        <OrganizerEventMarketDeliveryList
          deliveries={deliveries}
          retryingRecord={
            retryMutation.isPending
              ? (retryMutation.variables?.record ?? null)
              : null
          }
          onRetryDelivery={(delivery) => retryMutation.mutate(delivery)}
        />
      )}

      {marketsQuery.isError && (
        <div className="rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-3 text-sm text-[var(--text-primary)]">
          Organizer discovery is degraded. Saved references can still be opened
          directly. No missing event is inferred from this relay failure.
        </div>
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
        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Resolving organizer evidence from relays...
        </div>
      )}

      {!selectedReadPending && selectedReadError && (
        <Card>
          <CardHeader>
            <CardTitle>Event evidence unavailable</CardTitle>
            <CardDescription>
              The catalog was not shown because its organizer, links, deletion
              state, or supporting records could not be verified.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              onClick={() => selectedMarketQuery.refetch()}
            >
              Retry relay read
            </Button>
          </CardContent>
        </Card>
      )}

      {!selectedReadPending && !selectedReadError && selectedMarket && (
        <>
          <OrganizerEventMarketPanel
            market={selectedMarket}
            deliveries={deliveries}
            copied={copied}
            refreshing={
              marketsQuery.isFetching || selectedMarketQuery.isFetching
            }
            membershipPending={membershipMutation.isPending}
            retryingRecord={
              retryMutation.isPending
                ? (retryMutation.variables?.record ?? null)
                : null
            }
            onCopy={() => void copyShareLink(selectedMarket)}
            onEdit={openEdit}
            onRefresh={() => {
              void refreshMarketQueries(selectedReference)
            }}
            onMembership={(item, action) => {
              membershipMutation.mutate({ item, action })
            }}
            onRetryDelivery={(delivery) => retryMutation.mutate(delivery)}
          />
          <OrganizerHandoffReceiptQueue
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
            acknowledgementEvidenceComplete={
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
            pendingReceiptId={
              handoffAckMutation.isPending
                ? (handoffAckMutation.variables?.receipt.id ?? null)
                : null
            }
            onAcknowledge={(claim) => handoffAckMutation.mutate(claim)}
            onRefresh={() => {
              void Promise.all([
                handoffReceiptsQuery.refetch(),
                handoffMerchandiseQuery.refetch(),
              ])
            }}
          />
        </>
      )}

      {!marketsQuery.isPending &&
        allReferences.length === 0 &&
        !selectedMarket && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center px-6 py-14 text-center">
              <CalendarDays className="h-9 w-9 text-[var(--text-muted)]" />
              <h2 className="mt-4 text-lg font-semibold text-[var(--text-primary)]">
                No organizer event markets yet
              </h2>
              <p className="mt-2 max-w-lg text-sm leading-6 text-[var(--text-muted)]">
                Start with an empty organizer catalog. Products are accepted
                later by publishing a signed collection update.
              </p>
              <Button type="button" className="mt-5" onClick={openCreate}>
                <Plus />
                Create event
              </Button>
            </CardContent>
          </Card>
        )}

      <OrganizerEventMarketEditor
        open={editorOpen}
        initialForm={
          editingMarket ? organizerEventMarketToForm(editingMarket) : null
        }
        actionState={publishState}
        actionError={publishError}
        onOpenChange={(open) => {
          setEditorOpen(open)
          if (!open) setEditingMarket(null)
        }}
        onSubmit={(form) => {
          publishMutation.mutate({ form, existing: editingMarket })
        }}
      />
    </div>
  )
}
