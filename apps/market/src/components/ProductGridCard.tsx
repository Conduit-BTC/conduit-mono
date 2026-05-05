import { useNavigate } from "@tanstack/react-router"
import {
  formatPubkey,
  getProductImageCandidates,
  useProfile,
  type Product,
} from "@conduit/core"
import {
  ProductCard,
  ProductCardSkeleton,
  ProductCartAction,
} from "@conduit/ui"
import { getProductPriceDisplay } from "../lib/pricing"

type ProductGridCardProps = {
  product: Product
  merchantName?: string
  imageLoading?: "eager" | "lazy"
  onAddToCart?: () => void
  btcUsdRate?: number | null
  cartQuantity?: number
  onIncrement?: () => void
  onDecrement?: () => void
  onInvalidImage?: (productId: string) => void
}

export function ProductGridCard({
  product,
  merchantName: merchantNameOverride,
  imageLoading = "lazy",
  onAddToCart,
  btcUsdRate,
  cartQuantity = 0,
  onIncrement,
  onDecrement,
  onInvalidImage,
}: ProductGridCardProps) {
  const navigate = useNavigate()
  const { data: profile } = useProfile(
    merchantNameOverride ? undefined : product.pubkey
  )
  const merchantName =
    merchantNameOverride ||
    profile?.displayName ||
    profile?.name ||
    formatPubkey(product.pubkey, 6)
  const { primary, secondary } = getProductPriceDisplay(
    product,
    btcUsdRate ?? null
  )

  return (
    <ProductCard
      title={product.title}
      merchantName={merchantName}
      images={getProductImageCandidates(product)}
      primaryPrice={primary}
      secondaryPrice={secondary}
      imageLoading={imageLoading}
      cartQuantity={cartQuantity}
      onActivate={() =>
        navigate({
          to: "/products/$productId",
          params: { productId: product.id },
        })
      }
      onMerchantActivate={() =>
        navigate({
          to: "/store/$pubkey",
          params: { pubkey: product.pubkey },
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
          />
        ) : undefined
      }
    />
  )
}

export { ProductCardSkeleton as ProductGridCardSkeleton }
