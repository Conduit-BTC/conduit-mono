import {
  ChevronDown,
  GripVertical,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react"
import { type DragEvent, type FormEvent, useMemo, useState } from "react"
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
import {
  PrivateInboxSection,
  type PrivateInboxSectionProps,
} from "./PrivateInboxSection"
import { SignedActionStatus } from "./SignedActionStatus"
import { StatusPill } from "./StatusPill"
import { cn } from "../utils"

type RelaySettingsSection = "commerce" | "public"

interface RelayCapabilities {
  nip11: boolean
  search: boolean
  dm: boolean
  auth: boolean
  commerce: boolean
  protectedMessages?: boolean
  listings?: boolean
  cleanup?: boolean
}

interface RelayWarnings {
  dmWithoutAuth: boolean
  staleRelayInfo: boolean
  unreachable: boolean
  commercePartialSupport: boolean
}

export interface RelaySettingsPanelEntry {
  url: string
  readEnabled: boolean
  writeEnabled: boolean
  section: RelaySettingsSection
  source?: "default" | "manual" | "signer" | "published"
  commercePriority?: number
  capabilities: RelayCapabilities
  warnings: RelayWarnings
  scannedAt?: number
  relayName?: string
}

export interface RelaySettingsPanelState {
  entries: RelaySettingsPanelEntry[]
}

export type RelayAuthEvidenceState =
  | "untested"
  | "advertised"
  | "challenge_observed"
  | "succeeded"
  | "rejected"
  | "unavailable"

export interface RelaySettingsPanelProps {
  settings: RelaySettingsPanelState
  /** Runtime NIP-42 evidence. NIP-11 metadata alone is only "advertised". */
  authEvidenceByUrl?: Readonly<
    Record<string, RelayAuthEvidenceState | undefined>
  >
  scanningUrls?: readonly string[]
  error?: string | null
  isLoadingPublishedRelayList?: boolean
  publishedRelayListUpdatedAt?: number | null
  publishingRelayList?: boolean
  publishError?: string | null
  onAddRelay: (url: string) => void | Promise<void>
  onRefreshRelay: (url: string) => void | Promise<void>
  onRemoveRelay: (url: string) => void
  onToggleRead: (url: string, enabled: boolean) => void
  onToggleWrite: (url: string, enabled: boolean) => void
  onReorderCommerceRelay?: (sourceUrl: string, targetUrl: string) => void
  onReset?: () => void
  onPublishRelayList?: () => void | Promise<void>
  /** NIP-17 private inbox declaration status and repair (CND-208). */
  privateInbox?: Omit<PrivateInboxSectionProps, "className">
  className?: string
}

const sectionMeta: Record<
  RelaySettingsSection,
  {
    label: string
    description: string
    labelClassName: string
    dotClassName: string
    surfaceClassName: string
    empty: string
  }
> = {
  commerce: {
    label: "Commerce Relays",
    description:
      "Conduit has enough capability evidence to prioritize these relays for products, orders, and messages.",
    labelClassName: "text-[var(--primary-500)]",
    dotClassName: "bg-primary-400",
    surfaceClassName:
      "bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)]",
    empty:
      "No saved relay currently matches Conduit's full commerce profile. Your other relays can still remain useful here and in other Nostr apps.",
  },
  public: {
    label: "Other Relays",
    description:
      "These relays do not currently match Conduit's full commerce profile. They may still be important for general Nostr use or other apps.",
    labelClassName: "text-[var(--accent-500)]",
    dotClassName: "bg-accent-400",
    surfaceClassName:
      "bg-[color-mix(in_srgb,var(--accent-500)_1%,transparent)]",
    empty: "No other relays are saved for this signer.",
  },
}

function sortSectionEntries(
  entries: readonly RelaySettingsPanelEntry[],
  section: RelaySettingsSection
): RelaySettingsPanelEntry[] {
  const sectionEntries = entries.filter((entry) => entry.section === section)
  if (section !== "commerce") {
    return sectionEntries.sort((a, b) => a.url.localeCompare(b.url))
  }

  return sectionEntries.sort((a, b) => {
    const aPriority = a.commercePriority ?? Number.MAX_SAFE_INTEGER
    const bPriority = b.commercePriority ?? Number.MAX_SAFE_INTEGER
    if (aPriority !== bPriority) return aPriority - bPriority
    return a.url.localeCompare(b.url)
  })
}

function getRelayStatusLabel(entry: RelaySettingsPanelEntry): string {
  if (entry.warnings.unreachable) return "Latest check failed"
  if (entry.warnings.staleRelayInfo) return "Check is outdated"
  if (entry.capabilities.nip11) return "Relay info available"
  return "Not checked"
}

function getRelayWarningText(entry: RelaySettingsPanelEntry): string | null {
  if (entry.warnings.unreachable) {
    return "The latest relay-information check failed. Conduit kept your saved settings unchanged."
  }
  if (entry.warnings.dmWithoutAuth) {
    return "Protected-message relay without auth. Conduit may limit private commerce messaging here because relay access controls may be weaker."
  }
  if (entry.warnings.commercePartialSupport) {
    return "Some commerce-related support was detected, but Conduit has not confirmed the full commerce profile. This is not a reason to remove the relay."
  }
  if (entry.warnings.staleRelayInfo) {
    return "Relay information is cached or older than Conduit's freshness window. Check again to refresh the capability evidence."
  }
  return null
}

function getRelayCompatibilityText(entry: RelaySettingsPanelEntry): string {
  if (entry.capabilities.commerce) {
    return "Conduit has enough advertised or configured evidence to use its commerce profile. Protected access is reported separately."
  }
  if (entry.capabilities.nip11) {
    return "Relay information is available. Conduit can use this relay for reading or publishing when enabled; metadata does not prove protected access."
  }
  return "Compatibility has not been checked yet."
}

function getAuthEvidenceLabel(
  entry: RelaySettingsPanelEntry,
  evidence: RelayAuthEvidenceState | undefined
): string {
  const resolved =
    evidence ?? (entry.capabilities.auth ? "advertised" : "untested")

  switch (resolved) {
    case "succeeded":
      return "Auth succeeded"
    case "challenge_observed":
      return "Auth challenge observed"
    case "rejected":
      return "Auth rejected"
    case "unavailable":
      return "Auth unavailable"
    case "advertised":
      return "Auth advertised"
    case "untested":
    default:
      return "Auth untested"
  }
}

function hasProtectedMessageCapability(
  entry: RelaySettingsPanelEntry
): boolean {
  return entry.capabilities.protectedMessages ?? entry.capabilities.dm
}

function hasCleanupCapability(entry: RelaySettingsPanelEntry): boolean {
  return entry.capabilities.cleanup === true
}

function getRelaySourceMeta(entry: RelaySettingsPanelEntry): {
  label: string
  variant: "success" | "info" | "neutral"
} {
  switch (entry.source) {
    case "published":
      return { label: "Published relay list", variant: "success" }
    case "signer":
      return { label: "From signer", variant: "info" }
    case "manual":
      return { label: "Managed in Conduit", variant: "info" }
    case "default":
    default:
      return { label: "Conduit fallback", variant: "neutral" }
  }
}

function PreferenceToggle({
  label,
  active,
  disabled,
  tooltip,
  onToggle,
}: {
  label: "Read" | "Publish"
  active: boolean
  disabled: boolean
  tooltip: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={active}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-full border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-primary-400 bg-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] text-[var(--primary-500)]"
          : "border-[var(--border-overlay)] bg-transparent text-[var(--text-secondary)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
      )}
    >
      {label}
    </button>
  )
}

const relayCheckDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

function formatRelayCheckTime(scannedAt?: number): string {
  if (!scannedAt || !Number.isFinite(scannedAt)) return "Not recorded"
  const checkedAt = new Date(scannedAt)
  if (Number.isNaN(checkedAt.getTime())) return "Not recorded"
  return relayCheckDateTimeFormatter.format(checkedAt)
}

function RelayCapabilityDetails({
  entry,
  authEvidence,
}: {
  entry: RelaySettingsPanelEntry
  authEvidence?: RelayAuthEvidenceState
}) {
  const warningText = getRelayWarningText(entry)
  const compatibilityText = getRelayCompatibilityText(entry)
  const supportsProtectedMessages = hasProtectedMessageCapability(entry)
  const authEvidenceLabel = getAuthEvidenceLabel(entry, authEvidence)

  return (
    <details className="group/details rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)]">
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs font-medium text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
        <span>
          Relay details
          <span className="sr-only"> for {entry.url}</span>
        </span>
        <ChevronDown
          className="size-3.5 group-open/details:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-[var(--border)] px-3 py-3">
        <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-[var(--text-muted)]">Commerce</dt>
            <dd className="mt-1 font-medium text-[var(--text-primary)]">
              {entry.capabilities.commerce
                ? "Profile matched"
                : entry.warnings.commercePartialSupport
                  ? "Partial support detected"
                  : "Full profile not confirmed"}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)]">Search</dt>
            <dd className="mt-1 font-medium text-[var(--text-primary)]">
              {entry.capabilities.search ? "Advertised" : "Not advertised"}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)]">Encrypted messages</dt>
            <dd className="mt-1 font-medium text-[var(--text-primary)]">
              {supportsProtectedMessages
                ? "Support detected"
                : "Support not detected"}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)]">Protected access</dt>
            <dd className="mt-1 font-medium text-[var(--text-primary)]">
              {authEvidenceLabel}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)]">Cleanup</dt>
            <dd className="mt-1 font-medium text-[var(--text-primary)]">
              {hasCleanupCapability(entry)
                ? "Support detected"
                : "Support not detected"}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)]">Last checked</dt>
            <dd className="mt-1 font-medium text-[var(--text-primary)]">
              {formatRelayCheckTime(entry.scannedAt)}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
          {warningText ?? compatibilityText}
        </p>
      </div>
    </details>
  )
}

