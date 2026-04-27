import { getData } from "country-list"
import { useCallback, useEffect, useState } from "react"
import { AlertCircle, Plus, Trash2, X } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import { Button, Input, Label, Badge } from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import {
  loadShippingConfig,
  saveShippingConfig,
  isShippingComplete,
  type ShippingConfig,
  type ShippingCountryConfig,
} from "../lib/readiness"

export const Route = createFileRoute("/shipping")({
  beforeLoad: () => {
    requireAuth()
  },
  component: ShippingPage,
})

// ---------------------------------------------------------------------------
// Country data -- ISO 3166-1 via country-list, with common-name overrides
// ---------------------------------------------------------------------------

const COUNTRY_NAME_OVERRIDES: Record<string, string> = {
  AE: "United Arab Emirates",
  BO: "Bolivia",
  BS: "Bahamas",
  CD: "DR Congo",
  CG: "Congo",
  DO: "Dominican Republic",
  FK: "Falkland Islands",
  FM: "Micronesia",
  FO: "Faroe Islands",
  GB: "United Kingdom",
  GM: "Gambia",
  IR: "Iran",
  KP: "North Korea",
  KR: "South Korea",
  LA: "Laos",
  MD: "Moldova",
  NL: "Netherlands",
  NE: "Niger",
  PH: "Philippines",
  RU: "Russia",
  SD: "Sudan",
  SY: "Syria",
  TW: "Taiwan",
  US: "United States",
  VA: "Vatican City",
  VE: "Venezuela",
}

const COUNTRIES: { code: string; name: string }[] = getData()
  .map((c) => ({
    code: c.code,
    name: COUNTRY_NAME_OVERRIDES[c.code] ?? c.name,
  }))
  .sort((a, b) => a.name.localeCompare(b.name))

// ---------------------------------------------------------------------------
// Summary helper
// ---------------------------------------------------------------------------

function buildSummary(countries: ShippingCountryConfig[]): string {
  if (countries.length === 0) return "Not shipping to any destination yet."

  return countries
    .map((c) => {
      const parts: string[] = [c.name]
      if (c.restrictTo.length > 0) {
        parts.push(`in ${c.restrictTo.join(", ")}`)
      }
      if (c.exclude.length > 0) {
        parts.push(`excluding ${c.exclude.join(", ")}`)
      }
      return parts.join(" ")
    })
    .join(" . ")
}

