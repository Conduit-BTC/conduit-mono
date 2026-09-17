import { useMemo, useState } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query"
import { Loader2, RefreshCw } from "lucide-react"
import type { EventMarketHandoffMode } from "@conduit/core"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  cn,
} from "@conduit/ui"
import { acceptOwnEventProduct } from "../lib/event-product-acceptance"
import type { MerchantOrganizerEventMarket } from "../lib/event-market"
import {
  executeMerchantEventHandoffChange,
  finalizeMerchantEventHandoffChange,
  loadMerchantEventHandoffChange,
  retryMerchantEventHandoffChange,
  snapshotMerchantEventHandoffChangeSource,
  type MerchantEventHandoffChangeJournal,
} from "../lib/merchant-event-handoff-change"
import {
  createMerchantEventHandoffPreference,
  type MerchantEventHandoffArrangement,
} from "../lib/merchant-event-handoff-arrangement"
import {
  checkpointMerchantEventHandoffOrders,
  readMerchantEventHandoffChangeSource,
} from "../lib/merchant-event-handoff-change-runtime"

function organizerHandoffAvailable(
  market: MerchantOrganizerEventMarket,
  merchantPubkey: string
): boolean {
  return (
    merchantPubkey !== market.organizerPubkey &&
    !!market.pickupCoordinate &&
    market.source.pickup?.coordinate === market.pickupCoordinate &&
    market.source.pickup.evidenceState !== "retained"
  )
}

function targetLabel(mode: EventMarketHandoffMode): string {
  return mode === "organizer_handoff"
    ? "Organizer hands it out"
    : "I hand it out"
}

