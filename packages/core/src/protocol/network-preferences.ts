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
  applyAuthoritativeAccountNetworkReadds,
  dexieAccountNetworkLocalStateRepository,
  normalizeAccountNetworkLocalState,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import {
  readRetainedInboxDeclaration,
  resolveInboxDeclaration,
  type InboxDeclarationResolution,
  type ResolveInboxDeclarationOptions,
} from "./private-message-routing"
import {
  createRelaySettingsFromPreferences,
  normalizeOwnerSelectedRelayUrls,
  type RelaySettingsPlanningSnapshot,
  type RelaySettingsState,
} from "./relay-settings"
import { getAccountRelayScope } from "./session"

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

export interface AccountNetworkPreferencesReconciliation {
  projection: AccountNetworkPreferencesProjection
  ownerRelayList: OwnerRelayListResolution
  inboxDeclaration: InboxDeclarationResolution
  /** Exact canonical whole-relay exclusion set observed for this reconciliation. */
  localExcludedRelayUrls: string[]
}

export interface ReconcileAccountNetworkPreferencesOptions {
  /** Both lookups receive this same app-independent bounded source set. */
  relayUrls?: readonly string[]
  ownerRelayList?: ResolveOwnerRelayListOptions
  inboxDeclaration?: ResolveInboxDeclarationOptions
  resolveOwner?: typeof resolveOwnerRelayList
  resolveInbox?: typeof resolveInboxDeclaration
  localStateRepository?: AccountNetworkLocalStateRepository
  /** Account whose local cutoff gates the reconciliation relay attempts. */
  requestingAccountPubkey?: string | null
  /** Active authenticated account for owner-selected ws:// read authority. */
  authenticatedPubkey?: string | null
  /** Cancels queued or in-flight reconciliation I/O on session change. */
  signal?: AbortSignal
  /** Live account session authority for non-signal reconciliation reads. */
  shouldContinue?: ResolveOwnerRelayListOptions["shouldContinue"]
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
  localStateRepository?: AccountNetworkLocalStateRepository
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
  const excludedRelayUrls = (
    retainedLocalState?.exclusions.map((exclusion) => exclusion.relayUrl) ?? []
  ).sort()
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
      shouldContinue: options.shouldContinue,
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
      shouldContinue: options.shouldContinue,
      allowLocalRelayUrlsForPubkey: normalizedPubkey,
      // A fresh signer connection is a reconciliation boundary, even when a
      // process-local kind-10050 resolution is still inside its normal TTL.
      freshnessMs: 0,
    }),
  ])
  const [durableOwnerEvidence, durableInboxEvidence] = await Promise.all([
    ownerEvidenceRepository
      .get(normalizedPubkey)
      .then((record) => record ?? null)
      .catch(() => null),
    inboxEvidenceRepository
      .get(normalizedInboxPubkey)
      .then((record) => record ?? null)
      .catch(() => null),
  ])
  await applyFreshAuthoritativeNetworkReadds({
    pubkey: normalizedPubkey,
    ownerRelayList,
    ownerEvidence: durableOwnerEvidence,
    inboxDeclaration,
    inboxEvidence: durableInboxEvidence,
    repository: localStateRepository,
    updatedAt: Date.now(),
  })
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
  }
}
