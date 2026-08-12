import { Link } from "@tanstack/react-router"
import { formatNpub } from "@conduit/core"
import { useCart } from "../hooks/useCart"
import { useProductCartFulfillment } from "../hooks/useProductCartFulfillment"
import {
  createCartItemFromProduct,
  isSameCartFulfillment,
} from "../lib/cart-model"
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
>

export function ResolvedProductGridCard({
  product,
  btcUsdRate = null,
  ...props
}: ResolvedProductGridCardProps) {
  const cart = useCart()
  const fulfillment = useProductCartFulfillment(product, btcUsdRate)
  const resolution = fulfillment.resolution
  const candidate =
    resolution?.status === "pickup" || resolution?.status === "blocked"
      ? resolution.canonicalNaddr
      : fulfillment.candidateNaddr
  const cartCandidate = resolution
    ? resolution.status === "pickup"
      ? createCartItemFromProduct(resolution.product, resolution.fulfillment)
      : resolution.status === "standard"
        ? createCartItemFromProduct(resolution.product, {
            type: resolution.type,
          })
        : null
    : null
  const existing = cart.items.find((item) => item.productId === product.id)
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

  const add = () => {
    if (blocked || !cartCandidate) return
    cart.addItem(cartCandidate, 1)
  }
  const decrement = () => {
    if (!existing || !sameFulfillment) return
    if (existing.quantity <= 1) {
      cart.removeItem(product.id)
      return
    }
    cart.setQuantity(product.id, existing.quantity - 1)
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
        btcUsdRate={btcUsdRate}
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