export function MerchantEventHandoffChangeDialog({
  merchantPubkey,
  authenticatedPubkey,
  shouldContinue,
  market,
  arrangement,
  transition,
  queryKey,
  onRefresh,
}: {
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  market: MerchantOrganizerEventMarket
  arrangement: MerchantEventHandoffArrangement
  transition: MerchantEventHandoffChangeJournal | null
  queryKey: QueryKey
  onRefresh: () => void | Promise<void>
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const organizerAvailable = organizerHandoffAvailable(market, merchantPubkey)
  const currentMode =
    arrangement.state === "consistent" ? arrangement.selection.mode : null
  const [targetMode, setTargetMode] = useState<EventMarketHandoffMode>(() =>
    currentMode === "merchant_handoff" && organizerAvailable
      ? "organizer_handoff"
      : "merchant_handoff"
  )
  const [location, setLocation] = useState(
    arrangement.state === "consistent"
      ? (arrangement.selection.merchantPickup?.location ??
          market.eventLocation ??
          "")
      : (market.eventLocation ?? "")
  )
  const [country, setCountry] = useState(
    arrangement.state === "consistent"
      ? (arrangement.selection.merchantPickup?.countries[0] ??
          market.pickupCountry ??
          "US")
      : (market.pickupCountry ?? "US")
  )
  const effectiveTargetMode =
    targetMode === "organizer_handoff" && !organizerAvailable
      ? "merchant_handoff"
      : targetMode
  const sourceQuery = useQuery({
    queryKey: [
      "merchant-event-handoff-change-source",
      merchantPubkey,
      market.collectionCoordinate,
      market.collectionEventId ?? "",
      open,
    ],
    enabled: open && !transition,
    retry: false,
    queryFn: async () => {
      const source = await readMerchantEventHandoffChangeSource({
        merchantPubkey,
        marketReference: market.naddr,
        authenticatedPubkey,
        shouldContinue,
      })
      return {
        source,
        affected: snapshotMerchantEventHandoffChangeSource({
          merchantPubkey,
          source,
        }).affectedListings,
      }
    },
  })
  const targetIsCurrent = useMemo(() => {
    if (arrangement.state !== "consistent") return false
    if (arrangement.selection.mode !== effectiveTargetMode) return false
    if (effectiveTargetMode === "organizer_handoff") return true
    const currentPickup = arrangement.selection.merchantPickup
    return (
      (currentPickup?.location ?? "").trim() === location.trim() &&
      currentPickup?.countries[0]?.trim().toUpperCase() ===
        country.trim().toUpperCase()
    )
  }, [arrangement, country, effectiveTargetMode, location])

  const refreshAfterMutation = async () => {
    await onRefresh()
    await queryClient.invalidateQueries({ queryKey })
    await sourceQuery.refetch()
  }

  const changeMutation = useMutation({
    mutationFn: async () => {
      const source = sourceQuery.data?.source
      if (!source) {
        throw new Error("Review the current affected listings before signing.")
      }
      const target = await createMerchantEventHandoffPreference({
        merchantPubkey,
        market: source.market,
        mode: effectiveTargetMode,
        ...(effectiveTargetMode === "merchant_handoff"
          ? {
              merchantPickup: {
                title: "Merchant pickup",
                location,
                country,
              },
            }
          : {}),
      })
      const readCurrentSource = () =>
        readMerchantEventHandoffChangeSource({
          merchantPubkey,
          marketReference: market.naddr,
          authenticatedPubkey,
          shouldContinue,
        })
      return executeMerchantEventHandoffChange({
        merchantPubkey,
        authenticatedPubkey,
        shouldContinue,
        source,
        target,
        checkpointExistingOrders: ({ affectedListings }) =>
          checkpointMerchantEventHandoffOrders({
            merchantPubkey,
            authenticatedPubkey,
            shouldContinue,
            affectedListings,
          }).then(() => undefined),
        readCurrentSource,
        ...(merchantPubkey === source.market.organizerPubkey
          ? {
              requestOrganizerReacceptance: async ({ listings }) => {
                const first = listings[0]
                if (!first) return
                await acceptOwnEventProduct({
                  merchantPubkey,
                  authenticatedPubkey,
                  shouldContinue,
                  marketReference: market.naddr,
                  productCoordinate: first.productCoordinate,
                })
              },
            }
          : {}),
      })
    },
    onSuccess: refreshAfterMutation,
  })

  const retryMutation = useMutation({
    mutationFn: async () => {
      const journal = loadMerchantEventHandoffChange(
        merchantPubkey,
        market.collectionCoordinate
      )
      if (!journal) throw new Error("The saved handoff change is unavailable.")
      return retryMerchantEventHandoffChange({
        journal,
        authenticatedPubkey,
        shouldContinue,
        readCurrentSource: () =>
          readMerchantEventHandoffChangeSource({
            merchantPubkey,
            marketReference: market.naddr,
            authenticatedPubkey,
            shouldContinue,
          }),
      })
    },
    onSuccess: refreshAfterMutation,
  })

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      const journal = loadMerchantEventHandoffChange(
        merchantPubkey,
        market.collectionCoordinate
      )
      if (!journal) throw new Error("The saved handoff change is unavailable.")
      const current = await readMerchantEventHandoffChangeSource({
        merchantPubkey,
        marketReference: market.naddr,
        authenticatedPubkey,
        shouldContinue,
      })
      finalizeMerchantEventHandoffChange({ journal, current })
    },
    onSuccess: async () => {
      await refreshAfterMutation()
      setOpen(false)
    },
  })

  const activeMutation = changeMutation.isPending
    ? changeMutation
    : retryMutation.isPending
      ? retryMutation
      : finalizeMutation
  const mutationError =
    changeMutation.error ?? retryMutation.error ?? finalizeMutation.error
  const errorText =
    mutationError instanceof Error
      ? mutationError.message
      : sourceQuery.error instanceof Error
        ? sourceQuery.error.message
        : null

  if (transition) {
    const canRetry = transition.listings.some(
      (listing) =>
        listing.status === "signed" ||
        listing.status === "partial" ||
        listing.status === "retry_needed"
    )
    const allDelivered = transition.listings.every(
      (listing) => listing.status === "delivered"
    )
    return (
      <div className="flex flex-wrap items-center gap-2">
        {canRetry ? (
          <Button
            type="button"
            size="sm"
            onClick={() => retryMutation.mutate()}
            disabled={retryMutation.isPending}
          >
            {retryMutation.isPending ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw className="size-4" aria-hidden="true" />
            )}
            Retry undelivered listings
          </Button>
        ) : null}
        {allDelivered ? (
          <Button
            type="button"
            size="sm"
            onClick={() => finalizeMutation.mutate()}
            disabled={finalizeMutation.isPending}
          >
            {finalizeMutation.isPending ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            Check acceptance and finish
          </Button>
        ) : null}
        {errorText ? (
          <p
            className="w-full text-pretty text-xs leading-5 text-error"
            role="alert"
          >
            {errorText}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        {arrangement.state === "consistent"
          ? "Change arrangement"
          : "Reconcile event listings"}
      </Button>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review the event-wide handoff change</DialogTitle>
          <DialogDescription className="text-pretty leading-6">
            Every listed product below will receive a new signed revision. The
            original handoff snapshots on existing orders remain unchanged.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <fieldset
            className="grid gap-2 sm:grid-cols-2"
            disabled={activeMutation.isPending}
          >
            <legend className="text-sm font-medium text-[var(--text-primary)]">
              New arrangement
            </legend>
            <Button
              type="button"
              variant="outline"
              aria-pressed={effectiveTargetMode === "merchant_handoff"}
              className={cn(
                "h-auto justify-start whitespace-normal p-3 text-left",
                effectiveTargetMode === "merchant_handoff" &&
                  "border-primary-500 bg-primary-500/10"
              )}
              onClick={() => setTargetMode("merchant_handoff")}
            >
              I hand it out
            </Button>
            {organizerAvailable ? (
              <Button
                type="button"
                variant="outline"
                aria-pressed={effectiveTargetMode === "organizer_handoff"}
                className={cn(
                  "h-auto justify-start whitespace-normal p-3 text-left",
                  effectiveTargetMode === "organizer_handoff" &&
                    "border-secondary-500 bg-secondary-500/10"
                )}
                onClick={() => setTargetMode("organizer_handoff")}
              >
                Organizer hands it out
              </Button>
            ) : null}
          </fieldset>

          {effectiveTargetMode === "merchant_handoff" ? (
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <div className="grid gap-1.5">
                <Label htmlFor="handoff-change-location">
                  Pickup point or booth
                </Label>
                <Input
                  id="handoff-change-location"
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  disabled={activeMutation.isPending}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="handoff-change-country">Country</Label>
                <Input
                  id="handoff-change-country"
                  value={country}
                  maxLength={2}
                  className="uppercase"
                  onChange={(event) =>
                    setCountry(event.target.value.toUpperCase())
                  }
                  disabled={activeMutation.isPending}
                />
              </div>
            </div>
          ) : null}

          <section className="grid gap-2" aria-label="Affected event listings">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-balance text-sm font-semibold text-[var(--text-primary)]">
                Affected listings
              </h3>
              {sourceQuery.data ? (
                <Badge variant="outline">
                  {sourceQuery.data.affected.length} total
                </Badge>
              ) : null}
            </div>
            {sourceQuery.isPending ? (
              <p className="flex items-center gap-2 text-pretty text-sm text-[var(--text-muted)]">
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Reading exact current revisions…
              </p>
            ) : sourceQuery.data ? (
              <ul className="grid gap-2">
                {sourceQuery.data.affected.map((listing) => (
                  <li
                    key={listing.productCoordinate}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium text-[var(--text-primary)]">
                        {listing.product.title}
                      </span>
                      <Badge
                        variant={
                          listing.status === "accepted" ? "success" : "outline"
                        }
                      >
                        {listing.status}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-[var(--text-muted)]">
                      {listing.productCoordinate}
                    </p>
                    <p className="mt-1 text-pretty text-xs text-[var(--text-muted)]">
                      {listing.previousHandoffMode
                        ? targetLabel(listing.previousHandoffMode)
                        : "Existing handoff unresolved"}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <p className="text-pretty text-xs leading-5 text-[var(--text-muted)]">
            Accepted listings become pending after their handoff revision until
            the organizer signs a current collection acceptance. Each signed
            listing is retained for exact retry before relay delivery.
          </p>
          {targetIsCurrent ? (
            <p
              className="text-pretty text-sm text-[var(--warning)]"
              role="status"
            >
              Choose a different arrangement, or close this review.
            </p>
          ) : null}
          {errorText ? (
            <p
              className="text-pretty text-sm leading-6 text-error"
              role="alert"
            >
              {errorText}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={activeMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => changeMutation.mutate()}
            disabled={
              activeMutation.isPending ||
              sourceQuery.isPending ||
              !sourceQuery.data ||
              targetIsCurrent
            }
          >
            {changeMutation.isPending ? (
              <>
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Signing listing updates…
              </>
            ) : (
              `Change ${sourceQuery.data?.affected.length ?? 0} listings`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
