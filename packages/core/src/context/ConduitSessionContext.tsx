import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import type { ConduitAppId } from "../protocol/nip89"
import {
  connectNdk,
  disconnectNdk,
  refreshNdkRelaySettings,
} from "../protocol/ndk"
import {
  getActiveRelaySettingsScope,
  subscribeRelaySettingsChanges,
  setActiveRelaySettingsScope,
} from "../protocol/relay-settings"
import {
  resolveConduitSession,
  type ConduitSession,
} from "../protocol/session"
import type { Profile } from "../types"
import { useProfile } from "../hooks/useProfile"
import { useRelaySettings } from "../hooks/useRelaySettings"
import { useAuth } from "./AuthContext"

export interface ConduitSessionContextValue extends ConduitSession {
  identityReady: boolean
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
    session.mode === "signed_in" ? session.pubkey : null
  )
  const identityReady =
    session.mode === "guest" ||
    hasProfileName(profileQuery.data) ||
    (!profileQuery.isLoading && !profileQuery.isFetching)

  useRelaySettings(session.relayScope, {
    pubkey: session.pubkey,
    enabled: session.mode === "signed_in" && !!session.relayScope,
  })

  const activeScopeRef = useRef<string | null>(null)

  useEffect(() => {
    activeScopeRef.current = session.relayScope

    if (!session.relayScope) {
      setActiveRelaySettingsScope(null)
      disconnectNdk()
      return
    }

    if (!identityReady) return

    if (getActiveRelaySettingsScope() !== session.relayScope) {
      refreshNdkRelaySettings(session.relayScope)
    }

    void connectNdk()
  }, [identityReady, session.relayScope])

  useEffect(() => {
    return subscribeRelaySettingsChanges((scope) => {
      if (!scope || scope !== activeScopeRef.current) return
      refreshNdkRelaySettings(scope)
      void connectNdk()
    })
  }, [])

  const value = useMemo<ConduitSessionContextValue>(
    () => ({ ...session, identityReady }),
    [identityReady, session]
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
