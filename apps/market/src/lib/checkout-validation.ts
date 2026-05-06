import type { ShippingAddressSchema } from "@conduit/core"

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

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateShippingFields(
  shipping: ShippingFormState
): ShippingValidationError[] {
  const errors: ShippingValidationError[] = []

  const country = shipping.country.trim().toUpperCase()
  if (!ISO_COUNTRY_RE.test(country)) {
    errors.push({
      field: "country",
      message: "Enter a 2-letter country code (e.g. US)",
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

// ─── Fast checkout eligibility ────────────────────────────────────────────────

export function isFastCheckoutEligible(params: {
  walletPayCapable: boolean
  merchantLud16: string | undefined | null
  lnurlAllowsNostr: boolean
}): boolean {
  return (
    params.walletPayCapable && !!params.merchantLud16 && params.lnurlAllowsNostr
  )
}
