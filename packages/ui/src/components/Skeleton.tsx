import { type HTMLAttributes } from "react"
import { cn } from "../utils"

function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-[var(--surface-elevated)]", className)}
      {...props}
    />
  )
}

export { Skeleton }