function RelayRow({
  entry,
  authEvidence,
  inboxCandidate,
  section,
  scanning,
  draggedUrl,
  onDragStart,
  onDragEnd,
  onDropRelay,
  onRefreshRelay,
  onRemoveRelay,
  onToggleRead,
  onToggleWrite,
}: {
  entry: RelaySettingsPanelEntry
  authEvidence?: RelayAuthEvidenceState
  inboxCandidate?: PrivateInboxSectionProps["candidateRelays"][number]
  section: RelaySettingsSection
  scanning: boolean
  draggedUrl: string | null
  onDragStart: (url: string) => void
  onDragEnd: () => void
  onDropRelay?: (sourceUrl: string, targetUrl: string) => void
  onRefreshRelay: (url: string) => void
  onRemoveRelay: (url: string) => void
  onToggleRead: (url: string, enabled: boolean) => void
  onToggleWrite: (url: string, enabled: boolean) => void
}) {
  const isDisabled = entry.warnings.unreachable || scanning
  const isDefaultEntry = entry.source === "default"
  const draggable = section === "commerce" && !!onDropRelay
  const statusLabel = scanning ? "Checking relay" : getRelayStatusLabel(entry)
  const sourceMeta = getRelaySourceMeta(entry)

  function handleDragStart(event: DragEvent<HTMLDivElement>): void {
    if (!draggable) return
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", entry.url)
    onDragStart(entry.url)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    if (!draggable) return
    event.preventDefault()
    const sourceUrl = event.dataTransfer.getData("text/plain") || draggedUrl
    if (!sourceUrl) return
    onDropRelay?.(sourceUrl, entry.url)
  }

  return (
    <div
      draggable={draggable}
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (draggable) event.preventDefault()
      }}
      onDrop={handleDrop}
      className={cn(
        "group flex flex-col gap-3 border-b border-[var(--border)] py-4 last:border-b-0",
        draggedUrl === entry.url && "opacity-55"
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl bg-[color-mix(in_srgb,var(--surface)_60%,transparent)] p-3 sm:bg-transparent sm:p-0">
          {draggable ? (
            <GripVertical
              className="hidden size-4 cursor-grab text-[var(--text-muted)] active:cursor-grabbing sm:block"
              aria-label="Drag to change Conduit's commerce priority"
            />
          ) : null}
          <span
            className={cn(
              "size-2.5 shrink-0 rounded-full",
              sectionMeta[section].dotClassName,
              (entry.warnings.unreachable || !entry.readEnabled) && "opacity-35"
            )}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div
              className={cn(
                "truncate font-mono text-sm text-[var(--text-primary)]",
                entry.warnings.unreachable && "text-[var(--text-muted)]"
              )}
              title={entry.url}
            >
              {entry.url}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
              <span
                className={cn(
                  entry.warnings.unreachable && "text-[var(--error)]",
                  !entry.warnings.unreachable &&
                    entry.warnings.staleRelayInfo &&
                    "text-[var(--warning)]"
                )}
              >
                {statusLabel}
              </span>
              {entry.relayName ? <span>{entry.relayName}</span> : null}
              <StatusPill
                variant={sourceMeta.variant}
                noIcon
                className="py-0.5 text-[0.68rem]"
              >
                {sourceMeta.label}
              </StatusPill>
              {inboxCandidate?.declared ? (
                <StatusPill
                  variant="success"
                  noIcon
                  className="py-0.5 text-[0.68rem]"
                >
                  Private inbox
                </StatusPill>
              ) : inboxCandidate?.retained ? (
                <StatusPill
                  variant="info"
                  noIcon
                  className="py-0.5 text-[0.68rem]"
                >
                  Previous inbox
                </StatusPill>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 sm:shrink-0 sm:justify-end">
          <div className="flex items-center gap-1.5">
            <PreferenceToggle
              label="Read"
              active={entry.readEnabled}
              disabled={isDisabled}
              tooltip="Let Conduit read relevant events from this relay."
              onToggle={() => onToggleRead(entry.url, !entry.readEnabled)}
            />
            <PreferenceToggle
              label="Publish"
              active={entry.writeEnabled}
              disabled={isDisabled}
              tooltip="Let Conduit publish supported events to this relay."
              onToggle={() => onToggleWrite(entry.url, !entry.writeEnabled)}
            />
          </div>
          <button
            type="button"
            onClick={() => onRefreshRelay(entry.url)}
            disabled={scanning}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-overlay)] bg-[color-mix(in_srgb,var(--neutral-500)_10%,transparent)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-wait disabled:opacity-50"
            aria-label={`Refresh ${entry.url}`}
            title="Refresh relay verification"
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5 hover-spin-once",
                scanning && "animate-spin"
              )}
            />
          </button>
          <button
            type="button"
            onClick={() => onRemoveRelay(entry.url)}
            disabled={isDefaultEntry}
            className="inline-flex size-9 items-center justify-center rounded-full border border-[var(--border-overlay)] bg-[color-mix(in_srgb,var(--neutral-500)_10%,transparent)] text-[var(--text-secondary)] opacity-100 transition-colors hover:border-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)] hover:text-[var(--error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-[var(--border-overlay)] disabled:hover:bg-[color-mix(in_srgb,var(--neutral-500)_10%,transparent)] disabled:hover:text-[var(--text-secondary)]"
            aria-label={
              isDefaultEntry
                ? `${entry.url} is a default fallback`
                : `Remove ${entry.url} from Conduit`
            }
            title={
              isDefaultEntry
                ? "Default fallbacks stay visible unless you edit them into your list."
                : "Remove from Conduit. Other apps stay unchanged unless you publish the updated relay list."
            }
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <RelayCapabilityDetails entry={entry} authEvidence={authEvidence} />
    </div>
  )
}

