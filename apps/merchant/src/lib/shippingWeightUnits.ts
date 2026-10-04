export const SHIPPING_WEIGHT_UNITS = [
  { value: "g", label: "Grams", suffix: "g" },
  { value: "kg", label: "Kilograms", suffix: "kg" },
  { value: "lb", label: "Pounds", suffix: "lb" },
  { value: "oz", label: "Ounces", suffix: "oz" },
] as const

export type ShippingWeightUnit = (typeof SHIPPING_WEIGHT_UNITS)[number]["value"]

const gramFactors: Record<
  ShippingWeightUnit,
  { numerator: bigint; denominator: bigint }
> = {
  g: { numerator: 1n, denominator: 1n },
  kg: { numerator: 1000n, denominator: 1n },
  lb: { numerator: 45359237n, denominator: 100000n },
  oz: { numerator: 45359237n, denominator: 1600000n },
}

export function isShippingWeightUnit(
  value: unknown
): value is ShippingWeightUnit {
  return SHIPPING_WEIGHT_UNITS.some((unit) => unit.value === value)
}

/** Normalize entered weight upward to a whole gram, without float boundary drift. */
export function shippingWeightInputToGrams(
  value: string,
  unit: ShippingWeightUnit
): number {
  const text = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("Enter a valid weight.")
  const [whole, fraction = ""] = text.split(".")
  const factor = gramFactors[unit]
  const numerator = BigInt(`${whole}${fraction}`) * factor.numerator
  const denominator = 10n ** BigInt(fraction.length) * factor.denominator
  const grams = (numerator + denominator - 1n) / denominator
  if (grams > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Weight is too large.")
  return Number(grams)
}

/** Display units never change the canonical gram value unless the field is edited. */
export function displayShippingWeight(
  grams: string,
  unit: ShippingWeightUnit
): string {
  if (!grams.trim() || !/^\d+$/.test(grams.trim())) return grams
  if (unit === "g") return grams
  const factor = gramFactors[unit]
  const value =
    (Number(grams) * Number(factor.denominator)) / Number(factor.numerator)
  if (!Number.isFinite(value)) return grams
  return value.toFixed(3).replace(/\.?0+$/, "")
}

function preferenceKey(pubkey: string): string {
  return `conduit:merchant:shipping-weight-unit:${pubkey}`
}

export function getShippingWeightUnitPreference(
  pubkey?: string | null
): ShippingWeightUnit {
  if (!pubkey || typeof localStorage === "undefined") return "g"
  try {
    const unit = localStorage.getItem(preferenceKey(pubkey))
    return isShippingWeightUnit(unit) ? unit : "g"
  } catch {
    return "g"
  }
}

export function saveShippingWeightUnitPreference(
  pubkey: string | null | undefined,
  unit: ShippingWeightUnit
): boolean {
  if (!pubkey || typeof localStorage === "undefined") return false
  try {
    localStorage.setItem(preferenceKey(pubkey), unit)
    return true
  } catch {
    return false
  }
}
