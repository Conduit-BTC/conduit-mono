import {
  resolvePurchasableSelection,
  type CommerceProductRecord,
  type PreparedProductFamily,
  type Product,
} from "@conduit/core"
import { createCartItemFromProduct, type CartItem } from "./cart-model"

export type MarketProductFamily = PreparedProductFamily<CommerceProductRecord>

export interface ProductVariationAxisOption {
  value: string
  label: string
  soldOut: boolean
  disabled: boolean
}

export interface ProductVariationAxisModel {
  key: string
  label: string
  selectedValue: string
  options: ProductVariationAxisOption[]
}

export interface ProductVariationSelectorModel {
  axes: ProductVariationAxisModel[]
}

const SIZE_PRESENTATION_ORDER = new Map(
  ["xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl"].map((size, index) => [
    size,
    index,
  ])
)
const PRESENTATION_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})

function titleCase(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function getSpecificationValue(product: Product, key: string): string {
  return (
    product.specifications.find(
      (specification) =>
        specification.key.trim().toLowerCase() === key.toLowerCase()
    )?.value ?? ""
  )
}

export function getDefaultProductSelection(
  product: Product,
  family?: MarketProductFamily
): Product {
  if (product.type !== "variable" || !family || family.state !== "ready") {
    return product
  }
  return (
    family.children.find((child) => child.product.stock !== 0)?.product ??
    family.children[0]?.product ??
    product
  )
}

export function getProductSelection(
  product: Product,
  family: MarketProductFamily | undefined,
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
    family?.children.find(
      (candidate) =>
        candidate.product.id === selectedProductId ||
        candidate.product.id === decodedProductId ||
        candidate.addressId === selectedProductId ||
        candidate.addressId === decodedProductId
    )?.product ?? getDefaultProductSelection(product, family)
  )
}

export function getProductVariationSelectorModel(
  family: MarketProductFamily | undefined,
  selectedProduct: Product
): ProductVariationSelectorModel | null {
  if (!family || family.state !== "ready" || family.axes.length === 0) {
    return null
  }

  return {
    axes: family.axes.map((axis) => {
      const selectedValue = getSpecificationValue(selectedProduct, axis.key)
      const otherSelections = selectedProduct.specifications.filter(
        (specification) => specification.key.trim().toLowerCase() !== axis.key
      )
      const presentationValues = [...axis.values].sort((left, right) => {
        if (axis.key !== "size") {
          return PRESENTATION_COLLATOR.compare(left, right)
        }
        return (
          (SIZE_PRESENTATION_ORDER.get(left.trim().toLowerCase()) ??
            Number.MAX_SAFE_INTEGER) -
            (SIZE_PRESENTATION_ORDER.get(right.trim().toLowerCase()) ??
              Number.MAX_SAFE_INTEGER) ||
          PRESENTATION_COLLATOR.compare(left, right)
        )
      })
      const options = presentationValues.map((value) => {
        const compatible = family.children.filter((child) => {
          const hasValue =
            getSpecificationValue(child.product, axis.key).toLowerCase() ===
            value.toLowerCase()
          const matchesOthers = otherSelections.every(
            (selection) =>
              getSpecificationValue(
                child.product,
                selection.key
              ).toLowerCase() === selection.value.trim().toLowerCase()
          )
          return hasValue && matchesOthers
        })
        return {
          value,
          label: value,
          soldOut:
            compatible.length > 0 &&
            compatible.every((child) => child.product.stock === 0),
          disabled: compatible.length === 0,
        }
      })

      return {
        key: axis.key,
        label: titleCase(axis.label),
        selectedValue,
        options,
      }
    }),
  }
}

export function getProductSelectionForAxisValue(
  family: MarketProductFamily,
  selectedProduct: Product,
  axisKey: string,
  value: string
): Product | null {
  const specifications = selectedProduct.specifications.map((specification) =>
    specification.key.trim().toLowerCase() === axisKey
      ? { ...specification, value }
      : specification
  )
  const result = resolvePurchasableSelection(
    { kind: "family", family },
    { specifications }
  )
  return result.status === "selected" ? result.record.product : null
}

export function getProductSelectionImages(
  product: Product,
  selectedProduct: Product
): Array<{ url: string; alt?: string }> {
  if (selectedProduct.images.length > 0) return selectedProduct.images
  if (product.images.length > 0) return product.images
  return []
}

export function cartItemInputFromProductSelection(
  product: Product,
  selectedProduct: Product
): Omit<CartItem, "quantity"> {
  return {
    ...createCartItemFromProduct(selectedProduct),
    familyProductId:
      selectedProduct.type === "variation" ? product.id : undefined,
    selectedSpecifications:
      selectedProduct.type === "variation"
        ? [...selectedProduct.specifications]
        : undefined,
    image: getProductSelectionImages(product, selectedProduct)[0]?.url,
  }
}
