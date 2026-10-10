import type { ComponentProps } from "react"
import { Checkbox } from "@conduit/ui"
import type { MerchantProductFormValues } from "../lib/productForm"
import type { ProductVariationCombination } from "../lib/productVariations"
import { ProductShippingMeasurements } from "./ProductShippingMeasurements"

type ShippingForm = Pick<
  MerchantProductFormValues,
  | "shippingPricingMode"
  | "format"
  | "currency"
  | "shippingWeightUnit"
  | "variations"
>

export function SharedVariationMeasurementsToggle({
  form,
  disabled,
  onChange,
}: {
  form: ShippingForm
  disabled: boolean
  onChange: (shared: boolean) => void
}) {
  if (form.shippingPricingMode !== "weight_table" || form.format !== "physical")
    return null
  const shared = form.variations.shareShippingMeasurements === true
  const description = disabled
    ? "Choose Change fulfillment to edit variation shipping measurements."
    : shared
      ? "The parent measurements will replace each physical variation's measurements. Use the heaviest and largest variation for a conservative estimate. Packing and handling remain separate."
      : "Enter each physical variation's weight below. Dimensions are optional; enter all three if supplied. Every variation can use the same rate table."
  return (
    <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] p-3">
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={shared}
          disabled={disabled}
          aria-describedby="variation-shared-measurements-help"
          onCheckedChange={onChange}
        />
        Use the same weight and dimensions for all physical variations
      </label>
      <p
        id="variation-shared-measurements-help"
        className="text-pretty text-xs text-[var(--text-muted)]"
      >
        {description}
      </p>
    </div>
  )
}

export function VariationShippingMeasurements({
  form,
  combination,
  index,
  disabled,
  onChange,
}: {
  form: ShippingForm
  combination: ProductVariationCombination
  index: number
  disabled: boolean
  onChange: ComponentProps<typeof ProductShippingMeasurements>["onChange"]
}) {
  const format =
    combination.format === "inherit" ? form.format : combination.format
  if (
    form.shippingPricingMode !== "weight_table" ||
    !combination.inheritShipping ||
    format !== "physical"
  )
    return null
  return (
    <ProductShippingMeasurements
      idPrefix={`product-variation-${index}`}
      label={`Shipping measurements for ${combination.label}`}
      hideMeasurements={form.variations.shareShippingMeasurements === true}
      disabled={disabled}
      form={{
        ...combination,
        currency: form.currency,
        shippingPricingMode: "weight_table",
        shippingWeightUnit:
          combination.shippingWeightUnit ?? form.shippingWeightUnit,
      }}
      onChange={onChange}
    />
  )
}
