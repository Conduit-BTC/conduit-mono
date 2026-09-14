import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useAuth, useConduitSession, useProfiles } from "@conduit/core"
import {
  getEventActorIdentityView,
  type EventActorIdentityView,
} from "../lib/event-actor-identity"

type EventActorIdentityBatchContextValue = {
  getIdentity: (pubkey: string) => EventActorIdentityView
  register: (pubkey: string) => () => void
}

const EventActorIdentityBatchContext =
  createContext<EventActorIdentityBatchContextValue | null>(null)

export function EventActorIdentityProvider({
  children,
}: {
  children: ReactNode
}) {
  const { authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const session = useConduitSession()
  const accountPubkey = session.mode === "signed_in" ? session.pubkey : null
  const registrations = useRef(new Map<string, number>())
  const [pubkeys, setPubkeys] = useState<string[]>([])
  const register = useCallback((pubkey: string) => {
    const current = registrations.current.get(pubkey) ?? 0
    registrations.current.set(pubkey, current + 1)
    if (current === 0) {
      setPubkeys((existing) =>
        existing.includes(pubkey) ? existing : [...existing, pubkey].sort()
      )
    }

    return () => {
      const remaining = (registrations.current.get(pubkey) ?? 1) - 1
      if (remaining > 0) {
        registrations.current.set(pubkey, remaining)
        return
      }
      registrations.current.delete(pubkey)
      setPubkeys((existing) => existing.filter((entry) => entry !== pubkey))
    }
  }, [])
  const { data: profiles } = useProfiles(pubkeys, {
    accountPubkey,
    authenticatedPubkey: accountPubkey,
    shouldContinue: () => authGenerationRef.current === authGeneration,
    enabled: session.relaySettingsReady && pubkeys.length > 0,
    priority: "visible",
    refetchUnresolvedMs: 5_000,
    maxUnresolvedRefetches: 2,
  })
  const getIdentity = useCallback(
    (pubkey: string) =>
      getEventActorIdentityView({
        pubkey,
        profile: profiles[pubkey],
      }),
    [profiles]
  )
  const value = useMemo(
    () => ({ getIdentity, register }),
    [getIdentity, register]
  )

  return createElement(
    EventActorIdentityBatchContext.Provider,
    { value },
    children
  )
}

export function useEventActorIdentity(
  pubkey: string | null | undefined
): EventActorIdentityView | null {
  const batch = useRequiredEventActorIdentityBatch()
  const register = batch.register

  useEffect(() => {
    if (!pubkey) return
    return register(pubkey)
  }, [pubkey, register])

  return useMemo(
    () => (pubkey ? batch.getIdentity(pubkey) : null),
    [batch, pubkey]
  )
}

function useRequiredEventActorIdentityBatch(): EventActorIdentityBatchContextValue {
  const batch = useContext(EventActorIdentityBatchContext)
  if (!batch) {
    throw new Error(
      "useEventActorIdentity must be used within EventActorIdentityProvider"
    )
  }
  return batch
}
