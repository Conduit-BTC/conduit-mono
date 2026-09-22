import {
  createContext,
  useContext,
  useId,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from "react"
import { cn } from "../utils"

interface CollapsibleContextValue {
  contentId: string
  open: boolean
  setOpen: (open: boolean) => void
}

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null)

function useCollapsibleContext(): CollapsibleContextValue {
  const context = useContext(CollapsibleContext)
  if (!context) {
    throw new Error("Collapsible components must be used inside Collapsible.")
  }
  return context
}

export interface CollapsibleProps extends HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Collapsible({
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  className,
  children,
  ...props
}: CollapsibleProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const contentId = useId()
  const open = controlledOpen ?? uncontrolledOpen
  const contextValue = useMemo<CollapsibleContextValue>(
    () => ({
      contentId,
      open,
      setOpen(nextOpen: boolean): void {
        if (controlledOpen === undefined) setUncontrolledOpen(nextOpen)
        onOpenChange?.(nextOpen)
      },
    }),
    [contentId, controlledOpen, onOpenChange, open]
  )

  return (
    <CollapsibleContext.Provider value={contextValue}>
      <div
        data-state={open ? "open" : "closed"}
        className={cn(className)}
        {...props}
      >
        {children}
      </div>
    </CollapsibleContext.Provider>
  )
}

export function CollapsibleTrigger({
  className,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { contentId, open, setOpen } = useCollapsibleContext()
  return (
    <button
      {...props}
      type="button"
      aria-controls={contentId}
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) setOpen(!open)
      }}
    />
  )
}

export function CollapsibleContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const { contentId, open } = useCollapsibleContext()
  return (
    <div
      {...props}
      id={contentId}
      data-state={open ? "open" : "closed"}
      hidden={!open}
      className={cn(className)}
    />
  )
}
