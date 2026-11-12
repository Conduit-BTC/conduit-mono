import { expect, test } from "bun:test"
import { createRequire } from "node:module"
const { QueryClient } = createRequire(
  new URL("../apps/market/package.json", import.meta.url)
)("@tanstack/react-query")
import { config } from "../packages/core/src/config"
import { getProductCatalogQueryKey } from "../apps/market/src/lib/productCatalogRead"
import { getGlobalProductSearchQueryKey } from "../apps/market/src/lib/marketBrowseModel"

test("public catalog freshness cannot reuse an evidence query or an old configured feed", () => {
  const original = config.commerceDiscoveryRelayUrls
  const originalApp = config.appCommerceRelayUrls
  const client = new QueryClient()
  try {
    config.appCommerceRelayUrls = [
      "wss://first.feed.test",
      "wss://second.feed.test",
    ]
    config.commerceDiscoveryRelayUrls = ["wss://first.feed.test"]
    const input = { scope: "storefront" as const, merchantPubkey: "merchant" }
    const evidenceKey = getProductCatalogQueryKey(input, "network")
    const feedKey = getProductCatalogQueryKey(
      { ...input, readScope: "public_feed" },
      "network"
    )
    client.setQueryData(evidenceKey, "evidence")
    expect(client.getQueryData(feedKey)).toBeUndefined()
    client.setQueryData(feedKey, "first feed")
    config.commerceDiscoveryRelayUrls = ["wss://second.feed.test"]
    const changedFeedKey = getProductCatalogQueryKey(
      { ...input, readScope: "public_feed" },
      "network"
    )
    expect(client.getQueryData(changedFeedKey)).toBeUndefined()
  } finally {
    config.commerceDiscoveryRelayUrls = original
    config.appCommerceRelayUrls = originalApp
    client.clear()
  }
})

test("pure marketplace and ranked-search keys use their effective feed purpose when omitted", () => {
  const client = new QueryClient()
  const input = {
    query: "coffee",
    pubkey: null,
    catalogSource: "conduit" as const,
    anonymous: true,
    authorPubkeys: ["merchant"],
  }
  client.setQueryData(getGlobalProductSearchQueryKey(input), "feed search")
  expect(
    client.getQueryData(
      getGlobalProductSearchQueryKey({
        ...input,
        readScope: "public_feed",
      })
    )
  ).toBe("feed search")
  expect(
    getProductCatalogQueryKey({ scope: "marketplace" }, "network")
  ).toEqual(
    getProductCatalogQueryKey(
      { scope: "marketplace", readScope: "public_feed" },
      "network"
    )
  )
  client.clear()
})
