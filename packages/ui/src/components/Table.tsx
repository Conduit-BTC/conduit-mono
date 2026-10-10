import { forwardRef, type ComponentPropsWithoutRef } from "react"
import { cn } from "../utils"

/** Keep semantic table markup. The named scroll region is keyboard reachable. */
export const Table = forwardRef<
  HTMLTableElement,
  ComponentPropsWithoutRef<"table"> & {
    scrollLabel: string
    density?: "comfortable" | "compact"
  }
>(function Table(
  { scrollLabel, density = "comfortable", className, ...props },
  ref
) {
  return (
    <div
      role="region"
      aria-label={scrollLabel}
      tabIndex={0}
      className="max-w-full overflow-x-auto border-y border-[var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <table
        ref={ref}
        className={cn(
          "w-full text-left text-sm leading-normal [&_td]:px-4 [&_th]:px-4",
          density === "compact"
            ? "[&_td]:py-2 [&_th]:py-2"
            : "[&_td]:py-4 [&_th]:py-3",
          className
        )}
        {...props}
      />
    </div>
  )
})
export function TableHeader(props: ComponentPropsWithoutRef<"thead">) {
  return <thead {...props} />
}
export function TableBody(props: ComponentPropsWithoutRef<"tbody">) {
  return <tbody {...props} />
}
export function TableRow({
  className,
  ...props
}: ComponentPropsWithoutRef<"tr">) {
  return (
    <tr
      className={cn(
        "border-b border-[var(--border)] last:border-b-0 data-[selected=true]:bg-[var(--surface-elevated)]",
        className
      )}
      {...props}
    />
  )
}
export function TableHead({
  className,
  scope = "col",
  ...props
}: ComponentPropsWithoutRef<"th">) {
  return (
    <th
      scope={scope}
      className={cn(
        "bg-[var(--surface-elevated)] font-medium text-[var(--text-secondary)]",
        className
      )}
      {...props}
    />
  )
}
export function TableCell({
  className,
  ...props
}: ComponentPropsWithoutRef<"td">) {
  return <td className={cn("align-top tabular-nums", className)} {...props} />
}
export function TableCaption({
  className,
  ...props
}: ComponentPropsWithoutRef<"caption">) {
  return (
    <caption
      className={cn(
        "px-4 py-3 text-left text-pretty text-sm text-[var(--text-secondary)]",
        className
      )}
      {...props}
    />
  )
}
