import type {
  RelayActor,
  RelayEntry,
  RelayGroups,
  RelayOverrideState,
  RelayOverrides,
  RelayPurpose,
  RelayRole,
  RelaySource,
} from "./types"

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

const RELAY_SETTINGS_KEY = "conduit:relay-settings"
const SIGNER_RELAYS_KEY = "conduit:signer-relays"

type SignerRelayMap = Record<string, { read?: boolean; write?: boolean }>

type LegacyRelayGroups = {
  merchant?: unknown[]
  commerce?: unknown[]
  general?: unknown[]
}

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
    .map((relay) => normalizeRelayUrl(relay))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
}

function normalizeRelayUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""

  if (/^wss:\/\/localhost(?::\d+)?/i.test(trimmed)) {
    return trimmed.replace(/^wss:\/\/localhost/i, "ws://127.0.0.1")
  }

  if (/^wss:\/\/127\.0\.0\.1(?::\d+)?/i.test(trimmed)) {
    return trimmed.replace(/^wss:/i, "ws:")
  }

  return trimmed
}

function dedupeUrls(urls: string[]): string[] {
  const normalized = urls.map(normalizeRelayUrl).filter(Boolean)
  return normalized.filter((url, index, all) => all.indexOf(url) === index)
}

function getDefaultRelays(env: ReturnType<typeof getViteEnv>): string[] {
  const raw = env.defaultRelays.trim() || env.defaultRelayUrl.trim()
  if (!raw) return DEFAULT_RELAYS
  return parseRelayList(raw)
}

function emptyRelayGroups(): RelayGroups {
  return {
    merchant: [],
    commerce: [],
    general: [],
  }
}

function emptyRelayOverrides(): RelayOverrides {
  return {
    custom: emptyRelayGroups(),
    states: {
      merchant: {},
      commerce: {},
      general: {},
    },
  }
}

function urlsToEntries(
  urls: string[],
  role: RelayRole,
  source: RelaySource
): RelayEntry[] {
  return urls.map((url) => ({
    url: normalizeRelayUrl(url),
    role,
    source,
    out: true,
    in: true,
    find: true,
    dm: true,
  }))
}

function signerRelayMapToEntries(relays: SignerRelayMap): RelayEntry[] {
  return Object.entries(relays).map(([url, prefs]) => ({
    url: normalizeRelayUrl(url),
    role: "merchant",
    source: "signer",
    out: prefs.write ?? true,
    in: prefs.read ?? true,
    find: prefs.read ?? true,
    dm: prefs.read ?? true,
  }))
}

function isRelaySource(value: unknown): value is RelaySource {
  return value === "app" || value === "signer" || value === "custom"
}

function isRelayEntry(value: unknown, role: RelayRole): value is RelayEntry {
  if (!value || typeof value !== "object") return false

  const candidate = value as RelayEntry
  return (
    typeof candidate.url === "string" &&
    candidate.url.length > 0 &&
    candidate.role === role &&
    typeof candidate.out === "boolean" &&
    typeof candidate.in === "boolean" &&
    typeof candidate.find === "boolean" &&
    typeof candidate.dm === "boolean" &&
    isRelaySource(candidate.source)
  )
}

function isRelayGroup(value: unknown, role: RelayRole): value is RelayEntry[] {
  return (
    Array.isArray(value) && value.every((entry) => isRelayEntry(entry, role))
  )
}

function isRelayOverrideState(value: unknown): value is RelayOverrideState {
  if (!value || typeof value !== "object") return false

  const candidate = value as RelayOverrideState
  return (
    (candidate.out === undefined || typeof candidate.out === "boolean") &&
    (candidate.in === undefined || typeof candidate.in === "boolean") &&
    (candidate.find === undefined || typeof candidate.find === "boolean") &&
    (candidate.dm === undefined || typeof candidate.dm === "boolean") &&
    (candidate.hidden === undefined || typeof candidate.hidden === "boolean")
  )
}

function isRelayOverrideStateMap(
  value: unknown
): value is Record<string, RelayOverrideState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every((entry) => isRelayOverrideState(entry))
}

