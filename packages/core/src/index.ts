// Types
export * from "./types"

// Protocol
export * from "./protocol"

// Schemas
export * from "./schemas"

// Utils
export * from "./utils"

// Pricing
export {
  MSATS_PER_SAT,
  SATS_PER_BTC,
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
  fetchBtcUsdRate,
  getConfiguredBtcUsdRate,
  getConfiguredPricingRateQuote,
  useBtcUsdRate,
} from "./pricing/rates"
export type {
  BtcUsdRateQuote,
  CommercePriceSortDirection,
  CommercePriceLike,
  CommercePriceNormalization,
  PricingRateInput,
  SourcePriceQuote,
} from "./pricing"

// Config
export {
  config,
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
