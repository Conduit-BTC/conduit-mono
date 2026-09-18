import { useId, useRef, useState } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query"
import {
  CalendarDays,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Loader2,
  MapPin,
  PackagePlus,
  RefreshCw,
  Store,
} from "lucide-react"
import {
  buildMarketEventMerchantBoothUrl,
  useProfile,
  type EventMarketHandoffMode,
} from "@conduit/core"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  cn,
  eventMarketRequiredRecordsResolved,
  formatEventRelayReadCoverage,
  getEventActionabilityPresentation,
} from "@conduit/ui"
import {
  isParticipationProductAvailable,
  getResolvedEventMarketRelayHints,
  resolveOrganizerEventMarket,
  type MerchantOrganizerEventMarket,
} from "../lib/event-market"
import { getEventMarketUrl, inferMarketOrigin } from "../lib/market-links"
import {
  createMerchantEventHandoffPreference,
  loadMerchantEventHandoffPreference,
  resolveMerchantEventHandoffArrangement,
  saveMerchantEventHandoffPreference,
  type MerchantEventHandoffArrangement,
  type MerchantEventHandoffPreference,
} from "../lib/merchant-event-handoff-arrangement"
import {
  loadMerchantEventHandoffChange,
  type MerchantEventHandoffChangeJournal,
} from "../lib/merchant-event-handoff-change"
import {
  getMerchantEventHandoffTransitionSummary,
  type MerchantEventHandoffTransitionSummary,
} from "../lib/merchant-event-handoff-transition"
import { EventActorName, EventActorProvenance } from "./EventActorIdentity"
import { EventProductPublisherDialog } from "./EventProductPublisherDialog"
import { MerchantEventHandoffChangeDialog } from "./MerchantEventHandoffChangeDialog"

interface MerchantEventHandoffView {
  arrangement: MerchantEventHandoffArrangement
  preference: MerchantEventHandoffPreference | null
  transition: MerchantEventHandoffChangeJournal | null
  transitionSummary: MerchantEventHandoffTransitionSummary | null
}

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

function handoffLabel(mode: EventMarketHandoffMode): string {
  return mode === "organizer_handoff"
    ? "Organizer hands it out"
    : "I hand it out"
}

function resolvedPreference(
  view: MerchantEventHandoffView | undefined
): MerchantEventHandoffPreference | null {
  if (!view || view.arrangement.state !== "consistent") return null
  return (
    view.preference ?? {
      version: 1,
      merchantPubkey: view.arrangement.merchantPubkey,
      collectionCoordinate: view.arrangement.collectionCoordinate,
      ...view.arrangement.selection,
      savedAt: 0,
    }
  )
}

function arrangementBlockMessage(
  arrangement: Exclude<
    MerchantEventHandoffArrangement,
    { state: "unconfigured" | "consistent" | "transitioning" }
  >
): string {
  if (arrangement.state === "legacy_equivalent") {
    return `${arrangement.listings.length} existing event listing${arrangement.listings.length === 1 ? " uses" : "s use"} equivalent but separate merchant pickup records. Reconcile them to one merchant/event pickup record before publishing another product.`
  }
  if (arrangement.state === "conflicting") {
    const reason = arrangement.reasons[0]
    if (reason === "organizer_offer_changed") {
      return "The organizer handoff offer no longer matches every existing listing. Reconcile the affected listings before publishing another product."
    }
    if (reason === "different_merchant_pickup_terms") {
      return "Existing listings disagree about the merchant pickup terms. Reconcile them before publishing another product."
    }
    if (reason === "preference_mismatch") {
      return "The saved event arrangement conflicts with signed listing evidence. Reconcile the signed listings before publishing another product."
    }
    return "Existing listings use conflicting or invalid handoff authority. Reconcile them before publishing another product."
  }
  if (arrangement.reason === "partial_without_known_arrangement") {
    return "The relay view is partial and no verified event arrangement is known yet. Refresh before choosing or publishing."
  }
  if (arrangement.reason === "listing_handoff_unresolved") {
    return "At least one existing event listing has unresolved handoff evidence. Refresh or reconcile it before publishing another product."
  }
  if (arrangement.reason === "pickup_evidence_unavailable") {
    return "The signed pickup evidence for an existing listing is unavailable. Refresh before publishing another product."
  }
  return "The current event evidence is unavailable. Refresh before choosing or publishing an arrangement."
}

