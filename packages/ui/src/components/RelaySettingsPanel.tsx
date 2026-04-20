import { Plus } from "lucide-react"
import { type FormEvent, useMemo, useState } from "react"
import { Button } from "./Button"
import { Input } from "./Input"
import { cn } from "../utils"

type RelayRole = "merchant" | "commerce" | "general"
type RelaySource = "app" | "signer" | "custom"

interface RelayEntry {
  url: string
  role: RelayRole
  source: RelaySource
  out: boolean
  in: boolean
  find: boolean
  dm: boolean
}

type RelayGroupMap = Partial<Record<RelayRole, RelayEntry[]>>

export interface RelaySettingsPanelProps {
  groups: RelayGroupMap
  onAddRelay: (role: RelayRole, url: string) => void
  onRemoveRelay: (role: RelayRole, url: string) => void
  onUpdateRelay: (
    role: RelayRole,
    url: string,
    next: Pick<RelayEntry, "out" | "in" | "find" | "dm">
  ) => void
  onReset?: () => void
  className?: string
}

const ROLE_META: Record<RelayRole, {
  eyebrow: string
  title: string
  description: string
  tint: string
  border: string
  dot: string
  addLabel: string
}> = {
  merchant: {
    eyebrow: "MY RELAYS",
    title: "Your source of truth",
    description: "Merchant relays carry your canonical products, orders, and account state.",
    tint: "bg-primary-500/5",
    border: "border-primary-500/20",
    dot: "bg-primary-500",
    addLabel: "Add relay to My Relays...",
  },
  commerce: {
    eyebrow: "COMMERCE RELAYS",
    title: "Used for marketplace and transaction events",
    description: "Conduit and commerce relays accelerate storefront, order, and transaction traffic.",
    tint: "bg-secondary-500/5",
    border: "border-secondary-500/20",
    dot: "bg-secondary-500",
    addLabel: "Add relay to Commerce...",
  },
  general: {
    eyebrow: "PUBLIC RELAYS",
    title: "General network access and discovery",
    description: "General relays come from your signer, with app fallbacks when needed for discovery and messaging.",
    tint: "bg-tertiary-500/5",
    border: "border-tertiary-500/15",
    dot: "bg-tertiary-500",
    addLabel: "Add relay to Public...",
  },
}

function PurposePill({
  label,
  active,
  accentClass,
  onToggle,
}: {
  label: string
  active: boolean
  accentClass: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "h-7 min-w-8 rounded-lg border text-[9px] font-medium tracking-[0.18em] transition-colors",
        active
          ? `${accentClass} text-white`
          : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
      )}
    >
      {label}
    </button>
  )
}

function RelayRow({
  entry,
  accentClass,
  dotClass,
  onRemove,
  onUpdate,
}: {
  entry: RelayEntry
  accentClass: string
  dotClass: string
  onRemove: () => void
  onUpdate: (next: Pick<RelayEntry, "out" | "in" | "find" | "dm">) => void
}) {
  const isMuted = !entry.out && !entry.in && !entry.find && !entry.dm

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", isMuted ? "bg-[var(--text-muted)]" : dotClass)} />
        <div className="min-w-0 flex-1">
          <div className={cn(
            "truncate font-mono text-[11px]",
            isMuted ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]",
          )}>
            {entry.url}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <PurposePill
              label="OUT"
              active={entry.out}
              accentClass={accentClass}
              onToggle={() => onUpdate({ ...entry, out: !entry.out })}
            />
            <PurposePill
              label="IN"
              active={entry.in}
              accentClass={accentClass}
              onToggle={() => onUpdate({ ...entry, in: !entry.in })}
            />
            <PurposePill
              label="FIND"
              active={entry.find}
              accentClass={accentClass}
              onToggle={() => onUpdate({ ...entry, find: !entry.find })}
            />
            <PurposePill
              label="DM"
              active={entry.dm}
              accentClass={accentClass}
              onToggle={() => onUpdate({ ...entry, dm: !entry.dm })}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          {entry.source === "custom" ? "Remove" : "Hide"}
        </button>
      </div>
      <div className="h-px bg-[var(--border)]/40" />
    </div>
  )
}

function RelaySection({
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
  onUpdate: (url: string, next: Pick<RelayEntry, "out" | "in" | "find" | "dm">) => void
}) {
  const [newUrl, setNewUrl] = useState("")
  const meta = ROLE_META[role]
  const accentClass = useMemo(() => {
    if (role === "merchant") return "border-primary-500/40 bg-primary-500/15"
    if (role === "commerce") return "border-secondary-500/40 bg-secondary-500/15"
    return "border-tertiary-500/40 bg-tertiary-500/15"
  }, [role])

  function handleSubmit(event: FormEvent): void {
    event.preventDefault()
    const trimmed = newUrl.trim()
    if (!trimmed) return
    onAdd(trimmed)
    setNewUrl("")
  }

  return (
    <section className="space-y-3">
      <div>
        <div className="text-[11px] font-semibold tracking-[0.22em] text-[var(--text-muted)]">
          {meta.eyebrow}
        </div>
        <div className="mt-1 text-[12px] text-[var(--text-secondary)]">{meta.title}</div>
      </div>

      <div className={cn("rounded-2xl border p-4", meta.tint, meta.border)}>
        <div className="space-y-3">
          {entries.length > 0 ? entries.map((entry) => (
            <RelayRow
              key={entry.url}
              entry={entry}
              accentClass={accentClass}
              dotClass={meta.dot}
              onRemove={() => onRemove(entry.url)}
              onUpdate={(next) => onUpdate(entry.url, next)}
            />
          )) : (
            <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-[11px] text-[var(--text-muted)]">
              No relays configured in this section.
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-2 pt-1">
            <Input
              type="url"
              placeholder="wss://..."
              value={newUrl}
              onChange={(event) => setNewUrl(event.target.value)}
              className="h-10 border-[var(--border)] bg-[var(--surface)] font-mono text-xs"
            />
            <Button type="submit" variant="ghost" className="h-8 justify-start px-0 text-xs text-[var(--text-secondary)] hover:bg-transparent hover:text-[var(--text-primary)]">
              <Plus className="h-4 w-4" />
              {meta.addLabel}
            </Button>
          </form>
        </div>
      </div>
    </section>
  )
}

export function RelaySettingsPanel({
  groups,
  onAddRelay,
  onRemoveRelay,
  onUpdateRelay,
  onReset,
  className,
}: RelaySettingsPanelProps) {
  const roles = (["merchant", "commerce", "general"] as const).filter((role) => role in groups)

  return (
    <div className={cn("space-y-6", className)}>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">Relay Settings</h1>
        <p className="max-w-[38rem] text-xs leading-6 text-[var(--text-secondary)]">
          These relays are used across your accounts. Roles determine how each relay is used.
        </p>
      </div>

      {roles.map((role) => (
        <RelaySection
          key={role}
          role={role}
          entries={groups[role] ?? []}
          onAdd={(url) => onAddRelay(role, url)}
          onRemove={(url) => onRemoveRelay(role, url)}
          onUpdate={(url, next) => onUpdateRelay(role, url, next)}
        />
      ))}

      {onReset && (
        <div className="pt-2">
          <Button type="button" variant="outline" className="border-white/10 bg-white/3 text-xs" onClick={onReset}>
            Reset to defaults
          </Button>
        </div>
      )}
    </div>
  )
}
