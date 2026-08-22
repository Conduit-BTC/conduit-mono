import { useId } from "react"
import { Badge, Button, Checkbox } from "@conduit/ui"
import type {
  ProductVariationAxis,
  ProductVariationCombination,
} from "../lib/productVariations"

interface ProductCombinationMatrixProps {
  axes: readonly ProductVariationAxis[]
  combinations: readonly ProductVariationCombination[]
  invalid?: boolean
  onIncludeAll: () => void
  onIncludedChange: (identity: string, included: boolean) => void
  validationMessageId?: string
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US")
}

function getCombinationValue(
  combination: ProductVariationCombination,
  key: string
): string {
  const normalizedKey = normalizeKey(key)
  return (
    combination.specifications.find(
      (specification) => normalizeKey(specification.key) === normalizedKey
    )?.value ?? ""
  )
}

function getCombinationAccessibleName(
  combination: ProductVariationCombination
): string {
  return combination.specifications
    .map(({ key, value }) => `${key}: ${value}`)
    .join(", ")
}

export function ProductCombinationMatrix({
  axes,
  combinations,
  invalid = false,
  onIncludeAll,
  onIncludedChange,
  validationMessageId,
}: ProductCombinationMatrixProps) {
  const headingId = useId()
  const helpId = useId()
  const includedCount = combinations.filter(
    (combination) => combination.included
  ).length
  const excludedCount = combinations.length - includedCount
  const allIncluded =
    combinations.length > 0 && includedCount === combinations.length

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={validationMessageId}
      className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id={headingId}
              className="text-balance text-sm font-medium text-[var(--text-primary)]"
            >
              Availability matrix
            </h3>
            <Badge
              variant="secondary"
              className="border-[var(--border)] bg-[var(--surface)] tabular-nums text-[var(--text-secondary)]"
            >
              {includedCount} of {combinations.length} available
            </Badge>
          </div>
          <p
            id={helpId}
            className="max-w-2xl text-pretty text-xs leading-5 text-[var(--text-muted)]"
          >
            Choose the combinations this product offers. Keep a combination
            available and set its stock to 0 below when it is temporarily sold
            out.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={allIncluded}
          onClick={onIncludeAll}
        >
          {allIncluded ? "All available" : "Make all available"}
        </Button>
      </div>

      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-xs tabular-nums text-[var(--text-muted)]"
      >
        {includedCount} available · {excludedCount} unavailable
      </p>

      <div
        role="region"
        aria-label="Combination availability matrix"
        tabIndex={0}
        className="max-h-80 overflow-auto rounded-lg border border-[var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-500)]/50"
      >
        <table className="w-full min-w-max border-collapse text-left text-sm">
          <caption className="sr-only">
            Choose which combinations are available for this product.
          </caption>
          <thead className="sticky top-0 z-10 bg-[var(--surface)]">
            <tr>
              {axes.map((axis) => (
                <th
                  key={axis.id}
                  scope="col"
                  className="border-b border-[var(--border)] px-3 py-2 font-medium text-[var(--text-secondary)]"
                >
                  {axis.key.trim()}
                </th>
              ))}
              <th
                scope="col"
                className="border-b border-[var(--border)] px-3 py-2 text-center font-medium text-[var(--text-secondary)]"
              >
                Available
              </th>
            </tr>
          </thead>
          <tbody>
            {combinations.map((combination) => (
              <tr
                key={combination.identity}
                className="border-b border-[var(--border)] last:border-b-0"
              >
                {axes.map((axis, index) =>
                  index === 0 ? (
                    <th
                      key={axis.id}
                      scope="row"
                      className="px-3 py-2 font-medium text-[var(--text-primary)]"
                    >
                      {getCombinationValue(combination, axis.key)}
                    </th>
                  ) : (
                    <td
                      key={axis.id}
                      className="px-3 py-2 text-[var(--text-primary)]"
                    >
                      {getCombinationValue(combination, axis.key)}
                    </td>
                  )
                )}
                <td className="px-3 py-2 text-center">
                  <Checkbox
                    checked={combination.included}
                    aria-label={`Make ${getCombinationAccessibleName(combination)} available`}
                    aria-describedby={
                      validationMessageId
                        ? `${helpId} ${validationMessageId}`
                        : helpId
                    }
                    aria-invalid={invalid || undefined}
                    onCheckedChange={(included) =>
                      onIncludedChange(combination.identity, included)
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
