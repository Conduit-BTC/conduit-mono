import {
  CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
  isSupportedCommercePriceCurrency,
  parseShippingOptionAddress,
} from "@conduit/core"
import { getMixedFulfillmentBlockingMessage, type CartItem } from "./cart-model"

const HEX_PUBKEY = /^[0-9a-f]{64}$/

function hasSupportedPrice(item: {
  currency: string
  sourcePrice?: { currency: string }
}): boolean {
  return isSupportedCommercePriceCurrency(
    item.sourcePrice?.currency ?? item.currency
  )
}

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
        hasSupportedPrice(item) &&
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
        !hasSupportedPrice(item) ||
        (item.familyProductId !== undefined &&
          (!item.familyProductId.startsWith(`30402:${merchantPubkey}:`) ||
            !/^30402:[0-9a-f]{64}:.+$/.test(item.familyProductId)))
      )
        return false
      if (item.format === "digital")
        return (
          item.fulfillment === undefined || item.fulfillment.type === "digital"
        )
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
