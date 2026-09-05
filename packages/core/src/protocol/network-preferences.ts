import {
  accountNetworkDiscoveryRelayUrls,
  normalizeOwnerRelayListPubkey,
  resolveOwnerRelayList,
  type OwnerRelayListResolution,
  type ResolveOwnerRelayListOptions,
} from "./owner-relay-list-evidence"
import {
  clearInboxMigrationRecoveryRelayUrls,
  MAX_LEGACY_INBOX_READ_RECOVERY_RELAYS,
  resolveInboxDeclaration,
  setInboxMigrationRecoveryRelayUrls,
  type InboxDeclarationResolution,
  type ResolveInboxDeclarationOptions,
} from "./private-message-routing"
import {
  createRelaySettingsFromPreferences,
  getRelaySettingsStorageKey,
  loadRelaySettings,
  normalizeRelaySettingsState,
  setAccountRelaySettingsProjection,
  tryNormalizeRelayUrl,
  type RelaySettingsEntry,
  type RelaySettingsState,
} from "./relay-settings"
import { getAccountRelayScope, getLegacySignedInRelayScopes } from "./session"

const LEGACY_MIGRATION_KEY_PREFIX = "conduit:network-legacy-migration:v1"
const LEGACY_READ_RECOVERY_KEY_PREFIX =
  "conduit:network-legacy-read-recovery:v1"
export const LEGACY_RELAY_READ_RECOVERY_VERSION = 1

export type NetworkRoleMembership = "published" | "pending" | "draft" | null

export interface NetworkPreferenceRow {
  url: string
  position: number
  read: NetworkRoleMembership
  write: NetworkRoleMembership
  privateInbox: NetworkRoleMembership
  draftRead: boolean
  draftWrite: boolean
}

export interface AccountNetworkPreferencesProjection {
  pubkey: string
  relayScope: string
  rows: NetworkPreferenceRow[]
  relayListState: OwnerRelayListResolution["state"]
  relayListStale: boolean
  inboxState: InboxDeclarationResolution["state"]
  inboxStale: boolean
  runtimeRelaySettings: RelaySettingsState
}

export interface LegacyRelayReadRecoveryRecord {
  version: typeof LEGACY_RELAY_READ_RECOVERY_VERSION
  readRelayUrls: string[]
}

type LegacyRelaySettingsMigrationPhase = "prepared" | "complete"

interface LegacyRelaySettingsMigrationMarker {
  version: typeof LEGACY_RELAY_READ_RECOVERY_VERSION
  phase: LegacyRelaySettingsMigrationPhase
  draftFingerprint: string | null
  recoveryFingerprint: string | null
}

export type LegacyRelaySettingsMigrationStatus =
  | "not_applicable"
  | "deferred"
  | "seeded_draft"
  | "retired_signed_wins"
  | "retired_empty"
  | "already_complete"
  | "retryable"

export type LegacyRelayReadRecoveryClearStatus =
  "cleared" | "already_clear" | "not_applicable" | "retryable"

export interface AccountNetworkPreferencesReconciliation {
  projection: AccountNetworkPreferencesProjection
  ownerRelayList: OwnerRelayListResolution
  inboxDeclaration: InboxDeclarationResolution
  legacyMigration: LegacyRelaySettingsMigrationStatus
}

export interface LegacyRelaySettingsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ReconcileAccountNetworkPreferencesOptions {
  /** Both lookups receive this same app-independent bounded source set. */
  relayUrls?: readonly string[]
  ownerRelayList?: ResolveOwnerRelayListOptions
  inboxDeclaration?: ResolveInboxDeclarationOptions
  storage?: LegacyRelaySettingsStorage
  resolveOwner?: typeof resolveOwnerRelayList
  resolveInbox?: typeof resolveInboxDeclaration
}

function migrationMarkerKey(pubkey: string): string {
  return `${LEGACY_MIGRATION_KEY_PREFIX}:${pubkey}`
}

