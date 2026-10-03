import {
  CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
  isSatsLikeCurrency,
  parseShippingOptionAddress,
} from "@conduit/core"
import { getMixedFulfillmentBlockingMessage, type CartItem } from "./cart-model"

const HEX_PUBKEY = /^[0-9a-f]{64}$/

/** UI routing only; preparation independently validates every signed term. */
export function isCheckoutSparkSettledDigitalCart(
  items: readonly Pick<
    CartItem,
    "merchantPubkey" | "format" | "currency" | "sourcePrice" | "fulfillment"
  >[]
): boolean {
  const merchantPubkey = items[0]?.merchantPubkey
  return (
    !!merchantPubkey &&
    HEX_PUBKEY.test(merchantPubkey) &&
    items.every(
      (item) =>
        item.merchantPubkey === merchantPubkey &&
        item.format === "digital" &&
        item.currency === "SATS" &&
        (item.sourcePrice === undefined ||
          isSatsLikeCurrency(item.sourcePrice.normalizedCurrency)) &&
        (item.fulfillment === undefined || item.fulfillment.type === "digital")
    )
  )
}

/** Admission hint only: exact signed fulfillment is rechecked before funding. */
export function isCheckoutSparkSettledCart(
  items: readonly Pick<
    CartItem,
    | "merchantPubkey"
    | "format"
    | "currency"
    | "sourcePrice"
    | "fulfillment"
    | "familyProductId"
    | "selectedSpecifications"
    | "shippingOptionId"
    | "shippingOptionLaunchUnsupported"
  >[]
): boolean {
  const merchantPubkey = items[0]?.merchantPubkey
  return (
    !!merchantPubkey &&
    HEX_PUBKEY.test(merchantPubkey) &&
    !getMixedFulfillmentBlockingMessage([...items]) &&
    items.every((item) => {
      if (
        item.merchantPubkey !== merchantPubkey ||
        item.currency !== "SATS" ||
        item.familyProductId !== undefined ||
        item.selectedSpecifications !== undefined ||
        (item.sourcePrice !== undefined &&
          !isSatsLikeCurrency(item.sourcePrice.normalizedCurrency))
      )
        return false
      if (item.format === "digital")
        return (
          item.fulfillment === undefined || item.fulfillment.type === "digital"
        )
      if (item.fulfillment?.type === "pickup") {
        return (
          item.format === "physical" &&
          item.fulfillment.handoffMode === "merchant_handoff" &&
          item.fulfillment.handlerPubkey === merchantPubkey
        )
      }
      const address =
        item.shippingOptionId &&
        parseShippingOptionAddress(item.shippingOptionId)
      return (
        item.format === "physical" &&
        (item.fulfillment === undefined ||
          item.fulfillment.type === "shipping") &&
        item.shippingOptionLaunchUnsupported !== true &&
        !!address &&
        address.pubkey === merchantPubkey &&
        address.dTag !== CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG
      )
    })
  )
}
