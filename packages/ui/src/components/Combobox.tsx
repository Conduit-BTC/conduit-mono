import { Check, ChevronsUpDown } from "lucide-react"
import { useState } from "react"
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
  const selectedOption = options.find((option) => option.value === value)
  const label = selectedLabel ?? selectedOption?.label
  const optionList = (
    <CommandList className={listClassName}>
      <CommandEmpty>{emptyText}</CommandEmpty>
      <CommandGroup>
        {options.map((option) => (
          <CommandItem
            key={option.value}
            value={option.searchText ?? `${option.meta ?? ""} ${option.label}`}
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
    </CommandList>
  )

  if (searchInTrigger) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <Command className="overflow-visible rounded-none bg-transparent">
          <PopoverAnchor asChild>
            <div
              className={cn(
                "flex h-10 w-full items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)] focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 focus-within:ring-offset-[var(--background)]",
                invalid && "border-error/50 focus-within:ring-error/30",
                disabled && "cursor-not-allowed opacity-50",
                className,
                triggerClassName
              )}
            >
              <CommandInput
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
                aria-expanded={open}
                aria-invalid={invalid || undefined}
                wrapperClassName="min-w-0 flex-1 border-0 px-3"
                className="h-full py-0"
              />
              <ChevronsUpDown
                className="mr-3 h-4 w-4 shrink-0 opacity-50"
                aria-hidden="true"
              />
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            collisionPadding={8}
            onOpenAutoFocus={(event) => event.preventDefault()}
            className={cn(
              "w-[--radix-popover-trigger-width] p-0",
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
    <Popover open={open} onOpenChange={setOpen}>
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
          "w-[--radix-popover-trigger-width] p-0",
          contentClassName
        )}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          {optionList}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
