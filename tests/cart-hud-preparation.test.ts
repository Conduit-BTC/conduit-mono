import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { isCartHudPreparationEnabled } from "../apps/market/src/lib/cart-hud"
import {
  merchantLnurlPreflightQueryOptions,
  merchantCartAvailabilityQueryKey,
} from "../apps/market/src/hooks/useCartReadiness"

const { QueryClient, QueryObserver } = createRequire(
  new URL("../apps/market/package.json", import.meta.url)
)("@tanstack/react-query")

test("HUD preparation leases cannot join or cancel the cart and checkout query owners", () => {
  const client = new QueryClient()
  const ordinaryStock = merchantCartAvailabilityQueryKey(
    "merchant",
    ["product"],
    [],
    "account"
  )
  const hudStock = merchantCartAvailabilityQueryKey(
    "merchant",
    ["product"],
    [],
    "account",
    "hud-route-account"
  )
  client.setQueryData(ordinaryStock, "default stock")
  expect(client.getQueryData(hudStock)).toBeUndefined()
  const ordinaryLnurl = merchantLnurlPreflightQueryOptions(
    "sales@hud.fixture.net"
  ).queryKey
  const hudLnurl = merchantLnurlPreflightQueryOptions("sales@hud.fixture.net", {
    lifecycleKey: "hud-route-account",
  }).queryKey
  client.setQueryData(ordinaryLnurl, "default metadata")
  expect(client.getQueryData(hudLnurl)).toBeUndefined()
  client.setQueryData(hudStock, "HUD stock")
  expect(client.getQueryData(ordinaryStock)).toBe("default stock")
  client.clear()
})

test("HUD payment preflight starts only after explicit expansion in the current route/account scope", async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    return new Response(
      JSON.stringify({
        tag: "payRequest",
        callback: "https://hud-merchant.fixture.net/callback",
        minSendable: 1000,
        maxSendable: 100_000_000,
        metadata: JSON.stringify([["text/plain", "HUD fixture"]]),
      }),
      { headers: { "content-type": "application/json" } }
    )
  }) as typeof fetch
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const scope = "products:account:generation"
  const state = {
    expanded: true,
    visible: true,
    requestedScope: null as string | null,
    currentScope: scope,
  }
  const options = () => ({
    ...merchantLnurlPreflightQueryOptions("sales@hud-merchant.fixture.net", {
      bounded: false,
      retry: false,
    }),
    networkMode: "always" as const,
    enabled: isCartHudPreparationEnabled(state),
  })
  const observer = new QueryObserver(client, options())
  const unsubscribe = observer.subscribe(() => {})
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toBe(0)
    state.requestedScope = scope
    observer.setOptions(options())
    for (let i = 0; i < 30 && !observer.getCurrentResult().isSuccess; i++)
      await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toBe(1)
    expect(observer.getCurrentResult().isSuccess).toBe(true)
    state.expanded = false
    expect(isCartHudPreparationEnabled(state)).toBe(false)
    state.expanded = true
    state.currentScope = "another-route-or-account"
    expect(isCartHudPreparationEnabled(state)).toBe(false)
  } finally {
    unsubscribe()
    client.clear()
    globalThis.fetch = originalFetch
  }
})

test("withdrawing HUD intent fences an LNURL preflight waiting in the shared limiter", async () => {
  const originalFetch = globalThis.fetch
  const release: Array<() => void> = []
  let requests = 0
  let currentIntent = true
  const canceledQuery = new AbortController()
  globalThis.fetch = (async () => {
    requests++
    await new Promise<void>((resolve) => release.push(resolve))
    return new Response(
      JSON.stringify({
        tag: "payRequest",
        callback: "https://queued-hud.fixture.net/pay",
        minSendable: 1000,
        maxSendable: 100_000_000,
        metadata: JSON.stringify([["text/plain", "Queue fixture"]]),
      })
    )
  }) as typeof fetch
  const requestsSettled = Promise.allSettled([
    ...Array.from({ length: 4 }, (_, index) =>
      merchantLnurlPreflightQueryOptions(
        `merchant${index}@queued-hud.fixture.net`,
        {
          retry: false,
          shouldContinue: () => currentIntent,
        }
      ).queryFn()
    ),
    merchantLnurlPreflightQueryOptions("canceled@queued-hud.fixture.net", {
      retry: false,
      shouldContinue: () => true,
    }).queryFn({ signal: canceledQuery.signal }),
  ])
  try {
    for (let i = 0; i < 20 && requests < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toBe(3)
    currentIntent = false
    canceledQuery.abort()
    // Finish admitted reads; no queued request may start after withdrawal.
    while (release.length) release.shift()!()
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      while (release.length) release.shift()!()
    }
    const results = await requestsSettled
    expect(requests).toBe(3)
    expect(results[3]?.status).toBe("rejected")
    expect(results[4]?.status).toBe("rejected")
  } finally {
    currentIntent = false
    while (release.length) release.shift()!()
    await requestsSettled
    globalThis.fetch = originalFetch
  }
})
