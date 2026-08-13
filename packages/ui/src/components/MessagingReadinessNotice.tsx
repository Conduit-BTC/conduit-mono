import { MessageCircleMore, RefreshCw, Settings2 } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./Button"

/**
 * Typed NIP-17 inbox readiness states (CND-208).
 * - not_observed: no kind-10050 declaration was observed on the bounded
 *   discovery set; setup happens in Network.
 * - signed_empty: the current signed declaration intentionally lists no
 *   relays; restore it from Network settings.
 * - malformed: a signed declaration has relay tags but none are usable;
 *   repair happens in Network and is never automatic.
 * - lookup_partial / lookup_unavailable / lookup_failed: the declaration
 *   lookup degraded; this is retryable and never means "missing".
 */
export type MessagingReadinessState =
  | "not_observed"
  | "signed_empty"
  | "malformed"
  | "lookup_failed"
  | "lookup_partial"
  | "lookup_unavailable"

export interface MessagingReadinessNoticeProps {
  state: MessagingReadinessState
  onAction: () => void
  pending?: boolean
  error?: string | null
  className?: string
}

const COPY: Record<
  MessagingReadinessState,
  { title: string; body: string; actionLabel: string; setup: boolean }
> = {
  not_observed: {
    title: "Finish private inbox setup",
    body: "No encrypted inbox declaration was found on the shared discovery relays. Choose inbox relays in Network settings so orders and messages can reach this identity.",
    actionLabel: "Open Network settings",
    setup: true,
  },
  signed_empty: {
    title: "Restore your private inbox declaration",
    body: "Your current signed inbox declaration lists no relays. Choose inbox relays in Network settings to receive new encrypted messages.",
    actionLabel: "Open Network settings",
    setup: true,
  },
  malformed: {
    title: "Repair your private inbox declaration",
    body: "Your published inbox relay declaration contains no usable relays. Repair it from Network settings.",
    actionLabel: "Open Network settings",
    setup: true,
  },
  lookup_failed: {
    title: "Messaging setup could not be checked",
    body: "Retry the inbox relay lookup when your relay connection recovers.",
    actionLabel: "Retry",
    setup: false,
  },
  lookup_partial: {
    title: "Messaging setup only partially checked",
    body: "Some relays did not respond, so your inbox declaration could not be fully confirmed. Retry to complete the check.",
    actionLabel: "Retry",
    setup: false,
  },
  lookup_unavailable: {
    title: "Messaging setup could not be checked",
    body: "No relay responded to the inbox declaration lookup. This does not mean your setup is missing - retry when your connection recovers.",
    actionLabel: "Retry",
    setup: false,
  },
}

export function MessagingReadinessNotice({
  state,
  onAction,
  pending,
  error,
  className,
}: MessagingReadinessNoticeProps) {
  const copy = COPY[state]

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
            {copy.title}
          </div>
          <div className="mt-1 text-[var(--text-secondary)]">{copy.body}</div>
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
        {copy.setup ? (
          <Settings2 className="mr-1 size-3.5" />
        ) : (
          <RefreshCw
            className={cn("mr-1 size-3.5", pending && "animate-spin")}
          />
        )}
        {copy.actionLabel}
      </Button>
    </div>
  )
}
