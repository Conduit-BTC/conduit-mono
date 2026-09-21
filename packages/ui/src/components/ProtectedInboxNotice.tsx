import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react"
import {
  getProtectedInboxNoticePresentation,
  type ProtectedInboxNoticeState,
  type ProtectedInboxNoticeSubject,
} from "../protected-inbox-presentation"
import { cn } from "../utils"
import { Button } from "./Button"

export interface ProtectedInboxNoticeProps {
  state: ProtectedInboxNoticeState
  subject?: ProtectedInboxNoticeSubject
  decryptFailureCount?: number
  onRetry?: () => void
  retrying?: boolean
  className?: string
}

/** One consequence-level notice for a protected inbox result. */
export function ProtectedInboxNotice({
  state,
  subject = "messages",
  decryptFailureCount = 0,
  onRetry,
  retrying,
  className,
}: ProtectedInboxNoticeProps) {
  const presentation = getProtectedInboxNoticePresentation({
    state,
    subject,
    decryptFailureCount,
  })
  if (!presentation) return null

  const Icon = presentation.unavailable ? WifiOff : AlertTriangle
  return (
    <div
      role={presentation.unavailable ? "alert" : undefined}
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm",
        presentation.unavailable
          ? "border-error/30 bg-error/10 text-error"
          : "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--text-primary)]",
        className
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {presentation.message}
      </span>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
        >
          <RefreshCw
            className={cn("mr-1 size-3.5", retrying && "animate-spin")}
            aria-hidden="true"
          />
          Retry
        </Button>
      ) : null}
    </div>
  )
}
