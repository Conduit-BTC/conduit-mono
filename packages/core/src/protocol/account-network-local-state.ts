import { liveQuery } from "dexie"
import { config } from "../config"
import {
  db,
  type AccountNetworkFrontierReference,
  type AccountNetworkLocalState,
  type AccountNetworkRelayExclusion,
} from "../db"
import {
  createDefaultAccountNetworkRoutingPolicy,
  isAccountNetworkRoutingSourceEnabled,
  migrateLegacyAccountNetworkRoutingPolicy,
  normalizeAccountNetworkRoutingPolicy,
  type AccountNetworkRoutingPolicy,
} from "./account-network-routing-policy"
import { EVENT_KINDS } from "./kinds"
import {
  normalizeOwnerSelectedRelayUrls,
  normalizeSecureOrIsolatedE2eRelayUrls,
  normalizeRelaySettingsState,
  RELAY_SETTINGS_STORAGE_VERSION,
  type RelayScanResult,
  type RelaySettingsState,
} from "./relay-settings"
import type { SignedPublicNostrEvent } from "./signed-event"
import { isVerifiedNostrEvent } from "./verified-public-event"
import {
  mergeRelayTargets,
  type RelayGrant,
  type RelayOperation,
  type RelayTarget,
} from "./relay-authority"

export type {
  AccountNetworkFrontierReference,
  AccountNetworkLocalState,
  AccountNetworkRelayExclusion,
} from "../db"

export const ACCOUNT_NETWORK_LOCAL_STATE_VERSION = 2
const LEGACY_ACCOUNT_NETWORK_LOCAL_STATE_VERSION = 1

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
  replaceRoutingPolicy(
    pubkey: string,
    routingPolicy: AccountNetworkRoutingPolicy,
    updatedAt?: number
  ): Promise<AccountNetworkLocalState>
  updateRoutingPolicy(
    pubkey: string,
    updater: (
      current: AccountNetworkRoutingPolicy
    ) => AccountNetworkRoutingPolicy,
    updatedAt?: number
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
  const normalized = normalizeOwnerSelectedRelayUrls([value])[0]
  if (!normalized) throw new Error(`${label} must be a valid relay URL`)
  return normalized
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
        relayIconUrl: value.relayIconUrl,
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
    ...(entry.relayIconUrl ? { relayIconUrl: entry.relayIconUrl } : {}),
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
  if (
    version !== LEGACY_ACCOUNT_NETWORK_LOCAL_STATE_VERSION &&
    version !== ACCOUNT_NETWORK_LOCAL_STATE_VERSION
  ) {
    throw new Error(`Unsupported account network state version: ${version}`)
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
    version: ACCOUNT_NETWORK_LOCAL_STATE_VERSION,
    routingPolicy:
      version === LEGACY_ACCOUNT_NETWORK_LOCAL_STATE_VERSION
        ? migrateLegacyAccountNetworkRoutingPolicy()
        : normalizeAccountNetworkRoutingPolicy(value.routingPolicy),
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
    routingPolicy: createDefaultAccountNetworkRoutingPolicy(),
    exclusions: [],
    preferredRelayOrder: [],
    relayScans: [],
    updatedAt: assertTimestamp(now(), "Account network local state updatedAt"),
  }
}

function createDexieRepository(
  now: () => number = Date.now
): AccountNetworkLocalStateRepository {
  const repository: AccountNetworkLocalStateRepository = {
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

    async replaceRoutingPolicy(pubkey, routingPolicy, updatedAt = now()) {
      return await repository.update(pubkey, (current) =>
        replaceAccountNetworkRoutingPolicy(current, routingPolicy, updatedAt)
      )
    },

    async updateRoutingPolicy(pubkey, updater, updatedAt = now()) {
      return await repository.update(pubkey, (current) =>
        replaceAccountNetworkRoutingPolicy(
          current,
          updater(structuredClone(current.routingPolicy)),
          updatedAt
        )
      )
    },
  }
  return repository
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

  const repository: AccountNetworkLocalStateRepository = {
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

    async replaceRoutingPolicy(pubkey, routingPolicy, updatedAt = now()) {
      return await repository.update(pubkey, (current) =>
        replaceAccountNetworkRoutingPolicy(current, routingPolicy, updatedAt)
      )
    },

    async updateRoutingPolicy(pubkey, updater, updatedAt = now()) {
      return await repository.update(pubkey, (current) =>
        replaceAccountNetworkRoutingPolicy(
          current,
          updater(structuredClone(current.routingPolicy)),
          updatedAt
        )
      )
    },
  }
  return repository
}

