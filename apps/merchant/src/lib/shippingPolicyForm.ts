import {
  parseShippingPolicy,
  normalizeCurrencyIdentity,
  type SourcePriceQuote,
  shippingMoneyToMinorUnits,
  shippingMinorUnitsToAmount,
  policyCurrencyMinorDigits,
  type ShippingPolicy,
  type ShippingPolicyRule,
  type ShippingPolicyTable,
} from "@conduit/core"
import { parsePlainDecimalAmount } from "./productPriceForm"

export interface ShippingBandDraft {
  id: string
  maxWeight: string
  price: string
}

export interface ShippingRuleDraft {
  id: string
  country: string
  subdivision: string
  postalPrefix: string
  bands: ShippingBandDraft[]
  customArea?: boolean
}

export interface ShippingTableDraft {
  enabled: boolean
  freeShippingThreshold: string
  rules: ShippingRuleDraft[]
}

export interface ShippingPolicyDraft {
  title: string
  originCountry: string
  currency: string
  domestic: ShippingTableDraft
  international: ShippingTableDraft
}

export function createShippingRuleDraft(country = ""): ShippingRuleDraft {
  return {
    id: crypto.randomUUID(),
    country,
    subdivision: "",
    postalPrefix: "",
    bands: [{ id: crypto.randomUUID(), maxWeight: "", price: "" }],
  }
}

export function createShippingPolicyDraft(): ShippingPolicyDraft {
  return {
    title: "Standard shipping",
    originCountry: "",
    currency: "USD",
    domestic: {
      enabled: true,
      freeShippingThreshold: "",
      rules: [createShippingRuleDraft()],
    },
    international: { enabled: false, freeShippingThreshold: "", rules: [] },
  }
}

/** Preserve prices while requiring custom domestic areas to be selected again. */
export function changeShippingPolicyOrigin(
  draft: ShippingPolicyDraft,
  originCountry: string
): ShippingPolicyDraft {
  if (originCountry === draft.originCountry) return draft
  return {
    ...draft,
    originCountry,
    domestic: {
      ...draft.domestic,
      rules: draft.domestic.rules.map((rule) => ({
        ...rule,
        country: originCountry,
        customArea:
          !!rule.customArea || !!rule.subdivision || !!rule.postalPrefix,
        subdivision: "",
        postalPrefix: "",
      })),
    },
  }
}

function parseGrams(value: string, label: string, optional = false): number {
  if (optional && !value.trim()) return 0
  const grams = parsePlainDecimalAmount(value, label)
  if (!Number.isSafeInteger(grams) || grams < (optional ? 0 : 1)) {
    throw new Error(
      `${label} must be ${optional ? "non-negative" : "positive"} whole grams.`
    )
  }
  return grams
}

export function buildShippingPolicyFromDraft(
  draft: ShippingPolicyDraft
): ShippingPolicy {
  const money = (value: string, label: string) => {
    try {
      return shippingMoneyToMinorUnits(value, draft.currency)
    } catch (error) {
      throw new Error(
        `${label}: ${error instanceof Error ? error.message : "Invalid amount."}`,
        { cause: error }
      )
    }
  }
  const table = (
    input: ShippingTableDraft,
    domestic: boolean
  ): ShippingPolicyTable | null => {
    if (!input.enabled) return null
    if (!input.rules.length)
      throw new Error("Add at least one international destination.")
    const rules: ShippingPolicyRule[] = input.rules.map((rule, index) => {
      if (
        rule.customArea &&
        !rule.subdivision.trim() &&
        !rule.postalPrefix.trim()
      ) {
        throw new Error(
          "Choose a state or enter a postal prefix for custom rates."
        )
      }
      const country = domestic ? draft.originCountry : rule.country
      const subdivision = rule.subdivision.trim().toUpperCase()
      return {
        country,
        ...(rule.subdivision.trim()
          ? {
              subdivision: subdivision.startsWith(country)
                ? subdivision
                : `${country}-${subdivision}`,
            }
          : {}),
        ...(rule.postalPrefix.trim()
          ? { postalPrefix: rule.postalPrefix.trim() }
          : {}),
        bands: rule.bands.map((band) => ({
          maxWeightGrams: parseGrams(
            band.maxWeight,
            `Destination ${index + 1} maximum weight`
          ),
          priceMinor: money(
            band.price,
            `Destination ${index + 1} shipping price`
          ),
        })),
      }
    })
    return {
      rules,
      ...(input.freeShippingThreshold.trim()
        ? {
            freeShippingThresholdMinor: money(
              input.freeShippingThreshold,
              "Free shipping threshold"
            ),
          }
        : {}),
    }
  }
  const policy = parseShippingPolicy({
    version: 2,
    title: draft.title.trim(),
    originCountry: draft.originCountry,
    currency: draft.currency,
    domestic: table(draft.domestic, true),
    international: table(draft.international, false),
  })
  return policy
}

