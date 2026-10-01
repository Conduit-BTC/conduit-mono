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
import { getUSGroundAdvantageWarnings } from "../lib/usGroundAdvantageWarnings"
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
  idPrefix = "product",
  label = "Product shipping measurements",
  hideMeasurements = false,
  disabled = false,
}: {
  form: Measurements
  onChange: (value: Partial<Measurements>) => void
  error?: string
  idPrefix?: string
  label?: string
  hideMeasurements?: boolean
  disabled?: boolean
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
    if (form.shippingPricingMode === "weight_table")
      warnings.push(
        ...getUSGroundAdvantageWarnings(parsed.shippingDimensionsCm)
      )
  } catch {
    // Publication validates incomplete drafts while every field remains editable.
  }
  return (
    <section
      aria-label={label}
      className="space-y-3 rounded-xl border border-[var(--border)] p-3"
    >
      <div className="grid grid-cols-2 gap-3">
        {!hideMeasurements && (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={`${idPrefix}-shipping-weight`}>
              Shipping weight
            </Label>
            <ShippingWeightInput
              id={`${idPrefix}-shipping-weight`}
              disabled={disabled}
              unit={unit}
              value={form.shippingWeightGrams ?? ""}
              placeholder="0"
              aria-invalid={!!error}
              aria-describedby={
                error ? `${idPrefix}-shipping-weight-error` : undefined
              }
              onValueChange={(value) =>
                onChange({ shippingWeightGrams: value })
              }
            />
          </div>
        )}
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${idPrefix}-weight-unit`}>Weight unit</Label>
          <Select
            disabled={disabled}
            value={unit}
            onValueChange={(value) => {
              const weightUnit = value as ShippingWeightUnit
              onChange({ shippingWeightUnit: weightUnit })
              saveShippingWeightUnitPreference(pubkey, weightUnit)
            }}
          >
            <SelectTrigger id={`${idPrefix}-weight-unit`}>
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
          {hideMeasurements ? "Packing and handling" : "Packing and dimensions"}
        </summary>
        {form.shippingPricingMode === "weight_table" && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={`${idPrefix}-packing-weight`}>
                Extra packing weight
              </Label>
              <ShippingWeightInput
                id={`${idPrefix}-packing-weight`}
                disabled={disabled}
                unit={unit}
                value={form.shippingWeightAllowanceGrams ?? ""}
                placeholder="0"
                onValueChange={(value) =>
                  onChange({ shippingWeightAllowanceGrams: value })
                }
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={`${idPrefix}-handling-charge`}>
                Handling per item
              </Label>
              <InputWithSuffix
                id={`${idPrefix}-handling-charge`}
                disabled={disabled}
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
        {!hideMeasurements && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {(
              [
                ["shippingLengthCm", "Length"],
                ["shippingWidthCm", "Width"],
                ["shippingHeightCm", "Height"],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="min-w-0 space-y-1.5">
                <Label htmlFor={`${idPrefix}-${field}`}>{label}</Label>
                <InputWithSuffix
                  id={`${idPrefix}-${field}`}
                  disabled={disabled}
                  suffix="cm"
                  inputMode="decimal"
                  value={form[field] ?? ""}
                  onChange={(event) =>
                    onChange({ [field]: event.target.value })
                  }
                />
              </div>
            ))}
          </div>
        )}
      </details>
      {warnings.map((warning) => (
        <p key={warning} className="text-pretty text-sm text-warning">
          {warning}
        </p>
      ))}
      {error && (
        <p
          id={`${idPrefix}-shipping-weight-error`}
          role="alert"
          className="text-pretty text-sm text-error"
        >
          {error}
        </p>
      )}
    </section>
  )
}
