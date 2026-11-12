/** Pure signed shipping-policy terms shared by product parsing and shipping transport. */
import { z } from "zod"
import {
  getCurrencyFractionDigits,
  isSupportedCommercePriceCurrency,
  normalizeCurrencyIdentity,
} from "../pricing"
import { normalizeAddressRegion } from "./address-validation"
import { EVENT_KINDS } from "./kinds"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import {
  isVerifiedNostrEvent,
  type VerifiedNostrEvent,
} from "./verified-public-event"
import type { ShippingOptionEventDraft } from "./shipping"

export const MERCHANT_SHIPPING_POLICY_D_TAG = "conduit-shipping-policy"
export const SHIPPING_POLICY_EXTENSION_TAG = "conduit_shipping_table"
export const HEX_64 = /^[0-9a-f]{64}$/
export const integer = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
export const positiveInteger = integer.min(1)

export const shippingPolicyBandSchema = z
  .object({
    maxWeightGrams: positiveInteger,
    priceMinor: integer,
  })
  .strict()
export const shippingPolicyRuleSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    subdivision: z
      .string()
      .regex(/^[A-Z]{2}[A-Z0-9]{1,6}$/)
      .optional(),
    postalPrefix: z
      .string()
      .regex(/^[A-Z0-9]{1,32}$/)
      .optional(),
    bands: z.array(shippingPolicyBandSchema).min(1).max(100),
  })
  .strict()
export const shippingPolicyTableSchema = z
  .object({
    rules: z.array(shippingPolicyRuleSchema).min(1).max(500),
    freeShippingThresholdMinor: integer.optional(),
  })
  .strict()
const shippingPolicyFields = z
  .object({
    title: z.string().trim().min(1).max(200),
    originCountry: z.string().regex(/^[A-Z]{2}$/),
    currency: z.string().min(3).max(5),

    domestic: shippingPolicyTableSchema.nullable(),
    international: shippingPolicyTableSchema.nullable(),
  })
  .strict()
export const shippingPolicyV1Schema = shippingPolicyFields.extend({
  version: z.literal(1),
  weightAllowanceGrams: integer,
  handlingMinor: integer,
})
export const shippingPolicyV2Schema = shippingPolicyFields.extend({
  version: z.literal(2),
})
export const shippingPolicySchema = z
  .discriminatedUnion("version", [
    shippingPolicyV1Schema,
    shippingPolicyV2Schema,
  ])
  .superRefine((policy, context) => {
    if (!policy.domestic && !policy.international) {
      context.addIssue({
        code: "custom",
        message: "Add at least one destination table.",
      })
    }
    if (
      normalizeCurrencyIdentity(policy.currency) !== policy.currency ||
      !/^(?:[A-Z]{3}|SATS|MSATS)$/.test(policy.currency)
    ) {
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Invalid shipping currency.",
      })
    }
    for (const scope of ["domestic", "international"] as const) {
      const table = policy[scope]
      const seen = new Set<string>()
      for (const [index, rule] of (table?.rules ?? []).entries()) {
        if (
          (rule.country === policy.originCountry) !==
          (scope === "domestic")
        ) {
          context.addIssue({
            code: "custom",
            path: [scope, "rules", index, "country"],
            message: "Destination belongs in the other table.",
          })
        }
        if (rule.subdivision && !rule.subdivision.startsWith(rule.country)) {
          context.addIssue({
            code: "custom",
            path: [scope, "rules", index, "subdivision"],
            message: "Subdivision must include its country code.",
          })
        }
        const key = JSON.stringify([
          rule.country,
          rule.subdivision ?? "",
          rule.postalPrefix ?? "",
        ])
        if (seen.has(key))
          context.addIssue({
            code: "custom",
            path: [scope, "rules", index],
            message: "Duplicate destination rule.",
          })
        seen.add(key)
        let previous = 0
        for (const [bandIndex, band] of rule.bands.entries()) {
          if (band.maxWeightGrams <= previous)
            context.addIssue({
              code: "custom",
              path: [scope, "rules", index, "bands", bandIndex],
              message: "Weight limits must increase.",
            })
          previous = band.maxWeightGrams
        }
      }
    }
  })
export type ShippingPolicyV1 = z.infer<typeof shippingPolicyV1Schema>
export type ShippingPolicyV2 = z.infer<typeof shippingPolicyV2Schema>
export type ShippingPolicy = z.infer<typeof shippingPolicySchema>
export type ShippingPolicyTable = z.infer<typeof shippingPolicyTableSchema>
export type ShippingPolicyRule = z.infer<typeof shippingPolicyRuleSchema>
export type ShippingPolicyBand = z.infer<typeof shippingPolicyBandSchema>

