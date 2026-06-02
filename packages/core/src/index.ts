// Types
export * from "./types"

// Protocol
export * from "./protocol"
export * from "./protocol/countries"

// Schemas
export * from "./schemas"

// Utils
export * from "./utils"

// Analytics
export {
  canCaptureAnonymousTelemetry,
  sanitizeAnalyticsPath,
  useAnonymousPageviewTelemetry,
  type AnonymousPageviewInput,
  type ConduitAnalyticsApp,
} from "./analytics"

// Pricing
export {
  MSATS_PER_SAT,
  SATS_PER_BTC,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  canonicalizeProductPrice,
  compareCommercePrices,
  formatApproxUsdFromSats,
  formatFiatPrice,
  getPriceSats,
  isBtcLikeCurrency,
  isMsatsLikeCurrency,
  isSatsLikeCurrency,
  isUsdCurrencyCode,
  normalizeCommercePrice,
  normalizeCurrencyCode,
} from "./pricing"
export {
  BTC_USD_RATE_QUERY_KEY,
  BTC_USD_RATE_REFRESH_INTERVAL_MS,
  BTC_USD_RATE_STALE_MS,
  fetchBtcUsdRate,
  getConfiguredBtcUsdRate,
  getConfiguredPricingRateQuote,
  isBtcUsdRateQuoteFresh,
  useBtcUsdRate,
} from "./pricing/rates"
export type {
  BtcUsdRateQuote,
  CommercePriceSortDirection,
  CommercePriceLike,
  CommercePriceNormalization,
  PricingRateInput,
  SourcePriceQuote,
  SupportedProductPriceCurrency,
} from "./pricing"

// Config
export {
  CANONICAL_APP_WRITE_RELAYS,
  CANONICAL_DEFAULT_RELAYS,
  config,
  isRetiredDefaultRelayUrl,
  isMockPayments,
  isSignet,
  isTestnet,
  isMainnet,
  type ConduitConfig,
} from "./config"

// Database
export {
  db,
  pruneCommerceCaches,
  type StoredOrder,
  type StoredMessage,
  type CachedProduct,
  type CachedProfile,
  type CachedOrderMessage,
  type StoredPaymentAttempt,
} from "./db"

// Billing
export {
  getEntitlements,
  type Entitlements,
  type BillingTier,
} from "./billing/entitlements"

// Context
export {
  AuthProvider,
  useAuth,
  hasNip07,
  type AuthStatus,
  type AuthContextValue,
} from "./context/AuthContext"
export {
  ConduitSessionProvider,
  useConduitSession,
  type ConduitSessionContextValue,
  type ConduitSessionProviderProps,
} from "./context/ConduitSessionContext"

// Hooks
export { useNdkState } from "./hooks/useNdkState"
export { useNip07Availability } from "./hooks/useNip07Availability"
export {
  useProfile,
  type UseProfileOptions,
  type UseProfileResult,
} from "./hooks/useProfile"
export {
  useProfiles,
  type UseProfilesOptions,
  type UseProfilesResult,
} from "./hooks/useProfiles"
export {
  useRelaySettings,
  type UseRelaySettingsResult,
} from "./hooks/useRelaySettings"
export { useUpdateProfile } from "./hooks/useUpdateProfile"
