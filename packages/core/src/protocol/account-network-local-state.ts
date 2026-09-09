import { liveQuery } from "dexie"
import {
  db,
  type AccountNetworkFrontierReference,
  type AccountNetworkLocalState,
  type AccountNetworkRelayExclusion,
} from "../db"
import { EVENT_KINDS } from "./kinds"
import {
  getConfiguredIsolatedE2eRelayUrl,
  normalizeRelaySettingsState,
  RELAY_SETTINGS_STORAGE_VERSION,
  tryNormalizeRelayUrl,
  type RelayScanResult,
  type RelaySettingsState,
} from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export type {
  AccountNetworkFrontierReference,
  AccountNetworkLocalState,
  AccountNetworkRelayExclusion,
} from "../db"

export const ACCOUNT_NETWORK_LOCAL_STATE_VERSION = 1
export const ACCOUNT_NETWORK_LOCAL_STATE_MIGRATION_VERSION = 1
export const ACCOUNT_NETWORK_LOCAL_STATE_UNMIGRATED_VERSION = 0

const HEX_64 = /^[0-9a-f]{64}$/

declare const normalizedAccountNetworkPubkeyBrand: unique symbol
export type NormalizedAccountNetworkPubkey = string & {
  readonly [normalizedAccountNetworkPubkeyBrand]: true
}

export interface AccountNetworkLocalStateRepository {
  get(pubkey: string): Promise<AccountNetworkLocalState | undefined>
  replace(
    pubkey: string,
    state: AccountNetworkLocalState
  ): Promise<AccountNetworkLocalState>
  update(
    pubkey: string,
    updater: (current: AccountNetworkLocalState) => AccountNetworkLocalState
  ): Promise<AccountNetworkLocalState>
}

export interface AccountNetworkAuthoritativeReadds {
  relayList?: SignedPublicNostrEvent
  inboxDeclaration?: SignedPublicNostrEvent
  updatedAt?: number
}

export interface AccountNetworkRelayOperation<T> {
  relayUrl: string
  equivalenceKey: string
  value: T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cloneState(state: AccountNetworkLocalState): AccountNetworkLocalState {
  return structuredClone(state)
}

function assertTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer timestamp`)
  }
  return value as number
}

function assertVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return value as number
}

export function normalizeAccountNetworkPubkey(
  pubkey: string
): NormalizedAccountNetworkPubkey | null {
  const normalized = pubkey.trim().toLowerCase()
  return HEX_64.test(normalized)
    ? (normalized as NormalizedAccountNetworkPubkey)
    : null
}

function requireAccountPubkey(
  pubkey: string,
  label = "Account network local state"
): NormalizedAccountNetworkPubkey {
  const normalized = normalizeAccountNetworkPubkey(pubkey)
  if (!normalized) {
    throw new Error(`${label} requires a valid hex pubkey`)
  }
  return normalized
}

function normalizeAccountRelayUrl(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a relay URL`)
  }
  const normalized = tryNormalizeRelayUrl(value)
  const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
  if (
    !normalized.ok ||
    (!normalized.url.startsWith("wss://") &&
      normalized.url !== isolatedRelayUrl)
  ) {
    throw new Error(`${label} must be a secure relay URL`)
  }
  return normalized.url
}

function normalizeRelayUrlsStrict(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const item of value) {
    const relayUrl = normalizeAccountRelayUrl(item, label)
    if (seen.has(relayUrl)) {
      throw new Error(`${label} must not contain duplicate relay URLs`)
    }
    seen.add(relayUrl)
    normalized.push(relayUrl)
  }
  return normalized
}

function normalizeCandidateRelayUrls(relayUrls: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const relayUrl of relayUrls) {
    try {
      const accepted = normalizeAccountRelayUrl(relayUrl, "Relay URL")
      if (seen.has(accepted)) continue
      seen.add(accepted)
      normalized.push(accepted)
    } catch {
      // Candidate plans can contain invalid untrusted hints. Ignore them.
    }
  }
  return normalized
}