export function shippingPolicyToDraft(
  policy: ShippingPolicy
): ShippingPolicyDraft {
  const money = (minor: number) => {
    if (!Number.isSafeInteger(minor) || minor < 0)
      throw new Error("Invalid minor-unit amount.")
    const digits = policyCurrencyMinorDigits(policy.currency)
    const text = String(minor).padStart(digits + 1, "0")
    if (!digits) return text
    const fraction = text.slice(-digits).replace(/0+$/, "")
    return `${text.slice(0, -digits)}${fraction ? `.${fraction}` : ""}`
  }
  const table = (input: ShippingPolicyTable | null): ShippingTableDraft => ({
    enabled: input !== null,
    freeShippingThreshold:
      input?.freeShippingThresholdMinor === undefined
        ? ""
        : money(input.freeShippingThresholdMinor),
    rules: (input?.rules ?? []).map((rule) => ({
      id: crypto.randomUUID(),
      country: rule.country,
      customArea: !!rule.subdivision || !!rule.postalPrefix,
      subdivision: rule.subdivision ?? "",
      postalPrefix: rule.postalPrefix ?? "",
      bands: rule.bands.map((band) => ({
        id: crypto.randomUUID(),
        maxWeight: String(band.maxWeightGrams),
        price: money(band.priceMinor),
      })),
    })),
  })
  return {
    title: policy.title,
    originCountry: policy.originCountry,
    currency: policy.currency,
    domestic: table(policy.domestic),
    international: table(policy.international),
  }
}

export function getProductShippingMeasurements(form: {
  shippingWeightGrams?: string
  shippingWeightAllowanceGrams?: string
  shippingHandling?: string
  currency?: string
  shippingLengthCm?: string
  shippingWidthCm?: string
  shippingHeightCm?: string
}): {
  shippingWeightGrams?: number
  shippingWeightAllowanceGrams?: number
  shippingHandling?: SourcePriceQuote
  shippingDimensionsCm?: { length: number; width: number; height: number }
} {
  const weight = form.shippingWeightGrams?.trim()
  const dimensions = [
    form.shippingLengthCm,
    form.shippingWidthCm,
    form.shippingHeightCm,
  ]
  const anyDimension = dimensions.some((value) => !!value?.trim())
  const result: ReturnType<typeof getProductShippingMeasurements> = {}
  if (weight) result.shippingWeightGrams = parseGrams(weight, "Shipping weight")
  if (form.shippingWeightAllowanceGrams?.trim()) {
    result.shippingWeightAllowanceGrams = parseGrams(
      form.shippingWeightAllowanceGrams,
      "Extra packing weight",
      true
    )
  }
  if (form.shippingHandling?.trim()) {
    const currency = form.currency ?? "SATS"
    const minor = shippingMoneyToMinorUnits(
      parsePlainDecimalAmount(form.shippingHandling, "Handling charge"),
      currency
    )
    result.shippingHandling = {
      amount: shippingMinorUnitsToAmount(minor, currency),
      currency,
      normalizedCurrency: normalizeCurrencyIdentity(currency),
    }
  }

  if (anyDimension) {
    const [length, width, height] = dimensions.map((value) => {
      const cm = parsePlainDecimalAmount(value ?? "", "All three dimensions")
      if (cm <= 0) throw new Error("Dimensions must be greater than zero.")
      return cm
    })
    result.shippingDimensionsCm = { length, width, height }
  }
  return result
}
