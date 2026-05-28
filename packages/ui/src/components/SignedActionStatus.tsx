import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  PencilLine,
  Upload,
} from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "../utils"

export type SignedActionStatusState =
  | "idle"
  | "dirty"
  | "awaiting_signature"
  | "publishing"
  | "success"
  | "error"

const defaultMessages: Record<
  Exclude<SignedActionStatusState, "idle">,
  string
> = {
  dirty: "Save changes to publish this signed update.",
  awaiting_signature: "Confirm this request in your signer.",
  publishing: "Publishing the signed event to relays.",
  success: "Signed and saved.",
  error: "Something went wrong.",
}

function getStateMeta(state: SignedActionStatusState) {
  switch (state) {
    case "dirty":
      return {
        Icon: PencilLine,
        className: "text-[var(--warning)]",
        iconClassName: "text-[var(--warning)]",
      }
    case "awaiting_signature":
      return {
        Icon: Loader2,
        className: "text-[var(--text-secondary)]",
        iconClassName: "animate-spin text-[var(--secondary-500)]",
      }
    case "publishing":
      return {
        Icon: Upload,
        className: "text-[var(--text-secondary)]",
        iconClassName: "text-[var(--secondary-500)]",
      }
    case "success":
      return {
        Icon: CheckCircle2,
        className: "text-[var(--success)]",
        iconClassName: "text-[var(--success)]",
      }
    case "error":
      return {
        Icon: AlertCircle,
        className: "text-[var(--error)]",
        iconClassName: "text-[var(--error)]",
      }
    default:
      return null
  }
}

export interface SignedActionStatusProps {
  state: SignedActionStatusState
  message?: ReactNode
  dirtyMessage?: ReactNode
  awaitingSignatureMessage?: ReactNode
  publishingMessage?: ReactNode
  successMessage?: ReactNode
  errorMessage?: ReactNode
  className?: string
}

export function SignedActionStatus({
  state,
  message,
  dirtyMessage,
  awaitingSignatureMessage,
  publishingMessage,
  successMessage,
  errorMessage,
  className,
}: SignedActionStatusProps) {
  if (state === "idle" && !message) return null

  const stateMeta = getStateMeta(state)
  const Icon = stateMeta?.Icon
  const stateMessage =
    message ??
    (state === "dirty"
      ? dirtyMessage
      : state === "awaiting_signature"
        ? awaitingSignatureMessage
        : state === "publishing"
          ? publishingMessage
          : state === "success"
            ? successMessage
            : state === "error"
              ? errorMessage
              : null) ??
    (state === "idle" ? null : defaultMessages[state])

  if (!stateMessage) return null

  return (
    <div
      aria-live="polite"
      className={cn(
        "inline-flex min-h-5 items-center gap-1.5 text-sm leading-5",
        stateMeta?.className ?? "text-[var(--text-secondary)]",
        className
      )}
    >
      {Icon && (
        <Icon
          className={cn("h-4 w-4 shrink-0", stateMeta?.iconClassName)}
          aria-hidden="true"
        />
      )}
      <span>{stateMessage}</span>
    </div>
  )
}
