import { AlertTriangle, RefreshCw } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./Button"

export interface DecryptFailureNoticeProps {
  /** Number of messages that could not be decrypted this read. */
  count: number
  onRetry?: () => void
  retrying?: boolean
  className?: string
}

/**
 * Visible, retryable degraded state for messages that failed to unwrap/decrypt.
 * Renders nothing when there are no failures. Never shows message content — the
 * caller only passes a count, per the messaging privacy contract.
 */
export function DecryptFailureNotice({
  count,
  onRetry,
  retrying,
  className,
}: DecryptFailureNoticeProps) {
  if (count <= 0) return null

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm",
        "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--text-primary)]",
        className
      )}
    >
      <span className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-[var(--warning)]" />
        {count} message{count === 1 ? "" : "s"} couldn&rsquo;t be decrypted.
      </span>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
        >
          <RefreshCw className={cn("mr-1 size-3.5", retrying && "animate-spin")} />
          Retry
        </Button>
      ) : null}
    </div>
  )
}
