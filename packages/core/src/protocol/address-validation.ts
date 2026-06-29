import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min"

/**
 * Local, offline, privacy-preserving address/contact validity gates (CND-127).
 *
 * This is the buyer-input validity check: does the entered destination and
 * optional contact information look internally consistent enough for checkout?
 * It is intentionally distinct from merchant shipping-zone coverage, which is
 * handled separately by shipping-eligibility helpers.
 *
 * Hard constraints:
 * - No third-party / browser address validation calls.
 * - No address or contact data is logged or forwarded to analytics.
 * - Local consistency checks never claim full deliverability verification.
 */

export interface AddressForValidation {
  name?: string
  street?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  email?: string
  phone?: string
}

export type AddressValidityStatus =
  | "not_required"
  | "valid"
  | "missing"
  | "inconsistent"
  | "unknown"

export type AddressConfidenceLevel =
  | "not_required"
  | "missing_required"
  | "syntax_valid"
  | "street_plausible"
  | "postal_region_consistent"
  | "locality_consistent"
  | "unsupported_country"
  | "invalid"

export type AddressValidationField =
  | "name"
  | "street"
  | "city"
  | "state"
  | "postalCode"
  | "country"
  | "email"
  | "phone"

export type AddressValidationIssueCode =
  | "required"
  | "postal_format"
  | "region_required"
  | "region_unknown"
  | "state_postal_mismatch"
  | "city_postal_mismatch"
  | "street_plausibility"
  | "locality_plausibility"
  | "email_format"
  | "phone_format"
  | "validation_incomplete"
  | "unknown_country"

export interface AddressValidationIssue {
  field: AddressValidationField
  code: AddressValidationIssueCode
  message: string
}

export interface NormalizedAddressForValidation {
  name: string
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
  email?: string
  phone?: string
}

export interface AddressValidityResult {
  status: AddressValidityStatus
  level: AddressConfidenceLevel
  issues: AddressValidationIssue[]
  warnings: AddressValidationIssue[]
  normalized: NormalizedAddressForValidation
  canSubmitOrder: boolean
  canDirectPay: boolean
  profiledCountry: boolean
}

export type AddressRegionRequirement = {
  required: boolean
  label: string
}

export const ADDRESS_VALIDATION_V1_COUNTRIES = [
  "US",
  "CA",
  "GB",
  "AU",
  "NZ",
] as const

type ProfiledCountryCode = (typeof ADDRESS_VALIDATION_V1_COUNTRIES)[number]

type RegionPrefixRule = {
  prefix: string | RegExp | ((postalCode: string) => boolean)
  regions: string[]
}

type PostalLocalityRule = {
  prefix: string | RegExp
  localities: string[]
}

type CountryAddressProfile = {
  code: ProfiledCountryCode
  postalPattern: RegExp
  postalFormatMessage: string
  regionRequired: boolean
  regionLabel: string
  regionAliases: Record<string, string>
  regionCodes: Set<string>
  regionPrefixRules: RegionPrefixRule[]
  localityRules: PostalLocalityRule[]
  directPayRequiresRegionConsistency: boolean
}

const CONTACT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_ALLOWED_CHARS_RE = /[\d\s()+-]/
const PHONE_FORMAT_MESSAGE =
  "Enter a valid phone number. Use + country code if it differs from the delivery country."
const STREET_ALLOWED_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}\s.,'‘’#/&()-]*$/u
const CITY_ALLOWED_RE = /^[\p{L}][\p{L}\p{M}\s.'‘’-]*$/u

/**
 * Whether a legacy coarse validity status should block a checkout step. Newer
 * callers should prefer `result.canSubmitOrder` / `result.canDirectPay`.
 */
export function isAddressValidityBlocking(
  status: AddressValidityStatus
): boolean {
  return status === "missing" || status === "inconsistent"
}

export function isAddressDirectPaymentBlocking(
  result: Pick<AddressValidityResult, "canDirectPay">
): boolean {
  return !result.canDirectPay
}

export function sanitizePhoneInput(value: string): string {
  let result = ""
  let hasPlus = false
  for (const char of value) {
    if (!PHONE_ALLOWED_CHARS_RE.test(char)) continue
    if (char === "+") {
      const hasNonSpace = result.trim().length > 0
      if (hasPlus || hasNonSpace) continue
      hasPlus = true
    }
    result += char
  }
  return result.replace(/\s+/g, " ").trim()
}

function normalizeLookup(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
}

function normalizePostal(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "")
}

