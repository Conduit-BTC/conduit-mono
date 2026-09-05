import { CANONICAL_CONDUIT_RELAY_URL, config } from "../config"
import type {
  AccountNetworkPreferenceEventCheckpoint,
  AccountNetworkPreferenceRelayRole,
  AccountNetworkPreferenceUpdateRecord,
} from "../db"
import type { AccountNetworkPreferencesStatus } from "../hooks/useAccountNetworkPreferences"
import {
  accountNetworkPreferenceCheckpointSharedSetConfirmed,
  getUnresolvedAccountNetworkPreferencePublishRelayUrls,
  getUnresolvedAccountNetworkPreferenceReadbackRelayUrls,
} from "./network-preference-update-state"
import type { AccountNetworkPreferencesReconciliation } from "./network-preferences"
import { tryNormalizeRelayUrl, type RelaySettingsEntry } from "./relay-settings"
import type { RelayAuthEvidenceState } from "./relay-executor"
import { EVENT_KINDS } from "./kinds"

export type AccountNetworkRole = "read" | "publish" | "private_inbox"

export interface AccountNetworkRelayCapabilityView {
  configuredCommerce: boolean
  observedCommerce: boolean
  nip11: "not_checked" | "advertised" | "unavailable"
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
  capability: AccountNetworkRelayCapabilityView
}

export interface AccountNetworkFrontierView {
  state: string
  stale: boolean
  coverage: "complete" | "partial" | "unavailable" | "not_checked"
}

export interface AccountNetworkPendingCheckpointView {
  kind: 10002 | 10050
  label: "Read and Publish" | "Private inbox"
  state: "confirmed" | "pending" | "partial" | "superseded"
  acceptedCount: number
  rejectedCount: number
  timedOutCount: number
  confirmedCount: number
  targetCount: number
  retryAvailable: boolean
}

export interface AccountNetworkConduitRelayPromptView {
  relayUrl: typeof CANONICAL_CONDUIT_RELAY_URL
  missingRoles: AccountNetworkRole[]
  changedKindCount: number
}

export interface AccountNetworkSettingsView {
  status: AccountNetworkPreferencesStatus
  error: string | null
  rows: AccountNetworkRelayRowView[]
  capabilityByUrl: Readonly<Record<string, AccountNetworkRelayCapabilityView>>
  relayList: AccountNetworkFrontierView
  inbox: AccountNetworkFrontierView
  pendingStatus: "none" | "ready" | "unavailable"
  pendingCheckpoints: AccountNetworkPendingCheckpointView[]
  activeUpdateId: string | null
  conduitRelayPrompt: AccountNetworkConduitRelayPromptView | null
  revision: string
}

function normalizedConfiguredCommerceRelayUrls(): Set<string> {
  return new Set(
    config.commerceRelayUrls.flatMap((url) => {
      const normalized = tryNormalizeRelayUrl(url)
      return normalized.ok ? [normalized.url] : []
    })
  )
}

function hasObservedCommerceEvidence(entry?: RelaySettingsEntry): boolean {
  if (!entry?.capabilities.commerce) return false
  const observations = entry.observations
  if (!observations) return false
  return [
    observations.auth,
    observations.protectedMessages,
    observations.listings,
    observations.cleanup,
  ].every(
    (observation) =>
      observation.supported &&
      observation.status === "observed" &&
      observation.evidence.includes("active-probe")
  )
}

function capabilityFromEntry(
  url: string,
  entry: RelaySettingsEntry | undefined,
  authEvidence: RelayAuthEvidenceState | undefined,
  configuredCommerceRelayUrls: ReadonlySet<string>
): AccountNetworkRelayCapabilityView {
  const advertisedAuth =
    entry?.observations?.auth.status === "advertised" ||
    entry?.capabilities.auth === true
  return {
    configuredCommerce: configuredCommerceRelayUrls.has(url),
    observedCommerce: hasObservedCommerceEvidence(entry),
    nip11: entry?.warnings.unreachable
      ? "unavailable"
      : entry?.capabilities.nip11
        ? "advertised"
        : "not_checked",
    searchAdvertised:
      entry?.observations?.search.status === "advertised" ||
      entry?.capabilities.search === true,
    authEvidence:
      authEvidence && authEvidence !== "untested"
        ? authEvidence
        : advertisedAuth
          ? "advertised"
          : "untested",
    relayName: entry?.relayName,
    observedAt: entry?.scannedAt,
  }
}