function RelaySection({
  section,
  entries,
  authEvidenceByUrl,
  inboxCandidateByUrl,
  scanningUrls,
  draggedUrl,
  onDragStart,
  onDragEnd,
  onDropRelay,
  onRefreshRelay,
  onRemoveRelay,
  onToggleRead,
  onToggleWrite,
}: {
  section: RelaySettingsSection
  entries: RelaySettingsPanelEntry[]
  authEvidenceByUrl?: Readonly<
    Record<string, RelayAuthEvidenceState | undefined>
  >
  inboxCandidateByUrl: ReadonlyMap<
    string,
    PrivateInboxSectionProps["candidateRelays"][number]
  >
  scanningUrls: readonly string[]
  draggedUrl: string | null
  onDragStart: (url: string) => void
  onDragEnd: () => void
  onDropRelay?: (sourceUrl: string, targetUrl: string) => void
  onRefreshRelay: (url: string) => void
  onRemoveRelay: (url: string) => void
  onToggleRead: (url: string, enabled: boolean) => void
  onToggleWrite: (url: string, enabled: boolean) => void
}) {
  const meta = sectionMeta[section]

  return (
    <section>
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2
            className={cn(
              "text-sm font-semibold uppercase tracking-[0.2em]",
              meta.labelClassName
            )}
          >
            {meta.label}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
            {meta.description}
          </p>
        </div>
        {section === "commerce" && entries.length > 1 && onDropRelay ? (
          <div className="text-xs text-[var(--text-muted)]">
            Drag to change Conduit's commerce priority.
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          "rounded-[1.75rem] border border-[var(--border)] px-4 py-2 shadow-[var(--shadow-glass-inset)] sm:px-5",
          meta.surfaceClassName
        )}
      >
        {entries.length > 0 ? (
          entries.map((entry) => (
            <RelayRow
              key={entry.url}
              entry={entry}
              authEvidence={authEvidenceByUrl?.[entry.url]}
              inboxCandidate={inboxCandidateByUrl.get(entry.url)}
              section={section}
              scanning={scanningUrls.includes(entry.url)}
              draggedUrl={draggedUrl}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDropRelay={onDropRelay}
              onRefreshRelay={onRefreshRelay}
              onRemoveRelay={onRemoveRelay}
              onToggleRead={onToggleRead}
              onToggleWrite={onToggleWrite}
            />
          ))
        ) : (
          <div className="py-8 text-sm leading-6 text-[var(--text-muted)]">
            {meta.empty}
          </div>
        )}
      </div>
    </section>
  )
}

