import { config, isRetiredDefaultRelayUrl, type ConduitConfig } from "../config"

export type RelaySettingsSection = "commerce" | "public"
export type RelaySettingsSource = "default" | "manual" | "signer" | "published"
export type RelayCapabilityKey =
  | "nip11"
  | "search"
  | "dm"
  | "auth"
  | "commerce"
  | "protectedMessages"
  | "listings"
  | "cleanup"
export type RelayWarningKey =
  | "dmWithoutAuth"
  | "staleRelayInfo"
  | "unreachable"
  | "commercePartialSupport"
export type RelayCapabilityObservationStatus =
  | "unknown"
  | "advertised"
  | "known"
  | "observed"
  | "failed"
export type RelayCapabilityConfidence =
  | "none"
  | "advertised"
  | "known"
  | "observed"
export type RelayCapabilityEvidence =
  | "nip11"
  | "relay-limitation"
  | "conduit-commerce-profile"
  | "active-probe"

export interface RelayCapabilities {
  nip11: boolean
  search: boolean
  /**
   * Legacy alias for protectedMessages. Keep populated while callers migrate.
   */
  dm: boolean
  auth: boolean
  commerce: boolean
  protectedMessages?: boolean
  listings?: boolean
  cleanup?: boolean
}

export interface RelayCapabilityObservation {
  supported: boolean
  status: RelayCapabilityObservationStatus
  confidence: RelayCapabilityConfidence
  evidence: RelayCapabilityEvidence[]
  checkedAt?: number
  latencyMs?: number
  failureMode?: string
}

export interface RelayCapabilityObservations {
  search: RelayCapabilityObservation
  auth: RelayCapabilityObservation
  protectedMessages: RelayCapabilityObservation
  listings: RelayCapabilityObservation
  cleanup: RelayCapabilityObservation
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
  observations?: RelayCapabilityObservations
  commerceProfileVersion?: number
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
  observations: RelayCapabilityObservations
  commerceProfileVersion?: number
  scannedAt: number
}

export interface RelayScanOptions {
  timeoutMs?: number
  now?: () => number
  fetchImpl?: typeof fetch
  commerceRelayUrls?: readonly string[]
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
export const RELAY_COMMERCE_PROFILE_VERSION = 1

const EMPTY_CAPABILITIES: RelayCapabilities = {
  nip11: false,
  search: false,
  dm: false,
  auth: false,
  commerce: false,
  protectedMessages: false,
  listings: false,
  cleanup: false,
}

const EMPTY_WARNINGS: RelayWarnings = {
  dmWithoutAuth: false,
  staleRelayInfo: false,
  unreachable: false,
  commercePartialSupport: false,
}

let activeRelaySettingsScope: string | null = null
const relaySettingsListeners = new Set<(scope: string | null) => void>()

function now(): number {
  return Date.now()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createUnknownObservation(): RelayCapabilityObservation {
  return {
    supported: false,
    status: "unknown",
    confidence: "none",
    evidence: [],
  }
}

function createCapabilityObservation(input: {
  supported: boolean
  status: RelayCapabilityObservationStatus
  confidence: RelayCapabilityConfidence
  evidence: RelayCapabilityEvidence[]
  checkedAt: number
}): RelayCapabilityObservation {
  if (!input.supported) return createUnknownObservation()

  return {
    supported: true,
    status: input.status,
    confidence: input.confidence,
    evidence: input.evidence,
    checkedAt: input.checkedAt,
  }
}

function normalizeRelayCapabilityObservation(
  value: unknown
): RelayCapabilityObservation {
  if (!isRecord(value)) return createUnknownObservation()

  const statuses: RelayCapabilityObservationStatus[] = [
    "unknown",
    "advertised",
    "known",
    "observed",
    "failed",
  ]
  const confidences: RelayCapabilityConfidence[] = [
    "none",
    "advertised",
    "known",
    "observed",
  ]
  const evidenceKinds: RelayCapabilityEvidence[] = [
    "nip11",
    "relay-limitation",
    "conduit-commerce-profile",
    "active-probe",
  ]
  const status = statuses.includes(
    value.status as RelayCapabilityObservationStatus
  )
    ? (value.status as RelayCapabilityObservationStatus)
    : "unknown"
  const confidence = confidences.includes(
    value.confidence as RelayCapabilityConfidence
  )
    ? (value.confidence as RelayCapabilityConfidence)
    : "none"
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((item): item is RelayCapabilityEvidence =>
        evidenceKinds.includes(item as RelayCapabilityEvidence)
      )
    : []

  return {
    supported: value.supported === true,
    status,
    confidence,
    evidence,
    checkedAt:
      typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt)
        ? value.checkedAt
        : undefined,
    latencyMs:
      typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs)
        ? value.latencyMs
        : undefined,
    failureMode:
      typeof value.failureMode === "string" && value.failureMode.trim()
        ? value.failureMode.trim()
        : undefined,
  }
}

