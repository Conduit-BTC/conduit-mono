import {
  createEventGuestReceipt,
  formatEventGuestReceipt,
  type EventGuestReceipt,
} from "@conduit/core"
import { Button, Checkbox, Input, Label, QRCodeSVG } from "@conduit/ui"

export type EventGuestReceiptDraft = {
  receipt: EventGuestReceipt
  scope: string
  saved: boolean
}
export function EventGuestReceiptDetails({
  merchantPubkey,
  scope,
  label,
  onLabelChange,
  draft,
  onDraftChange,
}: {
  merchantPubkey: string
  scope: string
  label: string
  onLabelChange: (value: string) => void
  draft: EventGuestReceiptDraft | null
  onDraftChange: (value: EventGuestReceiptDraft) => void
}) {
  function show() {
    const receipt =
      draft?.scope === scope
        ? draft.receipt
        : createEventGuestReceipt(merchantPubkey)
    onDraftChange({
      receipt,
      scope,
      saved: draft?.scope === scope ? draft.saved : false,
    })
    return receipt
  }
  function save() {
    const receipt = show()
    const url = URL.createObjectURL(
      new Blob([formatEventGuestReceipt(receipt)], {
        type: "text/plain;charset=utf-8",
      })
    )
    const link = document.createElement("a")
    link.href = url
    link.download = "conduit-event-receipt.txt"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const current = draft?.scope === scope ? draft : null
  return (
    <div className="space-y-3">
      <Label htmlFor="event-handoff-name">Name or pseudonym for handoff</Label>
      <Input
        id="event-handoff-name"
        value={label}
        maxLength={80}
        onChange={(event) => onLabelChange(event.target.value)}
        autoComplete="off"
      />
      <p className="text-sm text-[var(--text-secondary)]">
        Keep your private receipt for pickup and support. Anyone with the code
        can present it, so keep it private. For a lost receipt or a refund,
        speak with the seller or organizer; the receipt is not proof of payment
        or a guaranteed refund. No contact details or reply inbox are shared.
      </p>
      <div className="flex flex-wrap gap-2">
        {!current ? (
          <Button type="button" variant="outline" onClick={show}>
            Show private receipt
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={save}>
          Save event receipt
        </Button>
      </div>
      {current ? (
        <>
          <section
            aria-label="Private pickup receipt"
            className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-4"
          >
            <h3 className="font-semibold">Private pickup receipt</h3>
            <p className="text-sm">
              Save a screenshot or download a copy before continuing. Show it
              only to the seller or organizer.
            </p>
            <p className="break-all text-xs">
              Order: {current.receipt.orderId}
            </p>
            <QRCodeSVG
              value={current.receipt.claimSecret}
              size={160}
              marginSize={4}
              title="Private receipt code"
            />
            <Label htmlFor="event-private-receipt-code">
              Private receipt code
            </Label>
            <Input
              id="event-private-receipt-code"
              value={current.receipt.claimSecret}
              readOnly
              autoComplete="off"
            />
            <p className="text-xs text-[var(--text-muted)]">
              This receipt is not proof of payment. Keep the code private.
            </p>
          </section>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={current.saved}
              onCheckedChange={(checked) =>
                onDraftChange({ ...current, saved: checked === true })
              }
            />
            I saved my private receipt
          </label>
        </>
      ) : null}
    </div>
  )
}
