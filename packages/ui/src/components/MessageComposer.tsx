import { useRef, useState, type KeyboardEvent } from "react"
import { Paperclip, Send } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./Button"
import { Input } from "./Input"
import { Textarea } from "./Textarea"

export interface MessageComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onAttach?: (file: File) => Promise<void>
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
  onAttach,
  sending,
  disabled,
  placeholder,
  className,
}: MessageComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [attaching, setAttaching] = useState(false)
  const [attachmentFailed, setAttachmentFailed] = useState(false)
  const canSend = !disabled && !sending && !attaching && value.trim().length > 0

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      if (canSend) onSend()
    }
  }

  return (
    <div className={cn("flex flex-wrap items-end gap-2", className)}>
      {onAttach ? (
        <>
          <Input
            ref={inputRef}
            type="file"
            className="hidden"
            aria-label="Choose an encrypted attachment"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ""
              if (!file) return
              setAttaching(true)
              setAttachmentFailed(false)
              void onAttach(file)
                .catch(() => setAttachmentFailed(true))
                .finally(() => setAttaching(false))
            }}
          />
          <Button
            size="icon"
            type="button"
            className="min-h-11 min-w-11"
            variant="outline"
            disabled={disabled || sending || attaching}
            aria-label="Attach encrypted file"
            onClick={() => inputRef.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
        </>
      ) : null}
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        aria-label="Message"
        placeholder={placeholder ?? "Write a message"}
        disabled={disabled || sending || attaching}
        rows={1}
        className="max-h-40 min-h-11 flex-1 resize-none"
      />
      <Button
        type="button"
        className="min-h-11 min-w-11"
        size="icon"
        onClick={() => {
          if (canSend) onSend()
        }}
        disabled={!canSend}
        aria-label="Send message"
      >
        <Send className={cn("size-4", sending && "animate-pulse")} />
      </Button>
      {attaching || attachmentFailed ? (
        <p
          role={attachmentFailed ? "alert" : "status"}
          className="w-full text-sm"
        >
          {attachmentFailed
            ? "Attachment delivery is incomplete. Check saved sends before trying again."
            : "Encrypting and sending attachment…"}
        </p>
      ) : null}
    </div>
  )
}
