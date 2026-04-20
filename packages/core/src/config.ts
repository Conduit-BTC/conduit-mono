import type { RelayActor, RelayEntry, RelayGroups, RelayRole } from "./types"

const DEFAULT_RELAYS = [
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://purplepag.es",
  "wss://relay.nostr.net",
  "wss://sendit.nosflare.com",
  "wss://relay.plebeian.market",
]

export interface ConduitConfig {
  relayUrl: string
  defaultRelays: string[]
  l2RelayUrls: string[]
  merchantRelayUrls: string[]
  publicRelayUrls: string[]
  cacheApiUrl: string | null
  lightningNetwork: "mainnet" | "signet" | "testnet" | "mock"
}

// Vite only statically replaces direct property access (import.meta.env.VITE_FOO).
// Dynamic access like import.meta.env[key] returns undefined in production builds.
// Use direct access for each variable so Vite can inline them at build time.
function getViteEnv(): {
  relayUrl: string
  defaultRelays: string
  defaultRelayUrl: string
  l2RelayUrls: string
  merchantRelayUrls: string
  publicRelayUrls: string
  cacheApiUrl: string
  lightningNetwork: string
} {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    return {
      relayUrl: import.meta.env.VITE_RELAY_URL ?? "",
      defaultRelays: import.meta.env.VITE_DEFAULT_RELAYS ?? "",
      defaultRelayUrl: import.meta.env.VITE_DEFAULT_RELAY_URL ?? "",
      l2RelayUrls: import.meta.env.VITE_L2_RELAY_URLS ?? "",
      merchantRelayUrls: import.meta.env.VITE_MERCHANT_RELAY_URLS ?? "",
      publicRelayUrls: import.meta.env.VITE_PUBLIC_RELAY_URLS ?? "",
      cacheApiUrl: import.meta.env.VITE_CACHE_API_URL ?? "",
      lightningNetwork: import.meta.env.VITE_LIGHTNING_NETWORK ?? "",
    }
  }
  return {
    relayUrl: "",
    defaultRelays: "",
    defaultRelayUrl: "",
    l2RelayUrls: "",
    merchantRelayUrls: "",
    publicRelayUrls: "",
    cacheApiUrl: "",
    lightningNetwork: "",
  }
}

function parseRelayList(raw: string): string[] {
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
}

function dedupeUrls(urls: string[]): string[] {
  return urls.filter((url, index, all) => url && all.indexOf(url) === index)
}

function getDefaultRelays(env: ReturnType<typeof getViteEnv>): string[] {
  const raw = env.defaultRelays.trim() || env.defaultRelayUrl.trim()
  if (!raw) return DEFAULT_RELAYS
  return parseRelayList(raw)
}

const env = getViteEnv()

const relayUrl = env.relayUrl || "wss://relay.primal.net"
const legacyRelays = getDefaultRelays(env)
const l2RelayUrls = parseRelayList(env.l2RelayUrls)
const merchantRelayUrls = parseRelayList(env.merchantRelayUrls)
const configuredPublicRelayUrls = parseRelayList(env.publicRelayUrls)
const publicRelayUrls = configuredPublicRelayUrls.length > 0 ? configuredPublicRelayUrls : legacyRelays
const defaultRelays = dedupeUrls([
  ...l2RelayUrls,
  ...merchantRelayUrls,
  ...publicRelayUrls,
  relayUrl,
])

export const config: ConduitConfig = {
  relayUrl,
  defaultRelays,
  l2RelayUrls,
  merchantRelayUrls,
  publicRelayUrls,
  cacheApiUrl: env.cacheApiUrl.trim() || null,
  lightningNetwork: (env.lightningNetwork || "mainnet") as ConduitConfig["lightningNetwork"],
}

export function isMockPayments(): boolean {
  return config.lightningNetwork === "mock"
}

export function isSignet(): boolean {
  return config.lightningNetwork === "signet"
}

export function isTestnet(): boolean {
  return config.lightningNetwork === "testnet" || config.lightningNetwork === "signet"
}

export function isMainnet(): boolean {
  return config.lightningNetwork === "mainnet"
}

// ── Relay Role Model ──────────────────────────────────────────

const RELAY_SETTINGS_KEY = "conduit:relay-settings"

