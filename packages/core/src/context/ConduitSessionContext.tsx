import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { ConduitAppId } from "../protocol/nip89"
import { disconnectNdk, refreshNdkRelaySettings } from "../protocol/ndk"
import {
  canRelaySettingsChangeControlRuntime,
  getActiveRelaySettingsScope,
  subscribeRelaySettingsChanges,
  setActiveRelaySettingsScope,
} from "../protocol/relay-settings"
import { closeAllProtectedRelayConnections } from "../protocol/relay-executor"
import {
  resolveConduitSession,
  shouldCloseProtectedConnectionsForScopeTransition,
  type ConduitSession,
} from "../protocol/session"
import type { Profile } from "../types"
import { useAccountNetworkPreferences } from "../hooks/useAccountNetworkPreferences"
import { useProfile } from "../hooks/useProfile"
import { useAuth } from "./AuthContext"

export interface ConduitSessionContextValue extends ConduitSession {
  identityReady: boolean
  relaySettingsReady: boolean
}

export interface ConduitSessionProviderProps {
  appId: ConduitAppId
  allowGuest?: boolean
  children: ReactNode
}

const ConduitSessionContext =
  createContext<ConduitSessionContextValue | null>(null)

function hasProfileName(profile: Profile | undefined): boolean {
  return !!(profile?.displayName?.trim() || profile?.name?.trim())
}

export function ConduitSessionProvider({
  appId,
  allowGuest = appId === "market",
  children,
}: ConduitSessionProviderProps) {
  const { pubkey, status } = useAuth()
  const signedInPubkey = status === "connected" ? pubkey : null
  const session = useMemo(
    () =>
      resolveConduitSession({
        appId,
        pubkey: signedInPubkey,
        allowGuest,
      }),
    [allowGuest, appId, signedInPubkey]
  )
  const profileQuery = useProfile(
    session.mode === "signed_in" ? session.pubkey : null,
    {
      authenticatedPubkey:
        session.mode === "signed_in" ? session.pubkey : null,
    }
  )
  const identityReady =
    session.mode === "guest" ||
    hasProfileName(profileQuery.data) ||
    (!profileQuery.isLoading && !profileQuery.isFetching)

  const accountNetworkPreferences = useAccountNetworkPreferences(
    session.pubkey,
    session.mode === "signed_in" && !!session.relayScope
  )
  const networkPreferencesReady =
    session.mode === "guest" || accountNetworkPreferences.status === "ready"
  const [activatedRelayScope, setActivatedRelayScope] = useState<string | null>(
    null
  )
  const relaySettingsReady =
    identityReady &&
    networkPreferencesReady &&
    activatedRelayScope === session.relayScope &&
    !!(session.relayScope || session.mode === "guest")

  const activeScopeRef = useRef<string | null>(null)
  const profileRelayScopeRef = useRef<string | null>(null)
  const profileRefreshReadyRef = useRef(false)
  const refetchProfile = profileQuery.refetch
  profileRefreshReadyRef.current =
    session.mode === "signed_in" && relaySettingsReady

  useEffect(() => {
    if (!session.relayScope) {
      if (
        shouldCloseProtectedConnectionsForScopeTransition(
          activeScopeRef.current,
          null
        )
      ) {
        closeAllProtectedRelayConnections()
      }
      activeScopeRef.current = null
      setActivatedRelayScope(null)
      setActiveRelaySettingsScope(null)
      disconnectNdk()
      return
    }

    if (!identityReady || !networkPreferencesReady) {
      if (
        shouldCloseProtectedConnectionsForScopeTransition(
          activeScopeRef.current,
          session.relayScope
        )
      ) {
        setActiveRelaySettingsScope(null)
        closeAllProtectedRelayConnections()
        disconnectNdk()
      }
      activeScopeRef.current = null
      setActivatedRelayScope(null)
      return
    }

    if (
      shouldCloseProtectedConnectionsForScopeTransition(
        activeScopeRef.current,
        session.relayScope
      )
    ) {
      closeAllProtectedRelayConnections()
    }

    if (getActiveRelaySettingsScope() !== session.relayScope) {
      refreshNdkRelaySettings(session.relayScope)
    }

    activeScopeRef.current = session.relayScope
    setActivatedRelayScope(session.relayScope)
  }, [identityReady, networkPreferencesReady, session.relayScope])

  useEffect(() => {
    const profileScope =
      session.mode === "signed_in" && session.relayScope
        ? `${session.pubkey}:${session.relayScope}`
        : null
    if (!profileScope) {
      profileRelayScopeRef.current = null
      return
    }
    if (
      !relaySettingsReady ||
      profileRelayScopeRef.current === profileScope
    )
      return
    profileRelayScopeRef.current = profileScope
    void refetchProfile()
  }, [
    refetchProfile,
    relaySettingsReady,
    session.mode,
    session.pubkey,
    session.relayScope,
  ])

  useEffect(() => {
    return subscribeRelaySettingsChanges((scope, source) => {
      if (!scope || scope !== activeScopeRef.current) return
      if (!canRelaySettingsChangeControlRuntime(scope, source)) return
      if (source === "signed_projection") {
        closeAllProtectedRelayConnections()
      }
      refreshNdkRelaySettings(scope)
      if (profileRefreshReadyRef.current) void refetchProfile()
    })
  }, [refetchProfile])

  const value = useMemo<ConduitSessionContextValue>(
    () => ({ ...session, identityReady, relaySettingsReady }),
    [identityReady, relaySettingsReady, session]
  )

  return (
    <ConduitSessionContext.Provider value={value}>
      {children}
    </ConduitSessionContext.Provider>
  )
}

export function useConduitSession(): ConduitSessionContextValue {
  const ctx = useContext(ConduitSessionContext)
  if (!ctx) {
    throw new Error(
      "useConduitSession must be used within a ConduitSessionProvider"
    )
  }
  return ctx
}
