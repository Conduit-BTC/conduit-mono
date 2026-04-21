import { ArrowDown, ArrowUp, Plus, Search, Send, X } from "lucide-react"
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
  onClose?: () => void
  className?: string
}

const ROLE_META: Record<
  RelayRole,
  {
    eyebrow: string
    title: string
    surface: string
    border: string
    dot: string
    accentText: string
    addText: string
    addLabel: string
  }
> = {
  merchant: {
    eyebrow: "MY RELAYS",
    title: "Your source of truth",
    surface:
      "bg-[color-mix(in_srgb,var(--background)_76%,var(--primary-950)_24%)]",
    border: "border-primary-500/20",
    dot: "bg-primary-500",
    accentText: "text-primary-400",
    addText: "text-primary-400 hover:text-primary-300",
    addLabel: "Add relay to My Relays...",
  },
  commerce: {
    eyebrow: "COMMERCE RELAYS",
    title: "Used for marketplace and transaction events",
    surface:
      "bg-[color-mix(in_srgb,var(--background)_78%,var(--secondary-950)_22%)]",
    border: "border-secondary-500/18",
    dot: "bg-secondary-500",
    accentText: "text-secondary-400",
    addText: "text-secondary-400 hover:text-secondary-300",
    addLabel: "Add relay to Commerce...",
  },
  general: {
    eyebrow: "PUBLIC RELAYS",
    title: "General network access and discovery",
    surface:
      "bg-[color-mix(in_srgb,var(--background)_78%,var(--tertiary-950)_22%)]",
    border: "border-tertiary-500/16",
    dot: "bg-tertiary-500",
    accentText: "text-tertiary-400",
    addText: "text-tertiary-400 hover:text-tertiary-300",
    addLabel: "Add relay to Public...",
  },
}

const PURPOSE_META = [
  { key: "out", label: "OUT", icon: ArrowUp },
  { key: "in", label: "IN", icon: ArrowDown },
  { key: "find", label: "FIND", icon: Search },
  { key: "dm", label: "DM", icon: Send },
] as const

