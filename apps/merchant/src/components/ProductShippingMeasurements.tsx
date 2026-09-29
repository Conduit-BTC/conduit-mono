import { getShippingDimensionWarnings } from "@conduit/core"
import { Input, Label } from "@conduit/ui"
import type { ProductPublishFormValues } from "../lib/productForm"
import { getProductShippingMeasurements } from "../lib/shippingPolicyForm"

type Measurements = Pick<
  ProductPublishFormValues,
  | "shippingWeightGrams"
  | "shippingLengthCm"
  | "shippingWidthCm"
  | "shippingHeightCm"
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
  let warnings: string[] = []
  try {
    const parsed = getProductShippingMeasurements(form)
    warnings = getShippingDimensionWarnings(
      parsed.shippingWeightGrams,
      parsed.shippingDimensionsCm
    )
  } catch {
    // Incomplete draft values remain editable; publish validation reports them.
  }
  return (
    <section
      aria-label="Product shipping measurements"
      className="space-y-3 rounded-xl border border-[var(--border)] p-3"
    >
      <div className="space-y-1.5">
        <Label htmlFor="product-shipping-weight">Shipping weight (g)</Label>
        <Input
          id="product-shipping-weight"
          inputMode="numeric"
          value={form.shippingWeightGrams ?? ""}
          placeholder="Weight of one item"
          className="tabular-nums"
          aria-invalid={!!error}
          aria-describedby="product-shipping-weight-help"
          onChange={(event) =>
            onChange({ shippingWeightGrams: event.target.value })
          }
        />
        <p
          id="product-shipping-weight-help"
          className="text-pretty text-xs text-[var(--text-muted)]"
        >
          Required for table shipping. Include the weight shipped with one item;
          1 kg = 1,000 g. Variations using the table share this weight.
        </p>
      </div>
      <details>
        <summary className="cursor-pointer py-2 text-sm text-[var(--text-secondary)]">
          Dimensions and special packing (optional)
        </summary>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {(
            [
              ["shippingLengthCm", "Length"],
              ["shippingWidthCm", "Width"],
              ["shippingHeightCm", "Height"],
            ] as const
          ).map(([field, label]) => (
            <div key={field} className="min-w-0 space-y-1.5">
              <Label htmlFor={`product-${field}`}>{label} (cm)</Label>
              <Input
                id={`product-${field}`}
                inputMode="decimal"
                value={form[field] ?? ""}
                className="tabular-nums"
                onChange={(event) => onChange({ [field]: event.target.value })}
              />
            </div>
          ))}
        </div>
        <p className="mt-2 text-pretty text-xs text-[var(--text-muted)]">
          Dimensions only flag items that may need extra care. They do not
          change checkout shipping. Use your judgment for fragile or special
          packing and consider covering it in the product price.
        </p>
      </details>
      {warnings.map((warning) => (
        <p key={warning} className="text-pretty text-sm text-warning">
          {warning}
        </p>
      ))}
      {error && (
        <p role="alert" className="text-pretty text-sm text-error">
          {error}
        </p>
      )}
    </section>
  )
}