function normalizeHumanText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ")
}

function normalizeCity(value: string | undefined): string {
  return normalizeHumanText(value)
}

function normalizeEmail(value: string | undefined): string | undefined {
  const trimmed = normalizeHumanText(value)
  return trimmed ? trimmed.toLowerCase() : undefined
}

function normalizePhone(
  value: string | undefined,
  country: string
): { normalized?: string; issue?: AddressValidationIssue } {
  const raw = value ?? ""
  const sanitized = sanitizePhoneInput(raw).trim()
  if (hasDisallowedPhoneCharacters(raw)) {
    return {
      normalized: sanitized,
      issue: {
        field: "phone",
        code: "phone_format",
        message: PHONE_FORMAT_MESSAGE,
      },
    }
  }
  if (!sanitized) return {}

  const parsed = parsePhoneNumberFromString(
    sanitized,
    country ? (country as CountryCode) : undefined
  )
  if (!parsed || !parsed.isValid()) {
    return {
      normalized: sanitized,
      issue: {
        field: "phone",
        code: "phone_format",
        message: PHONE_FORMAT_MESSAGE,
      },
    }
  }

  return { normalized: parsed.number }
}

function hasDisallowedPhoneCharacters(value: string): boolean {
  let hasPlus = false
  let hasNonSpace = false
  for (const char of value) {
    if (!PHONE_ALLOWED_CHARS_RE.test(char)) return true
    if (char === "+") {
      if (hasPlus || hasNonSpace) return true
      hasPlus = true
    } else if (char.trim()) {
      hasNonSpace = true
    }
  }
  return false
}

function issue(
  field: AddressValidationField,
  code: AddressValidationIssueCode,
  message: string
): AddressValidationIssue {
  return { field, code, message }
}

function warning(
  field: AddressValidationField,
  code: AddressValidationIssueCode,
  message: string
): AddressValidationIssue {
  return { field, code, message }
}

// --- Region metadata -------------------------------------------------------

const DEFAULT_REGION_REQUIREMENT: AddressRegionRequirement = {
  required: false,
  label: "State / Province / Region",
}

export const REQUIRED_ADDRESS_REGION_LABELS: Readonly<Record<string, string>> =
  {
    AE: "Emirate",
    AS: "State",
    AU: "State / Territory",
    BR: "State",
    CA: "Province / Territory",
    CN: "Province / Municipality / Region",
    CO: "Department",
    CR: "Province",
    ES: "Province",
    FM: "State",
    HK: "Area",
    HN: "Department",
    ID: "Province",
    IN: "State / Union Territory",
    IQ: "Province",
    IT: "Province",
    JM: "Parish",
    JP: "Prefecture",
    KN: "Island",
    KR: "Province / Metropolitan City",
    KY: "Island",
    MH: "State",
    MP: "State",
    MX: "State",
    NR: "District",
    PF: "Island",
    PG: "Province",
    PW: "State",
    RU: "Oblast / Region",
    SO: "Province",
    SV: "Province",
    TW: "County / City",
    UM: "State",
    US: "State",
    VE: "State",
    VI: "State",
  }

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

const CA_PROVINCE_NAME_TO_CODE: Record<string, string> = {
  alberta: "AB",
  "british columbia": "BC",
  manitoba: "MB",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  "nova scotia": "NS",
  "northwest territories": "NT",
  nunavut: "NU",
  ontario: "ON",
  "prince edward island": "PE",
  quebec: "QC",
  saskatchewan: "SK",
  yukon: "YT",
}

