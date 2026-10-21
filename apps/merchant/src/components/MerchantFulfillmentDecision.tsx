import { useState } from "react"
import type {
  MerchantFulfillmentChoice,
  MerchantFulfillmentDecision,
} from "@conduit/core"
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"

export function MerchantFulfillmentDecisionPanel({
  items,
  saved,
  pending,
  error,
  onSave,
  onRetry,
}: {
  items: Array<{ index: number; title: string }>
  saved: MerchantFulfillmentDecision | null
  pending: boolean
  error: string | null
  onSave: (choices: MerchantFulfillmentChoice[]) => void
  onRetry: () => void
}) {
  const [choices, setChoices] = useState<
    Record<number, MerchantFulfillmentChoice>
  >({})
  return (
    <section className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <h3 className="text-sm font-semibold">Delivery method</h3>
      {saved ? (
        <>
          <p role="status" className="text-sm text-[var(--text-secondary)]">
            Your delivery choices are saved on this device for this order.
          </p>
          {items.map((item) => (
            <p key={item.index} className="text-sm">
              {item.title}:{" "}
              {saved.lines.find((line) => line.index === item.index)?.mode ===
              "digital"
                ? "Digital delivery"
                : "Ship to buyer"}
            </p>
          ))}
        </>
      ) : (
        <>
          <p className="text-sm text-[var(--text-secondary)]">
            This order does not specify how these items are delivered. Confirm
            the agreed method with the buyer, then save a choice for each item
            before fulfilling the order. This does not change the buyer’s order.
          </p>
          {items.map((item) => (
            <div key={item.index} className="space-y-1">
              <Label htmlFor={`fulfillment-choice-${item.index}`}>
                {item.title}
              </Label>
              <Select
                value={choices[item.index] ?? ""}
                disabled={pending}
                onValueChange={(value) => {
                  if (value === "digital" || value === "shipping")
                    setChoices((current) => ({
                      ...current,
                      [item.index]: value,
                    }))
                }}
              >
                <SelectTrigger id={`fulfillment-choice-${item.index}`}>
                  <SelectValue placeholder="Choose delivery method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="digital">Digital delivery</SelectItem>
                  <SelectItem value="shipping">Ship to buyer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
          <Button
            type="button"
            disabled={
              pending || !!error || items.some((item) => !choices[item.index])
            }
            onClick={() => onSave(items.map((item) => choices[item.index]!))}
          >
            {pending ? "Saving delivery choices…" : "Save delivery choices"}
          </Button>
        </>
      )}
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-[var(--error-text)]">
            {error}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onRetry}
          >
            Retry saved delivery choices
          </Button>
        </div>
      )}
    </section>
  )
}
