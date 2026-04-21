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
  onSelect,
  variant = "default",
}: {
  icon: ReactNode
  label: string
  onSelect: () => void
  variant?: "default" | "danger" | "warning"
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn(
        "h-11 rounded-xl px-3 text-[15px] font-medium",
        variant === "default" &&
          "text-[var(--text-primary)] focus:bg-[color-mix(in_srgb,var(--primary-500)_12%,transparent)] focus:text-[var(--text-primary)]",
        variant === "warning" &&
          "text-secondary-400 focus:bg-secondary-500/10 focus:text-secondary-300",
        variant === "danger" &&
          "text-tertiary-400 focus:bg-transparent focus:text-tertiary-400"
      )}
    >
      <span className="mr-3 inline-flex h-5 w-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span>{label}</span>
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
            "inline-flex h-12 min-w-[12.5rem] items-center gap-3 rounded-[18px] border border-primary-400/35 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary-400)_88%,var(--primary-500))_0%,color-mix(in_srgb,var(--primary-300)_76%,var(--tertiary-500)_24%)_100%)] px-3 text-left text-white shadow-[0_10px_28px_color-mix(in_srgb,var(--primary-500)_28%,transparent),inset_0_1px_0_color-mix(in_srgb,white_18%,transparent)] transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400",
            className
          )}
        >
          <Avatar className="h-8 w-8 border border-white/20 shadow-[0_0_0_1px_color-mix(in_srgb,white_8%,transparent)]">
            <AvatarImage src={avatarUrl ?? undefined} alt={displayName} />
            <AvatarFallback className="bg-[color-mix(in_srgb,var(--primary-900)_78%,black)] text-white">
              {avatarFallback ?? displayName.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
            {displayName}
          </span>
          <div className="flex items-center gap-2">
            {alertLabel ? (
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-secondary-300/40 bg-secondary-500 text-secondary-50 shadow-[inset_0_1px_0_color-mix(in_srgb,white_24%,transparent)]">
                !
              </span>
            ) : null}
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                open && "rotate-180"
              )}
            />
          </div>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={10}
        className="w-[15rem] rounded-[1.35rem] border border-primary-400/20 bg-[color-mix(in_srgb,var(--background)_18%,var(--primary-950)_82%)] p-0 shadow-[0_28px_60px_color-mix(in_srgb,black_56%,transparent)] backdrop-blur-xl"
      >
        <div className="border-b border-white/8 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary-400)_88%,var(--primary-500))_0%,color-mix(in_srgb,var(--primary-300)_76%,var(--tertiary-500)_24%)_100%)] px-4 py-3 text-white">
          <div className="flex items-center gap-3">
            <Avatar className="h-8 w-8 border border-white/20">
              <AvatarImage src={avatarUrl ?? undefined} alt={displayName} />
              <AvatarFallback className="bg-[color-mix(in_srgb,var(--primary-900)_78%,black)] text-white">
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

          <DropdownMenuSeparator className="mx-0 my-2 bg-white/8" />

          {alertLabel ? (
            <>
              <SelectorItem
                icon={<span className="text-lg leading-none">!</span>}
                label={alertLabel}
                onSelect={() => setOpen(false)}
                variant="warning"
              />
              <DropdownMenuSeparator className="mx-0 my-2 bg-white/8" />
            </>
          ) : null}

          {onProfile ? (
            <SelectorItem
              icon={<CircleUserRound className="h-4 w-4" />}
              label="Profile"
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
            <DropdownMenuSeparator className="mx-0 my-2 bg-white/8" />
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
