import { SHIPPING_COUNTRIES } from "@conduit/core"
import { US_LISTING_AREA_STATES } from "./usListingAreaStates"

export type PlaceRow = [
  id: number,
  name: string,
  county: string,
  region: string,
  latitude: number,
  longitude: number,
  population: number,
]

type SearchablePlace = {
  row: PlaceRow
  name: string
  county: string
  region: string
}
const placeCache = new Map<string, Promise<PlaceRow[]>>()
const searchableCache = new WeakMap<PlaceRow[], SearchablePlace[]>()
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

export function isAcceptedListingAreaCountry(code: string): boolean {
  return SHIPPING_COUNTRIES.some((country) => country.code === code)
}

export function isAcceptedUSListingAreaState(code: string): boolean {
  return US_LISTING_AREA_STATES.some((state) => state.code === code)
}

export async function loadListingPlaces(
  code: string,
  stateCode = ""
): Promise<PlaceRow[]> {
  if (!isAcceptedListingAreaCountry(code))
    throw new Error("Listing area country is unavailable")
  if (code === "US" && !isAcceptedUSListingAreaState(stateCode))
    throw new Error("Select a state before searching places")
  const path = code === "US" ? `US/${stateCode}` : code
  let pending = placeCache.get(path)
  if (!pending) {
    pending = fetch(`/places/${path}.json`).then(async (response) => {
      if (!response.ok) throw new Error("Place index is unavailable")
      return (await response.json()) as PlaceRow[]
    })
    placeCache.set(path, pending)
    pending.catch(() => placeCache.delete(path))
  }
  return pending
}

function searchable(places: PlaceRow[]): SearchablePlace[] {
  let cached = searchableCache.get(places)
  if (!cached) {
    cached = places.map((row) => ({
      row,
      name: normalize(row[1]),
      county: normalize(row[2]),
      region: normalize(row[3]),
    }))
    searchableCache.set(places, cached)
  }
  return cached
}

export function searchListingPlaces(
  places: PlaceRow[],
  query: string,
  countryName: string,
  limit = 10
): PlaceRow[] {
  const needle = normalize(query)
  const countryOnly = !needle || normalize(countryName).includes(needle)
  const areaQuery =
    !countryOnly &&
    searchable(places).some(
      (place) => place.county === needle || place.region === needle
    )
  const best: Array<{ row: PlaceRow; score: number }> = []
  for (const place of searchable(places)) {
    const score = countryOnly
      ? 7
      : areaQuery && (place.county === needle || place.region === needle)
        ? 0
        : place.name === needle
          ? 1
          : place.name.startsWith(needle)
            ? 2
            : place.name.includes(needle)
              ? 3
              : place.county === needle
                ? 4
                : place.county.startsWith(needle)
                  ? 5
                  : place.county.includes(needle)
                    ? 6
                    : place.region.includes(needle)
                      ? 7
                      : Infinity
    if (!Number.isFinite(score)) continue
    const entry = { row: place.row, score }
    const position = best.findIndex(
      (current) =>
        score < current.score ||
        (score === current.score && place.row[6] > current.row[6])
    )
    if (position < 0) best.push(entry)
    else best.splice(position, 0, entry)
    if (best.length > limit) best.pop()
  }
  return best.map(({ row }) => row)
}

export function formatListingPlace(
  row: PlaceRow,
  countryName: string,
  separator = " · "
): string {
  return [row[1], row[2], row[3], countryName].filter(Boolean).join(separator)
}

export function geohashForListingArea(
  latitude: number,
  longitude: number
): string {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error("Place coordinates are invalid")
  }
  const lat = [-90, 90]
  const lon = [-180, 180]
  let bits = 0
  let value = 0
  let result = ""
  while (result.length < 4) {
    const range = bits % 2 === 0 ? lon : lat
    const midpoint = (range[0] + range[1]) / 2
    const coordinate = bits % 2 === 0 ? longitude : latitude
    value = (value << 1) | (coordinate >= midpoint ? 1 : 0)
    if (coordinate >= midpoint) range[0] = midpoint
    else range[1] = midpoint
    bits += 1
    if (bits % 5 === 0) {
      result += BASE32[value]
      value = 0
    }
  }
  return result
}

export async function resolveListingArea(
  code: string,
  stateCode: string,
  placeId: number
): Promise<{ location: string; geohash: string }> {
  const country = SHIPPING_COUNTRIES.find((item) => item.code === code)
  if (!country || !Number.isSafeInteger(placeId))
    throw new Error("Select a listed place")
  const place = (await loadListingPlaces(code, stateCode)).find(
    (row) => row[0] === placeId
  )
  if (!place)
    throw new Error(
      "Selected place is no longer in the index. Choose another place or clear the listing area."
    )
  return {
    location: formatListingPlace(place, country.name, ", "),
    geohash: geohashForListingArea(place[4], place[5]),
  }
}

export async function getListingAreaForPublication(
  form: {
    listingAreaMode: "unchanged" | "selected" | "clear"
    listingAreaCountry: string
    listingAreaState: string
    listingAreaPlaceId: number | null
  },
  existing?: { location?: string; geohash?: string },
  resolve = resolveListingArea
): Promise<{ location?: string; geohash?: string }> {
  if (form.listingAreaMode === "unchanged") {
    return { location: existing?.location, geohash: existing?.geohash }
  }
  if (form.listingAreaMode === "clear") return {}
  if (form.listingAreaPlaceId === null) throw new Error("Select a listed place")
  return resolve(
    form.listingAreaCountry,
    form.listingAreaState,
    form.listingAreaPlaceId
  )
}
