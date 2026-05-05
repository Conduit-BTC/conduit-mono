import { config, type ConduitConfig } from "../config"

export type RelaySettingsSection = "commerce" | "public"
export type RelaySettingsSource = "default" | "manual" | "signer" | "published"
export type RelayCapabilityKey = "nip11" | "search" | "dm" | "auth" | "commerce"
export type RelayWarningKey =
  | "dmWithoutAuth"
  | "staleRelayInfo"
  | "unreachable"
  | "commercePartialSupport"

export interface RelayCapabilities {
  nip11: boolean
  search: boolean
  dm: boolean
  auth: boolean
  commerce: boolean
}

export interface RelayWarnings {
  dmWithoutAuth: boolean
  staleRelayInfo: boolean
  unreachable: boolean
  commercePartialSupport: boolean
}

export interface RelaySettingsEntry {
  url: string
  readEnabled: boolean
  writeEnabled: boolean
  section: RelaySettingsSection
  commercePriority?: number
  capabilities: RelayCapabilities
  warnings: RelayWarnings
  source?: RelaySettingsSource
  scannedAt?: number
  relayName?: string
}

export interface RelaySettingsState {
  version: number
  entries: RelaySettingsEntry[]
  updatedAt: number
}

export interface RelayPreference {
  url: string
  readEnabled: boolean
  writeEnabled: boolean
}

export interface Nip65RelayUrls {
  readRelayUrls?: readonly string[]
  writeRelayUrls?: readonly string[]
  bothRelayUrls?: readonly string[]
}

export interface RelayInfoDocument {
  name?: unknown
  supported_nips?: unknown
  limitation?: {
    auth_required?: unknown
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface RelayScanResult {
  url: string
  reachable: boolean
  relayName?: string
  capabilities: RelayCapabilities
  warnings: RelayWarnings
  scannedAt: number
}

export interface RelayScanOptions {
  timeoutMs?: number
  now?: () => number
  fetchImpl?: typeof fetch
  knownCommerceRelayUrls?: readonly string[]
}

export interface RelayPlanOptions {
  settings?: RelaySettingsState
  scope?: string | null
  storageKey?: string
  fallbackRelayUrls?: readonly string[]
  includePublicFallback?: boolean
}

export const RELAY_SETTINGS_STORAGE_VERSION = 1
export const RELAY_SETTINGS_STORAGE_KEY = "conduit:relay-settings:v1"
export const RELAY_SCAN_STALE_MS = 7 * 24 * 60 * 60 * 1_000
export const RELAY_SCAN_TIMEOUT_MS = 4_000

const EMPTY_CAPABILITIES: RelayCapabilities = {
  nip11: false,
  search: false,
  dm: false,
  auth: false,
  commerce: false,
}

const EMPTY_WARNINGS: RelayWarnings = {
  dmWithoutAuth: false,
  staleRelayInfo: false,
  unreachable: false,
  commercePartialSupport: false,
}

let activeRelaySettingsScope: string | null = null

function now(): number {
  return Date.now()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRelayInfoDocument(value: unknown): value is RelayInfoDocument {
  return (
    isRecord(value) &&
    (!("supported_nips" in value) || Array.isArray(value.supported_nips))
  )
}

function uniqueRelayUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const url of urls) {
    const result = tryNormalizeRelayUrl(url)
    if (!result.ok || seen.has(result.url)) continue
    seen.add(result.url)
    normalized.push(result.url)
  }

  return normalized
}

function getSupportedNips(info: RelayInfoDocument | null): number[] {
  const raw = info?.supported_nips
  if (!Array.isArray(raw)) return []

  return raw
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0)
}

function hasCommerceCompatibilityEvidence(
  supportedNips: readonly number[]
): boolean {
  const supportsRelayLists = supportedNips.includes(65)
  const supportsParameterizedReplaceable = supportedNips.includes(33)
  const supportsMarketSpec = supportedNips.includes(99)
  const supportsGiftWraps = supportedNips.includes(17)
  const supportsAuth = supportedNips.includes(42)

  return (
    supportsRelayLists &&
    supportsParameterizedReplaceable &&
    supportsMarketSpec &&
    supportsGiftWraps &&
    supportsAuth
  )
}

function hasPartialCommerceEvidence(supportedNips: readonly number[]): boolean {
  return (
    supportedNips.includes(33) ||
    supportedNips.includes(42) ||
    supportedNips.includes(50) ||
    supportedNips.includes(65) ||
    supportedNips.includes(99) ||
    supportedNips.includes(17)
  )
}

