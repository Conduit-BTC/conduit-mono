import { Search } from "lucide-react"
import { cn } from "../utils"
import { Input, type InputProps } from "./Input"

export interface SearchInputProps extends Omit<InputProps, "type"> {
  containerClassName?: string
}

export function SearchInput({
  containerClassName,
  className,
  ...props
}: SearchInputProps) {
  return (
    <div className={cn("relative", containerClassName)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
      <Input
        type="search"
        className={cn(
          "h-11 rounded-xl pl-9 pr-3 focus-visible:ring-primary-500/30 focus-visible:ring-offset-0",
          className
        )}
        {...props}
      />
    </div>
  )
}
