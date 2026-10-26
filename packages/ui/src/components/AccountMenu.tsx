import { ChevronDown, KeyRound, LogOut, CircleUser } from "lucide-react"
import { type ReactNode, useState } from "react"
import { normalizePublicMediaUrl } from "@conduit/core"
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar"
import { Button } from "./Button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./DropdownMenu"

export interface AccountMenuProps {
  displayName: string
  pubkeyLabel?: string
  avatarUrl?: string | null
  accountPresent: boolean
  pending: boolean
  recoveryRequired?: boolean
  incompatible?: boolean
  label?: string
  fallback?: ReactNode
  items: Array<{ label: string; content: ReactNode }>
  onConnect: () => void
  onReconnect: () => Promise<void> | void
  onDisconnect: () => Promise<void> | void
}

export function AccountMenu({
  displayName,
  pubkeyLabel,
  avatarUrl,
  accountPresent,
  pending,
  recoveryRequired,
  incompatible,
  label = "Open account menu",
  fallback,
  items,
  onConnect,
  onReconnect,
  onDisconnect,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false)
  const [working, setWorking] = useState<"reconnect" | "disconnect" | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const safeAvatarUrl = normalizePublicMediaUrl(avatarUrl)
  async function run(
    action: () => Promise<void> | void,
    operation: "reconnect" | "disconnect"
  ) {
    if (working) return
    setWorking(operation)
    setError(null)
    try {
      await action()
      setOpen(false)
    } catch {
      setError("Could not finish the account action. Please try again.")
    } finally {
      setWorking(null)
    }
  }
  if (!accountPresent)
    return (
      <Button
        aria-label="Connect"
        aria-busy={pending}
        disabled={working !== null}
        onClick={onConnect}
        className="size-11 gap-2 p-0 sm:h-11 sm:w-auto sm:px-4"
      >
        <CircleUser className="size-5 sm:hidden" aria-hidden="true" />
        <span className="hidden sm:inline">Connect</span>
      </Button>
    )
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (!working) setOpen(next)
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={label}
          className="size-11 p-1.5 sm:h-12 sm:w-auto sm:min-w-48 sm:justify-start sm:gap-3 sm:px-3"
        >
          <Avatar className="size-8 shrink-0">
            <AvatarImage src={safeAvatarUrl ?? undefined} alt="" />
            <AvatarFallback>
              {fallback ?? displayName.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="hidden min-w-0 flex-1 text-left sm:block">
            <span className="block truncate text-sm font-semibold">
              {displayName}
            </span>
            <span className="block truncate text-xs">{pubkeyLabel}</span>
          </span>
          <ChevronDown className="hidden size-4 sm:block" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={10}
        className="w-56 bg-[var(--surface-dialog)] p-2"
      >
        <DropdownMenuLabel className="text-xs font-normal text-[var(--text-secondary)]">
          {incompatible
            ? "Signer capability required"
            : recoveryRequired
              ? "Signer reconnect needed"
              : "Connected"}
        </DropdownMenuLabel>
        {recoveryRequired && (
          <DropdownMenuItem
            disabled={pending || working !== null}
            onSelect={(event) => {
              event.preventDefault()
              void run(onReconnect, "reconnect")
            }}
          >
            <KeyRound className="mr-2 size-4" aria-hidden="true" />
            {pending ? "Reconnecting..." : "Reconnect signer"}
          </DropdownMenuItem>
        )}
        {items.map((item) => (
          <DropdownMenuItem
            asChild
            key={item.label}
            disabled={working !== null}
            className="min-h-11 cursor-pointer gap-3"
          >
            {item.content}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={working !== null || pending}
          onSelect={(event) => {
            event.preventDefault()
            void run(onDisconnect, "disconnect")
          }}
          className="min-h-11 cursor-pointer gap-3 text-[var(--error-text)] focus:text-[var(--error-text)]"
        >
          <LogOut className="size-4" aria-hidden="true" />
          {working === "disconnect" ? "Disconnecting..." : "Disconnect"}
        </DropdownMenuItem>
        {error && (
          <p
            role="alert"
            className="px-2 py-2 text-sm text-[var(--error-text)]"
          >
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
