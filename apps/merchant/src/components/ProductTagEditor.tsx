import {
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react"
import { X } from "lucide-react"
import { Button, cn } from "@conduit/ui"
import {
  addProductTags,
  formatProductTags,
  getProductTagEditFeedback,
  MAX_PRODUCT_TAG_COUNT,
  MAX_PRODUCT_TAG_LENGTH,
  parseProductTags,
  removeProductTagAtIndex,
} from "../lib/productForm"

interface ProductTagEditorProps {
  id: string
  value: string
  onChange: (value: string) => void
  descriptionId?: string
  errorMessage?: string | null
  placeholder?: string
}

export function ProductTagEditor({
  id,
  value,
  onChange,
  descriptionId,
  errorMessage,
  placeholder = "Add tag",
}: ProductTagEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const isComposingRef = useRef(false)
  const [draft, setDraft] = useState("")
  const [feedback, setFeedback] = useState<string | null>(null)
  const tags = useMemo(() => parseProductTags(value), [value])
  const feedbackId = `${id}-feedback`
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [
    descriptionId,
    hintId,
    feedback ? feedbackId : null,
    errorMessage ? errorId : null,
  ]
    .filter(Boolean)
    .join(" ")

  function commitTags(input: string): void {
    const result = addProductTags(value, input)
    const nextValue = formatProductTags(result.tags)
    const nextFeedback = getProductTagEditFeedback(result)

    if (nextValue !== formatProductTags(tags)) {
      onChange(nextValue)
    }
    setFeedback(nextFeedback)
    setDraft("")
  }

  function removeTag(index: number): void {
    const nextTags = removeProductTagAtIndex(value, index)
    onChange(formatProductTags(nextTags))
    setFeedback(null)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // Some WebKit IMEs report keyCode 229 after compositionend.
    if (
      isComposingRef.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return
    }

    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      commitTags(draft)
      return
    }

    if (event.key === "Backspace" && draft.length === 0 && tags.length > 0) {
      event.preventDefault()
      removeTag(tags.length - 1)
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const pasted = event.clipboardData.getData("text")
    if (
      !pasted.includes(",") &&
      `${draft}${pasted}`.trim().length <= MAX_PRODUCT_TAG_LENGTH
    ) {
      return
    }

    event.preventDefault()
    commitTags(
      pasted.includes(",") ? `${draft},${pasted}` : `${draft}${pasted}`
    )
  }

  return (
    <div className="grid gap-1.5">
      <div
        className={cn(
          "flex min-h-10 w-full cursor-text flex-wrap items-center gap-2 rounded-md border bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text-primary)] transition focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 focus-within:ring-offset-[var(--background)]",
          errorMessage
            ? "border-error"
            : "border-[var(--border)] focus-within:border-primary-500"
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag, index) => (
          <span
            key={`${tag}-${index}`}
            className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-2.5 py-1 text-xs text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)]"
            title={tag}
          >
            <span className="max-w-[12rem] truncate">{tag}</span>
            <button
              type="button"
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              aria-label={`Remove ${tag} tag`}
              onClick={(event) => {
                event.stopPropagation()
                removeTag(index)
              }}
            >
              <X aria-hidden="true" className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          ref={inputRef}
          className="min-h-7 min-w-[9rem] flex-1 bg-transparent px-1 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          value={draft}
          aria-describedby={describedBy || undefined}
          aria-invalid={!!errorMessage}
          onChange={(event) => {
            setDraft(event.target.value)
            setFeedback(null)
          }}
          onCompositionStart={() => {
            isComposingRef.current = true
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => {
            if (draft.trim()) commitTags(draft)
          }}
          placeholder={tags.length === 0 ? placeholder : "Add another tag"}
        />
        {draft.trim() && (
          <Button
            type="button"
            variant="muted"
            size="sm"
            className="h-7 shrink-0 px-2.5 text-xs"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              commitTags(draft)
              inputRef.current?.focus()
            }}
          >
            Add
          </Button>
        )}
      </div>

      {feedback && (
        <div
          id={feedbackId}
          className="text-xs leading-5 text-[var(--warning)]"
        >
          {feedback}
        </div>
      )}
      {errorMessage && (
        <div id={errorId} role="alert" className="text-xs leading-5 text-error">
          {errorMessage}
        </div>
      )}
      <div id={hintId} className="text-xs leading-5 text-[var(--text-muted)]">
        Press comma, Enter, or Add. {tags.length}/{MAX_PRODUCT_TAG_COUNT} tags,{" "}
        {MAX_PRODUCT_TAG_LENGTH} characters max each.
      </div>
    </div>
  )
}
