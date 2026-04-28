import {
  AlertTriangle,
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
import { type DragEvent, type FormEvent, type ReactNode, useState } from "react"
import { Button } from "./Button"
import { Input } from "./Input"
import { cn } from "../utils"

type RelaySettingsSection = "commerce" | "public"

interface RelayCapabilities {
  nip11: boolean
  search: boolean
  dm: boolean
  auth: boolean
  commerce: boolean
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

export interface RelaySettingsPanelProps {
  settings: RelaySettingsPanelState
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
    label: "Commerce Enabled Relays",
    description:
      "Relays that Conduit can use for commerce events like products, stock updates, orders, and merchant messages.",
    labelClassName: "text-primary-300",
    dotClassName: "bg-primary-400",
    surfaceClassName:
      "bg-[radial-gradient(circle_at_top_left,color-mix(in_srgb,var(--primary-500)_16%,transparent),transparent_38%),color-mix(in_srgb,var(--surface)_88%,var(--background)_12%)]",
    empty:
      "No verified commerce relays yet. Add a relay and Conduit will verify whether it belongs here.",
  },
  public: {
    label: "Other Public Relays",
    description:
      "General Nostr relays used for broader network reading, publishing, and discovery.",
    labelClassName: "text-accent-300",
    dotClassName: "bg-accent-400",
    surfaceClassName:
      "bg-[radial-gradient(circle_at_top_left,color-mix(in_srgb,var(--accent-500)_13%,transparent),transparent_38%),color-mix(in_srgb,var(--surface)_88%,var(--background)_12%)]",
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
    return "DM relay without auth. Conduit may limit DM use here because access controls may be weaker."
  }
  if (entry.warnings.commercePartialSupport) {
    return "Some commerce signals were detected, but this relay does not meet the full commerce profile."
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
    return "Partial commerce signals detected. Conduit keeps this relay public until full commerce checks pass."
  }
  if (entry.capabilities.nip11) {
    return "Public relay verified. Conduit can use it for general Nostr reads or writes when enabled."
  }
  if (entry.warnings.staleRelayInfo) {
    return "Compatibility has not been freshly verified. Refresh this relay to update detected capabilities."
  }
  return "Compatibility has not been scanned yet."
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
    <span className="group/tooltip relative inline-flex">
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
          ? "border-primary-400/60 bg-primary-500/20 text-primary-100"
          : "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
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
  shortLabel,
  description,
  warning = false,
}: {
  active: boolean
  icon: typeof Search
  label: string
  shortLabel: string
  description: string
  warning?: boolean
}) {
  return (
    <CapabilityTooltip label={label} description={description}>
      <span className="inline-flex flex-col items-center gap-1">
        <span
          tabIndex={0}
          title={label}
          aria-label={label}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-full border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
            warning
              ? "border-warning/35 bg-warning/10 text-warning"
              : active
                ? "border-success/35 bg-success/10 text-success"
                : "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)]"
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="hidden text-[0.56rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] lg:block">
          {shortLabel}
        </span>
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
  const warningText = getRelayWarningText(entry)
  const compatibilityText = getRelayCompatibilityText(entry)
  const isDisabled = entry.warnings.unreachable || scanning
  const draggable = section === "commerce" && !!onDropRelay

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
        "group grid min-w-0 gap-3 border-b border-[var(--border)] py-4 last:border-b-0 lg:grid-cols-[2rem_minmax(0,1fr)_7.25rem_10rem_5.75rem] lg:items-center",
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

      <div className="min-w-0 rounded-2xl bg-[color-mix(in_srgb,var(--surface)_60%,transparent)] p-3 lg:bg-transparent lg:p-0">
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
              <span>{getRelayStatusLabel(entry)}</span>
              <span
                className="rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-2 py-0.5"
                title={compatibilityText}
              >
                {entry.capabilities.commerce
                  ? "Commerce compatible"
                  : entry.warnings.commercePartialSupport
                    ? "Partial commerce"
                    : "Public relay"}
              </span>
              {entry.relayName ? <span>{entry.relayName}</span> : null}
              {warningText ? (
                <span className="text-warning" title={warningText}>
                  {warningText}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 lg:[display:contents]">
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

        <div className="flex items-center gap-1.5 lg:flex-nowrap lg:justify-center">
          <CapabilityIcon
            active={entry.capabilities.search}
            icon={Search}
            shortLabel="Search"
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
            active={entry.capabilities.dm}
            icon={Send}
            shortLabel="DM"
            label={
              entry.capabilities.dm
                ? "DM support detected"
                : "DM support not advertised"
            }
            description={
              entry.capabilities.dm
                ? `This relay advertises NIP-17 support. Conduit can consider it for modern encrypted buyer and merchant message delivery. ${compatibilityText}`
                : `This relay does not advertise NIP-17 support. Conduit should avoid depending on it for buyer and merchant message delivery. ${compatibilityText}`
            }
          />
          <CapabilityIcon
            active={entry.capabilities.auth || entry.warnings.dmWithoutAuth}
            icon={LockKeyhole}
            shortLabel="Auth"
            label={
              entry.warnings.dmWithoutAuth
                ? "DM relay without auth"
                : "Auth supported"
            }
            description={
              entry.warnings.dmWithoutAuth
                ? `This relay advertises NIP-17 DMs but not NIP-42 auth. Message content remains encrypted, but relay access controls may be weaker, so Conduit may limit protected messaging use here. ${compatibilityText}`
                : entry.capabilities.auth
                  ? `This relay advertises or requires NIP-42 authentication. Conduit can authenticate when a relay requires signed access for protected reads or writes. ${compatibilityText}`
                  : `This relay does not advertise NIP-42 authentication. Conduit can still use it for public reads or writes, but should avoid it for protected messaging paths. ${compatibilityText}`
            }
            warning={entry.warnings.dmWithoutAuth}
          />
          {(entry.warnings.unreachable ||
            entry.warnings.commercePartialSupport ||
            entry.warnings.staleRelayInfo) && (
            <CapabilityIcon
              active
              icon={entry.warnings.unreachable ? WifiOff : AlertTriangle}
              shortLabel="Warn"
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
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-wait disabled:opacity-50"
            aria-label={`Refresh ${entry.url}`}
            title="Refresh relay verification"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", scanning && "animate-spin")}
            />
          </button>
          <button
            type="button"
            onClick={() => onRemoveRelay(entry.url)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)] opacity-100 transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 lg:opacity-0 lg:group-hover:opacity-100"
            aria-label={`Remove ${entry.url}`}
            title="Remove relay"
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

export function RelaySettingsPanel({
  settings,
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
  className,
}: RelaySettingsPanelProps) {
  const [newRelayUrl, setNewRelayUrl] = useState("")
  const [isAdding, setIsAdding] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [draggedUrl, setDraggedUrl] = useState<string | null>(null)
  const commerceEntries = sortSectionEntries(settings.entries, "commerce")
  const publicEntries = sortSectionEntries(settings.entries, "public")
  const activeRelayCount = settings.entries.filter(
    (entry) => entry.readEnabled || entry.writeEnabled
  ).length
  const publishedLabel = publishedRelayListUpdatedAt
    ? `Published relays loaded ${new Date(
        publishedRelayListUpdatedAt * 1000
      ).toLocaleDateString()}`
    : isLoadingPublishedRelayList
      ? "Checking published relays"
      : "Local relay changes"

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
    try {
      await onPublishRelayList()
    } finally {
      setIsPublishing(false)
    }
  }

  return (
    <section
      className={cn(
        "rounded-[2.25rem] border border-[var(--border)] bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary-500)_14%,transparent),transparent_35%),linear-gradient(white,white)] p-5 shadow-[var(--shadow-dialog)] sm:p-8",
        className
      )}
    >
      <div className="space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
              Network
            </div>
            <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
              Relay Settings
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--text-secondary)]">
              Relays store and deliver data across the Nostr network.
            </p>
          </div>
          <div className="flex flex-col items-start gap-1 pt-1 sm:items-end">
            <span className="text-[0.65rem] uppercase tracking-[0.18em] text-[var(--text-muted)]">
              {publishedLabel}
            </span>
          </div>
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
          <div className="flex flex-wrap justify-end gap-2">
            {onReset ? (
              <Button type="button" variant="ghost" onClick={onReset}>
                {onPublishRelayList ? "Reset local draft" : "Reset to defaults"}
              </Button>
            ) : null}
            {onPublishRelayList ? (
              <Button
                type="button"
                variant="outline"
                disabled={
                  activeRelayCount <= 1 ||
                  isLoadingPublishedRelayList ||
                  isPublishing ||
                  publishingRelayList
                }
                onClick={() => void handlePublishRelayList()}
              >
                <Upload className="h-4 w-4" />
                {isPublishing || publishingRelayList
                  ? "Publishing..."
                  : "Publish relays"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {publishError ? (
          <div className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {publishError}
          </div>
        ) : null}
      </div>
    </section>
  )
}
