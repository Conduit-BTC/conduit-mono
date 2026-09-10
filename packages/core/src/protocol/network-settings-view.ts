import { config } from "../config"
import type { AccountNetworkLocalState } from "./account-network-local-state"
import type { AccountNetworkPreferencesReconciliation } from "./network-preferences"
import type { RelayAuthEvidenceState } from "./relay-executor"
import { tryNormalizeRelayUrl, type RelayScanResult } from "./relay-settings"
import { MAX_DECLARED_INBOX_WRITE_RELAYS } from "./private-message-routing"

export type AccountNetworkRole = "read" | "publish" | "private_inbox"
export type AccountNetworkRelayReachability =
  "responded" | "issue" | "not_checked"
export type AccountNetworkRelayConfiguredUse =
  | "app_publishing"
  | "product_discovery"
  | "search"
  | "inbox_discovery"
  | "order_messages"
  | "private_inbox"
  | "general_reads"
  | "public_activity"

export interface AccountNetworkRelayCapabilityView {
  /** Exact Conduit configuration; never inferred from relay observations. */
  configuredUses: readonly AccountNetworkRelayConfiguredUse[]
  observedCommerce: boolean
  nip11: "not_checked" | "available" | "unavailable"
  searchAdvertised: boolean
  authEvidence: RelayAuthEvidenceState | "advertised"
  relayName?: string
  observedAt?: number
}

export interface AccountNetworkRelayRowView {
  url: string
  readEnabled: boolean
  publishEnabled: boolean
  privateInboxEnabled: boolean
  readState: "published" | "pending" | "draft" | null
  publishState: "published" | "pending" | "draft" | null
  privateInboxState: "published" | "pending" | "draft" | null
  signedPosition: number | null
  candidate: boolean
  /** Hidden previous inbox used only for account-owned recovery reads. */
  recoveryReadOnly?: boolean
  reachability: AccountNetworkRelayReachability
  capability: AccountNetworkRelayCapabilityView
}

export interface AccountNetworkFrontierView {
  state: string
  stale: boolean
  retained: boolean
  coverage: "complete" | "partial" | "unavailable" | "not_checked"
  eventCreatedAt: number | null
  observedAt: number | null
  sourceRelayCount: number
}

/**
 * Delivery progress that current reconciliation evidence can prove without a
 * second update journal.
 */
export interface AccountNetworkPendingExactDeliveryView {
  kind: 10002 | 10050
  label: "Read and Publish" | "Private inbox"
  eventId: string
  /** Confirmation is explicit because zero eligible targets is not readback. */
  confirmationState: "exact_confirmed" | "readback_pending" | "policy_blocked"
  eligibleTargetCount: number
  exactReadbackCount: number
  unresolvedCount: number
  excludedTargetCount: number
  retryAvailable: boolean
}

export interface AccountNetworkSettingsView {
  rows: AccountNetworkRelayRowView[]
  relayList: AccountNetworkFrontierView
  inbox: AccountNetworkFrontierView
  pendingExactDeliveries: AccountNetworkPendingExactDeliveryView[]
}

export interface AccountNetworkDesiredRelayRoles {
  url: string
  readEnabled: boolean
  publishEnabled: boolean
  privateInboxEnabled: boolean
}

export interface AccountNetworkDesiredRolesValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export const ACCOUNT_NETWORK_LAST_INBOX_REPLACEMENT_MESSAGE =
  "Select a replacement before removing the last usable Private inbox."
export const ACCOUNT_NETWORK_SINGLE_PUBLISH_WARNING =
  "One Publish relay is valid, but adding another improves redundancy."

const CONFIGURED_USE_SOURCES: readonly [
  AccountNetworkRelayConfiguredUse,
  readonly string[],
][] = [
  ["app_publishing", config.appWriteRelayUrls],
  ["product_discovery", config.commerceDiscoveryRelayUrls],
  ["search", config.searchIndexRelayUrls],
  ["order_messages", config.commerceDmFallbackRelayUrls],
  ["private_inbox", config.dmInboxDefaultRelayUrls],
  ["inbox_discovery", config.dmDeclarationDiscoveryRelayUrls],
  ["general_reads", config.corePublicFallbackRelayUrls],
  ["public_activity", config.zapRelayUrls],
]
const COMMERCE_USES: readonly AccountNetworkRelayConfiguredUse[] = [
  "app_publishing",
  "product_discovery",
  "order_messages",
  "private_inbox",
]

