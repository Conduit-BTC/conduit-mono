import {
  AlertTriangle,
  Eraser,
  GripVertical,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Upload,
  WifiOff,
} from "lucide-react"
import {
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react"
import { Button } from "./Button"
import { Input } from "./Input"
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

export interface RelaySettingsPanelBucket {
  id: string
  label: string
  relayUrls: readonly string[]
}

export interface RelaySettingsPanelProps {
  settings: RelaySettingsPanelState
  relayBuckets?: readonly RelaySettingsPanelBucket[]
  scanningUrls?: readonly string[]
  error?: string | null
  isLoadingPublishedRelayList?: boolean
  publishedRelayListUpdatedAt?: number | null
  publishingRelayList?: boolean
  publishError?: string | null
  dmInboxRelayUrls?: readonly string[]
  dmInboxDefaultRelayUrls?: readonly string[]
  dmInboxPublishedAt?: number | null
  dmInboxLoading?: boolean
  publishingDmInbox?: boolean
  dmInboxPublishError?: string | null
  onAddRelay: (url: string) => void | Promise<void>
  onRefreshRelay: (url: string) => void | Promise<void>
  onRemoveRelay: (url: string) => void
  onToggleRead: (url: string, enabled: boolean) => void
  onToggleWrite: (url: string, enabled: boolean) => void
  onReorderCommerceRelay?: (sourceUrl: string, targetUrl: string) => void
  onReset?: () => void
  onPublishRelayList?: () => void | Promise<void>
  onPublishDefaultDmInbox?: () => void | Promise<void>
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
      "Relays that Conduit can use for commerce events like products, stock updates, orders, and merchant messages.",
    labelClassName: "text-[var(--primary-500)]",
    dotClassName: "bg-primary-400",
    surfaceClassName:
      "bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)]",
    empty:
      "No verified commerce relays yet. Add a relay and Conduit will verify whether it belongs here.",
  },
  public: {
    label: "Public Relays",
    description:
      "General Nostr relays used for broader network reading, publishing, and discovery.",
    labelClassName: "text-[var(--accent-500)]",
    dotClassName: "bg-accent-400",
    surfaceClassName:
      "bg-[color-mix(in_srgb,var(--accent-500)_1%,transparent)]",
    empty:
      "No public relays configured yet. Reachable non-commerce relays will appear here.",
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
  if (entry.warnings.unreachable) return "Unreachable"
  if (entry.warnings.staleRelayInfo) return "Needs verification"
  if (entry.capabilities.nip11) return "Verified"
  return "Not scanned"
}

function getRelayWarningText(entry: RelaySettingsPanelEntry): string | null {
  if (entry.warnings.unreachable) {
    return "Relay is unreachable. It is kept disabled until verification succeeds."
  }
  if (entry.warnings.dmWithoutAuth) {
    return "Protected-message relay without auth. Conduit may limit private commerce messaging here because relay access controls may be weaker."
  }
  if (entry.warnings.commercePartialSupport) {
    return "Commerce checks are incomplete. This relay has commerce-relevant signals, but has not passed Conduit's listing, protected-message, cleanup, and auth requirements."
  }
  if (entry.warnings.staleRelayInfo) {
    return "Relay information is cached or seeded. Refresh to verify current capabilities."
  }
  return null
}

function getRelayCompatibilityText(entry: RelaySettingsPanelEntry): string {
  if (entry.warnings.unreachable) {
    return "Compatibility unknown because Conduit could not reach this relay."
  }
  if (entry.capabilities.commerce) {
    return "Commerce compatible. Conduit can prioritize this relay for products, stock, orders, and merchant messages."
  }
  if (entry.warnings.commercePartialSupport) {
    return "Commerce signals detected, but Conduit keeps this relay public until listing, protected-message, cleanup, and auth checks are complete."
  }
  if (entry.capabilities.nip11) {
    return "Public relay verified. Conduit can use it for general Nostr reads or writes when enabled."
  }
  if (entry.warnings.staleRelayInfo) {
    return "Compatibility has not been freshly verified. Refresh this relay to update detected capabilities."
  }
  return "Compatibility has not been scanned yet."
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
      return { label: "Published", variant: "success" }
    case "signer":
      return { label: "Signer", variant: "info" }
    case "manual":
      return { label: "Manual", variant: "info" }
    case "default":
    default:
      return { label: "Imported", variant: "neutral" }
  }
}

