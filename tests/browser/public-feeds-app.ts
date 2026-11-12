import { createElement, useEffect, useRef } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools"
import { config } from "../../packages/core/src/config"
import { useProfiles } from "../../packages/core/src/hooks/useProfiles"
import { useProfileSearch } from "../../packages/core/src/hooks/useProfileSearch"
import {
  AuthProvider,
  useAuth,
} from "../../packages/core/src/context/AuthContext"
import {
  ConduitSessionProvider,
  useConduitSession,
} from "../../packages/core/src/context/ConduitSessionContext"
import { useProgressiveProducts } from "../../apps/market/src/hooks/useProgressiveProducts"
import { useSellerDirectory } from "../../apps/market/src/hooks/useSellerDirectory"
import {
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getFollowPubkeys,
  getMarketplaceProducts,
  getMarketplaceProductsProgressive,
  getMerchantStorefront,
  getProductDetail,
  getProductsByIds,
  getProfiles,
  hasExactLiveProductAvailabilityEvidence,
  type CommerceProductRecord,
  type CommerceQueryMeta,
} from "../../packages/core/src/protocol/commerce"
import {
  getProfilePaymentAddress,
  retainSelectedProfileRows,
} from "../../packages/core/src/protocol/profile-cache"
import { parseProfileEvent } from "../../packages/core/src/protocol/profiles"
import { searchNetworkProfiles } from "../../packages/core/src/protocol/profile-search"
import { ingestRelayListEvent } from "../../packages/core/src/protocol/relay-list"
import { closePublicRelayConnections } from "../../packages/core/src/protocol/relay-reader"
import { __resetRelayHealth } from "../../packages/core/src/protocol/relay-health"
import { admitPublicEvent } from "../../packages/core/src/protocol/verified-public-event"

// Disposable identity and destinations exist only in this isolated test app.
const key = new Uint8Array(32).fill(29)
const author = getPublicKey(key)
const configured = [
  "wss://public-feed-a.fixture.net",
  "wss://public-feed-b.fixture.net",
]
const hints = Array.from(
  { length: 105 },
  (_, index) => `wss://advertised-${index}.feed-fixture.net`
)
const outsideFallback = "wss://generic-fallback.feed-fixture.net"
const outsideSearch = "wss://generic-search.feed-fixture.net"
Object.assign(config, {
  e2eRelayIsolationEnabled: false,
  appCommerceRelayUrls: configured,
  commerceDiscoveryRelayUrls: configured,
  appReadRelayUrls: configured,
  appBackplaneRelayUrls: configured.slice(0, 1),
  defaultRelays: [outsideFallback],
  corePublicFallbackRelayUrls: [outsideFallback],
  searchIndexRelayUrls: [outsideSearch],
})

const coordinate = (name: string) => `30402:${author}:${name}`
function listing(
  name: string,
  price = 10,
  createdAt = 10,
  extra: string[][] = []
) {
  const tags = [
    ["d", name],
    ["title", `Fixture ${name}`],
    ["price", String(price), "SATS"],
    ["type", "simple", "digital"],
    ["image", "https://images.feed-fixture.net/synthetic.png"],
  ]
  return finalizeEvent(
    {
      kind: 30402,
      created_at: createdAt,
      content: "",
      tags: [
        ...tags.filter((tag) => !extra.some((value) => value[0] === tag[0])),
        ...extra,
      ],
    },
    key
  )
}
function deletion(name: string) {
  return finalizeEvent(
    { kind: 5, created_at: 30, content: "", tags: [["a", coordinate(name)]] },
    key
  )
}
const old = listing("current", 10, 10)
const current = listing("current", 40, 20)
const removed = listing("removed", 5, 10)
const parent = listing("family", 10, 10, [["type", "variable", "digital"]])
const childTags = [
  ["type", "variation", "digital"],
  ["a", coordinate("family")],
  ["spec", "Color", "Red"],
]
const child = listing("red", 10, 11, childTags)
const currentChild = listing("red", 40, 20, childTags)
const blue = listing("blue", 12, 12, [
  ["type", "variation", "digital"],
  ["a", coordinate("family")],
  ["spec", "Color", "Blue"],
])
const catalog = [
  old,
  removed,
  parent,
  child,
  blue,
  ...Array.from({ length: 8 }, (_, index) =>
    listing(`extra-${index}`, 10 + index, 2 + index)
  ),
]
const tombstones = [deletion("removed"), deletion("blue")]
const oldProfile = finalizeEvent(
  {
    kind: 0,
    created_at: 10,
    content: JSON.stringify({
      name: "Fixture Seller",
      lud16: "retired@synthetic.invalid",
    }),
    tags: [],
  },
  key
)
const profile = finalizeEvent(
  {
    kind: 0,
    created_at: 30,
    content: JSON.stringify({ name: "Fixture Seller" }),
    tags: [],
  },
  key
)
const relayList = finalizeEvent(
  {
    kind: 10002,
    created_at: 10,
    content: "",
    tags: hints.map((url) => ["r", url, "write"]),
  },
  key
)
const followList = finalizeEvent(
  {
    kind: 3,
    created_at: 10,
    content: "",
    tags: [["p", getPublicKey(new Uint8Array(32).fill(30))]],
  },
  key
)

