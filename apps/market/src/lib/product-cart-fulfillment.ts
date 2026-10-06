import type { Product } from "@conduit/core"

export type ProductCartFulfillmentResolution = {
  status: "standard"
  type: "digital" | "shipping"
  product: Product
}

/** Event pickup is selected explicitly from a current signed Event Market. */
export function resolveProductCartFulfillment(
  product: Product
): ProductCartFulfillmentResolution {
  return {
    status: "standard",
    type: product.format === "digital" ? "digital" : "shipping",
    product,
  }
}
