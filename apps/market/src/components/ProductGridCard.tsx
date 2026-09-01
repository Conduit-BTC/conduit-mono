import { useNavigate } from "@tanstack/react-router"
import {
  getShopperPriceDisplay,
  pubkeyToNpub,
  type PricingRateInput,
  type Product,
  type ShopperPricePreference,
} from "@conduit/core"
import {
  ProductCard,
  ProductCardSkeleton,
  ProductCartAction,
} from "@conduit/ui"
import { useEffect, useMemo, useState } from "react"
import { getProductAddAvailability } from "../lib/cart-model"
import {
  getDefaultProductSelection,
  getProductSelection,
  getProductSelectionImages,
  type MarketProductFamily,
} from "../lib/productVariations"
import { getPendingMerchantDisplayName } from "./MerchantIdentity"
import { ProductVariationSelector } from "./ProductVariationSelector"

export const PRODUCT_GRID_CLASS_NAME =
  "grid list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4"

export type ProductGridCardProps = {
  product: Product
  family?: MarketProductFamily
  familyHydrating?: boolean
  className?: string
  selectedProductId?: string
  onSelectedProductChange?: (product: Product) => void
  merchantName?: string
  merchantNamePending?: boolean
  imageLoading?: "eager" | "lazy"
  onAddToCart?: (product: Product) => void
  btcUsdRate?: PricingRateInput
  pricePreference?: ShopperPricePreference
  cartQuantity?: number
  getCartQuantity?: (product: Product) => number
  onIncrement?: (product: Product) => void
  onDecrement?: (product: Product) => void
  onInvalidImage?: (productId: string) => void
  /** Allow an intentional zero price only after exact pickup evidence resolves. */
  allowZeroPrice?: boolean
  cartActionDisabled?: boolean
  cartActionDisabledLabel?: string
  /** `null` keeps the card on the current workflow surface. */
  onProductActivate?: (() => void) | null
}

export function ProductGridCard({
  product,
  family,
  familyHydrating = false,
  className,
  selectedProductId: controlledSelectedProductId,
  onSelectedProductChange,
  merchantName: merchantNameOverride,
  merchantNamePending: merchantNamePendingOverride,
  imageLoading = "lazy",
  onAddToCart,
  btcUsdRate,
  pricePreference,
  cartQuantity = 0,
  getCartQuantity,
  onIncrement,
  onDecrement,
  onInvalidImage,
  allowZeroPrice = false,
  cartActionDisabled = false,
  cartActionDisabledLabel,
  onProductActivate,
}: ProductGridCardProps) {
  const navigate = useNavigate()
  const defaultSelection = useMemo(
    () => getDefaultProductSelection(product, family),
    [family, product]
  )
  const [internalSelectedProductId, setInternalSelectedProductId] = useState(
    defaultSelection.id
  )
  const selectedProductId =
    controlledSelectedProductId ?? internalSelectedProductId
  const selectedProduct = getProductSelection(
    product,
    family,
    selectedProductId
  )
  const hasVariations = product.type === "variable" && family?.state === "ready"
  const showVariationSkeleton =
    product.type === "variable" && familyHydrating && !hasVariations
  const images = getProductSelectionImages(product, selectedProduct)
  const selectedCartQuantity =
    getCartQuantity?.(selectedProduct) ?? cartQuantity

  useEffect(() => {
    if (controlledSelectedProductId === undefined) {
      setInternalSelectedProductId(defaultSelection.id)
    }
  }, [controlledSelectedProductId, defaultSelection.id])

  const merchantNamePending =
    merchantNamePendingOverride ?? !merchantNameOverride
  const merchantName =
    merchantNameOverride ||
    getPendingMerchantDisplayName(product.pubkey, { chars: 6 })
  const selectedPriceDisplay = getShopperPriceDisplay(
    selectedProduct,
    pricePreference,
    typeof btcUsdRate === "object" ? btcUsdRate : null,
    { allowZero: allowZeroPrice }
  )
  const summaryMinimum = family?.priceSummary.minimum?.product
  const summaryPriceDisplay = summaryMinimum
    ? getShopperPriceDisplay(
        summaryMinimum,
        pricePreference,
        typeof btcUsdRate === "object" ? btcUsdRate : null,
        { allowZero: allowZeroPrice }
      )
    : selectedPriceDisplay
  const primary =
    family?.priceSummary.varies === true
      ? `From ${summaryPriceDisplay.primary}`
      : summaryPriceDisplay.primary
  const secondary = summaryPriceDisplay.secondary
  const approximateUsd = summaryPriceDisplay.approximateUsd
  const soldOut = selectedProduct.stock === 0
  const atStockLimit =
    !soldOut &&
    getProductAddAvailability(selectedProduct.stock, selectedCartQuantity, 1)
      .canAdd === false

  return (
    <ProductCard
      className={className ?? "h-full"}
      title={product.title}
      merchantName={merchantName}
      merchantNamePending={merchantNamePending}
      images={images}
      primaryPrice={primary}
      secondaryPrice={secondary}
      approximateUsdPrice={approximateUsd}
      imageLoading={imageLoading}
      cartQuantity={selectedCartQuantity}
      soldOut={soldOut}
      options={
        hasVariations ? (
          <ProductVariationSelector
            family={family!}
            selectedProduct={selectedProduct}
            onSelect={(variation) => {
              setInternalSelectedProductId(variation.id)
              onSelectedProductChange?.(variation)
            }}
            compact
          />
        ) : showVariationSkeleton ? (
          <ProductVariationLoadingSkeleton />
        ) : undefined
      }
      onActivate={
        onProductActivate === null
          ? undefined
          : (onProductActivate ??
            (() =>
              navigate({
                to: "/products/$productId",
                params: { productId: selectedProduct.id },
              })))
      }
      onMerchantActivate={() =>
        navigate({
          to: "/store/$pubkey",
          params: { pubkey: pubkeyToNpub(product.pubkey) },
        })
      }
      onInvalidImage={() => onInvalidImage?.(product.id)}
      action={
        onAddToCart ? (
          <ProductCartAction
            title={product.title}
            cartQuantity={selectedCartQuantity}
            onAddToCart={() => onAddToCart(selectedProduct)}
            onIncrement={
              onIncrement ? () => onIncrement(selectedProduct) : undefined
            }
            onDecrement={
              onDecrement ? () => onDecrement(selectedProduct) : undefined
            }
            soldOut={soldOut}
            atStockLimit={atStockLimit}
            disabled={cartActionDisabled}
            disabledLabel={cartActionDisabledLabel}
          />
        ) : undefined
      }
    />
  )
}

function ProductVariationLoadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading product options"
      className="space-y-2 animate-pulse"
    >
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="space-y-1.5">
          <div className="h-3 w-16 rounded bg-[var(--surface-elevated)]" />
          <div className="h-8 rounded-md bg-[var(--surface-elevated)]" />
        </div>
      ))}
    </div>
  )
}

export { ProductCardSkeleton as ProductGridCardSkeleton }
