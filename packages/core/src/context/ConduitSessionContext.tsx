import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { ConduitAppId } from "../protocol/nip89"
import {
  disconnectNdk,
  refreshNdkRelaySettings,
  refreshNdkRelaySettingsWhenIdle,
} from "../protocol/ndk"
import {
  getActiveRelaySettingsScope,
  isAccountRelaySettingsScope,
  subscribeRelaySettingsChanges,
  setActiveRelaySettingsScope,
} from "../protocol/relay-settings"
import {
  closeAllProtectedRelayConnections,
} from "../protocol/relay-executor"
import {
  isConduitRelaySettingsReady,
  resolveConduitSession,
  shouldCloseProtectedConnectionsForScopeTransition,
  type ConduitSession,
} from "../protocol/session"
import type { Profile } from "../types"
import {
  useAccountNetworkPreferences,
  type UseAccountNetworkPreferencesResult,
} from "../hooks/useAccountNetworkPreferences"
import { useProfile } from "../hooks/useProfile"
import { useAuth } from "./AuthContext"

export interface ConduitSessionContextValue extends ConduitSession {
  identityReady: boolean
  relaySettingsReady: boolean
  accountNetworkPreferences: UseAccountNetworkPreferencesResult
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
  const { authGeneration, pubkey, status } = useAuth()
  const signedInPubkey = status === "connected" ? pubkey : null
  const profileAuthorityRef = useRef({ authGeneration, pubkey: signedInPubkey })
  useLayoutEffect(() => {
    profileAuthorityRef.current = { authGeneration, pubkey: signedInPubkey }
  }, [authGeneration, signedInPubkey])
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
      shouldContinue: () =>
        profileAuthorityRef.current.authGeneration === authGeneration &&
        profileAuthorityRef.current.pubkey === signedInPubkey,
    }
  )
  const identityReady =
    session.mode === "guest" ||
    hasProfileName(profileQuery.data) ||
    (!profileQuery.isLoading && !profileQuery.isFetching)

  const [activatedRelayScope, setActivatedRelayScope] = useState<string | null>(
    null
  )
  const accountNetworkPreferencesEnabled =
    session.mode === "signed_in" && !!session.relayScope
  const accountNetworkPreferences = useAccountNetworkPreferences(
    session.pubkey,
    accountNetworkPreferencesEnabled,
    accountNetworkPreferencesEnabled &&
      activatedRelayScope === session.relayScope,
    authGeneration
  )
  const localRelayAuthorityReady =
    session.mode === "guest" || accountNetworkPreferences.localReady
  const relaySettingsReady = isConduitRelaySettingsReady({
    mode: session.mode,
    identityReady,
    localAuthorityReady: localRelayAuthorityReady,
    relayScope: session.relayScope,
    activatedRelayScope,
  })

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

    if (!identityReady || !localRelayAuthorityReady) {
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

    const runtimeScope = getActiveRelaySettingsScope()
    if (runtimeScope !== session.relayScope) {
      // Child route effects can begin their first read before this parent
      // activation effect runs. With no prior runtime scope to revoke, defer
      // connection retirement so cold-start hydration cannot interrupt that
      // otherwise valid work. Real identity transitions were revoked above.
      if (activeScopeRef.current === null && runtimeScope === null) {
        refreshNdkRelaySettingsWhenIdle(session.relayScope)
      } else {
        refreshNdkRelaySettings(session.relayScope)
      }
    }

    activeScopeRef.current = session.relayScope
    setActivatedRelayScope(session.relayScope)
  }, [identityReady, localRelayAuthorityReady, session.relayScope])

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
    return subscribeRelaySettingsChanges((scope) => {
      if (!scope || scope !== activeScopeRef.current) return
      if (isAccountRelaySettingsScope(scope)) return
      refreshNdkRelaySettings(scope)
      if (profileRefreshReadyRef.current) void refetchProfile()
    })
  }, [refetchProfile])

  const value = useMemo<ConduitSessionContextValue>(
    () => ({
      ...session,
      identityReady,
      relaySettingsReady,
      accountNetworkPreferences,
    }),
    [accountNetworkPreferences, identityReady, relaySettingsReady, session]
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
