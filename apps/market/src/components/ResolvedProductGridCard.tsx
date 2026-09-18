import { useEffect, useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useCart } from "../hooks/useCart"
import { useEventActorIdentity } from "../hooks/useEventActorIdentity"
import { useProductCartFulfillment } from "../hooks/useProductCartFulfillment"
import { isSameCartLineFulfillment } from "../lib/cart-model"
import {
  cartItemInputFromProductSelection,
  getDefaultProductSelection,
  getProductSelection,
} from "../lib/productVariations"
import {
  getPickupHandoffPrivacyCopy,
  getPickupHandoffSummary,
} from "../lib/pickup-handoff"
import { EventActorName, EventActorProvenance } from "./EventActorIdentity"
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
  const existing = cartCandidate
    ? cart.items.find(
        (item) =>
          item.merchantPubkey === selectedProduct.pubkey &&
          item.productId === selectedProduct.id &&
          isSameCartLineFulfillment(item, cartCandidate)
      )
    : undefined
  const pickupHandoff =
    resolution?.status === "pickup"
      ? getPickupHandoffSummary(resolution.fulfillment)
      : null
  const pickupHandlerIdentity = useEventActorIdentity(
    pickupHandoff?.handlerPubkey
  )
  const cartQuantity = existing?.quantity ?? 0
  const blocked =
    fulfillment.isChecking || resolution?.status === "blocked" || !cartCandidate
  const disabledLabel = fulfillment.isChecking
    ? "Checking pickup"
    : "View event"

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

  const notice = fulfillment.isChecking
    ? "Checking current signed event pickup evidence before this listing can be added."
    : resolution?.status === "blocked"
      ? resolution.reason
      : null
  const showPickupNotice = !!pickupHandoff && !!pickupHandlerIdentity && !notice

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
      allowZeroPrice={resolution?.status === "pickup"}
      cartQuantity={cartQuantity}
      onAddToCart={add}
      onIncrement={increment}
      onDecrement={decrement}
      cartActionDisabled={blocked}
      cartActionDisabledLabel={disabledLabel}
      notice={
        notice || showPickupNotice ? (
          <>
            {showPickupNotice && pickupHandoff && pickupHandlerIdentity ? (
              <>
                <span>
                  {pickupHandoff.label}. Handled by{" "}
                  <EventActorName identity={pickupHandlerIdentity} />. No
                  delivery address is required.{" "}
                  {getPickupHandoffPrivacyCopy(pickupHandoff)}
                </span>
                <EventActorProvenance
                  pubkey={pickupHandoff.handlerPubkey}
                  copyLabel="Copy pickup handler npub"
                  className="mt-1 flex"
                />{" "}
              </>
            ) : (
              <span>{notice}</span>
            )}{" "}
            {candidate ? (
              <Link
                to="/events/$collectionRef"
                params={{ collectionRef: candidate }}
                className="font-medium text-secondary-400 hover:text-secondary-300"
              >
                View event catalog
              </Link>
            ) : null}
          </>
        ) : null
      }
    />
  )
}