function browserStorage(): LegacyRelaySettingsStorage | undefined {
  if (typeof window === "undefined") return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createEmptyRelaySettings(): RelaySettingsState {
  return { version: 1, entries: [], updatedAt: 0 }
}

/** Deterministic integrity token; this is not a cryptographic claim. */
function storageValueFingerprint(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let hash = 14_695_981_039_346_656_037n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n)
  }
  return `fnv1a64:${bytes.length}:${hash.toString(16).padStart(16, "0")}`
}

function legacyReadRecoveryKey(pubkey: string): string {
  return `${LEGACY_READ_RECOVERY_KEY_PREFIX}:${pubkey}`
}

function parseRelaySettingsStorageValue(
  raw: string | null
): RelaySettingsState | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return null
    return normalizeRelaySettingsState({
      version: typeof parsed.version === "number" ? parsed.version : 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      entries: parsed.entries.filter(
        isRecord
      ) as unknown as RelaySettingsEntry[],
    })
  } catch {
    return null
  }
}

function readRelaySettingsFromStorage(
  scope: string,
  storage: LegacyRelaySettingsStorage
): RelaySettingsState {
  try {
    const raw = storage.getItem(getRelaySettingsStorageKey(scope))
    const settings = parseRelaySettingsStorageValue(raw)
    return settings
      ? normalizeRelaySettingsState({
          ...settings,
          entries: settings.entries.filter(
            (entry) => entry.source !== "default"
          ),
        })
      : createEmptyRelaySettings()
  } catch {
    return createEmptyRelaySettings()
  }
}

interface LegacyRelaySettingsSnapshot {
  legacyKeys: string[]
  draft: RelaySettingsState
  readRelayUrls: string[]
}

function readLegacyRelaySettingsSnapshot(
  pubkey: string,
  storage: LegacyRelaySettingsStorage
): LegacyRelaySettingsSnapshot {
  const candidates = getLegacySignedInRelayScopes(pubkey)
    .flatMap((scope) => {
      const key = getRelaySettingsStorageKey(scope)
      const raw = storage.getItem(key)
      if (raw === null) return []
      const settings = parseRelaySettingsStorageValue(raw)
      if (!settings) {
        throw new Error("Legacy relay settings could not be verified")
      }
      return [{ key, scope, settings }]
    })
    .sort((left, right) => {
      const updatedAt = left.settings.updatedAt - right.settings.updatedAt
      return updatedAt !== 0 ? updatedAt : left.scope.localeCompare(right.scope)
    })
  const byUrl = new Map<string, RelaySettingsEntry>()
  for (const candidate of candidates) {
    for (const entry of candidate.settings.entries) {
      if (entry.source === "default") continue
      const normalized = tryNormalizeRelayUrl(entry.url)
      if (!normalized.ok) continue
      const normalizedEntry = {
        ...structuredClone(entry),
        url: normalized.url,
        source: "manual" as const,
      }
      byUrl.set(normalized.url, normalizedEntry)
    }
  }
  const updatedAt = Math.max(
    1,
    ...candidates.map((candidate) => candidate.settings.updatedAt)
  )
  const readRelayUrls: string[] = []
  for (const entry of byUrl.values()) {
    if (entry.readEnabled) readRelayUrls.push(entry.url)
  }
  readRelayUrls.sort()
  return {
    legacyKeys: candidates.map((candidate) => candidate.key),
    draft: normalizeRelaySettingsState({
      version: 1,
      entries: Array.from(byUrl.values()),
      updatedAt,
    }),
    readRelayUrls: readRelayUrls.slice(
      0,
      MAX_LEGACY_INBOX_READ_RECOVERY_RELAYS
    ),
  }
}

