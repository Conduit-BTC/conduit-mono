import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("identity surface contracts", () => {
  it("keeps Market store labels pending while profile lookups are unresolved", async () => {
    const expectations = {
      "apps/market/src/components/ProductGridCard.tsx": [
        "lookupSettled: !profileQuery.isPlaceholderData",
        'pendingLabel: "Loading store"',
      ],
      "apps/market/src/routes/products/$productId.tsx": [
        "lookupSettled: !merchantProfile.isPlaceholderData",
        'pendingLabel: "Loading store"',
      ],
      "apps/market/src/routes/products/index.tsx": [
        "!visibleMerchantPubkeys.includes(merchantPubkey)",
        "visibleIdentityReady",
        'pendingLabel: "Loading store"',
      ],
      "apps/market/src/routes/store/$pubkey.tsx": [
        "lookupSettled: !profileQuery.isPlaceholderData",
        'pendingLabel: "Loading store"',
      ],
    }

    for (const [file, snippets] of Object.entries(expectations)) {
      const content = await readFile(file, "utf8")
      for (const snippet of snippets) {
        expect(content).toContain(snippet)
      }
      expect(content).not.toContain("lookupSettled: true")
    }
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
