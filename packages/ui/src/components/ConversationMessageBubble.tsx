import { cn } from "../utils"

export interface ConversationMessageBubbleProps {
  content: string
  /** True when the signed-in user authored the message (align right). */
  mine: boolean
  timestampLabel?: string
  authorLabel?: string
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
  className,
}: ConversationMessageBubbleProps) {
  return (
    <div
      className={cn(
        "flex w-full",
        mine ? "justify-end" : "justify-start",
        className
      )}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm break-words whitespace-pre-wrap",
          mine
            ? "rounded-br-sm bg-primary-500 text-white"
            : "rounded-bl-sm border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]"
        )}
      >
        {authorLabel && !mine ? (
          <span className="mb-0.5 block text-[11px] font-medium text-[var(--text-muted)]">
            {authorLabel}
          </span>
        ) : null}
        <span>{content}</span>
        {timestampLabel ? (
          <span
            className={cn(
              "mt-1 block text-[10px]",
              mine ? "text-white/70" : "text-[var(--text-muted)]"
            )}
          >
            {timestampLabel}
          </span>
        ) : null}
      </div>
    </div>
  )
}
