import { describe, expect, it } from "bun:test"
import {
  QueryClient,
  QueryObserver,
  focusManager,
  onlineManager,
} from "@tanstack/react-query"
import {
  isRemoteMarketSearchEligible,
  MARKET_SEARCH_QUERY_POLICY,
} from "../src/lib/searchPolicy"
import { getGlobalProductSearchQueryKey } from "../src/lib/marketBrowseModel"

describe("Market remote search policy", () => {
  it("keeps blank and one-character input local until two characters", async () => {
    const client = new QueryClient()
    let requests = 0
    const options = (query: string) => ({
      ...MARKET_SEARCH_QUERY_POLICY,
      queryKey: ["search", query],
      queryFn: async () => ++requests,
      enabled: isRemoteMarketSearchEligible(query),
    })
    const observer = new QueryObserver(client, options(" "))
    const unsubscribe = observer.subscribe(() => {})
    try {
      observer.setOptions(options(" a "))
      await Bun.sleep(10)
      expect(requests).toBe(0)
      observer.setOptions(options(" ab "))
      await Bun.sleep(10)
      expect(requests).toBe(1)
      expect(observer.getCurrentResult().data).toBe(1)
    } finally {
      unsubscribe()
      client.clear()
    }
  })

  it("does not retry a rejected search even when client defaults retry", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 3, retryDelay: 1 } },
    })
    let requests = 0
    const observer = new QueryObserver(client, {
      ...MARKET_SEARCH_QUERY_POLICY,
      queryKey: ["rejected-search"],
      queryFn: async () => {
        requests++
        throw new Error("Search is unavailable")
      },
    })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await Bun.sleep(30)
      expect(requests).toBe(1)
      expect(observer.getCurrentResult().isError).toBe(true)
      await observer.refetch()
      expect(requests).toBe(2)
    } finally {
      unsubscribe()
      client.clear()
    }
  })

  it("reuses ranked results when the browse view changes merchant or category facets", async () => {
    const client = new QueryClient()
    let requests = 0
    const browse = {
      query: "books",
      pubkey: "viewer",
      catalogSource: "following" as const,
      anonymous: false,
      authorPubkeys: ["merchant-a", "merchant-b"],
      merchants: [] as string[],
      tags: [] as string[],
    }
    const options = () => ({
      ...MARKET_SEARCH_QUERY_POLICY,
      queryKey: getGlobalProductSearchQueryKey(browse),
      queryFn: async () => ++requests,
      staleTime: 20_000,
    })
    const observer = new QueryObserver(client, options())
    const unsubscribe = observer.subscribe(() => {})
    try {
      await Bun.sleep(10)
      browse.merchants = ["merchant-a"]
      browse.tags = ["fiction"]
      observer.setOptions(options())
      await Bun.sleep(10)
      expect(requests).toBe(1)
      expect(observer.getCurrentResult().data).toBe(1)
      browse.query = "novels"
      observer.setOptions(options())
      await Bun.sleep(10)
      expect(requests).toBe(2)
    } finally {
      unsubscribe()
      client.clear()
    }
  })

  it("keeps stale search results through focus and reconnect without another request", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { refetchOnWindowFocus: true, refetchOnReconnect: true },
      },
    })
    const previousFocus = focusManager.isFocused()
    const previousOnline = onlineManager.isOnline()
    let requests = 0
    client.mount()
    const observer = new QueryObserver(client, {
      ...MARKET_SEARCH_QUERY_POLICY,
      queryKey: ["stale-search"],
      queryFn: async () => ++requests,
      staleTime: 0,
    })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await Bun.sleep(10)
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      onlineManager.setOnline(false)
      onlineManager.setOnline(true)
      await Bun.sleep(10)
      expect(requests).toBe(1)
      expect(observer.getCurrentResult().data).toBe(1)
    } finally {
      unsubscribe()
      client.unmount()
      client.clear()
      focusManager.setFocused(previousFocus)
      onlineManager.setOnline(previousOnline)
    }
  })
})