function activeCheckpointKinds(
  record: AccountNetworkPreferenceUpdateRecord | null
): Set<number> {
  const kinds = new Set<number>()
  for (const checkpoint of record?.checkpoints ?? []) {
    if (checkpoint.state === "active") kinds.add(checkpoint.kind)
  }
  return kinds
}

function checkpointForKind(
  record: AccountNetworkPreferenceUpdateRecord | null,
  kind: 10002 | 10050
): AccountNetworkPreferenceEventCheckpoint | undefined {
  return record?.checkpoints.find((checkpoint) => checkpoint.kind === kind)
}

function pendingMembershipState(
  checkpoint: AccountNetworkPreferenceEventCheckpoint | undefined
): "published" | "pending" | null {
  if (!checkpoint) return "published"
  if (checkpoint.state === "superseded") return null
  return accountNetworkPreferenceCheckpointSharedSetConfirmed(checkpoint)
    ? "published"
    : "pending"
}

function selectScopedPendingUpdate(input: {
  accountPubkey: string | null
  reconciled: AccountNetworkPreferenceUpdateRecord | null
  transient: AccountNetworkPreferenceUpdateRecord | null
}): AccountNetworkPreferenceUpdateRecord | null {
  const accountPubkey = input.accountPubkey?.trim().toLowerCase() || null
  if (!accountPubkey) return null
  const reconciled =
    input.reconciled?.pubkey === accountPubkey ? input.reconciled : null
  const transient =
    input.transient?.pubkey === accountPubkey ? input.transient : null
  if (!transient) return reconciled
  if (!reconciled) return transient
  return reconciled.updatedAt >= transient.updatedAt ? reconciled : transient
}

function projectPendingCheckpoint(
  checkpoint: AccountNetworkPreferenceEventCheckpoint
): AccountNetworkPendingCheckpointView {
  const acceptedCount = checkpoint.relayOutcomes.filter(
    (outcome) => outcome.publishStatus === "acked"
  ).length
  const rejectedCount = checkpoint.relayOutcomes.filter(
    (outcome) => outcome.publishStatus === "rejected"
  ).length
  const timedOutCount = checkpoint.relayOutcomes.filter(
    (outcome) =>
      outcome.publishStatus === "timed_out" ||
      outcome.readbackStatus === "timed_out"
  ).length
  const confirmedCount = checkpoint.relayOutcomes.filter(
    (outcome) => outcome.readbackStatus === "observed"
  ).length
  const retryAvailable =
    checkpoint.state === "active" &&
    (getUnresolvedAccountNetworkPreferencePublishRelayUrls(checkpoint).length >
      0 ||
      getUnresolvedAccountNetworkPreferenceReadbackRelayUrls(checkpoint)
        .length > 0)
  const confirmed =
    accountNetworkPreferenceCheckpointSharedSetConfirmed(checkpoint)
  const partial =
    !confirmed &&
    checkpoint.relayOutcomes.some(
      (outcome) =>
        outcome.publishStatus === "acked" ||
        outcome.publishStatus === "rejected" ||
        outcome.publishStatus === "timed_out" ||
        outcome.readbackStatus === "absent" ||
        outcome.readbackStatus === "timed_out"
    )

  return {
    kind: checkpoint.kind,
    label:
      checkpoint.kind === EVENT_KINDS.RELAY_LIST
        ? "Read and Publish"
        : "Private inbox",
    state:
      checkpoint.state === "superseded"
        ? "superseded"
        : confirmed
          ? "confirmed"
          : partial
            ? "partial"
            : "pending",
    acceptedCount,
    rejectedCount,
    timedOutCount,
    confirmedCount,
    targetCount: checkpoint.relayOutcomes.length,
    retryAvailable,
  }
}