function normalizeAccountRelayUrl(url: string): string {
  const normalized = tryNormalizeRelayUrl(url)
  if (!normalized.ok) throw new Error(normalized.error)
  return normalized.url
}

function normalizedRelayUrl(url: string): string | null {
  try {
    return normalizeAccountRelayUrl(url)
  } catch {
    return null
  }
}

function configuredUsesByUrl(): ReadonlyMap<
  string,
  readonly AccountNetworkRelayConfiguredUse[]
> {
  const usesByUrl = new Map<string, AccountNetworkRelayConfiguredUse[]>()
  for (const [use, relayUrls] of CONFIGURED_USE_SOURCES) {
    for (const relayUrl of relayUrls) {
      const url = normalizedRelayUrl(relayUrl)
      if (!url) continue
      const uses = usesByUrl.get(url) ?? []
      if (!uses.includes(use)) uses.push(use)
      usesByUrl.set(url, uses)
    }
  }
  return usesByUrl
}

function hasObservedCommerceEvidence(scan?: RelayScanResult): boolean {
  if (!scan?.capabilities.commerce) return false
  return [
    scan.observations.auth,
    scan.observations.protectedMessages,
    scan.observations.listings,
    scan.observations.cleanup,
  ].every(
    (observation) =>
      observation.supported &&
      observation.status === "observed" &&
      observation.evidence.includes("active-probe")
  )
}

function capabilityFromEvidence(
  url: string,
  scan: RelayScanResult | undefined,
  authEvidence: RelayAuthEvidenceState | undefined,
  usesByUrl: ReadonlyMap<string, readonly AccountNetworkRelayConfiguredUse[]>
): AccountNetworkRelayCapabilityView {
  const advertisedAuth =
    scan?.observations.auth.status === "advertised" ||
    scan?.capabilities.auth === true
  return {
    configuredUses: usesByUrl.get(url) ?? [],
    observedCommerce: hasObservedCommerceEvidence(scan),
    nip11: !scan
      ? "not_checked"
      : scan.reachable && scan.capabilities.nip11
        ? "available"
        : "unavailable",
    searchAdvertised:
      scan?.observations.search.status === "advertised" ||
      scan?.capabilities.search === true,
    authEvidence:
      authEvidence && authEvidence !== "untested"
        ? authEvidence
        : advertisedAuth
          ? "advertised"
          : "untested",
    ...(scan?.relayName ? { relayName: scan.relayName } : {}),
    ...(scan ? { observedAt: scan.scannedAt } : {}),
  }
}

export function isAccountNetworkRelayCommerceRelevant(
  capability: Pick<
    AccountNetworkRelayCapabilityView,
    "configuredUses" | "observedCommerce"
  >
): boolean {
  return (
    capability.observedCommerce ||
    capability.configuredUses.some((use) => COMMERCE_USES.includes(use))
  )
}

function exclusionUrls(
  localState: AccountNetworkLocalState | null
): ReadonlySet<string> {
  return new Set(
    (localState?.exclusions ?? []).map((exclusion) => exclusion.relayUrl)
  )
}

function reachabilityByUrl(
  reconciliation: AccountNetworkPreferencesReconciliation
): ReadonlyMap<string, AccountNetworkRelayReachability> {
  const reachability = new Map<string, AccountNetworkRelayReachability>()
  const owner = reconciliation.ownerRelayList.observation
  const inbox = reconciliation.inboxDeclaration.observation
  for (const relayUrl of [
    ...(owner?.failedRelayUrls ?? []),
    ...(inbox?.failedRelayUrls ?? []),
  ]) {
    const url = normalizedRelayUrl(relayUrl)
    if (url) reachability.set(url, "issue")
  }
  for (const relayUrl of [
    ...(owner?.successfulRelayUrls ?? []),
    ...(inbox?.successfulRelayUrls ?? []),
  ]) {
    const url = normalizedRelayUrl(relayUrl)
    if (url) reachability.set(url, "responded")
  }
  return reachability
}

