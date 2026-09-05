import { describe, expect, it } from "bun:test"
import {
  deriveProtectedReadPresentationState,
  prepareProtectedReadRefreshState,
  selectProtectedReadRows,
} from "@conduit/core"
import { getDirectMessageSearchEmptyCopy } from "../apps/market/src/lib/protected-read-copy"

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

  it("keeps a settled empty cache pending while the live read is staggered", () => {
    const rows = selectProtectedReadRows<{ id: string }>(undefined, [])
    expect(
      deriveProtectedReadPresentationState({
        visibleCount: rows.length,
        pending: true,
      })
    ).toBe("pending")
  })

  it("never presents incomplete direct-message results as no matches", () => {
    expect(getDirectMessageSearchEmptyCopy("pending")).toBe(
      "Loading conversations…"
    )
    expect(getDirectMessageSearchEmptyCopy("complete")).toBe(
      "No conversations match your search."
    )
    for (const state of ["cached", "partial", "unavailable"] as const) {
      expect(getDirectMessageSearchEmptyCopy(state)).toContain("incomplete")
    }
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

  it("prepares truthful refresh state across protected and local sources", () => {
    expect(
      prepareProtectedReadRefreshState({
        protectedReadState: "complete",
        protectedReadRefreshing: false,
      })
    ).toEqual({ refreshing: false, stale: false })
    expect(
      prepareProtectedReadRefreshState({
        protectedReadState: "complete",
        protectedReadRefreshing: true,
      })
    ).toEqual({ refreshing: true, stale: false })
    expect(
      prepareProtectedReadRefreshState({
        protectedReadState: "complete",
        protectedReadRefreshing: false,
        protectedReadPaused: true,
      })
    ).toEqual({ refreshing: false, stale: true })

    for (const protectedReadState of [
      "pending",
      "cached",
      "partial",
      "unavailable",
    ] as const) {
      expect(
        prepareProtectedReadRefreshState({
          protectedReadState,
          protectedReadRefreshing: false,
        })
      ).toEqual({ refreshing: false, stale: true })
    }

    expect(
      prepareProtectedReadRefreshState({
        protectedReadState: "complete",
        protectedReadRefreshing: false,
        additionalSources: [{ refreshing: true, stale: false }],
      })
    ).toEqual({ refreshing: true, stale: false })
    expect(
      prepareProtectedReadRefreshState({
        protectedReadState: "complete",
        protectedReadRefreshing: false,
        additionalSources: [
          { refreshing: false, stale: true },
          { refreshing: false, stale: false },
        ],
      })
    ).toEqual({ refreshing: false, stale: true })
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
    expect(sources[0]).toContain("directMessageListPending")
    expect(sources[0].match(/\{directMessageSearchEmptyCopy\}/g)?.length).toBe(
      3
    )
    expect(sources[0]).toContain('directMessagesReadState === "complete"')
    expect(sources[0]).not.toContain(
      "dmsCacheQuery.isLoading &&\n            dmsLiveQuery.isLoading"
    )
    expect(sources[2]).toContain('relatedOrdersReadState === "pending"')
    expect(sources[2]).toContain('relatedOrdersReadState === "complete"')
    expect(sources[2]).not.toContain(
      "relatedOrdersLiveQuery.isLoading &&\n                  relatedOrdersCacheQuery.isLoading"
    )
  })

  it("passes current-session authentication evidence in both network routes", async () => {
    const [market, merchant, controller] = await Promise.all([
      source("apps/market/src/routes/network.tsx"),
      source("apps/merchant/src/routes/network.tsx"),
      source("packages/core/src/hooks/useAccountNetworkSettings.ts"),
    ])

    expect(market).toContain("useAccountNetworkSettings()")
    expect(merchant).toContain("useAccountNetworkSettings()")
    expect(controller).toContain("subscribeRelayAuthenticationEvidence")
    expect(controller).toContain(
      "getRelayAuthenticationEvidence(url, auth.pubkey!)"
    )
    expect(controller).toContain(
      "[auth.pubkey, auth.authGeneration, session.relayScope]"
    )
  })
})