function isRelayOverrides(value: unknown): value is RelayOverrides {
  if (!value || typeof value !== "object") return false

  const candidate = value as RelayOverrides
  return (
    !!candidate.custom &&
    !!candidate.states &&
    isRelayGroup(candidate.custom.merchant, "merchant") &&
    isRelayGroup(candidate.custom.commerce, "commerce") &&
    isRelayGroup(candidate.custom.general, "general") &&
    isRelayOverrideStateMap(candidate.states.merchant) &&
    isRelayOverrideStateMap(candidate.states.commerce) &&
    isRelayOverrideStateMap(candidate.states.general)
  )
}

function migrateLegacyOverrides(value: unknown): RelayOverrides | null {
  if (!value || typeof value !== "object") return null

  const candidate = value as LegacyRelayGroups
  if (
    !Array.isArray(candidate.merchant) ||
    !Array.isArray(candidate.commerce) ||
    !Array.isArray(candidate.general)
  ) {
    return null
  }

  return {
    custom: {
      merchant: candidate.merchant.filter(isLegacyRelayShape).map((entry) => ({
        url: entry.url,
        role: "merchant" as const,
        source: "custom" as const,
        out: entry.write ?? true,
        in: entry.read ?? true,
        find: false,
        dm: entry.read ?? true,
      })),
      commerce: candidate.commerce.filter(isLegacyRelayShape).map((entry) => ({
        url: entry.url,
        role: "commerce" as const,
        source: "custom" as const,
        out: entry.write ?? false,
        in: entry.read ?? true,
        find: entry.read ?? true,
        dm: false,
      })),
      general: candidate.general.filter(isLegacyRelayShape).map((entry) => ({
        url: entry.url,
        role: "general" as const,
        source: "custom" as const,
        out: entry.write ?? true,
        in: entry.read ?? true,
        find: entry.read ?? true,
        dm: entry.read ?? true,
      })),
    },
    states: emptyRelayOverrides().states,
  }
}

function isLegacyRelayShape(
  value: unknown
): value is { url: string; read?: boolean; write?: boolean } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { url?: unknown }).url === "string"
  )
}

function defaultPurposes(
  role: RelayRole
): Pick<RelayEntry, "out" | "in" | "find" | "dm"> {
  switch (role) {
    case "merchant":
      return { out: true, in: true, find: false, dm: true }
    case "commerce":
      return { out: false, in: true, find: true, dm: false }
    case "general":
      return { out: true, in: true, find: true, dm: true }
  }
}

function mergeRelayEntries(...groups: RelayEntry[][]): RelayEntry[] {
  const seen = new Set<string>()
  const merged: RelayEntry[] = []

  for (const group of groups) {
    for (const entry of group) {
      const normalizedUrl = normalizeRelayUrl(entry.url)
      if (!normalizedUrl || seen.has(normalizedUrl)) continue
      seen.add(normalizedUrl)
      merged.push({ ...entry, url: normalizedUrl })
    }
  }

  return merged
}

function applyStateOverrides(
  entries: RelayEntry[],
  states: Record<string, RelayOverrideState>
): RelayEntry[] {
  return entries.flatMap((entry) => {
    const state = states[entry.url]
    if (state?.hidden) return []

    return [
      {
        ...entry,
        out: state?.out ?? entry.out,
        in: state?.in ?? entry.in,
        find: state?.find ?? entry.find,
        dm: state?.dm ?? entry.dm,
      },
    ]
  })
}

function getEntriesForActor(actor: RelayActor): RelayEntry[] {
  const groups = getEffectiveRelayGroups()
  if (actor === "merchant") {
    return [...groups.merchant, ...groups.commerce, ...groups.general]
  }

  return [...groups.commerce, ...groups.general]
}

function collectRelayUrls(
  actor: RelayActor,
  filter: (entry: RelayEntry) => boolean
): string[] {
  return dedupeUrls(
    getEntriesForActor(actor)
      .filter(filter)
      .map((entry) => entry.url)
  )
}

function collectRoleRelayUrls(
  role: RelayRole,
  filter: (entry: RelayEntry) => boolean
): string[] {
  return dedupeUrls(
    getEffectiveRelayGroups()
      [role].filter(filter)
      .map((entry) => entry.url)
  )
}

