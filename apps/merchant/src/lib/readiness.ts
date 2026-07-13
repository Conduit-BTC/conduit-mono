/**
 * Merchant readiness utilities.
 *
 * Defines what "complete" means for each setup area and provides
 * helpers to compute readiness state from profile / localStorage data.
 */
import {
  CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
  SHIPPING_COUNTRIES,
  isRelaySetupIncomplete,
  isValidLud16Address,
  getNwcUriFingerprint,
  parseNwcUri,
  type ParsedShippingOption,
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
  "not_ready" | "invoice_only" | "direct_payment"

export interface MerchantSetupReadiness {
  profileComplete: boolean
  profileCheckPending: boolean
  paymentsComplete: boolean
  paymentsCheckPending: boolean
  shippingComplete: boolean
  shippingCheckPending: boolean
  networkComplete: boolean
  setupComplete: boolean
  setupCheckPending: boolean
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
  return profile.lud16 ? isValidLud16Address(profile.lud16) : false
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
  return !!parseStoredNwcConnection(raw)
}

export function getNwcUriStorageKey(
  pubkey: string | null | undefined
): string | null {
  const normalizedPubkey = pubkey?.trim()
  if (!normalizedPubkey) return null
  return `${NWC_URI_STORAGE_KEY}:${normalizedPubkey}`
}

export function getNwcConnectionCacheKey(rawUri: string): string {
  const normalizedUri = rawUri.trim()
  return normalizedUri ? getNwcUriFingerprint(normalizedUri) : "none"
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
  hasNwc = false,
  profileCheckPending = false,
  paymentsCheckPending = false,
  shippingCheckPending = false,
}: {
  profile: Profile | null | undefined
  shippingConfig: ShippingConfig
  relaySettings: RelaySettingsState
  hasNwc?: boolean
  profileCheckPending?: boolean
  paymentsCheckPending?: boolean
  shippingCheckPending?: boolean
}): MerchantSetupReadiness {
  const profileComplete = isProfileComplete(profile)
  const paymentsComplete = isPaymentsComplete(profile)
  const shippingComplete = isShippingComplete(shippingConfig)
  const networkComplete = isNetworkComplete(relaySettings)
  const setupComplete =
    profileComplete && paymentsComplete && shippingComplete && networkComplete
  const operationalReady =
    profileComplete && shippingComplete && networkComplete
  const setupCheckPending =
    profileCheckPending || paymentsCheckPending || shippingCheckPending
  const missingAreas: MerchantSetupReadiness["missingAreas"] = []

  if (!profileComplete && !profileCheckPending) missingAreas.push("profile")
  if (!paymentsComplete && !paymentsCheckPending) missingAreas.push("payments")
  if (!shippingComplete && !shippingCheckPending) missingAreas.push("shipping")
  if (!networkComplete) missingAreas.push("network")

  const paymentCapability: MerchantPaymentCapability = !operationalReady
    ? "not_ready"
    : paymentsComplete
      ? "direct_payment"
      : "invoice_only"

  return {
    profileComplete,
    profileCheckPending,
    paymentsComplete,
    paymentsCheckPending,
    shippingComplete,
    shippingCheckPending,
    networkComplete,
    setupComplete,
    setupCheckPending,
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

export function getShippingStorageKey(
  pubkey: string | null | undefined
): string {
  const normalizedPubkey = pubkey?.trim()
  return normalizedPubkey
    ? `${SHIPPING_STORAGE_KEY}:${normalizedPubkey}`
    : SHIPPING_STORAGE_KEY
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  )
}

function normalizeShippingConfig(value: unknown): ShippingConfig {
  if (!value || typeof value !== "object") return { countries: [] }
  const maybeConfig = value as { countries?: unknown }
  if (!Array.isArray(maybeConfig.countries)) return { countries: [] }

  return {
    countries: maybeConfig.countries.flatMap(
      (item): ShippingCountryConfig[] => {
        if (!item || typeof item !== "object") return []
        const maybeCountry = item as {
          code?: unknown
          name?: unknown
          restrictTo?: unknown
          exclude?: unknown
        }
        if (typeof maybeCountry.code !== "string") return []
        const code = maybeCountry.code.trim().toUpperCase()
        if (!code) return []
        const country = SHIPPING_COUNTRIES.find((entry) => entry.code === code)
        return [
          {
            code,
            name:
              typeof maybeCountry.name === "string" && maybeCountry.name.trim()
                ? maybeCountry.name.trim()
                : (country?.name ?? code),
            restrictTo: toStringArray(maybeCountry.restrictTo),
            exclude: toStringArray(maybeCountry.exclude),
          },
        ]
      }
    ),
  }
}

export function loadShippingConfig(
  pubkey?: string | null | undefined
): ShippingConfig {
  return parseShippingConfig(getStoredShippingConfigRaw(pubkey))
}

export function getStoredShippingConfigRaw(
  pubkey?: string | null | undefined
): string | null {
  try {
    if (typeof localStorage === "undefined") return null
    return localStorage.getItem(getShippingStorageKey(pubkey))
  } catch {
    return null
  }
}

export function parseShippingConfig(
  raw: string | null | undefined
): ShippingConfig {
  if (!raw) return { countries: [] }

  try {
    return normalizeShippingConfig(JSON.parse(raw) as unknown)
  } catch {
    return { countries: [] }
  }
}

export function saveShippingConfig(
  config: ShippingConfig,
  pubkey?: string | null | undefined
): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(
    getShippingStorageKey(pubkey),
    serializeShippingConfig(config)
  )
  notifyMerchantReadinessStorageChange()
}

export function isShippingComplete(config: ShippingConfig): boolean {
  return config.countries.length > 0
}

export function shippingOptionToConfig(
  option: ParsedShippingOption
): ShippingConfig {
  return {
    countries: option.countryRules.map((rule) => {
      const country = SHIPPING_COUNTRIES.find(
        (item) => item.code === rule.code.toUpperCase()
      )
      return {
        code: rule.code.toUpperCase(),
        name: country?.name ?? rule.name,
        restrictTo: rule.restrictTo,
        exclude: rule.exclude,
      }
    }),
  }
}

export function selectConduitShippingOption(
  options: readonly ParsedShippingOption[] | null | undefined
): ParsedShippingOption | null {
  if (!options || options.length === 0) return null
  return (
    options.find(
      (option) => option.dTag === CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG
    ) ??
    options[0] ??
    null
  )
}

export function serializeShippingConfig(config: ShippingConfig): string {
  return JSON.stringify(normalizeShippingConfig(config))
}

export function isStoredShippingConfigAuthoritative(
  rawStoredConfig: string | null
): boolean {
  if (rawStoredConfig === null) return false

  try {
    const parsed = JSON.parse(rawStoredConfig) as { countries?: unknown }
    if (!Array.isArray(parsed?.countries)) return false
    if (parsed.countries.length === 0) return true

    return normalizeShippingConfig(parsed).countries.length > 0
  } catch {
    return false
  }
}

export function shouldHydrateShippingConfig(
  rawStoredConfig: string | null,
  remoteConfig: ShippingConfig | null
): remoteConfig is ShippingConfig {
  return (
    !isStoredShippingConfigAuthoritative(rawStoredConfig) &&
    remoteConfig !== null
  )
}
