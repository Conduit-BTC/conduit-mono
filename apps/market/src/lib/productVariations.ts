import {
  parseGroupedProductOptionValue,
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
  group?: string
  soldOut: boolean
  disabled: boolean
}

export interface ProductVariationAxisOptionGroup {
  label: string
  options: ProductVariationAxisOption[]
}

export interface ProductVariationAxisModel {
  key: string
  label: string
  selectedValue: string
  selectedLabel: string
  options: ProductVariationAxisOption[]
  optionGroups: ProductVariationAxisOptionGroup[] | null
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

function isSizeAxis(value: string): boolean {
  return value
    .trim()
    .split(/[^a-z0-9]+/i)
    .some((part) => ["size", "sizes"].includes(part.toLowerCase()))
}

function compareProductOptionValues(
  axisKey: string,
  left: string,
  right: string
): number {
  const leftGrouped = parseGroupedProductOptionValue(left)
  const rightGrouped = parseGroupedProductOptionValue(right)
  const groupOrder = PRESENTATION_COLLATOR.compare(
    leftGrouped?.group ?? "",
    rightGrouped?.group ?? ""
  )
  if (groupOrder !== 0) return groupOrder

  const leftValue = leftGrouped?.value ?? left
  const rightValue = rightGrouped?.value ?? right
  if (!isSizeAxis(axisKey)) {
    return PRESENTATION_COLLATOR.compare(leftValue, rightValue)
  }
  return (
    (SIZE_PRESENTATION_ORDER.get(leftValue.trim().toLowerCase()) ??
      Number.MAX_SAFE_INTEGER) -
      (SIZE_PRESENTATION_ORDER.get(rightValue.trim().toLowerCase()) ??
        Number.MAX_SAFE_INTEGER) ||
    PRESENTATION_COLLATOR.compare(leftValue, rightValue)
  )
}

function getProductOptionGroups(
  options: ProductVariationAxisOption[]
): ProductVariationAxisOptionGroup[] | null {
  if (options.length === 0 || options.some((option) => !option.group)) {
    return null
  }

  const groups = new Map<string, ProductVariationAxisOption[]>()
  for (const option of options) {
    const label = option.group!
    groups.set(label, [...(groups.get(label) ?? []), option])
  }
  return Array.from(groups, ([label, groupOptions]) => ({
    label,
    options: groupOptions,
  }))
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
      const selectedLabel = selectedValue
      const otherSelections = selectedProduct.specifications.filter(
        (specification) => specification.key.trim().toLowerCase() !== axis.key
      )
      const presentationValues = [...axis.values].sort((left, right) =>
        compareProductOptionValues(axis.key, left, right)
      )
      const groupedPresentationValues = isSizeAxis(axis.key)
        ? presentationValues.map(parseGroupedProductOptionValue)
        : []
      const presentAsGroups =
        groupedPresentationValues.length > 0 &&
        groupedPresentationValues.every((value) => value !== null)
      const options = presentationValues.map((value) => {
        const groupedValue = parseGroupedProductOptionValue(value)
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
          label: presentAsGroups && groupedValue ? groupedValue.value : value,
          ...(presentAsGroups && groupedValue
            ? { group: groupedValue.group }
            : {}),
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
        selectedLabel,
        options,
        optionGroups: getProductOptionGroups(options),
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
