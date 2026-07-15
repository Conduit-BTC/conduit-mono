// Types
export * from "./types"

// Protocol
export * from "./protocol"
export * from "./protocol/countries"

// Schemas
export * from "./schemas"

// Utils
export * from "./utils"

// Build provenance
export {
  conduitBuildInfo,
  getCommitUrl,
  normalizeRepositoryUrl,
  type ConduitBuildInfo,
} from "./build-info"
export {
  browserTelemetryEventNames,
  browserTelemetryPropertyNames,
  applyPlausibleInitOptions,
  buildTelemetryEventPageContext,
  buildTelemetryPageUrl,
  getTelemetryAmountBucket,
  getTelemetryCountBucket,
  getConduitPostHogConfig,
  isBrowserTelemetryEventName,
  recordBrowserTelemetryEvent,
  recordBrowserTelemetryPageView,
  resolveBrowserTelemetryConfig,
  sanitizePostHogCaptureEvent,
  sanitizeTelemetryEventProperties,
  sanitizeTelemetryPath,
  sensitiveTelemetryPropertyNames,
  type BrowserTelemetryEventName,
  type BrowserTelemetryEventProperties,
  type BrowserTelemetryPropertyName,
  type BrowserTelemetryConfig,
  type BrowserTelemetryEnv,
  type ConduitPostHogConfig,
  type ConduitTelemetryApp,
  type PlausibleTelemetryConfig,
  type PlausibleFunction,
  type PlausibleInitOptions,
  type PostHogTelemetryConfig,
  type TelemetryEventInput,
  type TelemetryPageViewInput,
} from "./telemetry"
export {
  buildBugReportUrl,
  getBugReportAppLabel,
  type BugReportAppId,
  type BugReportUrlInput,
} from "./bug-report"

// Pricing
export {
  MSATS_PER_SAT,
  SATS_PER_BTC,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  canonicalizeProductPrice,
  canonicalizeShippingCost,
  compareCommercePrices,
  formatApproxUsdFromSats,
  formatFiatPrice,
  getCurrencyAmountStep,
  getCurrencyFractionDigits,
  getPriceSats,
  getShippingCostSats,
  isBtcLikeCurrency,
  isFiatCurrencyCode,
  isMsatsLikeCurrency,
  isSatsLikeCurrency,
  isUsdCurrencyCode,
  normalizeCommercePrice,
  normalizeCurrencyAmount,
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
export { fetchTrustedPricingRateQuote } from "./pricing/trusted-rate-provider"
export type { TrustedPricingRateOptions } from "./pricing/trusted-rate-provider"
export type {
  BtcUsdRateQuote,
  CommerceShippingCostLike,
  CommercePriceSortDirection,
  CommercePriceLike,
  CommercePriceNormalization,
  CurrencyAmountNormalization,
  PricingRateInput,
  SourcePriceQuote,
  SupportedProductPriceCurrency,
} from "./pricing"

// Config
export {
  CANONICAL_APP_BACKPLANE_RELAYS,
  CANONICAL_APP_WRITE_RELAYS,
  CANONICAL_COMMERCE_DM_FALLBACK_RELAYS,
  CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS,
  CANONICAL_DEFAULT_RELAYS,
  CANONICAL_DM_INBOX_DEFAULT_RELAYS,
  CANONICAL_SEARCH_INDEX_RELAYS,
  CANONICAL_ZAP_PUBLIC_RELAYS,
  config,
  getRelayBucketConfigs,
  isRetiredDefaultRelayUrl,
  isMockPayments,
  isSignet,
  isTestnet,
  isMainnet,
  type ConduitConfig,
  type RelayBucketConfig,
  type RelayBucketId,
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
  type CachedNip05Verification,
  type StoredPaymentAttempt,
  type OrderLifecycle,
  type OrderLifecycleItem,
  type OrderLifecyclePhase,
  type OrderCheckoutMode,
  type OrderPublicZapSigner,
  type OrderBuyerIdentityKind,
  type OrderGuestContact,
  type OrderAddressValidity,
  type OrderShippingZoneEligibility,
  type OrderDeliveryStatus,
  type OrderInvoiceStatus,
  type OrderPaymentStatus,
  type OrderProofDeliveryStatus,
  type OrderZapReceiptStatus,
} from "./db"

// Context
export {
  AuthProvider,
  useAuth,
  hasNip07,
  isTransientNip07ConnectError,
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
  useNip05Verification,
  type Nip05TrustStatus,
  type UseNip05VerificationResult,
} from "./hooks/useNip05Verification"
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
