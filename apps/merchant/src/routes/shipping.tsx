import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { AlertCircle } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  fetchMerchantShippingSettings,
  publishMerchantShippingSettings,
  getShippingOptionAddress,
  getShippingOptionsByCoordinates,
  useAuth,
  type MerchantShippingReadResult,
  type MerchantShippingSettings,
} from "@conduit/core"
import { Badge, Button, SignedActionStatus } from "@conduit/ui"
import { ListingAreaPicker } from "../components/ListingAreaPicker"
import { ShippingDestinationsEditor } from "../components/ShippingDestinationsEditor"
import { resolveListingArea } from "../lib/listingArea"
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
  | { status: "saved"; message?: string }
  | { status: "error"; message: string }

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return "Failed to save shipping settings."
}

function ShippingPage() {
  const queryClient = useQueryClient()
  const { pubkey, status: authStatus, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const [initialConfig] = useState<ShippingConfig>(() =>
    loadShippingConfig(pubkey)
  )
  const [config, setConfig] = useState<ShippingConfig>(initialConfig)
  const [lastSavedConfig, setLastSavedConfig] =
    useState<ShippingConfig>(initialConfig)
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" })
  const [areaCountry, setAreaCountry] = useState("")
  const [areaState, setAreaState] = useState("")
  const [areaPlaceId, setAreaPlaceId] = useState<number | null>(null)
  const [resolvingArea, setResolvingArea] = useState(false)
  const selectionGeneration = useRef(0)
  const [saving, setSaving] = useState(false)
  const signedSettingsQuery = useQuery({
    queryKey: ["merchant-shipping-settings", pubkey ?? "none"],
    enabled: !!pubkey && authStatus === "connected",
    queryFn: () => fetchMerchantShippingSettings(pubkey!),
    staleTime: 30_000,
  })
  const remoteShippingQuery = useQuery({
    queryKey: ["merchant-shipping-options", pubkey ?? "none", authStatus],
    enabled: !!pubkey,
    queryFn: ({ signal }) =>
      getShippingOptionsByCoordinates([getShippingOptionAddress(pubkey!)], {
        accountPubkey: pubkey,
        authenticatedPubkey: authStatus === "connected" ? pubkey : null,
        signal,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
      }),
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
  const needsRelaySync =
    signedSettingsQuery.data?.state === "not_found" &&
    (config.countries.length > 0 || !!config.shipsFrom)
  useEffect(() => {
    const storedConfig = loadShippingConfig(pubkey)
    setConfig(storedConfig)
    setLastSavedConfig(storedConfig)
    setSaveState({ status: "idle" })
  }, [pubkey])

  useEffect(() => {
    const remote = signedSettingsQuery.data
    if (!pubkey || remote?.state !== "found" || hasUnsavedChanges) return
    const next: ShippingConfig = remote.settings
    if (serializeShippingConfig(config) === serializeShippingConfig(next))
      return
    setConfig(next)
    setLastSavedConfig(next)
    try {
      saveShippingConfig(next, pubkey)
    } catch {
      setSaveState({
        status: "error",
        message:
          "Signed shipping settings loaded, but this device could not cache them.",
      })
    }
  }, [pubkey, signedSettingsQuery.data, hasUnsavedChanges, config])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (
      (!hasUnsavedChanges && !needsRelaySync) ||
      !pubkey ||
      authStatus !== "connected" ||
      saving ||
      resolvingArea
    )
      return

    setSaving(true)
    try {
      const settings: MerchantShippingSettings = {
        countries: config.countries,
        shipsFrom: config.shipsFrom ?? null,
      }
      const revision = await publishMerchantShippingSettings({
        pubkey,
        settings,
        acceptedRevision:
          signedSettingsQuery.data?.state === "found"
            ? signedSettingsQuery.data.revision
            : null,
        dependencies: {
          shouldContinue: () => authGenerationRef.current === authGeneration,
        },
      })
      const savedRead: MerchantShippingReadResult = {
        state: "found",
        settings,
        revision,
        coverageComplete: true,
      }
      queryClient.setQueryData(
        ["merchant-shipping-settings", pubkey],
        savedRead
      )
      let localCacheSaved = true
      try {
        saveShippingConfig(config, pubkey)
      } catch {
        localCacheSaved = false
      }
      setLastSavedConfig(config)
      setSaveState({
        status: "saved",
        message: localCacheSaved
          ? undefined
          : "Published to relays, but this device could not cache the settings.",
      })
    } catch (err: unknown) {
      setSaveState({ status: "error", message: getErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (
      hasUnsavedChanges ||
      signedSettingsQuery.isLoading ||
      signedSettingsQuery.data?.state === "found"
    )
      return
    const latest = selectConduitShippingOption(remoteShippingQuery.data)
    if (!latest) return

    const remoteConfig = shippingOptionToConfig(latest)
    const storedConfigRaw = getStoredShippingConfigRaw(pubkey)
    if (!shouldHydrateShippingConfig(storedConfigRaw, remoteConfig)) return

    setConfig(remoteConfig)
    saveShippingConfig(remoteConfig, pubkey)
    setLastSavedConfig(remoteConfig)
    setSaveState({ status: "idle" })
  }, [
    hasUnsavedChanges,
    pubkey,
    remoteShippingQuery.data,
    signedSettingsQuery.isLoading,
    signedSettingsQuery.data,
  ])

  async function selectAreaPlace(id: number | null) {
    const generation = ++selectionGeneration.current
    setAreaPlaceId(id)
    if (id === null) {
      setResolvingArea(false)
      setConfig((current) => ({ ...current, shipsFrom: null }))
      return
    }
    setResolvingArea(true)
    try {
      const shipsFrom = await resolveListingArea(areaCountry, areaState, id)
      if (generation !== selectionGeneration.current) return
      setConfig((current) => ({ ...current, shipsFrom }))
      setSaveState({ status: "idle" })
    } catch (error) {
      if (generation !== selectionGeneration.current) return
      setAreaPlaceId(null)
      setSaveState({ status: "error", message: getErrorMessage(error) })
    } finally {
      if (generation === selectionGeneration.current) setResolvingArea(false)
    }
  }

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
                  needsRelaySync ||
                  saveState.status === "saved" ||
                  signedSettingsQuery.isFetching ||
                  signedSettingsQuery.isError ||
                  signedSettingsQuery.data?.state === "unavailable" ||
                  remoteShippingQuery.isFetching) && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {hasUnsavedChanges || needsRelaySync ? (
                      <Badge variant="warning">Unsaved changes</Badge>
                    ) : saveState.status === "saved" ? (
                      <Badge variant="success">Saved</Badge>
                    ) : null}
                    {remoteShippingQuery.isFetching && (
                      <Badge variant="outline">
                        Checking legacy published settings
                      </Badge>
                    )}
                    {signedSettingsQuery.isFetching && (
                      <Badge variant="outline">Checking signed settings</Badge>
                    )}
                    {(signedSettingsQuery.isError ||
                      signedSettingsQuery.data?.state === "unavailable") && (
                      <Badge variant="warning">
                        Signed settings unavailable
                      </Badge>
                    )}
                  </div>
                )}
                <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-[var(--text-secondary)]">
                  Save your ships from area and destination presets to relays.
                  New products use these defaults; each fixed product still
                  publishes its own priced shipping option.
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
              <section className="space-y-3">
                <ListingAreaPicker
                  label="Ships from (optional)"
                  helpText="Choose a nearby town as a coarse public area. This is not your exact position or a pickup promise. Future products use it by default."
                  publicAreaPrefix="Public ships from area"
                  countryCode={areaCountry}
                  stateCode={areaState}
                  placeId={areaPlaceId}
                  preservedLocation={config.shipsFrom?.location}
                  onCountryChange={(code) => {
                    ++selectionGeneration.current
                    setResolvingArea(false)
                    setAreaCountry(code)
                    setAreaState("")
                    setAreaPlaceId(null)
                    setConfig((current) => ({ ...current, shipsFrom: null }))
                  }}
                  onStateChange={(code) => {
                    ++selectionGeneration.current
                    setResolvingArea(false)
                    setAreaState(code)
                    setAreaPlaceId(null)
                    setConfig((current) => ({ ...current, shipsFrom: null }))
                  }}
                  onPlaceChange={(id) => void selectAreaPlace(id)}
                  onClear={() => {
                    ++selectionGeneration.current
                    setResolvingArea(false)
                    setAreaPlaceId(null)
                    setConfig((current) => ({ ...current, shipsFrom: null }))
                  }}
                />
                <p className="text-xs text-[var(--text-muted)]">
                  These settings are signed and stored on relays. The area and
                  destination rules may be publicly readable. Do not enter an
                  address or exact location.
                </p>
              </section>
              <section className="space-y-4">
                <div>
                  <div className="text-[1rem] font-semibold tracking-[0.03em] text-[var(--primary-500)]">
                    DESTINATIONS
                  </div>
                  <div className="mt-1 text-[1rem] text-[var(--text-secondary)]">
                    Countries you ship to. Postal restrictions require
                    order-first coordination.
                  </div>
                </div>

                <div className="rounded-[2rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)] px-6 py-5 shadow-[var(--shadow-glass-inset)]">
                  <div className="space-y-4">
                    <ShippingDestinationsEditor
                      config={config}
                      onChange={(updated) => {
                        setConfig((current) => ({
                          ...current,
                          countries: updated.countries,
                        }))
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
                  disabled={
                    !pubkey ||
                    authStatus !== "connected" ||
                    (!hasUnsavedChanges && !needsRelaySync) ||
                    saving ||
                    resolvingArea ||
                    signedSettingsQuery.isLoading
                  }
                >
                  Save changes
                </Button>
                <SignedActionStatus
                  state={
                    saveState.status === "error"
                      ? "error"
                      : hasUnsavedChanges || needsRelaySync
                        ? "dirty"
                        : saveState.status === "saved"
                          ? "success"
                          : "idle"
                  }
                  dirtyMessage="Save changes to publish your shipping defaults."
                  successMessage={
                    saveState.status === "saved" && saveState.message
                      ? saveState.message
                      : "Shipping settings published to relays."
                  }
                  errorMessage={
                    saveState.status === "error" ? saveState.message : undefined
                  }
                />
                {(signedSettingsQuery.isError ||
                  signedSettingsQuery.data?.state === "unavailable") && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void signedSettingsQuery.refetch()}
                  >
                    Retry relay read
                  </Button>
                )}
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  )
}
