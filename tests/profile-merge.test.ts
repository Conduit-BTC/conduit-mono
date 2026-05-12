import { describe, expect, it } from "bun:test"
import { mergeRicherProfiles } from "@conduit/core"

describe("profile merge", () => {
  it("does not let bare pubkey profiles erase loaded merchant names", () => {
    const merged = mergeRicherProfiles(
      {
        merchant: {
          pubkey: "merchant",
          displayName: "Loaded Merchant",
          picture: "https://example.com/avatar.png",
        },
      },
      {
        merchant: { pubkey: "merchant" },
      }
    )

    expect(merged.merchant?.displayName).toBe("Loaded Merchant")
    expect(merged.merchant?.picture).toBe("https://example.com/avatar.png")
  })

  it("allows richer profile data to replace a bare profile", () => {
    const merged = mergeRicherProfiles(
      {
        merchant: { pubkey: "merchant" },
      },
      {
        merchant: {
          pubkey: "merchant",
          name: "loaded",
        },
      }
    )

    expect(merged.merchant?.name).toBe("loaded")
  })

  it("lets newer valid fields enrich existing profile data without blanking names", () => {
    const merged = mergeRicherProfiles(
      {
        merchant: {
          pubkey: "merchant",
          displayName: "Loaded Merchant",
          picture: "https://example.com/avatar.png",
        },
      },
      {
        merchant: {
          pubkey: "merchant",
          about: "Updated bio",
          picture: "",
        },
      }
    )

    expect(merged.merchant?.displayName).toBe("Loaded Merchant")
    expect(merged.merchant?.picture).toBe("https://example.com/avatar.png")
    expect(merged.merchant?.about).toBe("Updated bio")
  })
})
