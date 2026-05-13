const DEFAULT_RELAYS = [
  // Bootstrap read relays for product discovery. Capability scans determine
  // trust/commerce status; inclusion here does not grant write authority.
  "wss://conduitl2.fly.dev",
  "wss://relay.plebeian.market",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://purplepag.es",
]
const RETIRED_DEFAULT_RELAYS = new Set(["wss://relay.conduit.market"])

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
  defaultRelays: string
  defaultRelayUrl: string
  commerceRelayUrls: string
  publicRelayUrls: string
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
      defaultRelays: import.meta.env.VITE_DEFAULT_RELAYS ?? "",
      defaultRelayUrl: import.meta.env.VITE_DEFAULT_RELAY_URL ?? "",
      commerceRelayUrls: import.meta.env.VITE_COMMERCE_RELAY_URLS ?? "",
      publicRelayUrls: import.meta.env.VITE_PUBLIC_RELAY_URLS ?? "",
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
    defaultRelays: "",
    defaultRelayUrl: "",
    commerceRelayUrls: "",
    publicRelayUrls: "",
    cacheApiUrl: "",
    lightningNetwork: "",
    nip89RelayHint: "",
    nip89MarketPubkey: "",
    nip89MerchantPubkey: "",
    nip89MarketDTag: "",
    nip89MerchantDTag: "",
  }
}

function parseRelayList(raw: string): string[] {
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
}

function getDefaultRelays(env: ReturnType<typeof getViteEnv>): string[] {
  const raw = env.defaultRelays.trim() || env.defaultRelayUrl.trim()
  if (!raw) return DEFAULT_RELAYS
  return [...parseRelayList(raw), ...DEFAULT_RELAYS].filter(
    (url, index, all) =>
      !RETIRED_DEFAULT_RELAYS.has(url) && all.indexOf(url) === index
  )
}

const env = getViteEnv()

const relayUrl = env.relayUrl || "wss://relay.primal.net"
const legacyRelays = getDefaultRelays(env)
const commerceRelayUrls = parseRelayList(env.commerceRelayUrls)
const configuredPublicRelayUrls = parseRelayList(env.publicRelayUrls)
const publicRelayUrls =
  configuredPublicRelayUrls.length > 0
    ? configuredPublicRelayUrls
    : legacyRelays
const defaultRelays = [
  ...commerceRelayUrls,
  ...publicRelayUrls,
  relayUrl,
].filter((url, index, all) => url && all.indexOf(url) === index)

export const config: ConduitConfig = {
  relayUrl,
  defaultRelays,
  commerceRelayUrls,
  publicRelayUrls,
  cacheApiUrl: env.cacheApiUrl.trim() || null,
  lightningNetwork: (env.lightningNetwork ||
    "mainnet") as ConduitConfig["lightningNetwork"],
  nip89RelayHint: env.nip89RelayHint.trim() || relayUrl,
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
