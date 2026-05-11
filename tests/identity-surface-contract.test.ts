import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("identity surface contracts", () => {
  it("keeps Market store labels skeletal while profile lookups are unresolved", async () => {
    const expectations = {
      "apps/market/src/components/ProductGridCard.tsx": [
        "merchantNamePending",
        "getPendingMerchantDisplayName",
      ],
      "apps/market/src/hooks/useMerchantIdentities.ts": [
        "useProfiles(visibleMerchantPubkeys",
        "useProfiles(backgroundMerchantPubkeys",
        "refetchUnresolvedMs: 5_000",
        "refetchUnresolvedMs: 12_000",
      ],
      "apps/market/src/lib/marketBrowseModel.ts": [
        "getProfileName(profile)",
        'status: profileName ? "resolved" : "pending"',
        "getPendingMerchantName(pubkey)",
      ],
      "apps/market/src/routes/products/$productId.tsx": [
        "merchantIdentityPending",
        "getPendingMerchantDisplayName",
        "relayHints:",
      ],
      "apps/market/src/routes/products/index.tsx": [
        "useMarketBrowseModel",
        "getMerchantIdentity",
        'merchant.status === "pending"',
      ],
      "apps/market/src/routes/store/$pubkey.tsx": [
        "merchantIdentityPending",
        "useProfile(pubkey",
        "relayHints:",
        "getProfileName(profile)",
      ],
      "apps/merchant/src/routes/orders.tsx": [
        "useProfiles(buyerPubkeys",
        "refetchUnresolvedMs: 12_000",
      ],
    }

    for (const [file, snippets] of Object.entries(expectations)) {
      const content = await readFile(file, "utf8")
      for (const snippet of snippets) {
        expect(content).toContain(snippet)
      }
      expect(content).not.toContain('pendingLabel: "Loading store"')
    }

    const productGridCard = await readFile(
      "apps/market/src/components/ProductGridCard.tsx",
      "utf8"
    )
    expect(productGridCard).not.toContain("useProfile(")
    expect(productGridCard).not.toContain("getProfileName(")
  })

  it("keeps Merchant readiness on the session-owned relay scope", async () => {
    const content = await readFile(
      "apps/merchant/src/hooks/useMerchantReadiness.ts",
      "utf8"
    )

    expect(content).toContain("useConduitSession")
    expect(content).toContain("useRelaySettings(session.relayScope")
    expect(content).toContain("pubkey,")
    expect(content).toContain("bootstrapRelayList: false")
  })
})
