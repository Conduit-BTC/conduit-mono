import { useEffect, useMemo, useState } from "react"
import { useCart } from "../hooks/useCart"
import { useProductCartFulfillment } from "../hooks/useProductCartFulfillment"
import { selectCartLine } from "../lib/cart-model"
import {
  cartItemInputFromProductSelection,
  getDefaultProductSelection,
  getProductSelection,
} from "../lib/productVariations"
import { ProductGridCard, type ProductGridCardProps } from "./ProductGridCard"

type ResolvedProductGridCardProps = Omit<
  ProductGridCardProps,
  | "notice"
  | "cartActionDisabled"
  | "cartActionDisabledLabel"
  | "cartQuantity"
  | "onAddToCart"
  | "onDecrement"
  | "onIncrement"
  | "onSelectedProductChange"
  | "selectedProductId"
>

export function ResolvedProductGridCard({
  product,
  family,
  btcUsdRate = null,
  ...props
}: ResolvedProductGridCardProps) {
  const cart = useCart()
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
  const fulfillment = useProductCartFulfillment(selectedProduct, btcUsdRate)
  const resolution = fulfillment.resolution
  const cartCandidate =
    resolution?.status === "standard"
      ? cartItemInputFromProductSelection(product, resolution.product, {
          type: resolution.type,
        })
      : null
  const existing = cartCandidate
    ? selectCartLine(cart.items, cartCandidate)
    : undefined
  const cartQuantity = existing?.quantity ?? 0
  const blocked = !cartCandidate
  const disabledLabel = "Unavailable"

  useEffect(() => {
    setSelectedProductId(defaultSelection.id)
  }, [defaultSelection.id])

  const add = (selection = selectedProduct) => {
    if (selection.id !== selectedProduct.id) return
    if (blocked || !cartCandidate) return
    cart.addItem(cartCandidate, 1)
  }
  const increment = (selection = selectedProduct) => {
    if (selection.id !== selectedProduct.id || !existing || !cartCandidate)
      return
    cart.refreshAndIncrementItem(existing, cartCandidate, 1)
  }
  const decrement = (selection = selectedProduct) => {
    if (selection.id !== selectedProduct.id) return
    if (!existing) return
    if (existing.quantity <= 1) {
      cart.removeItem(existing)
      return
    }
    cart.decrementItem(existing)
  }

  return (
    <ProductGridCard
      {...props}
      product={product}
      family={family}
      btcUsdRate={btcUsdRate}
      selectedProductId={selectedProduct.id}
      onSelectedProductChange={(selection) =>
        setSelectedProductId(selection.id)
      }
      cartQuantity={cartQuantity}
      onAddToCart={add}
      onIncrement={increment}
      onDecrement={decrement}
      cartActionDisabled={blocked}
      cartActionDisabledLabel={disabledLabel}
    />
  )
}
