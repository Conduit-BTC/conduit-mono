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
import { Popover, PopoverContent, PopoverTrigger } from "./Popover"

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
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const selectedOption = options.find((option) => option.value === value)
  const label = selectedLabel ?? selectedOption?.label

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
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn(
          "w-[--radix-popover-trigger-width] p-0",
          contentClassName
        )}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={
                    option.searchText ?? `${option.meta ?? ""} ${option.label}`
                  }
                  disabled={option.disabled}
                  onSelect={() => {
                    onValueChange(option.value)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      "h-4 w-4",
                      value === option.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {option.meta ? (
                    <span className="w-8 shrink-0 text-xs font-mono text-[var(--text-muted)]">
                      {option.meta}
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
