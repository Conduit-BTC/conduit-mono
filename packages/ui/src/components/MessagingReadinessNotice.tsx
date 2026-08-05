import { MessageCircleMore, RefreshCw } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./Button"

export interface MessagingReadinessNoticeProps {
  state: "not_declared" | "lookup_failed"
  onAction: () => void
  pending?: boolean
  error?: string | null
  className?: string
}

export function MessagingReadinessNotice({
  state,
  onAction,
  pending,
  error,
  className,
}: MessagingReadinessNoticeProps) {
  const lookupFailed = state === "lookup_failed"

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-4 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-3 text-sm",
        className
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <MessageCircleMore className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <div>
          <div className="font-medium text-[var(--text-primary)]">
            {lookupFailed
              ? "Messaging setup could not be checked"
              : "Enable encrypted messaging"}
          </div>
          <div className="mt-1 text-[var(--text-secondary)]">
            {lookupFailed
              ? "Retry the inbox relay lookup when your relay connection recovers."
              : "Publish your private inbox relay declaration so messages can be delivered to this identity."}
          </div>
          {error ? <div className="mt-1 text-error">{error}</div> : null}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAction}
        disabled={pending}
      >
        <RefreshCw className={cn("mr-1 size-3.5", pending && "animate-spin")} />
        {lookupFailed ? "Retry" : "Enable messaging"}
      </Button>
    </div>
  )
}
