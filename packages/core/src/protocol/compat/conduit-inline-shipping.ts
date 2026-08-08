import {
  canonicalizeShippingCost,
  type CommerceShippingCostLike,
} from "../../pricing"
import type { ProductSchema } from "../../schemas"

function parseLegacyShippingCostTag(
  tags: string[][] | undefined
): CommerceShippingCostLike {
  const tag = tags?.find((candidate) => candidate[0] === "shipping_cost")
  const raw = tag?.[1]
  if (typeof raw !== "string") return {}

  const amount = Number(raw)
  const currency = typeof tag?.[2] === "string" ? tag[2] : "SATS"
  if (!Number.isFinite(amount) || amount < 0) return {}

  return canonicalizeShippingCost(amount, currency)
}

function parseLegacyShippingCountryRules(tags: string[][] | undefined): {
  shippingCountries?: string[]
  shippingCountryRules?: ProductSchema["shippingCountryRules"]
} {
  if (!tags) return {}
  const shippingCountries = Array.from(
    new Set(
      tags
        .filter((tag) => tag[0] === "shipping_country")
        .flatMap((tag) => tag.slice(1))
        .map((country) => country.trim().toUpperCase())
        .filter(Boolean)
    )
  )
  if (shippingCountries.length === 0) return {}

  return {
    shippingCountries,
    shippingCountryRules: shippingCountries.map((code) => ({
      code,
      name: code,
      restrictTo:
        tags
          .find(
            (tag) =>
              tag[0] === "shipping_restrict" && tag[1]?.toUpperCase() === code
          )
          ?.slice(2)
          .filter(Boolean) ?? [],
      exclude:
        tags
          .find(
            (tag) =>
              tag[0] === "shipping_exclude" && tag[1]?.toUpperCase() === code
          )
          ?.slice(2)
          .filter(Boolean) ?? [],
    })),
  }
}

/**
 * Read-only adapter for Conduit's pre-kind-30406 product shipping tags.
 *
 * Callers may use this projection to edit and upgrade a merchant-owned legacy
 * listing. It is never sufficient to authorize direct payment.
 */
export function parseLegacyConduitInlineShippingTags(
  tags: string[][] | undefined
): Partial<ProductSchema> {
  return {
    ...parseLegacyShippingCostTag(tags),
    ...parseLegacyShippingCountryRules(tags),
  }
}