function CapabilityTooltip({
  label,
  description,
  children,
}: {
  label: string
  description: string
  children: ReactNode
}) {
  return (
    <span className="group/tooltip relative inline-flex rounded-md">
      {children}
      <span className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-64 max-w-[calc(100vw-3rem)] rounded-xl border border-[var(--border)] bg-[var(--surface-dialog)] px-3 py-2 text-left text-xs leading-5 text-[var(--text-secondary)] opacity-0 shadow-[var(--shadow-dialog)] transition-opacity group-focus-within/tooltip:opacity-100 group-hover/tooltip:opacity-100 sm:left-1/2 sm:-translate-x-1/2">
        <span className="block font-semibold text-[var(--text-primary)]">
          {label}
        </span>
        <span className="mt-1 block">{description}</span>
      </span>
    </span>
  )
}

function PreferenceToggle({
  label,
  active,
  disabled,
  tooltip,
  onToggle,
}: {
  label: "IN" | "OUT"
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
        "inline-flex h-9 w-9 items-center justify-center rounded-full border text-[0.68rem] font-semibold tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-primary-400 bg-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] text-[var(--primary-500)]"
          : "border-[var(--border-overlay)] bg-transparent text-[var(--text-secondary)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
      )}
    >
      {label}
    </button>
  )
}

function CapabilityIcon({
  active,
  icon: Icon,
  label,
  description,
  warning = false,
}: {
  active: boolean
  icon: typeof Search
  label: string
  description: string
  warning?: boolean
}) {
  return (
    <CapabilityTooltip label={label} description={description}>
      <span
        tabIndex={0}
        title={label}
        aria-label={`${label}: ${description}`}
        className={cn(
          "relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
          warning
            ? "text-[var(--warning)]"
            : active
              ? "text-[var(--success)]"
              : "text-[var(--text-secondary)]"
        )}
      >
        <Icon className="h-3 w-3" />
      </span>
    </CapabilityTooltip>
  )
}

