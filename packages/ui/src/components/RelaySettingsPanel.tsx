import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react"
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Info,
  Plus,
  RefreshCw,
  RotateCcw,
  Store,
  Trash2,
  Upload,
} from "lucide-react"
import {
  areAccountNetworkRelayRowsReorderEquivalent,
  countAccountNetworkChangedKinds,
  isAccountNetworkRelayCommerceRelevant,
  orderAccountNetworkRelayRows,
  tryNormalizeRelayUrl,
  type AccountNetworkDesiredRelayRoles,
  type AccountNetworkFrontierView,
  type AccountNetworkRelayConfiguredUse,
  type AccountNetworkRelayRowView,
  type AccountNetworkRole,
  type AccountNetworkSettingsController,
  type AccountNetworkSettingsOperationPhase,
} from "@conduit/core"
import { cn } from "../utils"
import { Button } from "./Button"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./Dialog"
import { Input } from "./Input"
import { MediaServerPreferencesSection } from "./MediaServerPreferencesSection"
import {
  PreferenceSectionBody,
  PreferenceSectionCard,
  PreferenceSectionDivider,
  PreferenceSectionFooter,
} from "./PreferenceSectionCard"
import { StatusPill } from "./StatusPill"

export interface RelaySettingsPanelProps {
  controller: AccountNetworkSettingsController
  className?: string
  onUnpublishedRelayChangesChange?: (hasUnpublishedChanges: boolean) => void
}

function desiredRolesFromRows(
  rows: readonly AccountNetworkRelayRowView[]
): AccountNetworkDesiredRelayRoles[] {
  return rows.map((row) => ({
    url: row.url,
    readEnabled: row.readEnabled,
    publishEnabled: row.publishEnabled,
    privateInboxEnabled: row.privateInboxEnabled,
  }))
}

function baselineRolesFromRows(
  rows: readonly AccountNetworkRelayRowView[]
): AccountNetworkDesiredRelayRoles[] {
  return rows.map((row) => ({
    url: row.url,
    readEnabled: row.readState === "published" || row.readState === "pending",
    publishEnabled:
      row.publishState === "published" || row.publishState === "pending",
    privateInboxEnabled:
      row.privateInboxState === "published" ||
      row.privateInboxState === "pending",
  }))
}

function hasSignedOrPendingMembership(
  row: AccountNetworkRelayRowView
): boolean {
  return (
    Boolean(row.recoveryReadOnly) ||
    [row.readState, row.publishState, row.privateInboxState].some(
      (state) => state === "published" || state === "pending"
    )
  )
}

function discardReviewRows(
  rows: readonly AccountNetworkRelayRowView[]
): AccountNetworkRelayRowView[] {
  const baseline = new Map(
    baselineRolesFromRows(rows).map((entry) => [entry.url, entry])
  )
  return rows.map((row) => ({
    ...row,
    readEnabled: baseline.get(row.url)?.readEnabled ?? false,
    publishEnabled: baseline.get(row.url)?.publishEnabled ?? false,
    privateInboxEnabled: baseline.get(row.url)?.privateInboxEnabled ?? false,
  }))
}

function rolesDiffer(
  baselineRoles: readonly AccountNetworkDesiredRelayRoles[],
  desiredRoles: readonly AccountNetworkDesiredRelayRoles[],
  select: (roles: AccountNetworkDesiredRelayRoles) => readonly boolean[]
): boolean {
  const baselineByUrl = new Map(
    baselineRoles.flatMap((roles) => {
      const selected = select(roles)
      return selected.some(Boolean) ? [[roles.url, selected] as const] : []
    })
  )
  const desiredByUrl = new Map(
    desiredRoles.flatMap((roles) => {
      const selected = select(roles)
      return selected.some(Boolean) ? [[roles.url, selected] as const] : []
    })
  )
  const urls = new Set([...baselineByUrl.keys(), ...desiredByUrl.keys()])
  for (const url of urls) {
    const baseline = baselineByUrl.get(url) ?? []
    const desired = desiredByUrl.get(url) ?? []
    if (baseline.length !== desired.length) return true
    if (baseline.some((value, index) => value !== desired[index])) return true
  }
  return false
}

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

function formatEventTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Not observed"
  const date = new Date(seconds * 1_000)
  return Number.isFinite(date.getTime())
    ? dateTimeFormatter.format(date)
    : "Not observed"
}

function formatObservationTime(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) {
    return "Not recorded"
  }
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime())
    ? dateTimeFormatter.format(date)
    : "Not recorded"
}

function roleEnabled(
  row: AccountNetworkRelayRowView,
  role: AccountNetworkRole
) {
  if (role === "read") return row.readEnabled
  if (role === "publish") return row.publishEnabled
  return row.privateInboxEnabled
}

function roleLabel(role: AccountNetworkRole): string {
  if (role === "read") return "Read"
  if (role === "publish") return "Publish"
  return "Private inbox"
}

function RoleToggle({
  row,
  role,
  disabled,
  inboxLimitReached,
  onToggle,
}: {
  row: AccountNetworkRelayRowView
  role: AccountNetworkRole
  disabled: boolean
  inboxLimitReached: boolean
  onToggle: (trigger: HTMLButtonElement) => void
}) {
  const label = roleLabel(role)
  const enabled = roleEnabled(row, role)
  const maxInboxReached =
    role === "private_inbox" && !enabled && inboxLimitReached
  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-label={`${enabled ? "Disable" : "Enable"} ${label} for ${row.url}`}
      title={
        maxInboxReached
          ? "Private inbox lists are limited to three relays."
          : `${enabled ? "Disable" : "Enable"} ${label}`
      }
      disabled={disabled}
      onClick={(event) => onToggle(event.currentTarget)}
      className={cn(
        "inline-flex min-h-10 items-center justify-center rounded-full border px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40",
        enabled
          ? "border-primary-400 bg-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] text-[var(--primary-500)]"
          : "border-[var(--border-overlay)] bg-transparent text-[var(--text-secondary)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
      )}
    >
      {label}
    </button>
  )
}

function reachabilityLabel(
  reachability: AccountNetworkRelayRowView["reachability"]
): string {
  if (reachability === "responded") {
    return "Responded during the latest preference refresh"
  }
  if (reachability === "issue") {
    return "Connection issue during the latest preference refresh"
  }
  return "Not included in the latest preference refresh"
}