const env = getViteEnv()

const relayUrl = env.relayUrl || "wss://relay.primal.net"
const legacyRelays = getDefaultRelays(env)
const l2RelayUrls = parseRelayList(env.l2RelayUrls)
const merchantRelayUrls = parseRelayList(env.merchantRelayUrls)
const configuredPublicRelayUrls = parseRelayList(env.publicRelayUrls)
const publicRelayUrls =
  configuredPublicRelayUrls.length > 0
    ? configuredPublicRelayUrls
    : legacyRelays
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
  lightningNetwork: (env.lightningNetwork ||
    "mainnet") as ConduitConfig["lightningNetwork"],
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

export function loadSignerRelayMap(): SignerRelayMap {
  if (typeof localStorage === "undefined") return {}

  try {
    const raw = localStorage.getItem(SIGNER_RELAYS_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as SignerRelayMap
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {}

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([url, prefs]) => {
          return (
            typeof url === "string" &&
            normalizeRelayUrl(url).length > 0 &&
            isRelayOverrideState(prefs)
          )
        })
        .map(([url, prefs]) => [normalizeRelayUrl(url), prefs])
    )
  } catch {
    return {}
  }
}

export function saveSignerRelayMap(relays: SignerRelayMap): void {
  if (typeof localStorage === "undefined") return

  const normalized = Object.fromEntries(
    Object.entries(relays)
      .map(([url, prefs]) => [normalizeRelayUrl(url), prefs] as const)
      .filter(([url]) => url.length > 0)
  )

  localStorage.setItem(SIGNER_RELAYS_KEY, JSON.stringify(normalized))
}

export function clearSignerRelayMap(): void {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(SIGNER_RELAYS_KEY)
}

export function getConfiguredRelayGroups(): RelayGroups {
  return {
    merchant: urlsToEntries(config.merchantRelayUrls, "merchant", "app").map(
      (entry) => ({
        ...entry,
        ...defaultPurposes("merchant"),
      })
    ),
    commerce: urlsToEntries(config.l2RelayUrls, "commerce", "app").map(
      (entry) => ({
        ...entry,
        ...defaultPurposes("commerce"),
      })
    ),
    general: urlsToEntries(config.publicRelayUrls, "general", "app").map(
      (entry) => ({
        ...entry,
        ...defaultPurposes("general"),
      })
    ),
  }
}

/**
 * Build relay groups from the signer relay list and app config.
 * This is the baseline before any local user overrides are applied.
 */
export function getDefaultRelayGroups(): RelayGroups {
  const configured = getConfiguredRelayGroups()
  const signerRelays = signerRelayMapToEntries(loadSignerRelayMap())

  return {
    merchant: mergeRelayEntries(signerRelays, configured.merchant),
    commerce: configured.commerce,
    general: configured.general,
  }
}

/**
 * Load user-customized relay settings from localStorage.
 * Returns null if no overrides have been saved.
 */
export function loadRelayOverrides(): RelayOverrides | null {
  if (typeof localStorage === "undefined") return null

  try {
    const raw = localStorage.getItem(RELAY_SETTINGS_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as unknown
    if (isRelayOverrides(parsed)) return parsed

    return migrateLegacyOverrides(parsed)
  } catch {
    return null
  }
}

/**
 * Persist user relay overrides to localStorage.
 */
export function saveRelayOverrides(overrides: RelayOverrides): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(RELAY_SETTINGS_KEY, JSON.stringify(overrides))
}

/**
 * Clear user relay overrides, reverting to signer and app defaults.
 */
export function clearRelayOverrides(): void {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(RELAY_SETTINGS_KEY)
}

/**
 * Get the effective relay groups: signer and app defaults plus local overrides.
 */
export function getEffectiveRelayGroups(): RelayGroups {
  const defaults = getDefaultRelayGroups()
  const overrides = loadRelayOverrides()
  if (!overrides) return defaults

  return {
    merchant: applyStateOverrides(
      mergeRelayEntries(defaults.merchant, overrides.custom.merchant),
      overrides.states.merchant
    ),
    commerce: applyStateOverrides(
      mergeRelayEntries(defaults.commerce, overrides.custom.commerce),
      overrides.states.commerce
    ),
    general: applyStateOverrides(
      mergeRelayEntries(defaults.general, overrides.custom.general),
      overrides.states.general
    ),
  }
}

