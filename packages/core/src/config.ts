export type RelayBucketId =
  | "app_backplane"
  | "core_public_fallback"
  | "search_index"
  | "commerce_dm_fallback"
  | "dm_inbox_default"
  | "zap_public"

export interface RelayBucketConfig {
  id: RelayBucketId
  label: string
  relayUrls: string[]
}

export const CANONICAL_APP_BACKPLANE_RELAYS = ["wss://relay.conduit.market"]
export const CANONICAL_APP_WRITE_RELAYS = CANONICAL_APP_BACKPLANE_RELAYS
export const CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS = [
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.nostr.net",
]
export const CANONICAL_SEARCH_INDEX_RELAYS = ["wss://relay.nostr.band"]
export const CANONICAL_COMMERCE_DM_FALLBACK_RELAYS = [
  "wss://relay.conduit.market",
  "wss://inbox.azzamo.net",
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.nostr.net",
]
export const CANONICAL_DM_INBOX_DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.nostr.net",
]
export const CANONICAL_ZAP_PUBLIC_RELAYS = [
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.nostr.net",
  "wss://relay.nostr.band",
]
export const CANONICAL_DEFAULT_RELAYS = [
  ...CANONICAL_APP_BACKPLANE_RELAYS,
  ...CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS,
]
const RETIRED_DEFAULT_RELAYS = new Set<string>()
const FALLBACK_RELAY_URL = "wss://nos.lol"
const PUBLIC_REPO_ISSUES_URL =
  "https://github.com/Conduit-BTC/conduit-mono/issues"
const CONDUIT_RELAY_DEBUG_BANNER = [
  "\x1b[38;2;187;0;255m                 ⣾⣿⡆",
  "            ⢰⣿⣷  ⣿⣿⡇ ⣼⣿⣷",
  "            ⢸⣿⣿  ⣿⣿⡇ ⣿⣿⣿",
  "            ⢸⣿⣿  ⣿⣿⡇ ⣿⣿⣿",
  "            ⢸⣿⣿  ⣿⣿⡇ ⣿⣿⣿",
  "        ⣠⡀  ⢸⣿⣿  ⣿⣿⡇ ⣿⣿⣿  ⢀⣠⡀",
  "        ⣿⣿⡆ ⢸⣿⣿  ⣿⣿⡇ ⣿⣿⣿ ⢠⣾⣿⡇",
  "        ⣿⣿⣏ ⢸⣿⣿⣄⣰⣿⣿⣧⣀⣿⣿⣿ ⢸⣿⣿⡇",
  "        ⣿⣿⣷⣀⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣄⣼⣿⣿⡇",
  "        ⣿⣿⣿⣿⣿⣿⣿⣿⣿⠏ ⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇",
  "        ⣿⣿⣿⣿⣿⣿⣿⡿⠁ ⠸⠿⠿⠿⣿⣿⣿⣿⣿⣿⠁",
  "        ⠸⣿⣿⣿⣿⣿⡏      ⣠⣿⣿⣿⣿⣿⡟",
  "         ⠹⣿⣿⣿⣿⣿⣿⣿⡿ ⢀⣾⣿⣿⣿⣿⣿⡿⠁",
  "          ⠘⢿⣿⣿⣿⣿⣿⣇⣰⣿⣿⣿⣿⣿⡿⠋",
  "            ⠈⠛⠿⢿⣿⣿⣿⣿⣿⠿⠟⠋",
  "",
  "      ____ ___  _   _ ____  _   _ ___ _____",
  "     / ___/ _ \\| \\ | |  _ \\| | | |_ _|_   _|",
  "    | |  | | | |  \\| | | | | | | || |  | |",
  "    | |__| |_| | |\\  | |_| | |_| || |  | |",
  "     \\____\\___/|_| \\_|____/ \\___/|___| |_|",
  "",
  "                 RELAY MAP\x1b[0m",
].join("\n")

export interface ConduitConfig {
  relayUrl: string
  defaultRelays: string[]
  appBackplaneRelayUrls: string[]
  appWriteRelayUrls: string[]
  commerceRelayUrls: string[]
  publicRelayUrls: string[]
  corePublicFallbackRelayUrls: string[]
  searchIndexRelayUrls: string[]
  commerceDmFallbackRelayUrls: string[]
  dmInboxDefaultRelayUrls: string[]
  zapRelayUrls: string[]
  cacheApiUrl: string | null
  lightningNetwork: "mainnet" | "signet" | "testnet" | "mock"
  nip89RelayHint: string
  nip89MarketPubkey: string | null
  nip89MerchantPubkey: string | null
  nip89MarketDTag: string
  nip89MerchantDTag: string
  anonZapSignerUrl: string | null
  anonZapSignerPubkey: string | null
}

