import { describe, expect, it } from "bun:test"
import {
  addSupplierPercentage,
  getSupplierPercentage,
  getMerchantPercentage,
  removeSupplierPercentage,
  setSupplierPercentage,
} from "../apps/merchant/src/lib/productSupplierPercentages"
import {
  validateMerchantProductSupplierAllocationForm,
  type MerchantProductSupplierAllocationFormChange,
} from "../apps/merchant/src/lib/productForm"
import { getPublicKey } from "nostr-tools/pure"

const merchant = getPublicKey(new Uint8Array(32).fill(1))
const supplier = getPublicKey(new Uint8Array(32).fill(2))
function initial(): MerchantProductSupplierAllocationFormChange {
  return {
    enabled: true,
    merchantWeight: "3",
    merchantRelayHint: "",
    suppliers: [{ identity: supplier, relayHint: "", weight: "1" }],
  }
}
function validate(value: MerchantProductSupplierAllocationFormChange) {
  return validateMerchantProductSupplierAllocationForm(
    {
      supplierAllocationEnabled: value.enabled,
      merchantAllocationWeight: value.merchantWeight,
      merchantAllocationRelayHint: value.merchantRelayHint,
      supplierAllocations: value.suppliers,
    },
    merchant
  )
}

describe("supplier percentage authoring", () => {
  it("renders existing 3:1 terms as 75/25 without rewriting weights", () => {
    const value = initial()
    const before = structuredClone(value)
    expect(getSupplierPercentage(value, 0)).toBe("25")
    expect(getMerchantPercentage(value)).toBe("75")
    expect(value).toEqual(before)
    expect(validate(value).canPublish).toBe(true)
  })

  it("sets an exact percentage with merchant remainder and retains other repeating ratios", () => {
    const value = {
      ...initial(),
      merchantWeight: "1",
      suppliers: [
        { ...initial().suppliers[0]!, weight: "1" },
        { identity: "other", relayHint: "", weight: "1" },
      ],
    }
    const next = setSupplierPercentage(value, 0, "25")
    expect([
      next.merchantWeight,
      ...next.suppliers.map((row) => row.weight),
    ]).toEqual(["5", "3", "4"])
    expect(BigInt(next.suppliers[1]!.weight) * 3n).toBe(
      BigInt(next.merchantWeight) +
        next.suppliers.reduce((sum, row) => sum + BigInt(row.weight), 0n)
    )
    expect(getSupplierPercentage(next, 1)).toBe("33.33")
    expect(value.merchantWeight).toBe("1")
  })

  it("rejects blank, excessive precision, zero, and oversubscribed drafts without changing the prior weights", () => {
    for (const input of ["", ".", "1e2", "25.001", "0", "100", "101", "-5"]) {
      const next = setSupplierPercentage(initial(), 0, input)
      expect(next.suppliers[0]!.percentageInput).toBe(input)
      expect(next.suppliers[0]!.percentageError).toBeDefined()
      expect(next.suppliers[0]!.weight).toBe("1")
      expect(validate(next).canPublish).toBe(false)
    }
    const value = {
      ...initial(),
      merchantWeight: "1",
      suppliers: [
        { ...initial().suppliers[0]!, weight: "1" },
        { identity: "other", relayHint: "", weight: "2" },
      ],
    }
    expect(
      setSupplierPercentage(value, 0, "50").suppliers[0]!.percentageError
    ).toContain("leave a share")
  })

  it("accepts hundredths and can repair an unfinished input", () => {
    const invalid = setSupplierPercentage(initial(), 0, "12.")
    expect(validate(invalid).canPublish).toBe(false)
    const next = setSupplierPercentage(invalid, 0, "12.25")
    expect(next.merchantWeight).toBe("351")
    expect(next.suppliers[0]!.weight).toBe("49")
    expect(validate(next).canPublish).toBe(true)
  })

  it("adds from the merchant share and returns a removed share only to the merchant", () => {
    const value = initial()
    const added = addSupplierPercentage(value)
    expect(getSupplierPercentage(added, 0)).toBe("25")
    expect(getSupplierPercentage(added, 1)).toBe("25")
    expect(getMerchantPercentage(added)).toBe("50")
    const removed = removeSupplierPercentage(added, 1)
    expect(removed).toEqual(value)
    const thin = {
      ...initial(),
      merchantWeight: "1",
      suppliers: [{ ...initial().suppliers[0]!, weight: "99" }],
    }
    const half = addSupplierPercentage(thin)
    expect(getMerchantPercentage(half)).toBe("0.5")
    expect(getSupplierPercentage(half, 0)).toBe("99")
    expect(getSupplierPercentage(half, 1)).toBe("0.5")
  })

  it("preserves an untouched uncommon ratio and blocks unsafe integer growth", () => {
    const value = {
      ...initial(),
      merchantWeight: "1",
      suppliers: [{ ...initial().suppliers[0]!, weight: "6" }],
    }
    expect(getSupplierPercentage(value, 0)).toBe("85.71")
    expect(
      validate(value).allocation?.recipients.map((row) => row.weight)
    ).toEqual([1, 6])
    const huge = {
      ...initial(),
      merchantWeight: "4000000000000001",
      suppliers: [
        { ...initial().suppliers[0]!, weight: "1" },
        { identity: "other", relayHint: "", weight: "1" },
      ],
    }
    const next = setSupplierPercentage(huge, 0, "25")
    expect(next.suppliers[0]!.percentageError).toContain("preserve")
    expect(next.merchantWeight).toBe(huge.merchantWeight)
  })
})
