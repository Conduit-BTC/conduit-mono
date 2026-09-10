import {
  accountNetworkDiscoveryRelayUrls,
  dexieOwnerRelayListEvidenceRepository,
  normalizeOwnerRelayListPubkey,
  readRetainedOwnerRelayList,
  resolveOwnerRelayList,
  type OwnerRelayListResolution,
  type OwnerRelayListEvidenceRepository,
  type OwnerRelayListEvidenceRecord,
  type ResolveOwnerRelayListOptions,
} from "./owner-relay-list-evidence"
import {
  dexieInboxDeclarationEvidenceRepository,
  normalizeInboxDeclarationEvidencePubkey,
  type InboxDeclarationEvidenceRecord,
} from "./inbox-declaration-evidence"
import {
  ACCOUNT_NETWORK_LOCAL_STATE_MIGRATION_VERSION,
  applyAuthoritativeAccountNetworkReadds,
  dexieAccountNetworkLocalStateRepository,
  normalizeAccountNetworkLocalState,
  replaceAccountNetworkPreferredRelayOrder,
  replaceAccountNetworkRelayScans,
  type AccountNetworkLocalState,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import {
  MAX_DECLARED_INBOX_WRITE_RELAYS,
  MAX_LEGACY_INBOX_READ_RECOVERY_RELAYS,
  readRetainedInboxDeclaration,
  resolveInboxDeclaration,
  sharedInboxDiscoveryRelayUrls,
  type InboxDeclarationResolution,
  type ResolveInboxDeclarationOptions,
} from "./private-message-routing"
import {
  createRelaySettingsFromPreferences,
  getRelaySettingsStorageKey,
  normalizeOwnerSelectedRelayUrls,
  normalizeSecureOrIsolatedE2eRelayUrls,
  normalizeRelaySettingsState,
  tryNormalizeRelayUrl,
  type RelaySettingsEntry,
  type RelayScanResult,
  type RelaySettingsPlanningSnapshot,
  type RelaySettingsState,
} from "./relay-settings"
import { getAccountRelayScope, getLegacySignedInRelayScopes } from "./session"

const LEGACY_MIGRATION_KEY_PREFIX = "conduit:network-legacy-migration:v1"
const LEGACY_READ_RECOVERY_KEY_PREFIX =
  "conduit:network-legacy-read-recovery:v1"
export const LEGACY_RELAY_READ_RECOVERY_VERSION = 1

export type NetworkRoleMembership = "published" | "pending" | null

export interface NetworkPreferenceRow {
  url: string
  position: number
  read: NetworkRoleMembership
  write: NetworkRoleMembership
  privateInbox: NetworkRoleMembership
}

export interface AccountNetworkPreferencesProjection {
  pubkey: string
  relayScope: string
  rows: NetworkPreferenceRow[]
  relayListState: OwnerRelayListResolution["state"]
  relayListStale: boolean
  inboxState: InboxDeclarationResolution["state"]
  inboxStale: boolean
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
  | "review_required"
  | "retired_signed_wins"
  | "retired_empty"
  | "already_complete"
  | "retryable"

export interface LegacyRelaySettingsReviewCandidate {
  pubkey: string
  relayScope: string
  /** Ephemeral presentation input; this object is never persisted as roles. */
  draft: RelaySettingsState
  /** Opaque compare-and-swap token for the exact legacy source bytes. */
  sourceFingerprint: string
  source: "legacy_app_scopes" | "prepared_account_draft"
}

export interface LegacyRelaySettingsMigrationResult {
  status: LegacyRelaySettingsMigrationStatus
  legacyReviewCandidate: LegacyRelaySettingsReviewCandidate | null
}

export type LegacyRelaySettingsMigrationDisposition =
  "publish_staged" | "discarded"

export type CompleteLegacyRelaySettingsMigrationStatus =
  | "completed"
  | "already_complete"
  | "not_applicable"
  | "source_changed"
  | "retryable"

export type LegacyRelayReadRecoveryClearStatus =
  "cleared" | "already_clear" | "not_applicable" | "retryable"

export type LegacyRelayReadRecoveryRelayRemovalStatus =
  "updated" | LegacyRelayReadRecoveryClearStatus

export interface AccountNetworkPreferencesReconciliation {
  projection: AccountNetworkPreferencesProjection
  ownerRelayList: OwnerRelayListResolution
  inboxDeclaration: InboxDeclarationResolution
  /** Exact canonical whole-relay exclusion set observed for this reconciliation. */
  localExcludedRelayUrls: string[]
  legacyMigration: LegacyRelaySettingsMigrationStatus
  legacyReviewCandidate: LegacyRelaySettingsReviewCandidate | null
  /** Exact committed migration recovery input for the next reviewed change. */
  legacyInboxRecoveryRelayUrls: string[]
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
  localStateRepository?: AccountNetworkLocalStateRepository
  /** Account whose local cutoff gates the reconciliation relay attempts. */
  requestingAccountPubkey?: string | null
  /** Active authenticated account for owner-selected ws:// read authority. */
  authenticatedPubkey?: string | null
  /** Cancels queued or in-flight reconciliation I/O on session change. */
  signal?: AbortSignal
}

export interface HydrateAccountNetworkPreferencesOptions {
  ownerRelayList?: Pick<
    ResolveOwnerRelayListOptions,
    "evidenceRepository" | "now"
  >
  inboxDeclaration?: Pick<
    ResolveInboxDeclarationOptions,
    "evidenceRepository" | "now"
  >
  storage?: LegacyRelaySettingsStorage
  localStateRepository?: AccountNetworkLocalStateRepository
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

interface LegacyRelaySettingsSnapshot {
  legacyKeys: string[]
  draft: RelaySettingsState
  sourceFingerprint: string
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
      return [{ key, raw, scope, settings }]
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
  const sourceBytes = candidates
    .map(({ key, raw }) => [key, raw] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  return {
    legacyKeys: candidates.map((candidate) => candidate.key),
    draft: normalizeRelaySettingsState({
      version: 1,
      entries: Array.from(byUrl.values()),
      updatedAt,
    }),
    sourceFingerprint: storageValueFingerprint(JSON.stringify(sourceBytes)),
  }
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
    const normalized = normalizeSecureOrIsolatedE2eRelayUrls(readRelayUrls)
    if (
      normalized.length !== readRelayUrls.length ||
      normalized.some((url, index) => url !== readRelayUrls[index])
    )
      return null
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

function hasLegacyReadRecoveryTombstone(
  pubkey: string,
  storage: LegacyRelaySettingsStorage
): boolean {
  try {
    const marker = parseMigrationMarker(
      storage.getItem(migrationMarkerKey(pubkey))
    )
    return Boolean(marker?.phase === "complete" && !marker.recoveryFingerprint)
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

function loadAvailableLegacyRelayReadRecovery(
  pubkey: string,
  storage: LegacyRelaySettingsStorage
): LegacyRelayReadRecoveryRecord | null {
  const committed = getCommittedLegacyRelayReadRecovery(pubkey, storage)
  if (committed || hasLegacyReadRecoveryTombstone(pubkey, storage)) {
    return committed
  }
  // Untouched NIP-65 role drafts are not NIP-17 inbox evidence. Older builds
  // may already have committed a bounded compatibility record; preserve only
  // that explicit marker while it converges, and never create a new one here.
  return null
}

function isCompleteOwnerRelayListAbsence(
  resolution: OwnerRelayListResolution
): boolean {
  return (
    resolution.state === "not_observed" &&
    !resolution.stale &&
    !resolution.current &&
    resolution.lookup.coverage === "complete" &&
    !resolution.lookup.hadEvent &&
    resolution.observation.coverage === "complete" &&
    resolution.observation.eventSourceRelayUrls.length === 0
  )
}

function hasEligibleSignedOwnerProjection(
  resolution: OwnerRelayListResolution
): boolean {
  return Boolean(
    resolution.current &&
    (resolution.current.state === "declared" ||
      resolution.current.state === "signed_empty" ||
      (resolution.current.state === "malformed" && resolution.lastUsable))
  )
}

function relaySettingsFromOwnerEvidence(
  resolution: OwnerRelayListResolution
): RelaySettingsState {
  const settings = createRelaySettingsFromPreferences(
    resolution.preferences,
    "published"
  )
  settings.updatedAt =
    resolution.current?.observedAt ?? resolution.lookup.observedAt
  return settings
}

/**
 * Bind account planners to retained, validated, durable kind-10002 evidence.
 *
 * This Adapter performs no relay I/O and creates no second authority. Missing
 * or unreadable evidence yields a non-authoritative empty snapshot so the pure
 * planner can apply its explicit bootstrap policy. A validated signed-empty
 * frontier remains authoritative and therefore suppresses membership fallback.
 */
export async function readDurableAccountRelaySettingsPlanningSnapshot(
  pubkey: string,
  options: { evidenceRepository?: OwnerRelayListEvidenceRepository } = {}
): Promise<RelaySettingsPlanningSnapshot> {
  const normalizedPubkey = normalizeOwnerRelayListPubkey(pubkey)
  if (!normalizedPubkey) {
    return {
      settings: createRelaySettingsFromPreferences([], "published"),
      signedRelayListAuthoritative: false,
    }
  }
  let retained: OwnerRelayListResolution | null = null
  try {
    retained = await readRetainedOwnerRelayList(normalizedPubkey, {
      evidenceRepository: options.evidenceRepository,
      durableOnly: true,
    })
  } catch {
    // Durable storage can be unavailable in browser privacy modes. Without a
    // validated retained frontier there is no positive account membership;
    // callers retain only their explicit code-owned bootstrap policy.
  }
  const signedRelayListAuthoritative = Boolean(
    retained && hasEligibleSignedOwnerProjection(retained)
  )
  return {
    settings: retained
      ? relaySettingsFromOwnerEvidence(retained)
      : createRelaySettingsFromPreferences([], "published"),
    signedRelayListAuthoritative,
  }
}

function hasMigrationAuthoritativeOwnerReplacement(
  current: OwnerRelayListResolution,
  durable: OwnerRelayListResolution | null | undefined,
  pendingEventId: string | null | undefined
): boolean {
  const currentEventId = current.current?.signedEvent.id
  if (
    !currentEventId ||
    (current.current?.state !== "declared" &&
      current.current?.state !== "signed_empty") ||
    !durable ||
    (durable.current?.state !== "declared" &&
      durable.current?.state !== "signed_empty") ||
    durable.current.signedEvent.id !== currentEventId
  ) {
    return false
  }
  if (pendingEventId === currentEventId) return true
  return (
    !current.stale &&
    current.lookup.coverage === "complete" &&
    current.lookup.hadEvent &&
    current.lookup.eventId === currentEventId
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

interface LegacyRelaySettingsSourceSnapshot extends LegacyRelaySettingsSnapshot {
  source: LegacyRelaySettingsReviewCandidate["source"]
}

function readPreparedLegacyRelaySettingsSnapshot(
  accountScope: string,
  marker: LegacyRelaySettingsMigrationMarker,
  storage: LegacyRelaySettingsStorage
): LegacyRelaySettingsSourceSnapshot | null {
  if (!marker.draftFingerprint) return null
  const draftKey = getRelaySettingsStorageKey(accountScope)
  const raw = storage.getItem(draftKey)
  if (
    raw === null ||
    storageValueFingerprint(raw) !== marker.draftFingerprint
  ) {
    throw new Error("Prepared legacy relay draft changed")
  }
  const draft = parseRelaySettingsStorageValue(raw)
  if (!draft) throw new Error("Prepared legacy relay draft is invalid")
  return {
    legacyKeys: [draftKey],
    draft,
    sourceFingerprint: marker.draftFingerprint,
    source: "prepared_account_draft",
  }
}

function readLegacyRelaySettingsSource(
  pubkey: string,
  accountScope: string,
  marker: LegacyRelaySettingsMigrationMarker | null,
  storage: LegacyRelaySettingsStorage
): LegacyRelaySettingsSourceSnapshot | null {
  if (marker?.draftFingerprint) {
    return readPreparedLegacyRelaySettingsSnapshot(
      accountScope,
      marker,
      storage
    )
  }
  const snapshot = readLegacyRelaySettingsSnapshot(pubkey, storage)
  return snapshot.legacyKeys.length > 0
    ? { ...snapshot, source: "legacy_app_scopes" }
    : null
}

function relayScansFromLegacyDraft(
  draft: RelaySettingsState
): RelayScanResult[] {
  return draft.entries.flatMap((entry) => {
    if (
      !Number.isSafeInteger(entry.scannedAt) ||
      (entry.scannedAt ?? -1) < 0 ||
      !entry.observations
    ) {
      return []
    }
    return [
      {
        url: entry.url,
        reachable: !entry.warnings.unreachable,
        ...(entry.relayName ? { relayName: entry.relayName } : {}),
        capabilities: structuredClone(entry.capabilities),
        warnings: structuredClone(entry.warnings),
        observations: structuredClone(entry.observations),
        ...(entry.commerceProfileVersion === undefined
          ? {}
          : { commerceProfileVersion: entry.commerceProfileVersion }),
        scannedAt: entry.scannedAt!,
      },
    ]
  })
}

function mergePreferredRelayOrder(
  current: readonly string[],
  legacy: readonly string[]
): string[] {
  const seen = new Set(current)
  return [
    ...current,
    ...legacy.filter((relayUrl) => {
      if (seen.has(relayUrl)) return false
      seen.add(relayUrl)
      return true
    }),
  ]
}

function mergeRelayScans(
  current: readonly RelayScanResult[],
  legacy: readonly RelayScanResult[]
): RelayScanResult[] {
  const byUrl = new Map(
    current.map((scan) => [scan.url, structuredClone(scan)] as const)
  )
  for (const scan of legacy) {
    const retained = byUrl.get(scan.url)
    if (!retained || scan.scannedAt > retained.scannedAt) {
      byUrl.set(scan.url, structuredClone(scan))
    }
  }
  return Array.from(byUrl.values())
}

async function markLegacyRelaySettingsMigrated(input: {
  pubkey: string
  source: LegacyRelaySettingsSourceSnapshot | null
  repository: AccountNetworkLocalStateRepository
  updatedAt: number
}): Promise<AccountNetworkLocalState> {
  return await input.repository.update(input.pubkey, (current) => {
    let next = normalizeAccountNetworkLocalState(current, input.pubkey)
    if (input.source) {
      next = replaceAccountNetworkPreferredRelayOrder(
        next,
        mergePreferredRelayOrder(
          next.preferredRelayOrder,
          input.source.draft.entries.map((entry) => entry.url)
        ),
        input.updatedAt
      )
      next = replaceAccountNetworkRelayScans(
        next,
        mergeRelayScans(
          next.relayScans,
          relayScansFromLegacyDraft(input.source.draft)
        ),
        input.updatedAt
      )
    }
    return normalizeAccountNetworkLocalState(
      {
        ...next,
        migrationVersion: ACCOUNT_NETWORK_LOCAL_STATE_MIGRATION_VERSION,
        updatedAt: Math.max(next.updatedAt, input.updatedAt),
      },
      input.pubkey
    )
  })
}

function retirePreparedLegacyDraft(
  pubkey: string,
  accountScope: string,
  marker: LegacyRelaySettingsMigrationMarker | null,
  storage: LegacyRelaySettingsStorage
): boolean {
  if (!marker?.draftFingerprint) return true
  const draftKey = getRelaySettingsStorageKey(accountScope)
  const draftRaw = storage.getItem(draftKey)
  if (
    draftRaw !== null &&
    storageValueFingerprint(draftRaw) !== marker.draftFingerprint
  ) {
    return false
  }
  if (draftRaw !== null && !removeAndVerify(storage, draftKey)) return false
  return persistAndVerify(
    storage,
    migrationMarkerKey(pubkey),
    serializeMigrationMarker({
      ...marker,
      phase: "complete",
      draftFingerprint: null,
    })
  )
}

function retireLegacyRoleSources(input: {
  pubkey: string
  accountScope: string
  marker: LegacyRelaySettingsMigrationMarker | null
  storage: LegacyRelaySettingsStorage
}): boolean {
  if (
    !retirePreparedLegacyDraft(
      input.pubkey,
      input.accountScope,
      input.marker,
      input.storage
    )
  ) {
    return false
  }
  return retireLegacyRelaySettingsKeys(input.pubkey, input.storage)
}

function readMatchingReviewedLegacySource(input: {
  pubkey: string
  candidate: LegacyRelaySettingsReviewCandidate
  marker: LegacyRelaySettingsMigrationMarker | null
  storage: LegacyRelaySettingsStorage
}): LegacyRelaySettingsSourceSnapshot | null {
  const source = readLegacyRelaySettingsSource(
    input.pubkey,
    input.candidate.relayScope,
    input.marker,
    input.storage
  )
  return source &&
    source.source === input.candidate.source &&
    source.sourceFingerprint === input.candidate.sourceFingerprint
    ? source
    : null
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
  /** Keep the independent NIP-65 draft when only inbox recovery is replaced. */
  preserveMigratedDraft?: boolean
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
      draftRaw !== null &&
      (input.discardMigratedDraft ||
        (!input.preserveMigratedDraft && ownsCurrentDraft))
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
    const settledMarkerRaw = serializeMigrationMarker({
      version: LEGACY_RELAY_READ_RECOVERY_VERSION,
      phase: "complete",
      draftFingerprint:
        input.preserveMigratedDraft && ownsCurrentDraft
          ? (marker?.draftFingerprint ?? null)
          : null,
      recoveryFingerprint: null,
    })
    if (!persistAndVerify(storage, markerKey, settledMarkerRaw)) {
      return "retryable"
    }
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
 * Persistently remove whole-relay exclusions from the legacy read-only lane.
 * The existing migration marker remains the sole authenticity boundary: its
 * fingerprint is advanced only after the filtered recovery bytes are verified.
 */
export function removeLegacyRelayReadRecoveryRelayUrls(input: {
  pubkey: string
  relayUrls: readonly string[]
  accountScope?: string
  storage?: LegacyRelaySettingsStorage
}): LegacyRelayReadRecoveryRelayRemovalStatus {
  const pubkey = normalizeOwnerRelayListPubkey(input.pubkey)
  if (!pubkey) return "not_applicable"
  const accountScope = input.accountScope ?? getAccountRelayScope(pubkey)
  if (accountScope !== getAccountRelayScope(pubkey)) return "not_applicable"

  const removedRelayUrls = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(input.relayUrls)
  )
  if (removedRelayUrls.size === 0) return "already_clear"

  const storage = input.storage ?? browserStorage()
  if (!storage) return "not_applicable"

  try {
    const markerKey = migrationMarkerKey(pubkey)
    const recoveryKey = legacyReadRecoveryKey(pubkey)
    const markerRaw = storage.getItem(markerKey)
    const recoveryRaw = storage.getItem(recoveryKey)
    const marker = parseMigrationMarker(markerRaw)
    if (markerRaw !== null && !marker) return "retryable"
    if (!marker?.recoveryFingerprint) {
      if (recoveryRaw !== null) return "retryable"
      return "already_clear"
    }
    if (
      recoveryRaw === null ||
      storageValueFingerprint(recoveryRaw) !== marker.recoveryFingerprint
    ) {
      return "retryable"
    }
    const recovery = parseLegacyReadRecovery(recoveryRaw)
    if (!recovery) return "retryable"

    const readRelayUrls = recovery.readRelayUrls.filter(
      (relayUrl) => !removedRelayUrls.has(relayUrl)
    )
    if (readRelayUrls.length === recovery.readRelayUrls.length) {
      return "already_clear"
    }
    if (readRelayUrls.length === 0) {
      return clearLegacyRelayReadRecovery({
        pubkey,
        accountScope,
        storage,
        preserveMigratedDraft: true,
      })
    }

    const nextRecoveryRaw = JSON.stringify({
      version: LEGACY_RELAY_READ_RECOVERY_VERSION,
      readRelayUrls,
    } satisfies LegacyRelayReadRecoveryRecord)
    if (!persistAndVerify(storage, recoveryKey, nextRecoveryRaw)) {
      return "retryable"
    }
    const nextMarkerRaw = serializeMigrationMarker({
      ...marker,
      recoveryFingerprint: storageValueFingerprint(nextRecoveryRaw),
    })
    if (!persistAndVerify(storage, markerKey, nextMarkerRaw)) {
      // Best-effort rollback keeps the prior committed pair readable. The
      // current reconciliation remains filtered until the durable update is
      // retried.
      persistAndVerify(storage, recoveryKey, recoveryRaw)
      return "retryable"
    }
    return "updated"
  } catch {
    return "retryable"
  }
}

function isMatchingDurableInboxReplacement(
  current: InboxDeclarationResolution,
  durable: InboxDeclarationResolution | null,
  sharedConfirmationRelayUrls: readonly string[]
): boolean {
  const eventId = current.eventId
  const observation = current.observation
  const canonicalSharedRelayUrls = new Set(sharedInboxDiscoveryRelayUrls())
  const requiredSharedRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
    sharedConfirmationRelayUrls
  ).filter((relayUrl) => canonicalSharedRelayUrls.has(relayUrl))
  const successfulRelayUrls = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(
      observation?.successfulRelayUrls ?? []
    )
  )
  const exactEventSourceRelayUrls = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(
      observation?.eventSourceRelayUrls ?? []
    )
  )
  return Boolean(
    current.state === "declared" &&
    current.relayUrls.length >= 1 &&
    current.relayUrls.length <= MAX_DECLARED_INBOX_WRITE_RELAYS &&
    eventId &&
    !current.stale &&
    observation?.coverage === "complete" &&
    observation.eventId === eventId &&
    requiredSharedRelayUrls.length > 0 &&
    requiredSharedRelayUrls.every((relayUrl) =>
      successfulRelayUrls.has(relayUrl)
    ) &&
    requiredSharedRelayUrls.some((relayUrl) =>
      exactEventSourceRelayUrls.has(relayUrl)
    ) &&
    durable?.state === "declared" &&
    durable.eventId === eventId &&
    typeof durable.cutoverRecoveryReadbackObservedAt === "number" &&
    Number.isFinite(durable.cutoverRecoveryReadbackObservedAt)
  )
}

function retireVerifiedLegacyInboxRecovery(input: {
  pubkey: string
  accountScope: string
  storage: LegacyRelaySettingsStorage
  currentInboxDeclaration: InboxDeclarationResolution
  durableInboxDeclaration: InboxDeclarationResolution | null
  sharedConfirmationRelayUrls: readonly string[]
}): LegacyRelayReadRecoveryClearStatus | null {
  if (
    !isMatchingDurableInboxReplacement(
      input.currentInboxDeclaration,
      input.durableInboxDeclaration,
      input.sharedConfirmationRelayUrls
    ) ||
    !getCommittedLegacyRelayReadRecovery(input.pubkey, input.storage)
  ) {
    return null
  }
  return clearLegacyRelayReadRecovery({
    pubkey: input.pubkey,
    accountScope: input.accountScope,
    storage: input.storage,
    preserveMigratedDraft: true,
  })
}

export interface MigrateLegacyRelaySettingsDraftInput {
  pubkey: string
  accountScope: string
  ownerRelayList: OwnerRelayListResolution
  /** Exact durable reread required before signed evidence can retire legacy state. */
  durableOwnerRelayList?: OwnerRelayListResolution | null
  /** Exact locally staged kind-10002 may win before shared readback. */
  pendingOwnerRelayListEventId?: string | null
  storage?: LegacyRelaySettingsStorage
  localStateRepository?: AccountNetworkLocalStateRepository
  now?: () => number
}

async function migrateLegacyRelaySettingsDraftWithCandidate(
  input: MigrateLegacyRelaySettingsDraftInput
): Promise<LegacyRelaySettingsMigrationResult> {
  const storage = input.storage ?? browserStorage()
  const pubkey = normalizeOwnerRelayListPubkey(input.pubkey)
  if (
    !storage ||
    !pubkey ||
    input.accountScope !== getAccountRelayScope(pubkey)
  ) {
    return { status: "not_applicable", legacyReviewCandidate: null }
  }
  const repository =
    input.localStateRepository ?? dexieAccountNetworkLocalStateRepository
  const updatedAt = input.now?.() ?? Date.now()

  try {
    const hasSignedRelayList = hasMigrationAuthoritativeOwnerReplacement(
      input.ownerRelayList,
      input.durableOwnerRelayList,
      input.pendingOwnerRelayListEventId
    )
    const markerKey = migrationMarkerKey(pubkey)
    const recoveryKey = legacyReadRecoveryKey(pubkey)
    const markerRaw = storage.getItem(markerKey)
    const marker = parseMigrationMarker(markerRaw)
    if (markerRaw !== null && !marker) {
      return { status: "retryable", legacyReviewCandidate: null }
    }
    if (
      marker?.recoveryFingerprint &&
      !getCommittedLegacyRelayReadRecoveryStrict(pubkey, storage)
    ) {
      return { status: "retryable", legacyReviewCandidate: null }
    }

    const localState = await repository.get(pubkey)
    if (
      localState &&
      normalizeAccountNetworkLocalState(localState, pubkey).migrationVersion >=
        ACCOUNT_NETWORK_LOCAL_STATE_MIGRATION_VERSION
    ) {
      const mayRetireWithoutReviewedCandidate = Boolean(
        hasSignedRelayList ||
        marker?.draftFingerprint ||
        isMigrationTombstone(marker)
      )
      if (!mayRetireWithoutReviewedCandidate) {
        const stillHasLegacyRoles =
          readLegacyRelaySettingsSnapshot(pubkey, storage).legacyKeys.length > 0
        return {
          status: stillHasLegacyRoles ? "retryable" : "already_complete",
          legacyReviewCandidate: null,
        }
      }
      const retired = retireLegacyRoleSources({
        pubkey,
        accountScope: input.accountScope,
        marker,
        storage,
      })
      return {
        status: retired ? "already_complete" : "retryable",
        legacyReviewCandidate: null,
      }
    }

    if (isMigrationTombstone(marker) || (marker && !marker.draftFingerprint)) {
      await markLegacyRelaySettingsMigrated({
        pubkey,
        source: null,
        repository,
        updatedAt,
      })
      if (
        storage.getItem(recoveryKey) !== null &&
        !marker?.recoveryFingerprint &&
        !removeAndVerify(storage, recoveryKey)
      ) {
        return { status: "retryable", legacyReviewCandidate: null }
      }
      const retired = retireLegacyRoleSources({
        pubkey,
        accountScope: input.accountScope,
        marker,
        storage,
      })
      return {
        status: retired
          ? hasSignedRelayList
            ? "retired_signed_wins"
            : "already_complete"
          : "retryable",
        legacyReviewCandidate: null,
      }
    }

    const hasCompleteAbsence = isCompleteOwnerRelayListAbsence(
      input.ownerRelayList
    )
    if (!hasSignedRelayList && !hasCompleteAbsence) {
      return { status: "deferred", legacyReviewCandidate: null }
    }

    const source = readLegacyRelaySettingsSource(
      pubkey,
      input.accountScope,
      marker,
      storage
    )
    if (hasCompleteAbsence && source) {
      return {
        status: "review_required",
        legacyReviewCandidate: {
          pubkey,
          relayScope: input.accountScope,
          draft: structuredClone(source.draft),
          sourceFingerprint: source.sourceFingerprint,
          source: source.source,
        },
      }
    }

    await markLegacyRelaySettingsMigrated({
      pubkey,
      source,
      repository,
      updatedAt,
    })
    let cleanupMarker = marker
    if (hasSignedRelayList && !cleanupMarker) {
      cleanupMarker = {
        version: LEGACY_RELAY_READ_RECOVERY_VERSION,
        phase: "complete",
        draftFingerprint: null,
        recoveryFingerprint: null,
      }
      if (
        !persistAndVerify(
          storage,
          markerKey,
          serializeMigrationMarker(cleanupMarker)
        )
      ) {
        return { status: "retryable", legacyReviewCandidate: null }
      }
    }
    const retired = retireLegacyRoleSources({
      pubkey,
      accountScope: input.accountScope,
      marker: cleanupMarker,
      storage,
    })
    return {
      status: retired
        ? hasSignedRelayList
          ? "retired_signed_wins"
          : "retired_empty"
        : "retryable",
      legacyReviewCandidate: null,
    }
  } catch {
    return { status: "retryable", legacyReviewCandidate: null }
  }
}

/**
 * Reconcile obsolete role drafts without ever persisting a second desired-role
 * representation. Signed/pending kind-10002 wins. Exact complete absence may
 * only surface the old bytes as an ephemeral review candidate.
 */
export async function migrateLegacyRelaySettingsDraft(
  input: MigrateLegacyRelaySettingsDraftInput
): Promise<LegacyRelaySettingsMigrationStatus> {
  return (await migrateLegacyRelaySettingsDraftWithCandidate(input)).status
}

/**
 * Complete an explicit review decision only after publish staging or discard.
 * The local migration marker is committed before the exact legacy source is
 * retired, so an interrupted cleanup is idempotently recoverable.
 */
export async function completeLegacyRelaySettingsDraftMigration(input: {
  candidate: LegacyRelaySettingsReviewCandidate
  disposition: LegacyRelaySettingsMigrationDisposition
  storage?: LegacyRelaySettingsStorage
  localStateRepository?: AccountNetworkLocalStateRepository
  now?: () => number
}): Promise<CompleteLegacyRelaySettingsMigrationStatus> {
  const storage = input.storage ?? browserStorage()
  const pubkey = normalizeOwnerRelayListPubkey(input.candidate.pubkey)
  if (
    !storage ||
    !pubkey ||
    input.candidate.relayScope !== getAccountRelayScope(pubkey) ||
    (input.disposition !== "publish_staged" &&
      input.disposition !== "discarded")
  ) {
    return "not_applicable"
  }
  const repository =
    input.localStateRepository ?? dexieAccountNetworkLocalStateRepository

  try {
    const markerRaw = storage.getItem(migrationMarkerKey(pubkey))
    const marker = parseMigrationMarker(markerRaw)
    if (markerRaw !== null && !marker) return "retryable"
    const currentLocalState = await repository.get(pubkey)
    if (
      currentLocalState &&
      normalizeAccountNetworkLocalState(currentLocalState, pubkey)
        .migrationVersion >= ACCOUNT_NETWORK_LOCAL_STATE_MIGRATION_VERSION
    ) {
      const currentSource = readLegacyRelaySettingsSource(
        pubkey,
        input.candidate.relayScope,
        marker,
        storage
      )
      if (!currentSource) return "already_complete"
      if (
        !readMatchingReviewedLegacySource({
          pubkey,
          candidate: input.candidate,
          marker,
          storage,
        })
      ) {
        return "source_changed"
      }
      return retireLegacyRoleSources({
        pubkey,
        accountScope: input.candidate.relayScope,
        marker,
        storage,
      })
        ? "already_complete"
        : "retryable"
    }

    const source = readMatchingReviewedLegacySource({
      pubkey,
      candidate: input.candidate,
      marker,
      storage,
    })
    if (!source) return "source_changed"
    await markLegacyRelaySettingsMigrated({
      pubkey,
      source,
      repository,
      updatedAt: input.now?.() ?? Date.now(),
    })
    if (
      !readMatchingReviewedLegacySource({
        pubkey,
        candidate: input.candidate,
        marker,
        storage,
      })
    ) {
      return "source_changed"
    }
    return retireLegacyRoleSources({
      pubkey,
      accountScope: input.candidate.relayScope,
      marker,
      storage,
    })
      ? "completed"
      : "retryable"
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
    }
    rows.set(url, row)
    return row
  }

  for (const preference of input.ownerRelayList.preferences) {
    const row = ensureRow(preference.url)
    const membership = input.ownerRelayList.pendingDistribution
      ? "pending"
      : "published"
    if (preference.readEnabled) row.read = membership
    if (preference.writeEnabled) row.write = membership
  }
  const inbox = inboxMembership(input.inboxDeclaration)
  for (const relayUrl of inbox.relayUrls) {
    ensureRow(relayUrl).privateInbox = inbox.membership
  }
  return {
    pubkey: input.pubkey,
    relayScope: input.relayScope,
    rows: Array.from(rows.values()),
    relayListState: input.ownerRelayList.state,
    relayListStale: input.ownerRelayList.stale,
    inboxState: input.inboxDeclaration.state,
    inboxStale: input.inboxDeclaration.stale,
  }
}

function unavailableOwnerRelayList(
  pubkey: NonNullable<ReturnType<typeof normalizeOwnerRelayListPubkey>>,
  observedAt: number
): OwnerRelayListResolution {
  return {
    pubkey,
    state: "lookup_unavailable",
    preferences: [],
    stale: false,
    lookup: {
      observedAt,
      coverage: "unavailable",
      hadEvent: false,
    },
    observation: {
      coverage: "unavailable",
      attemptedRelayUrls: [],
      successfulRelayUrls: [],
      failedRelayUrls: [],
      cappedRelayUrls: [],
      eventSourceRelayUrls: [],
    },
  }
}

function unavailableInboxDeclaration(
  pubkey: string,
  fetchedAt: number
): InboxDeclarationResolution {
  return {
    pubkey,
    state: "lookup_unavailable",
    relayUrls: [],
    stale: false,
    fetchedAt,
  }
}

async function applyFreshAuthoritativeNetworkReadds(input: {
  pubkey: string
  ownerRelayList: OwnerRelayListResolution
  ownerEvidence: OwnerRelayListEvidenceRecord | null
  inboxDeclaration: InboxDeclarationResolution
  inboxEvidence: InboxDeclarationEvidenceRecord | null
  repository: AccountNetworkLocalStateRepository
  updatedAt: number
}): Promise<void> {
  const ownerEvent =
    input.ownerRelayList.current &&
    input.ownerRelayList.current.state !== "malformed" &&
    input.ownerRelayList.observation.eventId ===
      input.ownerRelayList.current.signedEvent.id &&
    input.ownerRelayList.observation.eventSourceRelayUrls.length > 0 &&
    input.ownerEvidence?.current?.signedEvent.id ===
      input.ownerRelayList.current.signedEvent.id
      ? input.ownerEvidence.current.signedEvent
      : undefined
  const inboxEvent =
    input.inboxDeclaration.eventId &&
    input.inboxDeclaration.state !== "malformed" &&
    input.inboxDeclaration.observation?.eventId ===
      input.inboxDeclaration.eventId &&
    input.inboxDeclaration.observation.eventSourceRelayUrls.length > 0 &&
    input.inboxEvidence?.current.signedEvent.id ===
      input.inboxDeclaration.eventId
      ? input.inboxEvidence.current.signedEvent
      : undefined
  if (!ownerEvent && !inboxEvent) return

  await input.repository.update(input.pubkey, (current) =>
    applyAuthoritativeAccountNetworkReadds(current, {
      ...(ownerEvent ? { relayList: ownerEvent } : {}),
      ...(inboxEvent ? { inboxDeclaration: inboxEvent } : {}),
      updatedAt: input.updatedAt,
    })
  )
}

/**
 * Load validated durable/local state into a session-owned reconciliation
 * projection before a signed-in relay scope becomes ready. This performs no
 * relay I/O; the fresh reconciliation remains a separate background step.
 */
export async function hydrateAccountNetworkPreferences(
  pubkey: string,
  options: HydrateAccountNetworkPreferencesOptions = {}
): Promise<AccountNetworkPreferencesReconciliation> {
  const normalizedPubkey = normalizeOwnerRelayListPubkey(pubkey)
  if (!normalizedPubkey) {
    throw new Error("Account Network hydration requires a valid hex pubkey")
  }
  const accountScope = getAccountRelayScope(normalizedPubkey)
  const observedAt = options.ownerRelayList?.now?.() ?? Date.now()
  const localStateRepository =
    options.localStateRepository ?? dexieAccountNetworkLocalStateRepository
  const [retainedOwnerRelayList, retainedInboxDeclaration, retainedLocalState] =
    await Promise.all([
      readRetainedOwnerRelayList(normalizedPubkey, {
        evidenceRepository: options.ownerRelayList?.evidenceRepository,
      }).catch(() => null),
      readRetainedInboxDeclaration(normalizedPubkey, {
        evidenceRepository: options.inboxDeclaration?.evidenceRepository,
        now: options.inboxDeclaration?.now,
      }).catch(() => null),
      localStateRepository
        .get(normalizedPubkey)
        .then((state) =>
          state
            ? normalizeAccountNetworkLocalState(state, normalizedPubkey)
            : null
        )
        .catch(() => null),
    ])
  const ownerRelayList =
    retainedOwnerRelayList ??
    unavailableOwnerRelayList(normalizedPubkey, observedAt)
  const inboxDeclaration =
    retainedInboxDeclaration ??
    unavailableInboxDeclaration(normalizedPubkey, observedAt)
  const storage = options.storage ?? browserStorage()
  const excludedRelayUrls = (
    retainedLocalState?.exclusions.map((exclusion) => exclusion.relayUrl) ?? []
  ).sort()
  const legacyRecoveryPruneStatus =
    storage && excludedRelayUrls.length > 0
      ? removeLegacyRelayReadRecoveryRelayUrls({
          pubkey: normalizedPubkey,
          accountScope,
          relayUrls: excludedRelayUrls,
          storage,
        })
      : null
  const legacyReadRecovery = storage
    ? loadAvailableLegacyRelayReadRecovery(normalizedPubkey, storage)
    : null
  const excludedRelayUrlSet = new Set(excludedRelayUrls)
  const legacyInboxRecoveryRelayUrls = (
    legacyReadRecovery?.readRelayUrls ?? []
  ).filter((relayUrl) => !excludedRelayUrlSet.has(relayUrl))
  const projection = projectAccountNetworkPreferences({
    pubkey: normalizedPubkey,
    relayScope: accountScope,
    ownerRelayList,
    inboxDeclaration,
  })
  return {
    projection,
    ownerRelayList,
    inboxDeclaration,
    localExcludedRelayUrls: excludedRelayUrls,
    legacyMigration:
      legacyRecoveryPruneStatus === "retryable"
        ? "retryable"
        : "not_applicable",
    legacyReviewCandidate: null,
    legacyInboxRecoveryRelayUrls,
  }
}

export async function reconcileAccountNetworkPreferences(
  pubkey: string,
  options: ReconcileAccountNetworkPreferencesOptions = {}
): Promise<AccountNetworkPreferencesReconciliation> {
  const normalizedPubkey = normalizeOwnerRelayListPubkey(pubkey)
  const normalizedInboxPubkey = normalizeInboxDeclarationEvidencePubkey(pubkey)
  if (!normalizedPubkey || !normalizedInboxPubkey) {
    throw new Error(
      "Account Network reconciliation requires a valid hex pubkey"
    )
  }
  const accountScope = getAccountRelayScope(normalizedPubkey)
  const relayUrls = [
    ...(options.relayUrls ?? accountNetworkDiscoveryRelayUrls()),
  ]
  const resolveOwner = options.resolveOwner ?? resolveOwnerRelayList
  const resolveInbox = options.resolveInbox ?? resolveInboxDeclaration
  const ownerEvidenceRepository =
    options.ownerRelayList?.evidenceRepository ??
    dexieOwnerRelayListEvidenceRepository
  const inboxEvidenceRepository =
    options.inboxDeclaration?.evidenceRepository ??
    dexieInboxDeclarationEvidenceRepository
  const localStateRepository =
    options.localStateRepository ?? dexieAccountNetworkLocalStateRepository
  const authenticatedOwnerPubkey = normalizeOwnerRelayListPubkey(
    options.authenticatedPubkey ?? ""
  )
  const ownerPlanningSnapshot =
    authenticatedOwnerPubkey === normalizedPubkey
      ? await readDurableAccountRelaySettingsPlanningSnapshot(
          normalizedPubkey,
          { evidenceRepository: ownerEvidenceRepository }
        )
      : null
  const ownerSelectedRelayUrls =
    authenticatedOwnerPubkey === normalizedPubkey
      ? normalizeOwnerSelectedRelayUrls([
          ...(options.ownerRelayList?.ownerSelectedRelayUrls ?? []),
          ...(ownerPlanningSnapshot?.settings.entries.flatMap((entry) =>
            entry.readEnabled || entry.writeEnabled ? [entry.url] : []
          ) ?? []),
        ])
      : []

  const [ownerRelayList, inboxDeclaration] = await Promise.all([
    resolveOwner(normalizedPubkey, {
      ...options.ownerRelayList,
      relayUrls: [...ownerSelectedRelayUrls, ...relayUrls],
      requestingAccountPubkey:
        options.requestingAccountPubkey ?? normalizedPubkey,
      authenticatedPubkey: options.authenticatedPubkey,
      ownerSelectedRelayUrls,
      accountNetworkLocalStateRepository:
        options.ownerRelayList?.accountNetworkLocalStateRepository ??
        localStateRepository,
      signal: options.signal,
    }),
    resolveInbox(normalizedPubkey, {
      ...options.inboxDeclaration,
      relayUrls,
      requestingAccountPubkey:
        options.requestingAccountPubkey ?? normalizedPubkey,
      authenticatedPubkey: options.authenticatedPubkey,
      accountNetworkLocalStateRepository:
        options.inboxDeclaration?.accountNetworkLocalStateRepository ??
        localStateRepository,
      signal: options.signal,
      allowLocalRelayUrlsForPubkey: normalizedPubkey,
      // A fresh signer connection is a reconciliation boundary, even when a
      // process-local kind-10050 resolution is still inside its normal TTL.
      freshnessMs: 0,
    }),
  ])
  const storage = options.storage ?? browserStorage()
  const [
    durableOwnerRelayList,
    durableInboxDeclaration,
    durableOwnerEvidence,
    durableInboxEvidence,
    retainedLocalState,
  ] = await Promise.all([
    ownerRelayList.current
      ? readRetainedOwnerRelayList(normalizedPubkey, {
          evidenceRepository: ownerEvidenceRepository,
          durableOnly: true,
        }).catch(() => null)
      : null,
    inboxDeclaration.state === "declared"
      ? readRetainedInboxDeclaration(normalizedPubkey, {
          evidenceRepository: inboxEvidenceRepository,
          now: options.inboxDeclaration?.now,
        }).catch(() => null)
      : null,
    ownerEvidenceRepository
      .get(normalizedPubkey)
      .then((record) => record ?? null)
      .catch(() => null),
    inboxEvidenceRepository
      .get(normalizedInboxPubkey)
      .then((record) => record ?? null)
      .catch(() => null),
    localStateRepository
      .get(normalizedPubkey)
      .then((state) =>
        state
          ? normalizeAccountNetworkLocalState(state, normalizedPubkey)
          : null
      )
      .catch(() => null),
  ])
  const excludedRelayUrls = (
    retainedLocalState?.exclusions.map((exclusion) => exclusion.relayUrl) ?? []
  ).sort()
  const legacyRecoveryPruneStatus =
    storage && excludedRelayUrls.length > 0
      ? removeLegacyRelayReadRecoveryRelayUrls({
          pubkey: normalizedPubkey,
          accountScope,
          relayUrls: excludedRelayUrls,
          storage,
        })
      : null
  if (legacyRecoveryPruneStatus !== "retryable") {
    await applyFreshAuthoritativeNetworkReadds({
      pubkey: normalizedPubkey,
      ownerRelayList,
      ownerEvidence: durableOwnerEvidence,
      inboxDeclaration,
      inboxEvidence: durableInboxEvidence,
      repository: localStateRepository,
      updatedAt: Date.now(),
    })
  }
  let legacyMigrationResult: LegacyRelaySettingsMigrationResult = {
    status: "not_applicable",
    legacyReviewCandidate: null,
  }
  if (storage) {
    const stagedOwnerRelayListEventId =
      durableOwnerEvidence?.pendingDistribution?.signedEvent.id
    const pendingOwnerRelayListEventId =
      stagedOwnerRelayListEventId ===
      durableOwnerRelayList?.current?.signedEvent.id
        ? stagedOwnerRelayListEventId
        : null
    legacyMigrationResult = await migrateLegacyRelaySettingsDraftWithCandidate({
      pubkey: normalizedPubkey,
      accountScope,
      ownerRelayList,
      durableOwnerRelayList,
      pendingOwnerRelayListEventId,
      storage,
      localStateRepository,
    })
  }
  if (legacyRecoveryPruneStatus === "retryable") {
    legacyMigrationResult = {
      status: "retryable",
      legacyReviewCandidate: legacyMigrationResult.legacyReviewCandidate,
    }
  }
  if (storage && legacyRecoveryPruneStatus !== "retryable") {
    const clearStatus = retireVerifiedLegacyInboxRecovery({
      pubkey: normalizedPubkey,
      accountScope,
      storage,
      currentInboxDeclaration: inboxDeclaration,
      durableInboxDeclaration,
      sharedConfirmationRelayUrls:
        options.inboxDeclaration?.sharedConfirmationRelayUrls ??
        sharedInboxDiscoveryRelayUrls(),
    })
    if (clearStatus === "retryable") {
      legacyMigrationResult = {
        status: "retryable",
        legacyReviewCandidate: legacyMigrationResult.legacyReviewCandidate,
      }
    }
  }
  let legacyReadRecovery: LegacyRelayReadRecoveryRecord | null = null
  if (storage) {
    legacyReadRecovery = loadAvailableLegacyRelayReadRecovery(
      normalizedPubkey,
      storage
    )
  }
  const excludedRelayUrlSet = new Set(excludedRelayUrls)
  const legacyInboxRecoveryRelayUrls = (
    legacyReadRecovery?.readRelayUrls ?? []
  ).filter((relayUrl) => !excludedRelayUrlSet.has(relayUrl))
  const projection = projectAccountNetworkPreferences({
    pubkey: normalizedPubkey,
    relayScope: accountScope,
    ownerRelayList,
    inboxDeclaration,
  })
  const committedLocalState = await localStateRepository
    .get(normalizedPubkey)
    .then((state) =>
      state ? normalizeAccountNetworkLocalState(state, normalizedPubkey) : null
    )
    .catch(() => null)
  const localExcludedRelayUrls = (
    committedLocalState?.exclusions.map((exclusion) => exclusion.relayUrl) ?? []
  ).sort()
  return {
    projection,
    ownerRelayList,
    inboxDeclaration,
    localExcludedRelayUrls,
    legacyMigration: legacyMigrationResult.status,
    legacyReviewCandidate: legacyMigrationResult.legacyReviewCandidate,
    legacyInboxRecoveryRelayUrls,
  }
}