function normalizeFrontierReference(
  value: unknown,
  label: string
): AccountNetworkFrontierReference {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a frontier reference`)
  }
  const { eventId, createdAt } = value
  if (eventId === null && createdAt === null) {
    return { eventId: null, createdAt: null }
  }
  if (typeof eventId !== "string" || typeof createdAt !== "number") {
    throw new Error(`${label} eventId and createdAt must both be null or valid`)
  }
  const normalizedEventId = eventId.toLowerCase()
  if (!HEX_64.test(normalizedEventId)) {
    throw new Error(`${label} eventId must be canonical hex`)
  }
  return {
    eventId: normalizedEventId,
    createdAt: assertTimestamp(createdAt, `${label} createdAt`),
  }
}

function normalizeRelayScan(value: unknown): RelayScanResult {
  if (!isRecord(value)) {
    throw new Error("Account network relay scans must contain objects")
  }
  const url = normalizeAccountRelayUrl(value.url, "Relay scan URL")
  if (typeof value.reachable !== "boolean") {
    throw new Error("Relay scan reachable must be a boolean")
  }
  if (
    !isRecord(value.capabilities) ||
    !isRecord(value.warnings) ||
    !isRecord(value.observations)
  ) {
    throw new Error(
      "Relay scans must use the existing capability, warning, and observation vocabulary"
    )
  }
  const scannedAt = assertTimestamp(value.scannedAt, "Relay scan scannedAt")
  if (value.relayName !== undefined && typeof value.relayName !== "string") {
    throw new Error("Relay scan relayName must be a string")
  }
  if (
    value.commerceProfileVersion !== undefined &&
    (!Number.isSafeInteger(value.commerceProfileVersion) ||
      (value.commerceProfileVersion as number) < 0)
  ) {
    throw new Error(
      "Relay scan commerceProfileVersion must be a non-negative integer"
    )
  }

  const normalizedSettings = normalizeRelaySettingsState({
    version: RELAY_SETTINGS_STORAGE_VERSION,
    entries: [
      {
        url,
        readEnabled: false,
        writeEnabled: false,
        section: "public",
        capabilities: value.capabilities,
        warnings: value.warnings,
        observations: value.observations,
        commerceProfileVersion: value.commerceProfileVersion,
        scannedAt,
        relayName: value.relayName,
      },
    ],
    updatedAt: scannedAt,
  } as unknown as RelaySettingsState)
  const entry = normalizedSettings.entries[0]
  if (!entry?.observations) {
    throw new Error("Relay scan observations could not be normalized")
  }

  return {
    url,
    reachable: value.reachable,
    ...(entry.relayName ? { relayName: entry.relayName } : {}),
    capabilities: entry.capabilities,
    warnings: entry.warnings,
    observations: entry.observations,
    ...(entry.commerceProfileVersion === undefined
      ? {}
      : { commerceProfileVersion: entry.commerceProfileVersion }),
    scannedAt,
  }
}

function normalizeRelayScans(value: unknown): RelayScanResult[] {
  if (!Array.isArray(value)) {
    throw new Error("Account network relayScans must be an array")
  }
  const seen = new Set<string>()
  return value.map((scan) => {
    const normalized = normalizeRelayScan(scan)
    if (seen.has(normalized.url)) {
      throw new Error(
        "Account network relayScans must not contain duplicate relay URLs"
      )
    }
    seen.add(normalized.url)
    return normalized
  })
}

function normalizeExclusion(value: unknown): AccountNetworkRelayExclusion {
  if (!isRecord(value)) {
    throw new Error("Account network exclusions must contain objects")
  }
  return {
    relayUrl: normalizeAccountRelayUrl(
      value.relayUrl,
      "Account network exclusion URL"
    ),
    committedAt: assertTimestamp(
      value.committedAt,
      "Account network exclusion committedAt"
    ),
    relayListFrontier: normalizeFrontierReference(
      value.relayListFrontier,
      "Account network relay-list frontier"
    ),
    inboxDeclarationFrontier: normalizeFrontierReference(
      value.inboxDeclarationFrontier,
      "Account network inbox-declaration frontier"
    ),
  }
}

export function normalizeAccountNetworkLocalState(
  value: unknown,
  expectedPubkey?: string
): AccountNetworkLocalState {
  if (!isRecord(value)) {
    throw new Error("Account network local state must be an object")
  }
  if (typeof value.pubkey !== "string") {
    throw new Error("Account network local state requires a pubkey")
  }
  const pubkey = requireAccountPubkey(value.pubkey)
  const expected =
    expectedPubkey === undefined
      ? undefined
      : requireAccountPubkey(expectedPubkey, "Expected account")
  if (expected !== undefined && pubkey !== expected) {
    throw new Error("Account network local state belongs to another account")
  }

  const version = assertVersion(value.version, "Account network state version")
  if (version !== ACCOUNT_NETWORK_LOCAL_STATE_VERSION) {
    throw new Error(`Unsupported account network state version: ${version}`)
  }
  const migrationVersion = assertVersion(
    value.migrationVersion,
    "Account network migration version"
  )
  if (migrationVersion > ACCOUNT_NETWORK_LOCAL_STATE_MIGRATION_VERSION) {
    throw new Error(
      `Unsupported account network migration version: ${migrationVersion}`
    )
  }
  if (!Array.isArray(value.exclusions)) {
    throw new Error("Account network exclusions must be an array")
  }
  const exclusionUrls = new Set<string>()
  const exclusions = value.exclusions.map((candidate) => {
    const exclusion = normalizeExclusion(candidate)
    if (exclusionUrls.has(exclusion.relayUrl)) {
      throw new Error(
        "Account network exclusions must not contain duplicate relay URLs"
      )
    }
    exclusionUrls.add(exclusion.relayUrl)
    return exclusion
  })

  return {
    pubkey,
    version,
    migrationVersion,
    exclusions,
    preferredRelayOrder: normalizeRelayUrlsStrict(
      value.preferredRelayOrder,
      "Account network preferredRelayOrder"
    ),
    relayScans: normalizeRelayScans(value.relayScans),
    updatedAt: assertTimestamp(
      value.updatedAt,
      "Account network local state updatedAt"
    ),
  }
}

export function emptyAccountNetworkLocalState(
  pubkey: string,
  now: () => number = Date.now
): AccountNetworkLocalState {
  return {
    pubkey: requireAccountPubkey(pubkey),
    version: ACCOUNT_NETWORK_LOCAL_STATE_VERSION,
    migrationVersion: ACCOUNT_NETWORK_LOCAL_STATE_UNMIGRATED_VERSION,
    exclusions: [],
    preferredRelayOrder: [],
    relayScans: [],
    updatedAt: assertTimestamp(now(), "Account network local state updatedAt"),
  }
}

function createDexieRepository(
  now: () => number = Date.now
): AccountNetworkLocalStateRepository {
  return {
    async get(pubkey) {
      const normalizedPubkey = requireAccountPubkey(pubkey)
      const record = await db.accountNetworkLocalState.get(normalizedPubkey)
      return record
        ? cloneState(
            normalizeAccountNetworkLocalState(record, normalizedPubkey)
          )
        : undefined
    },

    async replace(pubkey, state) {
      const normalizedPubkey = requireAccountPubkey(pubkey)
      const normalized = normalizeAccountNetworkLocalState(
        state,
        normalizedPubkey
      )
      await db.transaction("rw", db.accountNetworkLocalState, async () => {
        await db.accountNetworkLocalState.put(cloneState(normalized))
      })
      return cloneState(normalized)
    },

    async update(pubkey, updater) {
      const normalizedPubkey = requireAccountPubkey(pubkey)
      return await db.transaction(
        "rw",
        db.accountNetworkLocalState,
        async () => {
          const stored = await db.accountNetworkLocalState.get(normalizedPubkey)
          const current = stored
            ? normalizeAccountNetworkLocalState(stored, normalizedPubkey)
            : emptyAccountNetworkLocalState(normalizedPubkey, now)
          const next = normalizeAccountNetworkLocalState(
            updater(cloneState(current)),
            normalizedPubkey
          )
          if (next.updatedAt < current.updatedAt) {
            throw new Error("Account network updatedAt cannot move backwards")
          }
          if (!stored || JSON.stringify(stored) !== JSON.stringify(next)) {
            await db.accountNetworkLocalState.put(cloneState(next))
          }
          return cloneState(next)
        }
      )
    },
  }
}

export const dexieAccountNetworkLocalStateRepository = createDexieRepository()

/** Observe committed local policy changes in this and other browser contexts. */
export function subscribeAccountNetworkLocalState(
  pubkey: string,
  observer: {
    onChange(state: AccountNetworkLocalState | undefined): void
    onError(error: unknown): void
  }
): () => void {
  const normalizedPubkey = requireAccountPubkey(pubkey)
  const subscription = liveQuery(() =>
    db.accountNetworkLocalState.get(normalizedPubkey)
  ).subscribe({
    next: (record) =>
      observer.onChange(
        record
          ? normalizeAccountNetworkLocalState(record, normalizedPubkey)
          : undefined
      ),
    error: (error) => observer.onError(error),
  })
  return () => subscription.unsubscribe()
}

export function createInMemoryAccountNetworkLocalStateRepository(
  initial: readonly AccountNetworkLocalState[] = [],
  now: () => number = Date.now
): AccountNetworkLocalStateRepository {
  const records = new Map<string, AccountNetworkLocalState>()
  for (const candidate of initial) {
    const normalized = normalizeAccountNetworkLocalState(candidate)
    if (records.has(normalized.pubkey)) {
      throw new Error("Duplicate account network local state account")
    }
    records.set(normalized.pubkey, cloneState(normalized))
  }

  return {
    async get(pubkey) {
      const normalizedPubkey = requireAccountPubkey(pubkey)
      const record = records.get(normalizedPubkey)
      return record ? cloneState(record) : undefined
    },

    async replace(pubkey, state) {
      const normalizedPubkey = requireAccountPubkey(pubkey)
      const normalized = normalizeAccountNetworkLocalState(
        state,
        normalizedPubkey
      )
      records.set(normalizedPubkey, cloneState(normalized))
      return cloneState(normalized)
    },

    async update(pubkey, updater) {
      const normalizedPubkey = requireAccountPubkey(pubkey)
      const current = records.get(normalizedPubkey)
        ? cloneState(records.get(normalizedPubkey)!)
        : emptyAccountNetworkLocalState(normalizedPubkey, now)
      const next = normalizeAccountNetworkLocalState(
        updater(cloneState(current)),
        normalizedPubkey
      )
      if (next.updatedAt < current.updatedAt) {
        throw new Error("Account network updatedAt cannot move backwards")
      }
      records.set(normalizedPubkey, cloneState(next))
      return cloneState(next)
    },
  }
}

export function applyAccountNetworkRelayExclusion(
  state: AccountNetworkLocalState,
  input: {
    relayUrl: string
    relayListFrontier: AccountNetworkFrontierReference
    inboxDeclarationFrontier: AccountNetworkFrontierReference
    committedAt: number
  }
): AccountNetworkLocalState {
  const current = normalizeAccountNetworkLocalState(state)
  const exclusion: AccountNetworkRelayExclusion = {
    relayUrl: normalizeAccountRelayUrl(
      input.relayUrl,
      "Account network exclusion URL"
    ),
    relayListFrontier: normalizeFrontierReference(
      input.relayListFrontier,
      "Account network relay-list frontier"
    ),
    inboxDeclarationFrontier: normalizeFrontierReference(
      input.inboxDeclarationFrontier,
      "Account network inbox-declaration frontier"
    ),
    committedAt: assertTimestamp(
      input.committedAt,
      "Account network exclusion committedAt"
    ),
  }
  const existingIndex = current.exclusions.findIndex(
    (candidate) => candidate.relayUrl === exclusion.relayUrl
  )
  const exclusions = [...current.exclusions]
  if (existingIndex === -1) exclusions.push(exclusion)
  else exclusions[existingIndex] = exclusion

  return normalizeAccountNetworkLocalState({
    ...current,
    exclusions,
    updatedAt: Math.max(current.updatedAt, exclusion.committedAt),
  })
}

function assertAuthoritativeOwnEvent(
  accountPubkey: string,
  event: SignedPublicNostrEvent,
  expectedKind: number,
  label: string
): void {
  if (!isValidSignedPublicNostrEvent(event)) {
    throw new Error(`${label} must be a valid signed event`)
  }
  if (
    event.id !== event.id.toLowerCase() ||
    event.pubkey !== event.pubkey.toLowerCase() ||
    event.sig !== event.sig.toLowerCase()
  ) {
    throw new Error(`${label} must use canonical lowercase hex`)
  }
  if (event.pubkey !== accountPubkey) {
    throw new Error(`${label} author does not match the account`)
  }
  if (event.kind !== expectedKind) {
    throw new Error(`${label} has the wrong event kind`)
  }
}

function explicitRelayUrlsForEvent(event: SignedPublicNostrEvent): Set<string> {
  const relayUrls: string[] = []
  if (event.kind === EVENT_KINDS.RELAY_LIST) {
    for (const tag of event.tags) {
      if (tag[0] !== "r" || typeof tag[1] !== "string") continue
      const marker = tag[2]?.trim().toLowerCase()
      if (marker && marker !== "read" && marker !== "write") continue
      relayUrls.push(tag[1])
    }
  } else {
    for (const tag of event.tags) {
      if (tag[0] === "relay" && typeof tag[1] === "string") {
        relayUrls.push(tag[1])
      }
    }
  }
  return new Set(normalizeCandidateRelayUrls(relayUrls))
}

function isStrictlyStrongerFrontier(
  candidate: { eventId: string; createdAt: number },
  current: AccountNetworkFrontierReference
): boolean {
  if (current.eventId === null || current.createdAt === null) return true
  if (candidate.createdAt > current.createdAt) return true
  if (candidate.createdAt < current.createdAt) return false
  if (candidate.eventId === current.eventId) return false
  // NIP-01 retains the lexicographically lowest id at equal timestamps.
  return candidate.eventId < current.eventId
}

export function applyAuthoritativeAccountNetworkReadds(
  state: AccountNetworkLocalState,
  input: AccountNetworkAuthoritativeReadds
): AccountNetworkLocalState {
  const current = normalizeAccountNetworkLocalState(state)
  const candidates: Array<{
    kind:
      typeof EVENT_KINDS.RELAY_LIST | typeof EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
    event: SignedPublicNostrEvent
    relayUrls: Set<string>
  }> = []

  if (input.relayList) {
    assertAuthoritativeOwnEvent(
      current.pubkey,
      input.relayList,
      EVENT_KINDS.RELAY_LIST,
      "Authoritative relay list"
    )
    candidates.push({
      kind: EVENT_KINDS.RELAY_LIST,
      event: input.relayList,
      relayUrls: explicitRelayUrlsForEvent(input.relayList),
    })
  }
  if (input.inboxDeclaration) {
    assertAuthoritativeOwnEvent(
      current.pubkey,
      input.inboxDeclaration,
      EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      "Authoritative inbox declaration"
    )
    candidates.push({
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      event: input.inboxDeclaration,
      relayUrls: explicitRelayUrlsForEvent(input.inboxDeclaration),
    })
  }

  const exclusions = current.exclusions.filter((exclusion) => {
    return !candidates.some((candidate) => {
      if (!candidate.relayUrls.has(exclusion.relayUrl)) return false
      const frontier =
        candidate.kind === EVENT_KINDS.RELAY_LIST
          ? exclusion.relayListFrontier
          : exclusion.inboxDeclarationFrontier
      return isStrictlyStrongerFrontier(
        {
          eventId: candidate.event.id,
          createdAt: candidate.event.created_at,
        },
        frontier
      )
    })
  })

  if (exclusions.length === current.exclusions.length) return current
  const updatedAt = assertTimestamp(
    input.updatedAt ?? Date.now(),
    "Account network re-add updatedAt"
  )
  return normalizeAccountNetworkLocalState({
    ...current,
    exclusions,
    updatedAt: Math.max(current.updatedAt, updatedAt),
  })
}

export function replaceAccountNetworkPreferredRelayOrder(
  state: AccountNetworkLocalState,
  preferredRelayOrder: readonly string[],
  updatedAt: number = Date.now()
): AccountNetworkLocalState {
  const current = normalizeAccountNetworkLocalState(state)
  return normalizeAccountNetworkLocalState({
    ...current,
    preferredRelayOrder: normalizeRelayUrlsStrict(
      preferredRelayOrder,
      "Account network preferredRelayOrder"
    ),
    updatedAt: Math.max(
      current.updatedAt,
      assertTimestamp(updatedAt, "Account network preferred order updatedAt")
    ),
  })
}

export function replaceAccountNetworkRelayScans(
  state: AccountNetworkLocalState,
  relayScans: readonly RelayScanResult[],
  updatedAt: number = Date.now()
): AccountNetworkLocalState {
  const current = normalizeAccountNetworkLocalState(state)
  return normalizeAccountNetworkLocalState({
    ...current,
    relayScans: normalizeRelayScans(relayScans),
    updatedAt: Math.max(
      current.updatedAt,
      assertTimestamp(updatedAt, "Account network relay scans updatedAt")
    ),
  })
}

export async function filterEligibleAccountRelayUrls(input: {
  accountPubkey: string
  candidateRelayUrls: readonly string[]
  repository?: Pick<AccountNetworkLocalStateRepository, "get">
}): Promise<string[]> {
  const accountPubkey = normalizeAccountNetworkPubkey(input.accountPubkey)
  if (!accountPubkey) return []
  const repository = input.repository ?? dexieAccountNetworkLocalStateRepository

  try {
    // This is intentionally a fresh durable read on every admission attempt.
    const stored = await repository.get(accountPubkey)
    const state = stored
      ? normalizeAccountNetworkLocalState(stored, accountPubkey)
      : undefined
    const excluded = new Set(
      state?.exclusions.map((exclusion) => exclusion.relayUrl) ?? []
    )
    return normalizeCandidateRelayUrls(input.candidateRelayUrls).filter(
      (relayUrl) => !excluded.has(relayUrl)
    )
  } catch {
    // Durable local policy is the authority for whole-relay contact cutoffs.
    return []
  }
}

export async function orderEquivalentAccountRelayOperations<T>(input: {
  accountPubkey: string
  operations: readonly AccountNetworkRelayOperation<T>[]
  repository?: Pick<AccountNetworkLocalStateRepository, "get">
}): Promise<AccountNetworkRelayOperation<T>[]> {
  const unchanged = [...input.operations]
  const accountPubkey = normalizeAccountNetworkPubkey(input.accountPubkey)
  if (!accountPubkey) return unchanged
  const repository = input.repository ?? dexieAccountNetworkLocalStateRepository

  let state: AccountNetworkLocalState | undefined
  try {
    const stored = await repository.get(accountPubkey)
    state = stored
      ? normalizeAccountNetworkLocalState(stored, accountPubkey)
      : undefined
  } catch {
    // Ordering is a local preference, not an authorization gate.
    return unchanged
  }
  if (!state || state.preferredRelayOrder.length === 0) return unchanged

  const rank = new Map(
    state.preferredRelayOrder.map((relayUrl, index) => [relayUrl, index])
  )
  const positionsByGroup = new Map<string, number[]>()
  input.operations.forEach((operation, index) => {
    if (typeof operation.equivalenceKey !== "string") return
    const positions = positionsByGroup.get(operation.equivalenceKey) ?? []
    positions.push(index)
    positionsByGroup.set(operation.equivalenceKey, positions)
  })

  const result = [...input.operations]
  for (const positions of positionsByGroup.values()) {
    const sorted = positions
      .map((position, localIndex) => ({
        operation: input.operations[position]!,
        localIndex,
      }))
      .sort((left, right) => {
        const leftUrl = normalizeCandidateRelayUrls([
          left.operation.relayUrl,
        ])[0]
        const rightUrl = normalizeCandidateRelayUrls([
          right.operation.relayUrl,
        ])[0]
        const leftRank = leftUrl === undefined ? undefined : rank.get(leftUrl)
        const rightRank =
          rightUrl === undefined ? undefined : rank.get(rightUrl)
        if (leftRank === undefined && rightRank === undefined) {
          return left.localIndex - right.localIndex
        }
        if (leftRank === undefined) return 1
        if (rightRank === undefined) return -1
        return leftRank - rightRank || left.localIndex - right.localIndex
      })
    positions.forEach((position, index) => {
      result[position] = sorted[index]!.operation
    })
  }
  return result
}
