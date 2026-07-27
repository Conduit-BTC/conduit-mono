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
import { getPendingMerchantDisplayName } from "./MerchantIdentity"
import { ProductVariationSelector } from "./ProductVariationSelector"
import { getProductAddAvailability } from "../lib/cart-model"
import {
  getDefaultProductSelection,
  getProductSelection,
  getProductSelectionImages,
} from "../lib/productVariations"

type ProductGridCardProps = {
  product: Product
  merchantName?: string
  merchantNamePending?: boolean
  imageLoading?: "eager" | "lazy"
  onAddToCart?: (product: Product) => void
  btcUsdRate?: PricingRateInput
  pricePreference?: ShopperPricePreference
  getCartQuantity?: (product: Product) => number
  onIncrement?: (product: Product) => void
  onDecrement?: (product: Product) => void
  onInvalidImage?: (productId: string) => void
}

export function ProductGridCard({
  product,
  merchantName: merchantNameOverride,
  merchantNamePending: merchantNamePendingOverride,
  imageLoading = "lazy",
  onAddToCart,
  btcUsdRate,
  pricePreference,
  getCartQuantity,
  onIncrement,
  onDecrement,
  onInvalidImage,
}: ProductGridCardProps) {
  const navigate = useNavigate()
  const defaultSelection = useMemo(
    () => getDefaultProductSelection(product),
    [product]
  )
  const [selectedProductId, setSelectedProductId] = useState(
    defaultSelection.id
  )
  const selectedProduct = getProductSelection(product, selectedProductId)
  const hasVariations =
    product.type === "variable" && (product.variations?.length ?? 0) > 0
  const images = getProductSelectionImages(product, selectedProduct)
  const cartQuantity = getCartQuantity?.(selectedProduct) ?? 0

  useEffect(() => {
    setSelectedProductId(defaultSelection.id)
  }, [defaultSelection.id])

  const merchantNamePending =
    merchantNamePendingOverride ?? !merchantNameOverride
  const merchantName =
    merchantNameOverride ||
    getPendingMerchantDisplayName(product.pubkey, { chars: 6 })
  const { primary, secondary, approximateUsd } = getShopperPriceDisplay(
    selectedProduct,
    pricePreference,
    typeof btcUsdRate === "object" ? btcUsdRate : null
  )
  const soldOut = selectedProduct.stock === 0
  const atStockLimit =
    !soldOut &&
    getProductAddAvailability(selectedProduct.stock, cartQuantity, 1).canAdd ===
      false

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
      cartQuantity={cartQuantity}
      soldOut={soldOut}
      options={
        hasVariations ? (
          <ProductVariationSelector
            product={product}
            selectedProductId={selectedProduct.id}
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
            cartQuantity={cartQuantity}
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