export type PublicFeedBrowserFixtures = {
  configured: string[]
  hints: string[]
  outsideFallback: string
  outsideSearch: string
  catalog: ReturnType<typeof finalizeEvent>[]
  currentCatalog: ReturnType<typeof finalizeEvent>[]
  ranked: ReturnType<typeof finalizeEvent>[]
  tombstones: ReturnType<typeof finalizeEvent>[]
  oldProfile: ReturnType<typeof finalizeEvent>
  profile: ReturnType<typeof finalizeEvent>
  relayList: ReturnType<typeof finalizeEvent>
  followList: ReturnType<typeof finalizeEvent>
}
const fixtures: PublicFeedBrowserFixtures = {
  configured,
  hints,
  outsideFallback,
  outsideSearch,
  catalog,
  currentCatalog: catalog.map((event) =>
    event.id === old.id ? current : event.id === child.id ? currentChild : event
  ),
  ranked: [child, removed, old],
  tombstones,
  oldProfile,
  profile,
  relayList,
  followList,
}

const policy = { maxRelays: 2, connectTimeoutMs: 500, fetchTimeoutMs: 1_000 }
const output = document.querySelector<HTMLPreElement>("#result")!
const status = document.querySelector<HTMLOutputElement>("#status")!
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})
const hookRoot = createRoot(document.querySelector("#hooks")!)
const summary = (
  records: CommerceProductRecord[],
  meta: CommerceQueryMeta
) => ({
  ids: records.map((record) => record.dTag),
  prices: Object.fromEntries(
    records.map((record) => [record.dTag, record.product.price])
  ),
  families: Object.fromEntries(
    records
      .filter((record) => record.family)
      .map((record) => [
        record.dTag,
        record.family!.children.map((value) => ({
          id: value.dTag,
          price: value.product.price,
        })),
      ])
  ),
  stale: meta.stale,
  degraded: meta.degraded,
  capped: !!meta.capped,
})

function ProfileScopeProbe({
  complete,
}: {
  complete: (result: Record<string, unknown>) => void
}) {
  // Identical query options except read scope: both must execute independently.
  const options = {
    skipCache: true,
    requireCompleteEvidence: true,
    readPolicy: policy,
    relayHintsByPubkey: { [author]: hints },
    maxUnresolvedRefetches: 0,
    staleTime: 0,
  }
  const display = useProfiles([author], {
    ...options,
    readScope: "public_feed",
  })
  const evidence = useProfiles([author], options)
  const preparation = useProfiles([author], {
    ...options,
    lifecycleKey: "synthetic-preparation",
  })
  const search = useProfileSearch("Fixture", {
    readScope: "public_feed",
    authorPubkeys: [author],
    settleMs: 0,
  })
  useEffect(() => {
    if (
      display.isFetching ||
      display.isLoading ||
      evidence.isFetching ||
      evidence.isLoading ||
      preparation.isFetching ||
      preparation.isLoading ||
      search.isFetching ||
      !search.data
    )
      return
    complete({
      displayComplete: display.profileContexts[author]?.readComplete,
      evidenceComplete: evidence.profileContexts[author]?.readComplete,
      preparationComplete: preparation.profileContexts[author]?.readComplete,
      displayAddress: !!getProfilePaymentAddress(
        display.profileContexts[author]
      ),
      evidenceAddress: !!getProfilePaymentAddress(
        evidence.profileContexts[author]
      ),
      profileQueries: queryClient
        .getQueryCache()
        .findAll({ queryKey: ["profiles"] }).length,
      searchMatches: search.data.matches.length,
    })
  }, [complete, display, evidence, preparation, search])
  return createElement(
    "p",
    null,
    "Reading independent display and evidence profile queries"
  )
}

