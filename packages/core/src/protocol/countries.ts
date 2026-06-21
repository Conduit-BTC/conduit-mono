import { getData } from "country-list"

export type CountryOption = {
  code: string
  name: string
}

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

export const UNAVAILABLE_SHIPPING_COUNTRY_CODES = [
  "AF",
  "BY",
  "CU",
  "ER",
  "HT",
  "IR",
  "KP",
  "RU",
  "SD",
  "SS",
  "SY",
  "TM",
  "UA",
  "YE",
] as const

const UNAVAILABLE_SHIPPING_COUNTRY_CODE_SET = new Set<string>(
  UNAVAILABLE_SHIPPING_COUNTRY_CODES
)

export const SHIPPING_COUNTRIES: CountryOption[] = getData()
  .filter((country) => !UNAVAILABLE_SHIPPING_COUNTRY_CODE_SET.has(country.code))
  .map((country) => ({
    code: country.code,
    name: COUNTRY_NAME_OVERRIDES[country.code] ?? country.name,
  }))
  .sort((a, b) => a.name.localeCompare(b.name))