function getPrivateInboxSummary(
  privateInbox: RelaySettingsPanelProps["privateInbox"]
): {
  label: string
  variant: "success" | "warning" | "error" | "info" | "neutral"
} {
  if (!privateInbox) return { label: "Not available", variant: "neutral" }

  if (
    privateInbox.stale &&
    !privateInbox.distributionRepairable &&
    (privateInbox.status === "ready" ||
      privateInbox.status === "distribution_pending" ||
      privateInbox.status === "signed_empty" ||
      privateInbox.status === "malformed")
  ) {
    return { label: "Needs a fresh check", variant: "warning" }
  }

  switch (privateInbox.status) {
    case "ready":
      return privateInbox.distributionRepairable
        ? { label: "Redistribution needed", variant: "warning" }
        : { label: "Ready", variant: "success" }
    case "loading":
      return { label: "Checking", variant: "info" }
    case "distribution_pending":
      return { label: "Distribution pending", variant: "warning" }
    case "signed_empty":
      return { label: "No relays declared", variant: "error" }
    case "malformed":
      return { label: "Needs repair", variant: "error" }
    case "lookup_partial":
    case "lookup_unavailable":
      return { label: "Status unknown", variant: "warning" }
    case "not_observed":
    default:
      return { label: "Needs setup", variant: "warning" }
  }
}

