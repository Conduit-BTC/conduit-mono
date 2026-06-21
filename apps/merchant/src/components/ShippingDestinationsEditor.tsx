import { useCallback, useId, useMemo, useState } from "react"
import { Trash2, X } from "lucide-react"
import { SHIPPING_COUNTRIES, type CountryOption } from "@conduit/core"
import { Badge, Button, Combobox, Label, cn } from "@conduit/ui"
import type { ShippingConfig, ShippingCountryConfig } from "../lib/readiness"

function PostalTagInput({
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
    const trimmed = draft.trim()
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed])
    }
    setDraft("")
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      commit()
    }
    if (e.key === "Backspace" && !draft && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={inputId} className="text-xs text-[var(--text-secondary)]">
        {label}
      </Label>
      <div className="flex min-h-9 flex-wrap gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5">
        {tags.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="flex items-center gap-1 py-0.5 font-mono text-xs"
          >
            {tag}
            <button
              type="button"
              className="ml-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              aria-label={`Remove ${tag}`}
            >
              <X className="h-2.5 w-2.5" aria-hidden="true" />
            </button>
          </Badge>
        ))}
        <input
          id={inputId}
          className="min-w-24 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commit}
          placeholder={tags.length === 0 ? placeholder : ""}
        />
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">
        Press Enter or comma to add. Accepts patterns like{" "}
        <span className="font-mono">021**</span>,{" "}
        <span className="font-mono">SW1**</span>,{" "}
        <span className="font-mono">10115</span>.
      </p>
    </div>
  )
}

function CountryRow({
  entry,
  onUpdate,
  onRemove,
  compact = false,
}: {
  entry: ShippingCountryConfig
  onUpdate: (updated: ShippingCountryConfig) => void
  onRemove: () => void
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        "space-y-3 border border-[var(--border)] bg-[var(--surface-elevated)]",
        compact ? "rounded-xl p-3" : "rounded-2xl p-4"
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--text-primary)]">
          {entry.name}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-[var(--text-muted)] hover:text-error"
          onClick={onRemove}
          aria-label={`Remove ${entry.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      <PostalTagInput
        label="Restrict by postal code (optional)"
        tags={entry.restrictTo}
        onChange={(tags) => onUpdate({ ...entry, restrictTo: tags })}
        placeholder="021**, 100**, 10001 -- leave empty to ship anywhere in country"
      />
      <PostalTagInput
        label="Exclude postal codes (optional)"
        tags={entry.exclude}
        onChange={(tags) => onUpdate({ ...entry, exclude: tags })}
        placeholder="02139, SW1A**"
      />
    </div>
  )
}

function CountrySelector({
  selected,
  onAdd,
}: {
  selected: string[]
  onAdd: (country: CountryOption) => void
}) {
  const options = useMemo(
    () =>
      SHIPPING_COUNTRIES.filter(
        (country) => !selected.includes(country.code)
      ).map((country) => ({
        value: country.code,
        label: country.name,
        meta: country.code,
        searchText: `${country.code} ${country.name}`,
      })),
    [selected]
  )

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
      triggerClassName="h-9 text-sm"
      contentClassName="overflow-hidden rounded-xl border-[var(--border-overlay)] bg-[var(--surface-overlay)]"
      listClassName="max-h-[min(18rem,var(--radix-popover-content-available-height))] overscroll-contain"
      searchInTrigger
    />
  )
}

export function ShippingDestinationsEditor({
  config,
  onChange,
  emptyText = "No destinations added yet.",
  compact = false,
  className,
  rowsClassName,
}: {
  config: ShippingConfig
  onChange: (config: ShippingConfig) => void
  emptyText?: string
  compact?: boolean
  className?: string
  rowsClassName?: string
}) {
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
        countries: config.countries.filter((_, i) => i !== index),
      })
    },
    [config.countries, onChange]
  )

  return (
    <div className={cn("space-y-4", className)}>
      <CountrySelector
        selected={config.countries.map((country) => country.code)}
        onAdd={addCountry}
      />

      {config.countries.length === 0 ? (
        <p className="py-2 text-sm text-[var(--text-muted)]">{emptyText}</p>
      ) : (
        <div className={cn("space-y-3", rowsClassName)}>
          {config.countries.map((entry, index) => (
            <CountryRow
              key={entry.code}
              entry={entry}
              compact={compact}
              onUpdate={(updated) => updateCountry(index, updated)}
              onRemove={() => removeCountry(index)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