function normalizeRelayCapabilityObservations(
  value: unknown
): RelayCapabilityObservations {
  const observations = isRecord(value) ? value : {}

  return {
    search: normalizeRelayCapabilityObservation(observations.search),
    auth: normalizeRelayCapabilityObservation(observations.auth),
    protectedMessages: normalizeRelayCapabilityObservation(
      observations.protectedMessages
    ),
    listings: normalizeRelayCapabilityObservation(observations.listings),
    cleanup: normalizeRelayCapabilityObservation(observations.cleanup),
  }
}

function normalizeRelayCapabilities(value: unknown): RelayCapabilities {
  const capabilities = isRecord(value) ? value : {}
  const protectedMessages =
    capabilities.protectedMessages === true || capabilities.dm === true
  const listings = capabilities.listings === true
  const cleanup = capabilities.cleanup === true
  const auth = capabilities.auth === true
  const commerce =
    capabilities.commerce === true &&
    listings &&
    protectedMessages &&
    cleanup &&
    auth

  return {
    nip11: capabilities.nip11 === true,
    search: capabilities.search === true,
    dm: protectedMessages,
    auth,
    commerce,
    protectedMessages,
    listings,
    cleanup,
  }
}

function normalizeRelayWarnings(value: unknown): RelayWarnings {
  const warnings = isRecord(value) ? value : {}

  return {
    dmWithoutAuth: warnings.dmWithoutAuth === true,
    staleRelayInfo: warnings.staleRelayInfo === true,
    unreachable: warnings.unreachable === true,
    commercePartialSupport: warnings.commercePartialSupport === true,
  }
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

function hasKnownCommerceProfileEvidence(
  relayUrl: string,
  commerceRelayUrls: readonly string[] = config.commerceRelayUrls
): boolean {
  const normalizedUrl = normalizeRelayUrl(relayUrl)
  return uniqueRelayUrls(commerceRelayUrls).includes(normalizedUrl)
}

function hasPartialCommerceEvidence(input: {
  listings: boolean
  protectedMessages: boolean
  cleanup: boolean
}): boolean {
  return input.listings || input.protectedMessages || input.cleanup
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

function createDefaultRelaySettingsEntry(url: string): RelaySettingsEntry {
  return {
    url,
    readEnabled: true,
    writeEnabled: true,
    section: "public",
    capabilities: EMPTY_CAPABILITIES,
    warnings: {
      ...EMPTY_WARNINGS,
      staleRelayInfo: true,
    },
    source: "default",
  }
}

function appendDefaultRelaySettingsEntries(
  state: RelaySettingsState,
  cfg: ConduitConfig = config
): RelaySettingsState {
  const existingUrls = new Set(state.entries.map((entry) => entry.url))
  const missingDefaults = uniqueRelayUrls(
    cfg.defaultRelays.filter((url) => !isRetiredDefaultRelayUrl(url))
  )
    .filter((url) => !existingUrls.has(url))
    .map(createDefaultRelaySettingsEntry)

  if (missingDefaults.length === 0) return state

  return normalizeRelaySettingsState({
    ...state,
    entries: [...state.entries, ...missingDefaults],
  })
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

function sortCommerceRelayUrls(
  entries: readonly RelaySettingsEntry[],
  predicate: (entry: RelaySettingsEntry) => boolean
): string[] {
  return sortByCommercePriority(
    entries.filter((entry) => entry.section === "commerce").filter(predicate)
  ).map((entry) => entry.url)
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

export function countWriteNip65Relays(
  relays: readonly Pick<
    RelaySettingsEntry,
    "url" | "readEnabled" | "writeEnabled"
  >[]
): number {
  return serializeNip65RelayTags(relays).filter((tag) => tag[2] !== "read")
    .length
}

export function countWriteNip65RelayTags(tags: readonly string[][]): number {
  return parseNip65RelayTags(tags).filter(
    (preference) => preference.writeEnabled
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
  const writeRelayCount = countWriteNip65Relays(relays)
  if (writeRelayCount < 1) {
    throw new Error(
      "Refusing to publish a NIP-65 relay list without an OUT relay. Enable write access on at least one relay before publishing."
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
  const writeRelayCount = countWriteNip65RelayTags(tags)
  if (writeRelayCount < 1) {
    throw new Error(
      "Refusing to publish a NIP-65 relay list without an OUT relay. Enable write access on at least one relay before publishing."
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
  options: Pick<RelayScanOptions, "now" | "commerceRelayUrls"> = {}
): RelayScanResult {
  const normalizedUrl = normalizeRelayUrl(relayUrl)
  const supportedNips = getSupportedNips(info)
  const hasSupportedNips = Array.isArray(info?.supported_nips)
  const scannedAt = options.now?.() ?? now()
  const hasKnownCommerceProfile = hasKnownCommerceProfileEvidence(
    normalizedUrl,
    options.commerceRelayUrls
  )
  const supportsSearch = supportedNips.includes(50)
  const advertisesProtectedMessages = supportedNips.includes(59)
  const supportsProtectedMessages =
    advertisesProtectedMessages || hasKnownCommerceProfile
  const advertisesCleanup =
    supportedNips.includes(9) || supportedNips.includes(62)
  const supportsCleanup = advertisesCleanup || hasKnownCommerceProfile
  const supportsAuth = supportedNips.includes(42) || getAuthRequired(info)
  const supportsListings = hasKnownCommerceProfile
  const hasNip11 = !!info
  const commerce =
    hasNip11 &&
    supportsListings &&
    supportsProtectedMessages &&
    supportsCleanup &&
    supportsAuth

  const capabilities: RelayCapabilities = {
    nip11: hasNip11,
    search: supportsSearch,
    dm: supportsProtectedMessages,
    auth: supportsAuth,
    commerce,
    protectedMessages: supportsProtectedMessages,
    listings: supportsListings,
    cleanup: supportsCleanup,
  }

  const observations: RelayCapabilityObservations = {
    search: createCapabilityObservation({
      supported: supportsSearch,
      status: "advertised",
      confidence: "advertised",
      evidence: ["nip11"],
      checkedAt: scannedAt,
    }),
    auth: createCapabilityObservation({
      supported: supportsAuth,
      status: "advertised",
      confidence: "advertised",
      evidence: getAuthRequired(info) ? ["relay-limitation"] : ["nip11"],
      checkedAt: scannedAt,
    }),
    protectedMessages: createCapabilityObservation({
      supported: supportsProtectedMessages,
      status: advertisesProtectedMessages ? "advertised" : "known",
      confidence: advertisesProtectedMessages ? "advertised" : "known",
      evidence: advertisesProtectedMessages
        ? ["nip11"]
        : ["conduit-commerce-profile"],
      checkedAt: scannedAt,
    }),
    listings: createCapabilityObservation({
      supported: supportsListings,
      status: "known",
      confidence: "known",
      evidence: ["conduit-commerce-profile"],
      checkedAt: scannedAt,
    }),
    cleanup: createCapabilityObservation({
      supported: supportsCleanup,
      status: advertisesCleanup ? "advertised" : "known",
      confidence: advertisesCleanup ? "advertised" : "known",
      evidence: advertisesCleanup ? ["nip11"] : ["conduit-commerce-profile"],
      checkedAt: scannedAt,
    }),
  }

  const warnings: RelayWarnings = {
    ...EMPTY_WARNINGS,
    dmWithoutAuth: supportsProtectedMessages && !supportsAuth,
    staleRelayInfo: hasNip11 && !hasSupportedNips,
    commercePartialSupport:
      hasNip11 &&
      !commerce &&
      hasPartialCommerceEvidence({
        listings: supportsListings,
        protectedMessages: supportsProtectedMessages,
        cleanup: supportsCleanup,
      }),
  }

  return {
    url: normalizedUrl,
    reachable: hasNip11,
    relayName: getRelayName(info),
    capabilities,
    warnings,
    observations,
    commerceProfileVersion: hasKnownCommerceProfile
      ? RELAY_COMMERCE_PROFILE_VERSION
      : undefined,
    scannedAt,
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
  const usesCanonicalDefaults = source === "default"
  const readEnabled = usesCanonicalDefaults
    ? true
    : (existing?.readEnabled ?? scan.reachable)
  const writeEnabled = usesCanonicalDefaults
    ? true
    : (existing?.writeEnabled ??
      (scan.reachable &&
        scan.capabilities.commerce &&
        !scan.warnings.unreachable))

  return {
    url: scan.url,
    readEnabled,
    writeEnabled,
    section,
    commercePriority:
      section === "commerce" ? existing?.commercePriority : undefined,
    capabilities: scan.capabilities,
    warnings: scan.warnings,
    observations: scan.observations,
    commerceProfileVersion: scan.commerceProfileVersion,
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
  const usesCanonicalDefaults = source === "default"
  const baseCapabilities = preservePreference
    ? normalizeRelayCapabilities(existing?.capabilities)
    : {
        ...EMPTY_CAPABILITIES,
      }
  return {
    url: normalizeRelayUrl(relayUrl),
    readEnabled: usesCanonicalDefaults
      ? true
      : preservePreference
        ? (existing?.readEnabled ?? false)
        : false,
    writeEnabled: usesCanonicalDefaults
      ? true
      : preservePreference
        ? (existing?.writeEnabled ?? false)
        : false,
    section: "public",
    commercePriority: preservePreference
      ? existing?.commercePriority
      : undefined,
    capabilities: {
      ...baseCapabilities,
      commerce: false,
      listings: false,
    },
    warnings: {
      ...EMPTY_WARNINGS,
      staleRelayInfo: true,
      unreachable: true,
    },
    observations: preservePreference
      ? normalizeRelayCapabilityObservations(existing?.observations)
      : undefined,
    commerceProfileVersion: undefined,
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
      now: () => scannedAt,
      commerceRelayUrls: options.commerceRelayUrls,
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
  const entries: RelaySettingsEntry[] = uniqueRelayUrls(
    cfg.defaultRelays.filter((url) => !isRetiredDefaultRelayUrl(url))
  ).map(createDefaultRelaySettingsEntry)

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

export function subscribeRelaySettingsChanges(
  listener: (scope: string | null) => void
): () => void {
  relaySettingsListeners.add(listener)
  return () => relaySettingsListeners.delete(listener)
}

function notifyRelaySettingsChanged(scope?: string | null): void {
  const normalizedScope = scope?.trim() || null
  relaySettingsListeners.forEach((listener) => listener(normalizedScope))
}

export function normalizeRelaySettingsState(
  state: RelaySettingsState
): RelaySettingsState {
  const entriesByUrl = new Map<string, RelaySettingsEntry>()

  for (const entry of state.entries) {
    const result = tryNormalizeRelayUrl(entry.url)
    if (!result.ok) continue
    const capabilities = normalizeRelayCapabilities(entry.capabilities)
    const warnings = normalizeRelayWarnings(entry.warnings)
    const observations = normalizeRelayCapabilityObservations(
      entry.observations
    )
    const section: RelaySettingsSection =
      capabilities.commerce && !warnings.unreachable ? "commerce" : "public"

    const normalizedEntry: RelaySettingsEntry = {
      ...entry,
      url: result.url,
      readEnabled: entry.source === "default" ? true : entry.readEnabled,
      writeEnabled: entry.source === "default" ? true : entry.writeEnabled,
      capabilities,
      warnings,
      observations,
      commerceProfileVersion: capabilities.commerce
        ? (entry.commerceProfileVersion ?? RELAY_COMMERCE_PROFILE_VERSION)
        : undefined,
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
        : {
            ...entry,
            commercePriority: entry.warnings.unreachable
              ? entry.commercePriority
              : undefined,
          }
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

    return appendDefaultRelaySettingsEntries(
      normalizeRelaySettingsState({
        version: Number(parsed.version) || RELAY_SETTINGS_STORAGE_VERSION,
        updatedAt: Number(parsed.updatedAt) || now(),
        entries: parsed.entries.filter(
          isRecord
        ) as unknown as RelaySettingsEntry[],
      })
    )
  } catch {
    return createDefaultRelaySettings()
  }
}

export function saveRelaySettings(
  state: RelaySettingsState,
  scope?: string | null
): RelaySettingsState {
  const normalized = appendDefaultRelaySettingsEntries(
    normalizeRelaySettingsState({
      ...state,
      updatedAt: now(),
    })
  )

  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      getRelaySettingsStorageKey(scope),
      JSON.stringify(normalized)
    )
  }

  notifyRelaySettingsChanged(scope)

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

export function getPublishableRelaySettingsEntries(
  entries: readonly RelaySettingsEntry[]
): RelaySettingsEntry[] {
  return entries.filter(
    (entry) =>
      entry.source !== "default" && (entry.readEnabled || entry.writeEnabled)
  )
}

export function includeDefaultRelaySettingsEntries(
  state: RelaySettingsState
): RelaySettingsState {
  return normalizeRelaySettingsState({
    ...state,
    entries: state.entries.map((entry) =>
      entry.source === "default" ? { ...entry, source: "manual" } : entry
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
    const capabilities = existing?.capabilities
      ? normalizeRelayCapabilities(existing.capabilities)
      : {
          ...EMPTY_CAPABILITIES,
        }
    const warnings = existing?.warnings
      ? normalizeRelayWarnings(existing.warnings)
      : {
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
      observations: existing?.observations
        ? normalizeRelayCapabilityObservations(existing.observations)
        : undefined,
      commerceProfileVersion:
        capabilities.commerce && existing?.commerceProfileVersion
          ? existing.commerceProfileVersion
          : undefined,
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
  const commerceUrls = sortCommerceRelayUrls(settings.entries, (entry) =>
    hasFreshOrSeededRead(entry)
  )

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
  const commerceUrls = sortCommerceRelayUrls(settings.entries, (entry) =>
    hasUserEnabledWrite(entry)
  )

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
