/**
 * Local, offline, privacy-preserving address validity gates (CND-127).
 *
 * This is the buyer-input validity check: does the entered address look like a
 * real, internally consistent destination? It is intentionally distinct from
 * merchant shipping-zone coverage (whether the merchant ships there), which is
 * handled separately by the cart shipping-eligibility helpers.
 *
 * Hard constraints:
 *  - No third-party / browser network calls. All data is bundled and offline.
 *  - No address or contact data is logged or forwarded to analytics.
 *
 * The US cross-field check uses the USPS SCF allocation: each 3-digit ZIP prefix
 * is assigned to a single state (with a handful of cross-border exceptions). We
 * derive the prefix from the postal code and confirm it agrees with the entered
 * state. Prefixes that legitimately span states resolve to multiple states and
 * are treated leniently (never flagged), so the gate biases away from blocking
 * real buyers. City-level agreement is not asserted (returned as `unknown`),
 * matching the ticket's "deliverability uncertainty" state.
 */

export interface AddressForValidation {
  name?: string
  street?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

export type AddressValidityStatus =
  | "not_required"
  | "valid"
  | "missing"
  | "inconsistent"
  | "unknown"

export type AddressValidationField =
  | "name"
  | "street"
  | "city"
  | "state"
  | "postalCode"
  | "country"

export interface AddressValidationIssue {
  field: AddressValidationField
  code:
    | "required"
    | "postal_format"
    | "state_postal_mismatch"
    | "unknown_country"
  message: string
}

export interface AddressValidityResult {
  status: AddressValidityStatus
  issues: AddressValidationIssue[]
}

/**
 * Whether a validity result should block direct payment / zap-out.
 *
 * `unknown` does NOT block — we only have partial offline data for many
 * countries and must not hold up a buyer we cannot disprove.
 */
export function isAddressValidityBlocking(
  status: AddressValidityStatus
): boolean {
  return status === "missing" || status === "inconsistent"
}

// --- US state metadata -----------------------------------------------------

const US_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "puerto rico": "PR",
}

const US_STATE_CODES = new Set([
  ...Object.values(US_STATE_NAME_TO_CODE),
])

/** Normalize a free-text US state into its 2-letter code, or `null`. */
export function normalizeUsState(input: string | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const upper = trimmed.toUpperCase()
  if (upper.length === 2 && US_STATE_CODES.has(upper)) return upper
  const byName = US_STATE_NAME_TO_CODE[trimmed.toLowerCase()]
  return byName ?? null
}

/**
 * USPS SCF allocation as inclusive 3-digit ZIP prefix ranges per state. Each
 * range is `[lo, hi]` over the leading three digits (000–999). Where prefixes
 * legitimately overlap state lines, both states list the prefix and the lookup
 * stays lenient.
 */
const US_STATE_ZIP3_RANGES: Record<string, Array<[number, number]>> = {
  AL: [[350, 369]],
  AK: [[995, 999]],
  AZ: [[850, 865]],
  AR: [[716, 729]],
  CA: [[900, 961]],
  CO: [[800, 816]],
  CT: [[60, 69]],
  DE: [[197, 199]],
  DC: [[200, 205]],
  FL: [[320, 349]],
  GA: [
    [300, 319],
    [398, 399],
  ],
  HI: [[967, 968]],
  ID: [[832, 838]],
  IL: [[600, 629]],
  IN: [[460, 479]],
  IA: [[500, 528]],
  KS: [[660, 679]],
  KY: [[400, 427]],
  LA: [[700, 714]],
  ME: [[39, 49]],
  MD: [[206, 219]],
  MA: [
    [10, 27],
    [55, 55],
  ],
  MI: [[480, 499]],
  MN: [[550, 567]],
  MS: [[386, 397]],
  MO: [[630, 658]],
  MT: [[590, 599]],
  NE: [[680, 693]],
  NV: [[889, 898]],
  NH: [[30, 38]],
  NJ: [[70, 89]],
  NM: [[870, 884]],
  NY: [
    [5, 5],
    [100, 149],
  ],
  NC: [[270, 289]],
  ND: [[580, 588]],
  OH: [[430, 459]],
  OK: [[730, 749]],
  OR: [[970, 979]],
  PA: [[150, 196]],
  PR: [[6, 9]],
  RI: [[28, 29]],
  SC: [[290, 299]],
  SD: [[570, 577]],
  TN: [[370, 385]],
  TX: [
    [733, 733],
    [750, 799],
    [885, 885],
  ],
  UT: [[840, 847]],
  VT: [[50, 59]],
  VA: [[220, 246]],
  WA: [[980, 994]],
  WV: [[247, 268]],
  WI: [[530, 549]],
  WY: [[820, 831]],
}

