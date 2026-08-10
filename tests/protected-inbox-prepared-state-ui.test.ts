import { describe, expect, it } from "bun:test"
import {
  deriveProtectedReadPresentationState,
  selectProtectedReadRows,
} from "@conduit/core"

async function source(path: string): Promise<string> {
  return Bun.file(path).text()
}

describe("protected inbox prepared state", () => {
  it("uses route-local cache only until the live result resolves", () => {
    const cachedRows = [{ id: "cached" }]
    const liveRows = [{ id: "live" }]
    const liveEmpty: typeof liveRows = []

    expect(selectProtectedReadRows(undefined, cachedRows)).toBe(cachedRows)
    expect(selectProtectedReadRows(liveRows, cachedRows)).toBe(liveRows)
    expect(selectProtectedReadRows(liveEmpty, cachedRows)).toBe(liveEmpty)
    expect(selectProtectedReadRows(undefined, undefined)).toEqual([])
  })

  it("distinguishes pending, authoritative empty, partial, unavailable, and cache", () => {
    expect(
      deriveProtectedReadPresentationState({
        visibleCount: 0,
        pending: true,
      })
    ).toBe("pending")
    expect(
      deriveProtectedReadPresentationState({
        visibleCount: 0,
        meta: { inbox: { coverage: "complete" } },
      })
    ).toBe("complete")
    expect(
      deriveProtectedReadPresentationState({
        visibleCount: 0,
        meta: { degraded: true, inbox: { coverage: "partial" } },
      })
    ).toBe("partial")
    expect(
      deriveProtectedReadPresentationState({
        visibleCount: 0,
        meta: { inbox: { coverage: "unavailable" } },
      })
    ).not.toBe("complete")
    expect(
      deriveProtectedReadPresentationState({
        visibleCount: 0,
        meta: {
          source: "local_cache",
          stale: true,
          degraded: true,
          inbox: { coverage: "unavailable" },
        },
      })
    ).toBe("unavailable")
    expect(
      deriveProtectedReadPresentationState({
        visibleCount: 2,
        meta: {
          source: "local_cache",
          stale: true,
          inbox: { coverage: "unavailable" },
        },
      })
    ).toBe("cached")
  })

  it("wires the shared state into every Market and Merchant protected surface", async () => {
    const sources = await Promise.all(
      [
        "apps/market/src/routes/messages.tsx",
        "apps/market/src/routes/orders.tsx",
        "apps/merchant/src/routes/messages.tsx",
        "apps/merchant/src/routes/orders.tsx",
        "apps/merchant/src/routes/index.tsx",
      ].map(source)
    )

    const expectedSelectorCounts = [2, 1, 2, 1, 1]
    for (const [index, text] of sources.entries()) {
      expect(text).toContain("deriveProtectedReadPresentationState")
      expect(text).toContain("pending:")
      expect(text.match(/selectProtectedReadRows\(/g)?.length).toBe(
        expectedSelectorCounts[index]
      )
      expect(text).not.toMatch(/data\?\.data\.length\s*\?/)
    }
    expect(sources[3]).toContain("protectedOrderCountsUnavailable")
    expect(sources[3]).toContain(
      'conversations.length === 0 && protectedOrdersReadState !== "complete"'
    )
    expect(sources[3]).toContain('? "—"')
    expect(sources[4]).toContain(
      'const signerConnected = status === "connected" && !!pubkey'
    )
    expect(sources[4].match(/enabled: signerConnected/g)?.length).toBe(5)
    expect(sources[4]).toContain("if (!signerConnected) return []")
  })

  it("passes current-session authentication evidence in both network routes", async () => {
    const [market, merchant] = await Promise.all([
      source("apps/market/src/routes/network.tsx"),
      source("apps/merchant/src/routes/network.tsx"),
    ])

    expect(market).toContain(
      "authEvidenceByUrl={relaySettings.authEvidenceByUrl}"
    )
    expect(merchant).toContain(
      "authEvidenceByUrl={relaySettings.authEvidenceByUrl}"
    )
  })
})
