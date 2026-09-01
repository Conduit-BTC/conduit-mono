import { useCallback, useEffect, useRef } from "react"
import {
  retryOrderRelayDelivery,
  type OrderLifecycle,
  type RetryOrderRelayDeliveryOptions,
} from "@conduit/core"

import { clearCheckoutShippingSessionForOrderDelivery } from "./checkout-session"

type RetryOrderDeliveryFromOrdersOptions = RetryOrderRelayDeliveryOptions & {
  shippingStorage?: Pick<Storage, "getItem" | "removeItem" | "setItem"> | null
}

export type OrderDeliveryRetryAttempt = {
  signal: AbortSignal
  finish: () => void
}

/**
 * Own one live manual retry per buyer identity. A controller is created only
 * when the user clicks retry, so React StrictMode's setup/cleanup probe cannot
 * leave the next attempt permanently aborted. Identity changes and unmounts
 * still cancel in-flight work.
 */
export function useOrderDeliveryRetryAttempt(
  identityKey: string
): () => OrderDeliveryRetryAttempt {
  const activeController = useRef<AbortController | null>(null)

  useEffect(() => {
    activeController.current?.abort()
    activeController.current = null
    return () => {
      activeController.current?.abort()
      activeController.current = null
    }
  }, [identityKey])

  return useCallback(() => {
    if (!identityKey) {
      throw new Error("Order delivery retry requires an active buyer identity.")
    }
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    return {
      signal: controller.signal,
      finish: () => {
        if (activeController.current === controller) {
          activeController.current = null
        }
      },
    }
  }, [identityKey])
}

/**
 * Orders-route retry boundary. Guest delivery replays the immutable signed
 * wrap through the core worker, then retires only that order's retained
 * same-tab checkout draft once delivery reaches a terminal state.
 */
export async function retryOrderDeliveryFromOrders(
  orderId: string,
  activeBuyerPubkey: string,
  options: RetryOrderDeliveryFromOrdersOptions = {}
): Promise<OrderLifecycle | undefined> {
  const { shippingStorage, ...retryOptions } = options
  const lifecycle = await retryOrderRelayDelivery(
    orderId,
    activeBuyerPubkey,
    retryOptions
  )

  if (
    lifecycle?.buyerIdentityKind === "guest_ephemeral" &&
    lifecycle.orderDeliveryStatus !== "pending"
  ) {
    clearCheckoutShippingSessionForOrderDelivery(orderId, shippingStorage)
  }

  return lifecycle
}