const AU_STATE_NAME_TO_CODE: Record<string, string> = {
  "australian capital territory": "ACT",
  "new south wales": "NSW",
  "northern territory": "NT",
  queensland: "QLD",
  "south australia": "SA",
  tasmania: "TAS",
  victoria: "VIC",
  "western australia": "WA",
}

const NZ_REGION_NAME_TO_CODE: Record<string, string> = {
  auckland: "AUK",
  canterbury: "CAN",
  otago: "OTA",
  wellington: "WGN",
}

const US_STATE_CODES = new Set(Object.values(US_STATE_NAME_TO_CODE))
const CA_PROVINCE_CODES = new Set(Object.values(CA_PROVINCE_NAME_TO_CODE))
const AU_STATE_CODES = new Set(Object.values(AU_STATE_NAME_TO_CODE))
const NZ_REGION_CODES = new Set(Object.values(NZ_REGION_NAME_TO_CODE))

/** Normalize a free-text US state into its 2-letter code, or `null`. */
export function normalizeUsState(input: string | undefined): string | null {
  return normalizeRegion(input, US_STATE_NAME_TO_CODE, US_STATE_CODES)
}

function normalizeRegion(
  input: string | undefined,
  aliases: Record<string, string>,
  codes: Set<string>
): string | null {
  if (!input) return null
  const trimmed = normalizeHumanText(input)
  if (!trimmed) return null
  const upper = trimmed.toUpperCase()
  if (codes.has(upper)) return upper
  return aliases[normalizeLookup(trimmed)] ?? null
}

function prefixRange(
  lo: number,
  hi: number,
  regions: string[]
): RegionPrefixRule {
  return {
    prefix: new RegExp(
      `^(${Array.from({ length: hi - lo + 1 }, (_, index) =>
        String(lo + index).padStart(3, "0")
      ).join("|")})`
    ),
    regions,
  }
}

function postalRange(
  lo: number,
  hi: number,
  regions: string[]
): RegionPrefixRule {
  return {
    prefix: (postalCode) => {
      const value = Number(postalCode.slice(0, 4))
      return Number.isInteger(value) && value >= lo && value <= hi
    },
    regions,
  }
}

const US_REGION_PREFIX_RULES: RegionPrefixRule[] = [
  prefixRange(350, 369, ["AL"]),
  prefixRange(995, 999, ["AK"]),
  prefixRange(850, 865, ["AZ"]),
  prefixRange(716, 729, ["AR"]),
  prefixRange(900, 961, ["CA"]),
  prefixRange(800, 816, ["CO"]),
  prefixRange(60, 69, ["CT"]),
  prefixRange(197, 199, ["DE"]),
  prefixRange(200, 205, ["DC"]),
  prefixRange(320, 349, ["FL"]),
  prefixRange(300, 319, ["GA"]),
  prefixRange(398, 399, ["GA"]),
  prefixRange(967, 968, ["HI"]),
  prefixRange(832, 838, ["ID"]),
  prefixRange(600, 629, ["IL"]),
  prefixRange(460, 479, ["IN"]),
  prefixRange(500, 528, ["IA"]),
  prefixRange(660, 679, ["KS"]),
  prefixRange(400, 427, ["KY"]),
  prefixRange(700, 714, ["LA"]),
  prefixRange(39, 49, ["ME"]),
  prefixRange(206, 219, ["MD"]),
  prefixRange(10, 27, ["MA"]),
  prefixRange(55, 55, ["MA"]),
  prefixRange(480, 499, ["MI"]),
  prefixRange(550, 567, ["MN"]),
  prefixRange(386, 397, ["MS"]),
  prefixRange(630, 658, ["MO"]),
  prefixRange(590, 599, ["MT"]),
  prefixRange(680, 693, ["NE"]),
  prefixRange(889, 898, ["NV"]),
  prefixRange(30, 38, ["NH"]),
  prefixRange(70, 89, ["NJ"]),
  prefixRange(870, 884, ["NM"]),
  prefixRange(5, 5, ["NY"]),
  prefixRange(100, 149, ["NY"]),
  prefixRange(270, 289, ["NC"]),
  prefixRange(580, 588, ["ND"]),
  prefixRange(430, 459, ["OH"]),
  prefixRange(730, 749, ["OK"]),
  prefixRange(970, 979, ["OR"]),
  prefixRange(150, 196, ["PA"]),
  prefixRange(6, 9, ["PR"]),
  prefixRange(28, 29, ["RI"]),
  prefixRange(290, 299, ["SC"]),
  prefixRange(570, 577, ["SD"]),
  prefixRange(370, 385, ["TN"]),
  prefixRange(733, 733, ["TX"]),
  prefixRange(750, 799, ["TX"]),
  prefixRange(885, 885, ["TX"]),
  prefixRange(840, 847, ["UT"]),
  prefixRange(50, 59, ["VT"]),
  prefixRange(220, 246, ["VA"]),
  prefixRange(980, 994, ["WA"]),
  prefixRange(247, 268, ["WV"]),
  prefixRange(530, 549, ["WI"]),
  prefixRange(820, 831, ["WY"]),
]