function sourceRelayCount(urls: readonly string[] | undefined): number {
  return new Set(urls ?? []).size
}

function inboxObservedAt(
  reconciliation: AccountNetworkPreferencesReconciliation
): number | null {
  const inbox = reconciliation.inboxDeclaration
  if (!inbox.eventId) return null
  if (inbox.observation?.eventId === inbox.eventId) return inbox.fetchedAt
  if (!inbox.observation && !inbox.stale && inbox.sourceRelayUrls?.length) {
    return inbox.fetchedAt
  }
  return null
}

function rowEvidenceTier(row: AccountNetworkRelayRowView): number {
  const draftOnly =
    row.candidate ||
    [row.readState, row.publishState, row.privateInboxState].some(
      (state) => state === "draft"
    )
  if (draftOnly || !isAccountNetworkRelayRowOrderEligible(row)) return 4
  if (
    row.capability.configuredUses.some((use) => COMMERCE_USES.includes(use))
  ) {
    return 0
  }
  if (row.capability.observedCommerce) return 1
  if (
    row.capability.searchAdvertised ||
    row.capability.authEvidence === "advertised" ||
    row.capability.authEvidence === "challenge_observed" ||
    row.capability.authEvidence === "succeeded"
  ) {
    return 2
  }
  return 3
}

export function areAccountNetworkRelayRowsReorderEquivalent(
  left: AccountNetworkRelayRowView,
  right: AccountNetworkRelayRowView
): boolean {
  return (
    rowEvidenceTier(left) === rowEvidenceTier(right) &&
    reachabilityTier(left.reachability) === reachabilityTier(right.reachability)
  )
}

export function isAccountNetworkRelayRowOrderEligible(
  row: AccountNetworkRelayRowView
): boolean {
  return (
    Boolean(row.recoveryReadOnly) ||
    [row.readState, row.publishState, row.privateInboxState].some(
      (state) => state === "published" || state === "pending"
    )
  )
}

function reachabilityTier(
  reachability: AccountNetworkRelayReachability
): number {
  if (reachability === "responded") return 0
  if (reachability === "not_checked") return 1
  return 2
}

export function orderAccountNetworkRelayRows(
  rows: readonly AccountNetworkRelayRowView[],
  preferredRelayOrder: readonly string[] = []
): AccountNetworkRelayRowView[] {
  const preferredRank = new Map(
    preferredRelayOrder.flatMap((relayUrl, index) => {
      const url = normalizedRelayUrl(relayUrl)
      return url ? [[url, index] as const] : []
    })
  )
  return [...rows].sort((left, right) => {
    const evidenceDifference = rowEvidenceTier(left) - rowEvidenceTier(right)
    if (evidenceDifference !== 0) return evidenceDifference
    const reachabilityDifference =
      reachabilityTier(left.reachability) - reachabilityTier(right.reachability)
    if (reachabilityDifference !== 0) return reachabilityDifference
    const leftPreferred = preferredRank.get(left.url)
    const rightPreferred = preferredRank.get(right.url)
    if (leftPreferred !== undefined || rightPreferred !== undefined) {
      if (leftPreferred === undefined) return 1
      if (rightPreferred === undefined) return -1
      if (leftPreferred !== rightPreferred)
        return leftPreferred - rightPreferred
    }
    const leftPosition = left.signedPosition ?? Number.MAX_SAFE_INTEGER
    const rightPosition = right.signedPosition ?? Number.MAX_SAFE_INTEGER
    if (leftPosition !== rightPosition) return leftPosition - rightPosition
    return left.url.localeCompare(right.url)
  })
}

