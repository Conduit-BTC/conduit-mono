import type { MerchantProductSupplierAllocationFormChange } from "./productForm"

type AllocationForm = MerchantProductSupplierAllocationFormChange

function weights(value: AllocationForm): bigint[] | null {
  const inputs = [
    value.merchantWeight,
    ...value.suppliers.map((row) => row.weight),
  ]
  if (
    inputs.some(
      (input) =>
        !/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input))
    )
  )
    return null
  return inputs.map(BigInt)
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b]
  return a
}

function withWeights(
  value: AllocationForm,
  next: bigint[]
): AllocationForm | null {
  if (next.some((weight) => weight <= 0n)) return null
  const divisor = next.reduce(gcd)
  const reduced = next.map((weight) => weight / divisor)
  if (
    reduced.reduce((sum, weight) => sum + weight, 0n) >
    BigInt(Number.MAX_SAFE_INTEGER)
  )
    return null
  return {
    ...value,
    merchantWeight: String(reduced[0]),
    suppliers: value.suppliers.map((row, index) => ({
      ...row,
      weight: String(reduced[index + 1]),
    })),
  }
}

export function getSupplierPercentage(
  value: AllocationForm,
  index: number
): string {
  const current = weights(value)
  if (!current) return ""
  const total = current.reduce((sum, weight) => sum + weight, 0n)
  const percent = (Number(current[index + 1] ?? 0n) / Number(total)) * 100
  return percent.toFixed(2).replace(/\.?0+$/, "")
}

export function getMerchantPercentage(value: AllocationForm): string {
  const current = weights(value)
  if (!current) return ""
  const total = current.reduce((sum, weight) => sum + weight, 0n)
  return ((Number(current[0]) / Number(total)) * 100)
    .toFixed(2)
    .replace(/\.?0+$/, "")
}

/** Changes only the edited supplier and merchant remainder. Other signed ratios stay exact. */
export function setSupplierPercentage(
  value: AllocationForm,
  index: number,
  input: string
): AllocationForm {
  const draft = {
    ...value,
    suppliers: value.suppliers.map((row, rowIndex) =>
      rowIndex === index
        ? { ...row, percentageInput: input, percentageError: undefined }
        : row
    ),
  }
  const fail = (error: string): AllocationForm => ({
    ...draft,
    suppliers: draft.suppliers.map((row, rowIndex) =>
      rowIndex === index ? { ...row, percentageError: error } : row
    ),
  })
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(input.trim())) {
    return fail("Enter a percentage with at most two decimal places.")
  }
  const [whole = "0", fraction = ""] = input.trim().split(".")
  const hundredths = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))
  if (hundredths <= 0n || hundredths >= 10_000n)
    return fail("Each supplier needs more than 0% and less than 100%.")
  const current = weights(value)
  if (!current || !current[index + 1])
    return fail(
      "Repair the saved revenue split before changing its percentages."
    )
  const total = current.reduce((sum, weight) => sum + weight, 0n)
  const next = current.map((weight) => weight * 10_000n)
  const replacement = hundredths * total
  next[0] = next[0]! + next[index + 1]! - replacement
  next[index + 1] = replacement
  if (next[0]! <= 0n)
    return fail("Supplier percentages must leave a share for you.")
  return (
    withWeights(draft, next) ??
    fail(
      "This change cannot preserve the other saved shares exactly. Remove and re-add the split to set new percentages."
    )
  )
}

export function addSupplierPercentage(value: AllocationForm): AllocationForm {
  const current = weights(value)
  if (!current) return value
  const total = current.reduce((sum, weight) => sum + weight, 0n)
  // Start at 25%, or half the merchant remainder when less than 50% remains.
  const share = current[0]! * 2n < total ? current[0]! * 2n : total
  const next = current.map((weight) => weight * 4n)
  next[0] = next[0]! - share
  next.push(share)
  return (
    withWeights(
      {
        ...value,
        suppliers: [
          ...value.suppliers,
          { identity: "", relayHint: "", weight: "1" },
        ],
      },
      next
    ) ?? value
  )
}

export function removeSupplierPercentage(
  value: AllocationForm,
  index: number
): AllocationForm {
  const current = weights(value)
  const draft = {
    ...value,
    suppliers: value.suppliers.filter((_, rowIndex) => rowIndex !== index),
  }
  if (!current || !current[index + 1]) return draft
  current[0] = current[0]! + current[index + 1]!
  current.splice(index + 1, 1)
  return withWeights(draft, current) ?? draft
}
