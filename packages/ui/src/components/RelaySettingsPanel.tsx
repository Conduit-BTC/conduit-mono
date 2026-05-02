import {
  AlertTriangle,
  GripVertical,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
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
  onAddRelay: (url: string) => void | Promise<void>
  onRefreshRelay: (url: string) => void | Promise<void>
  onRemoveRelay: (url: string) => void
  onToggleRead: (url: string, enabled: boolean) => void
  onToggleWrite: (url: string, enabled: boolean) => void
  onReorderCommerceRelay: (sourceUrl: string, targetUrl: string) => void
  onReset?: () => void
  className?: string
}

function sortAllEntries(
  entries: readonly RelaySettingsPanelEntry[]
): RelaySettingsPanelEntry[] {
  return [...entries].sort((a, b) => {
    // Commerce first, ordered by priority; then public alphabetical.
    if (a.section !== b.section) {
      return a.section === "commerce" ? -1 : 1
    }
    if (a.section === "commerce") {
      const aPriority = a.commercePriority ?? Number.MAX_SAFE_INTEGER
      const bPriority = b.commercePriority ?? Number.MAX_SAFE_INTEGER
      if (aPriority !== bPriority) return aPriority - bPriority
    }
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
      <span className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-64 max-w-[calc(100vw-3rem)] rounded-lg border border-[var(--border)] bg-[var(--surface-dialog)] px-3 py-2 text-left text-xs leading-5 text-[var(--text-secondary)] opacity-0 shadow-[var(--shadow-dialog)] transition-opacity group-focus-within/tooltip:opacity-100 group-hover/tooltip:opacity-100 sm:left-1/2 sm:-translate-x-1/2">
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
        "inline-flex h-7 w-9 items-center justify-center rounded-md border text-[0.62rem] font-semibold tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40",
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
        aria-label={label}
        className={cn(
          "inline-flex h-6 w-6 items-center justify-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
          warning
            ? "border-warning/35 bg-warning/10 text-warning"
            : active
              ? "border-success/35 bg-success/10 text-success"
              : "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)]"
        )}
      >
        <Icon className="h-3 w-3" />
      </span>
    </CapabilityTooltip>
  )
}

function SectionTag({ section }: { section: RelaySettingsSection }) {
  const isCommerce = section === "commerce"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.55rem] font-semibold uppercase tracking-[0.14em]",
        isCommerce
          ? "border-primary-400/40 bg-primary-500/10 text-primary-200"
          : "border-accent-400/30 bg-accent-500/10 text-accent-200"
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          isCommerce ? "bg-primary-400" : "bg-accent-400"
        )}
        aria-hidden="true"
      />
      {isCommerce ? "Commerce" : "Public"}
    </span>
  )
}

