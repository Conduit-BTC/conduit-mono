import { ChevronDown, LogOut, RadioTower, UserRound } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar"
import { Button } from "./Button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./Dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./DropdownMenu"
import { cn } from "../utils"

export interface AccountMenuProps {
  displayName: string
  pubkeyLabel: string
  avatarUrl?: string | null
  statusLabel?: string
  variant?: "compact" | "panel"
  fallback?: ReactNode
  onProfile: () => void
  onNetwork: () => void
  onDisconnect: () => void
  className?: string
}

export function AccountMenu({
  displayName,
  pubkeyLabel,
  avatarUrl,
  statusLabel = "Connected signer",
  variant = "compact",
  fallback,
  onProfile,
  onNetwork,
  onDisconnect,
  className,
}: AccountMenuProps) {
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const isPanel = variant === "panel"

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {isPanel ? (
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-elevated)]",
                className
              )}
            >
              <Avatar className="h-8 w-8 border border-[var(--border)]">
                <AvatarImage src={avatarUrl ?? undefined} alt={displayName} />
                <AvatarFallback className="bg-transparent p-0">
                  {fallback ?? displayName[0]?.toUpperCase() ?? "?"}
                </AvatarFallback>
              </Avatar>
              <div className="hidden min-w-0 sm:block">
                <div className="truncate text-sm font-medium text-[var(--text-primary)]">
                  {displayName}
                </div>
                <div className="text-xs text-[var(--text-muted)]">
                  {statusLabel}
                </div>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
            </button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              className={cn("gap-2 text-xs", className)}
            >
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  className="h-5 w-5 rounded-full object-cover"
                />
              ) : null}
              {displayName}
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[15rem] rounded-xl border-[var(--border)] bg-[var(--surface-dialog)] p-2"
        >
          <DropdownMenuLabel className="px-2 py-2">
            <div className="flex items-center gap-2 text-xs font-normal text-[var(--text-secondary)]">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              {statusLabel}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="h-10 cursor-pointer gap-2 rounded-lg"
            onSelect={onProfile}
          >
            <UserRound className="h-4 w-4 text-secondary-300" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem
            className="h-10 cursor-pointer gap-2 rounded-lg"
            onSelect={onNetwork}
          >
            <RadioTower className="h-4 w-4 text-secondary-300" />
            Network
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="h-10 cursor-pointer gap-2 rounded-lg text-pink-400 focus:text-pink-300"
            onSelect={() => setDisconnectOpen(true)}
          >
            <LogOut className="h-4 w-4" />
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent className="max-w-sm border-[var(--border)] bg-[var(--surface-dialog)] text-[var(--text-primary)] shadow-[var(--shadow-dialog)]">
          <DialogHeader>
            <DialogTitle>Disconnect signer?</DialogTitle>
            <DialogDescription className="text-sm leading-7 text-[var(--text-secondary)]">
              You can reconnect later, but signed actions will require
              connecting again.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-secondary)]">
            <div className="font-medium text-[var(--text-primary)]">
              {displayName}
            </div>
            <div className="font-mono">{pubkeyLabel}</div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onDisconnect()
                setDisconnectOpen(false)
              }}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
