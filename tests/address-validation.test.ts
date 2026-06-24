import { describe, expect, it } from "bun:test"
import {
  isAddressValidityBlocking,
  normalizeUsState,
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
  it("flags the CND-127 example (90210 / Beverly Hills / Texas) as inconsistent", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "Texas",
    })
    expect(result.status).toBe("inconsistent")
    expect(result.issues[0]?.code).toBe("state_postal_mismatch")
    expect(isAddressValidityBlocking(result.status)).toBe(true)
  })

  it("accepts the same ZIP with the correct state", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "CA",
    })
    expect(result.status).toBe("valid")
    expect(isAddressValidityBlocking(result.status)).toBe(false)
  })

  it("accepts the full state name spelled out", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "California",
    })
    expect(result.status).toBe("valid")
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

  it("returns unknown for US when the state is absent (cannot confirm)", () => {
    const result = validateAddressConsistency({
      ...beverlyHills,
      state: "",
    })
    expect(result.status).toBe("unknown")
    expect(isAddressValidityBlocking(result.status)).toBe(false)
  })

  it("validates a well-formed non-US address structurally", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "10 Downing St",
      city: "London",
      postalCode: "SW1A 2AA",
      country: "GB",
    })
    expect(result.status).toBe("valid")
  })

  it("does not block a country without offline data", () => {
    const result = validateAddressConsistency({
      name: "Jane Doe",
      street: "1 Test Rd",
      city: "Testville",
      postalCode: "0000",
      country: "ZZ",
    })
    expect(result.status).toBe("unknown")
    expect(isAddressValidityBlocking(result.status)).toBe(false)
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
