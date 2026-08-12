import { type KeyboardEvent } from "react"
import { Send } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./Button"
import { Textarea } from "./Textarea"

export interface MessageComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  sending?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
}

/**
 * Shared message input: a growable textarea plus a send button. Enter sends,
 * Shift+Enter inserts a newline. Presentational — the caller owns the mutation.
 */
export function MessageComposer({
  value,
  onChange,
  onSend,
  sending,
  disabled,
  placeholder,
  className,
}: MessageComposerProps) {
  const canSend = !disabled && !sending && value.trim().length > 0

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (canSend) onSend()
    }
  }

  return (
    <div className={cn("flex items-end gap-2", className)}>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? "Write a message"}
        disabled={disabled || sending}
        rows={1}
        className="max-h-40 min-h-11 flex-1 resize-none"
      />
      <Button
        type="button"
        size="icon"
        onClick={() => {
          if (canSend) onSend()
        }}
        disabled={!canSend}
        aria-label="Send message"
      >
        <Send className={cn("size-4", sending && "animate-pulse")} />
      </Button>
    </div>
  )
}
