export const CANONICAL_DEFAULT_RELAYS = [
  // Canonical in-app relay reset list. Deploy env may add relays, but this
  // source list stays visible in the browser console for public verification.
  "wss://conduitl2.fly.dev",
  "wss://relay.plebeian.market",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://nostr.mom",
  "wss://relay.nostr.net",
  "wss://relay.minibits.cash",
]
const RETIRED_DEFAULT_RELAYS = new Set(["wss://relay.conduit.market"])
const FALLBACK_RELAY_URL = "wss://relay.primal.net"
const PUBLIC_REPO_ISSUES_URL =
  "https://github.com/Conduit-BTC/conduit-mono/issues"

export interface ConduitConfig {
  relayUrl: string
  defaultRelays: string[]
  commerceRelayUrls: string[]
  publicRelayUrls: string[]
  cacheApiUrl: string | null
  lightningNetwork: "mainnet" | "signet" | "testnet" | "mock"
  nip89RelayHint: string
  nip89MarketPubkey: string | null
  nip89MerchantPubkey: string | null
  nip89MarketDTag: string
  nip89MerchantDTag: string
}

// Vite only statically replaces direct property access (import.meta.env.VITE_FOO).
// Dynamic access like import.meta.env[key] returns undefined in production builds.
// Use direct access for each variable so Vite can inline them at build time.
function getViteEnv(): {
  relayUrl: string
  defaultRelayUrl: string
  defaultRelays: string
  publicRelayUrls: string
  commerceRelayUrls: string
  cacheApiUrl: string
  lightningNetwork: string
  nip89RelayHint: string
  nip89MarketPubkey: string
  nip89MerchantPubkey: string
  nip89MarketDTag: string
  nip89MerchantDTag: string
} {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    return {
      relayUrl: import.meta.env.VITE_RELAY_URL ?? "",
      defaultRelayUrl: import.meta.env.VITE_DEFAULT_RELAY_URL ?? "",
      defaultRelays: import.meta.env.VITE_DEFAULT_RELAYS ?? "",
      publicRelayUrls: import.meta.env.VITE_PUBLIC_RELAY_URLS ?? "",
      commerceRelayUrls: import.meta.env.VITE_COMMERCE_RELAY_URLS ?? "",
      cacheApiUrl: import.meta.env.VITE_CACHE_API_URL ?? "",
      lightningNetwork: import.meta.env.VITE_LIGHTNING_NETWORK ?? "",
      nip89RelayHint: import.meta.env.VITE_NIP89_RELAY_HINT ?? "",
      nip89MarketPubkey: import.meta.env.VITE_NIP89_MARKET_PUBKEY ?? "",
      nip89MerchantPubkey: import.meta.env.VITE_NIP89_MERCHANT_PUBKEY ?? "",
      nip89MarketDTag: import.meta.env.VITE_NIP89_MARKET_D_TAG ?? "",
      nip89MerchantDTag: import.meta.env.VITE_NIP89_MERCHANT_D_TAG ?? "",
    }
  }
  return {
    relayUrl: "",
    defaultRelayUrl: "",
    defaultRelays: "",
    publicRelayUrls: "",
    commerceRelayUrls: "",
    cacheApiUrl: "",
    lightningNetwork: "",
    nip89RelayHint: "",
    nip89MarketPubkey: "",
    nip89MerchantPubkey: "",
    nip89MarketDTag: "",
    nip89MerchantDTag: "",
  }
}

function normalizeConfiguredRelayUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `wss://${trimmed}`
    const parsed = new URL(withScheme)
    if (parsed.protocol === "http:") parsed.protocol = "ws:"
    if (parsed.protocol === "https:") parsed.protocol = "wss:"
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null
    if (!parsed.hostname) return null

    parsed.hash = ""
    parsed.search = ""
    const pathname =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}`
  } catch {
    return null
  }
}

export function isRetiredDefaultRelayUrl(input: string): boolean {
  const normalized = normalizeConfiguredRelayUrl(input)
  return !!normalized && RETIRED_DEFAULT_RELAYS.has(normalized)
}

function uniqueConfiguredRelayUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of urls) {
    const normalized = normalizeConfiguredRelayUrl(url)
    if (!normalized) continue
    if (RETIRED_DEFAULT_RELAYS.has(normalized)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function parseRelayList(raw: string): string[] {
  return uniqueConfiguredRelayUrls(raw.split(","))
}

function getConfiguredRelayUrl(raw: string, fallback: string): string {
  return uniqueConfiguredRelayUrls([raw])[0] ?? fallback
}

function formatRelayDebugList(relays: readonly string[]): string {
  return relays.length > 0
    ? relays.map((url) => `  - ${url}`).join("\n")
    : "  - (none)"
}

function formatInlineRelayDebugList(relays: readonly string[]): string {
  return relays.length > 0 ? relays.join(", ") : "(none)"
}

function formatEnvRelayDebugSource(input: {
  label: string
  raw: string
  relays: readonly string[]
}): string {
  return [
    `  ${input.label}`,
    `    raw: ${input.raw.trim() || "(empty)"}`,
    `    normalized: ${formatInlineRelayDebugList(input.relays)}`,
  ].join("\n")
}

function logRelayDebugConfig(input: {
  codeDefaults: readonly string[]
  envSources: readonly {
    label: string
    raw: string
    relays: readonly string[]
  }[]
  resolved: {
    relayUrl: string
    defaultRelays: readonly string[]
    publicRelayUrls: readonly string[]
    commerceRelayUrls: readonly string[]
  }
}): void {
  if (typeof window === "undefined") return

  console.log(
    [
      "   .----------------------------------------.",
      "  /  C O N D U I T   R E L A Y   M A P     \\",
      "  \\________________________________________/",
      "",
      "Code defaults:",
      formatRelayDebugList(input.codeDefaults),
      "",
      "Env relay vars loaded by this build:",
      ...input.envSources.map(formatEnvRelayDebugSource),
      "",
      "Resolved relay config:",
      `  relayUrl hint: ${input.resolved.relayUrl}`,
      "  defaultRelays:",
      formatRelayDebugList(input.resolved.defaultRelays),
      "  publicRelayUrls:",
      formatRelayDebugList(input.resolved.publicRelayUrls),
      "  commerceRelayUrls:",
      formatRelayDebugList(input.resolved.commerceRelayUrls),
      "",
      `Have feedback? Submit an issue: ${PUBLIC_REPO_ISSUES_URL}`,
    ].join("\n")
  )
}

const env = getViteEnv()

const relayUrl = getConfiguredRelayUrl(env.relayUrl, FALLBACK_RELAY_URL)
const envRelayUrl = uniqueConfiguredRelayUrls([env.relayUrl])
const envDefaultRelayUrl = uniqueConfiguredRelayUrls([env.defaultRelayUrl])
const envDefaultRelays = parseRelayList(env.defaultRelays)
const envPublicRelayUrls = parseRelayList(env.publicRelayUrls)
const envCommerceRelayUrls = parseRelayList(env.commerceRelayUrls)
const envGeneralRelayUrls = uniqueConfiguredRelayUrls([
  ...envRelayUrl,
  ...envDefaultRelayUrl,
  ...envDefaultRelays,
])
const defaultRelays = uniqueConfiguredRelayUrls(CANONICAL_DEFAULT_RELAYS)
const commerceRelayUrls = envCommerceRelayUrls
const publicRelayUrls = uniqueConfiguredRelayUrls([
  ...envPublicRelayUrls,
  ...envGeneralRelayUrls,
  ...defaultRelays,
])
const resolvedDefaultRelays = uniqueConfiguredRelayUrls([
  ...commerceRelayUrls,
  ...publicRelayUrls,
])
const nip89RelayHint = getConfiguredRelayUrl(env.nip89RelayHint, relayUrl)

export const config: ConduitConfig = {
  relayUrl,
  defaultRelays: resolvedDefaultRelays,
  commerceRelayUrls,
  publicRelayUrls,
  cacheApiUrl: env.cacheApiUrl.trim() || null,
  lightningNetwork: (env.lightningNetwork ||
    "mainnet") as ConduitConfig["lightningNetwork"],
  nip89RelayHint,
  nip89MarketPubkey: env.nip89MarketPubkey.trim() || null,
  nip89MerchantPubkey: env.nip89MerchantPubkey.trim() || null,
  nip89MarketDTag: env.nip89MarketDTag.trim() || "conduit-market",
  nip89MerchantDTag: env.nip89MerchantDTag.trim() || "conduit-merchant",
}

logRelayDebugConfig({
  codeDefaults: defaultRelays,
  envSources: [
    {
      label: "VITE_RELAY_URL",
      raw: env.relayUrl,
      relays: envRelayUrl,
    },
    {
      label: "VITE_DEFAULT_RELAY_URL",
      raw: env.defaultRelayUrl,
      relays: envDefaultRelayUrl,
    },
    {
      label: "VITE_DEFAULT_RELAYS",
      raw: env.defaultRelays,
      relays: envDefaultRelays,
    },
    {
      label: "VITE_PUBLIC_RELAY_URLS",
      raw: env.publicRelayUrls,
      relays: envPublicRelayUrls,
    },
    {
      label: "VITE_COMMERCE_RELAY_URLS",
      raw: env.commerceRelayUrls,
      relays: envCommerceRelayUrls,
    },
  ],
  resolved: {
    relayUrl: config.relayUrl,
    defaultRelays: config.defaultRelays,
    publicRelayUrls: config.publicRelayUrls,
    commerceRelayUrls: config.commerceRelayUrls,
  },
})

export function isMockPayments(): boolean {
  return config.lightningNetwork === "mock"
}

export function isSignet(): boolean {
  return config.lightningNetwork === "signet"
}

export function isTestnet(): boolean {
  return (
    config.lightningNetwork === "testnet" ||
    config.lightningNetwork === "signet"
  )
}

export function isMainnet(): boolean {
  return config.lightningNetwork === "mainnet"
}
