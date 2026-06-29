import { describe, expect, it } from "bun:test"
import {
  ADDRESS_VALIDATION_V1_COUNTRIES,
  REQUIRED_ADDRESS_REGION_LABELS,
  getAddressRegionRequirement,
  isAddressDirectPaymentBlocking,
  isAddressRegionRequired,
  isAddressValidityBlocking,
  normalizeUsState,
  sanitizePhoneInput,
  validateAddressConsistency,
} from "@conduit/core"

const beverlyHills = {
  name: "Testy McTesterson",
  street: "455 N Rexford Dr",
  city: "Beverly Hills",
  postalCode: "90210",
  country: "US",
}

const requiredRegionLabels = [
  ["AE", "Emirate"],
  ["AS", "State"],
  ["AU", "State / Territory"],
  ["BR", "State"],
  ["CA", "Province / Territory"],
  ["CN", "Province / Municipality / Region"],
  ["CO", "Department"],
  ["CR", "Province"],
  ["ES", "Province"],
  ["FM", "State"],
  ["HK", "Area"],
  ["HN", "Department"],
  ["ID", "Province"],
  ["IN", "State / Union Territory"],
  ["IQ", "Province"],
  ["IT", "Province"],
  ["JM", "Parish"],
  ["JP", "Prefecture"],
  ["KN", "Island"],
  ["KR", "Province / Metropolitan City"],
  ["KY", "Island"],
  ["MH", "State"],
  ["MP", "State"],
  ["MX", "State"],
  ["NR", "District"],
  ["PF", "Island"],
  ["PG", "Province"],
  ["PW", "State"],
  ["RU", "Oblast / Region"],
  ["SO", "Province"],
  ["SV", "Province"],
  ["TW", "County / City"],
  ["UM", "State"],
  ["US", "State"],
  ["VE", "State"],
  ["VI", "State"],
] as const

