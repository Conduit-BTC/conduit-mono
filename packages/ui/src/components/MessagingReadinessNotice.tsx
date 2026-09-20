import { MessageCircleMore, RefreshCw, Settings2 } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./Button"

/**
 * Typed NIP-17 inbox readiness states (CND-208).
 * - not_observed: no kind-10050 declaration was observed on the bounded
 *   discovery set; setup happens in Network.
 * - distribution_pending: an exact signed declaration is locally durable but
 *   has not been confirmed on shared discovery relays.
 * - signed_empty: the current signed declaration intentionally lists no
 *   relays; restore it from Network settings.
 * - malformed: a signed declaration has relay tags but none are usable;
 *   repair happens in Network and is never automatic.
 * - lookup_partial / lookup_unavailable / lookup_failed: the declaration
 *   lookup degraded; this is retryable and never means "missing".
 */
export type MessagingReadinessState =
  | "not_observed"
  | "distribution_pending"
  | "signed_empty"
  | "malformed"
  | "lookup_failed"
  | "lookup_partial"
  | "lookup_unavailable"

export type MessagingReadinessStatus =
  MessagingReadinessState | "loading" | "ready"

export function toMessagingReadinessNoticeState(
  status: MessagingReadinessStatus
): MessagingReadinessState | null {
  switch (status) {
    case "loading":
    case "ready":
      return null
    case "not_observed":
    case "distribution_pending":
    case "signed_empty":
    case "malformed":
    case "lookup_failed":
    case "lookup_partial":
    case "lookup_unavailable":
      return status
  }
}

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
    title: "Private messages may not reach you",
    body: "Choose an inbox in Network settings before relying on this inbox for new orders or messages.",
    actionLabel: "Open Network settings",
    setup: true,
  },
  distribution_pending: {
    title: "Private inbox setup is still publishing",
    body: "New messages may not reliably reach you yet. Finish setup in Network settings before sending a general direct message. Validated order replies can still deliver.",
    actionLabel: "Open Network settings",
    setup: true,
  },
  signed_empty: {
    title: "Private messages can't reach this inbox",
    body: "Choose an inbox in Network settings to receive new encrypted messages.",
    actionLabel: "Open Network settings",
    setup: true,
  },
  malformed: {
    title: "Private inbox setup needs repair",
    body: "Repair the inbox in Network settings before relying on new encrypted messages.",
    actionLabel: "Open Network settings",
    setup: true,
  },
  lookup_failed: {
    title: "Messaging availability couldn't be confirmed",
    body: "Retry before relying on an empty inbox or sending a new message.",
    actionLabel: "Retry",
    setup: false,
  },
  lookup_partial: {
    title: "Messaging availability couldn't be confirmed",
    body: "Retry before relying on an empty inbox or sending a new message.",
    actionLabel: "Retry",
    setup: false,
  },
  lookup_unavailable: {
    title: "Messaging availability couldn't be confirmed",
    body: "This does not mean setup is missing. Retry before relying on an empty inbox or sending a new message.",
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
      role="alert"
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