function RelayRow({
  entry,
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
  const warningText = scanning ? null : getRelayWarningText(entry)
  const compatibilityText = getRelayCompatibilityText(entry)
  const isDisabled = entry.warnings.unreachable || scanning
  const isDefaultEntry = entry.source === "default"
  const draggable = section === "commerce" && !!onDropRelay
  const statusLabel = scanning ? "Checking" : getRelayStatusLabel(entry)
  const sourceMeta = getRelaySourceMeta(entry)
  const supportsProtectedMessages = hasProtectedMessageCapability(entry)
  const supportsCleanup = hasCleanupCapability(entry)

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
        "group flex flex-col gap-3 border-b border-[var(--border)] py-4 last:border-b-0 sm:flex-row sm:items-center lg:grid lg:grid-cols-[2rem_minmax(0,1fr)_7.25rem_10rem_5.75rem] lg:items-center",
        draggedUrl === entry.url && "opacity-55"
      )}
    >
      <div className="hidden items-center justify-center lg:flex">
        {draggable ? (
          <GripVertical
            className="h-4 w-4 cursor-grab text-[var(--text-muted)] active:cursor-grabbing"
            aria-label="Drag to change Conduit's commerce priority"
          />
        ) : null}
      </div>

      <div className="min-w-0 flex-1 rounded-2xl bg-[color-mix(in_srgb,var(--surface)_60%,transparent)] p-3 sm:bg-transparent sm:p-0 lg:bg-transparent lg:p-0">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "h-2.5 w-2.5 shrink-0 rounded-full",
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
              <span>{statusLabel}</span>
              <CapabilityTooltip
                label={
                  entry.capabilities.commerce
                    ? "Commerce compatible"
                    : "Public relay"
                }
                description={compatibilityText}
              >
                <StatusPill
                  variant={entry.capabilities.commerce ? "success" : "neutral"}
                  noIcon
                  className="cursor-default py-0.5 text-[0.68rem]"
                >
                  {entry.capabilities.commerce
                    ? "Commerce compatible"
                    : "Public relay"}
                </StatusPill>
              </CapabilityTooltip>
              {entry.relayName ? <span>{entry.relayName}</span> : null}
              <StatusPill
                variant={sourceMeta.variant}
                noIcon
                className="cursor-default py-0.5 text-[0.68rem]"
              >
                {sourceMeta.label}
              </StatusPill>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 sm:shrink-0 sm:justify-end lg:[display:contents]">
        <div className="flex items-center gap-1.5 lg:justify-center">
          <PreferenceToggle
            label="OUT"
            active={entry.writeEnabled}
            disabled={isDisabled}
            tooltip="Publish events to this relay."
            onToggle={() => onToggleWrite(entry.url, !entry.writeEnabled)}
          />
          <PreferenceToggle
            label="IN"
            active={entry.readEnabled}
            disabled={isDisabled}
            tooltip="Read events from this relay."
            onToggle={() => onToggleRead(entry.url, !entry.readEnabled)}
          />
        </div>

        <div className="h-5 w-px shrink-0 bg-[var(--border)] lg:hidden" />

        <div className="flex items-center gap-2.5 lg:flex-nowrap lg:justify-center">
          <CapabilityIcon
            active={entry.capabilities.search}
            icon={Search}
            label={
              entry.capabilities.search
                ? "Search supported"
                : "Search not advertised"
            }
            description={
              entry.capabilities.search
                ? `This relay advertises NIP-50 search. Conduit can use it for discovery and lookup when a route needs search behavior. ${compatibilityText}`
                : `This relay does not advertise NIP-50 search. Conduit can still read ordinary events here, but should not rely on it for product search or discovery. ${compatibilityText}`
            }
          />
          <CapabilityIcon
            active={supportsProtectedMessages}
            icon={Send}
            label={
              supportsProtectedMessages
                ? "Protected messages detected"
                : "Protected messages not detected"
            }
            description={
              supportsProtectedMessages
                ? `This relay advertises or is profiled for NIP-59 gift-wrap transport using kind 1059. Conduit can consider it for encrypted buyer and merchant message delivery. ${compatibilityText}`
                : `This relay has not shown NIP-59 gift-wrap transport support. Conduit should avoid depending on it for buyer and merchant message delivery. ${compatibilityText}`
            }
          />
          <CapabilityIcon
            active={entry.capabilities.auth || entry.warnings.dmWithoutAuth}
            icon={LockKeyhole}
            label={
              entry.warnings.dmWithoutAuth
                ? "Protected messages without auth"
                : entry.capabilities.auth
                  ? "Auth supported"
                  : "Auth not advertised"
            }
            description={
              entry.warnings.dmWithoutAuth
                ? `This relay has protected-message transport but does not advertise or require NIP-42 auth. Message content remains encrypted, but relay access controls may be weaker, so Conduit may limit protected messaging use here. ${compatibilityText}`
                : entry.capabilities.auth
                  ? `This relay advertises or requires NIP-42 authentication. Conduit can authenticate when a relay requires signed access for protected reads or writes. ${compatibilityText}`
                  : `This relay does not advertise NIP-42 authentication. Conduit can still use it for public reads or writes, but should avoid it for protected messaging paths. ${compatibilityText}`
            }
            warning={entry.warnings.dmWithoutAuth}
          />
          <CapabilityIcon
            active={supportsCleanup}
            icon={Eraser}
            label={
              supportsCleanup ? "Cleanup supported" : "Cleanup not detected"
            }
            description={
              supportsCleanup
                ? `This relay advertises or is profiled for cleanup support. Conduit can request NIP-09 deletion for product replacement cleanup, and may use NIP-62 vanish behavior when protected/private traces are in scope. ${compatibilityText}`
                : `This relay has not shown cleanup support. Conduit should not assume product deletion requests or private-trace cleanup behavior will be honored here. ${compatibilityText}`
            }
          />
          {(entry.warnings.unreachable ||
            entry.warnings.commercePartialSupport ||
            entry.warnings.staleRelayInfo) && (
            <CapabilityIcon
              active
              icon={entry.warnings.unreachable ? WifiOff : AlertTriangle}
              label={warningText ?? "Relay warning"}
              description={`${warningText ?? "Conduit detected a relay warning."} ${compatibilityText}`}
              warning
            />
          )}
        </div>

        <div className="h-5 w-px shrink-0 bg-[var(--border)] lg:hidden" />

        <div className="flex items-center gap-1.5 lg:justify-end">
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
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-overlay)] bg-[color-mix(in_srgb,var(--neutral-500)_10%,transparent)] text-[var(--text-secondary)] opacity-100 transition-colors hover:border-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)] hover:text-[var(--error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-[var(--border-overlay)] disabled:hover:bg-[color-mix(in_srgb,var(--neutral-500)_10%,transparent)] disabled:hover:text-[var(--text-secondary)] lg:opacity-0 lg:group-hover:opacity-100"
            aria-label={
              isDefaultEntry
                ? `${entry.url} is a default fallback`
                : `Remove ${entry.url}`
            }
            title={
              isDefaultEntry
                ? "Default fallbacks stay visible unless you edit them into your list."
                : "Remove relay"
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

function RelaySection({
  section,
  entries,
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

function DmInboxSection({
  relayUrls,
  defaultRelayUrls,
  publishedAt,
  loading,
  publishing,
  publishError,
  onPublishDefaultDmInbox,
}: {
  relayUrls: readonly string[]
  defaultRelayUrls: readonly string[]
  publishedAt: number | null
  loading: boolean
  publishing: boolean
  publishError: string | null
  onPublishDefaultDmInbox?: () => void | Promise<void>
}) {
  const [localPublishing, setLocalPublishing] = useState(false)
  const [publishSucceeded, setPublishSucceeded] = useState(false)
  const effectiveRelayUrls = relayUrls.length > 0 ? relayUrls : defaultRelayUrls
  const hasPublishedInbox = relayUrls.length > 0
  const relayFingerprint = relayUrls.join("|")

  useEffect(() => {
    setPublishSucceeded(false)
  }, [relayFingerprint])

  async function handlePublish(): Promise<void> {
    if (!onPublishDefaultDmInbox || publishing || localPublishing) return

    setLocalPublishing(true)
    setPublishSucceeded(false)
    try {
      await onPublishDefaultDmInbox()
      setPublishSucceeded(true)
    } catch {
      setPublishSucceeded(false)
    } finally {
      setLocalPublishing(false)
    }
  }

  return (
    <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--text-primary)]">
              Encrypted Order Inbox
            </h2>
            <StatusPill
              variant={hasPublishedInbox ? "success" : "neutral"}
              noIcon
              className="cursor-default py-0.5 text-[0.68rem]"
            >
              {hasPublishedInbox ? "Published" : "Not published"}
            </StatusPill>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
            This NIP-17 inbox is separate from your NIP-65 relay list and is
            used for encrypted buyer and merchant order messages.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {effectiveRelayUrls.map((url) => (
              <span
                key={url}
                className="max-w-full truncate rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-2.5 py-1 font-mono text-xs text-[var(--text-secondary)]"
                title={url}
              >
                {url}
              </span>
            ))}
          </div>
          {publishedAt ? (
            <div className="mt-2 text-xs text-[var(--text-muted)]">
              Published event timestamp {publishedAt}
            </div>
          ) : loading ? (
            <div className="mt-2 text-xs text-[var(--text-muted)]">
              Checking encrypted order inbox
            </div>
          ) : null}
        </div>

        {onPublishDefaultDmInbox ? (
          <Button
            type="button"
            variant="outline"
            disabled={
              publishing || localPublishing || defaultRelayUrls.length === 0
            }
            onClick={() => void handlePublish()}
            className="sm:mt-1"
          >
            <Upload className="h-4 w-4" />
            {publishing || localPublishing
              ? "Waiting for signer..."
              : hasPublishedInbox
                ? "Update inbox"
                : "Publish inbox"}
          </Button>
        ) : null}
      </div>

      {onPublishDefaultDmInbox ? (
        <SignedActionStatus
          state={
            publishing || localPublishing
              ? "awaiting_signature"
              : publishError
                ? "error"
                : publishSucceeded
                  ? "success"
                  : "idle"
          }
          awaitingSignatureMessage="Confirm the encrypted order inbox in your signer."
          successMessage="Encrypted order inbox signed and published."
          errorMessage={publishError ?? undefined}
          className="mt-4"
        />
      ) : null}
    </section>
  )
}

function RelayDiagnosticsSection({
  buckets,
}: {
  buckets: readonly RelaySettingsPanelBucket[]
}) {
  const visibleBuckets = buckets.filter((bucket) => bucket.relayUrls.length > 0)
  if (visibleBuckets.length === 0) return null

  return (
    <details className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
      <summary className="cursor-pointer text-sm font-semibold uppercase tracking-[0.2em] text-[var(--text-primary)]">
        Relay Diagnostics
      </summary>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
        App, fallback, search, DM, and zap relay buckets are planner
        infrastructure. They are not part of your personal NIP-65 relay list
        unless you add them above.
      </p>
      <div className="mt-4 space-y-4">
        {visibleBuckets.map((bucket) => (
          <div key={bucket.id}>
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              {bucket.label}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {bucket.relayUrls.map((url) => (
                <span
                  key={`${bucket.id}:${url}`}
                  className="max-w-full truncate rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-2.5 py-1 font-mono text-xs text-[var(--text-secondary)]"
                  title={url}
                >
                  {url}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  )
}

export function RelaySettingsPanel({
  settings,
  relayBuckets = [],
  scanningUrls = [],
  error,
  isLoadingPublishedRelayList = false,
  publishedRelayListUpdatedAt = null,
  publishingRelayList = false,
  publishError = null,
  dmInboxRelayUrls = [],
  dmInboxDefaultRelayUrls = [],
  dmInboxPublishedAt = null,
  dmInboxLoading = false,
  publishingDmInbox = false,
  dmInboxPublishError = null,
  onAddRelay,
  onRefreshRelay,
  onRemoveRelay,
  onToggleRead,
  onToggleWrite,
  onReorderCommerceRelay,
  onReset,
  onPublishRelayList,
  onPublishDefaultDmInbox,
  className,
}: RelaySettingsPanelProps) {
  const [newRelayUrl, setNewRelayUrl] = useState("")
  const [isAdding, setIsAdding] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [relayPublishSucceeded, setRelayPublishSucceeded] = useState(false)
  const [draggedUrl, setDraggedUrl] = useState<string | null>(null)
  const personalEntries = useMemo(
    () => settings.entries.filter((entry) => entry.source !== "default"),
    [settings.entries]
  )
  const commerceEntries = sortSectionEntries(personalEntries, "commerce")
  const publicEntries = sortSectionEntries(personalEntries, "public")
  const publishableEntries = personalEntries.filter(
    (entry) => entry.readEnabled || entry.writeEnabled
  )
  const activeRelayCount = publishableEntries.length
  const localActiveRelayCount = personalEntries.filter(
    (entry) => entry.readEnabled || entry.writeEnabled
  ).length
  const readRelayCount = publishableEntries.filter(
    (entry) => entry.readEnabled
  ).length
  const writeRelayCount = publishableEntries.filter(
    (entry) => entry.writeEnabled
  ).length
  const canPublishRelayList = activeRelayCount > 1 && writeRelayCount > 0
  const relaySettingsFingerprint = useMemo(
    () =>
      personalEntries
        .map((entry) =>
          [
            entry.url,
            entry.readEnabled ? "read" : "no-read",
            entry.writeEnabled ? "write" : "no-write",
          ].join(":")
        )
        .sort()
        .join("|"),
    [personalEntries]
  )

  useEffect(() => {
    setRelayPublishSucceeded(false)
  }, [relaySettingsFingerprint])

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

  async function handlePublishRelayList(): Promise<void> {
    if (!onPublishRelayList || isPublishing || publishingRelayList) return

    setIsPublishing(true)
    setRelayPublishSucceeded(false)
    try {
      await onPublishRelayList()
      setRelayPublishSucceeded(true)
    } catch {
      setRelayPublishSucceeded(false)
    } finally {
      setIsPublishing(false)
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
            <h1 className="font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
              Network Settings
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--text-secondary)]">
              Relays store and deliver data across the Nostr network.
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

        <RelaySection
          section="commerce"
          entries={commerceEntries}
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
          onRemoveRelay={onRemoveRelay}
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
          entries={publicEntries}
          scanningUrls={scanningUrls}
          draggedUrl={draggedUrl}
          onDragStart={setDraggedUrl}
          onDragEnd={() => setDraggedUrl(null)}
          onDropRelay={undefined}
          onRefreshRelay={(url) => void onRefreshRelay(url)}
          onRemoveRelay={onRemoveRelay}
          onToggleRead={onToggleRead}
          onToggleWrite={onToggleWrite}
        />

        {onPublishDefaultDmInbox || dmInboxRelayUrls.length > 0 ? (
          <DmInboxSection
            relayUrls={dmInboxRelayUrls}
            defaultRelayUrls={dmInboxDefaultRelayUrls}
            publishedAt={dmInboxPublishedAt}
            loading={dmInboxLoading}
            publishing={publishingDmInbox}
            publishError={dmInboxPublishError}
            onPublishDefaultDmInbox={onPublishDefaultDmInbox}
          />
        ) : null}

        <RelayDiagnosticsSection buckets={relayBuckets} />

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
          <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">
            Conduit automatically categorizes relays based on supported NIPs.
          </p>
          {error ? (
            <div className="mt-3 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
              {error}
            </div>
          ) : null}
        </form>

        {onReset || onPublishRelayList ? (
          <div className="space-y-3">
            {onPublishRelayList ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
                Publishing signs a NIP-65 event with {activeRelayCount} saved{" "}
                relay {activeRelayCount === 1 ? "tag" : "tags"}:{" "}
                {readRelayCount} IN, {writeRelayCount} OUT.
                {writeRelayCount === 0
                  ? " Enable OUT on at least one relay before publishing."
                  : " Signers may show empty content because relay URLs live in tags, and may auto-approve if this site already has signing permission."}
              </div>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              {onReset ? (
                <Button type="button" variant="ghost" onClick={onReset}>
                  Clear relay settings
                </Button>
              ) : null}
              {onPublishRelayList ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !canPublishRelayList ||
                    localActiveRelayCount === 0 ||
                    isLoadingPublishedRelayList ||
                    isPublishing ||
                    publishingRelayList
                  }
                  onClick={() => void handlePublishRelayList()}
                >
                  <Upload className="h-4 w-4" />
                  {isPublishing || publishingRelayList
                    ? "Waiting for signer..."
                    : "Publish relays"}
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
                      : relayPublishSucceeded
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
        ) : null}
      </div>
    </section>
  )
}
