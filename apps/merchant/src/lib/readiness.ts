/**
 * Merchant readiness utilities.
 *
 * Defines what "complete" means for each setup area and provides
 * helpers to compute readiness state from profile / localStorage data.
 */
import {
  isRelaySetupIncomplete,
  parseNwcUri,
  type NwcConnection,
  type Profile,
  type RelaySettingsState,
} from "@conduit/core"

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * A merchant profile is considered complete when it has at minimum:
 * - a display name or name
 * - an about / bio
 * - a profile picture URL
 */
export function isProfileComplete(
  profile: Profile | null | undefined
): boolean {
  if (!profile) return false
  const hasName = !!(profile.displayName?.trim() || profile.name?.trim())
  const hasAbout = !!profile.about?.trim()
  const hasPicture = !!profile.picture?.trim()
  return hasName && hasAbout && hasPicture
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const NWC_URI_STORAGE_KEY = "conduit:merchant:nwc_uri"
export const MERCHANT_READINESS_STORAGE_EVENT =
  "conduit:merchant-readiness-storage"

export type StoredNwcConnection = NwcConnection & {
  uri: string
}

export type MerchantPaymentCapability =
  | "not_ready"
  | "invoice_only"
  | "direct_payment"

export interface MerchantSetupReadiness {
  profileComplete: boolean
  paymentsComplete: boolean
  shippingComplete: boolean
  networkComplete: boolean
  setupComplete: boolean
  operationalReady: boolean
  paymentCapability: MerchantPaymentCapability
  hasNwc: boolean
  missingAreas: Array<"profile" | "payments" | "shipping" | "network">
}

/**
 * Payments are considered complete when the merchant has a public Lightning
 * Address set in their Nostr profile. NWC is private invoice automation and
 * does not make a merchant publicly direct-payment eligible by itself.
 */
export function isPaymentsComplete(
  profile: Profile | null | undefined
): boolean {
  if (!profile) return false
  return !!profile.lud16?.trim()
}

export function parseStoredNwcConnection(
  raw: string | null | undefined
): StoredNwcConnection | null {
  if (!raw?.trim()) return null

  try {
    const uri = raw.trim()
    return {
      ...parseNwcUri(uri),
      uri,
    }
  } catch {
    return null
  }
}

export function hasNwcConfigured(raw?: string | null): boolean {
  if (raw !== undefined) return !!parseStoredNwcConnection(raw)

  try {
    return !!parseStoredNwcConnection(localStorage.getItem(NWC_URI_STORAGE_KEY))
  } catch {
    return false
  }
}

export function notifyMerchantReadinessStorageChange(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(MERCHANT_READINESS_STORAGE_EVENT))
}

export function isNetworkComplete(settings: RelaySettingsState): boolean {
  return !isRelaySetupIncomplete(settings)
}

export function getMerchantSetupReadiness({
  profile,
  shippingConfig,
  relaySettings,
  hasNwc = hasNwcConfigured(),
}: {
  profile: Profile | null | undefined
  shippingConfig: ShippingConfig
  relaySettings: RelaySettingsState
  hasNwc?: boolean
}): MerchantSetupReadiness {
  const profileComplete = isProfileComplete(profile)
  const paymentsComplete = isPaymentsComplete(profile)
  const shippingComplete = isShippingComplete(shippingConfig)
  const networkComplete = isNetworkComplete(relaySettings)
  const setupComplete =
    profileComplete && paymentsComplete && shippingComplete && networkComplete
  const operationalReady =
    profileComplete && shippingComplete && networkComplete
  const missingAreas: MerchantSetupReadiness["missingAreas"] = []

  if (!profileComplete) missingAreas.push("profile")
  if (!paymentsComplete) missingAreas.push("payments")
  if (!shippingComplete) missingAreas.push("shipping")
  if (!networkComplete) missingAreas.push("network")

  const paymentCapability: MerchantPaymentCapability = !operationalReady
    ? "not_ready"
    : paymentsComplete
      ? "direct_payment"
      : "invoice_only"

  return {
    profileComplete,
    paymentsComplete,
    shippingComplete,
    networkComplete,
    setupComplete,
    operationalReady,
    paymentCapability,
    hasNwc,
    missingAreas,
  }
}

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

export const SHIPPING_STORAGE_KEY = "conduit:merchant:shipping_config"

export interface ShippingCountryConfig {
  /** ISO-3166-1 alpha-2 country code */
  code: string
  /** Human-readable country name */
  name: string
  /** Postal code / prefix patterns that are allowed (empty = all) */
  restrictTo: string[]
  /** Postal code / prefix patterns that are excluded */
  exclude: string[]
}

export interface ShippingConfig {
  countries: ShippingCountryConfig[]
}

export function loadShippingConfig(): ShippingConfig {
  try {
    if (typeof localStorage === "undefined") return { countries: [] }
    const raw = localStorage.getItem(SHIPPING_STORAGE_KEY)
    return parseShippingConfig(raw)
  } catch {
    return { countries: [] }
  }
}

export function parseShippingConfig(
  raw: string | null | undefined
): ShippingConfig {
  if (!raw) return { countries: [] }

  try {
    return JSON.parse(raw) as ShippingConfig
  } catch {
    return { countries: [] }
  }
}

export function saveShippingConfig(config: ShippingConfig): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(SHIPPING_STORAGE_KEY, JSON.stringify(config))
  notifyMerchantReadinessStorageChange()
}

export function isShippingComplete(config: ShippingConfig): boolean {
  return config.countries.length > 0
}