export function normalizeShippingPolicyRegion(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/g, "")
}

export function normalizeShippingPolicySubdivision(
  country: string,
  value: string | undefined
): string | undefined {
  const code = country.trim().toUpperCase()
  const normalized = normalizeShippingPolicyRegion(value ?? "")
  if (!normalized) return undefined
  const region =
    normalizeAddressRegion(code, value) ??
    normalizeAddressRegion(
      code,
      normalized.startsWith(code) ? normalized.slice(code.length) : normalized
    ) ??
    normalized
  return region.startsWith(code) ? region : `${code}${region}`
}

/** Normalize human-entered identifiers before validating the signed document. */
export function parseShippingPolicy(input: unknown): ShippingPolicy {
  if (!input || typeof input !== "object")
    throw new Error("Invalid shipping policy.")
  const value = input as Record<string, unknown>
  const normalizeTable = (table: unknown): unknown => {
    if (!table || typeof table !== "object") return table
    const record = table as Record<string, unknown>
    return {
      ...record,
      rules: Array.isArray(record.rules)
        ? record.rules.map((item) => {
            if (!item || typeof item !== "object") return item
            const rule = item as Record<string, unknown>
            return {
              ...rule,
              country:
                typeof rule.country === "string"
                  ? rule.country.trim().toUpperCase()
                  : rule.country,
              ...(typeof rule.subdivision === "string"
                ? {
                    subdivision: normalizeShippingPolicyRegion(
                      rule.subdivision
                    ),
                  }
                : {}),
              ...(typeof rule.postalPrefix === "string"
                ? {
                    postalPrefix: normalizeShippingPolicyRegion(
                      rule.postalPrefix
                    ),
                  }
                : {}),
            }
          })
        : record.rules,
    }
  }
  return shippingPolicySchema.parse({
    ...value,
    originCountry:
      typeof value.originCountry === "string"
        ? value.originCountry.trim().toUpperCase()
        : value.originCountry,
    currency:
      typeof value.currency === "string"
        ? normalizeCurrencyIdentity(value.currency)
        : value.currency,
    domestic: normalizeTable(value.domestic),
    international: normalizeTable(value.international),
  })
}

