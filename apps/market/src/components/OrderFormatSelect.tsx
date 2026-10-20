import type { OrderWireFormat } from "@conduit/core"
import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"

export function OrderFormatSelect({
  value,
  onChange,
  disabled,
}: {
  value: OrderWireFormat
  onChange(value: OrderWireFormat): void
  disabled: boolean
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="checkout-order-format">Order compatibility</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === "conduit" || value === "open_markets") onChange(value)
        }}
      >
        <SelectTrigger
          id="checkout-order-format"
          aria-describedby="checkout-order-format-help"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="open_markets">Open Markets</SelectItem>
          <SelectItem value="conduit">Conduit</SelectItem>
        </SelectContent>
      </Select>
      <p
        id="checkout-order-format-help"
        className="text-pretty text-sm text-[var(--text-muted)]"
      >
        This choice is saved for this order and its replies. Choose Conduit if
        the seller requests it. Orders with larger shipping records use Conduit
        automatically to preserve all shipping details.
      </p>
    </div>
  )
}
