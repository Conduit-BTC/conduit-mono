import { useEffect, useId, useRef } from "react"
import { MessageCircle, Send, X } from "lucide-react"
import type { ParsedOrderMessage } from "@conduit/core"
import { Button } from "./Button"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./Dialog"
import { Input } from "./Input"
import { Label } from "./Label"
import { OrderConversationMessage } from "./OrderConversationMessage"

export type OrderMessagesWidgetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  subtitle?: string
  messages: ParsedOrderMessage[]
  selfPubkey?: string | null
  replyValue: string
  onReplyChange: (value: string) => void
  onSend: () => void
  sending?: boolean
  error?: string | null
  placeholder?: string
  resolveItem?: (
    productId: string
  ) => { title?: string; imageUrl?: string } | undefined
}

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
  error = null,
  placeholder = "Message, then press Enter",
  resolveItem,
}: OrderMessagesWidgetProps) {
  const replyInputId = useId()
  const errorId = useId()
  const messageEndRef = useRef<HTMLDivElement>(null)
  const latestMessageId = messages.at(-1)?.id

  useEffect(() => {
    if (!open) return
    messageEndRef.current?.scrollIntoView({ block: "end" })
  }, [latestMessageId, open])

  return (
    <div className="fixed bottom-4 right-4 z-50 sm:bottom-6 sm:right-6">
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="inset-0 left-0 top-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-[var(--surface)] p-0 sm:inset-auto sm:bottom-24 sm:right-6 sm:left-auto sm:top-auto sm:h-[32rem] sm:max-h-[calc(100dvh-7rem)] sm:w-[calc(100vw-2rem)] sm:max-w-sm sm:translate-x-0 sm:translate-y-0 sm:rounded-xl sm:border sm:border-[var(--border)]">
          <div className="border-b border-[var(--border)] p-4 pr-12">
            <DialogTitle className="text-sm font-semibold text-[var(--text-primary)]">
              {title}
            </DialogTitle>
            {subtitle && (
              <div className="truncate text-xs text-[var(--text-secondary)]">
                {subtitle}
              </div>
            )}
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
            <div ref={messageEndRef} aria-hidden="true" />
          </div>

          <form
            className="border-t border-[var(--border)] p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
            onSubmit={(event) => {
              event.preventDefault()
              if (sending || !replyValue.trim()) return
              onSend()
            }}
          >
            <Label htmlFor={replyInputId} className="sr-only">
              Message
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={replyInputId}
                value={replyValue}
                onChange={(event) => onReplyChange(event.target.value)}
                placeholder={placeholder}
                className="flex-1"
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
              />
              <Button
                type="submit"
                size="icon"
                className="shrink-0"
                disabled={sending || !replyValue.trim()}
                aria-label="Send message"
              >
                <Send className="size-4" aria-hidden="true" />
              </Button>
            </div>
            {error && (
              <p id={errorId} className="mt-2 text-xs text-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogContent>

        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={open ? "Close messages" : "Open messages"}
            className={`relative flex size-14 items-center justify-center rounded-full bg-primary-500 text-white shadow-xl transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] ${open ? "max-sm:hidden" : ""}`}
          >
            {open ? (
              <X className="size-6" aria-hidden="true" />
            ) : (
              <MessageCircle className="size-6" aria-hidden="true" />
            )}
            {!open && messages.length > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-1 text-xs font-medium text-[var(--text-primary)]">
                {messages.length}
              </span>
            )}
          </button>
        </DialogTrigger>
      </Dialog>
    </div>
  )
}