function urlsToEntries(urls: string[], role: RelayRole): RelayEntry[] {
  return urls.map((url) => ({ url, role, read: true, write: true }))
}

function isRelayEntry(value: unknown, role: RelayRole): value is RelayEntry {
  if (!value || typeof value !== "object") return false

  const candidate = value as RelayEntry
  return (
    typeof candidate.url === "string" &&
    candidate.url.length > 0 &&
    candidate.role === role &&
    typeof candidate.read === "boolean" &&
    typeof candidate.write === "boolean"
  )
}

function isRelayGroup(value: unknown, role: RelayRole): value is RelayEntry[] {
  return Array.isArray(value) && value.every((entry) => isRelayEntry(entry, role))
}

function collectRelayUrls(filter: (entry: RelayEntry) => boolean): string[] {
  const groups = getEffectiveRelayGroups()
  return dedupeUrls(
    [...groups.merchant, ...groups.commerce, ...groups.general]
      .filter(filter)
      .map((entry) => entry.url),
  )
}

/**
 * Build relay groups from the static env-based config.
 * This is the baseline before any user overrides are applied.
 */
export function getDefaultRelayGroups(): RelayGroups {
  return {
    merchant: urlsToEntries(config.merchantRelayUrls, "merchant"),
    commerce: urlsToEntries(config.l2RelayUrls, "commerce"),
    general: urlsToEntries(config.publicRelayUrls, "general"),
  }
}

/**
 * Load user-customized relay settings from localStorage.
 * Returns null if no overrides have been saved.
 */
export function loadRelayOverrides(): RelayGroups | null {
  if (typeof localStorage === "undefined") return null

  try {
    const raw = localStorage.getItem(RELAY_SETTINGS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as RelayGroups

    if (
      !parsed ||
      !isRelayGroup(parsed.merchant, "merchant") ||
      !isRelayGroup(parsed.commerce, "commerce") ||
      !isRelayGroup(parsed.general, "general")
    ) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

/**
 * Persist user relay overrides to localStorage.
 */
export function saveRelayOverrides(groups: RelayGroups): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(RELAY_SETTINGS_KEY, JSON.stringify(groups))
}

/**
 * Clear user relay overrides, reverting to env-based defaults.
 */
export function clearRelayOverrides(): void {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(RELAY_SETTINGS_KEY)
}

/**
 * Get the effective relay groups: user overrides merged with env defaults.
 * User overrides replace the env defaults entirely per group when present.
 */
export function getEffectiveRelayGroups(): RelayGroups {
  const overrides = loadRelayOverrides()
  return overrides ?? getDefaultRelayGroups()
}

/**
 * Get visible relay groups for a specific actor type.
 * Merchants see all three groups; shoppers see commerce and general only.
 */
export function getRelayGroupsForActor(actor: RelayActor): Partial<RelayGroups> {
  const groups = getEffectiveRelayGroups()
  if (actor === "merchant") return groups
  return {
    commerce: groups.commerce,
    general: groups.general,
  }
}

/**
 * Get all effective relay URLs as a flat deduplicated list.
 * Useful for NDK connection initialization.
 */
export function getEffectiveRelayUrls(): string[] {
  return collectRelayUrls((entry) => entry.read || entry.write)
}

/**
 * Get all effective relay URLs enabled for reads.
 */
export function getEffectiveReadableRelayUrls(): string[] {
  return collectRelayUrls((entry) => entry.read)
}

/**
 * Get all effective relay URLs enabled for writes.
 */
export function getEffectiveWritableRelayUrls(): string[] {
  return collectRelayUrls((entry) => entry.write)
}

/**
 * Human-readable label for a relay role.
 */
export function relayRoleLabel(role: RelayRole): string {
  switch (role) {
    case "merchant":
      return "Merchant relay"
    case "commerce":
      return "Commerce relay"
    case "general":
      return "General relay"
  }
}

/**
 * Short description for a relay role, suitable for tooltips.
 */
export function relayRoleDescription(role: RelayRole): string {
  switch (role) {
    case "merchant":
      return "Source of truth for your products and orders"
    case "commerce":
      return "De-commerce relay for faster marketplace reads"
    case "general":
      return "Broader Nostr network for reach and fallback"
  }
}
