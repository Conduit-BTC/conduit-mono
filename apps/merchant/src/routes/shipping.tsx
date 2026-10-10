import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  fetchMerchantShippingSettings,
  publishMerchantShippingSettings,
  getMerchantShippingPolicyCoordinate,
  getShippingOptionAddress,
  getShippingOptionsByCoordinates,
  useAuth,
  type MerchantShippingReadResult,
  type MerchantShippingRevision,
  type MerchantShippingSettings,
} from "@conduit/core"
import { PageLayout, Badge, Button, SignedActionStatus } from "@conduit/ui"
import { MerchantShippingPolicyEditor } from "../components/MerchantShippingPolicyEditor"
import { ListingAreaPicker } from "../components/ListingAreaPicker"
import { ShippingDestinationsEditor } from "../components/ShippingDestinationsEditor"
import { resolveListingArea } from "../lib/listingArea"
import { requireAuth } from "../lib/auth"
import {
  getStoredShippingConfigRaw,
  loadShippingConfig,
  saveShippingConfig,
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
  const [reviewedRevision, setReviewedRevision] =
    useState<MerchantShippingRevision | null>(null)
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
      getShippingOptionsByCoordinates(
        [
          getShippingOptionAddress(pubkey!),
          getMerchantShippingPolicyCoordinate(pubkey!),
        ],
        {
          accountPubkey: pubkey,
          authenticatedPubkey: authStatus === "connected" ? pubkey : null,
          signal,
          shouldContinue: () =>
            !signal.aborted && authGenerationRef.current === authGeneration,
        }
      ),
    staleTime: 30_000,
  })

  const retainedSettings =
    signedSettingsQuery.data?.state === "found" &&
    signedSettingsQuery.data.retained
  const unreviewedSettings =
    signedSettingsQuery.data?.state === "found" &&
    reviewedRevision?.eventId !== signedSettingsQuery.data.revision.eventId
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
    setReviewedRevision(null)
    setSaveState({ status: "idle" })
  }, [pubkey])

  const loadSignedSettings = useCallback(
    (remote: Extract<MerchantShippingReadResult, { state: "found" }>) => {
      if (!pubkey) return
      const next: ShippingConfig = remote.settings
      ++selectionGeneration.current
      setResolvingArea(false)
      setAreaCountry("")
      setAreaState("")
      setAreaPlaceId(null)
      setConfig(next)
      setLastSavedConfig(next)
      setReviewedRevision(remote.revision)
      setSaveState({ status: "idle" })
      try {
        saveShippingConfig(next, pubkey)
      } catch {
        setSaveState({
          status: "error",
          message:
            "Signed shipping settings loaded, but this device could not cache them.",
        })
      }
    },
    [pubkey]
  )

  useEffect(() => {
    const remote = signedSettingsQuery.data
    if (!pubkey || remote?.state !== "found" || hasUnsavedChanges) return
    if (
      serializeShippingConfig(config) ===
      serializeShippingConfig(remote.settings)
    ) {
      if (reviewedRevision?.eventId !== remote.revision.eventId)
        setReviewedRevision(remote.revision)
      return
    }
    loadSignedSettings(remote)
  }, [
    pubkey,
    signedSettingsQuery.data,
    hasUnsavedChanges,
    config,
    reviewedRevision,
    loadSignedSettings,
  ])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (
      (!hasUnsavedChanges && !needsRelaySync) ||
      !pubkey ||
      authStatus !== "connected" ||
      saving ||
      resolvingArea ||
      signedSettingsQuery.isLoading ||
      unreviewedSettings
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
        acceptedRevision: reviewedRevision,
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
      setReviewedRevision(revision)
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
    <PageLayout className="max-w-4xl px-0 py-2 sm:px-0 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <section className="min-w-0">
          <div className="space-y-8">
            {/* Header */}
            <div className="space-y-5">
              <div>
                <h1 className="text-balance font-heading text-3xl font-semibold text-[var(--text-primary)]">
                  Shipping
                </h1>
              </div>
            </div>

            <MerchantShippingPolicyEditor key={pubkey ?? "none"} />
            <details className="rounded-[var(--radius-md)] border border-[var(--border)] p-4 sm:p-5">
              <summary className="cursor-pointer text-balance font-semibold">
                <span>Listing area and fixed-shipping defaults</span>
                {retainedSettings && (
                  <Badge variant="warning" className="ml-2">
                    Using previously signed settings
                  </Badge>
                )}
              </summary>
              <p className="my-4 text-pretty text-sm text-[var(--text-secondary)]">
                Use these defaults for the public area on future listings and
                the destinations of fixed-price shipping products.
              </p>
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
                    <div className="text-[1rem] font-semibold tracking-[0.03em] text-[var(--link-text)]">
                      DESTINATIONS
                    </div>
                    <div className="mt-1 text-[1rem] text-[var(--text-secondary)]">
                      Countries you ship to. Postal restrictions require
                      order-first coordination.
                    </div>
                  </div>

                  <div className="min-w-0 border-t border-[var(--border)] pt-5">
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
                        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
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
                      signedSettingsQuery.isLoading ||
                      unreviewedSettings
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
                      saveState.status === "error"
                        ? saveState.message
                        : undefined
                    }
                  />
                  {unreviewedSettings && hasUnsavedChanges && (
                    <div className="space-y-2">
                      <p
                        role="status"
                        className="text-sm text-[var(--warning-text)]"
                      >
                        Signed settings arrived while you were editing. Load
                        them before saving to preserve their destination rules
                        and Ships from area. Loading replaces your unsaved
                        edits.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          if (signedSettingsQuery.data?.state === "found")
                            loadSignedSettings(signedSettingsQuery.data)
                        }}
                      >
                        Load signed settings
                      </Button>
                    </div>
                  )}
                  {retainedSettings && (
                    <p
                      role="status"
                      className="text-pretty text-sm text-[var(--warning-text)]"
                    >
                      Your previously signed settings are preserved. Retry the
                      relay read before saving changes.
                    </p>
                  )}
                  {(retainedSettings ||
                    signedSettingsQuery.isError ||
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
            </details>
          </div>
        </section>
      </div>
    </PageLayout>
  )
}