function reachabilityDotClassName(
  reachability: AccountNetworkRelayRowView["reachability"]
): string {
  if (reachability === "responded") return "bg-success"
  if (reachability === "issue") return "bg-warning"
  return "bg-[var(--text-muted)]"
}

function RelayIndicator({ row }: { row: AccountNetworkRelayRowView }) {
  const commerce = isAccountNetworkRelayCommerceRelevant(row.capability)
  const status = reachabilityLabel(row.reachability)
  const commerceStatus = row.capability.observedCommerce
    ? "Full commerce support observed"
    : "Used for commerce workflows"
  return (
    <span
      role="img"
      aria-label={commerce ? `${commerceStatus}. ${status}.` : `${status}.`}
      title={commerce ? `${commerceStatus} · ${status}` : status}
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full",
        commerce &&
          "bg-[color-mix(in_srgb,var(--primary-500)_12%,transparent)] text-[var(--primary-500)]"
      )}
    >
      {commerce ? (
        <>
          <Store className="size-4" aria-hidden="true" />
          <span
            aria-hidden="true"
            className={cn(
              "absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-[var(--surface)]",
              reachabilityDotClassName(row.reachability)
            )}
          />
        </>
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-3 rounded-full",
            reachabilityDotClassName(row.reachability)
          )}
        />
      )}
    </span>
  )
}

function authEvidenceLabel(row: AccountNetworkRelayRowView): string {
  switch (row.capability.authEvidence) {
    case "advertised":
      return "Advertised"
    case "challenge_observed":
      return "Challenge observed"
    case "succeeded":
      return "Succeeded"
    case "rejected":
      return "Rejected"
    case "unavailable":
      return "Unavailable"
    default:
      if (row.capability.nip11 === "available") return "Not advertised"
      if (row.capability.nip11 === "unavailable") return "Could not check"
      return "Not checked"
  }
}

function commerceEvidenceLabel(row: AccountNetworkRelayRowView): string {
  if (row.capability.observedCommerce) return "Full support observed"
  return "Not assessed"
}

function relayInformationLabel(row: AccountNetworkRelayRowView): string {
  if (row.capability.nip11 === "available") {
    return row.capability.observedAt
      ? `Updated ${formatObservationTime(row.capability.observedAt)}`
      : "Available"
  }
  if (row.capability.nip11 === "unavailable") {
    return "Unavailable on the last check"
  }
  return "Not checked"
}

const CONFIGURED_USE_GROUPS: readonly {
  label: string
  uses: readonly AccountNetworkRelayConfiguredUse[]
}[] = [
  { label: "App publishing", uses: ["app_publishing"] },
  { label: "Product discovery", uses: ["product_discovery"] },
  { label: "Search", uses: ["search"] },
  {
    label: "Private messaging",
    uses: ["order_messages", "private_inbox", "inbox_discovery"],
  },
  { label: "General reads", uses: ["general_reads"] },
  { label: "Zap activity", uses: ["public_activity"] },
]

function configuredUsesLabel(row: AccountNetworkRelayRowView): string {
  const configuredUses = new Set(row.capability.configuredUses)
  return CONFIGURED_USE_GROUPS.filter((group) =>
    group.uses.some((use) => configuredUses.has(use))
  )
    .map((group) => group.label)
    .join(", ")
}

function searchEvidenceLabel(row: AccountNetworkRelayRowView): string {
  if (row.capability.searchAdvertised) return "Advertised"
  if (row.capability.nip11 === "available") return "Not advertised"
  if (row.capability.nip11 === "unavailable") return "Could not check"
  return "Not checked"
}

