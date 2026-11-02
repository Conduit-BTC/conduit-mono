import {
  createEventGuestReceipt,
  getEventGuestReceiptCommitment,
  type EventGuestReceipt,
} from "@conduit/core/protocol/event-guest-checkout"
import {
  createEventPickupReceiptRepository,
  type EventPickupReceiptBuyerScope,
} from "@conduit/core/protocol/event-pickup-receipt-storage"
import type { ConduitDB } from "@conduit/core/db"
import type { OrderItemFulfillmentSchema } from "@conduit/core/schemas"

export interface CheckoutEventReceiptPreparationInput {
  scope: string
  merchantPubkey: string
  buyerScope: EventPickupReceiptBuyerScope
  items: readonly { fulfillment?: OrderItemFulfillmentSchema }[]
  orderId: string
  shouldContinue: () => boolean
}

/**
 * One mounted checkout attempt owns its receipt, not the render or a download.
 * Every checkout lane awaits this same verified save before publishing. Only
 * the commitment leaves this owner; possession is never reported as payment.
 */
export function createCheckoutEventReceiptPreparation(
  options: { database?: ConduitDB; now?: () => number } = {}
) {
  let draft: {
    scope: string
    binding: string
    receipt: EventGuestReceipt
  } | null = null
  return async (
    input: CheckoutEventReceiptPreparationInput
  ): Promise<{ orderId: string; pickupReceiptCommitment?: string }> => {
    const assertCurrent = () => {
      if (!input.shouldContinue())
        throw new Error("The buyer session changed before receipt saving.")
    }
    assertCurrent()
    const first = input.items[0]?.fulfillment
    const eventItems = input.items.filter(
      (item) => item.fulfillment?.type === "event_market_pickup"
    )
    if (eventItems.length === 0) return { orderId: input.orderId }
    if (
      first?.type !== "event_market_pickup" ||
      eventItems.length !== input.items.length ||
      eventItems.some((item) => {
        const fulfillment = item.fulfillment
        return (
          fulfillment?.type !== "event_market_pickup" ||
          fulfillment.merchantPubkey !== input.merchantPubkey ||
          fulfillment.calendar.coordinate !== first.calendar.coordinate ||
          fulfillment.calendar.eventId !== first.calendar.eventId ||
          fulfillment.calendar.end !== first.calendar.end
        )
      })
    )
      throw new Error("Review the selected Event pickup before continuing.")
    const scope = JSON.stringify([input.scope, input.buyerScope])
    const binding = JSON.stringify([
      input.merchantPubkey,
      first.calendar.coordinate,
      first.calendar.eventId,
      first.calendar.end,
    ])
    if (draft?.scope === scope && draft.binding !== binding)
      throw new Error("The selected Event pickup changed. Review it again.")
    if (draft?.scope !== scope) {
      draft = {
        scope,
        binding,
        receipt: {
          ...createEventGuestReceipt(input.merchantPubkey),
          orderId: input.orderId,
        },
      }
    }
    const saved = await createEventPickupReceiptRepository({
      ...options,
      assertCurrent,
    }).save({
      receipt: draft.receipt,
      buyerScope: input.buyerScope,
      occurrenceCoordinate: first.calendar.coordinate,
      occurrenceEnd: first.calendar.end,
    })
    assertCurrent()
    return {
      orderId: saved.orderId,
      pickupReceiptCommitment: getEventGuestReceiptCommitment(saved.receipt),
    }
  }
}
