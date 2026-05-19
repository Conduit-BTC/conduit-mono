export const CANONICAL_DEFAULT_RELAYS = [
  // Canonical in-app relay reset list. Deploy env should not inject or replace
  // this list; users can still publish their own NIP-65 preferences.
  "wss://conduitl2.fly.dev",
  "wss://relay.plebeian.market",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://purplepag.es",
]
const RETIRED_DEFAULT_RELAYS = new Set(["wss://relay.conduit.market"])
const FALLBACK_RELAY_URL = "wss://relay.primal.net"

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

function getConfiguredRelayUrl(raw: string, fallback: string): string {
  return uniqueConfiguredRelayUrls([raw])[0] ?? fallback
}

const env = getViteEnv()

const relayUrl = getConfiguredRelayUrl(env.relayUrl, FALLBACK_RELAY_URL)
const defaultRelays = uniqueConfiguredRelayUrls(CANONICAL_DEFAULT_RELAYS)
const commerceRelayUrls: string[] = []
const publicRelayUrls = defaultRelays
const nip89RelayHint = getConfiguredRelayUrl(env.nip89RelayHint, relayUrl)

export const config: ConduitConfig = {
  relayUrl,
  defaultRelays,
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
