import { useCallback, useId, useMemo, useState } from "react"
import { Trash2, X } from "lucide-react"
import {
  getAddressSubdivisionOptions,
  SHIPPING_COUNTRIES,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  supportsAddressPostalPolicy,
  type CountryOption,
} from "@conduit/core"
import {
  Badge,
  Button,
  Combobox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@conduit/ui"
import type { ShippingConfig, ShippingCountryConfig } from "../lib/readiness"
import { isPlainDecimalInput } from "../lib/productPriceForm"

function TokenInput({
  label,
  tags,
  onChange,
  placeholder,
}: {
  label: string
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
}) {
  const inputId = useId()
  const [draft, setDraft] = useState("")

  function commit() {
    const trimmed = draft.trim().toUpperCase()
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed])
    }
    setDraft("")
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      commit()
    }
    if (event.key === "Backspace" && !draft && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={inputId} className="text-xs text-[var(--text-secondary)]">
        {label}
      </Label>
      <div className="flex min-h-9 flex-wrap gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-[var(--ring)]">
        {tags.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="flex items-center gap-1 py-0.5 font-mono text-xs"
          >
            {tag}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-0.5 size-5 p-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              onClick={() => onChange(tags.filter((item) => item !== tag))}
              aria-label={`Remove ${tag}`}
            >
              <X className="size-2.5" aria-hidden="true" />
            </Button>
          </Badge>
        ))}
        <Input
          id={inputId}
          className="h-7 min-w-24 flex-1 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commit}
          placeholder={tags.length === 0 ? placeholder : ""}
        />
      </div>
      <p className="text-pretty text-xs text-[var(--text-muted)]">
        Press Enter or comma to add. Use one trailing * for a prefix.
      </p>
    </div>
  )
}

