import type { CheckoutSparkEventMarketBinding } from "./checkout-spark-event-market"
import type { CheckoutSparkCommerceQuote } from "./checkout-spark-reconciliation"
import type { SignedPublicNostrEvent } from "./signed-event"
import { parseCheckoutSparkSignedProductFields } from "./checkout-spark-product-fields"

/** Minimal handout display, never payment, stock or claim authority. */
export type EventMarketOrganizerMerchandise =
  | { readonly state: "unavailable" }
  | {
      readonly state: "ready"
      readonly lines: readonly {
        readonly productCoordinate: string
        readonly title: string
        readonly familyTitle?: string
        readonly quantity: number
        readonly specifications: readonly { key: string; value: string }[]
      }[]
    }

/** Input comes from a separately authenticated frozen purchase, never live listings. */
export function projectEventMarketOrganizerMerchandise(input: {
  merchantPubkey: string
  eventMarket: CheckoutSparkEventMarketBinding
  commerceQuote: CheckoutSparkCommerceQuote
  sourceEvents: readonly SignedPublicNostrEvent[]
}): EventMarketOrganizerMerchandise {
  try {
    const { eventMarket, commerceQuote } = input
    if (
      !eventMarket.lines.length ||
      eventMarket.lines.length !== commerceQuote.lines.length ||
      new Set(eventMarket.lines.map((line) => line.productCoordinate)).size !==
        eventMarket.lines.length ||
      new Set(commerceQuote.lines.map((line) => line.productCoordinate))
        .size !== commerceQuote.lines.length
    )
      return { state: "unavailable" }
    const sources = new Map<string, SignedPublicNostrEvent>()
    for (const event of input.sourceEvents) {
      const previous = sources.get(event.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(event))
        return { state: "unavailable" }
      sources.set(event.id, event)
    }
    const lines = eventMarket.lines.map((line) => {
      const quote = commerceQuote.lines.find(
        (candidate) => candidate.productCoordinate === line.productCoordinate
      )
      const event = sources.get(line.productEventId)
      if (
        !quote ||
        quote.productEventId !== line.productEventId ||
        quote.merchantPubkey !== input.merchantPubkey ||
        quote.quantity !== line.quantity ||
        !event ||
        event.pubkey !== input.merchantPubkey
      )
        throw new Error("Exact handout merchandise is unavailable.")
      const product = parseCheckoutSparkSignedProductFields(event)
      if (
        product.id !== line.productCoordinate ||
        product.type === "variable" ||
        (product.type === "variation") !== (quote.variation !== undefined)
      )
        throw new Error("Exact handout merchandise is unavailable.")
      let familyTitle: string | undefined
      if (quote.variation) {
        const parent = line.parentProduct
        const parentEvent = parent && sources.get(parent.eventId)
        if (
          !parent ||
          !parentEvent ||
          parentEvent.pubkey !== input.merchantPubkey ||
          product.parentProductId !== parent.coordinate ||
          quote.variation.familyCoordinate !== parent.coordinate ||
          JSON.stringify(quote.variation.specifications) !==
            JSON.stringify(product.specifications ?? [])
        )
          throw new Error("Exact handout variation is unavailable.")
        const family = parseCheckoutSparkSignedProductFields(parentEvent)
        if (family.id !== parent.coordinate || family.type !== "variable")
          throw new Error("Exact handout variation is unavailable.")
        familyTitle = family.title
      } else if (line.parentProduct) {
        throw new Error("Unexpected handout variation.")
      }
      return {
        productCoordinate: line.productCoordinate,
        title: product.title,
        ...(familyTitle === undefined ? {} : { familyTitle }),
        quantity: line.quantity,
        specifications: (quote.variation?.specifications ?? []).map(
          (specification) => ({ ...specification })
        ),
      }
    })
    return { state: "ready", lines }
  } catch {
    return { state: "unavailable" }
  }
}