function serializeLegacyReadRecovery(readRelayUrls: readonly string[]): string {
  const record: LegacyRelayReadRecoveryRecord = {
    version: LEGACY_RELAY_READ_RECOVERY_VERSION,
    readRelayUrls: [...readRelayUrls].slice(
      0,
      MAX_LEGACY_INBOX_READ_RECOVERY_RELAYS
    ),
  }
  return JSON.stringify(record)
}

function parseLegacyReadRecovery(
  raw: string | null
): LegacyRelayReadRecoveryRecord | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      !isRecord(parsed) ||
      parsed.version !== LEGACY_RELAY_READ_RECOVERY_VERSION ||
      !Array.isArray(parsed.readRelayUrls) ||
      parsed.readRelayUrls.length > MAX_LEGACY_INBOX_READ_RECOVERY_RELAYS ||
      !parsed.readRelayUrls.every((url) => typeof url === "string")
    ) {
      return null
    }
    const readRelayUrls = parsed.readRelayUrls as string[]
    const normalized = readRelayUrls.map((url) => tryNormalizeRelayUrl(url))
    if (
      normalized.some((result) => !result.ok) ||
      normalized.some(
        (result, index) => result.ok && result.url !== readRelayUrls[index]
      )
    ) {
      return null
    }
    if (new Set(readRelayUrls).size !== readRelayUrls.length) return null
    const sortedReadRelayUrls = [...readRelayUrls].sort()
    if (
      readRelayUrls.some((url, index) => url !== sortedReadRelayUrls[index])
    ) {
      return null
    }
    return {
      version: LEGACY_RELAY_READ_RECOVERY_VERSION,
      readRelayUrls: [...readRelayUrls],
    }
  } catch {
    return null
  }
}

function serializeMigrationMarker(
  marker: LegacyRelaySettingsMigrationMarker
): string {
  return JSON.stringify(marker)
}

function parseMigrationMarker(
  raw: string | null
): LegacyRelaySettingsMigrationMarker | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      !isRecord(parsed) ||
      parsed.version !== LEGACY_RELAY_READ_RECOVERY_VERSION ||
      (parsed.phase !== "prepared" && parsed.phase !== "complete") ||
      (parsed.draftFingerprint !== null &&
        typeof parsed.draftFingerprint !== "string") ||
      (parsed.recoveryFingerprint !== null &&
        typeof parsed.recoveryFingerprint !== "string")
    ) {
      return null
    }
    return {
      version: LEGACY_RELAY_READ_RECOVERY_VERSION,
      phase: parsed.phase,
      draftFingerprint: parsed.draftFingerprint,
      recoveryFingerprint: parsed.recoveryFingerprint,
    }
  } catch {
    return null
  }
}

function isMigrationTombstone(
  marker: LegacyRelaySettingsMigrationMarker | null
): boolean {
  return Boolean(
    marker?.phase === "complete" &&
    marker.draftFingerprint === null &&
    marker.recoveryFingerprint === null
  )
}

function hasMigrationTombstone(
  pubkey: string,
  storage: LegacyRelaySettingsStorage
): boolean {
  try {
    return isMigrationTombstone(
      parseMigrationMarker(storage.getItem(migrationMarkerKey(pubkey)))
    )
  } catch {
    return false
  }
}

function persistAndVerify(
  storage: LegacyRelaySettingsStorage,
  key: string,
  value: string
): boolean {
  storage.setItem(key, value)
  return storage.getItem(key) === value
}

function removeAndVerify(
  storage: LegacyRelaySettingsStorage,
  key: string
): boolean {
  storage.removeItem(key)
  return storage.getItem(key) === null
}

function getCommittedLegacyRelayReadRecoveryStrict(
  pubkey: string,
  storage: LegacyRelaySettingsStorage
): LegacyRelayReadRecoveryRecord | null {
  const marker = parseMigrationMarker(
    storage.getItem(migrationMarkerKey(pubkey))
  )
  if (!marker?.recoveryFingerprint) return null
  const recoveryRaw = storage.getItem(legacyReadRecoveryKey(pubkey))
  if (
    recoveryRaw === null ||
    storageValueFingerprint(recoveryRaw) !== marker.recoveryFingerprint
  ) {
    return null
  }
  return parseLegacyReadRecovery(recoveryRaw)
}

