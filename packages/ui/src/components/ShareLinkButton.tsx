import { Check, CircleAlert, Copy, Share2 } from "lucide-react"
import { useEffect, useId, useState, type MouseEventHandler } from "react"
import { Button, type ButtonProps } from "./Button"
import { cn } from "../utils"

type ShareLinkState = "idle" | "shared" | "copy_ready" | "copied" | "copy_error"

export interface ShareLinkButtonProps extends Omit<
  ButtonProps,
  "children" | "onClick" | "type"
> {
  url: string
  shareTitle: string
  shareText?: string
  idleLabel?: string
  sharedLabel?: string
  copyLabel?: string
  copiedLabel?: string
  errorLabel?: string
  onShareClick?: MouseEventHandler<HTMLButtonElement>
}

function isShareCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  )
}

function canUseNativeShare(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    window.matchMedia("(max-width: 767px)").matches
  )
}

export function ShareLinkButton({
  url,
  shareTitle,
  shareText,
  idleLabel = "Share",
  sharedLabel = "Shared",
  copyLabel = "Copy link",
  copiedLabel = "Copied",
  errorLabel = "Try copy again",
  onShareClick,
  className,
  variant = "outline",
  size = "sm",
  "aria-describedby": ariaDescribedBy,
  ...buttonProps
}: ShareLinkButtonProps) {
  const [state, setState] = useState<ShareLinkState>("idle")
  const statusId = useId()

  useEffect(() => {
    if (state !== "shared" && state !== "copied") return
    const timeoutId = window.setTimeout(() => setState("idle"), 1_800)
    return () => window.clearTimeout(timeoutId)
  }, [state])

  async function copyLink(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable")
      }
      await navigator.clipboard.writeText(url)
      setState("copied")
    } catch {
      setState("copy_error")
    }
  }

  async function shareLink(): Promise<void> {
    if (state === "copy_ready" || state === "copy_error") {
      await copyLink()
      return
    }

    setState("idle")
    if (canUseNativeShare()) {
      try {
        await navigator.share({ title: shareTitle, text: shareText, url })
        setState("shared")
        return
      } catch (error) {
        if (isShareCancellation(error)) return
        setState("copy_ready")
        return
      }
    }

    await copyLink()
  }

  const label =
    state === "shared"
      ? sharedLabel
      : state === "copy_ready"
        ? copyLabel
        : state === "copied"
          ? copiedLabel
          : state === "copy_error"
            ? errorLabel
            : idleLabel
  const statusMessage =
    state === "shared"
      ? `${shareTitle} link shared.`
      : state === "copy_ready"
        ? `Sharing was unavailable. Select ${copyLabel} to copy the ${shareTitle} link.`
        : state === "copied"
          ? `${shareTitle} link copied.`
          : state === "copy_error"
            ? `Could not copy the ${shareTitle} link. Try again.`
            : ""
  const accessibleLabel =
    state === "idle"
      ? (buttonProps["aria-label"] ?? `${idleLabel} ${shareTitle}`)
      : `${label} ${shareTitle}`

  return (
    <>
      <Button
        {...buttonProps}
        type="button"
        variant={variant}
        size={size}
        className={cn(state === "copy_error" && "text-error", className)}
        aria-label={accessibleLabel}
        aria-describedby={
          ariaDescribedBy ? `${ariaDescribedBy} ${statusId}` : statusId
        }
        onClick={(event) => {
          onShareClick?.(event)
          if (!event.defaultPrevented) void shareLink()
        }}
      >
        {state === "shared" || state === "copied" ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : state === "copy_ready" ? (
          <Copy className="size-3.5" aria-hidden="true" />
        ) : state === "copy_error" ? (
          <CircleAlert className="size-3.5" aria-hidden="true" />
        ) : (
          <Share2 className="size-3.5" aria-hidden="true" />
        )}
        {label}
      </Button>
      <span id={statusId} role="status" aria-live="polite" className="sr-only">
        {statusMessage}
      </span>
    </>
  )
}
