import { useRef, useState } from "react"
import { EventFulfillmentChoice } from "@conduit/ui"
import { useCart } from "../hooks/useCart"
import { prepareEventFulfillmentChoice } from "../lib/event-fulfillment-choice"
import type { CartItem } from "../lib/cart-model"

export function CartEventFulfillmentChoice({
  item,
  authenticatedPubkey,
  disabled = false,
  shouldContinue = () => true,
}: {
  item: CartItem
  authenticatedPubkey: string | null
  disabled?: boolean
  shouldContinue?: () => boolean
}) {
  const cart = useCart()
  const allowed = useRef(true)
  allowed.current = !disabled && shouldContinue()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (
    !item.eventMarketContext &&
    item.fulfillment?.type !== "event_market_pickup"
  )
    return null
  async function change(choice: "shipping" | "event_market_pickup") {
    if (
      (item.fulfillment?.type === "event_market_pickup"
        ? "event_market_pickup"
        : "shipping") === choice
    )
      return
    const revision = cart.revision
    setChecking(true)
    setError(null)
    try {
      const input = await prepareEventFulfillmentChoice(
        item,
        choice,
        authenticatedPubkey,
        () => allowed.current
      )
      if (!allowed.current) return
      const result = await cart.changeFulfillment(item, input, revision)
      if (!result.changed)
        setError("Your cart changed. Review it and try again.")
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not change fulfillment."
      )
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="mt-3 space-y-2">
      <EventFulfillmentChoice
        value={
          item.fulfillment?.type === "event_market_pickup"
            ? "event_market_pickup"
            : "shipping"
        }
        onChange={(choice) => {
          void change(choice)
        }}
        disabled={disabled || checking}
      />
      <p className="text-xs text-[var(--text-muted)]">
        Changing fulfillment updates shipping costs and creates a separate
        purchase.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-[var(--text-muted)]">
          {error}
        </p>
      ) : null}
    </div>
  )
}
