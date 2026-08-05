import { type ReactNode } from "react"
import { cn } from "../utils"

export interface ConversationCardScrollerProps {
  children: ReactNode
  className?: string
  contentClassName?: string
  label?: string
}

export function ConversationCardScroller({
  children,
  className,
  contentClassName,
  label = "Conversations",
}: ConversationCardScrollerProps) {
  return (
    <div
      role="region"
      aria-label={label}
      className={cn(
        "w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
      style={{
        maskImage:
          "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
      }}
    >
      <div
        className={cn(
          "flex min-w-max snap-x snap-mandatory gap-3 pb-1 pr-14",
          contentClassName
        )}
      >
        {children}
      </div>
    </div>
  )
}
