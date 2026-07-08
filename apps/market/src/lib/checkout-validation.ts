import {
  SHIPPING_COUNTRIES,
  getAddressRegionRequirement,
  sanitizePhoneInput,
  validateAddressConsistency,
  type AddressRegionRequirement,
  type AddressValidationIssue,
  type ShippingAddressSchema,
} from "@conduit/core"

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
  | "state"
  | "email"
  | "phone"

export type ShippingValidationError = {
  field: ShippingFieldKey
  message: string
}

// ─── Regexes ──────────────────────────────────────────────────────────────────

/** ISO 3166-1 alpha-2: exactly 2 uppercase ASCII letters. */
export const ISO_COUNTRY_RE = /^[A-Z]{2}$/

const SHIPPING_COUNTRY_CODES = new Set(
  SHIPPING_COUNTRIES.map((country) => country.code)
)

export const sanitizeShippingPhoneInput = sanitizePhoneInput

export const SHIPPING_PHONE_HELP_ID = "ship-phone-help"
export const SHIPPING_PHONE_ERROR_ID = "ship-phone-error"
export const SHIPPING_PHONE_HELP_COPY =
  "Use + country code if this number is outside the delivery country."

export function getShippingPhoneDescribedBy(hasError: boolean): string {
  return hasError
    ? `${SHIPPING_PHONE_HELP_ID} ${SHIPPING_PHONE_ERROR_ID}`
    : SHIPPING_PHONE_HELP_ID
}

export function getShippingRegionRequirement(
  country: string
): AddressRegionRequirement {
  return getAddressRegionRequirement(country)
}

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

  const addressResult = validateAddressConsistency({
    name: `${firstName} ${lastName}`.trim(),
    street: shipping.street,
    city: shipping.city,
    state: shipping.state,
    postalCode: shipping.postalCode,
    country,
    email: shipping.email,
    phone: shipping.phone,
  })

  const hasNameError =
    errors.some((e) => e.field === "firstName") ||
    errors.some((e) => e.field === "lastName")

  for (const issue of addressResult.issues) {
    const error = shippingErrorFromAddressIssue(issue, hasNameError)
    if (error && !errors.some((item) => item.field === error.field)) {
      errors.push(error)
    }
  }

  return errors
}

function validateContactFields(
  shipping: ShippingFormState
): ShippingValidationError[] {
  const errors: ShippingValidationError[] = []
  const country = shipping.country.trim().toUpperCase()
  const addressResult = validateAddressConsistency({
    name: `${shipping.firstName.trim()} ${shipping.lastName.trim()}`.trim(),
    street: shipping.street,
    city: shipping.city,
    state: shipping.state,
    postalCode: shipping.postalCode,
    country,
    email: shipping.email,
    phone: shipping.phone,
  })

  for (const issue of addressResult.issues) {
    if (issue.field !== "email" && issue.field !== "phone") continue
    const error = shippingErrorFromAddressIssue(issue, false)
    if (error && !errors.some((item) => item.field === error.field)) {
      errors.push(error)
    }
  }

  return errors
}

function appendRequiredGuestContactErrors(
  errors: ShippingValidationError[],
  shipping: ShippingFormState
): ShippingValidationError[] {
  const next = [...errors]
  if (
    shipping.phone.trim().length === 0 &&
    !next.some((error) => error.field === "phone")
  ) {
    next.push({
      field: "phone",
      message: "Phone is required for guest checkout",
    })
  }
  if (
    shipping.email.trim().length === 0 &&
    !next.some((error) => error.field === "email")
  ) {
    next.push({
      field: "email",
      message: "Email is required for guest checkout",
    })
  }
  return next
}

export function validateGuestContactFields(
  shipping: ShippingFormState
): ShippingValidationError[] {
  return appendRequiredGuestContactErrors(
    validateContactFields(shipping),
    shipping
  )
}

export function validateGuestShippingFields(
  shipping: ShippingFormState
): ShippingValidationError[] {
  return appendRequiredGuestContactErrors(
    validateShippingFields(shipping),
    shipping
  )
}

function shippingErrorFromAddressIssue(
  issue: AddressValidationIssue,
  hasNameError: boolean
): ShippingValidationError | null {
  switch (issue.field) {
    case "name":
      return hasNameError
        ? null
        : { field: "firstName", message: issue.message }
    case "street":
      return { field: "street", message: issue.message }
    case "city":
      return { field: "city", message: issue.message }
    case "state":
      return { field: "state", message: issue.message }
    case "postalCode":
      return { field: "postalCode", message: issue.message }
    case "country":
      return { field: "country", message: issue.message }
    case "email":
      return { field: "email", message: issue.message }
    case "phone":
      return { field: "phone", message: issue.message }
  }
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
      return "Postal/ZIP code"
    case "city":
      return "City"
    case "state":
      return "State / Province / Region"
    case "email":
      return "Email"
    case "phone":
      return "Phone"
  }
}

export function getShippingStepBlockingMessage(params: {
  hasUnpricedCheckoutItems: boolean
  shippingErrors: ShippingValidationError[]
}): string | null {
  if (params.hasUnpricedCheckoutItems) {
    return "One or more items cannot be converted to sats right now. Refresh prices before ordering."
  }
  if (params.shippingErrors.length > 0) {
    return "Fix the highlighted fields to continue."
  }

  // Shipping-zone readiness gates zap-out, not order-first Send Order.
  return null
}

// ─── Fast checkout eligibility ────────────────────────────────────────────────

export function isFastCheckoutEligible(params: {
  walletPayCapable: boolean
  merchantLud16: string | undefined | null
  lnurlAllowsNostr: boolean
  allowsManualFallback?: boolean
  requiresNostrZap?: boolean
  pricingReady?: boolean
  shippingEligible?: boolean
  shippingState?: ShippingCheckoutState
  shippingPriced?: boolean
  relayReady?: boolean
  addressValidForDirectPayment?: boolean
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
  allowsManualFallback?: boolean
  requiresNostrZap?: boolean
  pricingReady?: boolean
  shippingEligible?: boolean
  shippingState?: ShippingCheckoutState
  shippingPriced?: boolean
  relayReady?: boolean
  addressValidForDirectPayment?: boolean
}): string[] {
  const reasons: string[] = []
  const canStartLightningFlow =
    params.walletPayCapable || params.allowsManualFallback === true

  if (!canStartLightningFlow) {
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
  if (params.addressValidForDirectPayment === false) {
    reasons.push(
      "Enter a locally consistent delivery address before direct payment."
    )
  }
  if (params.relayReady === false) {
    reasons.push(
      "Order flow needs reliable order delivery before direct payment."
    )
  }
  return reasons
}
