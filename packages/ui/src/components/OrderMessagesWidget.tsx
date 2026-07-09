import { MessageCircle, Send, X } from "lucide-react"
import type { ParsedOrderMessage } from "@conduit/core"
import { Button } from "./Button"
import { Input } from "./Input"
import { OrderConversationMessage } from "./OrderConversationMessage"

export type OrderMessagesWidgetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Heading shown at the top of the window. */
  title?: string
  /** Secondary line (e.g. the counterparty name). */
  subtitle?: string
  messages: ParsedOrderMessage[]
  /** Pubkey of the current user, used to right-align their own messages. */
  selfPubkey?: string | null
  replyValue: string
  onReplyChange: (value: string) => void
  onSend: () => void
  sending?: boolean
  placeholder?: string
  /** Resolve an order item's product listing for thumbnails in order bubbles. */
  resolveItem?: (
    productId: string
  ) => { title?: string; imageUrl?: string } | undefined
}

// Floating chat launcher + window, anchored bottom-right. Shared by the
// merchant orders page and available to the market for order conversations.
export function OrderMessagesWidget({
  open,
  onOpenChange,
  title = "Messages",
  subtitle,
  messages,
  selfPubkey,
  replyValue,
  onReplyChange,
  onSend,
  sending = false,
  placeholder = "Message, then press Enter",
  resolveItem,
}: OrderMessagesWidgetProps) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3 sm:bottom-6 sm:right-6">
      {open && (
        <div className="fixed inset-0 z-50 flex h-[100dvh] w-screen flex-col overflow-hidden bg-[var(--surface)] sm:static sm:h-[32rem] sm:max-h-[calc(100dvh-7rem)] sm:w-[calc(100vw-2rem)] sm:max-w-sm sm:rounded-[1.25rem] sm:border sm:border-[var(--border)] sm:shadow-[var(--shadow-xl)]">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] p-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)]">
                {title}
              </div>
              {subtitle && (
                <div className="truncate text-xs text-[var(--text-secondary)]">
                  {subtitle}
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label="Close messages"
              onClick={() => onOpenChange(false)}
              className="shrink-0 rounded-full p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="text-sm text-[var(--text-secondary)]">
                No messages yet.
              </div>
            ) : (
              messages.map((message) => (
                <OrderConversationMessage
                  key={message.id}
                  message={message}
                  mine={message.senderPubkey === selfPubkey}
                  resolveItem={resolveItem}
                />
              ))
            )}
          </div>

          <form
            className="border-t border-[var(--border)] p-3"
            onSubmit={(event) => {
              event.preventDefault()
              onSend()
            }}
          >
            <div className="flex items-center gap-2">
              <Input
                value={replyValue}
                onChange={(event) => onReplyChange(event.target.value)}
                placeholder={placeholder}
                className="flex-1"
              />
              <Button
                type="submit"
                size="icon"
                className="shrink-0"
                disabled={sending || !replyValue.trim()}
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label={open ? "Close messages" : "Open messages"}
        className={`relative flex h-14 w-14 items-center justify-center rounded-full bg-primary-500 text-white shadow-[var(--shadow-xl)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] ${open ? "max-sm:hidden" : ""}`}
      >
        {open ? (
          <X className="h-6 w-6" />
        ) : (
          <MessageCircle className="h-6 w-6" />
        )}
        {!open && messages.length > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-1 text-xs font-medium text-[var(--text-primary)]">
            {messages.length}
          </span>
        )}
      </button>
    </div>
  )
}
