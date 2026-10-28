import { Checkbox, Label } from "@conduit/ui"

export function ProductEventOnlyField({
  checked,
  format,
  malformed,
  onChange,
}: {
  checked: boolean
  format: "physical" | "digital"
  malformed: boolean
  onChange: (checked: boolean) => void
}) {
  if (format !== "physical" && !checked && !malformed) return null
  return (
    <div className="grid gap-2 rounded-[var(--radius-md)] border border-[var(--border)] p-3">
      <div className="flex items-center gap-2">
        <Checkbox
          id="product-event-only"
          checked={checked}
          onCheckedChange={(value) => onChange(value === true)}
          aria-describedby="product-event-only-help"
        />
        <Label htmlFor="product-event-only">Sell only at events</Label>
      </div>
      <p
        id="product-event-only-help"
        className="text-xs leading-5 text-[var(--text-muted)]"
      >
        Keep this physical product out of your regular shop. To sell at an
        event, you still need its approved product assignment. Turning this off
        for an event-only product makes it available in your regular shop.
      </p>
      {checked && format !== "physical" ? (
        <p role="alert" className="text-xs text-[var(--error-text)]">
          Choose a physical product or turn off Sell only at events before
          publishing.
        </p>
      ) : null}
      {malformed ? (
        <p className="text-xs text-[var(--warning-text)]">
          The saved event-only setting needs review. Change this option
          deliberately to repair it; other edits keep the existing setting.
        </p>
      ) : null}
    </div>
  )
}
