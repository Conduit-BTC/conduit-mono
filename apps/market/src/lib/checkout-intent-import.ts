import {
  getProductsByIds,
  hasExactLiveProductAvailabilityEvidence,
  type CheckoutIntent,
} from "@conduit/core"
import {
  createCartItemFromProduct,
  groupCartPurchases,
  type CartItem,
} from "./cart-model"
import { getProductEventMarketCandidates } from "./event-market-adapter"

export type CheckoutImportError =
  | "merchant_scope_mismatch"
  | "product_unresolved"
  | "relay_unavailable"
  | "product_unavailable"
  | "incompatible_checkout"

export type CheckoutImportPreparation =
  | {
      status: "ready"
      merchantPubkey: string
      purchaseId: string
      items: CartItem[]
    }
  | { status: "error"; error: CheckoutImportError }

export async function prepareCheckoutIntent(
  intent: CheckoutIntent,
  options: {
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
  } = {},
  read: typeof getProductsByIds = getProductsByIds
): Promise<CheckoutImportPreparation> {
  if (
    new Set(intent.items.map((item) => item.coordinate.split(":")[1])).size !==
    1
  ) {
    return { status: "error", error: "merchant_scope_mismatch" }
  }
  let result: Awaited<ReturnType<typeof getProductsByIds>>
  try {
    result = await read(
      intent.items.map((item) => item.product),
      {
        authenticatedPubkey: options.authenticatedPubkey,
        shouldContinue: options.shouldContinue,
      }
    )
  } catch {
    return { status: "error", error: "relay_unavailable" }
  }
  const records = new Map(
    result.data.map((record) => [record.addressId, record])
  )
  const diagnostics = new Map(
    result.diagnostics.map((row) => [row.productId, row])
  )
  const items: CartItem[] = []
  for (const requested of intent.items) {
    const diagnostic = diagnostics.get(requested.product)
    const record = records.get(requested.coordinate)
    if (
      !record ||
      !diagnostic ||
      !hasExactLiveProductAvailabilityEvidence(
        diagnostic,
        requested.coordinate
      ) ||
      result.meta.source !== "commerce"
    ) {
      const issue = diagnostic?.issue
      const error: CheckoutImportError =
        issue === "lookup_unavailable" ||
        issue === "lookup_partial" ||
        issue === "cached_only" ||
        result.meta.source !== "commerce"
          ? "relay_unavailable"
          : issue === "listing_filtered"
            ? "product_unavailable"
            : "product_unresolved"
      return { status: "error", error }
    }
    const product = record.product
    if (
      product.id !== requested.coordinate ||
      product.pubkey !== requested.coordinate.split(":")[1] ||
      product.type === "variable" ||
      product.visibility !== "public" ||
      product.priceEvidenceMalformed ||
      product.stock === 0 ||
      (product.stock !== undefined && product.stock < requested.quantity)
    ) {
      return { status: "error", error: "product_unavailable" }
    }
    if (getProductEventMarketCandidates(product).length > 0) {
      return { status: "error", error: "incompatible_checkout" }
    }
    items.push({
      ...createCartItemFromProduct(product),
      quantity: requested.quantity,
    })
  }
  const groups = groupCartPurchases(items)
  if (groups.length !== 1 || groups[0]?.kind !== "delivery") {
    return { status: "error", error: "incompatible_checkout" }
  }
  return {
    status: "ready",
    merchantPubkey: groups[0].merchantPubkey,
    purchaseId: groups[0].id,
    items,
  }
}
