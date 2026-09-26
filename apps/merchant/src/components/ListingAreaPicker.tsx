import { useEffect, useMemo, useState } from "react"
import { SHIPPING_COUNTRIES } from "@conduit/core"
import { Button, Combobox, Label } from "@conduit/ui"
import {
  formatListingPlace,
  loadListingPlaces,
  searchListingPlaces,
  type PlaceRow,
} from "../lib/listingArea"
import { US_LISTING_AREA_STATES } from "../lib/usListingAreaStates"

const countryOptions = SHIPPING_COUNTRIES.map((country) => ({
  value: country.code,
  label: country.name,
  meta: country.code,
  searchText: `${country.name} ${country.code}`,
}))

const stateOptions = US_LISTING_AREA_STATES.map((state) => ({
  value: state.code,
  label: state.name,
  meta: state.code,
  searchText: `${state.name} ${state.code}`,
}))

function useListingPlaces(countryCode: string, stateCode: string) {
  const [snapshot, setSnapshot] = useState<{
    path: string
    rows: PlaceRow[]
    error: boolean
  } | null>(null)
  const path =
    countryCode === "US" ? `${countryCode}/${stateCode}` : countryCode
  const ready = !!countryCode && (countryCode !== "US" || !!stateCode)
  useEffect(() => {
    if (!ready) return
    let active = true
    loadListingPlaces(countryCode, stateCode)
      .then((rows) => {
        if (active) setSnapshot({ path, rows, error: false })
      })
      .catch(() => {
        if (active) setSnapshot({ path, rows: [], error: true })
      })
    return () => {
      active = false
    }
  }, [countryCode, stateCode, path, ready])
  const current = ready && snapshot?.path === path ? snapshot : null
  return {
    places: current?.rows ?? [],
    loading: ready && !current,
    error: current?.error ?? false,
  }
}

function getSearchHint(query: string, countryName: string): string {
  return !query.trim() ||
    countryName.toLowerCase().includes(query.trim().toLowerCase())
    ? "Showing a short ranked set. Search a town, county, or region to narrow it."
    : "Only choosing a suggestion sets the listing area."
}

export function ListingAreaPicker({
  label = "Listing area (optional)",
  helpText = "Choose a nearby listed town. This public area is approximate and does not promise pickup or reveal your exact position.",
  publicAreaPrefix = "Public listing area",
  countryCode,
  stateCode,
  placeId,
  preservedLocation,
  onCountryChange,
  onStateChange,
  onPlaceChange,
  onClear,
}: {
  label?: string
  helpText?: string
  publicAreaPrefix?: string
  countryCode: string
  stateCode: string
  placeId: number | null
  preservedLocation?: string
  onCountryChange: (code: string) => void
  onStateChange: (code: string) => void
  onPlaceChange: (id: number | null) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState("")
  const country = SHIPPING_COUNTRIES.find((item) => item.code === countryCode)
  const { places, loading, error } = useListingPlaces(countryCode, stateCode)

  const selected = places.find((row) => row[0] === placeId)
  const suggestions = useMemo(
    () => (country ? searchListingPlaces(places, query, country.name) : []),
    [places, query, country]
  )
  const options = suggestions.map((row) => ({
    value: String(row[0]),
    label: formatListingPlace(row, country?.name ?? ""),
    searchText: formatListingPlace(row, country?.name ?? ""),
  }))
  const publicArea = selected
    ? formatListingPlace(selected, country?.name ?? "", ", ")
    : preservedLocation

  return (
    <div className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
      <Label htmlFor="listing-area-country">{label}</Label>
      <p className="text-xs leading-5 text-[var(--text-muted)]">{helpText}</p>
      <Combobox
        id="listing-area-country"
        value={countryCode}
        options={countryOptions}
        onValueChange={(code) => {
          setQuery("")
          onCountryChange(code)
        }}
        placeholder="Select a country"
        searchPlaceholder="Search countries"
        emptyText="No accepted country found."
        searchInTrigger
      />
      {countryCode === "US" && (
        <Combobox
          id="listing-area-state"
          value={stateCode}
          options={stateOptions}
          onValueChange={(code) => {
            setQuery("")
            onStateChange(code)
          }}
          placeholder="Select a state"
          searchPlaceholder="Search states"
          emptyText="No state found."
          searchInTrigger
        />
      )}
      <Combobox
        id="listing-area-place"
        value={placeId === null ? undefined : String(placeId)}
        selectedLabel={
          selected
            ? formatListingPlace(selected, country?.name ?? "")
            : undefined
        }
        options={options}
        onValueChange={(value) => onPlaceChange(Number(value))}
        filterOptions={false}
        onSearchChange={(text) => {
          setQuery(text)
          if (text && placeId !== null) onPlaceChange(null)
        }}
        disabled={
          !country || (countryCode === "US" && !stateCode) || loading || error
        }
        placeholder={
          countryCode === "US" && !stateCode
            ? "Select a state first"
            : loading
              ? "Loading places…"
              : "Search a place, county, or region"
        }
        searchPlaceholder="Search a place, county, or region"
        emptyText={
          places.length === 0
            ? "No places in this index. You can publish without an area."
            : "No matching places. Try a nearby town."
        }
        searchInTrigger
      />
      {country && (countryCode !== "US" || stateCode) && !loading && !error && (
        <p className="text-xs text-[var(--text-muted)]">
          {getSearchHint(query, country.name)}
        </p>
      )}
      {error && (
        <p role="status" className="text-xs text-error">
          Place index unavailable. You can still publish without an area.
        </p>
      )}
      {placeId !== null && !loading && !selected && !error && (
        <p role="status" className="text-xs text-error">
          Selected place is no longer available. Choose another or clear the
          area.
        </p>
      )}
      {publicArea && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            {publicAreaPrefix}: <strong>{publicArea}</strong>
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            Clear area
          </Button>
        </div>
      )}
      <p className="text-xs text-[var(--text-muted)]">
        Place data ©{" "}
        <a
          href="https://www.geonames.org/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          GeoNames
        </a>
        ,{" "}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          CC BY 4.0
        </a>
        . The source may omit small settlements.
      </p>
    </div>
  )
}
