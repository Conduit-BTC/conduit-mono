import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react"
import { X } from "lucide-react"
import {
  Button,
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  Popover,
  PopoverAnchor,
  PopoverContent,
  cn,
} from "@conduit/ui"
import {
  addProductTags,
  formatProductTags,
  getProductTagEditFeedback,
  MAX_PRODUCT_TAG_COUNT,
  MAX_PRODUCT_TAG_LENGTH,
  parseProductTags,
  RECOMMENDED_MAX_PRODUCT_TAG_COUNT,
  RECOMMENDED_MIN_PRODUCT_TAG_COUNT,
  removeProductTagAtIndex,
} from "../lib/productForm"
import {
  getProductTagSuggestions,
  type ProductTagCatalogEntry,
} from "../lib/productTagSuggestions"

interface ProductTagEditorProps {
  id: string
  value: string
  onChange: (value: string) => void
  catalogTags?: readonly ProductTagCatalogEntry[]
  descriptionId?: string
  errorMessage?: string | null
  placeholder?: string
}

export function ProductTagEditor({
  id,
  value,
  onChange,
  catalogTags = [],
  descriptionId,
  errorMessage,
  placeholder = "Add tag",
}: ProductTagEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const isComposingRef = useRef(false)
  const isSelectingSuggestionRef = useRef(false)
  const suggestionTouchMovedRef = useRef(false)
  const [draft, setDraft] = useState("")
  const [feedback, setFeedback] = useState<string | null>(null)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState("")
  const [suggestionListId, setSuggestionListId] = useState<string>()
  const suggestionItemRefs = useRef(new Map<string, HTMLDivElement>())
  const tags = useMemo(() => parseProductTags(value), [value])
  const suggestions = useMemo(
    () => getProductTagSuggestions(catalogTags, tags, draft),
    [catalogTags, draft, tags]
  )
  const popupOpen =
    suggestionsOpen && draft.trim().length > 0 && suggestions.length > 0
  const activeSuggestionId =
    popupOpen && activeSuggestion
      ? suggestionItemRefs.current.get(activeSuggestion)?.id
      : undefined
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

  const handleSuggestionListRef = useCallback(
    (element: HTMLDivElement | null) => {
      setSuggestionListId(element?.id)
    },
    []
  )

  useEffect(() => {
    setActiveSuggestion(popupOpen ? (suggestions[0]?.tag ?? "") : "")
  }, [popupOpen, suggestions])

  function commitTags(input: string): void {
    const result = addProductTags(value, input)
    const nextValue = formatProductTags(result.tags)
    const nextFeedback = getProductTagEditFeedback(result)

    if (nextValue !== formatProductTags(tags)) {
      onChange(nextValue)
    }
    setFeedback(nextFeedback)
    setDraft("")
    setSuggestionsOpen(false)
    setActiveSuggestion("")
  }

  function commitSuggestion(tag: string): void {
    isSelectingSuggestionRef.current = false
    commitTags(tag)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
    })
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

    if (event.key === "Escape" && popupOpen) {
      event.preventDefault()
      event.stopPropagation()
      setSuggestionsOpen(false)
      setActiveSuggestion("")
      return
    }

    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      !popupOpen &&
      suggestions.length > 0
    ) {
      event.preventDefault()
      setSuggestionsOpen(true)
      setActiveSuggestion(suggestions[0]?.tag ?? "")
      return
    }

    if (event.key === "Enter") {
      if (popupOpen && activeSuggestion) return
      event.preventDefault()
      commitTags(draft)
      return
    }

    if (event.key === ",") {
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

  function resetSuggestionPointerState(): void {
    window.setTimeout(() => {
      isSelectingSuggestionRef.current = false
    }, 0)
  }

  function beginSuggestionPointerSelection(): void {
    isSelectingSuggestionRef.current = true
  }

  function beginSuggestionTouchSelection(): void {
    isSelectingSuggestionRef.current = true
    suggestionTouchMovedRef.current = false
  }

  function resetSuggestionTouchState(): void {
    // Mobile browsers can dispatch the compatibility click after touchend.
    window.setTimeout(() => {
      isSelectingSuggestionRef.current = false
    }, 500)
  }

  return (
    <div className="grid gap-1.5">
      <Popover
        open={popupOpen}
        onOpenChange={(open) => {
          setSuggestionsOpen(
            open && draft.trim().length > 0 && suggestions.length > 0
          )
        }}
      >
        <Command
          shouldFilter={false}
          value={activeSuggestion}
          onValueChange={setActiveSuggestion}
          className="overflow-visible rounded-none bg-transparent"
        >
          <PopoverAnchor asChild>
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
                onChange={(event) => {
                  const nextDraft = event.target.value
                  setDraft(nextDraft)
                  setFeedback(null)
                  setSuggestionsOpen(nextDraft.trim().length > 0)
                }}
                onFocus={() => {
                  if (draft.trim()) setSuggestionsOpen(true)
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
                  if (isSelectingSuggestionRef.current) return
                  setSuggestionsOpen(false)
                  if (draft.trim()) commitTags(draft)
                }}
                role="combobox"
                aria-autocomplete="list"
                aria-haspopup="listbox"
                aria-controls={popupOpen ? suggestionListId : undefined}
                aria-expanded={popupOpen}
                aria-activedescendant={activeSuggestionId}
                aria-describedby={describedBy || undefined}
                aria-invalid={!!errorMessage}
                placeholder={
                  tags.length === 0 ? placeholder : "Add another tag"
                }
              />
              {draft.trim() && (
                <Button
                  type="button"
                  variant="muted"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    commitTags(draft)
                    inputRef.current?.focus()
                  }}
                >
                  Add
                </Button>
              )}
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            sideOffset={6}
            collisionPadding={8}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerDownCapture={beginSuggestionPointerSelection}
            onPointerUpCapture={resetSuggestionPointerState}
            onPointerCancel={resetSuggestionPointerState}
            onTouchStartCapture={beginSuggestionTouchSelection}
            onTouchMoveCapture={() => {
              suggestionTouchMovedRef.current = true
            }}
            onTouchEndCapture={resetSuggestionTouchState}
            onTouchCancel={() => {
              suggestionTouchMovedRef.current = false
              resetSuggestionPointerState()
            }}
            className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border-[var(--border-overlay)] bg-[var(--surface-overlay)] p-1"
          >
            <CommandList
              ref={handleSuggestionListRef}
              className="max-h-[min(14rem,var(--radix-popover-content-available-height))] overscroll-contain"
            >
              <CommandGroup heading="From your catalog">
                {suggestions.map((suggestion) => (
                  <CommandItem
                    key={suggestion.tag}
                    ref={(element) => {
                      if (element) {
                        suggestionItemRefs.current.set(suggestion.tag, element)
                      } else {
                        suggestionItemRefs.current.delete(suggestion.tag)
                      }
                    }}
                    value={suggestion.tag}
                    onSelect={() => commitSuggestion(suggestion.tag)}
                    onTouchEnd={(event) => {
                      if (suggestionTouchMovedRef.current) return
                      event.preventDefault()
                      commitSuggestion(suggestion.tag)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {suggestion.tag}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">
                      {suggestion.count}{" "}
                      {suggestion.count === 1 ? "listing" : "listings"}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </PopoverContent>
        </Command>
      </Popover>

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
        Tags organize your store categories and help buyers search. Reuse a
        consistent strategy across listings. Minimum 3; aim for{" "}
        {RECOMMENDED_MIN_PRODUCT_TAG_COUNT}–{RECOMMENDED_MAX_PRODUCT_TAG_COUNT}.{" "}
        {tags.length}/{MAX_PRODUCT_TAG_COUNT} tags used,{" "}
        {MAX_PRODUCT_TAG_LENGTH} characters max each. Press comma, Enter, or
        Add.
      </div>
    </div>
  )
}
