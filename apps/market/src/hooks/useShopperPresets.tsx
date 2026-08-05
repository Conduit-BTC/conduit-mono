import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  DEFAULT_SHOPPER_PRESETS,
  decryptShopperPresetsDocument,
  fetchShopperPresets,
  getShopperDiscoveryDestination,
  getShopperPresetsValue,
  publishShopperPresets,
  useAuth,
  useConduitSession,
  type ShopperPresetsEnvelope,
  type ShopperPresetsReadResult,
  type ShopperPresetsValue,
} from "@conduit/core"
import {
  clearShopperPresetsUnlock,
  getBrowserShopperPresetsStorage,
  persistShopperPresetsUnlock,
  readRememberedShopperPresetsPassword,
  readShopperPresetsUnlockPolicy,
  removeLegacyPlaintextShopperPresets,
  type ShopperPresetsUnlockPolicy,
} from "../lib/shopper-presets-store"

export type ShopperPresetsSyncState =
  "disconnected" | "syncing" | "ready" | "synced" | "unavailable" | "error"

export type ShopperPresetsUnlockState =
  | "disconnected"
  | "loading"
  | "empty"
  | "locked"
  | "unlocking"
  | "unlocked"
  | "error"

type RemotePreset = {
  envelope: ShopperPresetsEnvelope
  eventId: string
}

type DecryptedPreset = {
  ownerPubkey: string
  value: ShopperPresetsValue
}

type ShopperPresetsContextValue = {
  identityPubkey: string | null
  presetOwnerPubkey: string | null
  preset: ShopperPresetsValue
  discoveryDestination: { country: string; postalCode: string } | null
  syncState: ShopperPresetsSyncState
  unlockState: ShopperPresetsUnlockState
  unlockPolicy: ShopperPresetsUnlockPolicy
  hasRemotePreset: boolean
  canSync: boolean
  updateLocal: (value: ShopperPresetsValue) => void
  unlock: (
    password: string,
    policy: ShopperPresetsUnlockPolicy
  ) => Promise<boolean>
  save: (
    value: ShopperPresetsValue,
    password: string,
    policy: ShopperPresetsUnlockPolicy
  ) => Promise<boolean>
  clear: (password: string) => Promise<boolean>
  lock: () => void
  refresh: () => Promise<void>
}

const ShopperPresetsContext = createContext<ShopperPresetsContextValue | null>(
  null
)

function queryKey(pubkey: string | null) {
  return ["shopper-presets-envelope", pubkey] as const
}

const waitForColdStartRetry = () =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, 500))

export async function fetchShopperPresetsForSession(
  pubkey: string,
  fetchPreset: typeof fetchShopperPresets = fetchShopperPresets,
  wait: () => Promise<void> = waitForColdStartRetry
): Promise<ShopperPresetsReadResult> {
  const first = await fetchPreset(pubkey)
  if (first.state !== "unavailable" || first.reason !== "relay_read") {
    return first
  }
  await wait()
  return fetchPreset(pubkey)
}