export function replaceAccountNetworkRoutingPolicy(
  state: AccountNetworkLocalState,
  routingPolicy: AccountNetworkRoutingPolicy,
  updatedAt: number = Date.now()
): AccountNetworkLocalState {
  const current = normalizeAccountNetworkLocalState(state)
  const normalizedRoutingPolicy =
    normalizeAccountNetworkRoutingPolicy(routingPolicy)
  if (
    JSON.stringify(current.routingPolicy) ===
    JSON.stringify(normalizedRoutingPolicy)
  ) {
    return current
  }
  return normalizeAccountNetworkLocalState({
    ...current,
    routingPolicy: normalizedRoutingPolicy,
    updatedAt: Math.max(
      current.updatedAt,
      assertTimestamp(updatedAt, "Account network routing policy updatedAt")
    ),
  })
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
  if (!isVerifiedNostrEvent(event)) {
    throw new Error(`${label} must be an admitted signed event`)
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
  return new Set(normalizeOwnerSelectedRelayUrls(relayUrls))
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

function configuredGrantRelayUrls(grant: RelayGrant): readonly string[] {
  if (grant.kind === "discovery") {
    return grant.registry === "owner_10002"
      ? [...config.dmDeclarationDiscoveryRelayUrls, ...config.defaultRelays]
      : config.dmDeclarationDiscoveryRelayUrls
  }
  if (grant.kind === "app") {
    switch (grant.bucket) {
      case "general_read":
        return config.appReadRelayUrls
      case "commerce_read":
        return config.appCommerceRelayUrls
      case "general_write":
        return config.appWriteRelayUrls
      case "commerce_write":
        return config.commerceRelayUrls
      case "recipient_delivery":
        return config.dmInboxDefaultRelayUrls.length > 0
          ? config.dmInboxDefaultRelayUrls
          : config.appReadRelayUrls
      case "recipient_fallback":
        return config.commerceDmFallbackRelayUrls
      case "core_public_write":
        return config.corePublicFallbackRelayUrls
      case "commerce_discovery_write":
        return config.commerceDiscoveryRelayUrls
      case "search_index":
        return config.searchIndexRelayUrls
      case "inbox_read":
        return config.appRelayDefinitions
          .filter((definition) => definition.privateInbox)
          .map((definition) => definition.url)
      case "author_readback":
        return [...config.appWriteRelayUrls, ...config.commerceRelayUrls]
      case "diagnostic_read":
        return config.appRelayDefinitions.map((definition) => definition.url)
    }
  }
  if (grant.kind === "public_fallback") {
    switch (grant.bucket) {
      case "core_public":
        return config.corePublicFallbackRelayUrls
      case "commerce_discovery":
        return config.commerceDiscoveryRelayUrls
      case "search_index":
        return config.searchIndexRelayUrls
      case "zap_public":
        return config.zapRelayUrls
      case "default":
        return config.defaultRelays
    }
  }
  if (grant.kind === "compatibility") {
    return grant.policy === "order_delivery"
      ? config.dmCompatibilityOrderRelayUrls
      : config.commerceDmFallbackRelayUrls
  }
  return []
}

/**
 * Resolve own signed selection through the existing admitted evidence owners.
 * This performs no relay I/O. A URL supplied by a caller is never proof.
 */
async function currentOwnerGrantSelection(
  pubkey: string,
  grant: Extract<
    RelayGrant,
    {
      kind:
        | "owner_nip65"
        | "owner_nip17"
        | "owner_selection"
        | "recovery"
        | "retained_inbox"
    }
  >,
  relayUrl: string,
  repositories?: {
    owner?: Pick<
      import("./owner-relay-list-evidence").OwnerRelayListEvidenceRepository,
      "get"
    >
    inbox?: Pick<
      import("./inbox-declaration-evidence").InboxDeclarationEvidenceRepository,
      "get"
    >
  }
): Promise<boolean> {
  if (grant.ownerPubkey.trim().toLowerCase() !== pubkey) return false
  if (
    grant.kind === "owner_nip65" ||
    (grant.kind === "owner_selection" && grant.eventKind === 10002)
  ) {
    const { readRetainedOwnerRelayList } =
      await import("./owner-relay-list-evidence")
    const retained = await readRetainedOwnerRelayList(pubkey, {
      durableOnly: true,
      durableEvidenceRepository: repositories?.owner,
    })
    const current = retained?.current
    if (!current) return false
    if (
      grant.kind === "owner_selection" &&
      current.signedEvent.id !== grant.eventId
    ) {
      return false
    }
    if (grant.kind === "owner_selection" && current.state !== "declared")
      return false
    if (
      grant.kind === "owner_nip65" &&
      current.state !== "declared" &&
      (current.state !== "malformed" ||
        retained.lastUsable?.state !== "declared")
    ) {
      return false
    }
    const selection = grant.kind === "owner_nip65" ? grant.selection : "write"
    const preferences =
      grant.kind === "owner_nip65" ? retained.preferences : current.preferences
    return preferences.some(
      (preference) =>
        preference.url === relayUrl &&
        (selection === "read"
          ? preference.readEnabled
          : preference.writeEnabled)
    )
  }
  const [
    { readRetainedInboxDeclarationEvidence },
    { getActiveInboxCutoverRecoveryRelayUrls },
  ] = await Promise.all([
    import("./private-message-routing"),
    import("./inbox-declaration-evidence"),
  ])
  const retained = await readRetainedInboxDeclarationEvidence(pubkey, {
    durableEvidenceRepository: repositories?.inbox,
  })
  if (!retained) return false
  if (grant.kind === "recovery") {
    if (
      grant.replacementEventId &&
      !retained.cutoverRecoveries?.some(
        (recovery) =>
          recovery.replacementEventId === grant.replacementEventId &&
          recovery.relayUrls.includes(relayUrl) &&
          !recovery.policyBlockedRelayUrls?.includes(relayUrl) &&
          (recovery.expiresAt === undefined || Date.now() < recovery.expiresAt)
      )
    )
      return false
    return getActiveInboxCutoverRecoveryRelayUrls(retained).includes(relayUrl)
  }
  if (grant.kind === "retained_inbox") {
    return retained.lastUsable?.secureRelayUrls.includes(relayUrl) === true
  }
  if (retained.current.state !== "declared") return false
  if (
    grant.kind === "owner_selection" &&
    retained.current.signedEvent.id !== grant.eventId
  )
    return false
  return retained.current.secureRelayUrls.includes(relayUrl)
}

/** Final account contact admission: every URL needs a live, applicable grant. */
export async function filterEligibleAccountRelayTargets(input: {
  accountPubkey: string
  authenticatedPubkey?: string | null
  targets: readonly RelayTarget[]
  operation: RelayOperation
  repository?: Pick<AccountNetworkLocalStateRepository, "get">
  ownerRelayListEvidenceRepository?: Pick<
    import("./owner-relay-list-evidence").OwnerRelayListEvidenceRepository,
    "get"
  >
  inboxDeclarationEvidenceRepository?: Pick<
    import("./inbox-declaration-evidence").InboxDeclarationEvidenceRepository,
    "get"
  >
  propagatePolicyReadErrors?: boolean
}): Promise<RelayTarget[]> {
  const accountPubkey = normalizeAccountNetworkPubkey(input.accountPubkey)
  if (!accountPubkey) return []
  const authenticatedPubkey = input.authenticatedPubkey
    ? normalizeAccountNetworkPubkey(input.authenticatedPubkey)
    : null
  const repository = input.repository ?? dexieAccountNetworkLocalStateRepository
  try {
    const stored = await repository.get(accountPubkey)
    const state = stored
      ? normalizeAccountNetworkLocalState(stored, accountPubkey)
      : undefined
    const policy =
      state?.routingPolicy ?? createDefaultAccountNetworkRoutingPolicy()
    const excluded = new Set(
      state?.exclusions.map((item) => item.relayUrl) ?? []
    )
    const result: RelayTarget[] = []
    for (const target of mergeRelayTargets(input.targets)) {
      if (excluded.has(target.url)) continue
      const secure = normalizeSecureOrIsolatedE2eRelayUrls([
        target.url,
      ]).includes(target.url)
      const admitted: RelayGrant[] = []
      for (const grant of target.grants) {
        if (grant.operation !== input.operation) continue
        if (
          !secure &&
          ![
            "owner_nip65",
            "owner_nip17",
            "owner_selection",
            "recovery",
            "retained_inbox",
          ].includes(grant.kind)
        )
          continue
        if (grant.kind === "app" || grant.kind === "public_fallback") {
          const bucketOperation =
            grant.kind === "public_fallback"
              ? "read"
              : grant.bucket === "general_write" ||
                  grant.bucket === "commerce_write" ||
                  grant.bucket === "recipient_delivery" ||
                  grant.bucket === "recipient_fallback" ||
                  grant.bucket === "core_public_write" ||
                  grant.bucket === "commerce_discovery_write"
                ? "write"
                : "read"
          if (
            grant.operation === bucketOperation &&
            isAccountNetworkRoutingSourceEnabled(policy, "app") &&
            configuredGrantRelayUrls(grant).includes(target.url)
          )
            admitted.push(grant)
          continue
        }
        if (grant.kind === "discovery") {
          if (configuredGrantRelayUrls(grant).includes(target.url))
            admitted.push(grant)
          continue
        }
        if (grant.kind === "compatibility") {
          if (
            configuredGrantRelayUrls(grant).includes(target.url) &&
            (grant.operation === "read" ||
              (config.dmCompatibilityOrderRoutingEnabled &&
                isAccountNetworkRoutingSourceEnabled(policy, "app")))
          ) {
            admitted.push(grant)
          }
          continue
        }
        if (
          grant.kind === "owner_nip65" ||
          grant.kind === "owner_nip17" ||
          grant.kind === "owner_selection" ||
          grant.kind === "recovery" ||
          grant.kind === "retained_inbox"
        ) {
          if (
            authenticatedPubkey === accountPubkey &&
            (grant.kind !== "owner_nip65" ||
              isAccountNetworkRoutingSourceEnabled(policy, "personal"))
          ) {
            try {
              if (
                await currentOwnerGrantSelection(
                  accountPubkey,
                  grant,
                  target.url,
                  {
                    owner: input.ownerRelayListEvidenceRepository,
                    inbox: input.inboxDeclarationEvidenceRepository,
                  }
                )
              )
                admitted.push(grant)
            } catch {
              // An unavailable signed-evidence store denies this owner grant,
              // without vetoing an independent grant on the same target.
            }
          }
          continue
        }
        if (
          secure &&
          grant.kind === "recipient_nip17" &&
          /^[0-9a-f]{64}$/.test(grant.recipientPubkey.trim().toLowerCase())
        ) {
          try {
            const { readRetainedInboxDeclaration } =
              await import("./private-message-routing")
            const declaration = await readRetainedInboxDeclaration(
              grant.recipientPubkey,
              {
                durableEvidenceRepository:
                  input.inboxDeclarationEvidenceRepository,
              }
            )
            if (
              declaration?.state === "declared" &&
              declaration.relayUrls.includes(target.url) &&
              (!grant.eventId || grant.eventId === declaration.eventId)
            ) {
              admitted.push(grant)
            }
          } catch {
            // Inconclusive recipient evidence denies only this declaration grant.
          }
          continue
        }
        if (
          secure &&
          (grant.kind === "remote_nip65" ||
            grant.kind === "public_hint" ||
            grant.kind === "source_delivery")
        ) {
          admitted.push(grant)
        }
      }
      if (admitted.length > 0)
        result.push({ url: target.url, grants: admitted })
    }
    return result
  } catch (error) {
    if (input.propagatePolicyReadErrors) throw error
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
        // Ordering only ranks otherwise eligible operations. Canonicalize
        // owner-stored ws:// preferences here without granting I/O authority.
        const leftUrl = normalizeOwnerSelectedRelayUrls([
          left.operation.relayUrl,
        ])[0]
        const rightUrl = normalizeOwnerSelectedRelayUrls([
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
