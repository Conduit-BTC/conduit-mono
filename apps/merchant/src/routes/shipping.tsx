import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, Loader2, Trash2, X } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  SHIPPING_COUNTRIES,
  getShippingOptions,
  publishShippingOptions,
  useAuth,
  type CountryOption,
} from "@conduit/core"
import { Badge, Button, Combobox, Label, SignedActionStatus } from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import {
  loadShippingConfig,
  saveShippingConfig,
  isShippingComplete,
  serializeShippingConfig,
  shippingOptionToConfig,
  selectConduitShippingOption,
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

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string }

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return "Failed to save shipping settings."
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
      contentClassName="max-h-64 overflow-hidden rounded-xl border-[var(--border-overlay)] bg-[var(--surface-overlay)]"
    />
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ShippingPage() {
  const { pubkey } = useAuth()
  const [initialConfig] = useState<ShippingConfig>(() =>
    loadShippingConfig(pubkey)
  )
  const [config, setConfig] = useState<ShippingConfig>(initialConfig)
  const [lastSavedConfig, setLastSavedConfig] =
    useState<ShippingConfig>(initialConfig)
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" })
  const remoteShippingQuery = useQuery({
    queryKey: ["merchant-shipping-options", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => getShippingOptions(pubkey!),
    staleTime: 60_000,
  })

  const complete = isShippingComplete(config)
  const summary = buildSummary(config.countries)
  const hasUnsavedChanges = useMemo(
    () =>
      serializeShippingConfig(config) !==
      serializeShippingConfig(lastSavedConfig),
    [config, lastSavedConfig]
  )
  const isSaving = saveState.status === "saving"

  useEffect(() => {
    const storedConfig = loadShippingConfig(pubkey)
    setConfig(storedConfig)
    setLastSavedConfig(storedConfig)
    setSaveState({ status: "idle" })
  }, [pubkey])

  const addCountry = useCallback((country: CountryOption) => {
    setConfig((prev) => ({
      countries: [
        ...prev.countries,
        { code: country.code, name: country.name, restrictTo: [], exclude: [] },
      ],
    }))
    setSaveState({ status: "idle" })
  }, [])

  const updateCountry = useCallback(
    (index: number, updated: ShippingCountryConfig) => {
      setConfig((prev) => {
        const countries = [...prev.countries]
        countries[index] = updated
        return { countries }
      })
      setSaveState({ status: "idle" })
    },
    []
  )

  const removeCountry = useCallback((index: number) => {
    setConfig((prev) => ({
      countries: prev.countries.filter((_, i) => i !== index),
    }))
    setSaveState({ status: "idle" })
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!hasUnsavedChanges || isSaving) return

    setSaveState({ status: "saving" })

    try {
      await publishShippingOptions(config, "merchant")
      saveShippingConfig(config, pubkey)
      setLastSavedConfig(config)
      setSaveState({ status: "saved" })
    } catch (err: unknown) {
      console.warn("[shipping] Failed to publish kind-30406:", err)
      setSaveState({ status: "error", message: getErrorMessage(err) })
    }
  }

  useEffect(() => {
    if (config.countries.length > 0) return
    if (hasUnsavedChanges) return
    const latest = selectConduitShippingOption(remoteShippingQuery.data)
    if (!latest) return

    const remoteConfig = shippingOptionToConfig(latest)
    if (remoteConfig.countries.length === 0) return

    setConfig(remoteConfig)
    saveShippingConfig(remoteConfig, pubkey)
    setLastSavedConfig(remoteConfig)
    setSaveState({ status: "saved" })
  }, [
    config.countries.length,
    hasUnsavedChanges,
    pubkey,
    remoteShippingQuery.data,
  ])

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <section className="rounded-[2.25rem] border border-[var(--border)] bg-[color:var(--surface-elevated)] bg-[image:radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary-500)_14%,transparent),transparent_40%)] p-5 shadow-[var(--shadow-dialog)] sm:p-8">
          <div className="space-y-8">
            {/* Header */}
            <div className="space-y-5">
              <div>
                <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
                  Setup
                </div>
                <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
                  Shipping
                </h1>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {hasUnsavedChanges ? (
                    <Badge variant="warning">Unsaved changes</Badge>
                  ) : saveState.status === "saved" ? (
                    <Badge variant="success">Saved</Badge>
                  ) : (
                    <Badge variant="secondary">No changes to save</Badge>
                  )}
                  {remoteShippingQuery.isFetching && (
                    <Badge variant="outline">Checking published settings</Badge>
                  )}
                </div>
                <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--text-secondary)]">
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

                <div className="rounded-[2rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)] px-6 py-5 shadow-[var(--shadow-glass-inset)]">
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

              <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <Button
                  type="submit"
                  disabled={!pubkey || !hasUnsavedChanges || isSaving}
                >
                  {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {isSaving ? "Waiting for signer..." : "Save changes"}
                </Button>
                <SignedActionStatus
                  state={
                    isSaving
                      ? "awaiting_signature"
                      : saveState.status === "error"
                        ? "error"
                        : hasUnsavedChanges
                          ? "dirty"
                          : saveState.status === "saved"
                            ? "success"
                            : "idle"
                  }
                  dirtyMessage="Save changes to publish your shipping settings."
                  awaitingSignatureMessage="Confirm the shipping update in your signer. It will show as saved after signing and relay publish finish."
                  successMessage="Signed and saved."
                  errorMessage={
                    saveState.status === "error" ? saveState.message : undefined
                  }
                />
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  )
}
