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

type ProductGridCardProps = {
  product: Product
  family?: MarketProductFamily
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
}

export function ProductGridCard({
  product,
  family,
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
}: ProductGridCardProps) {
  const navigate = useNavigate()
  const defaultSelection = useMemo(
    () => getDefaultProductSelection(product, family),
    [family, product]
  )
  const [selectedProductId, setSelectedProductId] = useState(
    defaultSelection.id
  )
  const selectedProduct = getProductSelection(
    product,
    family,
    selectedProductId
  )
  const hasVariations = product.type === "variable" && family?.state === "ready"
  const images = getProductSelectionImages(product, selectedProduct)
  const selectedCartQuantity =
    getCartQuantity?.(selectedProduct) ?? cartQuantity

  useEffect(() => {
    setSelectedProductId(defaultSelection.id)
  }, [defaultSelection.id])

  const merchantNamePending =
    merchantNamePendingOverride ?? !merchantNameOverride
  const merchantName =
    merchantNameOverride ||
    getPendingMerchantDisplayName(product.pubkey, { chars: 6 })
  const selectedPriceDisplay = getShopperPriceDisplay(
    selectedProduct,
    pricePreference,
    typeof btcUsdRate === "object" ? btcUsdRate : null
  )
  const summaryMinimum = family?.priceSummary.minimum?.product
  const summaryPriceDisplay = summaryMinimum
    ? getShopperPriceDisplay(
        summaryMinimum,
        pricePreference,
        typeof btcUsdRate === "object" ? btcUsdRate : null
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
            onSelect={(variation) => setSelectedProductId(variation.id)}
            compact
          />
        ) : undefined
      }
      onActivate={() =>
        navigate({
          to: "/products/$productId",
          params: { productId: selectedProduct.id },
        })
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
          />
        ) : undefined
      }
    />
  )
}

export { ProductCardSkeleton as ProductGridCardSkeleton }