function getRelayName(info: RelayInfoDocument | null): string | undefined {
  return typeof info?.name === "string" && info.name.trim()
    ? info.name.trim()
    : undefined
}

function getAuthRequired(info: RelayInfoDocument | null): boolean {
  return info?.limitation?.auth_required === true
}

function withRelayFallback(
  urls: readonly string[],
  fallbackRelayUrls?: readonly string[]
): string[] {
  if (urls.length > 0) return uniqueRelayUrls(urls)
  return uniqueRelayUrls(fallbackRelayUrls ?? config.defaultRelays)
}

function getSettingsForPlan(options: RelayPlanOptions): RelaySettingsState {
  return (
    options.settings ??
    loadRelaySettings(
      options.scope ?? options.storageKey ?? activeRelaySettingsScope
    )
  )
}

function hasFreshOrSeededRead(entry: RelaySettingsEntry): boolean {
  return entry.readEnabled && !entry.warnings.unreachable
}

function hasUserEnabledWrite(entry: RelaySettingsEntry): boolean {
  return entry.writeEnabled
}

function sortByCommercePriority(
  entries: readonly RelaySettingsEntry[]
): RelaySettingsEntry[] {
  return [...entries].sort((a, b) => {
    const aPriority = a.commercePriority ?? Number.MAX_SAFE_INTEGER
    const bPriority = b.commercePriority ?? Number.MAX_SAFE_INTEGER
    if (aPriority !== bPriority) return aPriority - bPriority
    return a.url.localeCompare(b.url)
  })
}