const PROFILES: Record<ProfiledCountryCode, CountryAddressProfile> = {
  US: {
    code: "US",
    postalPattern: /^\d{5}(?:-\d{4})?$/,
    postalFormatMessage: "Enter a 5-digit ZIP code.",
    regionRequired: true,
    regionLabel: "state",
    regionAliases: US_STATE_NAME_TO_CODE,
    regionCodes: US_STATE_CODES,
    regionPrefixRules: US_REGION_PREFIX_RULES,
    localityRules: [
      { prefix: "90210", localities: ["Beverly Hills"] },
      { prefix: "62701", localities: ["Springfield"] },
      { prefix: /^7870[14]/, localities: ["Austin"] },
      { prefix: "10001", localities: ["New York"] },
      { prefix: "98101", localities: ["Seattle"] },
    ],
    directPayRequiresRegionConsistency: true,
  },
  CA: {
    code: "CA",
    postalPattern:
      /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/,
    postalFormatMessage: "Enter a Canadian postal code like M5V 2T6.",
    regionRequired: true,
    regionLabel: "province / territory",
    regionAliases: CA_PROVINCE_NAME_TO_CODE,
    regionCodes: CA_PROVINCE_CODES,
    regionPrefixRules: [
      { prefix: "A", regions: ["NL"] },
      { prefix: "B", regions: ["NS"] },
      { prefix: "C", regions: ["PE"] },
      { prefix: "E", regions: ["NB"] },
      { prefix: /^[GHJ]/, regions: ["QC"] },
      { prefix: /^[KLMNP]/, regions: ["ON"] },
      { prefix: "R", regions: ["MB"] },
      { prefix: "S", regions: ["SK"] },
      { prefix: "T", regions: ["AB"] },
      { prefix: "V", regions: ["BC"] },
      { prefix: "X", regions: ["NT", "NU"] },
      { prefix: "Y", regions: ["YT"] },
    ],
    localityRules: [
      { prefix: "M5V", localities: ["Toronto"] },
      { prefix: "H2Y", localities: ["Montreal"] },
      { prefix: "V6B", localities: ["Vancouver"] },
    ],
    directPayRequiresRegionConsistency: true,
  },
  GB: {
    code: "GB",
    postalPattern: /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/,
    postalFormatMessage: "Enter a UK postcode like SW1A 1AA.",
    regionRequired: false,
    regionLabel: "region",
    regionAliases: {},
    regionCodes: new Set<string>(),
    regionPrefixRules: [],
    localityRules: [
      { prefix: /^SW1A/, localities: ["London", "Westminster"] },
      { prefix: /^EC1A/, localities: ["London"] },
      { prefix: /^M1/, localities: ["Manchester"] },
      { prefix: /^EH1/, localities: ["Edinburgh"] },
    ],
    directPayRequiresRegionConsistency: false,
  },
  AU: {
    code: "AU",
    postalPattern: /^\d{4}$/,
    postalFormatMessage: "Enter a 4-digit Australian postcode.",
    regionRequired: true,
    regionLabel: "state / territory",
    regionAliases: AU_STATE_NAME_TO_CODE,
    regionCodes: AU_STATE_CODES,
    regionPrefixRules: [
      postalRange(2000, 2599, ["NSW"]),
      postalRange(2619, 2899, ["NSW"]),
      postalRange(2921, 2999, ["NSW"]),
      postalRange(2600, 2618, ["ACT"]),
      postalRange(2900, 2920, ["ACT"]),
      { prefix: /^3/, regions: ["VIC"] },
      { prefix: /^4/, regions: ["QLD"] },
      { prefix: /^5/, regions: ["SA"] },
      { prefix: /^6/, regions: ["WA"] },
      { prefix: /^7/, regions: ["TAS"] },
      { prefix: /^0/, regions: ["NT"] },
    ],
    localityRules: [
      { prefix: "2000", localities: ["Sydney"] },
      { prefix: "3000", localities: ["Melbourne"] },
      { prefix: "4000", localities: ["Brisbane"] },
      { prefix: "5000", localities: ["Adelaide"] },
      { prefix: "6000", localities: ["Perth"] },
    ],
    directPayRequiresRegionConsistency: true,
  },
  NZ: {
    code: "NZ",
    postalPattern: /^\d{4}$/,
    postalFormatMessage: "Enter a 4-digit New Zealand postcode.",
    regionRequired: false,
    regionLabel: "region",
    regionAliases: NZ_REGION_NAME_TO_CODE,
    regionCodes: NZ_REGION_CODES,
    regionPrefixRules: [
      { prefix: /^10|^06/, regions: ["AUK"] },
      { prefix: /^50|^60/, regions: ["WGN"] },
      { prefix: /^80|^81/, regions: ["CAN"] },
      { prefix: /^90/, regions: ["OTA"] },
    ],
    localityRules: [
      { prefix: "1010", localities: ["Auckland"] },
      { prefix: "6011", localities: ["Wellington"] },
      { prefix: "8011", localities: ["Christchurch"] },
      { prefix: "9016", localities: ["Dunedin"] },
    ],
    directPayRequiresRegionConsistency: false,
  },
}

