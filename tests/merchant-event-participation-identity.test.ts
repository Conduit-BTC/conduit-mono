import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  getProfiles,
  hasProfileContent,
} from "@conduit/core"
import { getMerchantProfileState } from "../apps/merchant/src/lib/event-market-participation-identity"

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
})

describe("merchant event participation identity", () => {
  it("prefers resolved profile content over lookup diagnostics", () => {
    expect(
      getMerchantProfileState({
        hasProfile: true,
        lookupSettled: false,
        error: new Error("relay unavailable"),
      })
    ).toBe("available")
  })

  it("keeps an unresolved lookup visibly loading", () => {
    expect(
      getMerchantProfileState({
        hasProfile: false,
        lookupSettled: false,
        error: null,
      })
    ).toBe("loading")
  })

  it("keeps settled profiles unresolved without absence evidence", () => {
    expect(
      getMerchantProfileState({
        hasProfile: false,
        lookupSettled: true,
        error: null,
      })
    ).toBe("unresolved")
    expect(
      getMerchantProfileState({
        hasProfile: false,
        lookupSettled: true,
        error: new Error("relay unavailable"),
      })
    ).toBe("unavailable")
  })

  it("keeps an empty shared lookup unresolved even when the query succeeds", async () => {
    const merchantPubkey = "a".repeat(64)
    const cachedMerchantPubkey = "b".repeat(64)
    __setRelayListTestOverrides({
      fetchEventsFanout: async () => [],
      loadCached: async () => undefined,
      putCached: async () => {},
    })
    __setCommerceTestOverrides({
      getCachedProducts: async () => [],
      getCachedProfiles: async (pubkeys) =>
        pubkeys.map((pubkey) =>
          pubkey === cachedMerchantPubkey
            ? { pubkey, name: "Known merchant", cachedAt: Date.now() }
            : undefined
        ),
      // Ordinary relay failures resolve to an empty event set, not an Error.
      fetchEventsFanout: async () => [],
    })
    const { data: profiles } = await getProfiles({
      pubkeys: [merchantPubkey, cachedMerchantPubkey],
      priority: "visible",
    })

    // A fulfilled lookup gives useProfiles data without a query error.
    expect(hasProfileContent(profiles[merchantPubkey])).toBe(false)
    expect(
      getMerchantProfileState({
        hasProfile: hasProfileContent(profiles[merchantPubkey]),
        lookupSettled: true,
        error: null,
      })
    ).toBe("unresolved")
    expect(profiles[cachedMerchantPubkey]?.name).toBe("Known merchant")
    expect(
      getMerchantProfileState({
        hasProfile: hasProfileContent(profiles[cachedMerchantPubkey]),
        lookupSettled: true,
        error: null,
      })
    ).toBe("available")
  })
})