/** prefix (0–999) -> set of state codes that own it. */
const ZIP3_TO_STATES: Map<number, Set<string>> = (() => {
  const map = new Map<number, Set<string>>()
  for (const [state, ranges] of Object.entries(US_STATE_ZIP3_RANGES)) {
    for (const [lo, hi] of ranges) {
      for (let prefix = lo; prefix <= hi; prefix++) {
        const set = map.get(prefix) ?? new Set<string>()
        set.add(state)
        map.set(prefix, set)
      }
    }
  }
  return map
})()

const US_POSTAL_RE = /^\d{5}(?:-\d{4})?$/

/**
 * Per-country postal-format patterns for the structural check. Absence of a
 * country here means we do not assert postal shape (returns `unknown`, not a
 * failure). Patterns are deliberately permissive.
 */
const POSTAL_FORMATS: Record<string, RegExp> = {
  US: US_POSTAL_RE,
  CA: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/,
  GB: /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  AU: /^\d{4}$/,
  NL: /^\d{4}\s*[A-Za-z]{2}$/,
}

function usZip3(postalCode: string): number | null {
  const digits = postalCode.trim().slice(0, 3)
  if (!/^\d{3}$/.test(digits)) return null
  return Number.parseInt(digits, 10)
}

/**
 * Validate that an address is internally consistent. Assumes the caller has
 * already determined a physical address is required (digital orders should pass
 * `status: "not_required"` without calling this).
 */
export function validateAddressConsistency(
  address: AddressForValidation
): AddressValidityResult {
  const issues: AddressValidationIssue[] = []
  const country = (address.country ?? "").trim().toUpperCase()

  // Required physical fields (shape). Mirrors checkout-validation's required set
  // but expressed as validity issues so callers get a single result object.
  const requiredText: Array<[AddressValidationField, string | undefined]> = [
    ["name", address.name],
    ["street", address.street],
    ["city", address.city],
    ["postalCode", address.postalCode],
    ["country", address.country],
  ]
  for (const [field, value] of requiredText) {
    if (!value || !value.trim()) {
      issues.push({
        field,
        code: "required",
        message: `${labelFor(field)} is required.`,
      })
    }
  }
  if (issues.length > 0) {
    return { status: "missing", issues }
  }

  const postalCode = (address.postalCode as string).trim()

  // Postal-format check where we have a pattern for the country.
  const postalPattern = POSTAL_FORMATS[country]
  if (postalPattern && !postalPattern.test(postalCode)) {
    issues.push({
      field: "postalCode",
      code: "postal_format",
      message: "Postal code doesn't match the expected format for this country.",
    })
    return { status: "inconsistent", issues }
  }

  if (country === "US") {
    const prefix = usZip3(postalCode)
    const stateCode = normalizeUsState(address.state)
    if (prefix !== null && stateCode) {
      const owners = ZIP3_TO_STATES.get(prefix)
      // Only flag when the prefix maps to a definite set of states that
      // excludes the entered state. Unmapped prefixes -> unknown (lenient).
      if (owners && owners.size > 0 && !owners.has(stateCode)) {
        issues.push({
          field: "state",
          code: "state_postal_mismatch",
          message: `ZIP code ${postalCode} isn't in ${stateCode}. Check the state and ZIP code.`,
        })
        return { status: "inconsistent", issues }
      }
      if (owners && owners.has(stateCode)) {
        return { status: "valid", issues: [] }
      }
    }
    // Missing state or unmapped prefix: structurally fine, but we can't confirm.
    return { status: "unknown", issues: [] }
  }

  // Non-US: structural checks passed (or no pattern available). We do not have
  // offline locality data to cross-check, so we cannot positively confirm.
  return postalPattern
    ? { status: "valid", issues: [] }
    : { status: "unknown", issues: [] }
}

function labelFor(field: AddressValidationField): string {
  switch (field) {
    case "name":
      return "Name"
    case "street":
      return "Street address"
    case "city":
      return "City"
    case "state":
      return "State"
    case "postalCode":
      return "Postal code"
    case "country":
      return "Country"
  }
}
