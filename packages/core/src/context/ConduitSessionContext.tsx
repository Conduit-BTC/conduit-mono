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

  const relaySettings = useRelaySettings(session.relayScope, {
    pubkey: session.pubkey,
    enabled: session.mode === "signed_in" && !!session.relayScope,
  })
  const [activatedRelayScope, setActivatedRelayScope] = useState<string | null>(
    null
  )
  const relaySettingsReady =
    identityReady &&
    activatedRelayScope === session.relayScope &&
    !relaySettings.isLoadingPublishedRelayList

  const activeScopeRef = useRef<string | null>(null)

  useEffect(() => {
    if (!session.relayScope) {
      activeScopeRef.current = null
      setActivatedRelayScope(null)
      setActiveRelaySettingsScope(null)
      disconnectNdk()
      return
    }

    if (!identityReady) {
      activeScopeRef.current = null
      setActivatedRelayScope(null)
      return
    }

    if (getActiveRelaySettingsScope() !== session.relayScope) {
      refreshNdkRelaySettings(session.relayScope)
    }

    activeScopeRef.current = session.relayScope
    setActivatedRelayScope(session.relayScope)
  }, [identityReady, session.relayScope])

  useEffect(() => {
    return subscribeRelaySettingsChanges((scope) => {
      if (!scope || scope !== activeScopeRef.current) return
      refreshNdkRelaySettings(scope)
    })
  }, [])

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
