import { useEffect, useMemo, useState } from "react"
import { AlertCircle, Loader2 } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  buildShippingPublishResultTelemetryProperties,
  getShippingOptions,
  publishShippingOptions,
  recordBrowserTelemetryEvent,
  useAuth,
} from "@conduit/core"
import { Badge, Button, SignedActionStatus } from "@conduit/ui"
import { ShippingDestinationsEditor } from "../components/ShippingDestinationsEditor"
import { requireAuth } from "../lib/auth"
import {
  getStoredShippingConfigRaw,
  loadShippingConfig,
  saveShippingConfig,
  isShippingComplete,
  serializeShippingConfig,
  shippingOptionToConfig,
  selectConduitShippingOption,
  shouldHydrateShippingConfig,
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

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!hasUnsavedChanges || isSaving) return

    setSaveState({ status: "saving" })
    const startedAt = Date.now()
    const eventFamily = config.countries.length === 0 ? "clear" : "publish"

    try {
      await publishShippingOptions(config, "merchant")
      saveShippingConfig(config, pubkey)
      setLastSavedConfig(config)
      setSaveState({ status: "saved" })
      recordBrowserTelemetryEvent({
        app: "merchant",
        eventName: "shipping_publish_result",
        properties: buildShippingPublishResultTelemetryProperties({
          eventFamily,
          latencyMs: Date.now() - startedAt,
          status: "success",
        }),
      })
    } catch (err: unknown) {
      recordBrowserTelemetryEvent({
        app: "merchant",
        eventName: "shipping_publish_result",
        properties: buildShippingPublishResultTelemetryProperties({
          eventFamily,
          latencyMs: Date.now() - startedAt,
          status: "failure",
        }),
      })
      console.warn("[shipping] Failed to publish kind-30406:", err)
      setSaveState({ status: "error", message: getErrorMessage(err) })
    }
  }

  useEffect(() => {
    if (hasUnsavedChanges) return
    const latest = selectConduitShippingOption(remoteShippingQuery.data)
    if (!latest) return

    const remoteConfig = shippingOptionToConfig(latest)
    const storedConfigRaw = getStoredShippingConfigRaw(pubkey)
    if (!shouldHydrateShippingConfig(storedConfigRaw, remoteConfig)) return

    setConfig(remoteConfig)
    saveShippingConfig(remoteConfig, pubkey)
    setLastSavedConfig(remoteConfig)
    setSaveState({ status: "saved" })
  }, [hasUnsavedChanges, pubkey, remoteShippingQuery.data])

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <section className="rounded-[2.25rem] border border-[var(--border)] bg-[color:var(--surface-elevated)] bg-[image:radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary-500)_14%,transparent),transparent_40%)] p-5 shadow-[var(--shadow-dialog)] sm:p-8">
          <div className="space-y-8">
            {/* Header */}
            <div className="space-y-5">
              <div>
                <h1 className="text-balance font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
                  Shipping
                </h1>
                {(hasUnsavedChanges ||
                  saveState.status === "saved" ||
                  remoteShippingQuery.isFetching) && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {hasUnsavedChanges ? (
                      <Badge variant="warning">Unsaved changes</Badge>
                    ) : saveState.status === "saved" ? (
                      <Badge variant="success">Saved</Badge>
                    ) : null}
                    {remoteShippingQuery.isFetching && (
                      <Badge variant="outline">
                        Checking published settings
                      </Badge>
                    )}
                  </div>
                )}
                <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-[var(--text-secondary)]">
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
                    <ShippingDestinationsEditor
                      config={config}
                      onChange={(updated) => {
                        setConfig(updated)
                        setSaveState({ status: "idle" })
                      }}
                    />

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
