import { createEventGuestReceipt, type EventGuestReceipt } from "@conduit/core"
import { Button, Checkbox, Input, Label } from "@conduit/ui"

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
  function save() {
    const receipt =
      draft?.scope === scope
        ? draft.receipt
        : createEventGuestReceipt(merchantPubkey)
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(receipt)], { type: "application/json" })
    )
    const link = document.createElement("a")
    link.href = url
    link.download = "conduit-event-receipt.json"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    onDraftChange({ receipt, scope, saved: false })
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
        The merchant cannot contact you later. Keep this private receipt for
        support, refunds or rebates; arrange any payment back with the merchant
        in person. It is not proof of payment or a guaranteed refund. Anyone
        with the file can present it. No reply inbox is created.
      </p>
      <Button type="button" variant="outline" onClick={save}>
        Save event receipt
      </Button>
      {current ? (
        <label className="flex items-center gap-2">
          <Checkbox
            checked={current.saved}
            onCheckedChange={(checked) =>
              onDraftChange({ ...current, saved: checked === true })
            }
          />
          I saved my receipt and understand the trade-off
        </label>
      ) : null}
    </div>
  )
}
