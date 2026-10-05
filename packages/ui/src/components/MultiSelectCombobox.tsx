import { Check, ChevronDown } from "lucide-react"
import { useRef, type ReactNode } from "react"
import { cn } from "../utils"
import { Button } from "./Button"
import { Command, CommandInput, CommandItem, CommandList } from "./Command"
import { Popover, PopoverContent, PopoverTrigger } from "./Popover"
import { ScrollLoadMore } from "./ScrollLoadMore"

export interface MultiSelectComboboxOption {
  value: string
  label: string
  detail?: string
  icon?: ReactNode
}

/** Controlled, externally searched/paged options; cmdk owns keyboard focus. */
export function MultiSelectCombobox({
  options,
  selectedValues,
  onToggle,
  onClear,
  label,
  allLabel,
  search,
  onSearchChange,
  searchLabel,
  open,
  onOpenChange,
  hasMore,
  onLoadMore,
  status,
}: {
  options: MultiSelectComboboxOption[]
  selectedValues: readonly string[]
  onToggle: (value: string) => void
  onClear: () => void
  label: string
  allLabel: string
  search: string
  onSearchChange: (value: string) => void
  searchLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
  hasMore: boolean
  onLoadMore: () => void
  status?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const selected = new Set(selectedValues)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          className="w-full justify-between text-xs font-normal"
        >
          {label}
          <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-72 max-w-[calc(100vw-1rem)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={onSearchChange}
            placeholder={searchLabel}
            aria-label={searchLabel}
          />
          <CommandList key={search} ref={listRef} label={allLabel}>
            <CommandItem value="all" onSelect={onClear}>
              <Check
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0",
                  selected.size > 0 && "opacity-0"
                )}
              />
              <span className="font-semibold text-primary-500">{allLabel}</span>
              {selected.size === 0 ? (
                <span className="sr-only">Selected</span>
              ) : null}
            </CommandItem>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.value}
                onSelect={onToggle}
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0",
                    !selected.has(option.value) && "opacity-0"
                  )}
                />
                {option.icon}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.detail ? (
                  <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
                    {option.detail}
                  </span>
                ) : null}
                {selected.has(option.value) ? (
                  <span className="sr-only">Selected</span>
                ) : null}
              </CommandItem>
            ))}
            {hasMore ? (
              <ScrollLoadMore rootRef={listRef} onLoadMore={onLoadMore} />
            ) : null}
          </CommandList>
          {status ? (
            <p
              role="status"
              className="px-3 py-2 text-pretty text-xs text-[var(--text-muted)]"
            >
              {status}
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