export function getCommittedLegacyRelayReadRecovery(
  pubkey: string,
  storage: LegacyRelaySettingsStorage | undefined = browserStorage()
): LegacyRelayReadRecoveryRecord | null {
  const normalized = normalizeOwnerRelayListPubkey(pubkey)
  if (!normalized || !storage) return null
  try {
    return getCommittedLegacyRelayReadRecoveryStrict(normalized, storage)
  } catch {
    return null
  }
}

function isCompleteOwnerRelayListAbsence(
  resolution: OwnerRelayListResolution
): boolean {
  return (
    resolution.state === "not_observed" &&
    resolution.lookup.coverage === "complete" &&
    !resolution.lookup.hadEvent
  )
}

function retireLegacyRelaySettingsKeys(
  pubkey: string,
  storage: LegacyRelaySettingsStorage
): boolean {
  for (const scope of getLegacySignedInRelayScopes(pubkey)) {
    if (!removeAndVerify(storage, getRelaySettingsStorageKey(scope))) {
      return false
    }
  }
  return true
}

/**
 * Discard migration-only compatibility state without deleting a draft that the
 * user changed after migration. Callers may explicitly discard the current
 * draft when that is the user's requested action.
 */
export function clearLegacyRelayReadRecovery(input: {
  pubkey: string
  accountScope?: string
  storage?: LegacyRelaySettingsStorage
  discardMigratedDraft?: boolean
}): LegacyRelayReadRecoveryClearStatus {
  const pubkey = normalizeOwnerRelayListPubkey(input.pubkey)
  const storage = input.storage ?? browserStorage()
  if (!pubkey || !storage) return "not_applicable"
  const accountScope = input.accountScope ?? getAccountRelayScope(pubkey)
  if (accountScope !== getAccountRelayScope(pubkey)) return "not_applicable"

  try {
    const markerKey = migrationMarkerKey(pubkey)
    const recoveryKey = legacyReadRecoveryKey(pubkey)
    const draftKey = getRelaySettingsStorageKey(accountScope)
    const markerRaw = storage.getItem(markerKey)
    const recoveryRaw = storage.getItem(recoveryKey)
    const draftRaw = storage.getItem(draftKey)
    const marker = parseMigrationMarker(markerRaw)
    const ownsCurrentDraft = Boolean(
      marker?.draftFingerprint &&
      draftRaw !== null &&
      storageValueFingerprint(draftRaw) === marker.draftFingerprint
    )
    const discardDraft = Boolean(
      draftRaw !== null && (input.discardMigratedDraft || ownsCurrentDraft)
    )
    const hadLegacyState = getLegacySignedInRelayScopes(pubkey).some(
      (scope) => storage.getItem(getRelaySettingsStorageKey(scope)) !== null
    )
    const hadMigrationState =
      (markerRaw !== null && !isMigrationTombstone(marker)) ||
      recoveryRaw !== null ||
      discardDraft ||
      hadLegacyState

    if (discardDraft && !removeAndVerify(storage, draftKey)) return "retryable"
    const tombstoneRaw = serializeMigrationMarker({
      version: LEGACY_RELAY_READ_RECOVERY_VERSION,
      phase: "complete",
      draftFingerprint: null,
      recoveryFingerprint: null,
    })
    if (!persistAndVerify(storage, markerKey, tombstoneRaw)) return "retryable"
    clearInboxMigrationRecoveryRelayUrls(pubkey)
    if (recoveryRaw !== null && !removeAndVerify(storage, recoveryKey)) {
      return "retryable"
    }
    if (!retireLegacyRelaySettingsKeys(pubkey, storage)) {
      return "retryable"
    }
    return hadMigrationState ? "cleared" : "already_clear"
  } catch {
    return "retryable"
  }
}

