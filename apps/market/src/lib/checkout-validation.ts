import { SHIPPING_COUNTRIES, type ShippingAddressSchema } from "@conduit/core"

// ─── Types ────────────────────────────────────────────────────────────────────

export type ShippingFormState = ShippingAddressSchema & {
  firstName: string
  lastName: string
  line2: string
  phone: string
  email: string
}

export type ShippingFieldKey =
  | "country"
  | "firstName"
  | "lastName"
  | "street"
  | "postalCode"
  | "city"
  | "email"
  | "phone"

export type ShippingValidationError = {
  field: ShippingFieldKey
  message: string
}

// ─── Regexes ──────────────────────────────────────────────────────────────────

/** ISO 3166-1 alpha-2: exactly 2 uppercase ASCII letters. */
export const ISO_COUNTRY_RE = /^[A-Z]{2}$/

/** Minimal e-mail shape check. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Accept blank phone, or a string with 7-20 digit/space/+/- chars. */
export const PHONE_RE = /^[\d\s\-+().]{7,20}$/

const SHIPPING_COUNTRY_CODES = new Set(
  SHIPPING_COUNTRIES.map((country) => country.code)
)

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateShippingFields(
  shipping: ShippingFormState
): ShippingValidationError[] {
  const errors: ShippingValidationError[] = []

  const country = shipping.country.trim().toUpperCase()
  if (!ISO_COUNTRY_RE.test(country) || !SHIPPING_COUNTRY_CODES.has(country)) {
    errors.push({
      field: "country",
      message: "Select a supported country",
    })
  }

  const firstName = shipping.firstName.trim()
  if (firstName.length === 0) {
    errors.push({ field: "firstName", message: "First name is required" })
  } else if (firstName.length > 50) {
    errors.push({
      field: "firstName",
      message: "First name must be 50 characters or fewer",
    })
  }

  const lastName = shipping.lastName.trim()
  if (lastName.length === 0) {
    errors.push({ field: "lastName", message: "Last name is required" })
  } else if (lastName.length > 50) {
    errors.push({
      field: "lastName",
      message: "Last name must be 50 characters or fewer",
    })
  }

  if (shipping.street.trim().length === 0) {
    errors.push({ field: "street", message: "Street address is required" })
  }

  if (shipping.postalCode.trim().length === 0) {
    errors.push({ field: "postalCode", message: "Postal code is required" })
  }

  if (shipping.city.trim().length === 0) {
    errors.push({ field: "city", message: "City is required" })
  }

  const email = shipping.email.trim()
  if (email.length > 0 && !EMAIL_RE.test(email)) {
    errors.push({ field: "email", message: "Enter a valid email address" })
  }

  const phone = shipping.phone.trim()
  if (phone.length > 0 && !PHONE_RE.test(phone)) {
    errors.push({ field: "phone", message: "Enter a valid phone number" })
  }

  return errors
}

export function getValidationErrorFields(
  errors: ShippingValidationError[]
): ShippingFieldKey[] {
  return errors.map((e) => e.field)
}

export function shippingFieldLabel(field: ShippingFieldKey): string {
  switch (field) {
    case "country":
      return "Country"
    case "firstName":
      return "First name"
    case "lastName":
      return "Last name"
    case "street":
      return "Street address"
    case "postalCode":
      return "Postal code"
    case "city":
      return "City"
    case "email":
      return "Email"
    case "phone":
      return "Phone"
  }
}

export function getShippingStepBlockingMessage(params: {
  hasUnpricedCheckoutItems: boolean
  shippingErrors: ShippingValidationError[]
  shippingState: ShippingCheckoutState
}): string | null {
  if (params.hasUnpricedCheckoutItems) {
    return "One or more items cannot be converted to sats right now. Refresh prices before ordering."
  }
  if (params.shippingErrors.length > 0) {
    return "Fix the highlighted fields to continue."
  }

  switch (params.shippingState) {
    case "not_required":
    case "loading":
    case "missing_product_zone":
    case "no_published_rule":
    case "allowed":
    case "country_unsupported":
    case "postal_restricted":
      return null
  }
}