function PublicAppHooksProbe({
  complete,
}: {
  complete: (result: Record<string, unknown>) => void
}) {
  const auth = useAuth()
  const session = useConduitSession()
  const completed = useRef(false)
  // Omit readScope deliberately: the production marketplace hook selects it.
  const products = useProgressiveProducts({
    scope: "marketplace",
    merchantPubkey: author,
    limit: 6,
  })
  // Guest directory authors remain repository-owned. Do not replace that module
  // with a synthetic list just to manufacture seller rows for this fixture.
  const directory = useSellerDirectory({
    catalogSource: "conduit",
    query: "Fixture",
    accountSearchSettleMs: 0,
    networkEnabled: true,
    hydrateSellerProfiles: true,
  })
  useEffect(() => {
    if (
      completed.current ||
      !session.relaySettingsReady ||
      products.isInitialLoading ||
      products.isHydrating ||
      !products.meta ||
      directory.isFetching ||
      directory.accountSearch.isFetching ||
      !directory.accountSearch.data ||
      directory.accountSearch.data.evidence === "not_queried"
    )
      return
    completed.current = true
    complete({
      authStatus: auth.status,
      guest: session.mode === "guest",
      hasSigner: !!auth.signer,
      hasAccount: !!auth.accountPubkey,
      ids: products.products.map((product) => product.id.split(":").at(-1)),
      prices: Object.fromEntries(
        products.products.map((product) => [
          product.id.split(":").at(-1),
          product.price,
        ])
      ),
      productError: !!products.error,
      directoryConnected: directory.connected,
      directorySource: directory.effectiveSource,
      directorySearchEvidence: directory.accountSearch.data.evidence,
      directorySearchSettled: true,
      sellerCount: directory.sellers.length,
    })
  }, [auth, complete, directory, products, session])
  return createElement("p", null, "Reading the production Market guest hooks")
}

