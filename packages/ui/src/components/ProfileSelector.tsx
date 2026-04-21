import { ChevronDown, CircleUserRound, LogOut, Radio } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./DropdownMenu"
import { StatusPill, FilledWarningIcon } from "./StatusPill"
import { cn } from "../utils"

export interface ProfileSelectorProps {
  displayName: string
  avatarUrl?: string | null
  avatarFallback?: ReactNode
  statusLabel?: string
  alertLabel?: string
  className?: string
  onProfile?: () => void
  onNetwork?: () => void
  onDisconnect: () => void
}

function SelectorItem({
  icon,
  label,
  pill,
  onSelect,
  variant = "default",
}: {
  icon: ReactNode
  label: string
  pill?: ReactNode
  onSelect: () => void
  variant?: "default" | "danger" | "warning"
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn(
        "rounded-xl px-3 text-[15px] font-medium",
        pill ? "min-h-11 py-2" : "h-11",
        variant === "default" &&
          "text-[var(--text-primary)] focus:bg-[color-mix(in_srgb,var(--primary-500)_12%,transparent)] focus:text-[var(--text-primary)]",
        variant === "warning" &&
          "text-secondary-400 focus:bg-secondary-500/10 focus:text-secondary-300",
        variant === "danger" &&
          "text-tertiary-400 focus:bg-transparent focus:text-tertiary-400"
      )}
    >
      <span
        className={cn(
          "mr-3 inline-flex h-5 w-5 shrink-0 items-center justify-center",
          pill ? "self-start pt-[3px]" : "self-center"
        )}
      >
        {icon}
      </span>
      <span className="flex flex-col gap-1">
        <span>{label}</span>
        {pill}
      </span>
    </DropdownMenuItem>
  )
}

export function ProfileSelector({
  displayName,
  avatarUrl,
  avatarFallback,
  statusLabel = "Connected signer",
  alertLabel,
  className,
  onProfile,
  onNetwork,
  onDisconnect,
}: ProfileSelectorProps) {
  const [open, setOpen] = useState(false)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-12 min-w-[12.5rem] items-center gap-3 rounded-[18px] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary-400)_88%,var(--primary-500))_0%,color-mix(in_srgb,var(--primary-300)_76%,var(--tertiary-500)_24%)_100%)] px-3 text-left text-[var(--on-primary)] shadow-[0_10px_28px_color-mix(in_srgb,var(--primary-500)_28%,transparent),inset_0_1px_0_color-mix(in_srgb,var(--on-primary)_18%,transparent)] transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-400)]",
            className
          )}
        >
          {/* Avatar with optional warning badge overlay */}
          <div className="relative shrink-0">
            <Avatar className="h-8 w-8 border border-[color-mix(in_srgb,var(--on-primary)_20%,transparent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--on-primary)_8%,transparent)]">
              <AvatarImage src={avatarUrl ?? undefined} alt={displayName} />
              <AvatarFallback className="bg-[var(--avatar-bg)] text-[var(--on-primary)]">
                {avatarFallback ?? displayName.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {alertLabel && !open ? (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 text-[var(--warning)] drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
              >
                <FilledWarningIcon size={13} />
              </span>
            ) : null}
          </div>

          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
            {displayName}
          </span>

          <ChevronDown
            className={cn(
              "h-5 w-5 shrink-0 transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={10}
        style={{
          boxShadow: "0 0 0 1.5px var(--border-overlay), var(--shadow-dialog)",
        }}
        className="w-[15rem] rounded-[1.35rem] border-0 bg-[var(--surface-overlay)] p-0 backdrop-blur-xl"
      >
        <div className="rounded-t-[1.35rem] border-b border-[var(--border)] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary-400)_88%,var(--primary-500))_0%,color-mix(in_srgb,var(--primary-300)_76%,var(--tertiary-500)_24%)_100%)] px-4 py-3 text-[var(--on-primary)]">
          <div className="flex items-center gap-3">
            <Avatar className="h-8 w-8 border border-[color-mix(in_srgb,var(--on-primary)_20%,transparent)]">
              <AvatarImage src={avatarUrl ?? undefined} alt={displayName} />
              <AvatarFallback className="bg-[var(--avatar-bg)] text-[var(--on-primary)]">
                {avatarFallback ?? displayName.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
              {displayName}
            </span>
            <ChevronDown className="h-5 w-5 rotate-180" />
          </div>
        </div>

        <div className="p-3">
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
            <span className="h-2.5 w-2.5 rounded-full bg-success" />
            <span>{statusLabel}</span>
          </div>

          <DropdownMenuSeparator className="mx-0 my-2 bg-[var(--border)]" />

          {onProfile ? (
            <SelectorItem
              icon={<CircleUserRound className="h-4 w-4" />}
              label="Profile"
              pill={
                alertLabel ? (
                  <StatusPill
                    variant="warning"
                    iconSize={10}
                    className="text-[10px]"
                  >
                    {alertLabel}
                  </StatusPill>
                ) : undefined
              }
              onSelect={() => {
                setOpen(false)
                onProfile()
              }}
            />
          ) : null}

          {onNetwork ? (
            <SelectorItem
              icon={<Radio className="h-4 w-4" />}
              label="Network"
              onSelect={() => {
                setOpen(false)
                onNetwork()
              }}
            />
          ) : null}

          {onProfile || onNetwork ? (
            <DropdownMenuSeparator className="mx-0 my-2 bg-[var(--border)]" />
          ) : null}

          <SelectorItem
            icon={<LogOut className="h-4 w-4" />}
            label="Disconnect"
            onSelect={() => {
              setOpen(false)
              onDisconnect()
            }}
            variant="danger"
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