/**
 * Begin retiring app-local relay settings only after positive signed evidence
 * or a complete bounded absence. Without a verified migration marker, partial
 * and unavailable reads leave every key untouched. A verified marker or
 * tombstone may continue cleanup without re-importing retired state.
 */
export function migrateLegacyRelaySettingsDraft(input: {
  pubkey: string
  accountScope: string
  ownerRelayList: OwnerRelayListResolution
  storage?: LegacyRelaySettingsStorage
}): LegacyRelaySettingsMigrationStatus {
  const storage = input.storage ?? browserStorage()
  const pubkey = normalizeOwnerRelayListPubkey(input.pubkey)
  if (
    !storage ||
    !pubkey ||
    input.accountScope !== getAccountRelayScope(pubkey)
  ) {
    return "not_applicable"
  }

  try {
    const hasSignedRelayList = Boolean(input.ownerRelayList.current)
    const markerKey = migrationMarkerKey(pubkey)
    const recoveryKey = legacyReadRecoveryKey(pubkey)
    const markerRaw = storage.getItem(markerKey)
    const marker = parseMigrationMarker(markerRaw)
    if (markerRaw !== null && !marker) return "retryable"

    if (isMigrationTombstone(marker)) {
      clearInboxMigrationRecoveryRelayUrls(pubkey)
      if (
        storage.getItem(recoveryKey) !== null &&
        !removeAndVerify(storage, recoveryKey)
      ) {
        return "retryable"
      }
      if (!retireLegacyRelaySettingsKeys(pubkey, storage)) return "retryable"
      return hasSignedRelayList ? "retired_signed_wins" : "already_complete"
    }
    if (
      !marker &&
      !hasSignedRelayList &&
      !isCompleteOwnerRelayListAbsence(input.ownerRelayList)
    ) {
      return "deferred"
    }

    if (marker) {
      if (
        marker.recoveryFingerprint &&
        !getCommittedLegacyRelayReadRecoveryStrict(pubkey, storage)
      ) {
        return "retryable"
      }
      let settledMarker = marker
      if (hasSignedRelayList && marker.draftFingerprint) {
        const draftKey = getRelaySettingsStorageKey(input.accountScope)
        const draftRaw = storage.getItem(draftKey)
        if (
          draftRaw !== null &&
          storageValueFingerprint(draftRaw) === marker.draftFingerprint &&
          !removeAndVerify(storage, draftKey)
        ) {
          return "retryable"
        }
        settledMarker = { ...marker, draftFingerprint: null }
        if (
          !persistAndVerify(
            storage,
            markerKey,
            serializeMigrationMarker(settledMarker)
          )
        ) {
          return "retryable"
        }
      }
      if (!retireLegacyRelaySettingsKeys(pubkey, storage)) return "retryable"
      if (settledMarker.phase === "complete") {
        return hasSignedRelayList ? "retired_signed_wins" : "already_complete"
      }
      if (!settledMarker.recoveryFingerprint) return "retryable"
      const completeRaw = serializeMigrationMarker({
        ...settledMarker,
        phase: "complete",
      })
      if (!persistAndVerify(storage, markerKey, completeRaw)) return "retryable"
      return hasSignedRelayList ? "retired_signed_wins" : "seeded_draft"
    }

    const legacy = readLegacyRelaySettingsSnapshot(pubkey, storage)
    if (legacy.legacyKeys.length === 0) {
      if (
        storage.getItem(recoveryKey) !== null &&
        !removeAndVerify(storage, recoveryKey)
      ) {
        return "retryable"
      }
      const completeRaw = serializeMigrationMarker({
        version: LEGACY_RELAY_READ_RECOVERY_VERSION,
        phase: "complete",
        draftFingerprint: null,
        recoveryFingerprint: null,
      })
      if (!persistAndVerify(storage, markerKey, completeRaw)) return "retryable"
      return hasSignedRelayList ? "retired_signed_wins" : "retired_empty"
    }

    let draftFingerprint: string | null = null
    if (!hasSignedRelayList) {
      const draftKey = getRelaySettingsStorageKey(input.accountScope)
      const seededDraftRaw = JSON.stringify(legacy.draft)
      const existingDraftRaw = storage.getItem(draftKey)
      if (existingDraftRaw === null || existingDraftRaw === seededDraftRaw) {
        if (!persistAndVerify(storage, draftKey, seededDraftRaw)) {
          return "retryable"
        }
        draftFingerprint = storageValueFingerprint(seededDraftRaw)
      } else if (
        !parseRelaySettingsStorageValue(existingDraftRaw) ||
        storage.getItem(draftKey) !== existingDraftRaw
      ) {
        return "retryable"
      }
    }

    const recoveryRaw = serializeLegacyReadRecovery(legacy.readRelayUrls)
    if (!persistAndVerify(storage, recoveryKey, recoveryRaw)) {
      return "retryable"
    }
    const prepared: LegacyRelaySettingsMigrationMarker = {
      version: LEGACY_RELAY_READ_RECOVERY_VERSION,
      phase: "prepared",
      draftFingerprint,
      recoveryFingerprint: storageValueFingerprint(recoveryRaw),
    }
    if (
      !persistAndVerify(storage, markerKey, serializeMigrationMarker(prepared))
    ) {
      return "retryable"
    }
    if (!retireLegacyRelaySettingsKeys(pubkey, storage)) return "retryable"
    const completeRaw = serializeMigrationMarker({
      ...prepared,
      phase: "complete",
    })
    if (!persistAndVerify(storage, markerKey, completeRaw)) return "retryable"
    return hasSignedRelayList ? "retired_signed_wins" : "seeded_draft"
  } catch {
    return "retryable"
  }
}

