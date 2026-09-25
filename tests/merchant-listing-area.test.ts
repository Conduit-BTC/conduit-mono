import { describe, expect, it } from "bun:test"
import { readdirSync } from "node:fs"
import { SHIPPING_COUNTRIES } from "@conduit/core"
import {
  formatListingPlace,
  geohashForListingArea,
  getListingAreaForPublication,
  isAcceptedListingAreaCountry,
  isAcceptedUSListingAreaState,
  loadListingPlaces,
  resolveListingArea,
  searchListingPlaces,
  type PlaceRow,
} from "../apps/merchant/src/lib/listingArea"
import { US_LISTING_AREA_STATES } from "../apps/merchant/src/lib/usListingAreaStates"

const US_PLACES = (await Bun.file(
  "apps/merchant/public/places/US/CA.json"
).json()) as PlaceRow[]

describe("Merchant listing area", () => {
  it("generates files only for accepted shipping countries", () => {
    const generated = readdirSync("apps/merchant/public/places")
      .filter((name) => name.endsWith(".json") && name !== "source.json")
      .map((name) => name.slice(0, -5))
      .sort()
    expect(generated).toEqual(
      SHIPPING_COUNTRIES.map(({ code }) => code)
        .filter((code) => code !== "US")
        .sort()
    )
    const states = readdirSync("apps/merchant/public/places/US")
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .sort()
    expect(states).toEqual(
      US_LISTING_AREA_STATES.map(({ code }) => code).sort()
    )
    expect(isAcceptedUSListingAreaState("CA")).toBe(true)
    expect(isAcceptedUSListingAreaState("PR")).toBe(false)
    expect(isAcceptedListingAreaCountry("US")).toBe(true)
    expect(isAcceptedListingAreaCountry("RU")).toBe(false)
  })

  it("finds places by city, county, region, and selected country", () => {
    expect(
      searchListingPlaces(US_PLACES, "Oakland", "United States")[0]?.[1]
    ).toBe("Oakland")
    const county = searchListingPlaces(
      US_PLACES,
      "Alameda County",
      "United States"
    )
    expect(county[0]?.[1]).toBe("Oakland")
    expect(county.every((row) => row[2] === "Alameda County")).toBe(true)
    const region = searchListingPlaces(US_PLACES, "California", "United States")
    expect(region[0]?.[1]).toBe("Los Angeles")
    expect(region.every((row) => row[3] === "California")).toBe(true)
    expect(
      searchListingPlaces(US_PLACES, "United States", "United States")
    ).toHaveLength(10)
    expect(
      searchListingPlaces(US_PLACES, "United", "United States")
    ).toHaveLength(10)
    expect(formatListingPlace(county[0]!, "United States")).toBe(
      "Oakland · Alameda County · California · United States"
    )
  })

  it("derives a coarse geohash only for a selected indexed place", async () => {
    expect(geohashForListingArea(37.7749, -122.4194)).toBe("9q8y")
    const untouched = await getListingAreaForPublication(
      {
        listingAreaMode: "unchanged",
        listingAreaCountry: "",
        listingAreaState: "",
        listingAreaPlaceId: null,
      },
      { location: "Existing nearby town", geohash: "9q8y" }
    )
    expect(untouched).toEqual({
      location: "Existing nearby town",
      geohash: "9q8y",
    })
    expect(
      await getListingAreaForPublication(
        {
          listingAreaMode: "clear",
          listingAreaCountry: "US",
          listingAreaState: "CA",
          listingAreaPlaceId: null,
        },
        untouched
      )
    ).toEqual({})
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify(US_PLACES))
    try {
      const oakland = searchListingPlaces(
        US_PLACES,
        "Oakland",
        "United States"
      )[0]!
      expect(
        await getListingAreaForPublication(
          {
            listingAreaMode: "selected",
            listingAreaCountry: "US",
            listingAreaState: "CA",
            listingAreaPlaceId: oakland[0],
          },
          untouched,
          resolveListingArea
        )
      ).toEqual({
        location: "Oakland, Alameda County, California, United States",
        geohash: geohashForListingArea(oakland[4], oakland[5]),
      })
    } finally {
      globalThis.fetch = originalFetch
    }
    await expect(
      getListingAreaForPublication({
        listingAreaMode: "selected",
        listingAreaCountry: "US",
        listingAreaState: "CA",
        listingAreaPlaceId: null,
      })
    ).rejects.toThrow("Select a listed place")
  })

  it("requests only the selected US state or a non-US country file", async () => {
    const requested: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      requested.push(String(input))
      return new Response("[]")
    }
    try {
      await expect(loadListingPlaces("US")).rejects.toThrow("Select a state")
      await loadListingPlaces("US", "NY")
      await loadListingPlaces("CA")
      expect(requested).toEqual(["/places/US/NY.json", "/places/CA.json"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