function assertSameAccount(
  reconciliation: AccountNetworkPreferencesReconciliation,
  localState: AccountNetworkLocalState | null
): void {
  if (localState && localState.pubkey !== reconciliation.projection.pubkey) {
    throw new Error("Network settings evidence cannot cross accounts")
  }
}

export function buildAccountNetworkSettingsView(input: {
  reconciliation: AccountNetworkPreferencesReconciliation
  localState: AccountNetworkLocalState | null
  authEvidenceByUrl?: Readonly<
    Record<string, RelayAuthEvidenceState | undefined>
  >
}): AccountNetworkSettingsView {
  assertSameAccount(input.reconciliation, input.localState)
  const excluded = exclusionUrls(input.localState)
  const scans = new Map(
    (input.localState?.relayScans ?? []).map((scan) => [scan.url, scan])
  )
  const auth = input.authEvidenceByUrl ?? {}
  const uses = configuredUsesByUrl()
  const reachability = reachabilityByUrl(input.reconciliation)
  const rowsByUrl = new Map<string, AccountNetworkRelayRowView>()
  const ensureRow = (url: string): AccountNetworkRelayRowView | null => {
    const normalized = normalizedRelayUrl(url)
    if (!normalized || excluded.has(normalized)) return null
    const existing = rowsByUrl.get(normalized)
    if (existing) return existing
    const created: AccountNetworkRelayRowView = {
      url: normalized,
      readEnabled: false,
      publishEnabled: false,
      privateInboxEnabled: false,
      readState: null,
      publishState: null,
      privateInboxState: null,
      signedPosition: null,
      candidate: true,
      reachability: reachability.get(normalized) ?? "not_checked",
      capability: capabilityFromEvidence(
        normalized,
        scans.get(normalized),
        auth[normalized],
        uses
      ),
    }
    rowsByUrl.set(normalized, created)
    return created
  }

  for (const projected of input.reconciliation.projection.rows) {
    const row = ensureRow(projected.url)
    if (!row) continue
    const hasCommittedRole = [
      projected.read,
      projected.write,
      projected.privateInbox,
    ].some((state) => state === "published" || state === "pending")
    row.readEnabled = projected.read !== null
    row.publishEnabled = projected.write !== null
    row.privateInboxEnabled = projected.privateInbox !== null
    row.readState = projected.read
    row.publishState = projected.write
    row.privateInboxState = projected.privateInbox
    row.signedPosition = projected.position
    row.candidate = !hasCommittedRole
  }

  for (const entry of input.reconciliation.legacyReviewCandidate?.draft
    .entries ?? []) {
    const row = ensureRow(entry.url)
    if (!row) continue
    if (row.readState === null && entry.readEnabled) {
      row.readEnabled = true
      row.readState = "draft"
    }
    if (row.publishState === null && entry.writeEnabled) {
      row.publishEnabled = true
      row.publishState = "draft"
    }
  }

  const inbox = input.reconciliation.inboxDeclaration
  for (const relayUrl of [
    ...(inbox.retainedReadRelayUrls ?? []),
    ...(inbox.cutoverRecoveryRelayUrls ?? []),
    ...(input.reconciliation.legacyInboxRecoveryRelayUrls ?? []),
  ]) {
    const row = ensureRow(relayUrl)
    if (!row) continue
    row.recoveryReadOnly = true
    row.candidate = false
  }

  const rows = orderAccountNetworkRelayRows(
    [...rowsByUrl.values()],
    input.localState?.preferredRelayOrder
  )
  const owner = input.reconciliation.ownerRelayList
  const pendingExactDeliveries: AccountNetworkPendingExactDeliveryView[] = []
  if (owner.pendingDistribution) {
    const targets = new Set(owner.pendingDistribution.publishRelayUrls)
    const eligibleTargets = [...targets].filter((url) => !excluded.has(url))
    const exactSources = new Set(
      owner.pendingDistribution.relayOutcomes.flatMap((outcome) =>
        outcome.readbackStatus === "observed" ? [outcome.relayUrl] : []
      )
    )
    const exactReadbackCount = eligibleTargets.filter((url) =>
      exactSources.has(url)
    ).length
    const unresolvedCount = eligibleTargets.length - exactReadbackCount
    const excludedTargetCount = targets.size - eligibleTargets.length
    pendingExactDeliveries.push({
      kind: 10002,
      label: "Read and Publish",
      eventId: owner.pendingDistribution.signedEvent.id,
      confirmationState:
        eligibleTargets.length === 0 ||
        (unresolvedCount === 0 && excludedTargetCount > 0)
          ? "policy_blocked"
          : unresolvedCount === 0
            ? "exact_confirmed"
            : "readback_pending",
      eligibleTargetCount: eligibleTargets.length,
      exactReadbackCount,
      unresolvedCount,
      excludedTargetCount,
      retryAvailable: unresolvedCount > 0,
    })
  }
  if (
    inbox.state === "distribution_pending" &&
    inbox.eventId &&
    (inbox.pendingPublishRelayUrls?.length ?? 0) > 0
  ) {
    const targets = new Set(inbox.pendingPublishRelayUrls ?? [])
    const eligibleTargets = [...targets].filter((url) => !excluded.has(url))
    const exactSources = new Set(
      inbox.pendingRelayOutcomes?.flatMap((outcome) =>
        outcome.readbackStatus === "observed" ? [outcome.relayUrl] : []
      ) ?? []
    )
    const exactReadbackCount = eligibleTargets.filter((url) =>
      exactSources.has(url)
    ).length
    const unresolvedCount = eligibleTargets.length - exactReadbackCount
    const excludedTargetCount = targets.size - eligibleTargets.length
    pendingExactDeliveries.push({
      kind: 10050,
      label: "Private inbox",
      eventId: inbox.eventId,
      confirmationState:
        eligibleTargets.length === 0 ||
        (unresolvedCount === 0 && excludedTargetCount > 0)
          ? "policy_blocked"
          : unresolvedCount === 0
            ? "exact_confirmed"
            : "readback_pending",
      eligibleTargetCount: eligibleTargets.length,
      exactReadbackCount,
      unresolvedCount,
      excludedTargetCount,
      retryAvailable: unresolvedCount > 0,
    })
  }

  return {
    rows,
    relayList: {
      state: owner.state,
      stale: owner.stale,
      retained: Boolean(owner.current && owner.stale),
      coverage: owner.lookup.coverage,
      eventCreatedAt: owner.current?.signedEvent.created_at ?? null,
      observedAt: owner.current?.observedAt ?? null,
      sourceRelayCount: sourceRelayCount(owner.current?.sourceRelayUrls),
    },
    inbox: {
      state: inbox.state,
      stale: inbox.stale,
      retained: Boolean(inbox.eventId && inbox.stale),
      coverage: inbox.observation?.coverage ?? "not_checked",
      eventCreatedAt: inbox.eventCreatedAt ?? null,
      observedAt: inboxObservedAt(input.reconciliation),
      sourceRelayCount: sourceRelayCount(inbox.sourceRelayUrls),
    },
    pendingExactDeliveries,
  }
}

