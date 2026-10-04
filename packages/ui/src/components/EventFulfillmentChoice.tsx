import { Button } from "./Button"

export type EventFulfillmentSelection = "event_market_pickup" | "shipping"

export function EventFulfillmentChoice({
  value,
  onChange,
  disabled = false,
  shippingAvailable = true,
}: {
  value: EventFulfillmentSelection
  onChange: (value: EventFulfillmentSelection) => void
  disabled?: boolean
  shippingAvailable?: boolean
}) {
  return (
    <div
      role="group"
      aria-label="How would you like this item?"
      className="flex flex-wrap gap-2"
    >
      <Button
        type="button"
        size="sm"
        variant={value === "event_market_pickup" ? "primary" : "outline"}
        aria-pressed={value === "event_market_pickup"}
        disabled={disabled}
        onClick={() => onChange("event_market_pickup")}
      >
        Take it at the event
      </Button>
      <Button
        type="button"
        size="sm"
        variant={value === "shipping" ? "primary" : "outline"}
        aria-pressed={value === "shipping"}
        disabled={disabled || !shippingAvailable}
        onClick={() => onChange("shipping")}
      >
        Ship it
      </Button>
    </div>
  )
}
