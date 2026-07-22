import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./Button"

export interface LiveReadNoticeProps {
  state: "cached" | "partial" | "unavailable"
  onRetry?: () => void
  retrying?: boolean
  className?: string
}

export function LiveReadNotice({
  state,
  onRetry,
  retrying,
  className,
}: LiveReadNoticeProps) {
  const unavailable = state === "unavailable"
  const Icon = unavailable ? WifiOff : AlertTriangle
  const text =
    state === "cached"
      ? "Showing saved messages while the live inbox reconnects."
      : state === "partial"
        ? "Some inbox sources are unavailable. Messages may be incomplete."
        : "The live inbox is unavailable. Retry to check for messages."

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm",
        unavailable
          ? "border-error/30 bg-error/10 text-error"
          : "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--text-primary)]",
        className
      )}
    >
      <span className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" />
        {text}
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
          />
          Retry
        </Button>
      ) : null}
    </div>
  )
}
