import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import type { ProductFulfillmentChoice } from "../lib/productForm"

export function ProductFulfillmentEditor({
  intent,
  onIntentChange,
}: {
  intent: ProductFulfillmentChoice
  onIntentChange: (intent: ProductFulfillmentChoice) => void
}) {
  return (
    <div className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 sm:col-span-4">
      <Label htmlFor="product-fulfillment">Shop fulfillment</Label>
      <Select
        value={intent}
        onValueChange={(value) =>
          onIntentChange(value as ProductFulfillmentChoice)
        }
      >
        <SelectTrigger id="product-fulfillment">
          <SelectValue placeholder="Choose fulfillment" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="digital">Digital</SelectItem>
          <SelectItem value="ship">Physical product</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-[var(--text-muted)]">
        Event pickup uses your approved event assignment. Your shop shipping
        terms remain available.
      </p>
    </div>
  )
}
