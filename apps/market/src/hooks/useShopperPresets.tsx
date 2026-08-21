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
  type ShopperPresetsRevision,
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
import {
  isCurrentShopperPresetsRevision,
  isCurrentShopperPresetsRelayLifecycle,
  shopperPresetsQueryKey,
  shouldApplyShopperPresetsReadResult,
  shouldRefetchShopperPresetsAfterRelayActivation,
  type ShopperPresetsRelayLifecycle,
} from "../lib/shopper-presets-relay-lifecycle"

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
  unlock: (
    password: string,
    policy: ShopperPresetsUnlockPolicy
  ) => Promise<boolean>
  save: (
    value: ShopperPresetsValue,
    password: string,
    policy: ShopperPresetsUnlockPolicy
  ) => Promise<boolean>
  clear: (
    password: string,
    policy: ShopperPresetsUnlockPolicy
  ) => Promise<boolean>
  lock: () => void
  refresh: () => Promise<void>
}

const ShopperPresetsContext = createContext<ShopperPresetsContextValue | null>(
  null
)

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
  const { pubkey, status } = useAuth()
  const { identityReady, relayScope, relaySettingsReady } = useConduitSession()
  const queryClient = useQueryClient()
  const identityPubkey = status === "connected" ? pubkey : null
  const relayLifecycle = useMemo<ShopperPresetsRelayLifecycle>(
    () => ({
      identityPubkey,
      relayScope,
      relaySettingsReady,
    }),
    [identityPubkey, relayScope, relaySettingsReady]
  )
  const relayLifecycleRef = useRef(relayLifecycle)
  relayLifecycleRef.current = relayLifecycle
  const previousRelayLifecycleRef = useRef<ShopperPresetsRelayLifecycle | null>(
    null
  )
  const acceptedRevisionRef = useRef<ShopperPresetsRevision | null>(null)
  const [decryptedPreset, setDecryptedPreset] =
    useState<DecryptedPreset | null>(null)
  const [remotePreset, setRemotePreset] =
    useState<ShopperPresetsEnvelope | null>(null)
  const [unlockState, setUnlockState] =
    useState<ShopperPresetsUnlockState>("disconnected")
  const [syncState, setSyncState] =
    useState<ShopperPresetsSyncState>("disconnected")
  const [unlockPolicy, setUnlockPolicy] =
    useState<ShopperPresetsUnlockPolicy>("always")

  const remote = useQuery({
    queryKey: shopperPresetsQueryKey(identityPubkey, relayScope),
    queryFn: () => fetchShopperPresetsForSession(identityPubkey!),
    enabled: !!identityPubkey && identityReady && relaySettingsReady,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
  const refetchRemote = remote.refetch

  useEffect(() => {
    const previous = previousRelayLifecycleRef.current
    previousRelayLifecycleRef.current = relayLifecycle
    const cacheKey = shopperPresetsQueryKey(identityPubkey, relayScope)
    const hasCachedData = queryClient.getQueryData(cacheKey) !== undefined
    if (
      !shouldRefetchShopperPresetsAfterRelayActivation(
        previous,
        relayLifecycle,
        hasCachedData
      )
    )
      return
    void refetchRemote()
  }, [identityPubkey, queryClient, refetchRemote, relayLifecycle, relayScope])

  const rememberPassword = useCallback(
    (password: string, policy: ShopperPresetsUnlockPolicy) => {
      if (!identityPubkey) return
      const storage = getBrowserShopperPresetsStorage()
      setUnlockPolicy(policy)
      if (!storage) return
      persistShopperPresetsUnlock(
        identityPubkey,
        password,
        policy,
        storage.local,
        storage.session
      )
    },
    [identityPubkey]
  )

  const decryptRemote = useCallback(
    async (
      encrypted: ShopperPresetsEnvelope,
      password: string,
      policy: ShopperPresetsUnlockPolicy,
      revision: ShopperPresetsRevision
    ): Promise<boolean> => {
      const lifecycle = relayLifecycle
      if (
        !lifecycle.identityPubkey ||
        !isCurrentShopperPresetsRevision(acceptedRevisionRef.current, revision)
      )
        return false
      setUnlockState("unlocking")
      try {
        const document = await decryptShopperPresetsDocument(
          encrypted,
          password
        )
        if (
          !isCurrentShopperPresetsRelayLifecycle(
            relayLifecycleRef.current,
            lifecycle
          ) ||
          !isCurrentShopperPresetsRevision(
            acceptedRevisionRef.current,
            revision
          )
        )
          return false
        setDecryptedPreset({
          ownerPubkey: lifecycle.identityPubkey,
          value: getShopperPresetsValue(document),
        })
        setUnlockState("unlocked")
        setSyncState("synced")
        rememberPassword(password, policy)
        return true
      } catch {
        if (
          isCurrentShopperPresetsRelayLifecycle(
            relayLifecycleRef.current,
            lifecycle
          ) &&
          isCurrentShopperPresetsRevision(acceptedRevisionRef.current, revision)
        )
          setUnlockState("error")
        return false
      }
    },
    [relayLifecycle, rememberPassword]
  )

  useEffect(() => {
    acceptedRevisionRef.current = null
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
  }, [identityPubkey, relayScope])

  useEffect(() => {
    const result = remote.data
    if (!identityPubkey || !result) return
    const lifecycle = relayLifecycle
    if (
      !shouldApplyShopperPresetsReadResult(result, acceptedRevisionRef.current)
    )
      return
    if (result.state === "not_found") {
      setRemotePreset(null)
      setDecryptedPreset(null)
      setUnlockState("empty")
      setSyncState("ready")
      return
    }
    if (result.state === "unavailable") {
      setUnlockState("error")
      setSyncState("unavailable")
      return
    }
    acceptedRevisionRef.current = result.revision
    const encrypted = result.envelope
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
    void decryptRemote(
      encrypted,
      remembered.password,
      remembered.policy,
      result.revision
    ).then((unlocked) => {
      if (
        unlocked ||
        !storage ||
        !isCurrentShopperPresetsRelayLifecycle(
          relayLifecycleRef.current,
          lifecycle
        ) ||
        !isCurrentShopperPresetsRevision(
          acceptedRevisionRef.current,
          result.revision
        )
      )
        return
      clearShopperPresetsUnlock(identityPubkey, storage.local, storage.session)
      setUnlockState("locked")
    })
  }, [decryptRemote, identityPubkey, relayLifecycle, remote.data])

  useEffect(() => {
    if (
      !identityPubkey ||
      !remote.isError ||
      acceptedRevisionRef.current !== null
    )
      return
    setUnlockState("error")
    setSyncState("error")
  }, [identityPubkey, remote.isError])

  const unlock = useCallback(
    async (password: string, policy: ShopperPresetsUnlockPolicy) => {
      const revision = acceptedRevisionRef.current
      if (!remotePreset || !revision) return false
      return decryptRemote(remotePreset, password, policy, revision)
    },
    [decryptRemote, remotePreset]
  )

  const save = useCallback(
    async (
      value: ShopperPresetsValue,
      password: string,
      policy: ShopperPresetsUnlockPolicy
    ): Promise<boolean> => {
      if (
        !identityPubkey ||
        !relayScope ||
        !identityReady ||
        !relaySettingsReady ||
        !value.shipping
      )
        return false
      const lifecycle = relayLifecycle
      const identity = lifecycle.identityPubkey
      if (!identity) return false
      setSyncState("syncing")
      try {
        const result = await publishShopperPresets({
          pubkey: identity,
          value,
          password,
          appId: "market",
        })
        if (
          !isCurrentShopperPresetsRelayLifecycle(
            relayLifecycleRef.current,
            lifecycle
          )
        )
          return false
        const next: ShopperPresetsReadResult = {
          state: "found",
          envelope: result.envelope,
          revision: result.revision,
        }
        acceptedRevisionRef.current = result.revision
        setRemotePreset(result.envelope)
        setDecryptedPreset({ ownerPubkey: identity, value })
        setUnlockState("unlocked")
        setSyncState("synced")
        rememberPassword(password, policy)
        queryClient.setQueryData(
          shopperPresetsQueryKey(identity, lifecycle.relayScope),
          next
        )
        return true
      } catch {
        if (
          isCurrentShopperPresetsRelayLifecycle(
            relayLifecycleRef.current,
            lifecycle
          )
        )
          setSyncState("error")
        return false
      }
    },
    [
      identityPubkey,
      identityReady,
      queryClient,
      relayLifecycle,
      relayScope,
      relaySettingsReady,
      rememberPassword,
    ]
  )

  const clear = useCallback(
    async (
      password: string,
      policy: ShopperPresetsUnlockPolicy
    ): Promise<boolean> => {
      if (
        !identityPubkey ||
        !relayScope ||
        !identityReady ||
        !relaySettingsReady
      )
        return false
      const lifecycle = relayLifecycle
      const identity = lifecycle.identityPubkey
      if (!identity) return false
      setSyncState("syncing")
      try {
        const result = await publishShopperPresets({
          pubkey: identity,
          value: null,
          password,
          appId: "market",
        })
        if (
          !isCurrentShopperPresetsRelayLifecycle(
            relayLifecycleRef.current,
            lifecycle
          )
        )
          return false
        const next: ShopperPresetsReadResult = {
          state: "found",
          envelope: result.envelope,
          revision: result.revision,
        }
        acceptedRevisionRef.current = result.revision
        setRemotePreset(result.envelope)
        setDecryptedPreset({
          ownerPubkey: identity,
          value: DEFAULT_SHOPPER_PRESETS,
        })
        setUnlockState("unlocked")
        setSyncState("synced")
        rememberPassword(password, policy)
        queryClient.setQueryData(
          shopperPresetsQueryKey(identity, lifecycle.relayScope),
          next
        )
        return true
      } catch {
        if (
          isCurrentShopperPresetsRelayLifecycle(
            relayLifecycleRef.current,
            lifecycle
          )
        )
          setSyncState("error")
        return false
      }
    },
    [
      identityPubkey,
      identityReady,
      queryClient,
      relayLifecycle,
      relayScope,
      relaySettingsReady,
      rememberPassword,
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
    if (!identityPubkey || !relayScope || !relaySettingsReady) return
    const lifecycle = relayLifecycle
    const identity = lifecycle.identityPubkey
    if (!identity) return
    setSyncState("syncing")
    try {
      const result = await fetchShopperPresets(identity)
      if (
        !isCurrentShopperPresetsRelayLifecycle(
          relayLifecycleRef.current,
          lifecycle
        )
      )
        return
      queryClient.setQueryData(
        shopperPresetsQueryKey(identity, lifecycle.relayScope),
        result
      )
    } catch {
      if (
        isCurrentShopperPresetsRelayLifecycle(
          relayLifecycleRef.current,
          lifecycle
        )
      )
        setSyncState("error")
    }
  }, [
    identityPubkey,
    queryClient,
    relayLifecycle,
    relayScope,
    relaySettingsReady,
  ])

  const presetOwnerPubkey =
    decryptedPreset?.ownerPubkey === identityPubkey
      ? decryptedPreset.ownerPubkey
      : null
  const preset =
    presetOwnerPubkey && decryptedPreset
      ? decryptedPreset.value
      : DEFAULT_SHOPPER_PRESETS
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
      canSync:
        !!identityPubkey && !!relayScope && identityReady && relaySettingsReady,
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
      relaySettingsReady,
      relayScope,
      lock,
      preset,
      presetOwnerPubkey,
      refresh,
      remotePreset,
      save,
      syncState,
      unlock,
      unlockPolicy,
      unlockState,
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