function RelaySetupOverview({
  entries,
  privateInbox,
}: {
  entries: readonly RelaySettingsPanelEntry[]
  privateInbox: RelaySettingsPanelProps["privateInbox"]
}) {
  const readCount = entries.filter((entry) => entry.readEnabled).length
  const publishCount = entries.filter((entry) => entry.writeEnabled).length
  const checkCount = entries.filter(
    (entry) =>
      entry.scannedAt === undefined ||
      entry.warnings.unreachable ||
      entry.warnings.staleRelayInfo
  ).length
  const inboxSummary = getPrivateInboxSummary(privateInbox)

  return (
    <section
      aria-labelledby="relay-setup-overview"
      className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <h2
        id="relay-setup-overview"
        className="text-balance text-sm font-semibold text-[var(--text-primary)]"
      >
        Your relay setup
      </h2>
      <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
        This summarizes your saved relay list. Conduit may use separate bounded
        app fallbacks when needed.
      </p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2.5">
          <dt className="text-xs text-[var(--text-muted)]">Read</dt>
          <dd className="mt-1 text-sm font-medium tabular-nums text-[var(--text-primary)]">
            {readCount} selected
          </dd>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2.5">
          <dt className="text-xs text-[var(--text-muted)]">Publish</dt>
          <dd className="mt-1 text-sm font-medium tabular-nums text-[var(--text-primary)]">
            {publishCount} selected
          </dd>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2.5">
          <dt className="text-xs text-[var(--text-muted)]">Private inbox</dt>
          <dd className="mt-1">
            <StatusPill
              variant={inboxSummary.variant}
              className="py-0.5 text-[0.68rem]"
            >
              {inboxSummary.label}
            </StatusPill>
          </dd>
        </div>
      </dl>
      {checkCount > 0 ? (
        <p className="mt-3 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
          {checkCount}{" "}
          {checkCount === 1 ? "relay check needs" : "relay checks need"}{" "}
          attention. Saved preferences remain unchanged when a check fails.
        </p>
      ) : entries.length > 0 ? (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Relay-information checks are current on this device.
        </p>
      ) : null}
    </section>
  )
}