export function normalizeRelayUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Relay URL is required")
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `wss://${trimmed}`
  const parsed = new URL(withScheme)

  if (parsed.protocol === "http:") parsed.protocol = "ws:"
  if (parsed.protocol === "https:") parsed.protocol = "wss:"
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Relay URL must use ws:// or wss://")
  }
  if (!parsed.hostname) {
    throw new Error("Relay URL must include a host")
  }

  parsed.hash = ""
  parsed.search = ""

  const pathname =
    parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}`
}

export function tryNormalizeRelayUrl(
  input: string
): { ok: true; url: string } | { ok: false; error: string } {
  try {
    return { ok: true, url: normalizeRelayUrl(input) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid relay URL",
    }
  }
}

export function getRelayInfoDocumentUrl(relayUrl: string): string {
  const parsed = new URL(normalizeRelayUrl(relayUrl))
  parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:"
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
}

export function parseNip65RelayTags(
  tags: readonly string[][]
): RelayPreference[] {
  const byUrl = new Map<string, RelayPreference>()

  for (const tag of tags) {
    if (tag[0] !== "r" || !tag[1]) continue

    const result = tryNormalizeRelayUrl(tag[1])
    if (!result.ok) continue

    const marker = tag[2]?.toLowerCase()
    const readEnabled = marker !== "write"
    const writeEnabled = marker !== "read"
    const existing = byUrl.get(result.url)

    byUrl.set(result.url, {
      url: result.url,
      readEnabled: existing?.readEnabled || readEnabled,
      writeEnabled: existing?.writeEnabled || writeEnabled,
    })
  }

  return Array.from(byUrl.values())
}

export function serializeNip65RelayTags(
  relays: readonly Pick<
    RelaySettingsEntry,
    "url" | "readEnabled" | "writeEnabled"
  >[]
): string[][] {
  const tags: string[][] = []
  const seen = new Set<string>()

  for (const relay of relays) {
    const result = tryNormalizeRelayUrl(relay.url)
    if (!result.ok || seen.has(result.url)) continue
    seen.add(result.url)

    if (!relay.readEnabled && !relay.writeEnabled) continue
    if (relay.readEnabled && relay.writeEnabled) {
      tags.push(["r", result.url])
    } else if (relay.readEnabled) {
      tags.push(["r", result.url, "read"])
    } else {
      tags.push(["r", result.url, "write"])
    }
  }

  return tags
}

export function countActiveNip65RelayTags(
  relays: readonly Pick<
    RelaySettingsEntry,
    "url" | "readEnabled" | "writeEnabled"
  >[]
): number {
  return serializeNip65RelayTags(relays).length
}

export function countActiveNip65RelayTagsFromTags(
  tags: readonly string[][]
): number {
  return parseNip65RelayTags(tags).filter(
    (preference) => preference.readEnabled || preference.writeEnabled
  ).length
}

export function assertSafeNip65RelayList(
  relays: readonly Pick<
    RelaySettingsEntry,
    "url" | "readEnabled" | "writeEnabled"
  >[]
): void {
  const activeRelayCount = countActiveNip65RelayTags(relays)
  if (activeRelayCount <= 1) {
    throw new Error(
      "Refusing to publish a tiny NIP-65 relay list. Load or add at least two active relays before publishing."
    )
  }
}

export function assertSafeNip65RelayTags(tags: readonly string[][]): void {
  const activeRelayCount = countActiveNip65RelayTagsFromTags(tags)
  if (activeRelayCount <= 1) {
    throw new Error(
      "Refusing to publish a tiny NIP-65 relay list. Load or add at least two active relays before publishing."
    )
  }
}

export function mergeNip65RelayUrls(list: Nip65RelayUrls): RelayPreference[] {
  return parseNip65RelayTags([
    ...(list.readRelayUrls ?? []).map((url) => ["r", url, "read"]),
    ...(list.writeRelayUrls ?? []).map((url) => ["r", url, "write"]),
    ...(list.bothRelayUrls ?? []).map((url) => ["r", url]),
  ])
}

export function deriveRelayScanResult(
  relayUrl: string,
  info: RelayInfoDocument | null,
  options: Pick<RelayScanOptions, "knownCommerceRelayUrls" | "now"> = {}
): RelayScanResult {
  const normalizedUrl = normalizeRelayUrl(relayUrl)
  const supportedNips = getSupportedNips(info)
  const hasSupportedNips = Array.isArray(info?.supported_nips)
  const supportsSearch = supportedNips.includes(50)
  const supportsDm = supportedNips.includes(17)
  const supportsAuth = supportedNips.includes(42) || getAuthRequired(info)
  const hasNip11 = !!info
  const commerce = hasNip11 && hasCommerceCompatibilityEvidence(supportedNips)

  const capabilities: RelayCapabilities = {
    nip11: hasNip11,
    search: supportsSearch,
    dm: supportsDm,
    auth: supportsAuth,
    commerce,
  }

  const warnings: RelayWarnings = {
    ...EMPTY_WARNINGS,
    dmWithoutAuth: supportsDm && !supportsAuth,
    staleRelayInfo: hasNip11 && !hasSupportedNips,
    commercePartialSupport:
      hasNip11 && !commerce && hasPartialCommerceEvidence(supportedNips),
  }

  return {
    url: normalizedUrl,
    reachable: hasNip11,
    relayName: getRelayName(info),
    capabilities,
    warnings,
    scannedAt: options.now?.() ?? now(),
  }
}

export function createRelaySettingsEntryFromScan(
  scan: RelayScanResult,
  existing?: RelaySettingsEntry,
  source: RelaySettingsSource = existing?.source ?? "manual"
): RelaySettingsEntry {
  const section: RelaySettingsSection = scan.capabilities.commerce
    ? "commerce"
    : "public"
  const readEnabled = existing?.readEnabled ?? scan.reachable
  const writeEnabled =
    existing?.writeEnabled ??
    (scan.reachable && scan.capabilities.commerce && !scan.warnings.unreachable)

  return {
    url: scan.url,
    readEnabled,
    writeEnabled,
    section,
    commercePriority:
      section === "commerce" ? existing?.commercePriority : undefined,
    capabilities: scan.capabilities,
    warnings: scan.warnings,
    source,
    scannedAt: scan.scannedAt,
    relayName: scan.relayName,
  }
}

export function createUnreachableRelaySettingsEntry(
  relayUrl: string,
  source: RelaySettingsSource = "manual",
  scannedAt = now(),
  existing?: RelaySettingsEntry
): RelaySettingsEntry {
  const preservePreference = !!existing && existing.source !== "default"
  const baseCapabilities = preservePreference
    ? (existing?.capabilities ?? EMPTY_CAPABILITIES)
    : EMPTY_CAPABILITIES
  return {
    url: normalizeRelayUrl(relayUrl),
    readEnabled: preservePreference ? (existing?.readEnabled ?? false) : false,
    writeEnabled: preservePreference
      ? (existing?.writeEnabled ?? false)
      : false,
    section: preservePreference ? (existing?.section ?? "public") : "public",
    commercePriority: preservePreference
      ? existing?.commercePriority
      : undefined,
    capabilities: baseCapabilities,
    warnings: {
      ...EMPTY_WARNINGS,
      ...existing?.warnings,
      staleRelayInfo: true,
      unreachable: true,
    },
    source,
    scannedAt,
    relayName: existing?.relayName,
  }
}

export async function scanRelaySettingsEntry(
  relayUrl: string,
  options: RelayScanOptions = {},
  existing?: RelaySettingsEntry
): Promise<RelaySettingsEntry> {
  const normalizedUrl = normalizeRelayUrl(relayUrl)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? RELAY_SCAN_TIMEOUT_MS
  const scannedAt = options.now?.() ?? now()

  if (!fetchImpl) {
    return createUnreachableRelaySettingsEntry(
      normalizedUrl,
      existing?.source ?? "manual",
      scannedAt,
      existing
    )
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(getRelayInfoDocumentUrl(normalizedUrl), {
      headers: { Accept: "application/nostr+json" },
      signal: controller.signal,
    })

    if (!response.ok) {
      return createUnreachableRelaySettingsEntry(
        normalizedUrl,
        existing?.source ?? "manual",
        scannedAt,
        existing
      )
    }

    const json = await response.json()
    if (!isRelayInfoDocument(json)) {
      return createUnreachableRelaySettingsEntry(
        normalizedUrl,
        existing?.source ?? "manual",
        scannedAt,
        existing
      )
    }

    const info = json
    const scan = deriveRelayScanResult(normalizedUrl, info, {
      knownCommerceRelayUrls: options.knownCommerceRelayUrls,
      now: () => scannedAt,
    })
    return createRelaySettingsEntryFromScan(scan, existing)
  } catch {
    return createUnreachableRelaySettingsEntry(
      normalizedUrl,
      existing?.source ?? "manual",
      scannedAt,
      existing
    )
  } finally {
    clearTimeout(timeoutId)
  }
}

export function createDefaultRelaySettings(
  cfg: ConduitConfig = config
): RelaySettingsState {
  const entries: RelaySettingsEntry[] = uniqueRelayUrls(cfg.defaultRelays).map(
    (url) => ({
      url,
      readEnabled: true,
      writeEnabled: false,
      section: "public",
      capabilities: EMPTY_CAPABILITIES,
      warnings: {
        ...EMPTY_WARNINGS,
        staleRelayInfo: true,
      },
      source: "default" as const,
    })
  )

  return normalizeRelaySettingsState({
    version: RELAY_SETTINGS_STORAGE_VERSION,
    entries,
    updatedAt: now(),
  })
}

export function createRelaySettingsFromPreferences(
  preferences: readonly RelayPreference[],
  source: RelaySettingsSource = "published"
): RelaySettingsState {
  return mergeRelayPreferencesIntoSettings(
    {
      version: RELAY_SETTINGS_STORAGE_VERSION,
      entries: [],
      updatedAt: now(),
    },
    preferences,
    source
  )
}

export function hasManualRelaySettings(state: RelaySettingsState): boolean {
  return state.entries.some((entry) => entry.source === "manual")
}

export function getRelaySettingsStorageKey(scope?: string | null): string {
  const normalizedScope = scope?.trim()
  return normalizedScope
    ? `${RELAY_SETTINGS_STORAGE_KEY}:${normalizedScope}`
    : `${RELAY_SETTINGS_STORAGE_KEY}:default`
}

export function getActiveRelaySettingsScope(): string | null {
  return activeRelaySettingsScope
}

export function setActiveRelaySettingsScope(scope?: string | null): void {
  activeRelaySettingsScope = scope?.trim() || null
}

export function normalizeRelaySettingsState(
  state: RelaySettingsState
): RelaySettingsState {
  const entriesByUrl = new Map<string, RelaySettingsEntry>()

  for (const entry of state.entries) {
    const result = tryNormalizeRelayUrl(entry.url)
    if (!result.ok) continue
    const capabilities = {
      ...EMPTY_CAPABILITIES,
      ...(isRecord(entry.capabilities) ? entry.capabilities : {}),
    }
    const warnings = {
      ...EMPTY_WARNINGS,
      ...(isRecord(entry.warnings) ? entry.warnings : {}),
    }
    const section: RelaySettingsSection =
      capabilities.commerce || entry.section === "commerce"
        ? "commerce"
        : "public"

    const normalizedEntry: RelaySettingsEntry = {
      ...entry,
      url: result.url,
      capabilities,
      warnings,
      section,
    }
    entriesByUrl.set(result.url, normalizedEntry)
  }

  const entries = Array.from(entriesByUrl.values())
  const commerceEntries = sortByCommercePriority(
    entries.filter((entry) => entry.section === "commerce")
  )
  const priorityByUrl = new Map(
    commerceEntries.map((entry, index) => [entry.url, index])
  )

  return {
    version: RELAY_SETTINGS_STORAGE_VERSION,
    updatedAt: state.updatedAt || now(),
    entries: entries.map((entry) =>
      entry.section === "commerce"
        ? { ...entry, commercePriority: priorityByUrl.get(entry.url) ?? 0 }
        : { ...entry, commercePriority: undefined }
    ),
  }
}

export function loadRelaySettings(scope?: string | null): RelaySettingsState {
  if (typeof window === "undefined") return createDefaultRelaySettings()

  const key = getRelaySettingsStorageKey(scope)
  const raw = window.localStorage.getItem(key)
  if (!raw) return createDefaultRelaySettings()

  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
      return createDefaultRelaySettings()
    }

    return normalizeRelaySettingsState({
      version: Number(parsed.version) || RELAY_SETTINGS_STORAGE_VERSION,
      updatedAt: Number(parsed.updatedAt) || now(),
      entries: parsed.entries.filter(
        isRecord
      ) as unknown as RelaySettingsEntry[],
    })
  } catch {
    return createDefaultRelaySettings()
  }
}

export function saveRelaySettings(
  state: RelaySettingsState,
  scope?: string | null
): RelaySettingsState {
  const normalized = normalizeRelaySettingsState({
    ...state,
    updatedAt: now(),
  })

  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      getRelaySettingsStorageKey(scope),
      JSON.stringify(normalized)
    )
  }

  return normalized
}

export function upsertRelaySettingsEntry(
  state: RelaySettingsState,
  entry: RelaySettingsEntry
): RelaySettingsState {
  const existing = state.entries.find((item) => item.url === entry.url)
  const nextEntry =
    entry.section === "commerce" && existing?.commercePriority !== undefined
      ? { ...entry, commercePriority: existing.commercePriority }
      : entry

  return normalizeRelaySettingsState({
    ...state,
    entries: [
      ...state.entries.filter((item) => item.url !== nextEntry.url),
      nextEntry,
    ],
  })
}

export function removeRelaySettingsEntry(
  state: RelaySettingsState,
  relayUrl: string
): RelaySettingsState {
  const normalizedUrl = normalizeRelayUrl(relayUrl)
  return normalizeRelaySettingsState({
    ...state,
    entries: state.entries.filter((entry) => entry.url !== normalizedUrl),
  })
}

export function updateRelaySettingsEntry(
  state: RelaySettingsState,
  relayUrl: string,
  updates: Partial<
    Pick<RelaySettingsEntry, "readEnabled" | "writeEnabled" | "source">
  >
): RelaySettingsState {
  const normalizedUrl = normalizeRelayUrl(relayUrl)
  return normalizeRelaySettingsState({
    ...state,
    entries: state.entries.map((entry) =>
      entry.url === normalizedUrl ? { ...entry, ...updates } : entry
    ),
  })
}

export function reorderCommerceRelay(
  state: RelaySettingsState,
  sourceUrl: string,
  targetUrl: string
): RelaySettingsState {
  const normalizedSource = normalizeRelayUrl(sourceUrl)
  const normalizedTarget = normalizeRelayUrl(targetUrl)
  if (normalizedSource === normalizedTarget) return state

  const commerceEntries = sortByCommercePriority(
    state.entries.filter((entry) => entry.section === "commerce")
  )
  const sourceIndex = commerceEntries.findIndex(
    (entry) => entry.url === normalizedSource
  )
  const targetIndex = commerceEntries.findIndex(
    (entry) => entry.url === normalizedTarget
  )
  if (sourceIndex < 0 || targetIndex < 0) return state

  const [moved] = commerceEntries.splice(sourceIndex, 1)
  if (!moved) return state
  commerceEntries.splice(targetIndex, 0, moved)

  const priorityByUrl = new Map(
    commerceEntries.map((entry, index) => [entry.url, index])
  )

  return normalizeRelaySettingsState({
    ...state,
    entries: state.entries.map((entry) =>
      entry.section === "commerce"
        ? {
            ...entry,
            commercePriority: priorityByUrl.get(entry.url) ?? 0,
            source: "manual" as const,
          }
        : entry
    ),
  })
}

export function mergeRelayPreferencesIntoSettings(
  state: RelaySettingsState,
  preferences: readonly RelayPreference[],
  source: RelaySettingsSource = "signer"
): RelaySettingsState {
  let next = state

  for (const preference of preferences) {
    const normalizedUrl = normalizeRelayUrl(preference.url)
    const existing = next.entries.find((entry) => entry.url === normalizedUrl)
    const capabilities: RelayCapabilities = existing?.capabilities
      ? {
          ...existing.capabilities,
        }
      : {
          ...EMPTY_CAPABILITIES,
        }
    const warnings: RelayWarnings = existing?.warnings ?? {
      ...EMPTY_WARNINGS,
      staleRelayInfo: true,
    }
    const section: RelaySettingsSection = capabilities.commerce
      ? "commerce"
      : "public"
    const preserveLocalControls = existing?.source === "manual"
    const preferPublishedControls =
      source === "published" && !preserveLocalControls
    const entry: RelaySettingsEntry = {
      url: normalizedUrl,
      readEnabled: preferPublishedControls
        ? preference.readEnabled
        : (existing?.readEnabled ?? preference.readEnabled),
      writeEnabled: preferPublishedControls
        ? preference.writeEnabled
        : (existing?.writeEnabled ?? preference.writeEnabled),
      section,
      commercePriority:
        section === "commerce" && existing?.commercePriority !== undefined
          ? existing.commercePriority
          : undefined,
      capabilities,
      warnings,
      source: preserveLocalControls ? existing.source : source,
      scannedAt: existing?.scannedAt,
      relayName: existing?.relayName,
    }
    next = upsertRelaySettingsEntry(next, entry)
  }

  return next
}

export async function readNip07RelayPreferences(): Promise<RelayPreference[]> {
  if (typeof window === "undefined" || !window.nostr?.getRelays) return []

  try {
    const relays = await window.nostr.getRelays()
    return Object.entries(relays).flatMap(([url, preference]) => {
      const result = tryNormalizeRelayUrl(url)
      if (!result.ok) return []
      return [
        {
          url: result.url,
          readEnabled: !!preference.read,
          writeEnabled: !!preference.write,
        },
      ]
    })
  } catch {
    return []
  }
}

export function getGeneralReadRelayUrls(
  options: RelayPlanOptions = {}
): string[] {
  const settings = getSettingsForPlan(options)
  const relayUrls = settings.entries
    .filter((entry) => hasFreshOrSeededRead(entry))
    .map((entry) => entry.url)
  return withRelayFallback(relayUrls, options.fallbackRelayUrls)
}

export function getGeneralWriteRelayUrls(
  options: RelayPlanOptions = {}
): string[] {
  const settings = getSettingsForPlan(options)
  return uniqueRelayUrls(
    settings.entries
      .filter((entry) => hasUserEnabledWrite(entry))
      .map((entry) => entry.url)
  )
}

export function getCommerceReadRelayUrls(
  options: RelayPlanOptions = {}
): string[] {
  const settings = getSettingsForPlan(options)
  const commerceUrls = settings.entries
    .filter((entry) => entry.section === "commerce")
    .filter((entry) => hasFreshOrSeededRead(entry))
    .map((entry) => entry.url)

  const publicUrls =
    options.includePublicFallback === false
      ? []
      : settings.entries
          .filter(
            (entry) => entry.section === "public" && hasFreshOrSeededRead(entry)
          )
          .map((entry) => entry.url)

  return withRelayFallback(
    [...commerceUrls, ...publicUrls],
    options.fallbackRelayUrls
  )
}

export function getCommerceWriteRelayUrls(
  options: RelayPlanOptions = {}
): string[] {
  const settings = getSettingsForPlan(options)
  const commerceUrls = settings.entries
    .filter((entry) => entry.section === "commerce")
    .filter((entry) => hasUserEnabledWrite(entry))
    .map((entry) => entry.url)

  const publicUrls =
    options.includePublicFallback === false
      ? []
      : settings.entries
          .filter(
            (entry) => entry.section === "public" && hasUserEnabledWrite(entry)
          )
          .map((entry) => entry.url)

  return uniqueRelayUrls([...commerceUrls, ...publicUrls])
}

export function isRelaySetupIncomplete(
  settings: RelaySettingsState = loadRelaySettings()
): boolean {
  return (
    getCommerceReadRelayUrls({ settings, fallbackRelayUrls: [] }).length ===
      0 &&
    getGeneralReadRelayUrls({ settings, fallbackRelayUrls: [] }).length === 0
  )
}
