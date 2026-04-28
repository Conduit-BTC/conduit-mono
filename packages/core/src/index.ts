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
export { useProfile } from "./hooks/useProfile"
export {
  useRelaySettings,
  type UseRelaySettingsResult,
} from "./hooks/useRelaySettings"
export { useUpdateProfile } from "./hooks/useUpdateProfile"