function getProfile(country: string): CountryAddressProfile | undefined {
  return PROFILES[country as ProfiledCountryCode]
}

export function isAddressRegionRequired(country: string): boolean {
  return getAddressRegionRequirement(country).required
}

export function getAddressRegionRequirement(
  country: string
): AddressRegionRequirement {
  const code = normalizeHumanText(country).toUpperCase()
  const label = REQUIRED_ADDRESS_REGION_LABELS[code]
  if (!label) return { ...DEFAULT_REGION_REQUIREMENT }
  return { required: true, label }
}

export function getAddressRegionLabel(country: string): string {
  return getAddressRegionRequirement(country).label
}

function regionLabelForMessage(label: string): string {
  return label.toLocaleLowerCase("en-US")
}

function matchRule(
  postalCode: string,
  rule: RegionPrefixRule | PostalLocalityRule
): boolean {
  if (typeof rule.prefix === "function") return rule.prefix(postalCode)
  if (typeof rule.prefix === "string") return postalCode.startsWith(rule.prefix)
  return rule.prefix.test(postalCode)
}

function getPostalRegions(
  profile: CountryAddressProfile,
  postalCode: string
): string[] | null {
  for (const rule of profile.regionPrefixRules) {
    if (matchRule(postalCode, rule)) return rule.regions
  }
  return profile.regionPrefixRules.length > 0 ? null : []
}