function coverageFromInbox(
  reconciliation: AccountNetworkPreferencesReconciliation | null
): AccountNetworkFrontierView["coverage"] {
  return reconciliation?.inboxDeclaration.observation?.coverage ?? "not_checked"
}

export function buildAccountNetworkSettingsView(input: {
  accountPubkey: string | null
  status: AccountNetworkPreferencesStatus
  reconciliation: AccountNetworkPreferencesReconciliation | null
  error: string | null
  capabilityEntries?: readonly RelaySettingsEntry[]
  authEvidenceByUrl?: Readonly<
    Record<string, RelayAuthEvidenceState | undefined>
  >
  transientUpdate?: AccountNetworkPreferenceUpdateRecord | null
  conduitRelayPromptEnabled?: boolean
}): AccountNetworkSettingsView {
  const reconciliation = input.reconciliation
  const accountPubkey = input.accountPubkey?.trim().toLowerCase() || null
  const pending = selectScopedPendingUpdate({
    accountPubkey,
    reconciled: reconciliation?.pendingUpdate ?? null,
    transient: input.transientUpdate ?? null,
  })
  const activeKinds = activeCheckpointKinds(pending)
  const relayListCheckpoint = checkpointForKind(pending, EVENT_KINDS.RELAY_LIST)
  const inboxCheckpoint = checkpointForKind(
    pending,
    EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
  )
  const relayListPendingState = pending
    ? pendingMembershipState(relayListCheckpoint)
    : null
  const inboxPendingState = pending
    ? pendingMembershipState(inboxCheckpoint)
    : null
  const capabilityEntries = new Map(
    (input.capabilityEntries ?? []).map((entry) => [entry.url, entry])
  )
  const configuredCommerceRelayUrls = normalizedConfiguredCommerceRelayUrls()
  const rows = new Map<string, AccountNetworkRelayRowView>()
  const ensureRow = (url: string): AccountNetworkRelayRowView => {
    const existing = rows.get(url)
    if (existing) return existing
    const projected = reconciliation?.projection.rows.find(
      (candidate) => candidate.url === url
    )
    const entry = capabilityEntries.get(url)
    const created: AccountNetworkRelayRowView = {
      url,
      readEnabled: false,
      publishEnabled: false,
      privateInboxEnabled: false,
      readState: null,
      publishState: null,
      privateInboxState: null,
      signedPosition: projected?.position ?? null,
      candidate: true,
      capability: capabilityFromEntry(
        url,
        entry,
        input.authEvidenceByUrl?.[url],
        configuredCommerceRelayUrls
      ),
    }
    rows.set(url, created)
    return created
  }

  for (const projected of reconciliation?.projection.rows ?? []) {
    const row = ensureRow(projected.url)
    row.readEnabled = projected.read !== null || projected.draftRead
    row.publishEnabled = projected.write !== null || projected.draftWrite
    row.privateInboxEnabled = projected.privateInbox !== null
    row.readState = projected.read
    row.publishState = projected.write
    row.privateInboxState = projected.privateInbox
    row.candidate =
      projected.read === "draft" ||
      projected.write === "draft" ||
      (projected.read === null &&
        projected.write === null &&
        projected.privateInbox === null)
  }

  if (pending && !reconciliation) {
    if (relayListPendingState) {
      for (const preference of pending.nip65Preferences) {
        const row = ensureRow(preference.url)
        row.readEnabled = preference.readEnabled
        row.publishEnabled = preference.writeEnabled
        row.readState = preference.readEnabled ? relayListPendingState : null
        row.publishState = preference.writeEnabled
          ? relayListPendingState
          : null
        row.candidate = false
      }
    }
    if (inboxPendingState) {
      for (const url of pending.inboxRelayUrls) {
        const row = ensureRow(url)
        row.privateInboxEnabled = true
        row.privateInboxState = inboxPendingState
        row.candidate = false
      }
    }
  } else if (pending && relayListCheckpoint?.state === "active") {
    for (const row of rows.values()) {
      row.readEnabled = false
      row.publishEnabled = false
      row.readState = null
      row.publishState = null
    }
    for (const preference of pending.nip65Preferences) {
      const row = ensureRow(preference.url)
      row.readEnabled = preference.readEnabled
      row.publishEnabled = preference.writeEnabled
      row.readState = preference.readEnabled ? relayListPendingState : null
      row.publishState = preference.writeEnabled ? relayListPendingState : null
      row.candidate = false
    }
  }
  if (reconciliation && pending && inboxCheckpoint?.state === "active") {
    for (const row of rows.values()) {
      row.privateInboxEnabled = false
      row.privateInboxState = null
    }
    for (const url of pending.inboxRelayUrls) {
      const row = ensureRow(url)
      row.privateInboxEnabled = true
      row.privateInboxState = inboxPendingState
      row.candidate = false
    }
  }

  if (pending && activeKinds.size > 0) {
    const positionByUrl = new Map<string, number>()
    if (relayListPendingState) {
      for (const preference of pending.nip65Preferences) {
        if (!positionByUrl.has(preference.url)) {
          positionByUrl.set(preference.url, positionByUrl.size)
        }
      }
      for (const row of rows.values()) {
        row.signedPosition = positionByUrl.get(row.url) ?? null
      }
    }
    if (inboxPendingState) {
      let nextPosition = Math.max(
        -1,
        ...[...rows.values()].map((row) => row.signedPosition ?? -1)
      )
      const inboxOnlyUrls = pending.inboxRelayUrls
        .filter((url) => rows.get(url)?.signedPosition === null)
        .sort((left, right) => left.localeCompare(right))
      for (const url of inboxOnlyUrls) {
        const row = rows.get(url)
        if (row) row.signedPosition = ++nextPosition
      }
    }
  }

  const visibleRows = [...rows.values()].filter(
    (row) =>
      row.readEnabled ||
      row.publishEnabled ||
      row.privateInboxEnabled ||
      row.candidate
  )
  const orderedRows = orderAccountNetworkRelayRows(visibleRows)
  const capabilityUrls = new Set([
    ...orderedRows.map((row) => row.url),
    ...capabilityEntries.keys(),
    ...Object.keys(input.authEvidenceByUrl ?? {}),
  ])
  const capabilityByUrl = Object.fromEntries(
    [...capabilityUrls].map((url) => [
      url,
      capabilityFromEntry(
        url,
        capabilityEntries.get(url),
        input.authEvidenceByUrl?.[url],
        configuredCommerceRelayUrls
      ),
    ])
  )
  const activeUpdateId =
    activeKinds.size > 0 ? (pending?.updateId ?? null) : null
  const conduitRelayPrompt = getConduitRelayRecommendation({
    enabled:
      input.conduitRelayPromptEnabled ?? config.conduitRelayPromptEnabled,
    status: input.status,
    reconciliation,
    activeUpdateId,
  })
  const revision = JSON.stringify({
    accountPubkey,
    relayList: {
      eventId:
        reconciliation?.ownerRelayList.current?.signedEvent.id ??
        pending?.baseRelayList.eventId ??
        null,
      state:
        reconciliation?.ownerRelayList.state ??
        pending?.baseRelayList.state ??
        "not_checked",
    },
    inbox: {
      eventId:
        reconciliation?.inboxDeclaration.eventId ??
        pending?.baseInboxDeclaration.eventId ??
        null,
      state:
        reconciliation?.inboxDeclaration.state ??
        pending?.baseInboxDeclaration.state ??
        "not_checked",
    },
    activeUpdateId,
    desiredRoles: orderedRows
      .map((row) => [
        row.url,
        row.readEnabled,
        row.publishEnabled,
        row.privateInboxEnabled,
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  })
  return {
    status: input.status,
    error: input.error,
    rows: orderedRows,
    capabilityByUrl,
    relayList: {
      state: reconciliation?.ownerRelayList.state ?? "not_checked",
      stale: reconciliation?.ownerRelayList.stale ?? false,
      coverage: reconciliation?.ownerRelayList.lookup.coverage ?? "not_checked",
    },
    inbox: {
      state: reconciliation?.inboxDeclaration.state ?? "not_checked",
      stale: reconciliation?.inboxDeclaration.stale ?? false,
      coverage: coverageFromInbox(reconciliation),
    },
    pendingStatus:
      pending && pending === input.transientUpdate
        ? "ready"
        : (reconciliation?.pendingUpdateStatus ?? "none"),
    pendingCheckpoints: (pending?.checkpoints ?? []).map(
      projectPendingCheckpoint
    ),
    activeUpdateId,
    conduitRelayPrompt,
    revision,
  }
}

export function createCandidateNetworkRelayRow(
  entry: RelaySettingsEntry,
  authEvidence?: RelayAuthEvidenceState
): AccountNetworkRelayRowView {
  const configuredCommerceRelayUrls = normalizedConfiguredCommerceRelayUrls()
  return {
    url: entry.url,
    readEnabled: false,
    publishEnabled: false,
    privateInboxEnabled: false,
    readState: null,
    publishState: null,
    privateInboxState: null,
    signedPosition: null,
    candidate: true,
    capability: capabilityFromEntry(
      entry.url,
      entry,
      authEvidence,
      configuredCommerceRelayUrls
    ),
  }
}

export function orderAccountNetworkRelayRows(
  rows: readonly AccountNetworkRelayRowView[]
): AccountNetworkRelayRowView[] {
  const tier = (row: AccountNetworkRelayRowView): number => {
    const active =
      row.readEnabled || row.publishEnabled || row.privateInboxEnabled
    if (active && row.capability.configuredCommerce) return 0
    if (active && row.capability.observedCommerce) return 1
    if (
      active &&
      (row.capability.searchAdvertised ||
        row.capability.authEvidence === "advertised" ||
        row.capability.authEvidence === "challenge_observed" ||
        row.capability.authEvidence === "succeeded")
    ) {
      return 2
    }
    if (active) return 3
    return 4
  }
  return [...rows].sort((left, right) => {
    const tierDifference = tier(left) - tier(right)
    if (tierDifference !== 0) return tierDifference
    const leftPosition = left.signedPosition ?? Number.MAX_SAFE_INTEGER
    const rightPosition = right.signedPosition ?? Number.MAX_SAFE_INTEGER
    if (leftPosition !== rightPosition) return leftPosition - rightPosition
    return left.url.localeCompare(right.url)
  })
}

export interface AccountNetworkDesiredRelayRoles {
  url: string
  readEnabled: boolean
  publishEnabled: boolean
  privateInboxEnabled: boolean
}

export interface PreparedAccountNetworkSetRolesAction {
  action: {
    type: "set_roles"
    nip65Preferences: AccountNetworkPreferenceRelayRole[]
    inboxRelayUrls: string[]
  }
  changedKindCount: number
}

export interface PreparedConduitRelayRecommendation {
  action: PreparedAccountNetworkSetRolesAction["action"]
  relayUrl: typeof CANONICAL_CONDUIT_RELAY_URL
  missingRoles: AccountNetworkRole[]
  changedKindCount: number
}

function normalizedUrlForAction(url: string): string {
  const normalized = tryNormalizeRelayUrl(url)
  return normalized.ok ? normalized.url : url.trim()
}

function sameNip65RoleSemantics(
  left: readonly AccountNetworkPreferenceRelayRole[],
  right: readonly AccountNetworkPreferenceRelayRole[]
): boolean {
  if (left.length !== right.length) return false
  const leftByUrl = new Map(
    left.map((preference) => [
      normalizedUrlForAction(preference.url),
      preference,
    ])
  )
  return right.every((preference) => {
    const current = leftByUrl.get(normalizedUrlForAction(preference.url))
    return (
      current?.readEnabled === preference.readEnabled &&
      current.writeEnabled === preference.writeEnabled
    )
  })
}

function sameRelayMembership(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false
  const leftUrls = new Set(left.map(normalizedUrlForAction))
  return right.every((url) => leftUrls.has(normalizedUrlForAction(url)))
}

function reconciliationInboxRelayUrls(
  reconciliation: AccountNetworkPreferencesReconciliation
): string[] {
  const inbox = reconciliation.inboxDeclaration
  if (inbox.state === "distribution_pending") {
    return [...(inbox.pendingRelayUrls ?? [])]
  }
  return inbox.state === "declared" ? [...inbox.relayUrls] : []
}

/**
 * Prepare the one-click recommendation without reordering or replacing any
 * existing membership. The canonical relay is enabled in place when already
 * present and appended independently to each changed signed object otherwise.
 */
export function prepareConduitRelayRecommendation(
  reconciliation: AccountNetworkPreferencesReconciliation
): PreparedConduitRelayRecommendation | null {
  const currentNip65 = reconciliation.ownerRelayList.preferences.map(
    (preference) => ({ ...preference })
  )
  const currentInbox = reconciliationInboxRelayUrls(reconciliation)
  const canonical = CANONICAL_CONDUIT_RELAY_URL
  const conduitPreferenceIndex = currentNip65.findIndex(
    (preference) => normalizedUrlForAction(preference.url) === canonical
  )
  const conduitInboxIndex = currentInbox.findIndex(
    (url) => normalizedUrlForAction(url) === canonical
  )
  const existingPreference = currentNip65[conduitPreferenceIndex]
  const missingRoles: AccountNetworkRole[] = []
  if (!existingPreference?.readEnabled) missingRoles.push("read")
  if (!existingPreference?.writeEnabled) missingRoles.push("publish")
  if (conduitInboxIndex < 0) missingRoles.push("private_inbox")
  if (missingRoles.length === 0) return null
  if (conduitInboxIndex < 0 && currentInbox.length >= 3) return null

  const nip65Preferences = currentNip65.map((preference, index) =>
    index === conduitPreferenceIndex
      ? { ...preference, readEnabled: true, writeEnabled: true }
      : preference
  )
  if (conduitPreferenceIndex < 0) {
    nip65Preferences.push({
      url: canonical,
      readEnabled: true,
      writeEnabled: true,
    })
  }
  const inboxRelayUrls =
    conduitInboxIndex >= 0 ? currentInbox : [...currentInbox, canonical]
  const desiredByUrl = new Map<string, AccountNetworkDesiredRelayRoles>()
  for (const preference of nip65Preferences) {
    desiredByUrl.set(preference.url, {
      url: preference.url,
      readEnabled: preference.readEnabled,
      publishEnabled: preference.writeEnabled,
      privateInboxEnabled: false,
    })
  }
  for (const url of inboxRelayUrls) {
    const existing = desiredByUrl.get(url)
    desiredByUrl.set(url, {
      url,
      readEnabled: existing?.readEnabled ?? false,
      publishEnabled: existing?.publishEnabled ?? false,
      privateInboxEnabled: true,
    })
  }
  if (validateAccountNetworkDesiredRoles([...desiredByUrl.values()])) {
    return null
  }

  const nip65Changed =
    !existingPreference?.readEnabled || !existingPreference?.writeEnabled
  const inboxChanged = conduitInboxIndex < 0
  return {
    relayUrl: canonical,
    missingRoles,
    changedKindCount: Number(nip65Changed) + Number(inboxChanged),
    action: {
      type: "set_roles",
      nip65Preferences,
      inboxRelayUrls,
    },
  }
}

export function getConduitRelayRecommendation(input: {
  enabled: boolean
  status: AccountNetworkPreferencesStatus
  reconciliation: AccountNetworkPreferencesReconciliation | null
  activeUpdateId: string | null
}): AccountNetworkConduitRelayPromptView | null {
  const reconciliation = input.reconciliation
  if (
    !input.enabled ||
    input.status !== "ready" ||
    !reconciliation ||
    input.activeUpdateId ||
    reconciliation.pendingUpdateStatus === "unavailable" ||
    reconciliation.ownerRelayList.lookup.coverage !== "complete" ||
    reconciliation.ownerRelayList.stale ||
    reconciliation.inboxDeclaration.observation?.coverage !== "complete" ||
    reconciliation.inboxDeclaration.state === "distribution_pending" ||
    reconciliation.inboxDeclaration.stale
  ) {
    return null
  }
  const prepared = prepareConduitRelayRecommendation(reconciliation)
  return prepared
    ? {
        relayUrl: prepared.relayUrl,
        missingRoles: prepared.missingRoles,
        changedKindCount: prepared.changedKindCount,
      }
    : null
}

export function prepareAccountNetworkSetRolesAction(
  reconciliation: AccountNetworkPreferencesReconciliation | null,
  rows: readonly AccountNetworkDesiredRelayRoles[]
): PreparedAccountNetworkSetRolesAction {
  const desiredNip65: AccountNetworkPreferenceRelayRole[] = []
  const desiredInbox: string[] = []
  for (const row of rows) {
    const url = normalizedUrlForAction(row.url)
    if (row.readEnabled || row.publishEnabled) {
      desiredNip65.push({
        url,
        readEnabled: row.readEnabled,
        writeEnabled: row.publishEnabled,
      })
    }
    if (row.privateInboxEnabled) desiredInbox.push(url)
  }

  const currentNip65 = reconciliation
    ? reconciliation.ownerRelayList.preferences.map((preference) => ({
        ...preference,
      }))
    : []
  const currentInbox = reconciliation
    ? reconciliationInboxRelayUrls(reconciliation)
    : []
  const nip65Changed = !sameNip65RoleSemantics(currentNip65, desiredNip65)
  const inboxChanged = !sameRelayMembership(currentInbox, desiredInbox)

  return {
    action: {
      type: "set_roles",
      nip65Preferences: nip65Changed ? desiredNip65 : currentNip65,
      inboxRelayUrls: inboxChanged ? desiredInbox : currentInbox,
    },
    changedKindCount: Number(nip65Changed) + Number(inboxChanged),
  }
}

export function validateAccountNetworkDesiredRoles(
  rows: readonly AccountNetworkDesiredRelayRoles[]
): string | null {
  const general = rows.filter((row) => row.readEnabled || row.publishEnabled)
  if (general.length < 2) {
    return "Choose at least two relays for Read or Publish."
  }
  if (!general.some((row) => row.publishEnabled)) {
    return "Enable Publish on at least one relay."
  }
  const inboxCount = rows.filter((row) => row.privateInboxEnabled).length
  if (inboxCount < 1) {
    return "Choose at least one Private inbox relay."
  }
  if (inboxCount > 3) {
    return "Choose no more than three Private inbox relays."
  }
  return null
}

export function getAccountNetworkRemovalInstruction(
  rows: readonly AccountNetworkDesiredRelayRoles[],
  relayUrl: string
): string | null {
  const remaining = rows.filter((row) => row.url !== relayUrl)
  const validation = validateAccountNetworkDesiredRoles(remaining)
  if (!validation) return null
  if (
    remaining.filter((row) => row.readEnabled || row.publishEnabled).length <
      2 &&
    remaining.filter((row) => row.privateInboxEnabled).length < 1
  ) {
    return "Add a replacement relay and enable Read or Publish plus Private inbox before removing this one."
  }
  if (remaining.filter((row) => row.privateInboxEnabled).length < 1) {
    return "Add a replacement Private inbox relay before removing this one."
  }
  if (!remaining.some((row) => row.publishEnabled)) {
    return "Enable Publish on a replacement relay before removing this one."
  }
  return "Add a replacement relay with Read or Publish before removing this one."
}

export function countAccountNetworkChangedKinds(
  baseline: readonly AccountNetworkDesiredRelayRoles[],
  desired: readonly AccountNetworkDesiredRelayRoles[]
): number {
  const normalized = (
    rows: readonly AccountNetworkDesiredRelayRoles[],
    role: "nip65" | "inbox"
  ) => {
    const values: Array<string | [string, boolean, boolean]> = []
    for (const row of rows) {
      const included =
        role === "nip65"
          ? row.readEnabled || row.publishEnabled
          : row.privateInboxEnabled
      if (!included) continue
      values.push(
        role === "nip65"
          ? [row.url, row.readEnabled, row.publishEnabled]
          : row.url
      )
    }
    values.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    )
    return JSON.stringify(values)
  }
  return (
    Number(normalized(baseline, "nip65") !== normalized(desired, "nip65")) +
    Number(normalized(baseline, "inbox") !== normalized(desired, "inbox"))
  )
}