const actions = [
  "browse",
  "refresh",
  "load more",
  "search",
  "storefront",
  "detail",
  "support",
  "hook scopes",
  "public app hooks",
  "generic exact",
  "generic profile",
] as const
type Action = (typeof actions)[number]
async function run(action: Action): Promise<Record<string, unknown>> {
  closePublicRelayConnections()
  if (action === "browse" || action === "refresh" || action === "load more") {
    const snapshots: ReturnType<typeof summary>[] = []
    const result = await getMarketplaceProductsProgressive(
      {
        authorPubkeys: [author],
        limit: action === "load more" ? 6 : 2,
        readPolicy: policy,
      },
      (snapshot) => snapshots.push(summary(snapshot.data, snapshot.meta))
    )
    return { ...summary(result.data, result.meta), snapshots: snapshots.length }
  }
  if (action === "search") {
    const result = await getMarketplaceProducts({
      searchIndex: true,
      textQuery: "Fixture",
      readPolicy: policy,
    })
    return {
      ...summary(result.data, result.meta),
      searchRelays: result.meta.productSearch?.relayUrls,
    }
  }
  if (action === "storefront") {
    const result = await getMerchantStorefront({
      merchantPubkey: author,
      readScope: "public_feed",
      readPolicy: policy,
      deletionReadPolicy: policy,
    })
    return summary(result.data, result.meta)
  }
  if (action === "detail") {
    const result = await getProductDetail({
      productId: nip19.naddrEncode({
        kind: 30402,
        pubkey: author,
        identifier: "red",
        relays: hints.slice(0, 3),
      }),
      readScope: "public_feed",
    })
    return summary(result.data ? [result.data] : [], result.meta)
  }
  if (action === "support") {
    const [profiles, follows, search] = await Promise.all([
      getProfiles({
        pubkeys: [author],
        readScope: "public_feed",
        skipCache: true,
        readPolicy: policy,
        relayHintsByPubkey: { [author]: hints },
      }),
      getFollowPubkeys({ pubkey: author, readScope: "public_feed" }),
      searchNetworkProfiles({
        query: "Fixture",
        readScope: "public_feed",
        authorPubkeys: [author],
      }),
    ])
    return {
      profileComplete: profiles.profileContexts[author]?.readComplete,
      retainedRevocation: !getProfilePaymentAddress(
        profiles.profileContexts[author]
      ),
      followsObserved: follows.meta.eventObserved,
      followCount: follows.data.length,
      searchMatches: search.matches.length,
    }
  }
  if (action === "hook scopes") {
    return new Promise((complete) => {
      hookRoot.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ProfileScopeProbe, { complete })
        )
      )
    })
  }
  if (action === "public app hooks") {
    const appQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    return new Promise((complete) => {
      hookRoot.render(
        createElement(
          QueryClientProvider,
          { client: appQueryClient },
          createElement(AuthProvider, {
            children: createElement(ConduitSessionProvider, {
              appId: "market",
              children: createElement(PublicAppHooksProbe, { complete }),
            }),
          })
        )
      )
    })
  }
  if (action === "generic exact") {
    const result = await getProductsByIds([coordinate("current")])
    return {
      ...summary(result.data, result.meta),
      liveEvidence: hasExactLiveProductAvailabilityEvidence(
        result.diagnostics[0],
        coordinate("current")
      ),
    }
  }
  const result = await getProfiles({
    pubkeys: [author],
    skipCache: true,
    requireCompleteEvidence: true,
    evidenceScope: "payment",
    authorRelayPaymentPolicy: true,
    readPolicy: policy,
  })
  return {
    readComplete: result.profileContexts[author]?.readComplete,
    addressRevoked: !getProfilePaymentAddress(result.profileContexts[author]),
  }
}

declare global {
  interface Window {
    publicFeedHarness: {
      fixtures: PublicFeedBrowserFixtures
      resetHealth: () => void
    }
  }
}
window.publicFeedHarness = {
  fixtures,
  resetHealth: () => {
    closePublicRelayConnections()
    __resetRelayHealth()
  },
}

async function prepare() {
  await ingestRelayListEvent(relayList, hints)
  for (const event of [parent, current, currentChild, removed, blue]) {
    await cacheSignedProductListingEvent(event, { sourceRelayUrls: hints })
  }
  for (const event of tombstones) await cacheSignedProductDeletionEvent(event)
  const admitted = await admitPublicEvent(profile)
  if (admitted.status !== "verified")
    throw new Error("Synthetic profile admission failed")
  await retainSelectedProfileRows([
    {
      ...parseProfileEvent(admitted.event),
      rawContent: profile.content,
      eventId: profile.id,
      eventCreatedAt: profile.created_at,
      cachedAt: 0,
    },
  ])
  for (const action of actions) {
    const button = document.createElement("button")
    button.textContent = action
    button.addEventListener("click", async () => {
      status.textContent = `Running ${action}`
      output.textContent = ""
      try {
        output.textContent = JSON.stringify({ action, ...(await run(action)) })
      } catch (error) {
        output.textContent = JSON.stringify({
          action,
          error: error instanceof Error ? error.name : "unknown",
        })
      }
      status.textContent = "Ready"
    })
    document.querySelector("#controls")!.append(button)
  }
  status.textContent = "Ready"
}
void prepare().catch(() => {
  status.textContent = "Synthetic setup failed"
})