function PurposeButton({
  active,
  title,
  icon: Icon,
  activeClass,
  inactiveClass,
  onToggle,
}: {
  active: boolean
  title: string
  icon: typeof ArrowUp
  activeClass: string
  inactiveClass: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-full border transition-[color,background-color,border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
        active ? activeClass : inactiveClass
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

function RelayRow({
  entry,
  activeClass,
  inactiveClass,
  dotClass,
  onRemove,
  onUpdate,
}: {
  entry: RelayEntry
  activeClass: string
  inactiveClass: string
  dotClass: string
  onRemove: () => void
  onUpdate: (next: Pick<RelayEntry, "out" | "in" | "find" | "dm">) => void
}) {
  const isMuted = !entry.out && !entry.in && !entry.find && !entry.dm

  return (
    <div className="group relative border-b border-white/6 py-4 last:border-b-0">
      <div className="grid grid-cols-[minmax(0,1fr)_repeat(4,1.75rem)_2rem] items-center gap-3">
        <div className="flex min-w-0 items-center gap-4 pr-2">
          <span
            className={cn(
              "h-3 w-3 shrink-0 rounded-full",
              isMuted ? "bg-white/15" : dotClass
            )}
          />
          <span
            className={cn(
              "truncate font-mono text-[0.95rem] tracking-[0.01em] sm:text-[1.05rem]",
              isMuted
                ? "text-[var(--text-muted)]"
                : "text-[var(--text-primary)]"
            )}
          >
            {entry.url}
          </span>
        </div>

        <PurposeButton
          title="Publish writes"
          icon={ArrowUp}
          active={entry.out}
          activeClass={activeClass}
          inactiveClass={inactiveClass}
          onToggle={() => onUpdate({ ...entry, out: !entry.out })}
        />
        <PurposeButton
          title="Active pooled reads"
          icon={ArrowDown}
          active={entry.in}
          activeClass={activeClass}
          inactiveClass={inactiveClass}
          onToggle={() => onUpdate({ ...entry, in: !entry.in })}
        />
        <PurposeButton
          title="Discovery reads"
          icon={Search}
          active={entry.find}
          activeClass={activeClass}
          inactiveClass={inactiveClass}
          onToggle={() => onUpdate({ ...entry, find: !entry.find })}
        />
        <PurposeButton
          title="Protected conversation reads"
          icon={Send}
          active={entry.dm}
          activeClass={activeClass}
          inactiveClass={inactiveClass}
          onToggle={() => onUpdate({ ...entry, dm: !entry.dm })}
        />

        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] opacity-0 transition-[opacity,color,background-color] hover:bg-white/5 hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
          title={entry.source === "custom" ? "Remove relay" : "Hide relay"}
          aria-label={entry.source === "custom" ? "Remove relay" : "Hide relay"}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
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
  onUpdate: (
    url: string,
    next: Pick<RelayEntry, "out" | "in" | "find" | "dm">
  ) => void
}) {
  const [newUrl, setNewUrl] = useState("")
  const [isAdding, setIsAdding] = useState(false)
  const meta = ROLE_META[role]
  const inactiveClass = "border-white/8 bg-white/[0.03] text-white/80"
  const activeClass = useMemo(() => {
    if (role === "merchant") {
      return "border-primary-400/40 bg-primary-500/15 text-primary-200"
    }
    if (role === "commerce") {
      return "border-secondary-400/40 bg-secondary-500/15 text-secondary-200"
    }
    return "border-tertiary-400/40 bg-tertiary-500/15 text-tertiary-200"
  }, [role])

  function handleSubmit(event: FormEvent): void {
    event.preventDefault()
    const trimmed = newUrl.trim()
    if (!trimmed) return
    onAdd(trimmed)
    setNewUrl("")
    setIsAdding(false)
  }

  return (
    <section className="space-y-4">
      <div>
        <div
          className={cn(
            "text-[1rem] font-semibold tracking-[0.03em]",
            meta.accentText
          )}
        >
          {meta.eyebrow}
        </div>
        <div className="mt-1 text-[1rem] text-[var(--text-secondary)]">
          {meta.title}
        </div>
      </div>

      <div
        className={cn(
          "rounded-[2rem] border px-6 py-5 shadow-[inset_0_1px_0_color-mix(in_srgb,white_4%,transparent)]",
          meta.surface,
          meta.border
        )}
      >
        <div className="mb-3 grid grid-cols-[minmax(0,1fr)_repeat(4,1.75rem)_2rem] items-center gap-3">
          <div />
          {PURPOSE_META.map((purpose) => (
            <div
              key={purpose.key}
              className="text-center text-[0.62rem] font-medium tracking-[0.16em] text-[var(--text-muted)]"
            >
              {purpose.label}
            </div>
          ))}
          <div />
        </div>

        <div>
          {entries.length > 0 ? (
            entries.map((entry) => (
              <RelayRow
                key={entry.url}
                entry={entry}
                activeClass={activeClass}
                inactiveClass={inactiveClass}
                dotClass={meta.dot}
                onRemove={() => onRemove(entry.url)}
                onUpdate={(next) => onUpdate(entry.url, next)}
              />
            ))
          ) : (
            <div className="border-b border-white/6 py-4 text-[0.95rem] text-[var(--text-muted)]">
              No relays configured in this section yet.
            </div>
          )}

          {isAdding ? (
            <form
              onSubmit={handleSubmit}
              className="flex flex-col gap-3 pt-5 sm:flex-row"
            >
              <Input
                type="url"
                placeholder="wss://relay.example.com"
                value={newUrl}
                onChange={(event) => setNewUrl(event.target.value)}
                className="h-12 rounded-2xl border-white/10 bg-[color-mix(in_srgb,var(--background)_78%,var(--surface)_22%)] font-mono text-sm"
              />
              <div className="flex gap-2">
                <Button type="submit" className="h-12 rounded-2xl px-5">
                  Add
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-12 rounded-2xl px-4 text-[var(--text-secondary)] hover:bg-white/5"
                  onClick={() => {
                    setNewUrl("")
                    setIsAdding(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setIsAdding(true)}
              className={cn(
                "mt-3 inline-flex items-center gap-3 text-[1rem] font-medium transition-colors",
                meta.addText
              )}
            >
              <Plus className="h-5 w-5" />
              {meta.addLabel}
            </button>
          )}
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
  onClose,
  className,
}: RelaySettingsPanelProps) {
  const roles = (["merchant", "commerce", "general"] as const).filter(
    (role) => role in groups
  )

  return (
    <section
      className={cn(
        "rounded-[2.25rem] border border-white/8 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary-500)_8%,transparent),transparent_32%),linear-gradient(180deg,color-mix(in_srgb,var(--background)_90%,var(--surface)_10%),color-mix(in_srgb,var(--background)_94%,black_6%))] px-5 py-6 shadow-[var(--shadow-dialog)] sm:px-8 sm:py-8",
        className
      )}
    >
      <div className="space-y-8">
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-white/8 bg-[color-mix(in_srgb,var(--surface)_75%,transparent)]">
                <img
                  src="/images/logo/logo-icon.svg"
                  alt=""
                  aria-hidden="true"
                  className="h-6 w-6 brightness-0 invert"
                />
              </span>
              <h1 className="text-[1.9rem] font-semibold tracking-tight text-[var(--text-primary)] sm:text-[2.25rem]">
                Relay Settings
              </h1>
            </div>

            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/8 bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                aria-label="Close relay settings"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          <p className="max-w-[44rem] text-[1rem] leading-8 text-[var(--text-secondary)] sm:text-[1.05rem]">
            These relays are used across your accounts. Roles determine how each
            relay is used.
          </p>
        </div>

        <div className="space-y-8">
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
        </div>

        {onReset ? (
          <div className="pt-2">
            <Button
              type="button"
              variant="ghost"
              className="px-0 text-sm text-[var(--text-secondary)] hover:bg-transparent hover:text-[var(--text-primary)]"
              onClick={onReset}
            >
              Reset to defaults
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