function inboxMembership(resolution: InboxDeclarationResolution): {
  membership: NetworkRoleMembership
  relayUrls: string[]
} {
  if (resolution.state === "declared") {
    return { membership: "published", relayUrls: resolution.relayUrls }
  }
  if (resolution.state === "distribution_pending") {
    return {
      membership: "pending",
      relayUrls: resolution.pendingRelayUrls ?? [],
    }
  }
  return { membership: null, relayUrls: [] }
}

export function projectAccountNetworkPreferences(input: {
  pubkey: string
  relayScope: string
  ownerRelayList: OwnerRelayListResolution
  inboxDeclaration: InboxDeclarationResolution
  draft?: RelaySettingsState
}): AccountNetworkPreferencesProjection {
  const rows = new Map<string, NetworkPreferenceRow>()
  const ensureRow = (url: string): NetworkPreferenceRow => {
    const existing = rows.get(url)
    if (existing) return existing
    const row: NetworkPreferenceRow = {
      url,
      position: rows.size,
      read: null,
      write: null,
      privateInbox: null,
      draftRead: false,
      draftWrite: false,
    }
    rows.set(url, row)
    return row
  }

  for (const preference of input.ownerRelayList.preferences) {
    const row = ensureRow(preference.url)
    if (preference.readEnabled) row.read = "published"
    if (preference.writeEnabled) row.write = "published"
  }
  const inbox = inboxMembership(input.inboxDeclaration)
  for (const relayUrl of inbox.relayUrls) {
    ensureRow(relayUrl).privateInbox = inbox.membership
  }
  for (const entry of input.draft?.entries ?? []) {
    const row = ensureRow(entry.url)
    row.draftRead = entry.readEnabled
    row.draftWrite = entry.writeEnabled
    if (row.read === null && entry.readEnabled) row.read = "draft"
    if (row.write === null && entry.writeEnabled) row.write = "draft"
  }

  const runtimeRelaySettings = createRelaySettingsFromPreferences(
    input.ownerRelayList.preferences,
    "published"
  )
  runtimeRelaySettings.updatedAt =
    input.ownerRelayList.current?.observedAt ??
    input.ownerRelayList.lookup.observedAt

  return {
    pubkey: input.pubkey,
    relayScope: input.relayScope,
    rows: Array.from(rows.values()),
    relayListState: input.ownerRelayList.state,
    relayListStale: input.ownerRelayList.stale,
    inboxState: input.inboxDeclaration.state,
    inboxStale: input.inboxDeclaration.stale,
    runtimeRelaySettings,
  }
}

