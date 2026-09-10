import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useProfile, useProfiles } from "@conduit/core"
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
  const {
    data: profiles,
    hasProfile,
    lookupSettled,
  } = useProfiles(pubkeys, {
    enabled: pubkeys.length > 0,
    priority: "visible",
    refetchUnresolvedMs: 5_000,
    maxUnresolvedRefetches: 2,
  })
  const getIdentity = useCallback(
    (pubkey: string) =>
      getEventActorIdentityView({
        pubkey,
        profile: profiles[pubkey],
        lookupSettled: hasProfile(pubkey) || lookupSettled,
      }),
    [hasProfile, lookupSettled, profiles]
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
  const batch = useContext(EventActorIdentityBatchContext)
  const register = batch?.register
  const profileQuery = useProfile(pubkey, {
    enabled: !!pubkey && !batch,
    priority: "visible",
    refetchUnresolvedMs: 5_000,
    maxUnresolvedRefetches: 2,
  })

  useEffect(() => {
    if (!pubkey || !register) return
    return register(pubkey)
  }, [pubkey, register])

  return useMemo(
    () =>
      pubkey
        ? (batch?.getIdentity(pubkey) ??
          getEventActorIdentityView({
            pubkey,
            profile: profileQuery.data,
            lookupSettled: profileQuery.lookupSettled,
          }))
        : null,
    [batch, profileQuery.data, profileQuery.lookupSettled, pubkey]
  )
}
