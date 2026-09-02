import {
  AlertCircle,
  CheckCircle2,
  CircleSlash2,
  Loader2,
  PencilLine,
  TriangleAlert,
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
  | "partial"
  | "confirmation_pending"
  | "cancelled"
  | "error"

const defaultMessages: Record<
  Exclude<SignedActionStatusState, "idle">,
  string
> = {
  dirty: "Save changes to publish this signed update.",
  awaiting_signature: "Confirm this request in your signer.",
  publishing: "Publishing the signed event to relays.",
  success: "Signed and saved.",
  partial: "The signed event was accepted by only part of the relay plan.",
  confirmation_pending: "Relay acceptance is waiting for fresh read-back.",
  cancelled: "Signing was cancelled. Local edits were retained.",
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
    case "partial":
    case "confirmation_pending":
      return {
        Icon: TriangleAlert,
        className: "text-[var(--warning)]",
        iconClassName: "text-[var(--warning)]",
      }
    case "cancelled":
      return {
        Icon: CircleSlash2,
        className: "text-[var(--text-secondary)]",
        iconClassName: "text-[var(--text-muted)]",
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
  partialMessage?: ReactNode
  confirmationPendingMessage?: ReactNode
  cancelledMessage?: ReactNode
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
  partialMessage,
  confirmationPendingMessage,
  cancelledMessage,
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
            : state === "partial"
              ? partialMessage
              : state === "confirmation_pending"
                ? confirmationPendingMessage
                : state === "cancelled"
                  ? cancelledMessage
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
