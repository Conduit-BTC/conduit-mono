import { RefreshCw, Settings2, ShieldCheck } from "lucide-react"
import type { InboxDeclarationStatus } from "@conduit/core"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@conduit/ui"
import { getProductInboxPublishGuidance } from "../lib/productInboxReadiness"

export interface ProductInboxReadinessDialogProps {
  checking: boolean
  error?: string | null
  onKeepEditing: () => void
  onPublish: () => void
  onRetry: () => void
  onSetup: () => void
  open: boolean
  status: InboxDeclarationStatus
}

export function ProductInboxReadinessDialog({
  checking,
  error,
  onKeepEditing,
  onPublish,
  onRetry,
  onSetup,
  open,
  status,
}: ProductInboxReadinessDialogProps) {
  const guidance = getProductInboxPublishGuidance(status)
  const actionDisabled = guidance.action === "retry" && checking
  const action =
    guidance.action === "setup"
      ? onSetup
      : guidance.action === "retry"
        ? onRetry
        : onPublish

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onKeepEditing()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-[var(--surface-elevated)] text-primary-500 sm:mx-0">
            {guidance.action === "setup" ? (
              <Settings2 aria-hidden="true" className="size-5" />
            ) : guidance.action === "continue" ? (
              <ShieldCheck aria-hidden="true" className="size-5" />
            ) : (
              <RefreshCw aria-hidden="true" className="size-5" />
            )}
          </div>
          <AlertDialogTitle className="text-balance">
            {guidance.title}
          </AlertDialogTitle>
          <div aria-live="polite" aria-busy={checking}>
            <AlertDialogDescription className="text-pretty leading-6">
              {guidance.body}
            </AlertDialogDescription>
            {error ? (
              <p className="mt-2 text-pretty text-sm text-error">{error}</p>
            ) : null}
          </div>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <Button type="button" variant="ghost" onClick={onKeepEditing}>
            Keep editing
          </Button>
          {guidance.action !== "continue" ? (
            <Button type="button" variant="outline" onClick={onPublish}>
              Publish anyway
            </Button>
          ) : null}
          <Button type="button" onClick={action} disabled={actionDisabled}>
            {guidance.action === "retry" ? (
              <RefreshCw aria-hidden="true" className="size-4" />
            ) : null}
            {guidance.actionLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
