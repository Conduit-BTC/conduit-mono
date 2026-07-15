import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("Market zapouts route contract", () => {
  it("renders a public feed from marked NIP-57 receipts", async () => {
    const route = await readFile("apps/market/src/routes/zapouts.tsx", "utf8")

    expect(route).toContain('createFileRoute("/zapouts")')
    expect(route).toContain("EVENT_KINDS.ZAP_RECEIPT")
    expect(route).toContain("fetchEventsFanoutDetailed")
    expect(route).toContain('fetch("/api/anon-zap-config"')
    expect(route).toContain("config.zapRelayUrls")
    expect(route).toContain("parseOmfZapoutReceipt")
    expect(route).toContain('fetch("/api/zapout-authority"')
    expect(route).toContain("ZAPOUT_FEED_AUTHORITY_BATCH_SIZE")
    expect(route).toContain("verified.length < ZAPOUT_FEED_RENDER_LIMIT")
    expect(route).toContain(
      "(b.receipt.createdAt ?? 0) - (a.receipt.createdAt ?? 0)"
    )
    expect(route).toContain("ZAPOUT_FEED_MAX_AUTHORITY_CANDIDATES")
    expect(route).toContain("ZAPOUT_FEED_AUTHORITY_OVERALL_TIMEOUT_MS")
    expect(route).toContain("ZAPOUT_FEED_MAX_RELAYS")
    expect(route).toContain("authorityUnavailableCount")
    expect(route).toContain("Zapout verification unavailable")
    expect(route).not.toContain("fetchLnurlPayMetadata")
    expect(route).not.toContain("getProfiles({")
    expect(route).toContain("skipHealthFilter: true")
    expect(route).toContain(
      "const anonZapSignerPubkey = normalizePubkey(config.anonZapSignerPubkey)"
    )
    expect(route).toContain('"#P": [anonZapSignerPubkey]')
    expect(route).toContain("ZAPOUT_FEED_MAX_PAGES")
    expect(route).toContain("since: oldestCreatedAt")
    expect(route).toContain("until:")
    expect(route).toContain("paginationIncomplete = true")
    expect(route).toContain("fetchOmfZapoutsFromRelay")
    expect(route).toContain("Feed coverage is partial")
    expect(route).toContain("refetchOnWindowFocus: true")
    expect(route).not.toContain("requireAuth")
  })

  it("does not render private checkout fields in the public feed route", async () => {
    const route = await readFile("apps/market/src/routes/zapouts.tsx", "utf8")

    expect(route).not.toContain("orderId")
    expect(route).not.toContain("shipping")
    expect(route).not.toContain("fulfillment")
    expect(route).not.toContain("nwc")
  })

  it("registers the page title in the Market shell", async () => {
    const root = await readFile("apps/market/src/routes/__root.tsx", "utf8")

    expect(root).toContain('pathname === "/zapouts"')
    expect(root).toContain('return "Zapouts"')
  })
})