function getPostalLocalities(
  profile: CountryAddressProfile,
  postalCode: string
): string[] | null {
  for (const rule of profile.localityRules) {
    if (matchRule(postalCode, rule)) return rule.localities
  }
  return null
}

function localityMatches(input: string, expected: string[]): boolean {
  const normalizedInput = normalizeLookup(input)
  return expected.some(
    (locality) => normalizeLookup(locality) === normalizedInput
  )
}

function validateStreet(value: string): {
  issue?: AddressValidationIssue
  warning?: AddressValidationIssue
} {
  const text = normalizeHumanText(value)
  if (text.length < 5 || !/\p{L}/u.test(text)) {
    return {
      issue: issue(
        "street",
        "street_plausibility",
        "Enter a real street address."
      ),
    }
  }
  if (!STREET_ALLOWED_RE.test(text) || symbolRatio(text) > 0.28) {
    return {
      issue: issue(
        "street",
        "street_plausibility",
        "Street address contains unsupported characters."
      ),
    }
  }
  if (!/\d/.test(text)) {
    return {
      warning: warning(
        "street",
        "street_plausibility",
        "Street address does not include a house or building number. Review it carefully before paying."
      ),
    }
  }
  return {}
}

function validateCity(value: string): AddressValidationIssue | null {
  const text = normalizeCity(value)
  if (text.length < 2 || !CITY_ALLOWED_RE.test(text)) {
    return issue("city", "locality_plausibility", "Enter a valid city.")
  }
  return null
}

function symbolRatio(value: string): number {
  if (!value) return 0
  const symbols = value.replace(/[\p{L}\p{M}\p{N}\s]/gu, "").length
  return symbols / value.length
}

function statusFromIssues(
  issues: AddressValidationIssue[]
): AddressValidityStatus {
  if (issues.some((item) => item.code === "required")) return "missing"
  if (issues.length > 0) return "inconsistent"
  return "valid"
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
      return "State / Province / Region"
    case "postalCode":
      return "Postal/ZIP code"
    case "country":
      return "Country"
    case "email":
      return "Email"
    case "phone":
      return "Phone"
  }
}

