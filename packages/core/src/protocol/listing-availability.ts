import type { Product } from "../types"
import { normalizePublicMediaUrl } from "../network-target-safety"

export type ListingAvailabilityState = "active" | "hidden" | "unsupported"

export interface ListingAvailabilityReason {
  code: "merchant_hidden" | "missing_market_image" | "unsupported_product_type"
  label: string
  detail: string
  merchantAction: string
}

export interface ListingAvailabilityEvaluation {
  state: ListingAvailabilityState
  reasons: ListingAvailabilityReason[]
  marketVisible: boolean
  purchasable: boolean
}

export interface ListingAvailabilityContext {
  /** Commerce must establish a reachable parent/child group first. */
  variationGroupRole?: "parent" | "variation"
  /** Another member of the prepared group can supply the card image. */
  hasGroupImage?: boolean
}

export function hasMarketVisibleListingImage(
  product: Pick<Product, "images">
): boolean {
  return product.images.some(
    (image) => normalizePublicMediaUrl(image.url) !== null
  )
}

/** Structural display/checkout capability only; no content-policy assessment. */
export function evaluateListingAvailability(
  product: Product,
  context: ListingAvailabilityContext = {}
): ListingAvailabilityEvaluation {
  const reasons: ListingAvailabilityReason[] = []
  if (product.visibility !== "public") {
    reasons.push({
      code: "merchant_hidden",
      label: "Hidden by merchant",
      detail: "This listing is not marked public by the merchant.",
      merchantAction: "Publish the listing as public to include it in Market.",
    })
  }
  if (!context.hasGroupImage && !hasMarketVisibleListingImage(product)) {
    reasons.push({
      code: "missing_market_image",
      label: "Missing Market image",
      detail:
        "Market listings need at least one usable http or https image URL.",
      merchantAction:
        "Add a valid image URL to display this listing in Market.",
    })
  }
  const supportedVariationGroupRole =
    (product.type === "variable" && context.variationGroupRole === "parent") ||
    (product.type === "variation" && context.variationGroupRole === "variation")
  if (product.type !== "simple" && !supportedVariationGroupRole) {
    reasons.push({
      code: "unsupported_product_type",
      label: "Unsupported listing structure",
      detail:
        "This listing needs a supported product type or a complete variation group.",
      merchantAction:
        "Publish a simple listing or complete its variation group.",
    })
  }
  const state: ListingAvailabilityState = reasons.some(
    (reason) => reason.code === "unsupported_product_type"
  )
    ? "unsupported"
    : reasons.length > 0
      ? "hidden"
      : "active"
  return {
    state,
    reasons,
    marketVisible: state === "active",
    purchasable: state === "active",
  }
}

/** Exact pickup reads can recover merchant-hidden listings, never broken ones. */
export function isMerchantHiddenOnlyListingAvailable(
  availability: ListingAvailabilityEvaluation
): boolean {
  return (
    availability.state === "active" ||
    (availability.state === "hidden" &&
      availability.reasons.length > 0 &&
      availability.reasons.every((reason) => reason.code === "merchant_hidden"))
  )
}

export function isListingMarketVisible(
  evaluation: Pick<ListingAvailabilityEvaluation, "marketVisible">
): boolean {
  return evaluation.marketVisible
}

export function isListingPurchasable(
  evaluation: Pick<ListingAvailabilityEvaluation, "purchasable">
): boolean {
  return evaluation.purchasable
}

export function getListingAvailabilityDisplay(
  evaluation: Pick<ListingAvailabilityEvaluation, "state" | "reasons">
): {
  label: string
  summary: string
  merchantAction: string
  tone: "success" | "warning" | "error" | "info" | "neutral"
} {
  if (evaluation.state === "active") {
    return {
      label: "Active",
      summary: "Public listing with supported structure and a usable image.",
      merchantAction: "No action needed.",
      tone: "success",
    }
  }
  const primary =
    evaluation.reasons.find((reason) =>
      evaluation.state === "unsupported"
        ? reason.code === "unsupported_product_type"
        : reason.code !== "unsupported_product_type"
    ) ?? evaluation.reasons[0]
  return {
    label: evaluation.state === "unsupported" ? "Unsupported" : "Hidden",
    summary: primary?.detail ?? "This listing is unavailable in Market.",
    merchantAction:
      primary?.merchantAction ?? "Update the listing before publishing.",
    tone: evaluation.state === "unsupported" ? "error" : "warning",
  }
}