export function createCandidateNetworkRelayRow(input: {
  url: string
  localState: AccountNetworkLocalState
  scan?: RelayScanResult
  authEvidence?: RelayAuthEvidenceState
}): AccountNetworkRelayRowView {
  const url = normalizeAccountRelayUrl(input.url)
  if (exclusionUrls(input.localState).has(url)) {
    throw new Error(
      "A relay removed from the whole setup cannot be added locally"
    )
  }
  if (input.scan && normalizeAccountRelayUrl(input.scan.url) !== url) {
    throw new Error("Candidate relay scan must match the candidate URL")
  }
  return {
    url,
    readEnabled: false,
    publishEnabled: false,
    privateInboxEnabled: false,
    readState: null,
    publishState: null,
    privateInboxState: null,
    signedPosition: null,
    candidate: true,
    recoveryReadOnly: false,
    reachability: "not_checked",
    capability: capabilityFromEvidence(
      url,
      input.scan,
      input.authEvidence,
      configuredUsesByUrl()
    ),
  }
}

function currentActiveInboxUrls(
  reconciliation: AccountNetworkPreferencesReconciliation
): string[] {
  const inbox = reconciliation.inboxDeclaration
  return [
    ...new Set(
      inbox.state === "declared"
        ? inbox.relayUrls
        : inbox.state === "distribution_pending"
          ? (inbox.pendingRelayUrls ?? [])
          : []
    ),
  ]
}