export async function reconcileAccountNetworkPreferences(
  pubkey: string,
  options: ReconcileAccountNetworkPreferencesOptions = {}
): Promise<AccountNetworkPreferencesReconciliation> {
  const normalizedPubkey = pubkey.trim().toLowerCase()
  const accountScope = getAccountRelayScope(normalizedPubkey)
  const relayUrls = [
    ...(options.relayUrls ?? accountNetworkDiscoveryRelayUrls()),
  ]
  const resolveOwner = options.resolveOwner ?? resolveOwnerRelayList
  const resolveInbox = options.resolveInbox ?? resolveInboxDeclaration

  const [ownerRelayList, inboxDeclaration] = await Promise.all([
    resolveOwner(normalizedPubkey, {
      ...options.ownerRelayList,
      relayUrls,
    }),
    resolveInbox(normalizedPubkey, {
      ...options.inboxDeclaration,
      relayUrls,
      allowLocalRelayUrlsForPubkey: normalizedPubkey,
      // A fresh signer connection is a reconciliation boundary, even when a
      // process-local kind-10050 resolution is still inside its normal TTL.
      freshnessMs: 0,
    }),
  ])
  const storage = options.storage ?? browserStorage()
  let legacyMigration: LegacyRelaySettingsMigrationStatus = "not_applicable"
  if (storage) {
    legacyMigration = migrateLegacyRelaySettingsDraft({
      pubkey: normalizedPubkey,
      accountScope,
      ownerRelayList,
      storage,
    })
  }
  let legacyReadRecovery: LegacyRelayReadRecoveryRecord | null = null
  if (storage) {
    legacyReadRecovery = getCommittedLegacyRelayReadRecovery(
      normalizedPubkey,
      storage
    )
    if (
      !legacyReadRecovery &&
      !hasMigrationTombstone(normalizedPubkey, storage) &&
      (legacyMigration === "deferred" || legacyMigration === "retryable")
    ) {
      try {
        const legacy = readLegacyRelaySettingsSnapshot(
          normalizedPubkey,
          storage
        )
        if (legacy.legacyKeys.length > 0) {
          legacyReadRecovery = {
            version: LEGACY_RELAY_READ_RECOVERY_VERSION,
            readRelayUrls: legacy.readRelayUrls,
          }
        }
      } catch {
        // The old keys remain the durable fallback. A storage read failure is
        // not converted into absence or a partially committed recovery lane.
      }
    }
  }
  const draft = storage
    ? readRelaySettingsFromStorage(accountScope, storage)
    : loadRelaySettings(accountScope)
  const projection = projectAccountNetworkPreferences({
    pubkey: normalizedPubkey,
    relayScope: accountScope,
    ownerRelayList,
    inboxDeclaration,
    draft,
  })
  setInboxMigrationRecoveryRelayUrls(
    normalizedPubkey,
    legacyReadRecovery?.readRelayUrls ?? []
  )
  setAccountRelaySettingsProjection(
    accountScope,
    projection.runtimeRelaySettings,
    { signedRelayListAuthoritative: Boolean(ownerRelayList.current) }
  )
  return {
    projection,
    ownerRelayList,
    inboxDeclaration,
    legacyMigration,
  }
}