function transitionStatusLabel(
  status: MerchantEventHandoffChangeJournal["listings"][number]["status"]
): string {
  if (status === "awaiting_signature") return "Awaiting signature"
  if (status === "retry_needed") return "Retry needed"
  if (status === "partial") return "Partially delivered"
  if (status === "delivered") return "Delivered"
  return "Signed"
}

function merchantEventHandoffQueryKey(
  merchantPubkey: string,
  market: MerchantOrganizerEventMarket
): QueryKey {
  const evidenceKey = market.participation
    .map((item) =>
      [
        item.productCoordinate,
        item.status,
        item.fulfillmentStatus ?? "",
        item.pickupCoordinate ?? "",
        item.handoffMode ?? "",
        item.handlerPubkey ?? "",
      ].join(":")
    )
    .sort()
    .join("|")
  return [
    "merchant-event-handoff-arrangement",
    merchantPubkey,
    market.collectionCoordinate,
    market.state,
    market.collectionEventId ?? "",
    market.pickupEventId ?? "",
    evidenceKey,
  ]
}

function formatSchedule(market: MerchantOrganizerEventMarket): string {
  if (market.calendarKind === 31922) {
    return market.end ? `${market.start} – ${market.end}` : String(market.start)
  }
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: market.timezone || "UTC",
    })
    const start =
      typeof market.start === "number"
        ? formatter.format(new Date(market.start * 1_000))
        : String(market.start)
    const end =
      typeof market.end === "number"
        ? formatter.format(new Date(market.end * 1_000))
        : market.end
    return end ? `${start} – ${end}` : start
  } catch {
    return "Schedule unavailable"
  }
}

function actionabilityClassName(
  presentation: ReturnType<typeof getEventActionabilityPresentation>
): string {
  if (!presentation.prominent) {
    return "text-pretty text-sm font-medium text-[var(--text-secondary)]"
  }
  return presentation.tone === "destructive"
    ? "rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-pretty text-sm font-medium text-error"
    : "rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-pretty text-sm font-medium text-[var(--text-primary)]"
}

function getMerchantProductAvailability(market: MerchantOrganizerEventMarket): {
  availableProductCount: number
  unresolvedProductCount: number
} {
  const acceptedProducts = market.participation.filter(
    (item) => item.status === "accepted"
  )
  const organizerOnlyProductCount = market.participation.filter(
    (item) => item.status === "organizer_only"
  ).length
  const availableProductCount = acceptedProducts.filter((item) =>
    isParticipationProductAvailable(item, market.organizerPubkey)
  ).length

  return {
    availableProductCount,
    unresolvedProductCount:
      organizerOnlyProductCount +
      (acceptedProducts.length - availableProductCount),
  }
}

function getPickupSummary(market: MerchantOrganizerEventMarket): string {
  if (!market.pickupCoordinate) {
    return "Merchants hand out from their own pickup point."
  }
  if (!market.source.pickup) {
    return "Organizer handoff details are unresolved. Your exact merchant pickup evidence still controls whether your product can be handed out safely."
  }
  return "Organizer handoff is available, or you can hand out from your own pickup point."
}