// Vite only statically replaces direct property access (import.meta.env.VITE_FOO).
// Dynamic access like import.meta.env[key] returns undefined in production builds.
// Use direct access for each variable so Vite can inline them at build time.
function getViteEnv(): {
  relayUrl: string
  defaultRelayUrl: string
  defaultRelays: string
  appWriteRelayUrls: string
  publicRelayUrls: string
  commerceRelayUrls: string
  cacheApiUrl: string
  lightningNetwork: string
  nip89RelayHint: string
  nip89MarketPubkey: string
  nip89MerchantPubkey: string
  nip89MarketDTag: string
  nip89MerchantDTag: string
  anonZapSignerUrl: string
  anonZapSignerPubkey: string
} {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    return {
      relayUrl: import.meta.env.VITE_RELAY_URL ?? "",
      defaultRelayUrl: import.meta.env.VITE_DEFAULT_RELAY_URL ?? "",
      defaultRelays: import.meta.env.VITE_DEFAULT_RELAYS ?? "",
      appWriteRelayUrls: import.meta.env.VITE_APP_WRITE_RELAY_URLS ?? "",
      publicRelayUrls: import.meta.env.VITE_PUBLIC_RELAY_URLS ?? "",
      commerceRelayUrls: import.meta.env.VITE_COMMERCE_RELAY_URLS ?? "",
      cacheApiUrl: import.meta.env.VITE_CACHE_API_URL ?? "",
      lightningNetwork: import.meta.env.VITE_LIGHTNING_NETWORK ?? "",
      nip89RelayHint: import.meta.env.VITE_NIP89_RELAY_HINT ?? "",
      nip89MarketPubkey: import.meta.env.VITE_NIP89_MARKET_PUBKEY ?? "",
      nip89MerchantPubkey: import.meta.env.VITE_NIP89_MERCHANT_PUBKEY ?? "",
      nip89MarketDTag: import.meta.env.VITE_NIP89_MARKET_D_TAG ?? "",
      nip89MerchantDTag: import.meta.env.VITE_NIP89_MERCHANT_D_TAG ?? "",
      anonZapSignerUrl: import.meta.env.VITE_ANON_ZAP_SIGNER_URL ?? "",
      anonZapSignerPubkey: import.meta.env.VITE_ANON_ZAP_SIGNER_PUBKEY ?? "",
    }
  }
  return {
    relayUrl: "",
    defaultRelayUrl: "",
    defaultRelays: "",
    appWriteRelayUrls: "",
    publicRelayUrls: "",
    commerceRelayUrls: "",
    cacheApiUrl: "",
    lightningNetwork: "",
    nip89RelayHint: "",
    nip89MarketPubkey: "",
    nip89MerchantPubkey: "",
    nip89MarketDTag: "",
    nip89MerchantDTag: "",
    anonZapSignerUrl: "",
    anonZapSignerPubkey: "",
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
    appBackplaneRelayUrls: readonly string[]
    appWriteRelayUrls: readonly string[]
    publicRelayUrls: readonly string[]
    commerceRelayUrls: readonly string[]
    corePublicFallbackRelayUrls: readonly string[]
    searchIndexRelayUrls: readonly string[]
    commerceDmFallbackRelayUrls: readonly string[]
    dmInboxDefaultRelayUrls: readonly string[]
    zapRelayUrls: readonly string[]
  }
}): void {
  if (typeof window === "undefined") return

  console.log(
    [
      CONDUIT_RELAY_DEBUG_BANNER,
      "",
      "Code defaults:",
      formatRelayDebugList(input.codeDefaults),
      "",
      "Env relay vars loaded by this build:",
      ...input.envSources.map(formatEnvRelayDebugSource),
      "",
      "Resolved relay config:",
      `  relayUrl hint: ${input.resolved.relayUrl}`,
      "  appBackplaneRelayUrls:",
      formatRelayDebugList(input.resolved.appBackplaneRelayUrls),
      "  appWriteRelayUrls:",
      formatRelayDebugList(input.resolved.appWriteRelayUrls),
      "  defaultRelays:",
      formatRelayDebugList(input.resolved.defaultRelays),
      "  publicRelayUrls:",
      formatRelayDebugList(input.resolved.publicRelayUrls),
      "  commerceRelayUrls:",
      formatRelayDebugList(input.resolved.commerceRelayUrls),
      "  corePublicFallbackRelayUrls:",
      formatRelayDebugList(input.resolved.corePublicFallbackRelayUrls),
      "  searchIndexRelayUrls:",
      formatRelayDebugList(input.resolved.searchIndexRelayUrls),
      "  commerceDmFallbackRelayUrls:",
      formatRelayDebugList(input.resolved.commerceDmFallbackRelayUrls),
      "  dmInboxDefaultRelayUrls:",
      formatRelayDebugList(input.resolved.dmInboxDefaultRelayUrls),
      "  zapRelayUrls:",
      formatRelayDebugList(input.resolved.zapRelayUrls),
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
const envAppWriteRelayUrls = parseRelayList(env.appWriteRelayUrls)
const envPublicRelayUrls = parseRelayList(env.publicRelayUrls)
const envCommerceRelayUrls = parseRelayList(env.commerceRelayUrls)
const envGeneralRelayUrls = uniqueConfiguredRelayUrls([
  ...envRelayUrl,
  ...envDefaultRelayUrl,
  ...envDefaultRelays,
])
const defaultRelays = uniqueConfiguredRelayUrls(CANONICAL_DEFAULT_RELAYS)
const appBackplaneRelayUrls = uniqueConfiguredRelayUrls([
  ...CANONICAL_APP_BACKPLANE_RELAYS,
])
const appWriteRelayUrls = uniqueConfiguredRelayUrls([
  ...appBackplaneRelayUrls,
  ...envAppWriteRelayUrls,
])
const corePublicFallbackRelayUrls = uniqueConfiguredRelayUrls([
  ...CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS,
  ...envPublicRelayUrls,
  ...envGeneralRelayUrls,
])
const searchIndexRelayUrls = uniqueConfiguredRelayUrls(
  CANONICAL_SEARCH_INDEX_RELAYS
)
const commerceDmFallbackRelayUrls = uniqueConfiguredRelayUrls(
  CANONICAL_COMMERCE_DM_FALLBACK_RELAYS
)
const dmInboxDefaultRelayUrls = uniqueConfiguredRelayUrls(
  CANONICAL_DM_INBOX_DEFAULT_RELAYS
)
const zapRelayUrls = uniqueConfiguredRelayUrls(CANONICAL_ZAP_PUBLIC_RELAYS)
const commerceRelayUrls = uniqueConfiguredRelayUrls([
  ...appWriteRelayUrls,
  ...envCommerceRelayUrls,
])
const publicRelayUrls = uniqueConfiguredRelayUrls([
  ...corePublicFallbackRelayUrls,
])
const resolvedDefaultRelays = uniqueConfiguredRelayUrls([
  ...appBackplaneRelayUrls,
  ...corePublicFallbackRelayUrls,
  ...envDefaultRelays,
])
const nip89RelayHint = getConfiguredRelayUrl(
  env.nip89RelayHint,
  CANONICAL_APP_WRITE_RELAYS[0] ?? relayUrl
)

export const config: ConduitConfig = {
  relayUrl,
  defaultRelays: resolvedDefaultRelays,
  appBackplaneRelayUrls,
  appWriteRelayUrls,
  commerceRelayUrls,
  publicRelayUrls,
  corePublicFallbackRelayUrls,
  searchIndexRelayUrls,
  commerceDmFallbackRelayUrls,
  dmInboxDefaultRelayUrls,
  zapRelayUrls,
  cacheApiUrl: env.cacheApiUrl.trim() || null,
  lightningNetwork: (env.lightningNetwork ||
    "mainnet") as ConduitConfig["lightningNetwork"],
  nip89RelayHint,
  nip89MarketPubkey: env.nip89MarketPubkey.trim() || null,
  nip89MerchantPubkey: env.nip89MerchantPubkey.trim() || null,
  nip89MarketDTag: env.nip89MarketDTag.trim() || "conduit-market",
  nip89MerchantDTag: env.nip89MerchantDTag.trim() || "conduit-merchant",
  anonZapSignerUrl: env.anonZapSignerUrl.trim() || null,
  anonZapSignerPubkey: env.anonZapSignerPubkey.trim() || null,
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
      label: "VITE_APP_WRITE_RELAY_URLS",
      raw: env.appWriteRelayUrls,
      relays: envAppWriteRelayUrls,
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
    appBackplaneRelayUrls: config.appBackplaneRelayUrls,
    appWriteRelayUrls: config.appWriteRelayUrls,
    publicRelayUrls: config.publicRelayUrls,
    commerceRelayUrls: config.commerceRelayUrls,
    corePublicFallbackRelayUrls: config.corePublicFallbackRelayUrls,
    searchIndexRelayUrls: config.searchIndexRelayUrls,
    commerceDmFallbackRelayUrls: config.commerceDmFallbackRelayUrls,
    dmInboxDefaultRelayUrls: config.dmInboxDefaultRelayUrls,
    zapRelayUrls: config.zapRelayUrls,
  },
})

export function getRelayBucketConfigs(
  cfg: ConduitConfig = config
): RelayBucketConfig[] {
  return [
    {
      id: "app_backplane",
      label: "Conduit infrastructure",
      relayUrls: cfg.appBackplaneRelayUrls,
    },
    {
      id: "core_public_fallback",
      label: "Core public fallback",
      relayUrls: cfg.corePublicFallbackRelayUrls,
    },
    {
      id: "search_index",
      label: "Search/index",
      relayUrls: cfg.searchIndexRelayUrls,
    },
    {
      id: "commerce_dm_fallback",
      label: "Commerce DM fallback",
      relayUrls: cfg.commerceDmFallbackRelayUrls,
    },
    {
      id: "dm_inbox_default",
      label: "Default encrypted order inbox",
      relayUrls: cfg.dmInboxDefaultRelayUrls,
    },
    {
      id: "zap_public",
      label: "Zap visibility",
      relayUrls: cfg.zapRelayUrls,
    },
  ]
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
