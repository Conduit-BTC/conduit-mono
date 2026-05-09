import { useNavigate } from "@tanstack/react-router"
import {
  getProfileName,
  getProductImageCandidates,
  useProfile,
  type Product,
} from "@conduit/core"
import {
  ProductCard,
  ProductCardSkeleton,
  ProductCartAction,
} from "@conduit/ui"
import { getPendingMerchantDisplayName } from "./MerchantIdentity"
import { getProductPriceDisplay } from "../lib/pricing"

type ProductGridCardProps = {
  product: Product
  merchantName?: string
  merchantNamePending?: boolean
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
  merchantNamePending: merchantNamePendingOverride,
  imageLoading = "lazy",
  onAddToCart,
  btcUsdRate,
  cartQuantity = 0,
  onIncrement,
  onDecrement,
  onInvalidImage,
}: ProductGridCardProps) {
  const navigate = useNavigate()
  const profileQuery = useProfile(
    merchantNameOverride ? undefined : product.pubkey,
    { priority: "visible" }
  )
  const profile = profileQuery.data
  const profileName = getProfileName(profile)
  const merchantNamePending =
    merchantNamePendingOverride ?? (!profileName && !!product.pubkey)
  const merchantName =
    merchantNameOverride ||
    profileName ||
    getPendingMerchantDisplayName(product.pubkey, { chars: 6 })
  const { primary, secondary } = getProductPriceDisplay(
    product,
    btcUsdRate ?? null
  )

  return (
    <ProductCard
      title={product.title}
      merchantName={merchantName}
      merchantNamePending={merchantNamePending}
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