function RelayRow({
  entry,
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
  scanning: boolean
  draggedUrl: string | null
  onDragStart: (url: string) => void
  onDragEnd: () => void
  onDropRelay: (sourceUrl: string, targetUrl: string) => void
  onRefreshRelay: (url: string) => void
  onRemoveRelay: (url: string) => void
  onToggleRead: (url: string, enabled: boolean) => void
  onToggleWrite: (url: string, enabled: boolean) => void
}) {
  const warningText = getRelayWarningText(entry)
  const compatibilityText = getRelayCompatibilityText(entry)
  const isDisabled = entry.warnings.unreachable || scanning
  const draggable = entry.section === "commerce"

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
    onDropRelay(sourceUrl, entry.url)
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
        "group grid min-w-0 gap-2 border-b border-[var(--border)]/60 px-3 py-2.5 last:border-b-0 lg:grid-cols-[1.25rem_minmax(0,1fr)_5.5rem_6.75rem_4.25rem] lg:items-center",
        draggedUrl === entry.url && "opacity-55"
      )}
    >
      <div className="hidden items-center justify-center lg:flex">
        {draggable ? (
          <GripVertical
            className="h-3.5 w-3.5 cursor-grab text-[var(--text-muted)] active:cursor-grabbing"
            aria-label="Drag to change Conduit's commerce priority"
          />
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              entry.section === "commerce" ? "bg-primary-400" : "bg-accent-400",
              (entry.warnings.unreachable || !entry.readEnabled) && "opacity-35"
            )}
            aria-hidden="true"
          />
          <div
            className={cn(
              "min-w-0 truncate font-mono text-[0.8rem] text-[var(--text-primary)]",
              entry.warnings.unreachable && "text-[var(--text-muted)]"
            )}
            title={entry.url}
          >
            {entry.url}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.7rem] text-[var(--text-muted)]">
          <SectionTag section={entry.section} />
          <span title={compatibilityText}>{getRelayStatusLabel(entry)}</span>
          {entry.relayName ? (
            <span className="truncate" title={entry.relayName}>
              {entry.relayName}
            </span>
          ) : null}
          {warningText ? (
            <span className="text-warning" title={warningText}>
              {warningText}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-1.5 lg:justify-center">
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

      <div className="flex min-w-0 items-center gap-1.5 lg:justify-center">
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
              ? `This relay advertises NIP-50 search. ${compatibilityText}`
              : `This relay does not advertise NIP-50 search. ${compatibilityText}`
          }
        />
        <CapabilityIcon
          active={entry.capabilities.dm}
          icon={Send}
          label={
            entry.capabilities.dm
              ? "DM support detected"
              : "DM support not advertised"
          }
          description={
            entry.capabilities.dm
              ? `This relay advertises NIP-17 support. ${compatibilityText}`
              : `This relay does not advertise NIP-17 support. ${compatibilityText}`
          }
        />
        <CapabilityIcon
          active={entry.capabilities.auth || entry.warnings.dmWithoutAuth}
          icon={LockKeyhole}
          label={
            entry.warnings.dmWithoutAuth
              ? "DM relay without auth"
              : "Auth supported"
          }
          description={
            entry.warnings.dmWithoutAuth
              ? `This relay advertises NIP-17 DMs but not NIP-42 auth. ${compatibilityText}`
              : entry.capabilities.auth
                ? `This relay advertises or requires NIP-42 authentication. ${compatibilityText}`
                : `This relay does not advertise NIP-42 authentication. ${compatibilityText}`
          }
          warning={entry.warnings.dmWithoutAuth}
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

      <div className="flex min-w-0 items-center gap-1 lg:justify-end">
        <button
          type="button"
          onClick={() => onRefreshRelay(entry.url)}
          disabled={scanning}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-wait disabled:opacity-50"
          aria-label={`Refresh ${entry.url}`}
          title="Refresh relay verification"
        >
          <RefreshCw className={cn("h-3 w-3", scanning && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={() => onRemoveRelay(entry.url)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 lg:opacity-0 lg:group-hover:opacity-100"
          aria-label={`Remove ${entry.url}`}
          title="Remove relay"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

export function RelaySettingsPanel({
  settings,
  scanningUrls = [],
  error,
  onAddRelay,
  onRefreshRelay,
  onRemoveRelay,
  onToggleRead,
  onToggleWrite,
  onReorderCommerceRelay,
  onReset,
  className,
}: RelaySettingsPanelProps) {
  const [newRelayUrl, setNewRelayUrl] = useState("")
  const [isAdding, setIsAdding] = useState(false)
  const [draggedUrl, setDraggedUrl] = useState<string | null>(null)
  const entries = sortAllEntries(settings.entries)
  const commerceCount = entries.filter((e) => e.section === "commerce").length

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
      data-testid="relay-settings-panel"
      className={cn(
        "rounded-2xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--background)_70%,var(--surface)_30%)] p-4 shadow-[var(--shadow-glass-inset)] sm:p-6",
        className
      )}
    >
      <div className="space-y-5">
        <header className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-xl font-semibold tracking-tight text-[var(--text-primary)]">
              Relays
            </h1>
            <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
              Conduit prioritizes commerce-capable relays for products and
              orders, and uses public relays for general reads and writes.
            </p>
          </div>
          {commerceCount > 1 ? (
            <span className="text-[0.65rem] uppercase tracking-[0.18em] text-[var(--text-muted)]">
              Drag commerce rows to reorder priority
            </span>
          ) : null}
        </header>

        <div
          data-testid="relay-settings-list"
          className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]"
        >
          {entries.length > 0 ? (
            entries.map((entry) => (
              <RelayRow
                key={entry.url}
                entry={entry}
                scanning={scanningUrls.includes(entry.url)}
                draggedUrl={draggedUrl}
                onDragStart={setDraggedUrl}
                onDragEnd={() => setDraggedUrl(null)}
                onDropRelay={(sourceUrl, targetUrl) => {
                  setDraggedUrl(null)
                  onReorderCommerceRelay(sourceUrl, targetUrl)
                }}
                onRefreshRelay={(url) => void onRefreshRelay(url)}
                onRemoveRelay={onRemoveRelay}
                onToggleRead={onToggleRead}
                onToggleWrite={onToggleWrite}
              />
            ))
          ) : (
            <div className="px-4 py-6 text-sm leading-6 text-[var(--text-muted)]">
              No relays configured. Add one below to get started.
            </div>
          )}
        </div>

        <form
          onSubmit={(event) => void handleAddRelay(event)}
          className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)]/60 p-3"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id="relay-url"
              value={newRelayUrl}
              onChange={(event) => setNewRelayUrl(event.target.value)}
              placeholder="wss://relay.example.com"
              aria-label="Add relay URL"
              className="h-9 rounded-md bg-[var(--surface-elevated)] font-mono text-sm"
            />
            <Button
              type="submit"
              disabled={isAdding || !newRelayUrl.trim()}
              className="h-9 rounded-md px-3 text-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              {isAdding ? "Checking..." : "Add"}
            </Button>
          </div>
          <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
            Conduit auto-categorizes relays based on advertised NIPs.
          </p>
          {error ? (
            <div className="mt-2 rounded-md border border-error/30 bg-error/10 px-2.5 py-1.5 text-xs text-error">
              {error}
            </div>
          ) : null}
        </form>

        {onReset ? (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={onReset}
              className="h-8 px-3 text-xs"
            >
              Reset to defaults
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
