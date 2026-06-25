import { describe, expect, it } from "bun:test"
import {
  ADDRESS_VALIDATION_V1_COUNTRIES,
  isAddressDirectPaymentBlocking,
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

  it("flags the CND-127 example (90210 / Beverly Hills / Texas) as inconsistent", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "Texas",
    })
    expect(result.status).toBe("inconsistent")
    expect(result.issues[0]?.code).toBe("state_postal_mismatch")
    expect(result.canSubmitOrder).toBe(false)
    expect(result.canDirectPay).toBe(false)
    expect(isAddressValidityBlocking(result.status)).toBe(true)
  })

  it("accepts the same ZIP with the correct state", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "CA",
    })
    expect(result.status).toBe("valid")
    expect(result.level).toBe("locality_consistent")
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

  it("requires region for countries whose profiles expect one", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "",
    })
    expect(result.status).toBe("inconsistent")
    expect(result.issues.some((item) => item.code === "region_required")).toBe(
      true
    )
    expect(result.canSubmitOrder).toBe(false)
  })

  it("rejects a known US city/postal mismatch", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      city: "Costa Banana",
      state: "CA",
    })
    expect(result.status).toBe("inconsistent")
    expect(
      result.issues.some((item) => item.code === "city_postal_mismatch")
    ).toBe(true)
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

  it("rejects Canadian postal/province mismatches", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "301 Front St W",
      city: "Toronto",
      state: "BC",
      postalCode: "M5V 2T6",
      country: "CA",
    })
    expect(result.status).toBe("inconsistent")
    expect(
      result.issues.some((item) => item.code === "state_postal_mismatch")
    ).toBe(true)
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

  it("keeps UK addresses without locality evidence on order-first fallback", () => {
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
    expect(result.canDirectPay).toBe(false)
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

  it("rejects Australian postal/state mismatches", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Macquarie St",
      city: "Sydney",
      state: "WA",
      postalCode: "2000",
      country: "AU",
    })
    expect(result.status).toBe("inconsistent")
    expect(
      result.issues.some((item) => item.code === "state_postal_mismatch")
    ).toBe(true)
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

  it("keeps New Zealand addresses without locality evidence on order-first fallback", () => {
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
    expect(result.canDirectPay).toBe(false)
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

  it("keeps unsupported countries on order-first fallback without direct-payment confidence", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Test Rd",
      city: "Testville",
      postalCode: "0000",
      country: "ZZ",
    })
    expect(result.status).toBe("unknown")
    expect(result.canSubmitOrder).toBe(true)
    expect(result.canDirectPay).toBe(false)
    expect(isAddressDirectPaymentBlocking(result)).toBe(true)
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
