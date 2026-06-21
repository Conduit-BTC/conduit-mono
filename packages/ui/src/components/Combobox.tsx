import { Check, ChevronsUpDown } from "lucide-react"
import { type ElementRef, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "../utils"
import { Button } from "./Button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./Command"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "./Popover"

export type ComboboxOption = {
  value: string
  label: string
  meta?: string
  searchText?: string
  disabled?: boolean
}

export interface ComboboxProps {
  id?: string
  value?: string
  options: ComboboxOption[]
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  invalid?: boolean
  selectedLabel?: string
  className?: string
  triggerClassName?: string
  contentClassName?: string
  listClassName?: string
  searchInTrigger?: boolean
}

function normalizeComboboxSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

function getSearchScore(option: ComboboxOption, query: string): number | null {
  const label = normalizeComboboxSearch(option.label)
  const meta = normalizeComboboxSearch(option.meta ?? "")
  const searchText = normalizeComboboxSearch(
    option.searchText ?? `${option.meta ?? ""} ${option.label}`
  )
  const labelWords = label.split(/\s+/).filter(Boolean)

  if (meta === query || label === query) return 0
  if (label.startsWith(query)) return 1
  if (labelWords.some((word) => word.startsWith(query))) return 2
  if (meta.startsWith(query)) return 3
  if (searchText.startsWith(query)) return 4
  if (label.includes(query)) return 5
  if (searchText.includes(query)) return 6
  return null
}

export function getFilteredComboboxOptions(
  options: ComboboxOption[],
  search: string
): ComboboxOption[] {
  const query = normalizeComboboxSearch(search)
  if (!query) return options

  return options
    .map((option, index) => ({
      index,
      option,
      score: getSearchScore(option, query),
    }))
    .filter(
      (
        entry
      ): entry is {
        index: number
        option: ComboboxOption
        score: number
      } => entry.score !== null
    )
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.option)
}

export function Combobox({
  id,
  value,
  options,
  onValueChange,
  placeholder = "Select option...",
  searchPlaceholder = "Search...",
  emptyText = "No options found.",
  disabled = false,
  invalid = false,
  selectedLabel,
  className,
  triggerClassName,
  contentClassName,
  listClassName,
  searchInTrigger = false,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [activeValue, setActiveValue] = useState("")
  const listRef = useRef<ElementRef<typeof CommandList>>(null)
  const inputRef = useRef<ElementRef<typeof CommandInput>>(null)
  const selectedOption = options.find((option) => option.value === value)
  const label = selectedLabel ?? selectedOption?.label
  const filteredOptions = useMemo(
    () => getFilteredComboboxOptions(options, search),
    [options, search]
  )

  useEffect(() => {
    if (!open) return
    const selectedValue =
      !search &&
      value &&
      filteredOptions.some((option) => option.value === value)
        ? value
        : filteredOptions[0]?.value
    setActiveValue(selectedValue ?? "")
    const list = listRef.current
    if (!list) return

    const resetScroll = () => {
      list.scrollTop = 0
    }
    const frames: number[] = []
    resetScroll()
    frames.push(
      window.requestAnimationFrame(() => {
        resetScroll()
        frames.push(window.requestAnimationFrame(resetScroll))
      })
    )
    return () => {
      frames.forEach((frame) => window.cancelAnimationFrame(frame))
    }
  }, [filteredOptions, open, search, value])

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen)
    if (!nextOpen) setSearch("")
  }

  function focusSearchInput(): void {
    if (disabled) return
    setOpen(true)
    inputRef.current?.focus()
  }

  const optionList = (
    <CommandList
      key={normalizeComboboxSearch(search)}
      ref={listRef}
      className={listClassName}
    >
      {filteredOptions.length === 0 ? (
        <CommandEmpty>{emptyText}</CommandEmpty>
      ) : (
        <CommandGroup>
          {filteredOptions.map((option) => (
            <CommandItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              onSelect={() => {
                onValueChange(option.value)
                setSearch("")
                setOpen(false)
              }}
            >
              <Check
                className={cn(
                  "h-4 w-4",
                  value === option.value ? "opacity-100" : "opacity-0"
                )}
                aria-hidden="true"
              />
              {option.meta ? (
                <span className="w-8 shrink-0 font-mono text-xs text-[var(--text-muted)]">
                  {option.meta}
                </span>
              ) : null}
              <span className="min-w-0 truncate">{option.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </CommandList>
  )

  if (searchInTrigger) {
    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Command
          shouldFilter={false}
          value={activeValue}
          onValueChange={setActiveValue}
          className="overflow-visible rounded-none bg-transparent"
        >
          <PopoverAnchor asChild>
            <div
              className={cn(
                "flex h-10 w-full cursor-text items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)] focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 focus-within:ring-offset-[var(--background)]",
                invalid && "border-error/50 focus-within:ring-error/30",
                disabled && "cursor-not-allowed opacity-50",
                className,
                triggerClassName
              )}
              data-combobox-search-trigger=""
              onMouseDown={(event) => {
                if (event.target === inputRef.current) return
                event.preventDefault()
                focusSearchInput()
              }}
              onClick={focusSearchInput}
            >
              <CommandInput
                ref={inputRef}
                id={id}
                value={search}
                onValueChange={(next) => {
                  setSearch(next)
                  if (!open) setOpen(true)
                }}
                onFocus={() => setOpen(true)}
                onClick={() => setOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setOpen(false)
                }}
                placeholder={label ?? searchPlaceholder ?? placeholder}
                disabled={disabled}
                aria-label={searchPlaceholder ?? placeholder}
                aria-expanded={open}
                aria-invalid={invalid || undefined}
                wrapperClassName="flex h-full min-w-0 flex-1 border-0 px-3"
                className="h-full py-0 text-sm leading-6"
              />
              <ChevronsUpDown
                className="pointer-events-none mr-3 h-4 w-4 shrink-0 opacity-50"
                aria-hidden="true"
              />
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            collisionPadding={8}
            onOpenAutoFocus={(event) => event.preventDefault()}
            className={cn(
              "w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-1rem)] p-0",
              contentClassName
            )}
          >
            {optionList}
          </PopoverContent>
        </Command>
      </Popover>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          className={cn(
            "w-full justify-between bg-[var(--surface)] px-3 font-normal text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)]",
            !label && "text-[var(--text-muted)]",
            invalid &&
              "border-error/50 focus-visible:ring-error/30 data-[state=open]:border-error",
            className,
            triggerClassName
          )}
        >
          <span className="min-w-0 truncate">{label ?? placeholder}</span>
          <ChevronsUpDown
            className="h-4 w-4 shrink-0 opacity-50"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className={cn(
          "w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-1rem)] p-0",
          contentClassName
        )}
      >
        <Command
          shouldFilter={false}
          value={activeValue}
          onValueChange={setActiveValue}
        >
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder}
          />
          {optionList}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