// ─── Fast checkout eligibility ────────────────────────────────────────────────

export function isFastCheckoutEligible(params: {
  walletPayCapable: boolean
  merchantLud16: string | undefined | null
  lnurlAllowsNostr: boolean
  requiresNostrZap?: boolean
  pricingReady?: boolean
  shippingEligible?: boolean
  shippingState?: ShippingCheckoutState
  shippingPriced?: boolean
  relayReady?: boolean
}): boolean {
  return getFastCheckoutUnavailableReasons(params).length === 0
}

export type ShippingCheckoutState =
  | "not_required"
  | "loading"
  | "missing_product_zone"
  | "no_published_rule"
  | "allowed"
  | "country_unsupported"
  | "postal_restricted"

export function getShippingCheckoutState(params: {
  isAllDigital: boolean
  shippingLookupPending: boolean
  physicalItemsMissingShippingZone: boolean
  shippingOptionsAvailable: boolean
  destinationEligibility:
    | { eligible: true }
    | { eligible: false; reason: "country_unsupported" | "postal_restricted" }
    | { eligible: null; reason: "unknown" }
}): ShippingCheckoutState {
  if (params.isAllDigital) return "not_required"
  if (params.physicalItemsMissingShippingZone) return "missing_product_zone"

  if (params.shippingOptionsAvailable) {
    if (params.destinationEligibility.eligible === true) return "allowed"
    if (params.destinationEligibility.reason === "country_unsupported") {
      return "country_unsupported"
    }
    if (params.destinationEligibility.reason === "postal_restricted") {
      return "postal_restricted"
    }
  }

  if (params.shippingLookupPending) return "loading"
  return "no_published_rule"
}

export function getFastCheckoutUnavailableReasons(params: {
  walletPayCapable: boolean
  merchantLud16: string | undefined | null
  lnurlAllowsNostr: boolean
  requiresNostrZap?: boolean
  pricingReady?: boolean
  shippingEligible?: boolean
  shippingState?: ShippingCheckoutState
  shippingPriced?: boolean
  relayReady?: boolean
}): string[] {
  const reasons: string[] = []
  if (!params.walletPayCapable) {
    reasons.push(
      "Connect a Lightning wallet or enable browser Lightning payments."
    )
  }
  if (!params.merchantLud16) {
    reasons.push("Merchant has not added a Lightning Address.")
  }
  if (params.merchantLud16 && !params.lnurlAllowsNostr) {
    if (params.requiresNostrZap ?? true) {
      reasons.push(
        "Merchant Lightning Address does not advertise Nostr zap support."
      )
    } else {
      reasons.push("Merchant Lightning Address could not be checked.")
    }
  }
  if (params.pricingReady === false) {
    reasons.push("Refresh price conversion before paying.")
  }
  if (params.shippingState && params.shippingState !== "allowed") {
    switch (params.shippingState) {
      case "not_required":
        break
      case "loading":
        reasons.push("Checking merchant shipping rules.")
        break
      case "missing_product_zone":
        reasons.push(
          "A product in this cart is missing product-level shipping-zone data."
        )
        break
      case "no_published_rule":
        reasons.push("Merchant has not published shipping rules yet.")
        break
      case "country_unsupported":
        reasons.push("Merchant shipping zone does not include this country.")
        break
      case "postal_restricted":
        reasons.push(
          "Merchant shipping zone does not include this postal code."
        )
        break
    }
  } else if (params.shippingEligible === false) {
    reasons.push("Merchant shipping zone does not include this destination.")
  }
  if (params.shippingPriced === false) {
    reasons.push(
      "Shipping cost is coordinated with the merchant, so direct payment is disabled."
    )
  }
  if (params.relayReady === false) {
    reasons.push(
      "Order flow needs reliable order delivery before direct payment."
    )
  }
  return reasons
}
