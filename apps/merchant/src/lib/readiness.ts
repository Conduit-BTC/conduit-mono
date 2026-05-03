/**
 * Merchant readiness utilities.
 *
 * Defines what "complete" means for each setup area and provides
 * helpers to compute readiness state from profile / localStorage data.
 */
import type { Profile } from "@conduit/core"

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

const STORAGE_KEY_NWC = "conduit:merchant:nwc_uri"

/**
 * Payments are considered complete when the merchant has a Lightning Address
 * set in their Nostr profile.  NWC is optional but enables fast checkout.
 */
export function isPaymentsComplete(
  profile: Profile | null | undefined
): boolean {
  if (!profile) return false
  return !!profile.lud16?.trim()
}

export function hasNwcConfigured(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_NWC)
    return !!raw && raw.startsWith("nostr+walletconnect://")
  } catch {
    return false
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
    const raw = localStorage.getItem(SHIPPING_STORAGE_KEY)
    if (!raw) return { countries: [] }
    return JSON.parse(raw) as ShippingConfig
  } catch {
    return { countries: [] }
  }
}

export function saveShippingConfig(config: ShippingConfig): void {
  localStorage.setItem(SHIPPING_STORAGE_KEY, JSON.stringify(config))
}

export function isShippingComplete(config: ShippingConfig): boolean {
  return config.countries.length > 0
}