export function validateAddressConsistency(
  address: AddressForValidation
): AddressValidityResult {
  const country = normalizeHumanText(address.country).toUpperCase()
  const normalized: NormalizedAddressForValidation = {
    name: normalizeHumanText(address.name),
    street: normalizeHumanText(address.street),
    city: normalizeCity(address.city),
    state: normalizeHumanText(address.state) || undefined,
    postalCode: normalizePostal(address.postalCode ?? ""),
    country,
    email: normalizeEmail(address.email),
  }

  const phone = normalizePhone(address.phone, country)
  if (phone.normalized) normalized.phone = phone.normalized

  const issues: AddressValidationIssue[] = []
  const warnings: AddressValidationIssue[] = []
  for (const [field, value] of [
    ["name", normalized.name],
    ["street", normalized.street],
    ["city", normalized.city],
    ["postalCode", normalized.postalCode],
    ["country", normalized.country],
  ] as Array<[AddressValidationField, string | undefined]>) {
    if (!value) {
      issues.push(issue(field, "required", `${labelFor(field)} is required.`))
    }
  }

  if (normalized.email && !CONTACT_EMAIL_RE.test(normalized.email)) {
    issues.push(issue("email", "email_format", "Enter a valid email address."))
  }
  if (phone.issue) issues.push(phone.issue)

  if (normalized.street) {
    const streetResult = validateStreet(normalized.street)
    if (streetResult.issue) issues.push(streetResult.issue)
    if (streetResult.warning) warnings.push(streetResult.warning)
  }
  if (normalized.city) {
    const cityIssue = validateCity(normalized.city)
    if (cityIssue) issues.push(cityIssue)
  }

  const profile = getProfile(country)
  if (!profile) {
    const regionRequirement = getAddressRegionRequirement(country)
    if (regionRequirement.required && !normalized.state) {
      warnings.push(
        warning(
          "state",
          "region_required",
          `We could not validate the ${regionLabelForMessage(regionRequirement.label)} locally. Review it carefully before paying.`
        )
      )
    }

    const status = statusFromIssues(issues)
    if (status === "valid") {
      warnings.push(
        warning(
          "country",
          "unknown_country",
          "We could not fully validate this address locally. Review it carefully before paying; the merchant may need to confirm details."
        )
      )
    }
    return {
      status: status === "valid" ? "unknown" : status,
      level: status === "valid" ? "unsupported_country" : "invalid",
      issues,
      warnings,
      normalized,
      canSubmitOrder: issues.length === 0,
      canDirectPay: issues.length === 0,
      profiledCountry: false,
    }
  }

  const normalizedRegion = normalizeRegion(
    normalized.state,
    profile.regionAliases,
    profile.regionCodes
  )
  if (normalizedRegion) normalized.state = normalizedRegion

  if (profile.regionRequired && !normalizedRegion) {
    warnings.push(
      warning(
        "state",
        "region_required",
        `We could not validate the ${profile.regionLabel} locally. Review it carefully before paying.`
      )
    )
  } else if (
    normalized.state &&
    !normalizedRegion &&
    profile.regionCodes.size > 0
  ) {
    warnings.push(
      warning(
        "state",
        "region_unknown",
        `We could not validate the ${profile.regionLabel} locally. Review it carefully before paying.`
      )
    )
  }

  if (
    normalized.postalCode &&
    !profile.postalPattern.test(normalized.postalCode)
  ) {
    issues.push(
      issue("postalCode", "postal_format", profile.postalFormatMessage)
    )
  }

  let regionConsistent = false
  if (normalized.postalCode && normalizedRegion) {
    const postalRegions = getPostalRegions(profile, normalized.postalCode)
    if (postalRegions && postalRegions.length > 0) {
      if (!postalRegions.includes(normalizedRegion)) {
        warnings.push(
          warning(
            "state",
            "state_postal_mismatch",
            `${labelFor("postalCode")} may not match the selected ${profile.regionLabel}. Review it carefully before paying.`
          )
        )
      } else {
        regionConsistent = true
      }
    }
  }

  let localityConsistent = false
  if (normalized.postalCode && normalized.city) {
    const expectedLocalities = getPostalLocalities(
      profile,
      normalized.postalCode
    )
    if (expectedLocalities && expectedLocalities.length > 0) {
      if (!localityMatches(normalized.city, expectedLocalities)) {
        warnings.push(
          warning(
            "city",
            "city_postal_mismatch",
            "City may not match the postal code. Review it carefully before paying."
          )
        )
      } else {
        localityConsistent = true
      }
    }
  }

  const status = statusFromIssues(issues)
  if (status !== "valid") {
    return {
      status,
      level: status === "missing" ? "missing_required" : "invalid",
      issues,
      warnings,
      normalized,
      canSubmitOrder: false,
      canDirectPay: false,
      profiledCountry: true,
    }
  }

  const level: AddressConfidenceLevel = localityConsistent
    ? "locality_consistent"
    : regionConsistent
      ? "postal_region_consistent"
      : "street_plausible"

  const canDirectPay = localityConsistent || regionConsistent
  if (!canDirectPay) {
    warnings.push(
      warning(
        "country",
        "validation_incomplete",
        "We could not fully validate this address locally. Review it carefully before paying; the merchant may need to confirm details."
      )
    )
  }

  return {
    status: "valid",
    level,
    issues: [],
    warnings,
    normalized,
    canSubmitOrder: true,
    canDirectPay: true,
    profiledCountry: true,
  }
}
