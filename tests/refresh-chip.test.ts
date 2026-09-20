import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { prepareProtectedReadRefreshState } from "@conduit/core"
import { RefreshChip } from "../packages/ui/src/components/RefreshChip"
import {
  getRefreshChipDoneTimerDelay,
  resolveRefreshChipPhase,
} from "../packages/ui/src/components/RefreshChipState"

function visibleLabelMarkup(markup: string, label: string): string {
  let index = markup.indexOf(`>${label}<`)
  while (index > 0) {
    const spanStart = markup.lastIndexOf("<span", index)
    const spanMarkup = markup.slice(spanStart, index)
    if (spanMarkup.includes("col-start-1 row-start-1")) return spanMarkup
    index = markup.indexOf(`>${label}<`, index + 1)
  }
  throw new Error(`No stacked phase span found for label: ${label}`)
}

describe("RefreshChip", () => {
  it("renders completion only from an explicit current refresh phase", () => {
    expect(
      resolveRefreshChipPhase({
        phase: "done",
        refreshing: false,
        stale: false,
      })
    ).toBe("done")
    expect(
      resolveRefreshChipPhase({
        phase: "done",
        refreshing: false,
        stale: true,
      })
    ).toBe("idle")
    expect(
      resolveRefreshChipPhase({
        phase: "idle",
        refreshing: false,
        stale: false,
      })
    ).toBe("idle")
  })

  it("leaves completion immediately when data becomes stale", () => {
    expect(
      resolveRefreshChipPhase({
        phase: "done",
        refreshing: false,
        stale: true,
      })
    ).toBe("idle")
    expect(
      resolveRefreshChipPhase({
        phase: "idle",
        refreshing: true,
        stale: true,
      })
    ).toBe("refreshing")
  })

  it("starts the completion interval only after a re-keyed catalog read settles", () => {
    const doneDurationMs = 2_000
    const replacementReadDurationMs = doneDurationMs + 1
    const requestSettledDuringReplacementRead = {
      phase: "done" as const,
      refreshing: true,
      stale: false,
    }

    expect(replacementReadDurationMs).toBeGreaterThan(doneDurationMs)
    expect(resolveRefreshChipPhase(requestSettledDuringReplacementRead)).toBe(
      "refreshing"
    )
    expect(
      getRefreshChipDoneTimerDelay({
        ...requestSettledDuringReplacementRead,
        doneDurationMs,
      })
    ).toBeNull()

    const replacementReadSettled = {
      ...requestSettledDuringReplacementRead,
      refreshing: false,
    }
    expect(resolveRefreshChipPhase(replacementReadSettled)).toBe("done")
    expect(
      getRefreshChipDoneTimerDelay({
        ...replacementReadSettled,
        doneDurationMs,
      })
    ).toBe(doneDurationMs)
  })

  it("only completes when every protected refresh source is current", () => {
    const completed = prepareProtectedReadRefreshState({
      protectedReadState: "complete",
      protectedReadRefreshing: false,
      additionalSources: [{ refreshing: false, stale: false }],
    })
    expect(
      resolveRefreshChipPhase({
        phase: "done",
        ...completed,
      })
    ).toBe("done")

    const localFailure = prepareProtectedReadRefreshState({
      protectedReadState: "complete",
      protectedReadRefreshing: false,
      additionalSources: [{ refreshing: false, stale: true }],
    })
    expect(
      resolveRefreshChipPhase({
        phase: "done",
        ...localFailure,
      })
    ).toBe("idle")

    const paused = prepareProtectedReadRefreshState({
      protectedReadState: "complete",
      protectedReadRefreshing: false,
      protectedReadPaused: true,
    })
    expect(
      resolveRefreshChipPhase({
        phase: "done",
        ...paused,
      })
    ).toBe("idle")
  })

  it("renders an interactive refresh button while idle", () => {
    const markup = renderToStaticMarkup(
      createElement(RefreshChip, {
        refreshing: false,
        onRefresh: async () => {},
      })
    )

    expect(markup).toContain("<button")
    expect(markup).not.toContain('disabled=""')
    expect(markup).toContain('aria-label="Refresh"')
    expect(visibleLabelMarkup(markup, "Refresh")).toContain("opacity-100")
    expect(visibleLabelMarkup(markup, "Refreshing...")).toContain("opacity-0")
    expect(visibleLabelMarkup(markup, "Updated")).toContain("opacity-0")
  })

  it("stays fully opaque and spins while a refresh runs", () => {
    const markup = renderToStaticMarkup(
      createElement(RefreshChip, {
        refreshing: true,
        onRefresh: async () => {},
        refreshingLabel: "Updating listings...",
      })
    )

    // Not disabled: the Button's disabled:opacity-50 fade must not apply
    // while refreshing. The chip reports busy state and ignores clicks.
    expect(markup).not.toContain('disabled=""')
    expect(markup).toContain('aria-label="Updating listings..."')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("animate-spin")
    expect(markup).not.toContain("animate-pulse")
    expect(visibleLabelMarkup(markup, "Updating listings...")).toContain(
      "opacity-100"
    )
    expect(visibleLabelMarkup(markup, "Refresh")).toContain("opacity-0")
  })

  it("keeps stale evidence out of the refresh control", () => {
    const markup = renderToStaticMarkup(
      createElement(RefreshChip, {
        refreshing: false,
        onRefresh: async () => {},
        stale: true,
      })
    )

    expect(markup).toContain('aria-label="Refresh"')
    expect(visibleLabelMarkup(markup, "Refresh")).toContain("opacity-100")
    expect(markup).not.toContain("May be out of date")
    expect(markup).not.toContain("--warning")
    expect(markup).not.toContain('role="status"')
  })

  it("stacks every phase label in one grid cell to stay shift-free", () => {
    const markup = renderToStaticMarkup(
      createElement(RefreshChip, {
        refreshing: false,
        onRefresh: async () => {},
        refreshingLabel: "Refreshing the whole storefront...",
      })
    )

    expect(markup).toContain("inline-grid")
    for (const label of [
      "Refresh",
      "Refreshing the whole storefront...",
      "Updated",
    ]) {
      expect(visibleLabelMarkup(markup, label)).toContain(
        "col-start-1 row-start-1"
      )
    }
  })

  it("is the shared refresh control on Market and Merchant data surfaces", async () => {
    const surfaces = [
      "apps/market/src/routes/products/index.tsx",
      "apps/market/src/routes/products/$productId.tsx",
      "apps/market/src/routes/store/$pubkey.tsx",
      "apps/market/src/routes/orders.tsx",
      "apps/merchant/src/routes/products.tsx",
      "apps/merchant/src/routes/orders.tsx",
    ]
    for (const surface of surfaces) {
      const source = await readFile(surface, "utf8")
      expect(source).toContain("RefreshChip")
      expect(source).not.toContain("FreshnessChip")
    }
  })

  it("requires explicit refreshes to settle after their backing reads", async () => {
    const [chipSource, progressiveSource] = await Promise.all([
      readFile("packages/ui/src/components/RefreshChip.tsx", "utf8"),
      readFile("apps/market/src/hooks/useProgressiveProducts.ts", "utf8"),
    ])

    expect(chipSource).toContain("onRefresh: () => Promise<unknown>")
    expect(chipSource).not.toContain("if (!refreshResult)")
    expect(
      progressiveSource.match(/refetch: \(\) => Promise<void>/g)
    ).toHaveLength(2)
    expect(progressiveSource).toContain("waitForNextProgressiveRead()")
    expect(progressiveSource).toContain(
      "settleProgressiveRefreshes(discoveryKey)"
    )
    expect(progressiveSource).toContain(
      "await Promise.all([refetchCachedDetail(), refetchNetworkDetail()])"
    )
  })

  it("keeps empty Market surfaces visibly busy during refresh", async () => {
    const browseModelSource = await readFile(
      "apps/market/src/hooks/useMarketBrowseModel.ts",
      "utf8"
    )
    const detailSource = await readFile(
      "apps/market/src/routes/products/$productId.tsx",
      "utf8"
    )
    const storefrontSource = await readFile(
      "apps/market/src/routes/store/$pubkey.tsx",
      "utf8"
    )

    expect(detailSource).toContain(
      "const productRefreshing = productQuery.isHydrating"
    )
    expect(detailSource).not.toContain(
      "const productRefreshing = !!product && productQuery.isHydrating"
    )
    expect(storefrontSource).toContain("refreshing={productsQuery.isHydrating}")
    expect(storefrontSource).not.toContain(
      "productsQuery.isHydrating && filteredProducts.length > 0"
    )
    expect(browseModelSource).toContain(
      "isUpdatingListings: preparedProductsQuery.isHydrating"
    )
    expect(browseModelSource).not.toContain(
      "!preparedProductsQuery.isInitialLoading &&"
    )
  })

  it("keeps Market route refresh controls at the shared small-button height", async () => {
    const detailSource = await readFile(
      "apps/market/src/routes/products/$productId.tsx",
      "utf8"
    )
    const ordersSource = await readFile(
      "apps/market/src/routes/orders.tsx",
      "utf8"
    )

    expect(detailSource).toContain(
      'className="relative grid min-h-8 gap-2 text-sm text-[var(--text-secondary)] sm:block"'
    )
    expect(detailSource).not.toContain(
      'className="relative grid min-h-7 gap-2 text-sm text-[var(--text-secondary)] sm:block"'
    )
    const ordersRefreshChip =
      ordersSource.match(/<RefreshChip[\s\S]*?\/>/)?.[0] ?? ""
    expect(ordersRefreshChip).toContain("doneDurationMs={900}")
    expect(ordersRefreshChip).not.toContain("h-11")
  })

  it("keeps incomplete product reads out of the Updated phase", async () => {
    const detailSource = await readFile(
      "apps/market/src/routes/products/$productId.tsx",
      "utf8"
    )
    const storefrontSource = await readFile(
      "apps/market/src/routes/store/$pubkey.tsx",
      "utf8"
    )
    const merchantProductsSource = await readFile(
      "apps/merchant/src/routes/products.tsx",
      "utf8"
    )

    expect(detailSource).toContain("stale={productReadIncomplete}")
    expect(storefrontSource).toContain("stale={productReadIncomplete}")
    expect(merchantProductsSource).toContain(
      "stale={merchantProductReadIncomplete}"
    )
    for (const source of [
      detailSource,
      storefrontSource,
      merchantProductsSource,
    ]) {
      expect(source).toContain("isCommerceReadIncomplete")
    }
  })

  it("keeps incomplete order reads out of the Updated phase", async () => {
    const marketOrdersSource = await readFile(
      "apps/market/src/routes/orders.tsx",
      "utf8"
    )
    const merchantOrdersSource = await readFile(
      "apps/merchant/src/routes/orders.tsx",
      "utf8"
    )

    expect(marketOrdersSource).toContain("const ordersRefreshState =")
    expect(marketOrdersSource).toContain("prepareProtectedReadRefreshState({")
    expect(marketOrdersSource).toContain(
      "protectedReadPaused: messagesQuery.isPaused"
    )
    expect(marketOrdersSource).toContain(
      "lifecyclesQuery.isError || lifecyclesQuery.isPaused"
    )
    expect(marketOrdersSource).toContain(
      "refreshing={ordersRefreshState.refreshing}"
    )
    expect(marketOrdersSource).toContain("stale={ordersRefreshState.stale}")

    expect(merchantOrdersSource).toContain(
      "const ordersRefreshState = prepareProtectedReadRefreshState({"
    )
    expect(merchantOrdersSource).toContain("protectedOrdersReadState")
    expect(merchantOrdersSource).toContain(
      "protectedReadPaused: ordersQuery.isPaused"
    )
    expect(merchantOrdersSource).toContain(
      "refreshing={ordersRefreshState.refreshing}"
    )
    expect(merchantOrdersSource).toContain("stale={ordersRefreshState.stale}")
  })

  it("keeps paused product refreshes out of the Updated phase", async () => {
    const progressiveSource = await readFile(
      "apps/market/src/hooks/useProgressiveProducts.ts",
      "utf8"
    )
    const browseSource = await readFile(
      "apps/market/src/hooks/useMarketBrowseModel.ts",
      "utf8"
    )
    const detailSource = await readFile(
      "apps/market/src/routes/products/$productId.tsx",
      "utf8"
    )
    const storefrontSource = await readFile(
      "apps/market/src/routes/store/$pubkey.tsx",
      "utf8"
    )
    const merchantProductsSource = await readFile(
      "apps/merchant/src/routes/products.tsx",
      "utf8"
    )

    expect(progressiveSource).toContain("isRefreshPaused")
    expect(progressiveSource).toContain("firstDegreeQuery.isPaused")
    expect(progressiveSource).toContain("firstNetworkQuery.isPaused")
    expect(progressiveSource).toContain("networkQuery.isPaused")
    expect(progressiveSource).toContain("firstDegreeQuery.isPending")
    expect(progressiveSource).toContain("cachedQuery.isPending")
    expect(progressiveSource).toContain("firstNetworkQuery.isPending")
    expect(browseSource).toContain(
      "catalogPaused: productsQuery.isRefreshPaused"
    )
    expect(browseSource).toContain(
      "globalSearchPaused: globalSearchQuery.isPaused"
    )
    expect(browseSource).toContain("globalSearchQuery.isPending")
    expect(detailSource).toContain("productQuery.isRefreshPaused")
    expect(storefrontSource).toContain("productsQuery.isRefreshPaused")
    expect(merchantProductsSource).toContain("productsQuery.isPaused")
    expect(merchantProductsSource).toContain(
      "productsQuery.isPending && cachedProductsQuery.isPending"
    )
  })
})