function SubdivisionSelector({
  country,
  label,
  selected,
  onChange,
}: {
  country: string
  label: string
  selected: string[]
  onChange: (values: string[]) => void
}) {
  const inputId = useId()
  const selectedSet = new Set(selected)
  const options = getAddressSubdivisionOptions(country).flatMap((option) =>
    selectedSet.has(option.code)
      ? []
      : [
          {
            value: option.code,
            label: option.name,
            meta: option.code,
            searchText: `${option.code} ${option.name}`,
          },
        ]
  )

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={inputId} className="text-xs text-[var(--text-secondary)]">
        {label}
      </Label>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((code) => (
            <Badge
              key={code}
              variant="secondary"
              className="flex items-center gap-1 py-0.5 text-xs"
            >
              {code}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-5 p-0"
                onClick={() =>
                  onChange(selected.filter((value) => value !== code))
                }
                aria-label={`Remove ${code}`}
              >
                <X className="size-2.5" aria-hidden="true" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      <Combobox
        id={inputId}
        options={options}
        onValueChange={(code) => onChange([...selected, code])}
        placeholder="Add a state or region..."
        searchPlaceholder="Search states or regions..."
        emptyText="No more subdivisions available."
        triggerClassName="h-9 text-sm"
        searchInTrigger
      />
    </div>
  )
}

function CountryRow({
  entry,
  onUpdate,
  onRemove,
  compact = false,
  showRates,
  defaultCurrency,
  enableDestinationPolicies,
}: {
  entry: ShippingCountryConfig
  onUpdate: (updated: ShippingCountryConfig) => void
  onRemove: () => void
  compact?: boolean
  showRates: boolean
  defaultCurrency: string
  enableDestinationPolicies: boolean
}) {
  const rateId = useId()
  const currencyId = useId()
  const subdivisionOptions = getAddressSubdivisionOptions(entry.code)

  return (
    <div
      className={cn(
        "space-y-3 border border-[var(--border)] bg-[var(--surface-elevated)]",
        compact ? "rounded-xl p-3" : "rounded-2xl p-4"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-[var(--text-primary)]">
          {entry.name}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-7 shrink-0 p-0 text-[var(--text-muted)] hover:text-error"
          onClick={onRemove}
          aria-label={`Remove ${entry.name}`}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </div>

      {showRates && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label
                htmlFor={rateId}
                className="text-xs text-[var(--text-secondary)]"
              >
                Flat checkout rate
              </Label>
              <Input
                id={rateId}
                type="text"
                inputMode="decimal"
                className="tabular-nums"
                value={entry.rate?.amount ?? ""}
                placeholder="Use product fallback"
                onChange={(event) => {
                  const amount = event.target.value
                  if (!isPlainDecimalInput(amount)) return
                  onUpdate({
                    ...entry,
                    rate: amount
                      ? {
                          amount,
                          currency: entry.rate?.currency ?? defaultCurrency,
                        }
                      : undefined,
                  })
                }}
                aria-describedby={`${rateId}-help`}
              />
            </div>
            <div className="grid gap-1.5">
              <Label
                htmlFor={currencyId}
                className="text-xs text-[var(--text-secondary)]"
              >
                Currency
              </Label>
              <Select
                disabled={!entry.rate}
                value={entry.rate?.currency ?? defaultCurrency}
                onValueChange={(currency) =>
                  onUpdate({
                    ...entry,
                    rate: {
                      amount: entry.rate?.amount ?? "0",
                      currency,
                    },
                  })
                }
              >
                <SelectTrigger
                  id={currencyId}
                  aria-label={`${entry.name} rate currency`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_PRODUCT_PRICE_CURRENCIES.map((currency) => (
                    <SelectItem key={currency} value={currency}>
                      {currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p
            id={`${rateId}-help`}
            className="text-pretty text-xs text-[var(--text-muted)]"
          >
            Leave blank to use the product-level fallback amount.
          </p>
        </>
      )}

      {enableDestinationPolicies && subdivisionOptions.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <SubdivisionSelector
            country={entry.code}
            label="Only these states or regions"
            selected={entry.includeSubdivisions ?? []}
            onChange={(includeSubdivisions) =>
              onUpdate({ ...entry, includeSubdivisions })
            }
          />
          <SubdivisionSelector
            country={entry.code}
            label="Exclude states or regions"
            selected={entry.excludeSubdivisions ?? []}
            onChange={(excludeSubdivisions) =>
              onUpdate({ ...entry, excludeSubdivisions })
            }
          />
        </div>
      )}

      {enableDestinationPolicies && supportsAddressPostalPolicy(entry.code) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TokenInput
            label="Only these postal codes or prefixes"
            tags={entry.restrictTo}
            onChange={(restrictTo) => onUpdate({ ...entry, restrictTo })}
            placeholder="021*, SW1*, 10115"
          />
          <TokenInput
            label="Exclude postal codes or prefixes"
            tags={entry.exclude}
            onChange={(exclude) => onUpdate({ ...entry, exclude })}
            placeholder="02139, SW1A*"
          />
        </div>
      )}
    </div>
  )
}

function CountrySelector({
  selected,
  onAdd,
  allowRepeated,
}: {
  selected: string[]
  onAdd: (country: CountryOption) => void
  allowRepeated: boolean
}) {
  const options = useMemo(() => {
    const selectedSet = new Set(selected)
    return SHIPPING_COUNTRIES.flatMap((country) =>
      !allowRepeated && selectedSet.has(country.code)
        ? []
        : [
            {
              value: country.code,
              label: country.name,
              meta: country.code,
              searchText: `${country.code} ${country.name}`,
            },
          ]
    )
  }, [allowRepeated, selected])

  return (
    <Combobox
      options={options}
      onValueChange={(countryCode) => {
        const country = SHIPPING_COUNTRIES.find(
          (item) => item.code === countryCode
        )
        if (country) onAdd(country)
      }}
      placeholder="Search countries to add..."
      searchPlaceholder="Search countries to add..."
      emptyText="No countries available."
      triggerClassName="h-9 max-w-xs text-sm"
      contentClassName="overflow-hidden rounded-xl border-[var(--border-overlay)] bg-[var(--surface-overlay)] p-1"
      listClassName="max-h-[min(14rem,var(--radix-popover-content-available-height))] overscroll-contain pr-1 [scrollbar-gutter:stable] sm:max-h-[min(18rem,var(--radix-popover-content-available-height))]"
      searchInTrigger
    />
  )
}

function getCountryPolicyKey(entry: ShippingCountryConfig): string {
  return JSON.stringify([
    entry.code,
    entry.includeCountry === true,
    entry.includeSubdivisions ?? [],
    entry.excludeSubdivisions ?? [],
    entry.restrictTo,
    entry.exclude,
    entry.excludeCountry === true,
  ])
}

export function ShippingDestinationsEditor({
  config,
  onChange,
  emptyText = "No destinations added yet.",
  compact = false,
  className,
  rowsClassName,
  showRates = false,
  defaultCurrency = "SATS",
  enableDestinationPolicies = false,
}: {
  config: ShippingConfig
  onChange: (config: ShippingConfig) => void
  emptyText?: string
  compact?: boolean
  className?: string
  rowsClassName?: string
  showRates?: boolean
  defaultCurrency?: string
  enableDestinationPolicies?: boolean
}) {
  const policyKeyOccurrences = new Map<string, number>()
  const addCountry = useCallback(
    (country: CountryOption) => {
      onChange({
        countries: [
          ...config.countries,
          {
            code: country.code,
            name: country.name,
            restrictTo: [],
            exclude: [],
            includeSubdivisions: [],
            excludeSubdivisions: [],
          },
        ],
      })
    },
    [config.countries, onChange]
  )

  const updateCountry = useCallback(
    (index: number, updated: ShippingCountryConfig) => {
      const countries = [...config.countries]
      countries[index] = updated
      onChange({ countries })
    },
    [config.countries, onChange]
  )

  const removeCountry = useCallback(
    (index: number) => {
      onChange({
        countries: config.countries.filter(
          (_, itemIndex) => itemIndex !== index
        ),
      })
    },
    [config.countries, onChange]
  )

  return (
    <div className={cn("space-y-4", className)}>
      <CountrySelector
        selected={config.countries.map((country) => country.code)}
        onAdd={addCountry}
        allowRepeated={enableDestinationPolicies}
      />

      {config.countries.length === 0 ? (
        <p className="py-2 text-sm text-[var(--text-muted)]">{emptyText}</p>
      ) : (
        <div className={cn("space-y-3", rowsClassName)}>
          {config.countries.map((entry, index) => {
            const policyKey = getCountryPolicyKey(entry)
            const occurrence = policyKeyOccurrences.get(policyKey) ?? 0
            policyKeyOccurrences.set(policyKey, occurrence + 1)
            return (
              <CountryRow
                key={`${policyKey}:${occurrence}`}
                entry={entry}
                compact={compact}
                showRates={showRates}
                defaultCurrency={defaultCurrency}
                enableDestinationPolicies={enableDestinationPolicies}
                onUpdate={(updated) => updateCountry(index, updated)}
                onRemove={() => removeCountry(index)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
