// Types
export * from "./types"

// Protocol
export * from "./protocol"
export * from "./protocol/countries"

// Schemas
export * from "./schemas"

// Utils
export * from "./utils"
export * from "./network-target-safety"
export * from "./app-links"
export * from "./checkout-intent"
export * from "./checkout-partner-registry"
export * from "./checkout-source-domain"
export * from "./checkout-attribution"

// Wallets
export * from "./wallets"

// Build provenance
export {
  conduitBuildInfo,
  getCommitUrl,
  normalizeRepositoryUrl,
  type ConduitBuildInfo,
} from "./build-info"

export { getClientErrorMessage } from "./client-error"

export {
  buildBugReportUrl,
  getBugReportAppLabel,
  type BugReportAppId,
  type BugReportUrlInput,
} from "./bug-report"

// Pricing
export {
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  DEFAULT_SHOPPER_PRICE_PREFERENCE,
  MSATS_PER_SAT,
  SATS_PER_BTC,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  SUPPORTED_SHOPPER_DISPLAY_CURRENCIES,
  canonicalizeProductPrice,
  canonicalizeShippingCost,
  compareCommercePrices,
  formatApproxUsdFromSats,
  formatBitcoinBaseUnits,
  formatFiatPrice,
  formatSourcePrice,
  getCurrencyAmountStep,
  getCurrencyFractionDigits,
  getPriceSats,
  getShippingCostSats,
  getShopperPriceDisplay,
  getShopperCardPriceDisplay,
  getProductCardPriceDisplay,
  type CardPriceLabel,
  getShopperSatsDisplay,
  isBtcLikeCurrency,
  isFiatCurrencyCode,
  isMsatsLikeCurrency,
  isPricingRateQuoteFresh,
  isSatsLikeCurrency,
  isSupportedCommercePriceCurrency,
  isSupportedShopperDisplayCurrency,
  isUsdCurrencyCode,
  normalizeCommercePrice,
  normalizeCurrencyAmount,
  normalizeCurrencyCode,
  normalizeCurrencyIdentity,
  normalizeShopperPricePreference,
  type BitcoinDisplayUnit,
  type CommercePriceNormalizationOptions,
  type ShopperDisplayCurrency,
  type ShopperPriceDisplay,
  type ShopperPriceDisplayOptions,
  type ShopperPriceDisplayState,
  type ShopperPricePreference,
} from "./pricing"
export {
  BTC_USD_RATE_QUERY_KEY,
  getBtcUsdRateQueryKey,
  BTC_USD_RATE_REFRESH_INTERVAL_MS,
  BTC_USD_RATE_STALE_MS,
  fetchBtcUsdRate,
  getConfiguredBtcUsdRate,
  getConfiguredPricingRateQuote,
  isBtcUsdRateQuoteFresh,
  useBtcUsdRate,
  useDisplayBtcUsdRate,
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
  APP_RELAY_REGISTRY_VERSION,
  applyE2eRelayIsolation,
  CANONICAL_APP_BACKPLANE_RELAYS,
  CANONICAL_APP_READ_RELAYS,
  CANONICAL_APP_RELAY_DEFINITIONS,
  CANONICAL_APP_WRITE_RELAYS,
  CANONICAL_COMMERCE_DISCOVERY_RELAYS,
  CANONICAL_COMMERCE_DM_FALLBACK_RELAYS,
  CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS,
  CANONICAL_DEFAULT_RELAYS,
  CANONICAL_DM_DECLARATION_DISCOVERY_RELAYS,
  CANONICAL_DM_COMPATIBILITY_ORDER_RELAYS,
  CANONICAL_DM_INBOX_DEFAULT_RELAYS,
  CANONICAL_SEARCH_INDEX_RELAYS,
  CANONICAL_ZAP_PUBLIC_RELAYS,
  config,
  getRelayBucketConfigs,
  isRetiredDefaultRelayUrl,
  resolveDmCompatibilityOrderRoutingEnabled,
  resolveQuantumRouterEnabled,
  resolveQuantumRouterExecutionEnabled,
  resolveE2eRelayIsolation,
  isMockPayments,
  isSignet,
  isTestnet,
  isMainnet,
  isQuantumRouterEnabled,
  isQuantumRouterExecutionEnabled,
  type AppRelayDefinition,
  type AppRelayNip65Mode,
  type ConduitConfig,
  type RelayBucketConfig,
  type RelayBucketId,
} from "./config"

