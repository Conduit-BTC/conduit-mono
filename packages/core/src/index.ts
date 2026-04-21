// Types
export * from "./types"

// Protocol
export * from "./protocol"

// Schemas
export * from "./schemas"

// Utils
export * from "./utils"

// Config
export {
  config,
  isMockPayments,
  isSignet,
  isTestnet,
  isMainnet,
  getDefaultRelayGroups,
  getConfiguredRelayGroups,
  getEffectiveRelayGroups,
  getEffectiveRelayUrls,
  getEffectiveReadableRelayUrls,
  getEffectiveWritableRelayUrls,
  getEffectiveDiscoveryRelayUrls,
  getEffectiveDmRelayUrls,
  getEffectiveRoleRelayUrls,
  getRelayGroupsForActor,
  loadRelayOverrides,
  loadSignerRelayMap,
  saveRelayOverrides,
  saveSignerRelayMap,
  clearRelayOverrides,
  clearSignerRelayMap,
  relayRoleLabel,
  relayRoleDescription,
  relayPurposeLabel,
  relaySourceLabel,
  relaySourceDescription,
  type ConduitConfig,
} from "./config"

// Database
export {
  db,
  ensureCommerceCacheScope,
  type StoredOrder,
  type StoredMessage,
  type CachedProduct,
  type CachedProfile,
  type CachedOrderMessage,
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

// Hooks
export { useNdkState } from "./hooks/useNdkState"
export { useNip07Availability } from "./hooks/useNip07Availability"
export { useProfile } from "./hooks/useProfile"
export { useUpdateProfile } from "./hooks/useUpdateProfile"
export {
  useRelaySettings,
  type UseRelaySettingsResult,
} from "./hooks/useRelaySettings"
