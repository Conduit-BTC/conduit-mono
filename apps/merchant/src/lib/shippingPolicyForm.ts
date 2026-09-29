import {
  parseShippingPolicy,
  shippingMoneyToMinorUnits,
  shippingMinorUnitsToAmount,
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
  weightAllowance: string
  handling: string
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
    weightAllowance: "",
    handling: "",
    domestic: {
      enabled: true,
      freeShippingThreshold: "",
      rules: [createShippingRuleDraft()],
    },
    international: { enabled: false, freeShippingThreshold: "", rules: [] },
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
  const money = (value: string, label: string) =>
    shippingMoneyToMinorUnits(
      parsePlainDecimalAmount(value, label),
      draft.currency
    )
  const table = (
    input: ShippingTableDraft,
    domestic: boolean
  ): ShippingPolicyTable | null => {
    if (!input.enabled) return null
    if (!input.rules.length)
      throw new Error("Add at least one international destination.")
    const rules: ShippingPolicyRule[] = input.rules.map((rule, index) => ({
      country: domestic ? draft.originCountry : rule.country,
      ...(rule.subdivision.trim()
        ? { subdivision: rule.subdivision.trim() }
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
    }))
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
    version: 1,
    title: draft.title.trim(),
    originCountry: draft.originCountry,
    currency: draft.currency,
    weightAllowanceGrams: parseGrams(
      draft.weightAllowance,
      "Weight allowance",
      true
    ),
    handlingMinor: draft.handling.trim()
      ? money(draft.handling, "Handling buffer")
      : 0,
    domestic: table(draft.domestic, true),
    international: table(draft.international, false),
  })
  return policy
}

export function shippingPolicyToDraft(
  policy: ShippingPolicy
): ShippingPolicyDraft {
  const money = (minor: number) =>
    String(shippingMinorUnitsToAmount(minor, policy.currency))
  const table = (input: ShippingPolicyTable | null): ShippingTableDraft => ({
    enabled: input !== null,
    freeShippingThreshold:
      input?.freeShippingThresholdMinor === undefined
        ? ""
        : money(input.freeShippingThresholdMinor),
    rules: (input?.rules ?? []).map((rule) => ({
      id: crypto.randomUUID(),
      country: rule.country,
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
    weightAllowance: policy.weightAllowanceGrams
      ? String(policy.weightAllowanceGrams)
      : "",
    handling: policy.handlingMinor ? money(policy.handlingMinor) : "",
    domestic: table(policy.domestic),
    international: table(policy.international),
  }
}

export function getProductShippingMeasurements(form: {
  shippingWeightGrams?: string
  shippingLengthCm?: string
  shippingWidthCm?: string
  shippingHeightCm?: string
}): {
  shippingWeightGrams?: number
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
