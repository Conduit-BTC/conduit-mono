import { useNavigate } from "@tanstack/react-router"
import {
  getShopperPriceDisplay,
  getProductImageCandidates,
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
import { getPendingMerchantDisplayName } from "./MerchantIdentity"

type ProductGridCardProps = {
  product: Product
  merchantName?: string
  merchantNamePending?: boolean
  imageLoading?: "eager" | "lazy"
  onAddToCart?: () => void
  btcUsdRate?: PricingRateInput
  pricePreference?: ShopperPricePreference
  cartQuantity?: number
  onIncrement?: () => void
  onDecrement?: () => void
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
  cartQuantity = 0,
  onIncrement,
  onDecrement,
  onInvalidImage,
}: ProductGridCardProps) {
  const navigate = useNavigate()
  const merchantNamePending =
    merchantNamePendingOverride ?? !merchantNameOverride
  const merchantName =
    merchantNameOverride ||
    getPendingMerchantDisplayName(product.pubkey, { chars: 6 })
  const { primary, secondary, approximateUsd } = getShopperPriceDisplay(
    product,
    pricePreference,
    typeof btcUsdRate === "object" ? btcUsdRate : null
  )
  const soldOut = product.stock === 0

  return (
    <ProductCard
      title={product.title}
      merchantName={merchantName}
      merchantNamePending={merchantNamePending}
      images={getProductImageCandidates(product)}
      primaryPrice={primary}
      secondaryPrice={secondary}
      approximateUsdPrice={approximateUsd}
      imageLoading={imageLoading}
      cartQuantity={cartQuantity}
      soldOut={soldOut}
      onActivate={() =>
        navigate({
          to: "/products/$productId",
          params: { productId: product.id },
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
            onAddToCart={onAddToCart}
            onIncrement={onIncrement}
            onDecrement={onDecrement}
            soldOut={soldOut}
          />
        ) : undefined
      }
    />
  )
}

export { ProductCardSkeleton as ProductGridCardSkeleton }
