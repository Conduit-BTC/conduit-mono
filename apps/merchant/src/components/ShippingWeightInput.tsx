import { useState } from "react"
import { InputWithSuffix, type InputProps } from "@conduit/ui"
import {
  displayShippingWeight,
  shippingWeightInputToGrams,
  type ShippingWeightUnit,
} from "../lib/shippingWeightUnits"

export function ShippingWeightInput({
  value,
  unit,
  onValueChange,
  ...props
}: Omit<InputProps, "value" | "onChange"> & {
  value: string
  unit: ShippingWeightUnit
  onValueChange: (grams: string) => void
}) {
  const [entry, setEntry] = useState(() => ({
    value,
    unit,
    text: displayShippingWeight(value, unit),
  }))
  if (entry.value !== value || entry.unit !== unit) {
    setEntry({ value, unit, text: displayShippingWeight(value, unit) })
  }
  return (
    <InputWithSuffix
      {...props}
      suffix={unit}
      value={
        entry.value === value && entry.unit === unit
          ? entry.text
          : displayShippingWeight(value, unit)
      }
      inputMode="decimal"
      onChange={(event) => {
        const text = event.target.value
        let grams = text
        if (text.trim()) {
          try {
            grams = String(shippingWeightInputToGrams(text, unit))
          } catch {
            // Keep invalid drafts editable; publication validates the stored input.
          }
        }
        setEntry({ value: grams, unit, text })
        onValueChange(grams)
      }}
    />
  )
}