/** Decimal conversion checks precision instead of silently rounding terms. */
export function shippingMoneyToMinorUnits(
  amount: number | string,
  currency: string
): number {
  const digits = getCurrencyFractionDigits(currency)
  let text = String(amount).trim()
  if (typeof amount === "number" && /e/i.test(text)) {
    const [coefficient, exponentText] = text.toLowerCase().split("e")
    const exponent = Number(exponentText)
    if (!coefficient || !Number.isInteger(exponent) || Math.abs(exponent) > 100)
      throw new Error("Invalid amount.")
    const digitsOnly = coefficient.replace(".", "")
    const decimalIndex =
      (coefficient.includes(".")
        ? coefficient.indexOf(".")
        : coefficient.length) + exponent
    text =
      decimalIndex <= 0
        ? `0.${"0".repeat(-decimalIndex)}${digitsOnly}`
        : decimalIndex >= digitsOnly.length
          ? `${digitsOnly}${"0".repeat(decimalIndex - digitsOnly.length)}`
          : `${digitsOnly.slice(0, decimalIndex)}.${digitsOnly.slice(decimalIndex)}`
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) throw new Error("Enter a non-negative decimal amount.")
  const fraction = match[2] ?? ""
  if (fraction.slice(digits).replace(/0/g, ""))
    throw new Error("Amount exceeds currency precision.")
  const minor = Number(
    BigInt(match[1]!) * 10n ** BigInt(digits) +
      BigInt(fraction.slice(0, digits).padEnd(digits, "0") || "0")
  )
  if (!Number.isSafeInteger(minor))
    throw new Error("Amount exceeds the supported range.")
  return minor
}
export function shippingMinorUnitsToAmount(
  minor: number,
  currency: string
): number {
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new Error("Invalid minor-unit amount.")
  return minor / 10 ** getCurrencyFractionDigits(currency)
}
function minorDecimal(minor: number, currency: string): string {
  const digits = getCurrencyFractionDigits(currency)
  if (!digits) return String(minor)
  const text = String(minor).padStart(digits + 1, "0")
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`
}
export function ownerPubkey(pubkey: string): string {
  const owner = pubkey.trim().toLowerCase()
  if (!HEX_64.test(owner)) throw new Error("Merchant identity is invalid.")
  return owner
}
export function getMerchantShippingPolicyCoordinate(pubkey: string): string {
  return `${EVENT_KINDS.SHIPPING_OPTION}:${ownerPubkey(pubkey)}:${MERCHANT_SHIPPING_POLICY_D_TAG}`
}
export function buildShippingPolicyEventDraft(input: {
  policy: ShippingPolicy
  clientAppId?: ConduitAppId
}): ShippingOptionEventDraft {
  const policy = parseShippingPolicy(input.policy)
  if (!isSupportedCommercePriceCurrency(policy.currency))
    throw new Error("Unsupported shipping currency.")
  return buildCanonicalShippingPolicyEventDraft({ ...input, policy })
}

/** Canonical wire reconstruction also serves retained signed policy parsing. */
function buildCanonicalShippingPolicyEventDraft(input: {
  policy: ShippingPolicy
  clientAppId?: ConduitAppId
}): ShippingOptionEventDraft {
  const policy = input.policy
  const rules = [
    ...(policy.domestic?.rules ?? []),
    ...(policy.international?.rules ?? []),
  ]
  let tags: string[][] = [
    ["d", MERCHANT_SHIPPING_POLICY_D_TAG],
    ["title", policy.title],
    [
      "country",
      ...Array.from(new Set(rules.map((rule) => rule.country))).sort(),
    ],
    ["service", "standard"],
    [
      SHIPPING_POLICY_EXTENSION_TAG,
      String(policy.version),
      JSON.stringify(policy),
    ],
  ]
  if (input.clientAppId) tags = appendConduitClientTag(tags, input.clientAppId)
  return {
    kind: EVENT_KINDS.SHIPPING_OPTION,
    content: `${policy.title}. Shipping is calculated from the destination and combined product weight using the attached merchant table.`,
    tags,
  }
}

/** Table capability is required; summary metadata must agree with the policy. */
export function parsePrivateOrderShippingPolicyTags(
  tags: readonly (readonly string[])[]
): ShippingPolicy | null {
  const markers = tags.filter((tag) => tag[0] === SHIPPING_POLICY_EXTENSION_TAG)
  if (
    markers.length !== 1 ||
    markers[0]?.length !== 3 ||
    !["1", "2"].includes(markers[0][1]!)
  )
    return null
  try {
    const policy = parseShippingPolicy(JSON.parse(markers[0][2]!) as unknown)
    if (String(policy.version) !== markers[0]![1]) return null
    const draft = buildCanonicalShippingPolicyEventDraft({ policy })
    const permitted = new Set([
      ...draft.tags.map((tag) => tag[0]),
      "client",
      "price",
    ])
    if (tags.some((tag) => !permitted.has(tag[0]))) return null
    // Read-only compatibility for retained signed table revisions. New writes
    // omit the old first-band summary so standard readers cannot charge it.
    const prices = tags.filter((tag) => tag[0] === "price")
    if (prices.length > 0) {
      const firstRule =
        policy.domestic?.rules[0] ?? policy.international!.rules[0]!
      const legacyPrice = [
        "price",
        minorDecimal(firstRule.bands[0]!.priceMinor, policy.currency),
        policy.currency,
      ]
      if (
        prices.length !== 1 ||
        JSON.stringify(prices[0]) !== JSON.stringify(legacyPrice)
      )
        return null
    }
    for (const name of ["d", "title", "service"]) {
      const expected = draft.tags.find((tag) => tag[0] === name)!
      const actual = tags.filter((tag) => tag[0] === name)
      if (
        actual.length !== 1 ||
        JSON.stringify(actual[0]) !== JSON.stringify(expected)
      )
        return null
    }
    const countries = tags.filter((tag) => tag[0] === "country")
    if (countries.some((tag) => tag.length < 2)) return null
    const actual = Array.from(
      new Set(countries.flatMap((tag) => tag.slice(1)))
    ).sort()
    if (
      JSON.stringify(actual) !==
      JSON.stringify(draft.tags.find((tag) => tag[0] === "country")!.slice(1))
    )
      return null
    return policy
  } catch {
    return null
  }
}

/** Public policy parsing requires the exact admitted kind-30406 event. */
export function parseShippingPolicyEventTags(
  event: VerifiedNostrEvent
): ShippingPolicy | null {
  if (
    !isVerifiedNostrEvent(event) ||
    event.kind !== EVENT_KINDS.SHIPPING_OPTION
  )
    return null
  return parsePrivateOrderShippingPolicyTags(event.tags)
}