// Database
export {
  db,
  pruneCommerceCaches,
  subscribeToWalletDescriptorChanges,
  subscribeToShoppingCartChanges,
  subscribeToProductCacheChanges,
  pruneShopperTrustSnapshots,
  shopperTrustSnapshotIsExpired,
  SHOPPER_TRUST_SNAPSHOT_MAX_ROWS,
  SHOPPER_TRUST_SNAPSHOT_RETENTION_MS,
  type StoredOrder,
  type ConduitDB,
  type EventMarketOrganizerStockPool,
  type EventMarketOrganizerStockEntry,
  type MerchantInventoryProduct,
  type MerchantInventoryAssignment,
  type StoredMessage,
  type CachedProduct,
  type CachedProductTombstone,
  type CachedShippingOptionFrontier,
  type CachedEventMarketEvidence,
  type ProductDeletionDeliveryJob,
  type ProductListingDeliveryJob,
  type ProductListingDeliveryState,
  type ProductListingRelayDelivery,
  type ProductListingRelayDeliveryStatus,
  type ProductListingRelayTarget,
  type LocalProductWriteIntent,
  type LocalProductWriteFrontier,
  type LocalProductShippingJob,
  type LocalProductStockCheckpoint,
  type ProductDeletionDeliveryState,
  type ProductDeletionRelayDelivery,
  type ProductDeletionRelayDeliveryStatus,
  type ProductDeletionRelayRole,
  type ProductDeletionRelayTarget,
  type CachedProfile,
  type CachedOrderMessage,
  type DeclaredInboxDeclarationEventEvidence,
  type InboxDeclarationEventEvidence,
  type InboxDeclarationEvidenceRecord,
  type InboxDeclarationEvidenceState,
  type MalformedInboxDeclarationEventEvidence,
  type NormalizedInboxDeclarationPubkey,
  type SignedEmptyInboxDeclarationEventEvidence,
  type CachedNip05Verification,
  type CachedShopperTrustCoverage,
  type CachedShopperTrustSignal,
  type CachedShopperTrustSignalState,
  type CachedShopperTrustSnapshot,
  type StoredPaymentAttempt,
  type StoredMerchantPendingInvoice,
  type StoredWalletCredential,
  type StoredShoppingCart,
  type OrderLifecycle,
  type OrderLifecycleItem,
  type OrderLifecyclePhase,
  type OrderCheckoutMode,
  type OrderPublicZapSigner,
  type OrderBuyerIdentityKind,
  type OrderGuestContact,
  type OrderAddressValidity,
  type OrderShippingZoneEligibility,
  type OrderDeliveryRoute,
  type OrderRelayDelivery,
  type OrderRelayDeliveryRecord,
  type OrderRelayDeliveryStatus,
  type OrderDeliveryStatus,
  type OrderInvoiceStatus,
  type OrderPaymentStatus,
  type OrderPaymentTarget,
  type OrderProofDeliveryStatus,
  type OrderZapReceiptStatus,
} from "./db"

// Context
export {
  AuthProvider,
  useAuth,
  hasNip07,
  getAuthSignerReadiness,
  isTransientNip07ConnectError,
  type AuthStatus,
  type AuthSignerReadiness,
  type AuthContextValue,
  type RemoteSignerRecoveryState,
} from "./context/AuthContext"
export {
  ConduitSessionProvider,
  useConduitSession,
  type ConduitSessionContextValue,
  type ConduitSessionProviderProps,
} from "./context/ConduitSessionContext"

// Hooks
export { useProjectTipReceipt } from "./hooks/useProjectTipReceipt"
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
  useUnreadDirectMessageCount,
  type UnreadDirectMessageCountState,
} from "./hooks/useUnreadDirectMessageCount"
export {
  getProfileSearchQueryKey,
  selectProfileSearchPhaseResult,
  useProfileSearch,
  type UseProfileSearchOptions,
  type UseProfileSearchResult,
} from "./hooks/useProfileSearch"
export {
  getProfileQueryPerspectiveKey,
  getProfileSingletonQueryKey,
  useProfiles,
  type UseProfilesOptions,
  type UseProfilesResult,
} from "./hooks/useProfiles"
export {
  useShopperTrustEvidence,
  type UseShopperTrustEvidenceOptions,
  type UseShopperTrustEvidenceResult,
} from "./hooks/useShopperTrustEvidence"
export {
  prepareAccountNetworkPreferencesPresentation,
  useAccountNetworkPreferences,
  type AccountNetworkPreferencesState,
  type AccountNetworkPreferencesStatus,
  type UseAccountNetworkPreferencesResult,
} from "./hooks/useAccountNetworkPreferences"
export {
  useAccountNetworkSettings,
  type AccountNetworkMediaServerController,
  type AccountNetworkReviewChangedObject,
  type AccountNetworkSettingsController,
  type AccountNetworkSettingsOperationKind,
  type AccountNetworkSettingsOperationPhase,
  type AccountNetworkSettingsOperationView,
  type PreparedAccountNetworkSettingsChange,
  type PrepareAccountNetworkSettingsChangeInput,
} from "./hooks/useAccountNetworkSettings"
export {
  INBOX_DECLARATION_QUERY_KEY,
  useInboxDeclaration,
  type InboxDeclarationStatus,
  type UseInboxDeclarationOptions,
  type UseInboxDeclarationResult,
} from "./hooks/useInboxDeclaration"
export {
  useMediaServerPreferences,
  type MediaServerDraftActionResult,
  type MediaServerPreferenceViewStatus,
  type MediaServerPreferencesView,
  type MediaServerPublishPhase,
  type UseMediaServerPreferencesOptions,
  type UseMediaServerPreferencesResult,
} from "./hooks/useMediaServerPreferences"
export {
  useProductImageUpload,
  type ProductImageUploadController,
  type ProductImageUploadRequest,
} from "./hooks/useProductImageUpload"
export {
  useUpdateProfile,
  type UseUpdateProfileOptions,
} from "./hooks/useUpdateProfile"
export {
  useProgressiveEventMarketDiscovery,
  createProgressiveEventMarketDiscoveryQuery,
} from "./hooks/useProgressiveEventMarketDiscovery"

export { useCommerceInbox } from "./hooks/useCommerceInbox"

export {
  observeCheckoutSparkOperation,
  type CheckoutSparkOperationStep,
  type CheckoutSparkPerformanceObservation,
  type CheckoutSparkPerformanceObserver,
} from "./protocol/checkout-spark-performance"
