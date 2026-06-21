import { describe, expect, it } from "bun:test"
import {
  getFilteredComboboxOptions,
  type ComboboxOption,
} from "../packages/ui/src/components/Combobox"

const countryOptions: ComboboxOption[] = [
  {
    value: "AX",
    label: "Åland Islands",
    meta: "AX",
    searchText: "AX Åland Islands",
  },
  {
    value: "TZ",
    label: "Tanzania, the United Republic of",
    meta: "TZ",
    searchText: "TZ Tanzania, the United Republic of",
  },
  {
    value: "GB",
    label: "United Kingdom",
    meta: "GB",
    searchText: "GB United Kingdom",
  },
  {
    value: "CA",
    label: "Canada",
    meta: "CA",
    searchText: "CA Canada",
  },
]

describe("combobox filtering", () => {
  it("prefers label word starts over incidental search-text matches", () => {
    expect(getFilteredComboboxOptions(countryOptions, "un")[0]?.value).toBe(
      "GB"
    )
  })

  it("restores the original order when the search is cleared", () => {
    expect(
      getFilteredComboboxOptions(countryOptions, "").map((item) => item.value)
    ).toEqual(["AX", "TZ", "GB", "CA"])
  })

  it("matches diacritic-insensitive labels", () => {
    expect(getFilteredComboboxOptions(countryOptions, "aland")[0]?.value).toBe(
      "AX"
    )
  })
})
