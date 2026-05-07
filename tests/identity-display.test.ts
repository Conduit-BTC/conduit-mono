import { describe, expect, it } from "bun:test"
import { getProfileDisplayLabel, getProfileName } from "@conduit/core"

describe("profile display labels", () => {
  it("prefers display names and plain names before any fallback", () => {
    expect(
      getProfileName({
        pubkey: "alice",
        displayName: "Alice Store",
        name: "alice",
      })
    ).toBe("Alice Store")

    expect(
      getProfileName({
        pubkey: "alice",
        name: "alice",
      })
    ).toBe("alice")
  })

  it("keeps pubkey fallback out of unresolved identity surfaces", () => {
    expect(
      getProfileDisplayLabel(undefined, "a".repeat(64), {
        lookupSettled: false,
        pendingLabel: "Loading store",
      })
    ).toBe("Loading store")
  })

  it("uses a shortened pubkey only after lookup settles empty", () => {
    const label = getProfileDisplayLabel(undefined, "a".repeat(64), {
      lookupSettled: true,
      emptyPrefix: "Store",
      chars: 6,
    })

    expect(label.startsWith("Store npub1")).toBe(true)
  })
})
