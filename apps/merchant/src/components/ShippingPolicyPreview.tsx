import { useState } from "react"
import {
  previewShippingPolicy,
  SHIPPING_COUNTRIES,
  shippingMinorUnitsToAmount,
  shippingMoneyToMinorUnits,
  type ShippingPolicy,
} from "@conduit/core"
import { Combobox, Input, InputWithSuffix, Label } from "@conduit/ui"
import type { ShippingWeightUnit } from "../lib/shippingWeightUnits"
import { ShippingWeightInput } from "./ShippingWeightInput"

const countryOptions = SHIPPING_COUNTRIES.map(({ code, name }) => ({
  value: code,
  label: name,
}))
const panel = "space-y-4 border-t border-[var(--border)] pt-4"
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Check the preview values."
}

export function ShippingPolicyPreview({
  policy,
  weightUnit,
}: {
  policy: ShippingPolicy | null
  weightUnit: ShippingWeightUnit
}) {
  const [country, setCountry] = useState("")
  const [subdivision, setSubdivision] = useState("")
  const [postalCode, setPostalCode] = useState("")
  const [firstWeight, setFirstWeight] = useState("250")
  const [secondWeight, setSecondWeight] = useState("250")
  const [quantity, setQuantity] = useState("1")
  const [subtotal, setSubtotal] = useState("0")
  let result: string | null = null
  if (
    policy &&
    country &&
    firstWeight &&
    secondWeight &&
    quantity &&
    subtotal
  ) {
    try {
      const q = Number(quantity)
      const first = Number(firstWeight)
      const second = Number(secondWeight)
      if (
        ![q, first, second].every(
          (value) => Number.isSafeInteger(value) && value > 0
        )
      )
        throw new Error("Enter positive whole weights and quantities.")
      const subtotalMinor = shippingMoneyToMinorUnits(
        Number(subtotal),
        policy.currency
      )
      const quote = previewShippingPolicy({
        policy,
        destination: { country, subdivision, postalCode },
        items: [
          {
            weightGrams: first,
            quantity: q,
            currency: policy.currency,
            subtotalMinor: 0,
          },
          {
            weightGrams: second,
            quantity: 1,
            currency: policy.currency,
            subtotalMinor,
          },
        ],
      })
      result =
        quote.status === "quoted"
          ? `Combined shipping: ${shippingMinorUnitsToAmount(quote.amountMinor, policy.currency)} ${policy.currency}`
          : "This basket needs merchant coordination. Check the destination and weight limits."
    } catch (error) {
      result = errorMessage(error)
    }
  }
  return (
    <details className={panel}>
      <summary className="cursor-pointer text-balance font-semibold">
        Preview a basket
      </summary>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="shipping-preview-country">Preview destination</Label>
          <Combobox
            id="shipping-preview-country"
            searchPlaceholder="Search countries"
            value={country}
            options={countryOptions}
            placeholder="Choose country"
            onValueChange={setCountry}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="shipping-preview-region">
            Preview state / region
          </Label>
          <Input
            id="shipping-preview-region"
            value={subdivision}
            onChange={(e) => setSubdivision(e.target.value)}
            placeholder="Optional, for example US-CA"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="shipping-preview-postal">Preview postal code</Label>
          <Input
            id="shipping-preview-postal"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="shipping-preview-first-weight">
            First item weight
          </Label>
          <ShippingWeightInput
            unit={weightUnit}
            id="shipping-preview-first-weight"
            value={firstWeight}
            inputMode="numeric"
            onValueChange={setFirstWeight}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="shipping-preview-quantity">First item quantity</Label>
          <Input
            id="shipping-preview-quantity"
            value={quantity}
            inputMode="numeric"
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="shipping-preview-second-weight">
            Second item weight
          </Label>
          <ShippingWeightInput
            unit={weightUnit}
            id="shipping-preview-second-weight"
            value={secondWeight}
            inputMode="numeric"
            onValueChange={setSecondWeight}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="shipping-preview-subtotal">Basket subtotal</Label>
          <InputWithSuffix
            suffix={
              policy?.currency === "SATS" ? "sats" : (policy?.currency ?? "")
            }
            id="shipping-preview-subtotal"
            value={subtotal}
            inputMode="decimal"
            onChange={(e) => setSubtotal(e.target.value)}
          />
        </div>
      </div>
      <p role="status" className="text-pretty text-sm tabular-nums">
        {result ?? "Choose a destination to see the total."}
      </p>
    </details>
  )
}