describe("validateAddressConsistency", () => {
  it("declares the CND-127 v1 country tranche", () => {
    expect(ADDRESS_VALIDATION_V1_COUNTRIES).toEqual([
      "US",
      "CA",
      "GB",
      "AU",
      "NZ",
    ])
  })

  it("reports country-specific region requirements and display labels", () => {
    expect(Object.keys(REQUIRED_ADDRESS_REGION_LABELS).sort()).toEqual(
      requiredRegionLabels.map(([code]) => code).sort()
    )

    for (const [code, label] of requiredRegionLabels) {
      expect(isAddressRegionRequired(code)).toBe(true)
      expect(getAddressRegionRequirement(code)).toEqual({
        required: true,
        label,
      })
    }

    expect(getAddressRegionRequirement("ca")).toEqual({
      required: true,
      label: "Province / Territory",
    })
    expect(isAddressRegionRequired("GB")).toBe(false)
    expect(isAddressRegionRequired("NZ")).toBe(false)
    expect(getAddressRegionRequirement("DE")).toEqual({
      required: false,
      label: "State / Province / Region",
    })
  })

  it("warns on the CND-127 example (90210 / Beverly Hills / Texas)", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "Texas",
    })
    expect(result.status).toBe("valid")
    expect(result.issues).toEqual([])
    expect(
      result.warnings.some((item) => item.code === "state_postal_mismatch")
    ).toBe(true)
    expect(result.canSubmitOrder).toBe(true)
    expect(result.canDirectPay).toBe(true)
    expect(isAddressDirectPaymentBlocking(result)).toBe(false)
    expect(isAddressValidityBlocking(result.status)).toBe(false)
  })

  it("accepts the same ZIP with the correct state", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "CA",
    })
    expect(result.status).toBe("valid")
    expect(result.level).toBe("locality_consistent")
    expect(result.warnings).toEqual([])
    expect(result.canSubmitOrder).toBe(true)
    expect(result.canDirectPay).toBe(true)
    expect(isAddressValidityBlocking(result.status)).toBe(false)
  })

  it("accepts the full state name spelled out", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "California",
    })
    expect(result.status).toBe("valid")
    expect(result.normalized.state).toBe("CA")
  })

  it("reports missing required fields", () => {
    const result = validateAddressConsistency({
      name: "",
      street: "",
      city: "",
      postalCode: "",
      country: "",
    })
    expect(result.status).toBe("missing")
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.canSubmitOrder).toBe(false)
    expect(isAddressValidityBlocking(result.status)).toBe(true)
  })

  it("rejects a malformed US postal code", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      postalCode: "9021",
      state: "CA",
    })
    expect(result.status).toBe("inconsistent")
    expect(result.issues[0]?.code).toBe("postal_format")
  })

  it("warns when countries whose profiles expect a region do not have one", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "",
    })
    expect(result.status).toBe("valid")
    expect(result.issues).toEqual([])
    expect(
      result.warnings.some((item) => item.code === "region_required")
    ).toBe(true)
    expect(result.canSubmitOrder).toBe(true)
    expect(result.canDirectPay).toBe(true)
  })

  it("warns but allows direct payment when an unprofiled required-region country omits region", () => {
    const result = validateAddressConsistency({
      name: "Aisha Example",
      street: "123 Creek Road",
      city: "Dubai",
      state: "",
      postalCode: "00000",
      country: "AE",
    })
    expect(result.profiledCountry).toBe(false)
    expect(result.status).toBe("unknown")
    expect(result.issues).toEqual([])
    expect(
      result.warnings.some((item) => item.code === "region_required")
    ).toBe(true)
    expect(
      result.warnings.some((item) => item.code === "unknown_country")
    ).toBe(true)
    expect(result.canSubmitOrder).toBe(true)
    expect(result.canDirectPay).toBe(true)
  })

  it("warns on a known US city/postal mismatch", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      city: "Costa Banana",
      state: "CA",
    })
    expect(result.status).toBe("valid")
    expect(result.issues).toEqual([])
    expect(
      result.warnings.some((item) => item.code === "city_postal_mismatch")
    ).toBe(true)
    expect(result.canDirectPay).toBe(true)
  })

  it("rejects obvious street-address junk", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "3400 Avenue of the Arts12312!!! 1<<CC>> ,.,s,d,,",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    })
    expect(result.status).toBe("inconsistent")
    expect(
      result.issues.some((item) => item.code === "street_plausibility")
    ).toBe(true)
  })

  it("warns but allows direct payment when the street has no building number", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      street: "Rexford Drive",
      state: "CA",
    })
    expect(result.status).toBe("valid")
    expect(result.issues).toEqual([])
    expect(
      result.warnings.some((item) => item.code === "street_plausibility")
    ).toBe(true)
    expect(result.canSubmitOrder).toBe(true)
    expect(result.canDirectPay).toBe(true)
  })

  it("validates Canadian postal/province consistency", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "301 Front St W",
      city: "Toronto",
      state: "Ontario",
      postalCode: "M5V 2T6",
      country: "CA",
    })
    expect(result.status).toBe("valid")
    expect(result.normalized.postalCode).toBe("M5V2T6")
    expect(result.normalized.state).toBe("ON")
    expect(result.canDirectPay).toBe(true)
  })

  it("warns on Canadian postal/province mismatches", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "301 Front St W",
      city: "Toronto",
      state: "BC",
      postalCode: "M5V 2T6",
      country: "CA",
    })
    expect(result.status).toBe("valid")
    expect(result.issues).toEqual([])
    expect(
      result.warnings.some((item) => item.code === "state_postal_mismatch")
    ).toBe(true)
    expect(result.canDirectPay).toBe(true)
  })

  it("rejects invalid Canadian postal-code letters", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "301 Front St W",
      city: "Toronto",
      state: "ON",
      postalCode: "Q1Q 1Q1",
      country: "CA",
    })
    expect(result.status).toBe("inconsistent")
    expect(result.issues.some((item) => item.code === "postal_format")).toBe(
      true
    )
  })

  it("accepts accented Canadian locality and street text", () => {
    const montreal = validateAddressConsistency({
      name: "Jane Doe",
      street: "380 Saint-Antoine O",
      city: "Montréal",
      state: "QC",
      postalCode: "H2Y 1C6",
      country: "CA",
    })
    expect(montreal.status).toBe("valid")
    expect(montreal.level).toBe("locality_consistent")
    expect(montreal.canDirectPay).toBe(true)

    const quebec = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Côte de la Fabrique",
      city: "Québec",
      state: "QC",
      postalCode: "G1R 4P5",
      country: "CA",
    })
    expect(quebec.status).toBe("valid")
    expect(
      quebec.issues.some((item) => item.code === "street_plausibility")
    ).toBe(false)
    expect(
      quebec.issues.some((item) => item.code === "locality_plausibility")
    ).toBe(false)
    expect(quebec.canDirectPay).toBe(true)
  })

  it("accepts apostrophes and accents in street and locality text", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Rue de l'Église",
      city: "St. John's",
      state: "NL",
      postalCode: "A1C 5X1",
      country: "CA",
    })
    expect(result.status).toBe("valid")
    expect(
      result.issues.some((item) => item.code === "street_plausibility")
    ).toBe(false)
    expect(
      result.issues.some((item) => item.code === "locality_plausibility")
    ).toBe(false)
    expect(result.level).toBe("postal_region_consistent")

    const smartQuoteResult = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Rue de l’Église",
      city: "St. John’s",
      state: "NL",
      postalCode: "A1C 5X1",
      country: "CA",
    })
    expect(smartQuoteResult.status).toBe("valid")
    expect(
      smartQuoteResult.issues.some(
        (item) => item.code === "street_plausibility"
      )
    ).toBe(false)
    expect(
      smartQuoteResult.issues.some(
        (item) => item.code === "locality_plausibility"
      )
    ).toBe(false)
  })

  it("splits Canadian A and B postal prefixes by province", () => {
    const novaScotia = validateAddressConsistency({
      name: "Jane Doe",
      street: "123 Main St",
      city: "Halifax",
      state: "NS",
      postalCode: "B3H 1Y2",
      country: "CA",
    })
    expect(novaScotia.status).toBe("valid")
    expect(novaScotia.level).toBe("postal_region_consistent")
    expect(novaScotia.canDirectPay).toBe(true)

    const newfoundland = validateAddressConsistency({
      name: "Jane Doe",
      street: "123 Main St",
      city: "St. John's",
      state: "NL",
      postalCode: "A1C 5X1",
      country: "CA",
    })
    expect(newfoundland.status).toBe("valid")
    expect(newfoundland.level).toBe("postal_region_consistent")
    expect(newfoundland.canDirectPay).toBe(true)

    const bInNewfoundland = validateAddressConsistency({
      name: "Jane Doe",
      street: "123 Main St",
      city: "Halifax",
      state: "NL",
      postalCode: "B3H 1Y2",
      country: "CA",
    })
    expect(bInNewfoundland.status).toBe("valid")
    expect(
      bInNewfoundland.warnings.some(
        (item) => item.code === "state_postal_mismatch"
      )
    ).toBe(true)
    expect(bInNewfoundland.canDirectPay).toBe(true)

    const aInNovaScotia = validateAddressConsistency({
      name: "Jane Doe",
      street: "123 Main St",
      city: "St. John's",
      state: "NS",
      postalCode: "A1C 5X1",
      country: "CA",
    })
    expect(aInNovaScotia.status).toBe("valid")
    expect(
      aInNovaScotia.warnings.some(
        (item) => item.code === "state_postal_mismatch"
      )
    ).toBe(true)
    expect(
      aInNovaScotia.issues.some((item) => item.code === "locality_plausibility")
    ).toBe(false)
  })

  it("validates a well-formed UK postcode structurally", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "10 Downing St",
      city: "London",
      postalCode: "SW1A 2AA",
      country: "GB",
    })
    expect(result.status).toBe("valid")
    expect(result.level).toBe("locality_consistent")
    expect(result.canDirectPay).toBe(true)
  })

  it("allows UK direct payment with a warning when locality evidence is incomplete", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "22 High St",
      city: "Bath",
      postalCode: "BA1 1AA",
      country: "GB",
    })
    expect(result.status).toBe("valid")
    expect(result.canSubmitOrder).toBe(true)
    expect(result.level).toBe("street_plausible")
    expect(
      result.warnings.some((item) => item.code === "validation_incomplete")
    ).toBe(true)
    expect(result.canDirectPay).toBe(true)
  })

  it("validates Australian postal/state consistency", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Macquarie St",
      city: "Sydney",
      state: "NSW",
      postalCode: "2000",
      country: "AU",
    })
    expect(result.status).toBe("valid")
    expect(result.canDirectPay).toBe(true)
  })

  it("warns on Australian postal/state mismatches", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Macquarie St",
      city: "Sydney",
      state: "WA",
      postalCode: "2000",
      country: "AU",
    })
    expect(result.status).toBe("valid")
    expect(result.issues).toEqual([])
    expect(
      result.warnings.some((item) => item.code === "state_postal_mismatch")
    ).toBe(true)
    expect(result.canDirectPay).toBe(true)
  })

  it("splits Australian NSW and ACT postcode ranges for direct payment", () => {
    const sydney = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Macquarie St",
      city: "Sydney",
      state: "NSW",
      postalCode: "2000",
      country: "AU",
    })
    expect(sydney.status).toBe("valid")
    expect(sydney.canDirectPay).toBe(true)

    const canberra = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 London Circuit",
      city: "Canberra",
      state: "ACT",
      postalCode: "2600",
      country: "AU",
    })
    expect(canberra.status).toBe("valid")
    expect(canberra.level).toBe("postal_region_consistent")
    expect(canberra.canDirectPay).toBe(true)

    const sydneyInAct = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Macquarie St",
      city: "Sydney",
      state: "ACT",
      postalCode: "2000",
      country: "AU",
    })
    expect(sydneyInAct.status).toBe("valid")
    expect(
      sydneyInAct.warnings.some((item) => item.code === "state_postal_mismatch")
    ).toBe(true)
    expect(sydneyInAct.canDirectPay).toBe(true)

    const canberraInNsw = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 London Circuit",
      city: "Canberra",
      state: "NSW",
      postalCode: "2600",
      country: "AU",
    })
    expect(canberraInNsw.status).toBe("valid")
    expect(
      canberraInNsw.warnings.some(
        (item) => item.code === "state_postal_mismatch"
      )
    ).toBe(true)
    expect(canberraInNsw.canDirectPay).toBe(true)
  })

  it("validates New Zealand postal/locality basics", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Queen St",
      city: "Auckland",
      postalCode: "1010",
      country: "NZ",
    })
    expect(result.status).toBe("valid")
    expect(result.level).toBe("locality_consistent")
    expect(result.canDirectPay).toBe(true)
  })

  it("allows New Zealand direct payment with a warning when locality evidence is incomplete", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "12 George St",
      city: "Timaru",
      postalCode: "7910",
      country: "NZ",
    })
    expect(result.status).toBe("valid")
    expect(result.canSubmitOrder).toBe(true)
    expect(result.level).toBe("street_plausible")
    expect(
      result.warnings.some((item) => item.code === "validation_incomplete")
    ).toBe(true)
    expect(result.canDirectPay).toBe(true)
  })

  it("accepts accented New Zealand locality text with advisory direct payment", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Massey Rd",
      city: "Māngere",
      state: "Auckland",
      postalCode: "2022",
      country: "NZ",
    })
    expect(result.status).toBe("valid")
    expect(result.canSubmitOrder).toBe(true)
    expect(result.level).toBe("street_plausible")
    expect(
      result.warnings.some((item) => item.code === "validation_incomplete")
    ).toBe(true)
    expect(result.canDirectPay).toBe(true)
  })

  it("rejects invalid email values when provided", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "CA",
      email: "124531451345135",
    })
    expect(result.status).toBe("inconsistent")
    expect(result.issues.some((item) => item.code === "email_format")).toBe(
      true
    )
  })

  it("rejects invalid phone values when provided", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "CA",
      phone: "123",
    })
    expect(result.status).toBe("inconsistent")
    expect(result.issues.some((item) => item.code === "phone_format")).toBe(
      true
    )
    expect(
      result.issues.find((item) => item.code === "phone_format")?.message
    ).toBe(
      "Enter a valid phone number. Use + country code if it differs from the delivery country."
    )
  })

  it("normalizes valid phone values", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "CA",
      phone: "+1 800 555 1234",
    })
    expect(result.status).toBe("valid")
    expect(result.normalized.phone).toBe("+18005551234")
  })

  it("accepts international phone values outside the delivery country", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "CA",
      country: "US",
      phone: "+44 20 7946 0958",
    })
    expect(result.status).toBe("valid")
    expect(result.normalized.phone).toBe("+442079460958")
  })

  it("keeps unprofiled countries direct-payment eligible with a warning", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Teststrasse",
      city: "Berlin",
      postalCode: "10115",
      country: "DE",
    })
    expect(result.status).toBe("unknown")
    expect(result.canSubmitOrder).toBe(true)
    expect(result.canDirectPay).toBe(true)
    expect(
      result.warnings.some((item) => item.code === "unknown_country")
    ).toBe(true)
    expect(isAddressDirectPaymentBlocking(result)).toBe(false)
    expect(isAddressValidityBlocking(result.status)).toBe(false)
  })
})

describe("sanitizePhoneInput", () => {
  it("removes arbitrary pasted letters and keeps international-safe characters", () => {
    expect(sanitizePhoneInput("abc +1 (800) 555-1234 ext nope")).toBe(
      "+1 (800) 555-1234"
    )
  })

  it("allows only a leading plus", () => {
    expect(sanitizePhoneInput("++1+800")).toBe("+1800")
  })
})

describe("normalizeUsState", () => {
  it("maps codes and names", () => {
    expect(normalizeUsState("ca")).toBe("CA")
    expect(normalizeUsState("California")).toBe("CA")
    expect(normalizeUsState("New York")).toBe("NY")
    expect(normalizeUsState("")).toBeNull()
    expect(normalizeUsState("Nowhere")).toBeNull()
  })
})
