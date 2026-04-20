import { type FormEvent, useState } from "react"
import { Badge } from "./Badge"
import { Button } from "./Button"
import { Input } from "./Input"
import { cn } from "../utils"

/**
 * Relay role within the Conduit commerce architecture.
 */
type RelayRole = "merchant" | "commerce" | "general"

interface RelayEntry {
  url: string
  role: RelayRole
  read: boolean
  write: boolean
}

type RelayGroupMap = Partial<Record<RelayRole, RelayEntry[]>>

export interface RelaySettingsPanelProps {
  /** Relay entries grouped by role. Only groups present are rendered. */
  groups: RelayGroupMap
  /** Called when the user adds a relay to a group. */
  onAddRelay: (role: RelayRole, url: string) => void
  /** Called when the user removes a relay from a group. */
  onRemoveRelay: (role: RelayRole, url: string) => void
  /** Called when the user changes read/write flags for a relay. */
  onUpdateRelay: (role: RelayRole, url: string, next: Pick<RelayEntry, "read" | "write">) => void
  /** Called when the user clicks "Reset to defaults". */
  onReset?: () => void
  /** Additional CSS class for the root element. */
  className?: string
}

function EntryToggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2 py-1 text-[10px] font-medium text-[var(--text-secondary)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3 w-3 accent-[var(--accent)]"
      />
      <span>{label}</span>
    </label>
  )
}

const ROLE_META: Record<RelayRole, { label: string; description: string }> = {
  merchant: {
    label: "Merchant relay",
    description: "Source of truth for your products and orders",
  },
  commerce: {
    label: "Commerce relay",
    description: "De-commerce relay for faster marketplace reads",
  },
  general: {
    label: "General relay",
    description: "Broader Nostr network for reach and fallback",
  },
}

const ROLE_ORDER: RelayRole[] = ["merchant", "commerce", "general"]

function RelayGroup({
  role,
  entries,
  onAdd,
  onRemove,
  onUpdate,
}: {
  role: RelayRole
  entries: RelayEntry[]
  onAdd: (url: string) => void
  onRemove: (url: string) => void
  onUpdate: (url: string, next: Pick<RelayEntry, "read" | "write">) => void
}) {
  const [newUrl, setNewUrl] = useState("")
  const meta = ROLE_META[role]

  function handleAdd(event: FormEvent): void {
    event.preventDefault()
    const trimmed = newUrl.trim()
    if (!trimmed) return
    onAdd(trimmed)
    setNewUrl("")
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">{meta.label}</h3>
          <Badge variant="outline" className="text-[10px]">
            {entries.length}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">{meta.description}</p>
      </div>

      {entries.length > 0 && (
        <ul className="space-y-1.5">
          {entries.map((entry) => (
            <li
              key={entry.url}
              className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-xs text-[var(--text-secondary)]">
                  {entry.url}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(entry.url)}
                  className="shrink-0 text-xs text-[var(--text-muted)] transition-colors hover:text-red-400"
                  aria-label={`Remove ${entry.url}`}
                >
                  Remove
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <EntryToggle
                  label="Read"
                  checked={entry.read}
                  onChange={(checked) => onUpdate(entry.url, { read: checked, write: entry.write })}
                />
                <EntryToggle
                  label="Write"
                  checked={entry.write}
                  onChange={(checked) => onUpdate(entry.url, { read: entry.read, write: checked })}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {entries.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
          No relays configured
        </div>
      )}

      <form onSubmit={handleAdd} className="flex gap-2">
        <Input
          type="url"
          placeholder="wss://..."
          value={newUrl}
          onChange={(event) => setNewUrl(event.target.value)}
          className="h-9 flex-1 font-mono text-xs"
        />
        <Button type="submit" variant="outline" className="h-9 shrink-0 px-3 text-xs">
          Add
        </Button>
      </form>
    </div>
  )
}

/**
 * Minimalist relay settings panel with role-grouped relay lists.
 *
 * Designed to be actor-aware: pass only the groups relevant to the actor.
 * - Merchant: merchant, commerce, general
 * - Shopper: commerce, general
 */
export function RelaySettingsPanel({
  groups,
  onAddRelay,
  onRemoveRelay,
  onUpdateRelay,
  onReset,
  className,
}: RelaySettingsPanelProps) {
  const visibleRoles = ROLE_ORDER.filter((role) => role in groups)

  return (
    <div className={cn("space-y-6", className)}>
      {visibleRoles.map((role) => (
        <RelayGroup
          key={role}
          role={role}
          entries={groups[role] ?? []}
          onAdd={(url) => onAddRelay(role, url)}
          onRemove={(url) => onRemoveRelay(role, url)}
          onUpdate={(url, next) => onUpdateRelay(role, url, next)}
        />
      ))}

      {onReset && (
        <div className="border-t border-[var(--border)] pt-4">
          <Button
            type="button"
            variant="outline"
            className="h-9 text-xs"
            onClick={onReset}
          >
            Reset to defaults
          </Button>
        </div>
      )}
    </div>
  )
}
