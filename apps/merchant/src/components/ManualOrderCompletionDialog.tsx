import { useState } from "react"
import type { MerchantCompletionBasis } from "@conduit/core"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@conduit/ui"

export function ManualOrderCompletionDialog({
  methods,
  buyerNotified,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  methods: MerchantCompletionBasis[]
  buyerNotified: boolean
  pending: boolean
  error: string | null
  onClose: () => void
  onConfirm: (basis: MerchantCompletionBasis, note: string) => void
}) {
  const [basis, setBasis] = useState<MerchantCompletionBasis>(methods[0]!)
  const [note, setNote] = useState("")
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Complete fulfilled order?</AlertDialogTitle>
          <AlertDialogDescription>
            Confirm only after the buyer received the items. This records your
            statement of fulfillment without tracking.
            {buyerNotified
              ? " The update will be submitted to the buyer’s inbox."
              : " This is recorded in your order history; the buyer is not notified."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {methods.length > 1 ? (
          <div className="grid gap-2">
            <Label htmlFor="completion-method">
              How was this order fulfilled?
            </Label>
            <Select
              value={basis}
              disabled={pending}
              onValueChange={(value) => {
                if (methods.includes(value as MerchantCompletionBasis))
                  setBasis(value as MerchantCompletionBasis)
              }}
            >
              <SelectTrigger id="completion-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="delivered_without_tracking">
                  Delivered, tracking unavailable
                </SelectItem>
                <SelectItem value="historical_handoff">
                  Event purchase / picked up
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">
            Delivered, tracking unavailable
          </p>
        )}
        {basis === "historical_handoff" && (
          <p className="text-sm text-[var(--text-secondary)]">
            You are confirming a past handoff. The original fulfillment type is
            unknown; this statement does not change the order or verify an event
            or organizer receipt.
          </p>
        )}
        <div className="grid gap-2">
          <Label htmlFor="completion-note">Completion note (optional)</Label>
          <Textarea
            id="completion-note"
            value={note}
            maxLength={2000}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onClose}
          >
            Keep open
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() => onConfirm(basis, note)}
          >
            {pending
              ? "Recording…"
              : basis === "historical_handoff"
                ? "Confirm picked up / complete"
                : "Confirm delivered / complete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
