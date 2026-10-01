import { useState } from "react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  InputWithSuffix,
  Label,
} from "@conduit/ui"
import {
  applyUSShippingStarter,
  buildUSShippingStarter,
  getUSStarterArea,
  US_SHIPPING_STARTER,
  US_STARTER_AREA_NAMES,
} from "../lib/usShippingStarter"
import type { ShippingPolicyDraft } from "../lib/shippingPolicyForm"
import { parsePlainDecimalAmount } from "../lib/productPriceForm"

export default function USShippingStarter({
  open,
  onOpenChange,
  draft,
  onApply,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: ShippingPolicyDraft
  onApply: (draft: ShippingPolicyDraft) => void
}) {
  const [origin, setOrigin] = useState("")
  const [destination, setDestination] = useState("")
  const [prices, setPrices] = useState(() =>
    US_SHIPPING_STARTER.pricesDollars.map((row) => row.map(String))
  )
  let candidate: ShippingPolicyDraft | null = null
  let error = ""
  try {
    candidate = applyUSShippingStarter(
      draft,
      buildUSShippingStarter(
        origin,
        prices.map((row) =>
          row.map((price) => parsePlainDecimalAmount(price, "Starter price"))
        )
      )
    )
  } catch (caught) {
    error =
      caught instanceof Error ? caught.message : "Review the starter prices."
  }
  const area = getUSStarterArea(origin, destination)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>US domestic starter</DialogTitle>
          <DialogDescription>
            Review approximate USPS Ground Advantage prices, rounded upward to
            dollars. Applying replaces your domestic draft; publish after
            reviewing it.
          </DialogDescription>
        </DialogHeader>
        <p className="text-pretty text-sm text-[var(--text-secondary)]">
          Ordinary parcels up to 5 lb, including Alaska and Hawaii. Territories,
          military ZIPs, ZIP 96799 and oversized or special parcels need
          coordination. Broader postal areas use their highest estimated price.
          These are editable estimates, not live postage quotes.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="starter-origin">Origin ZIP</Label>
            <Input
              id="starter-origin"
              inputMode="numeric"
              maxLength={5}
              value={origin}
              onChange={(event) => setOrigin(event.target.value.trim())}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="starter-destination">Preview destination ZIP</Label>
            <Input
              id="starter-destination"
              inputMode="numeric"
              maxLength={5}
              value={destination}
              onChange={(event) => setDestination(event.target.value.trim())}
            />
          </div>
        </div>
        <p className="text-pretty text-sm">
          The exact origin ZIP stays in this setup. Published postal areas
          reflect distance from your origin.
        </p>
        {origin.startsWith("967") && (
          <p className="text-pretty text-sm text-warning">
            For Hawaii origin ZIPs starting 967, this starter conservatively
            uses farther prices outside Hawaii. Review representative
            destinations before publishing.
          </p>
        )}
        {destination && (
          <p role="status" className="text-sm">
            {area === null
              ? "Destination outside starter coverage, or origin incomplete."
              : `Destination uses ${US_STARTER_AREA_NAMES[area]!.toLowerCase()} prices.`}
          </p>
        )}
        <div className="space-y-4">
          {US_STARTER_AREA_NAMES.map((name, group) => (
            <section
              key={name}
              aria-label={`${name} starter prices`}
              className="space-y-2"
            >
              <h3 className="text-sm font-medium">{name}</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {["8 oz", "1 lb", "2 lb", "5 lb"].map((weight, band) => (
                  <div key={weight} className="min-w-0 space-y-1.5">
                    <Label htmlFor={`starter-${group}-${band}`}>
                      {name} up to {weight}
                    </Label>
                    <InputWithSuffix
                      id={`starter-${group}-${band}`}
                      suffix="USD"
                      inputMode="decimal"
                      value={prices[group]![band]!}
                      onChange={(event) =>
                        setPrices((current) =>
                          current.map((row, index) =>
                            index === group
                              ? row.map((price, tier) =>
                                  tier === band ? event.target.value : price
                                )
                              : row
                          )
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        <p className="text-pretty text-sm">
          For small ordinary parcels, start by measuring packing; 50 g per item
          is a starting estimate. Add it to product packing weight and review
          combined baskets. Long or bulky parcels can cost more, and the starter
          does not calculate dimensional weight or extra service fees.
        </p>
        <p className="text-pretty text-xs text-[var(--text-secondary)]">
          Reference reviewed {US_SHIPPING_STARTER.reviewedAt}; ZIP areas
          effective {US_SHIPPING_STARTER.zoneReferenceEffectiveAt}. Retail
          seasonal upper estimates cover October 4, 2026–January 17, 2027.{" "}
          {new Date().toISOString().slice(0, 10) >
            US_SHIPPING_STARTER.reviewAfter &&
            "This reference needs a new price review. "}
          <a
            className="underline"
            href="https://pe.usps.com/PriceChange/Index"
            target="_blank"
            rel="noreferrer"
          >
            USPS price reference
          </a>
          {" · "}
          <a
            className="underline"
            href="https://postcalc.usps.com/DomesticZoneChart"
            target="_blank"
            rel="noreferrer"
          >
            ZIP reference
          </a>
        </p>
        {origin && error && (
          <p role="alert" className="text-pretty text-sm text-error">
            {error}
          </p>
        )}
        <Button
          type="button"
          disabled={!candidate}
          onClick={() => {
            if (candidate) {
              onApply(candidate)
              onOpenChange(false)
            }
          }}
        >
          Apply starter to draft
        </Button>
      </DialogContent>
    </Dialog>
  )
}
