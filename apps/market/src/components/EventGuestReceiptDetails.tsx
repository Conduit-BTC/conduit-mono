import { Input, Label } from "@conduit/ui"

/** Private possession details are shown in Orders only after payment verification. */
export function EventGuestReceiptDetails({
  label,
  onLabelChange,
}: {
  label: string
  onLabelChange: (value: string) => void
}) {
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
        We’ll check that your private receipt is saved on this device before
        sending the order. You can view it and optionally save a copy after
        payment is verified. Keep it private: anyone with its code can present
        it. The receipt is not proof of payment or a guaranteed refund. No
        contact details or reply inbox are shared.
      </p>
    </div>
  )
}
