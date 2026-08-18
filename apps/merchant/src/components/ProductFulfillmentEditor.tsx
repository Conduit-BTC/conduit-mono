import { useEffect, useState } from "react"
import { CalendarDays, Check, Loader2, MapPin, Search } from "lucide-react"
import type { EventMarketHandoffMode } from "@conduit/core"
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  cn,
} from "@conduit/ui"
import type { MerchantOrganizerEventMarket } from "../lib/event-market"
import {
  canonicalizeProductEventMarketReference,
  getProductLocalPickupEvidenceError,
  type ProductEventParticipationState,
} from "../lib/product-local-pickup"
import type { ProductFulfillmentIntent } from "../lib/productForm"

function participationLabel(state: ProductEventParticipationState): string {
  switch (state) {
    case "accepted":
      return "Organizer accepted"
    case "pending":
      return "Request pending"
    case "will_request":
      return "Will request participation"
    default:
      return "Participation unavailable"
  }
}

export function ProductFulfillmentEditor({
  intent,
  reference,
  handoffMode,
  merchantPickupTitle,
  merchantPickupLocation,
  merchantPickupGeohash,
  merchantPickupCountry,
  market,
  organizerInboxState,
  availableMarkets,
  resolving,
  readFailed,
  participation,
  onIntentChange,
  onReferenceChange,
  onHandoffModeChange,
  onMerchantPickupChange,
}: {
  intent: ProductFulfillmentIntent
  reference: string
  handoffMode: EventMarketHandoffMode
  merchantPickupTitle: string
  merchantPickupLocation: string
  merchantPickupGeohash: string
  merchantPickupCountry: string
  market?: MerchantOrganizerEventMarket | null
  organizerInboxState: "idle" | "checking" | "ready" | "unavailable"
  availableMarkets: readonly MerchantOrganizerEventMarket[]
  resolving: boolean
  readFailed: boolean
  participation: ProductEventParticipationState
  onIntentChange: (intent: ProductFulfillmentIntent) => void
  onReferenceChange: (reference: string) => void
  onHandoffModeChange: (mode: EventMarketHandoffMode) => void
  onMerchantPickupChange: (
    field:
      | "merchantPickupTitle"
      | "merchantPickupLocation"
      | "merchantPickupGeohash"
      | "merchantPickupCountry",
    value: string
  ) => void
}) {
  const [draftReference, setDraftReference] = useState(reference)
  const [importError, setImportError] = useState("")

  useEffect(() => {
    setDraftReference(reference)
    setImportError("")
  }, [reference])

  const baseEvidenceError =
    intent === "local_pickup"
      ? getProductLocalPickupEvidenceError({
          reference,
          market,
          resolving,
          readFailed,
        })
      : null
  const evidenceError =
    baseEvidenceError ??
    (intent === "local_pickup"
      ? getProductLocalPickupEvidenceError({
          reference,
          market,
          handoffMode,
          resolving,
          readFailed,
        })
      : null)

  function importReference(): void {
    try {
      const canonical = canonicalizeProductEventMarketReference(draftReference)
      onReferenceChange(canonical)
      setDraftReference(canonical)
      setImportError("")
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : "Paste a valid kind-30405 event catalog reference."
      )
    }
  }

  return (
    <div className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 sm:col-span-4">
      <div className="grid gap-1.5">
        <Label htmlFor="product-fulfillment">Fulfillment</Label>
        <Select
          value={intent}
          onValueChange={(value) =>
            onIntentChange(value as ProductFulfillmentIntent)
          }
        >
          <SelectTrigger id="product-fulfillment">
            <SelectValue placeholder="Choose fulfillment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="digital">Digital</SelectItem>
            <SelectItem value="ship">Ship</SelectItem>
            <SelectItem value="local_pickup">Local pickup</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {intent === "local_pickup" && (
        <div className="grid gap-3 border-t border-[var(--border)] pt-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <MapPin className="h-4 w-4 text-secondary-400" />
              Event pickup
            </div>
            <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
              Import the organizer collection naddr or Market share link. The
              product will reference the exact collection and one signed public
              pickup option. You choose who hands the item to the buyer.
            </p>
          </div>

          {availableMarkets.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="product-organizer-event-preset">
                Your active organizer events
              </Label>
              <Select
                value={
                  availableMarkets.some(
                    (candidate) => candidate.collectionCoordinate === reference
                  )
                    ? reference
                    : ""
                }
                onValueChange={onReferenceChange}
              >
                <SelectTrigger id="product-organizer-event-preset">
                  <SelectValue placeholder="Choose one of your signed events" />
                </SelectTrigger>
                <SelectContent>
                  {availableMarkets.map((candidate) => (
                    <SelectItem
                      key={candidate.collectionCoordinate}
                      value={candidate.collectionCoordinate}
                    >
                      {candidate.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="product-event-market-reference">
              Event catalog naddr or link
            </Label>
            <div className="flex gap-2">
              <Input
                id="product-event-market-reference"
                value={draftReference}
                onChange={(event) => setDraftReference(event.target.value)}
                placeholder="naddr1... or https://..."
                aria-invalid={!!importError}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!draftReference.trim() || resolving}
                onClick={importReference}
              >
                <Search />
                Import
              </Button>
            </div>
            {importError && (
              <p className="text-xs leading-5 text-error" role="alert">
                {importError}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <p className="text-xs leading-5 text-[var(--text-muted)]">
              Need a merchant-owned event and pickup option?
            </p>
            <Button type="button" size="sm" variant="ghost" asChild>
              <a href="/events" target="_blank" rel="noreferrer">
                <CalendarDays />
                Create or manage event
              </a>
            </Button>
          </div>

          {market && !baseEvidenceError && (
            <div className="grid gap-2" aria-label="Event handoff handler">
              <Label>Who hands out this product?</Label>
              <Button
                type="button"
                variant="outline"
                aria-pressed={handoffMode === "merchant_handoff"}
                className={cn(
                  "h-auto w-full justify-start whitespace-normal p-3 text-left",
                  handoffMode === "merchant_handoff"
                    ? "border-primary-500 bg-primary-500/10"
                    : "border-[var(--border)] bg-[var(--surface)]"
                )}
                onClick={() => onHandoffModeChange("merchant_handoff")}
              >
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  Merchant hands out
                </span>
                <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                  Buyers pick up from your booth. The order remains between you
                  and the buyer; no organizer receipt is shared.
                </span>
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-pressed={handoffMode === "organizer_handoff"}
                disabled={!market.pickupCoordinate}
                className={cn(
                  "h-auto w-full justify-start whitespace-normal p-3 text-left",
                  handoffMode === "organizer_handoff"
                    ? "border-secondary-500 bg-secondary-500/10"
                    : "border-[var(--border)] bg-[var(--surface)]"
                )}
                onClick={() => onHandoffModeChange("organizer_handoff")}
              >
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  Organizer hands out
                </span>
                <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                  After payment is verified, share a minimal ready receipt with
                  the organizer. They never receive the full order, buyer
                  contact, notes, address, invoice, or payment secrets.
                </span>
              </Button>

              {!market.pickupCoordinate && (
                <p className="text-xs leading-5 text-[var(--text-muted)]">
                  This organizer is not offering handoff for this event.
                  Merchant handoff remains available.
                </p>
              )}
              {market.pickupCoordinate &&
                handoffMode === "organizer_handoff" &&
                organizerInboxState !== "ready" && (
                  <p className="text-xs leading-5 text-warning" role="status">
                    {organizerInboxState === "checking"
                      ? "Checking the organizer's private receipt inbox. You can publish the participation request now, but checkout stays closed until the organizer has a usable inbox."
                      : "Organizer handoff can be requested, but buyer checkout stays closed until the organizer publishes a usable kind-10050 receipt inbox."}
                  </p>
                )}
            </div>
          )}

          {market &&
            !baseEvidenceError &&
            handoffMode === "merchant_handoff" && (
              <div className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    Public merchant booth pickup
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                    These details are public. Do not enter contact details,
                    attendee names, order notes, or private instructions.
                  </p>
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="product-merchant-pickup-title">
                    Pickup title
                  </Label>
                  <Input
                    id="product-merchant-pickup-title"
                    value={merchantPickupTitle}
                    onChange={(event) =>
                      onMerchantPickupChange(
                        "merchantPickupTitle",
                        event.target.value
                      )
                    }
                  />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="product-merchant-pickup-location">
                    Public booth location
                  </Label>
                  <Input
                    id="product-merchant-pickup-location"
                    value={merchantPickupLocation}
                    placeholder={
                      market.eventLocation ?? "Booth or handoff point"
                    }
                    onChange={(event) =>
                      onMerchantPickupChange(
                        "merchantPickupLocation",
                        event.target.value
                      )
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="product-merchant-pickup-geohash">
                    Geohash (optional)
                  </Label>
                  <Input
                    id="product-merchant-pickup-geohash"
                    value={merchantPickupGeohash}
                    onChange={(event) =>
                      onMerchantPickupChange(
                        "merchantPickupGeohash",
                        event.target.value
                      )
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="product-merchant-pickup-country">
                    Country code
                  </Label>
                  <Input
                    id="product-merchant-pickup-country"
                    maxLength={2}
                    className="uppercase"
                    value={merchantPickupCountry}
                    onChange={(event) =>
                      onMerchantPickupChange(
                        "merchantPickupCountry",
                        event.target.value.toUpperCase()
                      )
                    }
                  />
                </div>
              </div>
            )}

          {resolving && (
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Verifying organizer, event, collection, and pickup evidence...
            </div>
          )}

          {!resolving && market && !baseEvidenceError && (
            <div className="rounded-lg border border-success/30 bg-success/10 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
                    <Check className="h-4 w-4 text-success" />
                    {market.title}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
                    {handoffMode === "organizer_handoff"
                      ? `Organizer hands out · ${market.pickupTitle ?? "Organizer pickup"}`
                      : `Merchant hands out · ${merchantPickupTitle || "Merchant booth pickup"}`}
                  </p>
                </div>
                <StatusPill
                  variant={participation === "accepted" ? "success" : "warning"}
                  className="text-[10px]"
                >
                  {participationLabel(participation)}
                </StatusPill>
              </div>
            </div>
          )}

          {!resolving && evidenceError && (
            <p
              className={cn(
                "rounded-lg border px-3 py-2 text-xs leading-5",
                reference
                  ? "border-error/30 bg-error/10 text-error"
                  : "border-[var(--border)] text-[var(--text-muted)]"
              )}
              role={reference ? "alert" : undefined}
            >
              {evidenceError}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