function MerchantEventHandoffSetup({
  merchantPubkey,
  authenticatedPubkey,
  shouldContinue,
  market,
  disabled,
  queryKey,
  initialPreference,
}: {
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  market: MerchantOrganizerEventMarket
  disabled: boolean
  queryKey: QueryKey
  initialPreference?: MerchantEventHandoffPreference | null
}) {
  const fieldId = useId()
  const queryClient = useQueryClient()
  const organizerAvailable = organizerHandoffAvailable(market, merchantPubkey)
  const [mode, setMode] = useState<EventMarketHandoffMode>(
    initialPreference?.mode ?? "merchant_handoff"
  )
  const [location, setLocation] = useState(
    initialPreference?.merchantPickup?.location ?? market.eventLocation ?? ""
  )
  const [country, setCountry] = useState(
    initialPreference?.merchantPickup?.countries[0] ??
      market.pickupCountry ??
      "US"
  )
  const effectiveMode =
    mode === "organizer_handoff" && !organizerAvailable
      ? "merchant_handoff"
      : mode
  const configureMutation = useMutation({
    mutationFn: async () => {
      const freshMarket = await resolveOrganizerEventMarket(
        market.naddr,
        market.organizerPubkey,
        authenticatedPubkey,
        undefined,
        shouldContinue
      )
      if (freshMarket.state !== "active") {
        throw new Error(
          "A complete active event read is required before choosing the handoff arrangement."
        )
      }
      const freshPreference = loadMerchantEventHandoffPreference(
        merchantPubkey,
        freshMarket.collectionCoordinate
      )
      const freshTransition = loadMerchantEventHandoffChange(
        merchantPubkey,
        freshMarket.collectionCoordinate
      )
      const freshArrangement = await resolveMerchantEventHandoffArrangement({
        merchantPubkey,
        market: freshMarket,
        preference: freshPreference,
        transition: freshTransition,
      })
      if (
        freshTransition ||
        freshArrangement.listings.length > 0 ||
        (freshArrangement.state !== "unconfigured" &&
          freshArrangement.state !== "consistent")
      ) {
        throw new Error(
          "Signed event listings now exist or conflict with this preference. Refresh and reconcile before changing it."
        )
      }
      const preference = await createMerchantEventHandoffPreference({
        merchantPubkey,
        market: freshMarket,
        mode: effectiveMode,
        ...(effectiveMode === "merchant_handoff"
          ? {
              merchantPickup: {
                title: "Merchant pickup",
                location,
                country,
              },
            }
          : {}),
      })
      saveMerchantEventHandoffPreference(preference)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey })
    },
  })
  const error = configureMutation.error
  const errorText =
    error instanceof Error
      ? error.message
      : error
        ? "The event arrangement could not be saved."
        : ""

  return (
    <form
      className="grid gap-4 rounded-xl border border-primary-500/30 bg-primary-500/10 p-4"
      data-testid="merchant-event-handoff-setup"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled && !configureMutation.isPending) {
          configureMutation.mutate()
        }
      }}
    >
      <div>
        <h3 className="text-balance font-semibold text-[var(--text-primary)]">
          Choose the event handoff arrangement
        </h3>
        <p className="mt-1 max-w-3xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
          Choose once before publishing this event&apos;s first product. Every
          product you publish for this event inherits this arrangement. Changing
          it later requires updating every affected listing.
        </p>
      </div>

      <fieldset
        className="grid gap-2 sm:grid-cols-2"
        disabled={disabled || configureMutation.isPending}
      >
        <legend className="sr-only">Event handoff arrangement</legend>
        <Button
          type="button"
          variant="outline"
          aria-pressed={effectiveMode === "merchant_handoff"}
          className={cn(
            "h-auto justify-start whitespace-normal p-3 text-left",
            effectiveMode === "merchant_handoff" &&
              "border-primary-500 bg-primary-500/10"
          )}
          onClick={() => setMode("merchant_handoff")}
        >
          <span>
            <span className="block font-medium">I hand it out</span>
            <span className="mt-1 block text-pretty text-xs leading-5 text-[var(--text-muted)]">
              Buyers collect from your booth or merchant pickup point.
            </span>
          </span>
        </Button>
        {organizerAvailable ? (
          <Button
            type="button"
            variant="outline"
            aria-pressed={effectiveMode === "organizer_handoff"}
            className={cn(
              "h-auto justify-start whitespace-normal p-3 text-left",
              effectiveMode === "organizer_handoff" &&
                "border-secondary-500 bg-secondary-500/10"
            )}
            onClick={() => setMode("organizer_handoff")}
          >
            <span>
              <span className="block font-medium">Organizer hands it out</span>
              <span className="mt-1 block text-pretty text-xs leading-5 text-[var(--text-muted)]">
                You confirm payment and readiness; the organizer records
                collection using the accepted pickup arrangement.
              </span>
            </span>
          </Button>
        ) : null}
      </fieldset>

      {effectiveMode === "merchant_handoff" ? (
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <div className="grid gap-1.5">
            <Label htmlFor={`${fieldId}-location`}>Pickup point or booth</Label>
            <Input
              id={`${fieldId}-location`}
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              disabled={disabled || configureMutation.isPending}
              aria-describedby={errorText ? `${fieldId}-error` : undefined}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${fieldId}-country`}>Country</Label>
            <Input
              id={`${fieldId}-country`}
              maxLength={2}
              className="uppercase"
              value={country}
              onChange={(event) => setCountry(event.target.value.toUpperCase())}
              disabled={disabled || configureMutation.isPending}
              aria-describedby={errorText ? `${fieldId}-error` : undefined}
            />
          </div>
        </div>
      ) : null}

      {errorText ? (
        <p
          id={`${fieldId}-error`}
          className="text-pretty text-sm text-error"
          role="alert"
        >
          {errorText}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={disabled || configureMutation.isPending}
        >
          {configureMutation.isPending ? (
            <>
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              Saving arrangement…
            </>
          ) : initialPreference ? (
            "Update arrangement"
          ) : (
            "Use this arrangement"
          )}
        </Button>
        {disabled ? (
          <p className="text-pretty text-xs leading-5 text-[var(--text-muted)]">
            Refresh the event before saving its arrangement.
          </p>
        ) : null}
      </div>
    </form>
  )
}

function MerchantEventHandoffStatus({
  merchantPubkey,
  authenticatedPubkey,
  shouldContinue,
  market,
  view,
  loading,
  error,
  marketPublishable,
  boothUrl,
  queryKey,
  onRefresh,
}: {
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  market: MerchantOrganizerEventMarket
  view: MerchantEventHandoffView | undefined
  loading: boolean
  error: unknown
  marketPublishable: boolean
  boothUrl: string | null
  queryKey: QueryKey
  onRefresh: () => void | Promise<void>
}) {
  if (loading) {
    return (
      <section
        className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
        aria-label="Event handoff arrangement"
        aria-busy="true"
      >
        <div className="h-5 w-48 animate-pulse rounded bg-[var(--surface)] motion-reduce:animate-none" />
        <div className="h-4 w-full animate-pulse rounded bg-[var(--surface)] motion-reduce:animate-none" />
      </section>
    )
  }

  if (error || !view) {
    const message =
      error instanceof Error
        ? error.message
        : "The event arrangement could not be verified."
    return (
      <section
        className="flex items-start gap-3 rounded-xl border border-error/30 bg-error/10 p-4 text-error"
        role="alert"
        data-testid="merchant-event-handoff-blocked"
      >
        <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div>
          <h3 className="text-balance font-semibold">
            Event arrangement unavailable
          </h3>
          <p className="mt-1 text-pretty text-sm leading-6">{message}</p>
        </div>
      </section>
    )
  }

  const { arrangement, transition, transitionSummary } = view
  if (
    market.state === "active" &&
    arrangement.listings.length === 0 &&
    (arrangement.state === "unconfigured" || arrangement.state === "consistent")
  ) {
    return (
      <MerchantEventHandoffSetup
        key={`${market.collectionCoordinate}:${view.preference?.savedAt ?? "new"}`}
        merchantPubkey={merchantPubkey}
        authenticatedPubkey={authenticatedPubkey}
        shouldContinue={shouldContinue}
        market={market}
        disabled={!marketPublishable}
        queryKey={queryKey}
        initialPreference={view.preference}
      />
    )
  }
  if (arrangement.state === "unconfigured") {
    return (
      <MerchantEventHandoffSetup
        key={market.collectionCoordinate}
        merchantPubkey={merchantPubkey}
        authenticatedPubkey={authenticatedPubkey}
        shouldContinue={shouldContinue}
        market={market}
        disabled
        queryKey={queryKey}
      />
    )
  }

  if (arrangement.state === "consistent") {
    const merchantPickup = arrangement.selection.merchantPickup
    return (
      <section
        className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 p-4"
        aria-label="Event handoff arrangement"
        data-testid="merchant-event-handoff-consistent"
      >
        <CircleCheck
          className="mt-0.5 size-5 shrink-0 text-success"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-balance font-semibold text-[var(--text-primary)]">
              {handoffLabel(arrangement.selection.mode)}
            </h3>
            <Badge variant="success">Event arrangement</Badge>
          </div>
          <p className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Every new product for this event inherits this arrangement. It is
            not reset when you create or copy a product.
          </p>
          {merchantPickup ? (
            <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-muted)]">
              {merchantPickup.location || merchantPickup.title} ·{" "}
              {merchantPickup.countries.join(", ")}
            </p>
          ) : null}
          {arrangement.listings.length > 0 ? (
            <p className="mt-1 text-pretty text-xs tabular-nums text-[var(--text-muted)]">
              {arrangement.listings.length} existing event listing
              {arrangement.listings.length === 1 ? "" : "s"} use this
              arrangement.
            </p>
          ) : null}
          {arrangement.selection.mode === "merchant_handoff" && boothUrl ? (
            <div className="mt-3">
              <Button type="button" variant="outline" size="sm" asChild>
                <a href={boothUrl} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" /> Open booth shopping
                </a>
              </Button>
              <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-muted)]">
                This link opens the event and merchant context for shoppers. It
                does not override signed stock, price, payment, or handoff
                checks.
              </p>
            </div>
          ) : null}
          {arrangement.listings.length > 0 ? (
            <div className="mt-3">
              <MerchantEventHandoffChangeDialog
                merchantPubkey={merchantPubkey}
                authenticatedPubkey={authenticatedPubkey}
                shouldContinue={shouldContinue}
                market={market}
                arrangement={arrangement}
                transition={null}
                queryKey={queryKey}
                onRefresh={onRefresh}
              />
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  if (arrangement.state === "transitioning") {
    const completed =
      transitionSummary?.delivered ?? arrangement.completedListingCount
    const total = transitionSummary?.total ?? arrangement.totalListingCount
    return (
      <section
        className="grid gap-3 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4"
        role="status"
        data-testid="merchant-event-handoff-transition"
      >
        <div className="flex items-start gap-3">
          <RefreshCw
            className="mt-0.5 size-5 shrink-0 text-[var(--warning)]"
            aria-hidden="true"
          />
          <div>
            <h3 className="text-balance font-semibold text-[var(--text-primary)]">
              Changing to “{handoffLabel(arrangement.target.mode)}”
            </h3>
            <p className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
              <span className="tabular-nums">
                {completed} of {total}
              </span>{" "}
              affected listing updates are delivered. New publishing stays
              blocked until every signed listing is delivered and the
              arrangement is reconciled.
            </p>
          </div>
        </div>
        {transitionSummary ? (
          <div className="flex flex-wrap gap-2" aria-label="Transition totals">
            <Badge variant="success">
              {transitionSummary.delivered} delivered
            </Badge>
            {transitionSummary.partial > 0 ? (
              <Badge variant="warning">
                {transitionSummary.partial} partial
              </Badge>
            ) : null}
            {transitionSummary.retryNeeded > 0 ? (
              <Badge variant="destructive">
                {transitionSummary.retryNeeded} retry needed
              </Badge>
            ) : null}
            {transitionSummary.awaitingSignature > 0 ? (
              <Badge variant="outline">
                {transitionSummary.awaitingSignature} awaiting signature
              </Badge>
            ) : null}
            {transitionSummary.signed > 0 ? (
              <Badge variant="outline">{transitionSummary.signed} signed</Badge>
            ) : null}
          </div>
        ) : null}
        {transition ? (
          <ul className="grid gap-2" aria-label="Affected listings">
            {transition.listings.map((listing) => (
              <li
                key={listing.productCoordinate}
                className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
                    {listing.title || "Event listing"}
                  </span>
                  <span className="block truncate font-mono text-xs text-[var(--text-muted)]">
                    {listing.productCoordinate}
                  </span>
                </span>
                <Badge
                  className="shrink-0"
                  variant={
                    listing.status === "delivered"
                      ? "success"
                      : listing.status === "retry_needed"
                        ? "destructive"
                        : listing.status === "partial"
                          ? "warning"
                          : "outline"
                  }
                >
                  {transitionStatusLabel(listing.status)}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {transition ? (
          <MerchantEventHandoffChangeDialog
            merchantPubkey={merchantPubkey}
            authenticatedPubkey={authenticatedPubkey}
            shouldContinue={shouldContinue}
            market={market}
            arrangement={arrangement}
            transition={transition}
            queryKey={queryKey}
            onRefresh={onRefresh}
          />
        ) : null}
      </section>
    )
  }

  const message = arrangementBlockMessage(arrangement)
  return (
    <section
      className="flex items-start gap-3 rounded-xl border border-error/30 bg-error/10 p-4 text-error"
      role="alert"
      data-testid={`merchant-event-handoff-${arrangement.state}`}
    >
      <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <h3 className="text-balance font-semibold">
          {arrangement.state === "legacy_equivalent"
            ? "Pickup records need reconciliation"
            : arrangement.state === "conflicting"
              ? "Event arrangements conflict"
              : "Event arrangement unresolved"}
        </h3>
        <p className="mt-1 text-pretty text-sm leading-6">{message}</p>
        {(arrangement.state === "legacy_equivalent" ||
          arrangement.state === "conflicting") &&
        market.state === "active" ? (
          <div className="mt-3 text-[var(--text-primary)]">
            <MerchantEventHandoffChangeDialog
              merchantPubkey={merchantPubkey}
              authenticatedPubkey={authenticatedPubkey}
              shouldContinue={shouldContinue}
              market={market}
              arrangement={arrangement}
              transition={null}
              queryKey={queryKey}
              onRefresh={onRefresh}
            />
          </div>
        ) : null}
      </div>
    </section>
  )
}

function useResolvedMerchantEventHandoff(
  merchantPubkey: string,
  market: MerchantOrganizerEventMarket
) {
  const queryKey = merchantEventHandoffQueryKey(merchantPubkey, market)
  const query = useQuery({
    queryKey,
    retry: false,
    queryFn: async (): Promise<MerchantEventHandoffView> => {
      const preference = loadMerchantEventHandoffPreference(
        merchantPubkey,
        market.collectionCoordinate
      )
      const transition = loadMerchantEventHandoffChange(
        merchantPubkey,
        market.collectionCoordinate
      )
      const arrangement = await resolveMerchantEventHandoffArrangement({
        merchantPubkey,
        market,
        preference,
        transition,
      })
      return {
        arrangement,
        preference,
        transition,
        transitionSummary: transition
          ? getMerchantEventHandoffTransitionSummary(transition)
          : null,
      }
    },
  })
  const preference = resolvedPreference(query.data)
  const boothUrl =
    preference?.mode === "merchant_handoff"
      ? buildMarketEventMerchantBoothUrl(
          inferMarketOrigin(),
          market.naddr,
          merchantPubkey
        )
      : null
  return { query, queryKey, preference, boothUrl }
}

export function MerchantEventMarketPanel({
  merchantPubkey,
  authenticatedPubkey,
  shouldContinue,
  market,
  refreshing,
  onRefresh,
  compact = false,
}: {
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  market: MerchantOrganizerEventMarket
  refreshing: boolean
  onRefresh: () => void | Promise<void>
  compact?: boolean
}) {
  const publishDisabledId = useId()
  const [publisherOpen, setPublisherOpen] = useState(false)
  const [publishedAccepted, setPublishedAccepted] = useState<boolean | null>(
    null
  )
  const publicationRefreshPending = useRef(false)
  const ownsMarket = merchantPubkey === market.organizerPubkey
  const marketPublishable = market.state === "active"
  const {
    query: handoffViewQuery,
    queryKey: handoffQueryKey,
    preference: handoffPreference,
    boothUrl,
  } = useResolvedMerchantEventHandoff(merchantPubkey, market)
  const publishable = marketPublishable && !!handoffPreference
  const organizerProfileQuery = useProfile(market.organizerPubkey, {
    accountPubkey: merchantPubkey,
    authenticatedPubkey,
    shouldContinue,
    relayHints: getResolvedEventMarketRelayHints(market.source),
    priority: "visible",
    maxUnresolvedRefetches: 1,
  })
  const { availableProductCount, unresolvedProductCount } =
    getMerchantProductAvailability(market)
  const actionability = getEventActionabilityPresentation({
    state: market.state,
    availableProductCount,
    unresolvedProductCount,
    requiredEventRecordsResolved: eventMarketRequiredRecordsResolved(
      market.source
    ),
  })
  const relayCoverage = formatEventRelayReadCoverage(market.source.coverage)
  const publishDisabledMessage = !marketPublishable
    ? "Publishing is unavailable until a complete active event read verifies the merchant/event handoff arrangement."
    : handoffViewQuery.isPending
      ? "The event handoff arrangement is still being verified."
      : "Choose or reconcile the event handoff arrangement before publishing a product."
  const publisherControls = (
    <>
      <div className="flex flex-col gap-3 rounded-xl border border-primary-500/30 bg-primary-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-balance font-semibold text-[var(--text-primary)]">
            Sell at this event
          </h3>
          <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Publish a new product from scratch or copy one of your existing
            products.{" "}
            {ownsMarket
              ? "Your own product is accepted into this event when you approve its collection signature."
              : "The organizer reviews it before it appears in the event collection."}
          </p>
          {publishedAccepted !== null && (
            <p
              className="mt-2 text-pretty text-xs font-medium text-success"
              role="status"
            >
              {publishedAccepted
                ? "Product published and accepted into your event."
                : "Product published. Organizer acceptance is pending."}
            </p>
          )}
        </div>
        <Button
          type="button"
          className="shrink-0"
          disabled={!publishable}
          aria-describedby={!publishable ? publishDisabledId : undefined}
          onClick={() => setPublisherOpen(true)}
        >
          <PackagePlus /> Publish product
        </Button>
      </div>
      {!publishable && (
        <p
          id={publishDisabledId}
          className="text-xs leading-5 text-[var(--text-muted)]"
        >
          {publishDisabledMessage}
        </p>
      )}
    </>
  )
  const handoffControls = (
    <MerchantEventHandoffStatus
      merchantPubkey={merchantPubkey}
      authenticatedPubkey={authenticatedPubkey}
      shouldContinue={shouldContinue}
      market={market}
      view={handoffViewQuery.data}
      loading={handoffViewQuery.isPending}
      error={handoffViewQuery.error}
      marketPublishable={marketPublishable}
      boothUrl={boothUrl}
      queryKey={handoffQueryKey}
      onRefresh={onRefresh}
    />
  )

  async function refreshMarket(): Promise<void> {
    await onRefresh()
    await handoffViewQuery.refetch()
  }

  return (
    <>
      {compact ? (
        <section className="grid gap-3" aria-label="Sell at this event">
          {handoffControls}
          {publisherControls}
        </section>
      ) : (
        <Card className="overflow-hidden">
          {market.imageUrl && (
            <img
              src={market.imageUrl}
              alt=""
              className="h-48 w-full border-b border-[var(--border)] bg-[var(--surface-elevated)] object-contain sm:h-60"
            />
          )}
          <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge variant={actionability.tone}>
                  {actionability.label}
                </Badge>
                <Badge variant="outline">Published by organizer</Badge>
              </div>
              <p
                className={actionabilityClassName(actionability)}
                role={actionability.role}
                data-testid="merchant-event-actionability-status"
              >
                {actionability.prominent ? (
                  <span className="sr-only">{actionability.label}: </span>
                ) : null}
                {actionability.message}
              </p>
              {relayCoverage ? (
                <p
                  className="mt-1 text-pretty text-xs tabular-nums text-[var(--text-muted)]"
                  role="status"
                  aria-label={`Relay read coverage: ${relayCoverage}`}
                  data-testid="merchant-event-relay-read-coverage"
                >
                  {relayCoverage}
                </p>
              ) : null}
              <CardTitle className="text-balance text-2xl">
                {market.title}
              </CardTitle>
              {market.summary && (
                <CardDescription className="mt-2 max-w-3xl text-pretty leading-6">
                  {market.summary}
                </CardDescription>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={refreshing}
                onClick={() => void refreshMarket()}
              >
                <RefreshCw
                  className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
                />
                Refresh
              </Button>
              <Button type="button" variant="outline" asChild>
                <a
                  href={getEventMarketUrl(market.naddr)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink /> Shopper page
                </a>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid gap-5">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
                <div>
                  <dt className="font-medium text-[var(--text-primary)]">
                    Date and time
                  </dt>
                  <dd className="mt-1 leading-6 text-[var(--text-secondary)]">
                    {formatSchedule(market)}
                  </dd>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
                <div>
                  <dt className="font-medium text-[var(--text-primary)]">
                    Location
                  </dt>
                  <dd className="mt-1 leading-6 text-[var(--text-secondary)]">
                    {market.eventLocation ||
                      market.eventGeohash ||
                      "Not provided"}
                  </dd>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                <Store className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
                <div>
                  <dt className="font-medium text-[var(--text-primary)]">
                    Organizer
                  </dt>
                  <dd className="mt-1 min-w-0 leading-6">
                    <EventActorName
                      pubkey={market.organizerPubkey}
                      profile={organizerProfileQuery.data}
                      className="block text-sm"
                    />
                    <EventActorProvenance
                      pubkey={market.organizerPubkey}
                      copyLabel="Copy organizer npub"
                      className="mt-0.5 max-w-full text-xs"
                    />
                  </dd>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                <PackagePlus className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
                <div>
                  <dt className="font-medium text-[var(--text-primary)]">
                    Pickup
                  </dt>
                  <dd className="mt-1 leading-6 text-[var(--text-secondary)]">
                    {getPickupSummary(market)}
                  </dd>
                </div>
              </div>
            </dl>

            {handoffControls}
            {publisherControls}
          </CardContent>
        </Card>
      )}

      {handoffPreference ? (
        <EventProductPublisherDialog
          key={`${publisherOpen ? "open" : "closed"}:${market.collectionCoordinate}`}
          open={publisherOpen}
          merchantPubkey={merchantPubkey}
          authenticatedPubkey={authenticatedPubkey}
          shouldContinue={shouldContinue}
          market={market}
          handoffPreference={handoffPreference}
          onOpenChange={(open) => {
            setPublisherOpen(open)
            if (!open && publicationRefreshPending.current) {
              publicationRefreshPending.current = false
              void refreshMarket()
            }
          }}
          onPublished={(accepted) => {
            setPublishedAccepted(accepted)
            publicationRefreshPending.current = true
          }}
        />
      ) : null}
    </>
  )
}