/**
 * Get visible relay groups for a specific actor type.
 * Merchants see all three groups; shoppers see commerce and general only.
 */
export function getRelayGroupsForActor(
  actor: RelayActor
): Partial<RelayGroups> {
  const groups = getEffectiveRelayGroups()
  if (actor === "merchant") return groups

  return {
    commerce: groups.commerce,
    general: groups.general,
  }
}

/**
 * Get all effective relay URLs as a flat deduplicated list.
 */
export function getEffectiveRelayUrls(
  actor: RelayActor = "merchant"
): string[] {
  return collectRelayUrls(
    actor,
    (entry) => entry.out || entry.in || entry.find || entry.dm
  )
}

/**
 * Get all effective relay URLs enabled for reads.
 */
export function getEffectiveReadableRelayUrls(
  actor: RelayActor = "merchant"
): string[] {
  return collectRelayUrls(actor, (entry) => entry.in)
}

/**
 * Get all effective relay URLs enabled for writes.
 */
export function getEffectiveWritableRelayUrls(
  actor: RelayActor = "merchant"
): string[] {
  return collectRelayUrls(actor, (entry) => entry.out)
}

export function getEffectiveDiscoveryRelayUrls(
  actor: RelayActor = "merchant"
): string[] {
  return collectRelayUrls(actor, (entry) => entry.find)
}

export function getEffectiveDmRelayUrls(
  actor: RelayActor = "merchant"
): string[] {
  return collectRelayUrls(actor, (entry) => entry.dm)
}

export function getEffectiveRoleRelayUrls(
  role: RelayRole,
  purpose: RelayPurpose = "in"
): string[] {
  return collectRoleRelayUrls(role, (entry) => entry[purpose])
}

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

export function relayRoleDescription(role: RelayRole): string {
  switch (role) {
    case "merchant":
      return "Source of truth for your products and orders"
    case "commerce":
      return "Conduit-managed acceleration for commerce reads and delivery"
    case "general":
      return "Your signer relay list, plus app fallbacks when available"
  }
}

export function relaySourceLabel(source: RelaySource): string {
  switch (source) {
    case "app":
      return "Conduit"
    case "signer":
      return "Signer"
    case "custom":
      return "Custom"
  }
}

export function relaySourceDescription(source: RelaySource): string {
  switch (source) {
    case "app":
      return "Added by the app for marketplace acceleration or fallback"
    case "signer":
      return "Pulled from your signer relay list when available"
    case "custom":
      return "Added only on this device"
  }
}

export function relayPurposeLabel(purpose: RelayPurpose): string {
  switch (purpose) {
    case "out":
      return "OUT"
    case "in":
      return "IN"
    case "find":
      return "FIND"
    case "dm":
      return "DM"
  }
}

/**
 * Returns true when the given actor has no usable relays configured for the
 * relay roles that are essential to their workflow. Used to surface the
 * "Set up relays" CTA in the profile dropdown.
 *
 * - Shoppers require at least one commerce or general relay enabled for
 *   discovery (find) or reads (in).
 * - Merchants additionally require at least one merchant relay enabled for
 *   writes (out) or reads (in) so their listings/orders can publish.
 *
 * Pass `groups` to evaluate against a specific snapshot (keeps the check
 * reactive when driven from `useRelaySettings`); otherwise it reads the
 * current effective groups from storage.
 */
export function isRelaySetupIncomplete(
  actor: RelayActor,
  groups?: Partial<RelayGroups>
): boolean {
  const resolved = groups ?? getEffectiveRelayGroups()
  const commerce = resolved.commerce ?? []
  const general = resolved.general ?? []
  const merchant = resolved.merchant ?? []

  const hasCommerceOrGeneral = [...commerce, ...general].some(
    (entry) => entry.in || entry.find
  )

  if (!hasCommerceOrGeneral) return true

  if (actor === "merchant") {
    const hasMerchant = merchant.some((entry) => entry.out || entry.in)
    if (!hasMerchant) return true
  }

  return false
}