function currentRecoveryOnlyInboxUrls(
  reconciliation: AccountNetworkPreferencesReconciliation
): string[] {
  const inbox = reconciliation.inboxDeclaration
  const active = new Set(currentActiveInboxUrls(reconciliation))
  return [
    ...new Set(
      [
        ...(inbox.retainedReadRelayUrls ?? []),
        ...(inbox.cutoverRecoveryRelayUrls ?? []),
        ...(reconciliation.legacyInboxRecoveryRelayUrls ?? []),
      ].filter((url) => !active.has(url))
    ),
  ]
}

function currentUsableInboxUrls(
  reconciliation: AccountNetworkPreferencesReconciliation
): string[] {
  return [
    ...new Set([
      ...currentActiveInboxUrls(reconciliation),
      ...currentRecoveryOnlyInboxUrls(reconciliation),
    ]),
  ]
}

export function validateAccountNetworkDesiredRoles(
  rows: readonly AccountNetworkDesiredRelayRoles[],
  context: {
    reconciliation: AccountNetworkPreferencesReconciliation
    localState: AccountNetworkLocalState | null
  }
): AccountNetworkDesiredRolesValidation {
  assertSameAccount(context.reconciliation, context.localState)
  const excluded = exclusionUrls(context.localState)
  const errors: string[] = []
  const normalized = new Map<string, AccountNetworkDesiredRelayRoles>()
  for (const row of rows) {
    const url = normalizedRelayUrl(row.url)
    if (!url) {
      errors.push("Every selected role must use a valid relay URL.")
      continue
    }
    if (normalized.has(url)) {
      errors.push("Each relay may appear only once in the Network review.")
      continue
    }
    normalized.set(url, { ...row, url })
    if (
      excluded.has(url) &&
      (row.readEnabled || row.publishEnabled || row.privateInboxEnabled)
    ) {
      errors.push("A relay removed from the whole setup cannot be selected.")
    }
  }

  const desired = [...normalized.values()].filter(
    (row) => !excluded.has(row.url)
  )
  const publishCount = desired.filter((row) => row.publishEnabled).length
  if (publishCount === 0) errors.push("Enable Publish on at least one relay.")
  const desiredInboxCount = desired.filter(
    (row) => row.privateInboxEnabled
  ).length
  if (desiredInboxCount > MAX_DECLARED_INBOX_WRITE_RELAYS) {
    errors.push(
      `Choose no more than ${MAX_DECLARED_INBOX_WRITE_RELAYS} Private inbox relays.`
    )
  }
  const usableInboxCount = currentUsableInboxUrls(
    context.reconciliation
  ).filter((url) => !excluded.has(url)).length
  const currentInboxCount = currentActiveInboxUrls(
    context.reconciliation
  ).filter((url) => !excluded.has(url)).length
  const reviewedRelayUrls = new Set(desired.map((row) => row.url))
  const recoveryInboxCount = currentRecoveryOnlyInboxUrls(
    context.reconciliation
  ).filter((url) => !excluded.has(url) && reviewedRelayUrls.has(url)).length
  if (
    (currentInboxCount > 0 && desiredInboxCount === 0) ||
    (usableInboxCount > 0 &&
      desiredInboxCount === 0 &&
      recoveryInboxCount === 0)
  ) {
    errors.push(ACCOUNT_NETWORK_LAST_INBOX_REPLACEMENT_MESSAGE)
  }

  const uniqueErrors = [...new Set(errors)]
  return {
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors,
    warnings:
      publishCount === 1 ? [ACCOUNT_NETWORK_SINGLE_PUBLISH_WARNING] : [],
  }
}