function RelayDetails({ row }: { row: AccountNetworkRelayRowView }) {
  return (
    <details className="ml-10 mt-3 border-t border-[var(--border)] pt-2">
      <summary className="w-fit cursor-pointer text-sm font-medium text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
        Relay details
        <span className="sr-only"> for {row.url}</span>
      </summary>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {row.recoveryReadOnly ? (
          <div>
            <dt className="text-[var(--text-muted)]">Recovery use</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">
              Previous private inbox reads only
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-[var(--text-muted)]">Recent connection</dt>
          <dd className="mt-0.5 text-[var(--text-primary)]">
            {reachabilityLabel(row.reachability)}
          </dd>
        </div>
        {row.capability.relayName ? (
          <div>
            <dt className="text-[var(--text-muted)]">Relay name</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">
              {row.capability.relayName}
            </dd>
          </div>
        ) : null}
        {row.capability.configuredUses.length > 0 ? (
          <div>
            <dt className="text-[var(--text-muted)]">Configured use</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">
              {configuredUsesLabel(row)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-[var(--text-muted)]">Commerce support</dt>
          <dd className="mt-0.5 text-[var(--text-primary)]">
            {commerceEvidenceLabel(row)}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">Authentication</dt>
          <dd className="mt-0.5 text-[var(--text-primary)]">
            {authEvidenceLabel(row)}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">Search</dt>
          <dd className="mt-0.5 text-[var(--text-primary)]">
            {searchEvidenceLabel(row)}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">Relay information</dt>
          <dd className="mt-0.5 text-[var(--text-primary)]">
            {relayInformationLabel(row)}
          </dd>
        </div>
      </dl>
    </details>
  )
}

function relayRowState(
  row: AccountNetworkRelayRowView,
  edited: boolean
): { label: string; attention: boolean } | null {
  const pending = [row.readState, row.publishState, row.privateInboxState].some(
    (state) => state === "pending"
  )
  if (pending) return { label: "Publishing", attention: true }
  const draft =
    row.candidate || row.readState === "draft" || row.publishState === "draft"
  if (draft) return { label: "New", attention: false }
  return edited ? { label: "Edited", attention: true } : null
}

function RelayOrderControls({
  row,
  operationBusy,
  canMoveEarlier,
  canMoveLater,
  onMoveEarlier,
  onMoveLater,
}: {
  row: AccountNetworkRelayRowView
  operationBusy: boolean
  canMoveEarlier: boolean
  canMoveLater: boolean
  onMoveEarlier: () => void
  onMoveLater: () => void
}) {
  if (!canMoveEarlier && !canMoveLater) return null
  return (
    <div
      role="group"
      aria-label={`Order preference for ${row.url}`}
      className="flex items-center gap-1"
    >
      {canMoveEarlier ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Move ${row.url} earlier`}
          title="Move earlier"
          disabled={operationBusy}
          onClick={onMoveEarlier}
        >
          <ArrowUp className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
      {canMoveLater ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Move ${row.url} later`}
          title="Move later"
          disabled={operationBusy}
          onClick={onMoveLater}
        >
          <ArrowDown className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  )
}

function RelayRoleControls({
  row,
  mutationDisabled,
  inboxCount,
  onToggle,
}: {
  row: AccountNetworkRelayRowView
  mutationDisabled: boolean
  inboxCount: number
  onToggle: (role: AccountNetworkRole, trigger: HTMLButtonElement) => void
}) {
  const inboxLimitReached = inboxCount >= 3
  return (["read", "publish", "private_inbox"] as const).map((role) => (
    <RoleToggle
      key={role}
      row={row}
      role={role}
      disabled={
        mutationDisabled ||
        (role === "private_inbox" &&
          !row.privateInboxEnabled &&
          inboxLimitReached)
      }
      inboxLimitReached={inboxLimitReached}
      onToggle={(trigger) => onToggle(role, trigger)}
    />
  ))
}

function RelayRow({
  row,
  edited,
  mutationDisabled,
  operationBusy,
  wholeSetupRemoval,
  inboxCount,
  canMoveEarlier,
  canMoveLater,
  onToggle,
  onRemove,
  onMoveEarlier,
  onMoveLater,
}: {
  row: AccountNetworkRelayRowView
  edited: boolean
  mutationDisabled: boolean
  operationBusy: boolean
  wholeSetupRemoval: boolean
  inboxCount: number
  canMoveEarlier: boolean
  canMoveLater: boolean
  onToggle: (role: AccountNetworkRole, trigger: HTMLButtonElement) => void
  onRemove: (trigger: HTMLButtonElement) => void
  onMoveEarlier: () => void
  onMoveLater: () => void
}) {
  const state = relayRowState(row, edited)
  const removalLabel = wholeSetupRemoval
    ? `Remove ${row.url} from my whole setup`
    : `Remove ${row.url} from this review`
  const removalTitle = wholeSetupRemoval
    ? "Remove from my whole setup"
    : "Remove from this review"
  return (
    <li className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <RelayIndicator row={row} />
          <div className="min-w-0 pt-1.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <span
                className="min-w-0 truncate font-mono text-sm text-[var(--text-primary)]"
                title={row.url}
              >
                {row.url}
              </span>
              {row.recoveryReadOnly ? (
                <span className="text-xs font-medium text-warning">
                  Recovery read-only
                </span>
              ) : null}
              {state ? (
                <span
                  className={cn(
                    "text-xs font-medium",
                    state.attention
                      ? "text-warning"
                      : "text-[var(--text-muted)]"
                  )}
                >
                  {state.label}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:max-w-[23rem] lg:justify-end">
          <RelayOrderControls
            row={row}
            operationBusy={operationBusy}
            canMoveEarlier={canMoveEarlier}
            canMoveLater={canMoveLater}
            onMoveEarlier={onMoveEarlier}
            onMoveLater={onMoveLater}
          />
          <RelayRoleControls
            row={row}
            mutationDisabled={mutationDisabled}
            inboxCount={inboxCount}
            onToggle={onToggle}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={removalLabel}
            title={removalTitle}
            disabled={wholeSetupRemoval ? mutationDisabled : operationBusy}
            onClick={(event) => onRemove(event.currentTarget)}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {row.recoveryReadOnly ? (
        <p className="ml-10 mt-2 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
          Conduit reads this previous inbox during the 7-day recovery window.
          Removing it from your whole setup ends recovery for this relay
          immediately.
        </p>
      ) : null}
      <RelayDetails row={row} />
    </li>
  )
}

function frontierExceptionMessage(
  frontier: AccountNetworkFrontierView
): string | null {
  if (frontier.state === "distribution_pending") {
    return "Publishing is still in progress."
  }
  if (frontier.state === "signed_empty") {
    return "The published preference is empty."
  }
  if (frontier.state === "malformed") {
    return "The published preference needs repair."
  }
  if (frontier.eventCreatedAt !== null) return null
  if (frontier.state === "lookup_unavailable") {
    return "This preference could not be refreshed."
  }
  if (frontier.state === "lookup_partial") {
    return "No preference was found in the relay responses received."
  }
  if (frontier.state === "not_observed") {
    return "No published preference found."
  }
  return "Not checked yet."
}

function observedSourceLabel(sourceRelayCount: number): string {
  if (sourceRelayCount === 0) return "Source not recorded"
  return `Seen on ${sourceRelayCount} relay${sourceRelayCount === 1 ? "" : "s"}`
}

function PublishedRelayPreference({
  label,
  frontier,
}: {
  label: string
  frontier: AccountNetworkFrontierView
}) {
  const exceptionMessage = frontierExceptionMessage(frontier)
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-3">
      <h3 className="text-balance text-sm font-semibold text-[var(--text-primary)]">
        {label}
      </h3>
      {frontier.eventCreatedAt !== null ? (
        <p className="mt-1 flex flex-wrap gap-x-2 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
          <span className="tabular-nums">
            Published {formatEventTime(frontier.eventCreatedAt)}
          </span>
          {frontier.observedAt !== null ? (
            <span className="tabular-nums">
              Last seen {formatObservationTime(frontier.observedAt)}
            </span>
          ) : null}
          <span className="tabular-nums">
            {observedSourceLabel(frontier.sourceRelayCount)}
          </span>
        </p>
      ) : null}
      {exceptionMessage ? (
        <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
          {exceptionMessage}
        </p>
      ) : null}
    </div>
  )
}

function PublishedRelayPreferences({
  controller,
}: {
  controller: AccountNetworkSettingsController
}) {
  const { view } = controller
  const failed = controller.status === "error"
  return (
    <div>
      <details className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 sm:p-4">
        <summary className="cursor-pointer text-sm font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
          Published preferences
        </summary>
        <div className="mt-3">
          <div className="grid gap-3">
            <PublishedRelayPreference
              label="Read and Publish"
              frontier={view.relayList}
            />
            <PublishedRelayPreference
              label="Private inbox"
              frontier={view.inbox}
            />
          </div>
        </div>
      </details>
      {failed && controller.error ? (
        <p role="alert" className="mt-3 text-pretty text-sm text-error">
          {controller.error}
        </p>
      ) : null}
    </div>
  )
}

function PendingUpdateSummary({
  controller,
  relayDraftDirty,
}: {
  controller: AccountNetworkSettingsController
  relayDraftDirty: boolean
}) {
  const deliveries = controller.view.pendingExactDeliveries
  if (deliveries.length === 0) return null
  const retryAvailable = deliveries.some((delivery) => delivery.retryAvailable)
  return (
    <div
      aria-labelledby="pending-network-update-heading"
      className="mt-3 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3
            id="pending-network-update-heading"
            className="text-balance text-sm font-semibold text-[var(--text-primary)]"
          >
            Signed update status
          </h3>
          <p className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Conduit retains each exact signed event while it checks shared
            relays. A publish response alone is not proof of shared readback.
          </p>
        </div>
        {retryAvailable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              relayDraftDirty || operationIsBusy(controller.operation.phase)
            }
            title={
              relayDraftDirty
                ? "Publish or discard your relay edits before retrying signed preferences."
                : undefined
            }
            onClick={() =>
              void controller.retryPendingUpdate().catch(() => undefined)
            }
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Retry exact signed update
          </Button>
        ) : null}
      </div>
      <ul className="mt-3 space-y-2">
        {deliveries.map((delivery) => (
          <li
            key={`${delivery.kind}:${delivery.eventId}`}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {delivery.label}
              </span>
              <StatusPill
                variant={delivery.unresolvedCount === 0 ? "success" : "warning"}
                noIcon
              >
                {delivery.unresolvedCount === 0
                  ? "Exact event confirmed"
                  : "Exact readback pending"}
              </StatusPill>
            </div>
            <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
              {delivery.exactReadbackCount} exact readback ·{" "}
              {delivery.unresolvedCount} unresolved ·{" "}
              {delivery.eligibleTargetCount} eligible target
              {delivery.eligibleTargetCount === 1 ? "" : "s"}
              {delivery.excludedTargetCount > 0
                ? ` · ${delivery.excludedTargetCount} excluded`
                : ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function operationMessage(
  kind: AccountNetworkSettingsController["operation"]["kind"],
  phase: AccountNetworkSettingsOperationPhase,
  fallback: string | null
): string | null {
  if (fallback) return fallback
  if (kind === "discard_legacy" && phase === "staging") {
    return "Discarding the older local relay role draft."
  }
  if (phase === "checking") return "Checking the current signed preferences."
  if (phase === "awaiting_signatures") {
    return "Complete each signer request. Nothing changes until every required signature is staged."
  }
  if (phase === "staging") {
    return "Storing the exact signed preferences before any relay write."
  }
  if (phase === "publishing") {
    return "Publishing each signed preference independently."
  }
  if (phase === "confirming") {
    return "Checking for the exact signed preferences on shared relays."
  }
  return null
}

function operationIsBusy(phase: AccountNetworkSettingsOperationPhase): boolean {
  return !["idle", "complete", "error"].includes(phase)
}

export function RelayRemovalDialog({
  relayUrl,
  instruction,
  errorMessage,
  busy,
  returnFocusRef,
  onCancel,
  onProceed,
}: {
  relayUrl: string | null
  instruction: string | null
  errorMessage: string | null
  busy: boolean
  returnFocusRef?: RefObject<HTMLButtonElement | null>
  onCancel: () => void
  onProceed: () => void
}) {
  return (
    <AlertDialog
      open={relayUrl !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current?.isConnected) return
          event.preventDefault()
          returnFocusRef.current.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-balance">
            Remove this relay from your whole setup?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-pretty leading-6">
            After any required signer requests are safely staged, Conduit will
            stop reading, publishing, and checking it for private messages. This
            also ends any recovery reads for this relay immediately. Stale
            clients may still send messages there, and those messages can be
            missed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="break-all rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--text-primary)]">
          {relayUrl}
        </div>
        {instruction ? (
          <p role="alert" className="text-pretty text-sm text-warning">
            {instruction}
          </p>
        ) : null}
        {errorMessage ? (
          <p role="alert" className="text-pretty text-sm text-error">
            {errorMessage}
          </p>
        ) : null}
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || Boolean(instruction)}
            onClick={onProceed}
          >
            Proceed
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export interface UnpublishedRelayChangesDialogProps {
  open: boolean
  operationInProgress: boolean
  onKeepEditing: () => void
  onLeave: () => void
}

export function UnpublishedRelayChangesDialog({
  open,
  operationInProgress,
  onKeepEditing,
  onLeave,
}: UnpublishedRelayChangesDialogProps) {
  const returnFocusRef = useRef<HTMLElement | null>(null)

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onKeepEditing()
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={() => {
          const activeElement = document.activeElement
          returnFocusRef.current =
            activeElement instanceof HTMLElement &&
            activeElement !== document.body
              ? activeElement
              : null
        }}
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef.current?.isConnected) return
          event.preventDefault()
          returnFocusRef.current.focus()
          returnFocusRef.current = null
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-balance">
            {operationInProgress
              ? "Network update in progress"
              : "Leave with unpublished relay changes?"}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-pretty leading-6">
            {operationInProgress
              ? "Stay on this page while Conduit finishes staging and publishing the signed preferences."
              : "Leaving this page will discard your relay edits. Conduit and other Nostr apps will keep using your last published preferences."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button type="button" variant="outline" onClick={onKeepEditing}>
            {operationInProgress ? "Stay on this page" : "Keep editing"}
          </Button>
          {!operationInProgress ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                returnFocusRef.current = null
                onLeave()
              }}
            >
              Leave and discard
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function removalInstructionForReview(
  relayUrl: string | null,
  dirty: boolean,
  baselineRoles: readonly AccountNetworkDesiredRelayRoles[],
  controller: AccountNetworkSettingsController
): string | null {
  if (!relayUrl) return null
  if (dirty) {
    return "Save or discard your other reviewed role changes before removing this relay."
  }
  const removalRoles = baselineRoles.filter((roles) => roles.url !== relayUrl)
  return controller.validate(removalRoles).errors[0] ?? null
}

function useRelaySettingsReview(
  controller: AccountNetworkSettingsController,
  onUnpublishedRelayChangesChange?: (hasUnpublishedChanges: boolean) => void
) {
  const [rows, setRows] = useState<AccountNetworkRelayRowView[]>(
    () => controller.view.rows
  )
  const [newRelayUrl, setNewRelayUrl] = useState("")
  const [addError, setAddError] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [relayPendingRemoval, setRelayPendingRemoval] = useState<string | null>(
    null
  )
  const removalTriggerRef = useRef<HTMLButtonElement | null>(null)
  const publishButtonRef = useRef<HTMLButtonElement | null>(null)
  const [localActionError, setLocalActionError] = useState<string | null>(null)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)

  const baselineRoles = useMemo(
    () => baselineRolesFromRows(controller.view.rows),
    [controller.view.rows]
  )
  const presentationRows = useMemo(() => {
    const currentByUrl = new Map(
      controller.view.rows.map((row) => [row.url, row])
    )
    return orderAccountNetworkRelayRows(
      rows.map((row) => {
        const current = currentByUrl.get(row.url)
        return current
          ? {
              ...row,
              signedPosition: current.signedPosition ?? row.signedPosition,
              reachability: current.reachability,
              capability: current.capability,
              recoveryReadOnly: current.recoveryReadOnly,
            }
          : row
      }),
      rows.map((row) => row.url)
    )
  }, [controller.view.rows, rows])
  const desiredRoles = useMemo(
    () => desiredRolesFromRows(presentationRows),
    [presentationRows]
  )
  const editedRelayUrls = useMemo(() => {
    const baselineByUrl = new Map(
      baselineRoles.map((roles) => [roles.url, roles])
    )
    return new Set(
      desiredRoles.flatMap((roles) => {
        const baseline = baselineByUrl.get(roles.url)
        if (!baseline) return []
        return baseline.readEnabled !== roles.readEnabled ||
          baseline.publishEnabled !== roles.publishEnabled ||
          baseline.privateInboxEnabled !== roles.privateInboxEnabled
          ? [roles.url]
          : []
      })
    )
  }, [baselineRoles, desiredRoles])
  const wholeSetupRelayUrls = useMemo(() => {
    const relayUrls = new Set<string>()
    for (const row of controller.view.rows) {
      if (hasSignedOrPendingMembership(row)) relayUrls.add(row.url)
    }
    return relayUrls
  }, [controller.view.rows])
  const changedKindCount = countAccountNetworkChangedKinds(
    baselineRoles,
    desiredRoles
  )
  const dirty = changedKindCount > 0
  const controllerRowUrls = new Set(controller.view.rows.map((row) => row.url))
  const hasLocalCandidate = rows.some(
    (row) => row.candidate && !controllerRowUrls.has(row.url)
  )
  const hasUnconfiguredLocalCandidate = rows.some(
    (row) =>
      row.candidate &&
      !controllerRowUrls.has(row.url) &&
      !row.readEnabled &&
      !row.publishEnabled &&
      !row.privateInboxEnabled
  )
  const hasUnpublishedChanges = dirty || hasLocalCandidate
  const relayListChanged = rolesDiffer(baselineRoles, desiredRoles, (roles) => [
    roles.readEnabled,
    roles.publishEnabled,
  ])
  const inboxChanged = rolesDiffer(baselineRoles, desiredRoles, (roles) => [
    roles.privateInboxEnabled,
  ])
  const validation = controller.validate(desiredRoles)
  const validationErrors = hasUnconfiguredLocalCandidate
    ? ["Choose at least one role for each added relay or discard it."]
    : validation.errors
  const validationError = validationErrors[0] ?? null
  const validationWarnings = validation.warnings
  const pendingRetry = controller.view.pendingExactDeliveries.some(
    (delivery) => delivery.retryAvailable
  )
  const busy = operationIsBusy(controller.operation.phase)
  const metadataReady = controller.status === "ready" && !busy
  const mutationReady = metadataReady && !pendingRetry
  const inboxCount = rows.filter((row) => row.privateInboxEnabled).length
  const removalInstruction = removalInstructionForReview(
    relayPendingRemoval,
    dirty,
    baselineRoles,
    controller
  )
  const operationText = operationMessage(
    controller.operation.kind,
    controller.operation.phase,
    controller.operation.message
  )

  useEffect(() => {
    onUnpublishedRelayChangesChange?.(hasUnpublishedChanges)
  }, [hasUnpublishedChanges, onUnpublishedRelayChangesChange])

  useEffect(
    () => () => onUnpublishedRelayChangesChange?.(false),
    [onUnpublishedRelayChangesChange]
  )

  function toggleRole(
    url: string,
    role: AccountNetworkRole,
    trigger: HTMLButtonElement
  ): void {
    controller.clearOperation()
    setLocalActionError(null)
    const currentRow = rows.find((row) => row.url === url)
    if (
      currentRow &&
      wholeSetupRelayUrls.has(url) &&
      !currentRow.recoveryReadOnly &&
      roleEnabled(currentRow, role) &&
      Number(currentRow.readEnabled) +
        Number(currentRow.publishEnabled) +
        Number(currentRow.privateInboxEnabled) ===
        1
    ) {
      removalTriggerRef.current = trigger
      setRelayPendingRemoval(url)
      return
    }
    setRows((current) =>
      orderAccountNetworkRelayRows(
        current.map((row) => {
          if (row.url !== url) return row
          if (role === "read") {
            return { ...row, readEnabled: !row.readEnabled }
          }
          if (role === "publish") {
            return { ...row, publishEnabled: !row.publishEnabled }
          }
          return { ...row, privateInboxEnabled: !row.privateInboxEnabled }
        }),
        current.map((row) => row.url)
      )
    )
  }

  async function moveRelay(url: string, offset: -1 | 1): Promise<void> {
    const index = presentationRows.findIndex((row) => row.url === url)
    const targetIndex = index + offset
    if (
      index < 0 ||
      targetIndex < 0 ||
      targetIndex >= presentationRows.length
    ) {
      return
    }
    const target = presentationRows[targetIndex]
    const source = presentationRows[index]
    if (!target || !source) return
    if (!areAccountNetworkRelayRowsReorderEquivalent(source, target)) return

    const nextRows = [...presentationRows]
    nextRows[index] = target
    nextRows[targetIndex] = source
    setLocalActionError(null)
    setRows(nextRows)
    try {
      await controller.reorderRelays(nextRows.map((row) => row.url))
    } catch (error) {
      setRows(presentationRows)
      setLocalActionError(
        error instanceof Error
          ? error.message
          : "Unable to save this relay order preference."
      )
    }
  }

  async function addRelay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!newRelayUrl.trim() || isAdding) return
    setAddError(null)
    const normalized = tryNormalizeRelayUrl(newRelayUrl)
    if (!normalized.ok) {
      setAddError(normalized.error)
      return
    }
    if (rows.some((row) => row.url === normalized.url)) {
      setAddError("This relay is already in your Network review.")
      return
    }
    setIsAdding(true)
    try {
      const added = await controller.addRelay(normalized.url)
      setRows((current) =>
        current.some((row) => row.url === added.url)
          ? current
          : orderAccountNetworkRelayRows(
              [...current, added],
              [...current.map((row) => row.url), added.url]
            )
      )
      setNewRelayUrl("")
      controller.clearOperation()
    } catch (error) {
      setAddError(
        error instanceof Error ? error.message : "Unable to add this relay."
      )
    } finally {
      setIsAdding(false)
    }
  }

  function requestRelayRemoval(
    row: AccountNetworkRelayRowView,
    trigger: HTMLButtonElement
  ): void {
    if (!wholeSetupRelayUrls.has(row.url)) {
      setRows((current) =>
        current.filter((candidate) => candidate.url !== row.url)
      )
      setLocalActionError(null)
      controller.clearOperation()
      return
    }
    controller.clearOperation()
    removalTriggerRef.current = trigger
    setRelayPendingRemoval(row.url)
  }

  function requestPublish(): void {
    setLocalActionError(null)
    if (validationError) {
      setLocalActionError(validationError)
      return
    }
    if (changedKindCount === 0) return
    setPublishDialogOpen(true)
  }

  function closePublishDialog(): void {
    setPublishDialogOpen(false)
    requestAnimationFrame(() =>
      publishButtonRef.current?.focus({ preventScroll: true })
    )
  }

  async function confirmPublish(): Promise<void> {
    setPublishDialogOpen(false)
    setLocalActionError(null)
    if (validationError) {
      setLocalActionError(validationError)
      return
    }
    try {
      await controller.save(desiredRoles)
    } catch {
      // The controller exposes the actionable error beside this action.
    }
  }

  function discardReview(): void {
    setPublishDialogOpen(false)
    setRows(discardReviewRows(controller.view.rows))
    setLocalActionError(null)
    controller.clearOperation()
  }

  function cancelRemoval(): void {
    setRelayPendingRemoval(null)
  }

  async function proceedRemoval(): Promise<void> {
    if (!relayPendingRemoval) return
    try {
      await controller.removeRelay(relayPendingRemoval)
      setRelayPendingRemoval(null)
    } catch {
      // The controller exposes the actionable error beside this action.
    }
  }

  return {
    rows: presentationRows,
    newRelayUrl,
    addError,
    localActionError,
    isAdding,
    relayPendingRemoval,
    removalTriggerRef,
    publishButtonRef,
    publishDialogOpen,
    editedRelayUrls,
    wholeSetupRelayUrls,
    changedKindCount,
    dirty,
    hasUnpublishedChanges,
    relayListChanged,
    inboxChanged,
    validationError,
    validationWarnings,
    busy,
    metadataReady,
    mutationReady,
    inboxCount,
    removalInstruction,
    operationText,
    setNewRelayUrl,
    toggleRole,
    moveRelay,
    addRelay,
    requestRelayRemoval,
    requestPublish,
    closePublishDialog,
    confirmPublish,
    discardReview,
    cancelRemoval,
    proceedRemoval,
  }
}

type RelaySettingsReview = ReturnType<typeof useRelaySettingsReview>

function NetworkHeader() {
  return (
    <header>
      <h1 className="text-balance font-display text-4xl font-semibold text-[var(--text-primary)] sm:text-5xl">
        Network
      </h1>
      <p className="mt-3 max-w-2xl text-pretty text-base leading-7 text-[var(--text-secondary)]">
        Choose where Conduit reads, publishes, and receives private messages on
        Nostr.
      </p>
    </header>
  )
}

function LegacyInboxRecoverySection({
  controller,
  busy,
  relayDraftDirty,
}: {
  controller: AccountNetworkSettingsController
  busy: boolean
  relayDraftDirty: boolean
}) {
  if (!controller.exactInboxRedistributionAvailable) return null
  return (
    <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-balance text-sm font-semibold text-[var(--text-primary)]">
            Finish private inbox distribution
          </h3>
          <p className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Retry the exact signed declaration already retained on this device.
            This does not create a new event or ask your signer.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={busy || relayDraftDirty}
          title={
            relayDraftDirty
              ? "Publish or discard your relay edits before retrying the signed declaration."
              : undefined
          }
          onClick={() =>
            void controller
              .redistributeExactInboxDeclaration()
              .catch(() => undefined)
          }
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          Retry exact declaration
        </Button>
      </div>
    </div>
  )
}

function LegacyRelayDraftSection({
  controller,
  busy,
}: {
  controller: AccountNetworkSettingsController
  busy: boolean
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!controller.legacyDraftReviewAvailable) return null

  async function discardLegacyDraft(): Promise<void> {
    setDiscarding(true)
    setError(null)
    try {
      await controller.discardLegacyDraft()
      setDialogOpen(false)
    } catch (discardError) {
      setError(
        discardError instanceof Error
          ? discardError.message
          : "The older relay role draft could not be discarded."
      )
    } finally {
      setDiscarding(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-balance text-sm font-semibold text-[var(--text-primary)]">
            Older relay role draft
          </h3>
          <p className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Review and publish these older Read and Publish choices, or discard
            only this local draft. Discarding it does not end private inbox
            recovery.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={busy || discarding}
          onClick={() => {
            setError(null)
            setDialogOpen(true)
          }}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Discard older draft
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-pretty text-sm text-error">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!discarding) setDialogOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              Discard the older relay role draft?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty leading-6">
              This removes only the unpublished legacy Read and Publish draft
              from Conduit storage. It does not publish an event, ask your
              signer, or end private inbox recovery.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={discarding}
              onClick={() => setDialogOpen(false)}
            >
              Keep draft
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={discarding}
              onClick={() => void discardLegacyDraft()}
            >
              {discarding ? "Discarding" : "Discard draft"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function AddRelaySection({ review }: { review: RelaySettingsReview }) {
  return (
    <form onSubmit={(event) => void review.addRelay(event)}>
      <label
        htmlFor="account-network-relay-url"
        className="text-sm font-medium text-[var(--text-primary)]"
      >
        Add relay
      </label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <Input
          id="account-network-relay-url"
          aria-describedby={
            review.addError ? "account-network-relay-error" : undefined
          }
          aria-invalid={review.addError ? true : undefined}
          value={review.newRelayUrl}
          onChange={(event) => review.setNewRelayUrl(event.target.value)}
          placeholder="wss://relay.example.com"
          className="h-11 rounded-xl bg-[var(--surface-elevated)] font-mono"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={
            !review.metadataReady ||
            review.isAdding ||
            !review.newRelayUrl.trim()
          }
          className="h-11 shrink-0"
        >
          <Plus className="size-4" aria-hidden="true" />
          {review.isAdding ? "Adding" : "Add relay"}
        </Button>
      </div>
      {review.addError ? (
        <p
          id="account-network-relay-error"
          role="alert"
          className="mt-2 text-pretty text-sm text-error"
        >
          {review.addError}
        </p>
      ) : null}
    </form>
  )
}

function RelayListSection({ review }: { review: RelaySettingsReview }) {
  return (
    <div>
      <p className="mb-3 text-pretty text-xs leading-5 text-[var(--text-muted)]">
        Relay order is a Conduit preference among otherwise equivalent choices.
        Moving a relay does not ask your signer or change published authority.
      </p>
      {review.rows.length > 0 ? (
        <ul className="space-y-2" aria-label="Relays">
          {review.rows.map((row, index) => {
            const previous = review.rows[index - 1]
            const next = review.rows[index + 1]
            const canMoveEarlier = Boolean(
              previous &&
              areAccountNetworkRelayRowsReorderEquivalent(row, previous)
            )
            const canMoveLater = Boolean(
              next && areAccountNetworkRelayRowsReorderEquivalent(row, next)
            )
            return (
              <RelayRow
                key={row.url}
                row={row}
                edited={review.editedRelayUrls.has(row.url)}
                mutationDisabled={!review.mutationReady}
                operationBusy={review.busy}
                wholeSetupRemoval={review.wholeSetupRelayUrls.has(row.url)}
                inboxCount={review.inboxCount}
                canMoveEarlier={canMoveEarlier}
                canMoveLater={canMoveLater}
                onToggle={(role, trigger) =>
                  review.toggleRole(row.url, role, trigger)
                }
                onRemove={(trigger) => review.requestRelayRemoval(row, trigger)}
                onMoveEarlier={() => void review.moveRelay(row.url, -1)}
                onMoveLater={() => void review.moveRelay(row.url, 1)}
              />
            )
          })}
        </ul>
      ) : (
        <div className="py-4 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
          No relay preferences were found. Add at least one Publish relay.
          Select a Private inbox if you want to receive private messages.
        </div>
      )}
    </div>
  )
}

function OperationNotice({
  controller,
  message,
}: {
  controller: AccountNetworkSettingsController
  message: string | null
}) {
  if (!message) return null
  const phase = controller.operation.phase
  const error = phase === "error"
  const complete = phase === "complete"
  return (
    <div
      role={error ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "mt-3 flex items-start gap-2 text-pretty text-sm leading-6",
        error
          ? "text-error"
          : complete
            ? "text-success"
            : "text-[var(--text-secondary)]"
      )}
    >
      {error ? (
        <AlertCircle className="mt-1 size-4 shrink-0" aria-hidden="true" />
      ) : complete ? (
        <CheckCircle2 className="mt-1 size-4 shrink-0" aria-hidden="true" />
      ) : (
        <Info className="mt-1 size-4 shrink-0" aria-hidden="true" />
      )}
      <span>{message}</span>
    </div>
  )
}

function NetworkReviewSummary({ review }: { review: RelaySettingsReview }) {
  const title = review.hasUnpublishedChanges
    ? "Unpublished changes"
    : "No unpublished changes"
  const description = review.hasUnpublishedChanges
    ? "Publish or discard these relay edits before refreshing or leaving this page."
    : "Edit a relay role or add a relay to prepare an update."
  return (
    <div className="flex min-w-0 items-start gap-2">
      {review.hasUnpublishedChanges ? (
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-[var(--warning)]"
          aria-hidden="true"
        />
      ) : null}
      <div>
        <p
          className={cn(
            "text-sm font-semibold",
            review.hasUnpublishedChanges
              ? "text-[var(--warning)]"
              : "text-[var(--text-secondary)]"
          )}
        >
          {title}
        </p>
        <p className="mt-1 max-w-xl text-pretty text-xs leading-5 text-[var(--text-muted)]">
          {description}
        </p>
      </div>
    </div>
  )
}

function NetworkReviewActions({ review }: { review: RelaySettingsReview }) {
  const validationVisible = Boolean(
    review.validationError && review.hasUnpublishedChanges
  )
  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div className="flex flex-wrap justify-end gap-2">
        {review.hasUnpublishedChanges ? (
          <Button
            type="button"
            variant="ghost"
            disabled={review.busy}
            onClick={review.discardReview}
          >
            Discard changes
          </Button>
        ) : null}
        <Button
          ref={review.publishButtonRef}
          type="button"
          variant={review.hasUnpublishedChanges ? "primary" : "outline"}
          aria-describedby={
            validationVisible ? "network-review-validation" : undefined
          }
          disabled={
            !review.mutationReady ||
            review.changedKindCount === 0 ||
            Boolean(review.validationError)
          }
          onClick={review.requestPublish}
        >
          <Upload className="size-4" aria-hidden="true" />
          Review and publish
        </Button>
      </div>
      {validationVisible ? (
        <p
          id="network-review-validation"
          className="max-w-sm text-pretty text-right text-xs text-warning"
        >
          {review.validationError}
        </p>
      ) : null}
    </div>
  )
}

function NetworkReviewNotices({
  controller,
  review,
}: {
  controller: AccountNetworkSettingsController
  review: RelaySettingsReview
}) {
  return (
    <>
      {review.localActionError ? (
        <p role="alert" className="mt-3 text-pretty text-sm text-error">
          {review.localActionError}
        </p>
      ) : null}
      {review.validationWarnings.map((warning) => (
        <p
          key={warning}
          className="mt-3 flex items-start gap-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]"
        >
          <Info className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </p>
      ))}
      <OperationNotice controller={controller} message={review.operationText} />
    </>
  )
}

function PublishNetworkReviewDialog({
  review,
}: {
  review: RelaySettingsReview
}) {
  const signerRequestLabel =
    review.changedKindCount === 1 ? "request" : "requests"
  return (
    <AlertDialog
      open={review.publishDialogOpen}
      onOpenChange={(open) => {
        if (!open) review.closePublishDialog()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-balance">
            Publish these Network changes?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-pretty leading-6">
            Your external signer will show {review.changedKindCount}{" "}
            {signerRequestLabel}. The signed preferences publish and confirm
            independently.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-sm text-[var(--text-primary)]">
          {review.relayListChanged ? (
            <li>
              <span className="font-semibold">Read and Publish</span>
              <span className="text-[var(--text-secondary)]">
                {" "}
                relay preferences
              </span>
            </li>
          ) : null}
          {review.inboxChanged ? (
            <li>
              <span className="font-semibold">Private inbox</span>
              <span className="text-[var(--text-secondary)]">
                {" "}
                relay preferences
              </span>
            </li>
          ) : null}
        </ul>
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={review.closePublishDialog}
          >
            Keep editing
          </Button>
          <Button type="button" onClick={() => void review.confirmPublish()}>
            <Upload className="size-4" aria-hidden="true" />
            Sign and publish
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function NetworkReviewSection({
  controller,
  review,
}: {
  controller: AccountNetworkSettingsController
  review: RelaySettingsReview
}) {
  return (
    <>
      <PreferenceSectionFooter attention={review.hasUnpublishedChanges}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <NetworkReviewSummary review={review} />
          <NetworkReviewActions review={review} />
        </div>
        <NetworkReviewNotices controller={controller} review={review} />
      </PreferenceSectionFooter>

      <PublishNetworkReviewDialog review={review} />
    </>
  )
}

function RelayPreferencesSection({
  controller,
  review,
}: {
  controller: AccountNetworkSettingsController
  review: RelaySettingsReview
}) {
  const checking =
    controller.status === "reconciling" || controller.relayInformationRefreshing
  const refreshDisabled =
    checking || review.busy || review.hasUnpublishedChanges
  return (
    <PreferenceSectionCard
      headingId="relay-list-heading"
      title="Relays"
      description="Choose which relays Conduit uses to read, publish, and receive private messages."
      aria-busy={checking || undefined}
      headerAction={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refreshDisabled}
          title={
            review.hasUnpublishedChanges
              ? "Publish or discard your relay edits before refreshing."
              : undefined
          }
          onClick={() => void controller.refresh()}
        >
          <RefreshCw
            className={cn(
              "size-4",
              checking && "animate-spin motion-reduce:animate-none"
            )}
            aria-hidden="true"
          />
          {checking ? "Refreshing" : "Refresh"}
        </Button>
      }
    >
      <PreferenceSectionBody className="pt-0 sm:pt-0">
        <PublishedRelayPreferences controller={controller} />
        <PendingUpdateSummary
          controller={controller}
          relayDraftDirty={review.hasUnpublishedChanges}
        />
        <LegacyInboxRecoverySection
          controller={controller}
          busy={review.busy}
          relayDraftDirty={review.hasUnpublishedChanges}
        />
        <LegacyRelayDraftSection controller={controller} busy={review.busy} />
      </PreferenceSectionBody>
      <PreferenceSectionDivider />
      <PreferenceSectionBody>
        <RelayListSection review={review} />
      </PreferenceSectionBody>
      <PreferenceSectionDivider />
      <PreferenceSectionBody>
        <AddRelaySection review={review} />
      </PreferenceSectionBody>
      <PreferenceSectionDivider />
      <NetworkReviewSection controller={controller} review={review} />
    </PreferenceSectionCard>
  )
}

function RelayPreferencesEditor({
  controller,
  onUnpublishedRelayChangesChange,
}: RelaySettingsPanelProps) {
  const review = useRelaySettingsReview(
    controller,
    onUnpublishedRelayChangesChange
  )
  return (
    <>
      <RelayPreferencesSection controller={controller} review={review} />
      <RelayRemovalDialog
        relayUrl={review.relayPendingRemoval}
        instruction={review.removalInstruction}
        errorMessage={
          controller.operation.kind === "remove" &&
          controller.operation.phase === "error"
            ? (controller.operation.message ??
              "The relay could not be removed. Retry or cancel this removal.")
            : null
        }
        busy={review.busy}
        returnFocusRef={review.removalTriggerRef}
        onCancel={review.cancelRemoval}
        onProceed={() => void review.proceedRemoval()}
      />
    </>
  )
}

/** Keep signer-free ordering out of the editor reset identity. */
function getRelaySettingsEditorRevision(
  controller: AccountNetworkSettingsController
): string {
  const rows = controller.view.rows
    .map(
      (row) =>
        [
          row.url,
          row.readState,
          row.publishState,
          row.privateInboxState,
          Boolean(row.recoveryReadOnly),
        ] as const
    )
    .sort((left, right) => left[0].localeCompare(right[0]))

  return JSON.stringify({
    revision: controller.revision,
    legacyDraftReviewAvailable: controller.legacyDraftReviewAvailable,
    rows,
  })
}

export function RelaySettingsPanel({
  controller,
  className,
  onUnpublishedRelayChangesChange,
}: RelaySettingsPanelProps) {
  const editorRevision = getRelaySettingsEditorRevision(controller)
  return (
    <section
      className={cn(
        "rounded-[2rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 shadow-lg sm:p-7",
        className
      )}
    >
      <div className="space-y-6">
        <NetworkHeader />
        <RelayPreferencesEditor
          key={editorRevision}
          controller={controller}
          onUnpublishedRelayChangesChange={onUnpublishedRelayChangesChange}
        />
        {controller.mediaServers ? (
          <MediaServerPreferencesSection {...controller.mediaServers} />
        ) : null}
      </div>
    </section>
  )
}
