import {
  getDefaultProductSelection as getCoreDefaultProductSelection,
  getProductImageCandidates,
  type Product,
} from "@conduit/core"
import { createCartItemFromProduct, type CartItem } from "./cart-model"

export interface ProductVariationOption {
  product: Product
  label: string
  soldOut: boolean
}

export interface ProductVariationSelectorModel {
  label: string
  options: ProductVariationOption[]
}

const SIZE_ORDER = new Map(
  ["xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl"].map((size, index) => [
    size,
    index,
  ])
)
const NATURAL_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})

function titleCase(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function getSpecificationValue(
  product: Product,
  key: string
): string | undefined {
  return product.specifications.find(
    (specification) =>
      specification.key.trim().toLowerCase() === key.toLowerCase()
  )?.value
}

function compareOptionLabels(
  left: ProductVariationOption,
  right: ProductVariationOption,
  singleKey?: string
): number {
  if (singleKey?.toLowerCase() === "size") {
    const leftRank = SIZE_ORDER.get(left.label.trim().toLowerCase())
    const rightRank = SIZE_ORDER.get(right.label.trim().toLowerCase())
    if (leftRank !== undefined || rightRank !== undefined) {
      return (
        (leftRank ?? Number.MAX_SAFE_INTEGER) -
          (rightRank ?? Number.MAX_SAFE_INTEGER) ||
        NATURAL_COLLATOR.compare(left.label, right.label)
      )
    }
  }

  return NATURAL_COLLATOR.compare(left.label, right.label)
}

export function getProductVariationSelectorModel(
  product: Product
): ProductVariationSelectorModel | null {
  const variations = product.variations ?? []
  if (product.type !== "variable" || variations.length === 0) return null

  const specificationKeys = Array.from(
    new Map(
      variations.flatMap((variation) =>
        variation.specifications.map((specification) => [
          specification.key.trim().toLowerCase(),
          specification.key.trim(),
        ])
      )
    ).values()
  ).filter(Boolean)
  const varyingKeys = specificationKeys.filter((key) => {
    const values = new Set(
      variations.map((variation) => getSpecificationValue(variation, key) ?? "")
    )
    return values.size > 1
  })

  const selectorLabel =
    varyingKeys.length === 1
      ? titleCase(varyingKeys[0]!)
      : varyingKeys.length > 1
        ? "Options"
        : "Option"
  const options = variations
    .map((variation) => {
      let label = variation.title
      if (varyingKeys.length === 1) {
        label =
          getSpecificationValue(variation, varyingKeys[0]!) ?? variation.title
      } else if (varyingKeys.length > 1) {
        label = varyingKeys
          .map((key) => {
            const value = getSpecificationValue(variation, key)
            return value ? `${titleCase(key)}: ${value}` : null
          })
          .filter(Boolean)
          .join(" / ")
      } else if (variation.specifications.length > 0) {
        label = variation.specifications
          .map(
            (specification) =>
              `${titleCase(specification.key)}: ${specification.value}`
          )
          .join(" / ")
      }

      return {
        product: variation,
        label,
        soldOut: variation.stock === 0,
      }
    })
    .sort((left, right) =>
      compareOptionLabels(
        left,
        right,
        varyingKeys.length === 1 ? varyingKeys[0] : undefined
      )
    )

  return { label: selectorLabel, options }
}

export { getCoreDefaultProductSelection as getDefaultProductSelection }

export function getProductSelection(
  product: Product,
  selectedProductId?: string
): Product {
  let decodedProductId = selectedProductId
  try {
    decodedProductId = selectedProductId
      ? decodeURIComponent(selectedProductId)
      : selectedProductId
  } catch {
    // Preserve the raw route value when it is not valid percent encoding.
  }

  return (
    product.variations?.find(
      (variation) =>
        variation.id === selectedProductId || variation.id === decodedProductId
    ) ?? getCoreDefaultProductSelection(product)
  )
}

export function getProductSelectionImages(
  product: Product,
  selectedProduct: Product
): Array<{ url: string; alt?: string }> {
  const selectedImages = getProductImageCandidates(selectedProduct)
  if (selectedImages.length > 0) return selectedImages

  const parentImages = getProductImageCandidates(product)
  if (parentImages.length > 0) return parentImages

  for (const variation of product.variations ?? []) {
    const siblingImages = getProductImageCandidates(variation)
    if (siblingImages.length > 0) return siblingImages
  }

  return []
}

export function cartItemInputFromProductSelection(
  product: Product,
  selectedProduct: Product
): Omit<CartItem, "quantity"> {
  return {
    ...createCartItemFromProduct(selectedProduct),
    image: getProductSelectionImages(product, selectedProduct)[0]?.url,
  }
}
