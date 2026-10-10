import { Plus, Trash2 } from "lucide-react"
import { SHIPPING_COUNTRIES } from "@conduit/core"
import {
  Button,
  Checkbox,
  Combobox,
  Input,
  InputWithSuffix,
  Label,
} from "@conduit/ui"
import {
  createShippingRuleDraft,
  type ShippingTableDraft,
} from "../lib/shippingPolicyForm"
import { US_LISTING_AREA_STATES } from "../lib/usListingAreaStates"
import type { ShippingWeightUnit } from "../lib/shippingWeightUnits"
import { ShippingWeightInput } from "./ShippingWeightInput"

const countries = SHIPPING_COUNTRIES.map(({ code, name }) => ({
  value: code,
  label: name,
}))
const states = [
  { value: "all", label: "Any state" },
  ...US_LISTING_AREA_STATES.map(({ code, name }) => ({
    value: code,
    label: name,
  })),
]

export function ShippingTableEditor({
  kind,
  originCountry,
  currency,
  weightUnit,
  table,
  onChange,
}: {
  kind: "domestic" | "international"
  originCountry: string
  currency: string
  weightUnit: ShippingWeightUnit
  table: ShippingTableDraft
  onChange: (value: ShippingTableDraft) => void
}) {
  const title = kind === "domestic" ? "Domestic" : "International"
  const suffix = currency === "SATS" ? "sats" : currency
  function updateRule(
    index: number,
    update: Partial<ShippingTableDraft["rules"][number]>
  ) {
    onChange({
      ...table,
      rules: table.rules.map((rule, i) =>
        i === index ? { ...rule, ...update } : rule
      ),
    })
  }
  function customize(index: number) {
    const base = table.rules[index]!
    const rule = {
      ...createShippingRuleDraft(
        kind === "domestic" ? originCountry : base.country
      ),
      customArea: true,
      bands: base.bands.map((band) => ({ ...band, id: crypto.randomUUID() })),
    }
    onChange({
      ...table,
      rules: [
        ...table.rules.slice(0, index + 1),
        rule,
        ...table.rules.slice(index + 1),
      ],
    })
  }
  return (
    <section
      aria-label={`${title} rates`}
      className="min-w-0 space-y-4 border-t border-[var(--border)] pt-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-balance text-lg font-semibold">{title}</h3>
        <label className="flex min-h-11 min-w-11 items-center justify-center">
          <Checkbox
            aria-label={`Enable ${title.toLowerCase()}`}
            checked={table.enabled}
            onCheckedChange={(checked) =>
              onChange({
                ...table,
                enabled: checked === true,
                rules:
                  checked === true && !table.rules.length
                    ? [
                        createShippingRuleDraft(
                          kind === "domestic" ? originCountry : ""
                        ),
                      ]
                    : table.rules,
              })
            }
          />
        </label>
      </div>
      {table.enabled && (
        <>
          {table.rules.map((rule, index) => {
            const custom =
              !!rule.customArea || !!rule.subdivision || !!rule.postalPrefix
            const country = kind === "domestic" ? originCountry : rule.country
            const countryName = countries.find(
              (entry) => entry.value === country
            )?.label
            return (
              <div
                key={rule.id}
                className="space-y-3 border-t border-[var(--border)] pt-4 first:border-0 first:pt-0"
                role="group"
                aria-label={`${countryName ?? "Destination"}${custom ? " custom area" : " rates"}`}
              >
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    {custom ? (
                      <p className="text-balance text-sm font-medium">
                        {countryName} · Custom area
                      </p>
                    ) : kind === "domestic" ? (
                      <p className="text-sm font-medium">
                        {countryName ?? "Choose origin country"}
                      </p>
                    ) : (
                      <div className="space-y-1">
                        <Label htmlFor={`${rule.id}-country`}>Country</Label>
                        <Combobox
                          id={`${rule.id}-country`}
                          value={country}
                          options={countries.filter(
                            (entry) => entry.value !== originCountry
                          )}
                          placeholder="Choose country"
                          searchPlaceholder="Search countries"
                          onValueChange={(value) =>
                            updateRule(index, { country: value })
                          }
                        />
                      </div>
                    )}
                  </div>
                  {(custom || kind === "international") && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="w-8 shrink-0"
                      aria-label={`Remove ${title.toLowerCase()} destination ${index + 1}`}
                      onClick={() =>
                        onChange({
                          ...table,
                          rules: table.rules.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
                {custom && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor={`${rule.id}-subdivision`}>
                        {country === "US" ? "State" : "State / region"}
                      </Label>
                      {country === "US" ? (
                        <Combobox
                          id={`${rule.id}-subdivision`}
                          options={states}
                          value={rule.subdivision.replace(/^US-?/, "") || "all"}
                          placeholder="Any state"
                          searchPlaceholder="Search states"
                          onValueChange={(value) =>
                            updateRule(index, {
                              subdivision: value === "all" ? "" : `US-${value}`,
                            })
                          }
                        />
                      ) : (
                        <Input
                          id={`${rule.id}-subdivision`}
                          value={rule.subdivision}
                          placeholder="Optional code"
                          onChange={(event) =>
                            updateRule(index, {
                              subdivision: event.target.value,
                            })
                          }
                        />
                      )}
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`${rule.id}-postal`}>Postal prefix</Label>
                      <Input
                        id={`${rule.id}-postal`}
                        value={rule.postalPrefix}
                        placeholder="Optional"
                        autoCapitalize="characters"
                        onChange={(event) =>
                          updateRule(index, {
                            postalPrefix: event.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  {rule.bands.map((band, bandIndex) => (
                    <div
                      key={band.id}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2"
                      role="group"
                      aria-label={`Weight band ${bandIndex + 1}`}
                    >
                      <div className="min-w-0 space-y-1.5">
                        {bandIndex === 0 && (
                          <Label htmlFor={`${band.id}-weight`}>
                            Up to weight
                          </Label>
                        )}
                        <ShippingWeightInput
                          id={`${band.id}-weight`}
                          aria-label="Up to weight"
                          unit={weightUnit}
                          value={band.maxWeight}
                          placeholder="0"
                          onValueChange={(maxWeight) =>
                            updateRule(index, {
                              bands: rule.bands.map((entry, i) =>
                                i === bandIndex
                                  ? { ...entry, maxWeight }
                                  : entry
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="min-w-0 space-y-1.5">
                        {bandIndex === 0 && (
                          <Label htmlFor={`${band.id}-price`}>
                            Shipping price
                          </Label>
                        )}
                        <InputWithSuffix
                          id={`${band.id}-price`}
                          aria-label="Shipping price"
                          suffix={suffix}
                          inputMode="decimal"
                          value={band.price}
                          placeholder="0"
                          onChange={(event) =>
                            updateRule(index, {
                              bands: rule.bands.map((entry, i) =>
                                i === bandIndex
                                  ? { ...entry, price: event.target.value }
                                  : entry
                              ),
                            })
                          }
                        />
                      </div>
                      {rule.bands.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="w-8 shrink-0"
                          aria-label={`Remove ${title.toLowerCase()} destination ${index + 1} band ${bandIndex + 1}`}
                          onClick={() =>
                            updateRule(index, {
                              bands: rule.bands.filter(
                                (_, i) => i !== bandIndex
                              ),
                            })
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      updateRule(index, {
                        bands: [
                          ...rule.bands,
                          { id: crypto.randomUUID(), maxWeight: "", price: "" },
                        ],
                      })
                    }
                  >
                    <Plus className="size-4" />
                    Add weight band
                  </Button>
                  {!custom && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!country}
                      onClick={() => customize(index)}
                    >
                      Customize by state or postal area
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
          {kind === "international" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onChange({
                  ...table,
                  rules: [...table.rules, createShippingRuleDraft()],
                })
              }
            >
              <Plus className="size-4" />
              Add country
            </Button>
          )}
          <div className="space-y-1 border-t border-[var(--border)] pt-4">
            <Label htmlFor={`${kind}-free-threshold`}>Free shipping from</Label>
            <InputWithSuffix
              id={`${kind}-free-threshold`}
              suffix={suffix}
              value={table.freeShippingThreshold}
              inputMode="decimal"
              placeholder="Optional"
              onChange={(event) =>
                onChange({
                  ...table,
                  freeShippingThreshold: event.target.value,
                })
              }
            />
          </div>
        </>
      )}
    </section>
  )
}
