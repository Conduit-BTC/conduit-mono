import { getShippingDimensionWarnings, useAuth } from "@conduit/core"
import {
  InputWithSuffix,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import type { ProductPublishFormValues } from "../lib/productForm"
import { getProductShippingMeasurements } from "../lib/shippingPolicyForm"
import {
  getShippingWeightUnitPreference,
  saveShippingWeightUnitPreference,
  SHIPPING_WEIGHT_UNITS,
  type ShippingWeightUnit,
} from "../lib/shippingWeightUnits"
import { ShippingWeightInput } from "./ShippingWeightInput"

type Measurements = Pick<
  ProductPublishFormValues,
  | "shippingWeightGrams"
  | "shippingWeightUnit"
  | "shippingWeightAllowanceGrams"
  | "shippingHandling"
  | "shippingLengthCm"
  | "shippingWidthCm"
  | "shippingHeightCm"
  | "currency"
  | "shippingPricingMode"
>

export function ProductShippingMeasurements({
  form,
  onChange,
  error,
}: {
  form: Measurements
  onChange: (value: Partial<Measurements>) => void
  error?: string
}) {
  const { pubkey } = useAuth()
  const unit =
    form.shippingWeightUnit ?? getShippingWeightUnitPreference(pubkey)
  let warnings: string[] = []
  try {
    const parsed = getProductShippingMeasurements(form)
    warnings = getShippingDimensionWarnings(
      parsed.shippingWeightGrams,
      parsed.shippingDimensionsCm
    )
  } catch {
    // Publication validates incomplete drafts while every field remains editable.
  }
  return (
    <section
      aria-label="Product shipping measurements"
      className="space-y-3 rounded-xl border border-[var(--border)] p-3"
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="product-shipping-weight">Shipping weight</Label>
          <ShippingWeightInput
            id="product-shipping-weight"
            unit={unit}
            value={form.shippingWeightGrams ?? ""}
            placeholder="0"
            aria-invalid={!!error}
            aria-describedby={
              error ? "product-shipping-weight-error" : undefined
            }
            onValueChange={(value) => onChange({ shippingWeightGrams: value })}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="product-weight-unit">Weight unit</Label>
          <Select
            value={unit}
            onValueChange={(value) => {
              const weightUnit = value as ShippingWeightUnit
              onChange({ shippingWeightUnit: weightUnit })
              saveShippingWeightUnitPreference(pubkey, weightUnit)
            }}
          >
            <SelectTrigger id="product-weight-unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SHIPPING_WEIGHT_UNITS.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <details>
        <summary className="cursor-pointer py-2 text-sm text-[var(--text-secondary)]">
          Packing and dimensions
        </summary>
        {form.shippingPricingMode === "weight_table" && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="product-packing-weight">
                Extra packing weight
              </Label>
              <ShippingWeightInput
                id="product-packing-weight"
                unit={unit}
                value={form.shippingWeightAllowanceGrams ?? ""}
                placeholder="0"
                onValueChange={(value) =>
                  onChange({ shippingWeightAllowanceGrams: value })
                }
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="product-handling-charge">Handling per item</Label>
              <InputWithSuffix
                id="product-handling-charge"
                suffix={form.currency === "SATS" ? "sats" : form.currency}
                inputMode="decimal"
                value={form.shippingHandling ?? ""}
                placeholder="0"
                onChange={(event) =>
                  onChange({ shippingHandling: event.target.value })
                }
              />
            </div>
          </div>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2">
          {(
            [
              ["shippingLengthCm", "Length"],
              ["shippingWidthCm", "Width"],
              ["shippingHeightCm", "Height"],
            ] as const
          ).map(([field, label]) => (
            <div key={field} className="min-w-0 space-y-1.5">
              <Label htmlFor={`product-${field}`}>{label}</Label>
              <InputWithSuffix
                id={`product-${field}`}
                suffix="cm"
                inputMode="decimal"
                value={form[field] ?? ""}
                onChange={(event) => onChange({ [field]: event.target.value })}
              />
            </div>
          ))}
        </div>
      </details>
      {warnings.map((warning) => (
        <p key={warning} className="text-pretty text-sm text-warning">
          {warning}
        </p>
      ))}
      {error && (
        <p
          id="product-shipping-weight-error"
          role="alert"
          className="text-pretty text-sm text-error"
        >
          {error}
        </p>
      )}
    </section>
  )
}
