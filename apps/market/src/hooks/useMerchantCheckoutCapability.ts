import { useEffect, useMemo, useState } from "react"
import { hasWebLN, useAuth, validateAddressConsistency } from "@conduit/core"
import {
  useMerchantLnurlPreflight,
  type MerchantCartReadiness,
} from "./useCartReadiness"
import { useShopperPricing } from "./useShopperPricing"
import { useWallet } from "./useWallet"
import {
  deriveMerchantCheckoutCapability,
  getMerchantCapabilityFallbackMessage,
  type MerchantCheckoutCapability,
  type MerchantLnurlPreflight,
} from "../lib/cart-readiness"
import {
  cartItemsMatchCurrentProducts,
  getCartCostSummary,
  type CartItem,
} from "../lib/cart-model"
import { buildCheckoutPricingIntent } from "../lib/checkout-payment"
import { readCheckoutShippingSession } from "../lib/checkout-session"
import {
  buildShippingAddressFromForm,
  validateShippingFields,
} from "../lib/checkout-validation"
import {
  getCartShippingDestinationEligibility,
  hasPhysicalItemsMissingShippingZone,
} from "../lib/cart-shipping-options"

export type MerchantCheckoutCapabilityView = {
  capability: MerchantCheckoutCapability
  fallbackMessage: string
  pricingIntent: ReturnType<typeof buildCheckoutPricingIntent> | null
  lnurl: MerchantLnurlPreflight
}

/**
 * Shared Zap Out capability view for one merchant's cart group.
 *
 * The HUD and the cart route consume this same derivation over the same
 * prepared readiness and LNURL preflight evidence, so the surfaces cannot
 * disagree about eligibility. Checkout consumes the same prepared queries
 * and applies its strictly stronger authoritative eligibility and payment
 * validation on explicit intent.
 */
export function useMerchantCheckoutCapability(input: {
  items: readonly CartItem[]
  readiness: MerchantCartReadiness | undefined
  merchantLud16: string | null | undefined
  enabled?: boolean
}): MerchantCheckoutCapabilityView {
  const { pubkey, status: authStatus } = useAuth()
  const wallet = useWallet()
  const shopperPricing = useShopperPricing()
  const enabled = input.enabled ?? true
  const [webLnAvailable, setWebLnAvailable] = useState(false)
  useEffect(() => {
    const check = () => setWebLnAvailable(hasWebLN())
    check()
    window.addEventListener("focus", check)
    return () => window.removeEventListener("focus", check)
  }, [])

  const lnurlPreflight = useMerchantLnurlPreflight(input.merchantLud16, {
    enabled,
  })
  const items = useMemo(() => Array.from(input.items), [input.items])
  const summary =
    items.length > 0 ? getCartCostSummary(items, shopperPricing.quote) : null
  const pricingIntent =
    items.length > 0
      ? buildCheckoutPricingIntent(items, shopperPricing.quote)
      : null
  const isAllDigital = Boolean(
    items.length && items.every((item) => item.format === "digital")
  )
  const shippingPreset = readCheckoutShippingSession()
  const shippingAddress = buildShippingAddressFromForm(shippingPreset)
  const shippingPresetReady =
    isAllDigital ||
    (validateShippingFields(shippingPreset).length === 0 &&
      validateAddressConsistency(shippingAddress).canDirectPay)
  const shippingDestinationReady = Boolean(
    isAllDigital ||
    (items.length > 0 &&
      !hasPhysicalItemsMissingShippingZone(items) &&
      getCartShippingDestinationEligibility(
        {
          country: shippingAddress.country,
          postalCode: shippingAddress.postalCode,
        },
        Array.from(items),
        []
      ).eligible === true)
  )
  const listingTermsCurrent = Boolean(
    items.length > 0 &&
    input.readiness &&
    cartItemsMatchCurrentProducts(items, input.readiness.products)
  )
  const automaticWalletReady =
    webLnAvailable ||
    (wallet.status === "pay-capable" && Boolean(wallet.connection))

  const capability = deriveMerchantCheckoutCapability({
    readiness: enabled
      ? (input.readiness?.state ?? "not_started")
      : "not_started",
    blockingMessage: input.readiness?.blockingMessage ?? null,
    listingTermsCurrent,
    shopperPresetReady: shippingPresetReady,
    walletReady:
      authStatus === "connected" && Boolean(pubkey) && automaticWalletReady,
    itemPricesAvailable:
      summary?.itemPricesAvailable === true && pricingIntent?.status === "ok",
    shippingReady:
      shippingPresetReady &&
      shippingDestinationReady &&
      summary?.shippingReadyForZap === true,
    lnurl: lnurlPreflight,
    totalMsats:
      pricingIntent?.status === "ok" ? pricingIntent.totalMsats : null,
  })

  return {
    capability,
    fallbackMessage: getMerchantCapabilityFallbackMessage(capability),
    pricingIntent,
    lnurl: lnurlPreflight,
  }
}