// ---------------------------------------------------------------------------
// PostalTagInput
// ---------------------------------------------------------------------------

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
      <Label className="text-xs text-[var(--text-secondary)]">{label}</Label>
      <div className="flex min-h-9 flex-wrap gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5">
        {tags.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="flex items-center gap-1 py-0.5 text-xs font-mono"
          >
            {tag}
            <button
              type="button"
              className="ml-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              aria-label={`Remove ${tag}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
        <input
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

// ---------------------------------------------------------------------------
// CountryRow
// ---------------------------------------------------------------------------

function CountryRow({
  entry,
  onUpdate,
  onRemove,
}: {
  entry: ShippingCountryConfig
  onUpdate: (updated: ShippingCountryConfig) => void
  onRemove: () => void
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm text-[var(--text-primary)]">
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
          <Trash2 className="h-3.5 w-3.5" />
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

// ---------------------------------------------------------------------------
// Country selector
// ---------------------------------------------------------------------------

function CountrySelector({
  selected,
  onAdd,
}: {
  selected: string[]
  onAdd: (country: { code: string; name: string }) => void
}) {
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)

  const filtered = COUNTRIES.filter(
    (c) =>
      !selected.includes(c.code) &&
      c.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="relative">
      <div className="flex gap-2">
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search countries to add..."
          className="h-9 text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setOpen((o) => !o)}
          aria-label="Toggle country list"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-[var(--border-overlay)] bg-[var(--surface-overlay)] shadow-[var(--shadow-dialog)] backdrop-blur-xl">
          {filtered.map((c) => (
            <button
              key={c.code}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors text-left"
              onClick={() => {
                onAdd(c)
                setSearch("")
                setOpen(false)
              }}
            >
              <span className="text-xs font-mono text-[var(--text-muted)]">
                {c.code}
              </span>
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ShippingPage() {
  const [config, setConfig] = useState<ShippingConfig>(() =>
    loadShippingConfig()
  )
  const [saved, setSaved] = useState(false)

  const complete = isShippingComplete(config)
  const summary = buildSummary(config.countries)

  const addCountry = useCallback((country: { code: string; name: string }) => {
    setConfig((prev) => ({
      countries: [
        ...prev.countries,
        { code: country.code, name: country.name, restrictTo: [], exclude: [] },
      ],
    }))
    setSaved(false)
  }, [])

  const updateCountry = useCallback(
    (index: number, updated: ShippingCountryConfig) => {
      setConfig((prev) => {
        const countries = [...prev.countries]
        countries[index] = updated
        return { countries }
      })
      setSaved(false)
    },
    []
  )

  const removeCountry = useCallback((index: number) => {
    setConfig((prev) => ({
      countries: prev.countries.filter((_, i) => i !== index),
    }))
    setSaved(false)
  }, [])

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    saveShippingConfig(config)
    setSaved(true)
  }

  // Persist on unmount to avoid data loss
  useEffect(() => {
    return () => {
      saveShippingConfig(config)
    }
  }, [config])

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <section className="rounded-[2.25rem] border border-[var(--border)] bg-[var(--surface)] px-5 py-6 shadow-[var(--shadow-dialog)] sm:px-8 sm:py-8">
          <div className="space-y-8">
            {/* Header */}
            <div className="space-y-5">
              <div>
                <h1 className="text-[1.9rem] font-semibold tracking-tight text-[var(--text-primary)] sm:text-[2.25rem]">
                  Shipping
                </h1>
                <p className="mt-2 max-w-[44rem] text-[1rem] leading-8 text-[var(--text-secondary)] sm:text-[1.05rem]">
                  Define where you ship. Buyers outside your configured
                  destinations will not see your products as available.
                </p>
              </div>

              {!complete && (
                <div className="flex items-start gap-3 rounded-2xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-4 py-3.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
                  <p className="text-sm text-[var(--warning)]">
                    <span className="font-semibold">
                      No shipping destinations set.
                    </span>{" "}
                    Add at least one country to indicate where you can ship
                    orders.
                  </p>
                </div>
              )}
            </div>

            {/* Form */}
            <form onSubmit={handleSave} className="space-y-8">
              <section className="space-y-4">
                <div>
                  <div className="text-[1rem] font-semibold tracking-[0.03em] text-[var(--primary-500)]">
                    DESTINATIONS
                  </div>
                  <div className="mt-1 text-[1rem] text-[var(--text-secondary)]">
                    Countries you ship to, with optional postal restrictions
                  </div>
                </div>

                <div className="rounded-[2rem] bg-[color-mix(in_srgb,var(--surface)_98%,var(--primary-500)_2%)] px-6 py-5 shadow-[var(--shadow-glass-inset)]">
                  <div className="space-y-4">
                    <CountrySelector
                      selected={config.countries.map((c) => c.code)}
                      onAdd={addCountry}
                    />

                    {config.countries.length === 0 ? (
                      <p className="text-sm text-[var(--text-muted)] py-2">
                        No destinations added yet.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {config.countries.map((entry, i) => (
                          <CountryRow
                            key={entry.code}
                            entry={entry}
                            onUpdate={(updated) => updateCountry(i, updated)}
                            onRemove={() => removeCountry(i)}
                          />
                        ))}
                      </div>
                    )}

                    {/* Plain-language summary */}
                    {config.countries.length > 0 && (
                      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
                        <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">
                          Summary
                        </p>
                        <p className="text-sm text-[var(--text-primary)]">
                          {summary}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <div className="flex items-center gap-3">
                <Button type="submit">Save shipping settings</Button>
                {saved && (
                  <span className="text-sm text-[var(--success)]">Saved</span>
                )}
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  )
}