export function ShopperPresetsProvider({ children }: { children: ReactNode }) {
  const { pubkey, signer, status } = useAuth()
  const { identityReady } = useConduitSession()
  const queryClient = useQueryClient()
  const identityPubkey = status === "connected" ? pubkey : null
  const identityRef = useRef(identityPubkey)
  identityRef.current = identityPubkey
  const handledRemoteRef = useRef<string | null>(null)
  const [decryptedPreset, setDecryptedPreset] =
    useState<DecryptedPreset | null>(null)
  const [remotePreset, setRemotePreset] = useState<RemotePreset | null>(null)
  const [unlockState, setUnlockState] =
    useState<ShopperPresetsUnlockState>("disconnected")
  const [syncState, setSyncState] =
    useState<ShopperPresetsSyncState>("disconnected")
  const [unlockPolicy, setUnlockPolicy] =
    useState<ShopperPresetsUnlockPolicy>("always")

  const remote = useQuery({
    queryKey: queryKey(identityPubkey),
    queryFn: () => fetchShopperPresetsForSession(identityPubkey!),
    enabled: !!identityPubkey && identityReady,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })

  const rememberPassword = useCallback(
    (password: string, policy: ShopperPresetsUnlockPolicy) => {
      if (!identityPubkey) return
      const storage = getBrowserShopperPresetsStorage()
      if (!storage) return
      persistShopperPresetsUnlock(
        identityPubkey,
        password,
        policy,
        storage.local,
        storage.session
      )
      setUnlockPolicy(policy)
    },
    [identityPubkey]
  )

  const decryptRemote = useCallback(
    async (
      encrypted: RemotePreset,
      password: string,
      policy: ShopperPresetsUnlockPolicy
    ): Promise<boolean> => {
      const identity = identityPubkey
      if (!identity) return false
      setUnlockState("unlocking")
      try {
        const document = await decryptShopperPresetsDocument(
          encrypted.envelope,
          password
        )
        if (identityRef.current !== identity) return false
        setDecryptedPreset({
          ownerPubkey: identity,
          value: getShopperPresetsValue(document),
        })
        setUnlockState("unlocked")
        setSyncState("synced")
        rememberPassword(password, policy)
        return true
      } catch {
        if (identityRef.current === identity) setUnlockState("error")
        return false
      }
    },
    [identityPubkey, rememberPassword]
  )

  useEffect(() => {
    handledRemoteRef.current = null
    setDecryptedPreset(null)
    setRemotePreset(null)
    if (!identityPubkey) {
      setUnlockState("disconnected")
      setSyncState("disconnected")
      return
    }
    setUnlockState("loading")
    setSyncState("syncing")
    const storage = getBrowserShopperPresetsStorage()
    if (storage) {
      removeLegacyPlaintextShopperPresets(identityPubkey, storage.local)
      setUnlockPolicy(
        readShopperPresetsUnlockPolicy(identityPubkey, storage.local)
      )
    }
  }, [identityPubkey])

  useEffect(() => {
    const result = remote.data
    if (!identityPubkey || !result) return
    if (result.state === "not_found") {
      setRemotePreset(null)
      setDecryptedPreset(null)
      setUnlockState("empty")
      setSyncState("ready")
      return
    }
    if (result.state === "unavailable" || !result.usable) {
      setUnlockState("error")
      setSyncState("unavailable")
      return
    }
    if (handledRemoteRef.current === result.revision.eventId) return
    handledRemoteRef.current = result.revision.eventId
    const encrypted = {
      envelope: result.envelope,
      eventId: result.revision.eventId,
    }
    setRemotePreset(encrypted)
    setDecryptedPreset(null)
    setSyncState("synced")
    const storage = getBrowserShopperPresetsStorage()
    const remembered = storage
      ? readRememberedShopperPresetsPassword(
          identityPubkey,
          storage.local,
          storage.session
        )
      : null
    if (!remembered) {
      setUnlockState("locked")
      return
    }
    void decryptRemote(encrypted, remembered.password, remembered.policy).then(
      (unlocked) => {
        if (unlocked || !storage) return
        clearShopperPresetsUnlock(
          identityPubkey,
          storage.local,
          storage.session
        )
        setUnlockState("locked")
      }
    )
  }, [decryptRemote, identityPubkey, remote.data])

  useEffect(() => {
    if (!identityPubkey || !remote.isError) return
    setUnlockState("error")
    setSyncState("error")
  }, [identityPubkey, remote.isError])

  const unlock = useCallback(
    async (password: string, policy: ShopperPresetsUnlockPolicy) => {
      if (!remotePreset) return false
      return decryptRemote(remotePreset, password, policy)
    },
    [decryptRemote, remotePreset]
  )

  const save = useCallback(
    async (
      value: ShopperPresetsValue,
      password: string,
      policy: ShopperPresetsUnlockPolicy
    ): Promise<boolean> => {
      if (!identityPubkey || !identityReady || !signer || !value.shipping)
        return false
      const identity = identityPubkey
      setSyncState("syncing")
      try {
        const result = await publishShopperPresets({
          pubkey: identity,
          value,
          password,
          appId: "market",
          dependencies: { signer },
        })
        if (identityRef.current !== identity) return false
        const next: ShopperPresetsReadResult = {
          state: "found",
          envelope: result.envelope,
          revision: result.revision,
          usable: true,
        }
        handledRemoteRef.current = result.revision.eventId
        setRemotePreset({
          envelope: result.envelope,
          eventId: result.revision.eventId,
        })
        setDecryptedPreset({ ownerPubkey: identity, value })
        setUnlockState("unlocked")
        setSyncState("synced")
        rememberPassword(password, policy)
        queryClient.setQueryData(queryKey(identity), next)
        return true
      } catch {
        if (identityRef.current === identity) setSyncState("error")
        return false
      }
    },
    [identityPubkey, identityReady, queryClient, rememberPassword, signer]
  )

  const clear = useCallback(
    async (password: string): Promise<boolean> => {
      if (!identityPubkey || !identityReady || !signer) return false
      const identity = identityPubkey
      setSyncState("syncing")
      try {
        const result = await publishShopperPresets({
          pubkey: identity,
          value: null,
          password,
          appId: "market",
          dependencies: { signer },
        })
        if (identityRef.current !== identity) return false
        const next: ShopperPresetsReadResult = {
          state: "found",
          envelope: result.envelope,
          revision: result.revision,
          usable: true,
        }
        handledRemoteRef.current = result.revision.eventId
        setRemotePreset({
          envelope: result.envelope,
          eventId: result.revision.eventId,
        })
        setDecryptedPreset({
          ownerPubkey: identity,
          value: DEFAULT_SHOPPER_PRESETS,
        })
        setUnlockState("unlocked")
        setSyncState("synced")
        rememberPassword(password, unlockPolicy)
        queryClient.setQueryData(queryKey(identity), next)
        return true
      } catch {
        if (identityRef.current === identity) setSyncState("error")
        return false
      }
    },
    [
      identityPubkey,
      identityReady,
      queryClient,
      rememberPassword,
      signer,
      unlockPolicy,
    ]
  )

  const lock = useCallback(() => {
    if (!identityPubkey) return
    setDecryptedPreset(null)
    setUnlockState(remotePreset ? "locked" : "empty")
    const storage = getBrowserShopperPresetsStorage()
    if (storage) {
      clearShopperPresetsUnlock(identityPubkey, storage.local, storage.session)
    }
  }, [identityPubkey, remotePreset])

  const refresh = useCallback(async (): Promise<void> => {
    if (!identityPubkey) return
    const identity = identityPubkey
    handledRemoteRef.current = null
    setSyncState("syncing")
    try {
      const result = await fetchShopperPresets(identity)
      if (identityRef.current !== identity) return
      queryClient.setQueryData(queryKey(identity), result)
    } catch {
      if (identityRef.current === identity) setSyncState("error")
    }
  }, [identityPubkey, queryClient])

  const presetOwnerPubkey =
    decryptedPreset?.ownerPubkey === identityPubkey
      ? decryptedPreset.ownerPubkey
      : null
  const preset =
    presetOwnerPubkey && decryptedPreset
      ? decryptedPreset.value
      : DEFAULT_SHOPPER_PRESETS
  const updateLocal = useCallback(
    (value: ShopperPresetsValue) => {
      if (!identityPubkey) return
      setDecryptedPreset({ ownerPubkey: identityPubkey, value })
    },
    [identityPubkey]
  )
  const discoveryDestination = useMemo(
    () => getShopperDiscoveryDestination(preset),
    [preset]
  )
  const value = useMemo(
    () => ({
      identityPubkey,
      presetOwnerPubkey,
      preset,
      discoveryDestination,
      syncState,
      unlockState,
      unlockPolicy,
      hasRemotePreset: remotePreset !== null,
      canSync: !!identityPubkey && identityReady && !!signer,
      updateLocal,
      unlock,
      save,
      clear,
      lock,
      refresh,
    }),
    [
      clear,
      discoveryDestination,
      identityPubkey,
      identityReady,
      lock,
      preset,
      presetOwnerPubkey,
      refresh,
      remotePreset,
      save,
      signer,
      syncState,
      unlock,
      unlockPolicy,
      unlockState,
      updateLocal,
    ]
  )

  return (
    <ShopperPresetsContext.Provider value={value}>
      {children}
    </ShopperPresetsContext.Provider>
  )
}

export function useShopperPresets(): ShopperPresetsContextValue {
  const context = useContext(ShopperPresetsContext)
  if (!context) {
    throw new Error(
      "useShopperPresets must be used within ShopperPresetsProvider"
    )
  }
  return context
}