function RelaySettingsActions({
  entries,
  isLoadingPublishedRelayList,
  publishingRelayList,
  publishError,
  onReset,
  onPublishRelayList,
}: {
  entries: readonly RelaySettingsPanelEntry[]
  isLoadingPublishedRelayList: boolean
  publishingRelayList: boolean
  publishError: string | null
  onReset?: () => void
  onPublishRelayList?: () => void | Promise<void>
}) {
  const [isPublishing, setIsPublishing] = useState(false)
  const [publishedFingerprint, setPublishedFingerprint] = useState<
    string | null
  >(null)
  const [clearSettingsOpen, setClearSettingsOpen] = useState(false)
  const publishableEntries = entries.filter(
    (entry) => entry.readEnabled || entry.writeEnabled
  )
  const activeRelayCount = publishableEntries.length
  const readRelayCount = publishableEntries.filter(
    (entry) => entry.readEnabled
  ).length
  const writeRelayCount = publishableEntries.filter(
    (entry) => entry.writeEnabled
  ).length
  const canPublishRelayList = activeRelayCount > 1 && writeRelayCount > 0
  const relaySettingsFingerprint = useMemo(
    () =>
      entries
        .map((entry) =>
          [
            entry.url,
            entry.readEnabled ? "read" : "no-read",
            entry.writeEnabled ? "write" : "no-write",
          ].join(":")
        )
        .sort()
        .join("|"),
    [entries]
  )

  async function handlePublishRelayList(): Promise<void> {
    if (!onPublishRelayList || isPublishing || publishingRelayList) return

    setIsPublishing(true)
    setPublishedFingerprint(null)
    try {
      await onPublishRelayList()
      setPublishedFingerprint(relaySettingsFingerprint)
    } catch {
      setPublishedFingerprint(null)
    } finally {
      setIsPublishing(false)
    }
  }

  if (!onReset && !onPublishRelayList) return null

  return (
    <>
      <div className="space-y-3">
        {onPublishRelayList ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
            Changes stay in Conduit until you publish. Publishing replaces your
            NIP-65 relay list, which other Nostr apps may use, with{" "}
            {activeRelayCount} saved relay{" "}
            {activeRelayCount === 1 ? "tag" : "tags"}: {readRelayCount} Read,{" "}
            {writeRelayCount} Publish.
            {writeRelayCount === 0
              ? " Select Publish on at least one relay before publishing."
              : " Your signer may show empty content because relay URLs are stored in tags."}
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {onReset ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setClearSettingsOpen(true)}
            >
              Clear relay settings
            </Button>
          ) : null}
          {onPublishRelayList ? (
            <Button
              type="button"
              variant="outline"
              disabled={
                !canPublishRelayList ||
                isLoadingPublishedRelayList ||
                isPublishing ||
                publishingRelayList
              }
              onClick={() => void handlePublishRelayList()}
            >
              <Upload className="h-4 w-4" />
              {isPublishing || publishingRelayList
                ? "Waiting for signer..."
                : "Publish relay list"}
            </Button>
          ) : null}
        </div>
        {onPublishRelayList ? (
          <SignedActionStatus
            state={
              isPublishing || publishingRelayList
                ? "awaiting_signature"
                : publishError
                  ? "error"
                  : publishedFingerprint === relaySettingsFingerprint
                    ? "success"
                    : "idle"
            }
            awaitingSignatureMessage="Confirm the relay list in your signer. It will show as published after relay delivery finishes."
            successMessage="Relay list signed and published."
            errorMessage={publishError ?? undefined}
            className="justify-end"
          />
        ) : null}
      </div>

      <AlertDialog open={clearSettingsOpen} onOpenChange={setClearSettingsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Clear relay settings on this device?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty leading-6">
              Conduit will remove every saved relay preference for this signer
              on this device. Your published NIP-65 list and other Nostr apps
              stay unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setClearSettingsOpen(false)}
            >
              Keep settings
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                onReset?.()
                setClearSettingsOpen(false)
              }}
            >
              Clear local settings
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function RelaySettingsPanel({
  settings,
  authEvidenceByUrl,
  scanningUrls = [],
  error,
  isLoadingPublishedRelayList = false,
  publishedRelayListUpdatedAt = null,
  publishingRelayList = false,
  publishError = null,
  onAddRelay,
  onRefreshRelay,
  onRemoveRelay,
  onToggleRead,
  onToggleWrite,
  onReorderCommerceRelay,
  onReset,
  onPublishRelayList,
  privateInbox,
  className,
}: RelaySettingsPanelProps) {
  const [newRelayUrl, setNewRelayUrl] = useState("")
  const [isAdding, setIsAdding] = useState(false)
  const [draggedUrl, setDraggedUrl] = useState<string | null>(null)
  const [relayPendingRemoval, setRelayPendingRemoval] = useState<string | null>(
    null
  )
  const personalEntries = useMemo(
    () => settings.entries.filter((entry) => entry.source !== "default"),
    [settings.entries]
  )
  const commerceEntries = sortSectionEntries(personalEntries, "commerce")
  const otherEntries = sortSectionEntries(personalEntries, "public")
  const inboxCandidateByUrl = useMemo(
    () =>
      new Map(
        (privateInbox?.candidateRelays ?? []).map((candidate) => [
          candidate.url,
          candidate,
        ])
      ),
    [privateInbox?.candidateRelays]
  )
  async function handleAddRelay(event: FormEvent): Promise<void> {
    event.preventDefault()
    const trimmed = newRelayUrl.trim()
    if (!trimmed || isAdding) return

    setIsAdding(true)
    try {
      await onAddRelay(trimmed)
      setNewRelayUrl("")
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <section
      className={cn(
        "rounded-[2.25rem] border border-[var(--border)] bg-[color:var(--surface-elevated)] bg-[image:radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary-500)_14%,transparent),transparent_35%)] p-5 shadow-[var(--shadow-dialog)] sm:p-8",
        className
      )}
    >
      <div className="space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-balance font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
              Network Settings
            </h1>
            <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-[var(--text-secondary)]">
              Choose where Conduit reads and publishes. Your published relay
              list may also be used by other Nostr apps.
            </p>
          </div>
          {isLoadingPublishedRelayList || publishedRelayListUpdatedAt ? (
            <div className="flex min-h-7 items-center pt-1 text-xs text-[var(--text-muted)]">
              {isLoadingPublishedRelayList
                ? "Checking relays"
                : "Published relays loaded"}
            </div>
          ) : null}
        </div>

        <RelaySetupOverview
          entries={personalEntries}
          privateInbox={privateInbox}
        />

        <RelaySection
          section="commerce"
          entries={commerceEntries}
          authEvidenceByUrl={authEvidenceByUrl}
          inboxCandidateByUrl={inboxCandidateByUrl}
          scanningUrls={scanningUrls}
          draggedUrl={draggedUrl}
          onDragStart={setDraggedUrl}
          onDragEnd={() => setDraggedUrl(null)}
          onDropRelay={
            onReorderCommerceRelay
              ? (sourceUrl, targetUrl) => {
                  setDraggedUrl(null)
                  onReorderCommerceRelay(sourceUrl, targetUrl)
                }
              : undefined
          }
          onRefreshRelay={(url) => void onRefreshRelay(url)}
          onRemoveRelay={setRelayPendingRemoval}
          onToggleRead={onToggleRead}
          onToggleWrite={onToggleWrite}
        />

        {personalEntries.length === 0 ? (
          <div className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="text-sm font-medium text-[var(--text-primary)]">
              No relays saved for this signer
            </div>
            <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
              Conduit can still use app infrastructure and bounded fallback
              relays for reads. Those relays are separate from your personal
              NIP-65 list.
            </p>
          </div>
        ) : null}

        <RelaySection
          section="public"
          entries={otherEntries}
          authEvidenceByUrl={authEvidenceByUrl}
          inboxCandidateByUrl={inboxCandidateByUrl}
          scanningUrls={scanningUrls}
          draggedUrl={draggedUrl}
          onDragStart={setDraggedUrl}
          onDragEnd={() => setDraggedUrl(null)}
          onDropRelay={undefined}
          onRefreshRelay={(url) => void onRefreshRelay(url)}
          onRemoveRelay={setRelayPendingRemoval}
          onToggleRead={onToggleRead}
          onToggleWrite={onToggleWrite}
        />

        {privateInbox ? <PrivateInboxSection {...privateInbox} /> : null}

        <form
          onSubmit={(event) => void handleAddRelay(event)}
          className="rounded-[1.5rem] border border-dashed border-[var(--border)] bg-[var(--surface)] p-4"
        >
          <label
            htmlFor="relay-url"
            className="text-sm font-medium text-[var(--text-primary)]"
          >
            Add Relay
          </label>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <Input
              id="relay-url"
              value={newRelayUrl}
              onChange={(event) => setNewRelayUrl(event.target.value)}
              placeholder="wss://relay.example.com"
              className="h-12 rounded-2xl bg-[var(--surface-elevated)] font-mono"
            />
            <Button
              type="submit"
              disabled={isAdding || !newRelayUrl.trim()}
              className="h-12 rounded-2xl px-5"
            >
              <Plus className="h-4 w-4" />
              {isAdding ? "Checking..." : "Add Relay"}
            </Button>
          </div>
          <p className="mt-3 text-pretty text-sm leading-6 text-[var(--text-muted)]">
            Conduit checks relay information and capabilities, then places the
            relay in the appropriate section. Missing a commerce profile is not
            a reason to remove it.
          </p>
          {error ? (
            <div className="mt-3 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
              {error}
            </div>
          ) : null}
        </form>

        <RelaySettingsActions
          entries={personalEntries}
          isLoadingPublishedRelayList={isLoadingPublishedRelayList}
          publishingRelayList={publishingRelayList}
          publishError={publishError}
          onReset={onReset}
          onPublishRelayList={onPublishRelayList}
        />
      </div>

      <AlertDialog
        open={relayPendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setRelayPendingRemoval(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this relay from Conduit?</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty leading-6">
              Conduit will remove this relay from the saved settings on this
              device. Other Nostr apps stay unchanged unless you publish the
              updated relay list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="break-all rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--text-primary)]">
            {relayPendingRemoval}
          </div>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRelayPendingRemoval(null)}
            >
              Keep relay
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (relayPendingRemoval) onRemoveRelay(relayPendingRemoval)
                setRelayPendingRemoval(null)
              }}
            >
              Remove from Conduit
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
