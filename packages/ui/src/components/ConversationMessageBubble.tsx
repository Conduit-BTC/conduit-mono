import { LoaderCircle, RefreshCw } from "lucide-react"
import { cn } from "../utils"
import type { OptimisticMessageDeliveryState } from "../hooks/useOptimisticConversationMessages"

type LegacyOrderStatusMessage = {
  id: string
  type: number
  message: string
  paid: boolean
  shipped: boolean
  cancelled: boolean
}

function isLegacyOrderStatusMessage(
  value: unknown
): value is LegacyOrderStatusMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "number" &&
    typeof candidate.message === "string" &&
    typeof candidate.paid === "boolean" &&
    typeof candidate.shipped === "boolean" &&
    typeof candidate.cancelled === "boolean"
  )
}

/** Render known legacy order-status DMs as their buyer-facing message text. */
export function getConversationMessageDisplayContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content)
    return isLegacyOrderStatusMessage(parsed) ? parsed.message : content
  } catch {
    return content
  }
}

export interface ConversationMessageBubbleProps {
  content: string
  /** True when the signed-in user authored the message (align right). */
  mine: boolean
  timestampLabel?: string
  authorLabel?: string
  deliveryState?: OptimisticMessageDeliveryState
  onRetry?: () => void
  className?: string
}

/**
 * Presentational chat bubble for a general (kind-14) direct message. Shared by
 * Market and Merchant so the two inboxes render identically. Order-linked
 * messages keep their own richer, order-shaped renderer.
 */
export function ConversationMessageBubble({
  content,
  mine,
  timestampLabel,
  authorLabel,
  deliveryState = "published",
  onRetry,
  className,
}: ConversationMessageBubbleProps) {
  const displayContent = getConversationMessageDisplayContent(content)

  return (
    <div
      className={cn(
        "flex w-full",
        mine ? "justify-end" : "justify-start",
        className
      )}
    >
      <div
        data-delivery-state={deliveryState}
        aria-busy={deliveryState === "pending" || undefined}
        className={cn(
          "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm break-words whitespace-pre-wrap",
          mine
            ? "rounded-br-sm bg-primary-500 text-white"
            : "rounded-bl-sm border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]",
          deliveryState === "pending" && "opacity-80",
          deliveryState === "failed" && "outline outline-1 outline-error/60"
        )}
      >
        {authorLabel && !mine ? (
          <span className="mb-0.5 block text-[11px] font-medium text-[var(--text-muted)]">
            {authorLabel}
          </span>
        ) : null}
        <span>{displayContent}</span>
        {timestampLabel || deliveryState !== "published" ? (
          <span
            className={cn(
              "mt-1 flex items-center justify-end gap-1.5 text-[10px]",
              mine ? "text-white/70" : "text-[var(--text-muted)]"
            )}
          >
            {timestampLabel ? <span>{timestampLabel}</span> : null}
            {deliveryState === "pending" ? (
              <span
                role="status"
                aria-label="Publishing message"
                className="inline-flex items-center"
              >
                <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
              </span>
            ) : null}
            {deliveryState === "failed" && onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1 font-medium text-white transition-opacity hover:opacity-80"
                aria-label="Retry message"
                title="Retry message"
              >
                <RefreshCw className="size-3" />
                Retry
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  )
}
