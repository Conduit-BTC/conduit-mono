import * as React from "react"
import { LoaderCircle } from "lucide-react"
import { cn } from "../utils"
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar"
import { Badge } from "./Badge"

export interface SearchSuggestionItem {
  id: string
  label: string
  description?: string
  badge?: string
  imageUrl?: string
  fallback?: React.ReactNode
}

export function getSearchSuggestionOptionId(
  listboxId: string,
  index: number
): string {
  return `${listboxId}-option-${index}`
}

/**
 * ARIA combobox attributes for a free-text input whose suggestions live in a
 * `SearchSuggestions` listbox. The input keeps its own submit behavior.
 */
export function getSearchSuggestionInputProps(input: {
  listboxId: string
  open: boolean
  activeIndex: number
}): Pick<
  React.InputHTMLAttributes<HTMLInputElement>,
  | "role"
  | "aria-expanded"
  | "aria-controls"
  | "aria-autocomplete"
  | "aria-activedescendant"
  | "aria-haspopup"
> {
  return {
    role: "combobox",
    "aria-haspopup": "listbox",
    "aria-autocomplete": "list",
    "aria-expanded": input.open,
    "aria-controls": input.open ? input.listboxId : undefined,
    "aria-activedescendant":
      input.open && input.activeIndex >= 0
        ? getSearchSuggestionOptionId(input.listboxId, input.activeIndex)
        : undefined,
  }
}

export interface UseSearchSuggestionKeyboardInput {
  open: boolean
  count: number
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelectActive: () => void
  onDismiss: () => void
}

/**
 * Keyboard handling for the input that owns a suggestion listbox. Enter is
 * only consumed while an option is active so the surrounding form keeps its
 * default submit behavior.
 */
export function useSearchSuggestionKeyboard(
  input: UseSearchSuggestionKeyboardInput
): (event: React.KeyboardEvent<HTMLInputElement>) => void {
  const {
    open,
    count,
    activeIndex,
    onActiveIndexChange,
    onSelectActive,
    onDismiss,
  } = input
  return React.useCallback(
    (event) => {
      if (!open || count === 0) {
        if (event.key === "Escape" && open) {
          event.preventDefault()
          onDismiss()
        }
        return
      }
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault()
          onActiveIndexChange(activeIndex >= count - 1 ? 0 : activeIndex + 1)
          return
        case "ArrowUp":
          event.preventDefault()
          onActiveIndexChange(activeIndex <= 0 ? count - 1 : activeIndex - 1)
          return
        case "Escape":
          event.preventDefault()
          onDismiss()
          return
        case "Enter":
          if (activeIndex >= 0) {
            event.preventDefault()
            onSelectActive()
          }
          return
        default:
          return
      }
    },
    [activeIndex, count, onActiveIndexChange, onDismiss, onSelectActive, open]
  )
}

export interface SearchSuggestionsProps {
  id: string
  items: readonly SearchSuggestionItem[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (item: SearchSuggestionItem, index: number) => void
  heading?: string
  ariaLabel?: string
  loading?: boolean
  emptyMessage?: React.ReactNode
  footer?: React.ReactNode
  className?: string
}

export function SearchSuggestions({
  id,
  items,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  heading,
  ariaLabel,
  loading = false,
  emptyMessage,
  footer,
  className,
}: SearchSuggestionsProps) {
  const activeRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-overlay)] shadow-[var(--shadow-md)]",
        className
      )}
    >
      {heading ? (
        <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          <span>{heading}</span>
          {loading ? (
            <LoaderCircle
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
        </div>
      ) : null}
      <div
        id={id}
        role="listbox"
        aria-label={ariaLabel ?? heading}
        className="max-h-80 overflow-y-auto p-1"
      >
        {items.length === 0 && emptyMessage ? (
          <div className="px-3 py-2 text-sm text-[var(--text-muted)]">
            {emptyMessage}
          </div>
        ) : null}
        {items.map((item, index) => {
          const active = index === activeIndex
          return (
            <div
              key={item.id}
              id={getSearchSuggestionOptionId(id, index)}
              ref={active ? activeRef : undefined}
              role="option"
              aria-selected={active}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActiveIndexChange(index)}
              onClick={() => onSelect(item, index)}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors",
                "text-[var(--text-primary)]",
                active ? "bg-[var(--muted)]" : "hover:bg-[var(--muted)]"
              )}
            >
              <Avatar className="size-8 shrink-0">
                {item.imageUrl ? (
                  <AvatarImage src={item.imageUrl} alt="" />
                ) : null}
                <AvatarFallback className="bg-[var(--avatar-bg)] text-xs text-white">
                  {item.fallback ?? item.label.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{item.label}</span>
                {item.description ? (
                  <span className="truncate text-xs text-[var(--text-muted)]">
                    {item.description}
                  </span>
                ) : null}
              </span>
              {item.badge ? (
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {item.badge}
                </Badge>
              ) : null}
            </div>
          )
        })}
      </div>
      {footer ? (
        <div className="border-t border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
          {footer}
        </div>
      ) : null}
    </div>
  )
}
