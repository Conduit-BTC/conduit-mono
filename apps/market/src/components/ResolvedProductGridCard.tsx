import { useEffect, useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { formatNpub } from "@conduit/core"
import { useCart } from "../hooks/useCart"
import { useProductCartFulfillment } from "../hooks/useProductCartFulfillment"
import { isSameCartFulfillment, selectCartItem } from "../lib/cart-model"
import {
  cartItemInputFromProductSelection,
  getDefaultProductSelection,
  getProductSelection,
} from "../lib/productVariations"
import {
  getPickupHandoffPrivacyCopy,
  getPickupHandoffSummary,
} from "../lib/pickup-handoff"
import { ProductGridCard, type ProductGridCardProps } from "./ProductGridCard"

type ResolvedProductGridCardProps = Omit<
  ProductGridCardProps,
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
  const candidate =
    resolution?.status === "pickup" || resolution?.status === "blocked"
      ? resolution.canonicalNaddr
      : fulfillment.candidateNaddr
  const cartCandidate = resolution
    ? resolution.status === "pickup"
      ? cartItemInputFromProductSelection(
          product,
          resolution.product,
          resolution.fulfillment
        )
      : resolution.status === "standard"
        ? cartItemInputFromProductSelection(product, resolution.product, {
            type: resolution.type,
          })
        : null
    : null
  const selectedIdentity = {
    merchantPubkey: selectedProduct.pubkey,
    productId: selectedProduct.id,
  }
  const existing = selectCartItem(cart.items, selectedIdentity)
  const sameFulfillment =
    !!existing &&
    !!cartCandidate &&
    isSameCartFulfillment(existing, cartCandidate)
  const existingFulfillmentConflict = !!existing && !sameFulfillment
  const pickupHandoff =
    resolution?.status === "pickup"
      ? getPickupHandoffSummary(resolution.fulfillment)
      : null
  const cartQuantity = sameFulfillment ? existing.quantity : 0
  const blocked =
    fulfillment.isChecking ||
    resolution?.status === "blocked" ||
    !cartCandidate ||
    existingFulfillmentConflict
  const disabledLabel = fulfillment.isChecking
    ? "Checking pickup"
    : existingFulfillmentConflict
      ? "Review cart"
      : "View event"

  useEffect(() => {
    setSelectedProductId(defaultSelection.id)
  }, [defaultSelection.id])

  const add = (selection = selectedProduct) => {
    if (selection.id !== selectedProduct.id) return
    if (blocked || !cartCandidate) return
    cart.addItem(cartCandidate, 1)
  }
  const decrement = (selection = selectedProduct) => {
    if (selection.id !== selectedProduct.id) return
    if (!existing || !sameFulfillment) return
    if (existing.quantity <= 1) {
      cart.removeItem(selectedIdentity)
      return
    }
    cart.setQuantity(selectedIdentity, existing.quantity - 1)
  }

  const notice = fulfillment.isChecking
    ? "Checking current signed event pickup evidence before this listing can be added."
    : existingFulfillmentConflict
      ? "This listing is already in your cart with different fulfillment. Remove that line before adding it here."
      : resolution?.status === "blocked"
        ? resolution.reason
        : pickupHandoff
          ? `${pickupHandoff.label}. Signed by ${formatNpub(pickupHandoff.handlerPubkey, 10)}. No delivery address is required. ${getPickupHandoffPrivacyCopy(pickupHandoff)}`
          : null

  return (
    <div className="h-full space-y-2">
      <ProductGridCard
        {...props}
        product={product}
        family={family}
        btcUsdRate={btcUsdRate}
        selectedProductId={selectedProduct.id}
        onSelectedProductChange={(selection) =>
          setSelectedProductId(selection.id)
        }
        allowZeroPrice={resolution?.status === "pickup"}
        cartQuantity={cartQuantity}
        onAddToCart={add}
        onIncrement={add}
        onDecrement={decrement}
        cartActionDisabled={blocked}
        cartActionDisabledLabel={disabledLabel}
      />
      {notice ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
          <span>{notice}</span>{" "}
          {candidate ? (
            <Link
              to="/events/$collectionRef"
              params={{ collectionRef: candidate }}
              className="font-medium text-secondary-400 hover:text-secondary-300"
            >
              View event catalog
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
