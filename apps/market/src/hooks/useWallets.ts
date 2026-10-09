import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  config,
  useAuth,
  getAccountSigner,
  subscribeToAccountSignerChanges,
  getWalletDefaultReplacement,
  getWalletNetworkFromLightningConfig,
  parseNwcUri,
  subscribeToWalletDescriptorChanges,
  type AccountSigner,
  type WalletDescriptor,
  type WalletNetwork,
} from "@conduit/core"

import {
  closeBuyerNwcSession,
  getBuyerNwcSession,
  getBuyerNwcSessionSnapshots,
  type NwcSessionSnapshot,
} from "../lib/buyer-nwc-session"
import {
  getDefaultSparkAccountNumber,
  getSparkConfiguration,
  getSparkWalletManager,
  isSparkWalletManagerInitialized,
} from "../lib/spark-sdk"
import type {
  SparkPaymentSummary,
  SparkSendQuote,
  SparkSendRequest,
  SparkSendResult,
} from "../lib/spark-wallet"
import {
  generateSparkMnemonic,
  isValidSparkAccountNumber,
  isValidSparkMnemonic,
  normalizeSparkMnemonic,
} from "../lib/spark-recovery"
import {
  assertLocalSparkWalletRemovalSafe,
  cleanupSparkWalletState,
  openRegisteredSparkWallet,
  runSparkWalletRemoval,
  type SparkWalletRemovalMode,
} from "../lib/spark-wallet-lifecycle"
import {
  getNwcWalletRegistrationDetails,
  migrateLegacyNwcWallet,
  reconcileNwcWalletRegistration,
} from "../lib/wallet-migration"
import {
  getMarketWalletRegistry,
  getMarketWalletStore,
  getSparkRecoveryBinding,
  registerNwcWalletAtomically,
  registerSparkWalletAtomically,
  type StoredSparkWalletRecovery,
  serializeStoredSparkWalletRecovery,
} from "../lib/wallet-storage"
import {
  assertWalletSignerCurrent,
  isWalletSignerCurrent,
  recoverStoredSparkMnemonic,
  requireWalletSigner,
  sealSignerSparkRecovery,
} from "../lib/signer-spark-recovery"
import { rollbackFailedWalletSetup } from "../lib/wallet-setup-rollback"
import {
  getRemovedWalletIdsForProvider,
  LatestWalletReloadCoordinator,
  reconcileWalletSynchronizationError,
  WALLET_STORAGE_INITIALIZATION_ERROR,
  WalletDescriptorSubscriptionCoordinator,
  WalletInitializationCoordinator,
} from "../lib/wallet-initialization"
import {
  notifyWalletChangeFallback,
  subscribeToWalletChangeFallback,
} from "../lib/wallet-change-fallback"

/**
 * Reuse a recent live NWC probe across sequential route mounts. Explicit
 * connects and payment attempts still perform their own live probes.
 */
const NWC_MOUNT_WARM_MAX_AGE_MS = 30_000
const deliberatelyLockedWallets = new WeakMap<AccountSigner, Set<string>>()

export type WalletRuntimeState =
  | {
      status: "locked" | "connecting"
      balanceMsats: null
      error: null
    }
  | {
      status: "ready"
      balanceMsats: number | null
      error: null
    }
  | {
      status: "unavailable" | "error"
      balanceMsats: number | null
      error: string
    }

export interface UseWalletsReturn {
  wallets: WalletDescriptor[]
  portableWallets: WalletDescriptor[]
  connectedWallets: WalletDescriptor[]
  runtime: Record<string, WalletRuntimeState>
  nwcSnapshots: Record<string, NwcSessionSnapshot>
  loading: boolean
  hasPasswordWallets: boolean
  initializationError: string | null
  sparkAvailability: ReturnType<typeof getSparkConfiguration>
  hasSparkRecovery(walletId: string): Promise<boolean>
  getSparkRecoveryType(
    walletId: string
  ): Promise<"password" | "signer" | "signer-with-password-fallback" | null>
  renameWallet(walletId: string, label: string): Promise<void>
  connectNwc(uri: string, label?: string): Promise<WalletDescriptor>
  createSpark(label?: string): Promise<{
    wallet: WalletDescriptor
    mnemonic: string
    accountNumber: number
  }>
  importSpark(input: {
    label: string
    mnemonic: string
    accountNumber: number
  }): Promise<WalletDescriptor>
  unlockSpark(
    walletId: string,
    password?: string,
    migrate?: boolean
  ): Promise<void>
  revealSparkRecovery(
    walletId: string,
    password?: string
  ): Promise<{ mnemonic: string; accountNumber: number }>
  lockSpark(walletId: string): Promise<void>
  getSparkLightningAddress(
    walletId: string,
    register?: boolean
  ): Promise<import("@conduit/core").BreezAddressState>
  receiveSparkLightning(walletId: string, amountSats?: number): Promise<string>
  getSparkAddress(walletId: string): Promise<string>
  listSparkPayments(walletId: string): Promise<SparkPaymentSummary[]>
  prepareSparkSend(
    walletId: string,
    request: SparkSendRequest
  ): Promise<SparkSendQuote>
  confirmSparkSend(walletId: string, quoteId: string): Promise<SparkSendResult>
  hasUnresolvedSparkSend(walletId: string): boolean
  acknowledgeUnresolvedSparkSend(walletId: string): void
  discardSparkSendQuote(walletId: string, quoteId: string): void
  refreshBalance(walletId: string): Promise<void>
  setDefaultPaymentWallet(walletId: string): Promise<void>
  removeWallet(
    walletId: string,
    options?: { recoveryConfirmed?: boolean }
  ): Promise<void>
  retryInitialization(): Promise<void>
}

const lockedRuntime = (): WalletRuntimeState => ({
  status: "locked",
  balanceMsats: null,
  error: null,
})

const walletInitialization = new WalletInitializationCoordinator()

export function useWallets(
  options: { enabled?: boolean } = {}
): UseWalletsReturn {
  const auth = useAuth()
  const ownerRef = useRef(auth.accountPubkey)
  useLayoutEffect(() => {
    ownerRef.current = auth.accountPubkey
  }, [auth.accountPubkey])
  const enabled = options.enabled ?? true
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const registry = getMarketWalletRegistry()
  const store = getMarketWalletStore()
  const [wallets, setWallets] = useState<WalletDescriptor[]>([])
  const [loadedOwner, setLoadedOwner] = useState(auth.accountPubkey)
  const walletsRef = useRef<WalletDescriptor[]>([])
  const [reloadCoordinator] = useState(
    () => new LatestWalletReloadCoordinator()
  )
  const [subscriptionCoordinator] = useState(
    () => new WalletDescriptorSubscriptionCoordinator()
  )
  const [runtime, setRuntime] = useState<Record<string, WalletRuntimeState>>({})
  const [nwcSnapshots, setNwcSnapshots] = useState<
    Record<string, NwcSessionSnapshot>
  >({})
  const [hasPasswordWallets, setHasPasswordWallets] = useState(false)
  const [loading, setLoading] = useState(enabled)
  const [initializationError, setInitializationError] = useState<string | null>(
    null
  )
  const [walletSubscriptionEpoch, setWalletSubscriptionEpoch] = useState(0)
  const initializationAttemptRef = useRef(0)

  const reload = useCallback(
    async (shouldApply: () => boolean = () => true) => {
      await reloadCoordinator.run(
        async () => {
          const ownerPubkey = ownerRef.current
          const nextWallets = await store.listVisible(ownerPubkey)
          const sparkManager = getSparkWalletManager()
          const openSparkRuntime = new Map<string, WalletRuntimeState>()

          if (sparkManager) {
            await sparkManager.closeWalletsExcept(
              new Set(
                nextWallets
                  .filter((wallet) => wallet.providerId === "spark")
                  .map((wallet) => wallet.id)
              )
            )
            await Promise.all(
              nextWallets.map(async (wallet) => {
                if (
                  wallet.providerId !== "spark" ||
                  !sparkManager.isOpen(wallet.id)
                ) {
                  return
                }
                try {
                  const balanceSats = await sparkManager.getBalance(wallet.id)
                  openSparkRuntime.set(wallet.id, {
                    status: "ready",
                    balanceMsats: balanceSats * 1_000,
                    error: null,
                  })
                } catch (error) {
                  openSparkRuntime.set(wallet.id, {
                    status: "error",
                    balanceMsats: null,
                    error: getErrorMessage(
                      error,
                      "Could not refresh wallet balance."
                    ),
                  })
                }
              })
            )
          }

          const hasPasswordWallets = (
            await Promise.all(
              nextWallets
                .filter((w) => w.providerId === "spark")
                .map((w) => store.getSparkRecovery(w.id))
            )
          ).some((recovery) => recovery?.type === "password")
          return {
            nextWallets,
            openSparkRuntime,
            hasPasswordWallets,
            ownerPubkey,
          }
        },
        ({
          nextWallets,
          openSparkRuntime,
          hasPasswordWallets,
          ownerPubkey,
        }) => {
          if (
            !enabledRef.current ||
            !shouldApply() ||
            ownerRef.current !== ownerPubkey
          )
            return
          for (const walletId of getRemovedWalletIdsForProvider(
            walletsRef.current,
            nextWallets,
            "nwc"
          )) {
            closeBuyerNwcSession(walletId)
          }
          walletsRef.current = nextWallets
          setWallets(nextWallets)
          setLoadedOwner(ownerPubkey)
          setHasPasswordWallets(hasPasswordWallets)
          const nextNwcWalletIds = nextWallets
            .filter((wallet) => wallet.providerId === "nwc")
            .map((wallet) => wallet.id)
          const nextNwcSnapshots = getBuyerNwcSessionSnapshots(nextNwcWalletIds)
          setNwcSnapshots(nextNwcSnapshots)
          setRuntime((current) => {
            const next = { ...current }
            for (const wallet of nextWallets) {
              if (wallet.providerId === "spark") {
                next[wallet.id] =
                  openSparkRuntime.get(wallet.id) ?? lockedRuntime()
              } else if (wallet.providerId === "nwc") {
                next[wallet.id] = getNwcRuntimeState(
                  nextNwcSnapshots[wallet.id]
                )
              } else {
                next[wallet.id] ??= lockedRuntime()
              }
            }
            for (const walletId of Object.keys(next)) {
              if (!nextWallets.some((wallet) => wallet.id === walletId)) {
                delete next[walletId]
              }
            }
            return next
          })
        }
      )
      await reloadCoordinator.waitForLatest()
    },
    [reloadCoordinator, store]
  )

  const refreshAfterCommittedWalletMutation = useCallback(async () => {
    notifyWalletChangeFallback()
    let outcome: "succeeded" | "failed"
    try {
      await reload()
      outcome = "succeeded"
    } catch {
      outcome = "failed"
    }
    if (subscriptionCoordinator.acceptsCurrent(outcome)) {
      setInitializationError((current) =>
        reconcileWalletSynchronizationError(current, outcome)
      )
    }
  }, [reload, subscriptionCoordinator])

  const retryInitialization = useCallback(async () => {
    const attempt = initializationAttemptRef.current + 1
    initializationAttemptRef.current = attempt
    const isCurrentAttempt = () =>
      enabledRef.current && initializationAttemptRef.current === attempt
    setLoading(true)
    setInitializationError(null)
    try {
      await walletInitialization.run(initializeWalletStorage)
      if (!isCurrentAttempt()) return
      await reload(isCurrentAttempt)
      if (!isCurrentAttempt()) return
      setWalletSubscriptionEpoch(subscriptionCoordinator.start())
    } catch {
      if (isCurrentAttempt()) {
        setInitializationError(WALLET_STORAGE_INITIALIZATION_ERROR)
      }
    } finally {
      if (initializationAttemptRef.current === attempt) {
        setLoading(false)
      }
    }
  }, [reload, subscriptionCoordinator])

  useEffect(() => {
    if (!enabled) {
      initializationAttemptRef.current += 1
      walletsRef.current = []
      setWallets([])
      setRuntime({})
      setNwcSnapshots({})
      setWalletSubscriptionEpoch(0)
      setInitializationError(null)
      setLoading(false)
      return
    }
    void retryInitialization()
  }, [enabled, retryInitialization])

  useEffect(() => {
    if (!enabled || walletSubscriptionEpoch === 0) return

    let active = true
    const reportSynchronization = (outcome: "succeeded" | "failed") => {
      if (
        !active ||
        !subscriptionCoordinator.accepts(walletSubscriptionEpoch, outcome)
      ) {
        return
      }
      setInitializationError((current) =>
        reconcileWalletSynchronizationError(current, outcome)
      )
    }
    const reloadFromSubscription = () => {
      void reload().then(
        () => reportSynchronization("succeeded"),
        () => reportSynchronization("failed")
      )
    }
    const unsubscribeDescriptorChanges = subscribeToWalletDescriptorChanges({
      onChange: reloadFromSubscription,
      onError() {
        if (
          !active ||
          !subscriptionCoordinator.markFailed(walletSubscriptionEpoch)
        ) {
          return
        }
        reportSynchronization("failed")
      },
    })
    const unsubscribeFallback = subscribeToWalletChangeFallback(
      reloadFromSubscription
    )

    return () => {
      active = false
      unsubscribeDescriptorChanges()
      unsubscribeFallback()
    }
  }, [enabled, reload, subscriptionCoordinator, walletSubscriptionEpoch])

  useEffect(() => {
    if (!enabled) return
    const manager = getSparkWalletManager()
    if (!manager) {
      return
    }
    let active = true
    const unsubscribe = manager.subscribe((walletId) => {
      if (!active) {
        return
      }
      void refreshSparkBalance(walletId, manager, setRuntime).catch(
        () => undefined
      )
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const unsubscribes: Array<() => void> = []
    let active = true

    for (const wallet of wallets) {
      if (wallet.providerId !== "nwc") {
        continue
      }
      const session = getBuyerNwcSession(wallet.id)
      const unsubscribe = session.subscribe((snapshot) => {
        if (active) {
          setNwcSnapshots((current) => ({
            ...current,
            [wallet.id]: snapshot,
          }))
          setRuntime((current) => ({
            ...current,
            [wallet.id]: getNwcRuntimeState(snapshot),
          }))
        }
      })
      unsubscribes.push(unsubscribe)
      void store
        .getNwcCredential(wallet.id)
        .then(async (uri) => {
          if (!active || !uri) {
            return
          }
          session.setConnection(parseNwcUri(uri))
          const snapshot = await session.ensureWarm(NWC_MOUNT_WARM_MAX_AGE_MS)
          if (!active || !snapshot.info) {
            return
          }
          const changed = await reconcileNwcWalletRegistration({
            walletId: wallet.id,
            info: snapshot.info,
            store,
          })
          if (changed && active) {
            await refreshAfterCommittedWalletMutation()
          }
        })
        .catch(() => {
          if (active) {
            setRuntime((current) => ({
              ...current,
              [wallet.id]: {
                status: "error",
                balanceMsats: null,
                error: "Could not open this Connected Wallet.",
              },
            }))
          }
        })
    }

    return () => {
      active = false
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }, [enabled, refreshAfterCommittedWalletMutation, store, wallets])

  const ensureDefault = useCallback(
    async (wallet: WalletDescriptor) => {
      if (!wallet.capabilities.includes("pay_invoice")) {
        return
      }
      const eligible = (await store.listVisible(ownerRef.current)).filter(
        (candidate) =>
          candidate.network === wallet.network &&
          candidate.capabilities.includes("pay_invoice")
      )
      if (
        !eligible.some((candidate) =>
          candidate.defaultIntents.includes("pay_invoice")
        )
      ) {
        await registry.setDefault(wallet.id, "pay_invoice")
      }
    },
    [registry, store]
  )

  const registerSparkWallet = useCallback(
    async (input: {
      walletId: string
      label: string
      network: WalletNetwork
      recovery: StoredSparkWalletRecovery
      shouldContinue?: () => boolean
    }) =>
      registerSparkWalletAtomically({
        store,
        recovery: input.recovery,
        shouldContinue: input.shouldContinue,
        findExisting: async () => {
          if (input.recovery.type !== "signer") return undefined
          for (const wallet of await registry.list()) {
            if (wallet.providerId !== "spark") continue
            const stored = await store.getSparkRecovery(wallet.id)
            if (!stored)
              throw new Error(
                "Existing wallet recovery could not be read. Repair it before importing another wallet."
              )
            if (
              stored.type === "signer" &&
              stored.identityKey === input.recovery.identityKey
            ) {
              if (stored.ownerPubkey !== input.recovery.ownerPubkey)
                throw new Error(
                  "This wallet is already saved under another Nostr identity on this device."
                )
              return wallet
            }
          }
          return undefined
        },
        register: () =>
          registry.add({
            id: input.walletId,
            kind: "portable",
            providerId: "spark",
            label: input.label,
            network: input.network,
            capabilities: [
              "pay_invoice",
              "receive",
              "balance",
              "history",
              "spark_transfer",
            ],
          }),
      }),
    [registry, store]
  )

  const connectNwc = useCallback(
    async (uri: string, label?: string) => {
      const connection = parseNwcUri(uri)
      const temporaryWalletId = `pending-${crypto.randomUUID()}`
      const temporarySession = getBuyerNwcSession(temporaryWalletId)
      try {
        temporarySession.setConnection(connection)
        const snapshot = await temporarySession.warm()
        const info = snapshot.info
        const registration = getNwcWalletRegistrationDetails(
          info,
          getWalletNetworkFromLightningConfig(config.lightningNetwork)
        )
        const { wallet: connectedWallet } = await registerNwcWalletAtomically({
          store,
          uri,
          listWallets: () => registry.list(),
          register: () =>
            registry.add({
              kind: "connected",
              providerId: "nwc",
              label: label?.trim() || info?.alias?.trim() || "Connected wallet",
              network: registration.network,
              capabilities: registration.capabilities,
            }),
          ensureDefault,
        })
        const session = getBuyerNwcSession(connectedWallet.id)
        session.setConnection(connection)
        void session.warm()
        await refreshAfterCommittedWalletMutation()
        return connectedWallet
      } finally {
        closeBuyerNwcSession(temporaryWalletId)
      }
    },
    [ensureDefault, refreshAfterCommittedWalletMutation, registry, store]
  )

  const setupSparkWallet = useCallback(
    async (input: {
      label: string
      mnemonic: string
      accountNumber: number
    }) => {
      const manager = requireSparkManager()
      const network = getSparkWalletNetwork()
      const walletId = crypto.randomUUID()
      const binding = {
        walletId,
        providerId: "spark" as const,
        network,
        accountNumber: input.accountNumber,
      }
      const signer = requireWalletSigner()
      const recovery = await sealSignerSparkRecovery(
        input.mnemonic,
        binding,
        signer
      )
      assertWalletSignerCurrent(signer)
      const wallet = await registerSparkWallet({
        walletId,
        label:
          input.label.trim() ||
          `Conduit Wallet ${walletsRef.current.filter((w) => w.providerId === "spark").length + 1}`,
        network,
        recovery,
        shouldContinue: () => isWalletSignerCurrent(signer),
      })
      try {
        await manager.openWithMnemonic({
          walletId: wallet.id,
          mnemonic: input.mnemonic,
          accountNumber: input.accountNumber,
          shouldContinue: () => isWalletSignerCurrent(signer),
          subscribeRevocation: (listener) =>
            subscribeToAccountSignerChanges(() => {
              if (!isWalletSignerCurrent(signer)) listener()
            }),
        })
        assertWalletSignerCurrent(signer)
        await refreshSparkBalance(wallet.id, manager, setRuntime)
        await ensureDefault(wallet)
      } catch (error) {
        if (wallet.id !== walletId) throw error
        const rollback = await rollbackFailedWalletSetup({
          closeWallet: () => manager.close(wallet.id),
          removeRegistration: () => registry.remove(wallet.id),
        })
        if (rollback.status === "kept") {
          await refreshAfterCommittedWalletMutation()
          throw new Error(
            `${getErrorMessage(error, "Portable Wallet setup failed.")} ${rollback.reason}`,
            { cause: error }
          )
        }
        throw error
      }
      // Address setup cannot roll back a usable wallet. ensure recovers the
      // signed existing registration first; incomplete lookup never registers.
      try {
        await manager.getLightningAddress(wallet.id, true)
      } catch {
        /* Retry is available on the wallet card. */
      }
      assertWalletSignerCurrent(signer)
      await refreshAfterCommittedWalletMutation()
      return wallet
    },
    [
      ensureDefault,
      refreshAfterCommittedWalletMutation,
      registerSparkWallet,
      registry,
    ]
  )

  const createSpark = useCallback(
    async (label = "") => {
      requireSparkManager()
      const network = getSparkWalletNetwork()
      const accountNumber = getDefaultSparkAccountNumber(network)
      const mnemonic = generateSparkMnemonic()
      const wallet = await setupSparkWallet({
        label,
        mnemonic,
        accountNumber,
      })
      return {
        wallet,
        mnemonic,
        accountNumber,
      }
    },
    [setupSparkWallet]
  )

  const importSpark = useCallback(
    async (input: {
      label: string
      mnemonic: string
      accountNumber: number
    }) => {
      requireSparkManager()
      const mnemonic = normalizeSparkMnemonic(input.mnemonic)
      if (!isValidSparkMnemonic(mnemonic)) {
        throw new Error("Enter a valid BIP39 recovery phrase.")
      }
      const accountNumber = input.accountNumber
      if (!isValidSparkAccountNumber(accountNumber)) {
        throw new Error("Enter a valid Spark account number.")
      }
      return setupSparkWallet({
        label: input.label,
        mnemonic,
        accountNumber,
      })
    },
    [setupSparkWallet]
  )

  const unlockSpark = useCallback(
    async (walletId: string, password = "", migrate = false) => {
      const manager = requireSparkManager()
      setRuntime((current) => ({
        ...current,
        [walletId]: {
          status: "connecting",
          balanceMsats: null,
          error: null,
        },
      }))
      try {
        await openRegisteredSparkWallet({
          walletId,
          manager,
          expectedNetwork: getSparkWalletNetwork(),
          listWallets: () => registry.list(),
          resolveOpenInput: async (registration) => {
            const stored = await store.getSparkRecovery(walletId)
            if (!stored) {
              throw new Error("Portable Wallet recovery data is unavailable.")
            }
            const binding = getSparkRecoveryBinding(registration, stored)
            const recovered = await recoverStoredSparkMnemonic(
              stored,
              binding,
              password
            )
            const mnemonic = recovered.mnemonic
            const signer =
              recovered.signer ?? (migrate ? requireWalletSigner() : undefined)
            if (migrate && stored.type === "password" && signer) {
              const sealed = await sealSignerSparkRecovery(
                mnemonic,
                binding,
                signer
              )
              await store.transaction(async () => {
                assertWalletSignerCurrent(signer)
                const current = await store.getSparkRecovery(walletId)
                if (JSON.stringify(current) !== JSON.stringify(stored))
                  throw new Error(
                    "Wallet recovery changed. Reopen it before migrating."
                  )
                const migrated = { ...sealed, legacyRecovery: stored }
                await store.putSparkRecovery(walletId, migrated)
                if (
                  serializeStoredSparkWalletRecovery(
                    (await store.getSparkRecovery(walletId))!
                  ) !== serializeStoredSparkWalletRecovery(migrated)
                )
                  throw new Error("Wallet migration could not be verified.")
                assertWalletSignerCurrent(signer)
              })
            }
            return {
              mnemonic,
              accountNumber: stored.accountNumber,
              ...(signer
                ? {
                    shouldContinue: () => isWalletSignerCurrent(signer),
                    subscribeRevocation: (listener: () => void) =>
                      subscribeToAccountSignerChanges(() => {
                        if (!isWalletSignerCurrent(signer)) listener()
                      }),
                  }
                : {}),
            }
          },
          afterOpen: () => refreshSparkBalance(walletId, manager, setRuntime),
        })
        if (migrate) await refreshAfterCommittedWalletMutation()
      } catch (error) {
        setRuntime((current) => ({
          ...current,
          [walletId]: {
            status: "error",
            balanceMsats: null,
            error: getErrorMessage(error, "Could not unlock Portable Wallet."),
          },
        }))
        throw error
      }
    },
    [registry, store, refreshAfterCommittedWalletMutation]
  )

  const revealSparkRecovery = useCallback(
    async (walletId: string, password = "") => {
      const wallet = (await registry.list()).find(
        (candidate) =>
          candidate.id === walletId &&
          candidate.kind === "portable" &&
          candidate.providerId === "spark"
      )
      if (!wallet) {
        throw new Error(
          "Portable Wallet is no longer registered on this device."
        )
      }
      const stored = await store.getSparkRecovery(walletId)
      if (!stored) {
        throw new Error("Portable Wallet recovery data is unavailable.")
      }
      const recovered = await recoverStoredSparkMnemonic(
        stored,
        getSparkRecoveryBinding(wallet, stored),
        password
      )
      return {
        mnemonic: recovered.mnemonic,
        accountNumber: stored.accountNumber,
      }
    },
    [registry, store]
  )

  const hasSparkRecovery = useCallback(
    async (walletId: string) => {
      return Boolean(await store.getSparkRecovery(walletId))
    },
    [store]
  )

  const lockSpark = useCallback(async (walletId: string) => {
    const signer = getAccountSigner()
    if (signer) {
      const locked = deliberatelyLockedWallets.get(signer) ?? new Set<string>()
      locked.add(walletId)
      deliberatelyLockedWallets.set(signer, locked)
    }
    const manager = getSparkWalletManager()
    await manager?.close(walletId)
    setRuntime((current) => ({
      ...current,
      [walletId]: lockedRuntime(),
    }))
  }, [])

  const receiveSparkLightning = useCallback(
    async (walletId: string, amountSats?: number) => {
      const manager = requireSparkManager()
      const result = await manager.receiveLightning(walletId, {
        description: "Spark Portable Wallet receive",
        amountSats,
        expirySecs: 3_600,
      })
      return result.paymentRequest
    },
    []
  )

  const getSparkLightningAddress = useCallback(
    async (walletId: string, register = false) => {
      return requireSparkManager().getLightningAddress(walletId, register)
    },
    []
  )

  const getSparkAddress = useCallback(async (walletId: string) => {
    return requireSparkManager().getSparkAddress(walletId)
  }, [])

  const listSparkPayments = useCallback(async (walletId: string) => {
    return requireSparkManager().listPayments(walletId)
  }, [])

  const prepareSparkSend = useCallback(
    async (walletId: string, request: SparkSendRequest) => {
      return requireSparkManager().prepareSend(walletId, request)
    },
    []
  )

  const confirmSparkSend = useCallback(
    async (walletId: string, quoteId: string) => {
      const manager = requireSparkManager()
      const result = await manager.confirmSend(walletId, quoteId)
      if (result.status === "sent") {
        await refreshSparkBalance(walletId, manager, setRuntime).catch(
          () => undefined
        )
      }
      return result
    },
    []
  )

  const discardSparkSendQuote = useCallback(
    (walletId: string, quoteId: string) => {
      getSparkWalletManager()?.discardSendQuote(walletId, quoteId)
    },
    []
  )

  const hasUnresolvedSparkSend = useCallback((walletId: string) => {
    return requireSparkManager().hasUnresolvedSend(walletId)
  }, [])

  const acknowledgeUnresolvedSparkSend = useCallback((walletId: string) => {
    requireSparkManager().acknowledgeUnresolvedSend(walletId)
  }, [])

  const refreshBalance = useCallback(
    async (walletId: string) => {
      const wallet = wallets.find((candidate) => candidate.id === walletId)
      if (!wallet) {
        throw new Error("Wallet not found.")
      }
      if (wallet.providerId === "spark") {
        const manager = requireSparkManager()
        await refreshSparkBalance(walletId, manager, setRuntime)
        return
      }
      if (wallet.providerId === "nwc") {
        await getBuyerNwcSession(walletId).refreshBalance()
      }
    },
    [wallets]
  )

  const setDefaultPaymentWallet = useCallback(
    async (walletId: string) => {
      await registry.setDefault(walletId, "pay_invoice")
      await refreshAfterCommittedWalletMutation()
    },
    [refreshAfterCommittedWalletMutation, registry]
  )

  const removeWallet = useCallback(
    async (walletId: string, options: { recoveryConfirmed?: boolean } = {}) => {
      const requestedWallet = (await registry.list()).find(
        (candidate) => candidate.id === walletId
      )
      if (!requestedWallet) {
        return
      }

      const removeCurrentRegistration = async (
        mode: SparkWalletRemovalMode = "coordinated"
      ): Promise<boolean> => {
        const wallet = (await registry.list()).find(
          (candidate) => candidate.id === walletId
        )
        if (
          !wallet ||
          wallet.providerId !== requestedWallet.providerId ||
          wallet.createdAt !== requestedWallet.createdAt
        ) {
          if (!wallet && requestedWallet.providerId === "spark") {
            if (mode === "local-only") {
              await assertLocalSparkWalletRemovalSafe({
                managerInitialized: isSparkWalletManagerInitialized(),
              })
            } else {
              await cleanupSparkWalletState({
                walletId,
                manager: getSparkWalletManager(),
              })
            }
          }
          return false
        }
        if (wallet.kind === "portable" && !options.recoveryConfirmed) {
          throw new Error(
            "Confirm that recovery material is available before removing this Portable Wallet."
          )
        }
        if (wallet.providerId === "spark") {
          if (mode === "local-only") {
            await assertLocalSparkWalletRemovalSafe({
              managerInitialized: isSparkWalletManagerInitialized(),
            })
          } else {
            await cleanupSparkWalletState({
              walletId: wallet.id,
              manager: getSparkWalletManager(),
            })
          }
        } else if (wallet.providerId === "nwc") {
          closeBuyerNwcSession(wallet.id)
        }
        await store.transaction(async () => {
          await registry.remove(wallet.id)
          const remaining = (await store.listVisible(ownerRef.current)).filter(
            (candidate) =>
              candidate.network === wallet.network &&
              candidate.capabilities.includes("pay_invoice")
          )
          const replacement = getWalletDefaultReplacement(remaining, {
            network: wallet.network,
            intent: "pay_invoice",
          })
          if (replacement) {
            await registry.setDefault(replacement.id, "pay_invoice")
          }
        })
        return true
      }

      const removed =
        requestedWallet.providerId === "spark"
          ? await runSparkWalletRemoval({
              walletId,
              remove: removeCurrentRegistration,
            })
          : await removeCurrentRegistration()
      if (removed) {
        await refreshAfterCommittedWalletMutation()
      }
    },
    [refreshAfterCommittedWalletMutation, registry, store]
  )

  useEffect(() => {
    let active = true
    const signer = getAccountSigner()
    void (async () => {
      await reload(() => active)
      if (!active || !signer?.capabilities.nip44) return
      const wallet = walletsRef.current.find(
        (wallet) =>
          wallet.providerId === "spark" &&
          wallet.network === getSparkWalletNetwork() &&
          wallet.defaultIntents.includes("pay_invoice") &&
          !getSparkWalletManager()?.isOpen(wallet.id) &&
          !deliberatelyLockedWallets.get(signer)?.has(wallet.id)
      )
      if (!wallet) return
      const stored = await store.getSparkRecovery(wallet.id)
      if (!active || !isWalletSignerCurrent(signer)) return
      if (stored?.type === "signer" && stored.ownerPubkey === signer.pubkey) {
        try {
          await unlockSpark(wallet.id)
        } catch {
          /* The wallet error and Open action allow a deliberate retry. */
        }
      }
    })().catch(() => {
      /* The normal reload reports storage failures. */
    })
    return () => {
      active = false
    }
  }, [
    auth.accountPubkey,
    auth.authGeneration,
    auth.signerReadiness,
    reload,
    store,
    unlockSpark,
  ])

  const getSparkRecoveryType = useCallback(
    async (walletId: string) => {
      const recovery = await store.getSparkRecovery(walletId)
      return recovery?.type === "signer" && recovery.legacyRecovery
        ? ("signer-with-password-fallback" as const)
        : (recovery?.type ?? null)
    },
    [store]
  )
  const renameWallet = useCallback(
    async (walletId: string, label: string) => {
      const wallet = (await store.listVisible(ownerRef.current)).find(
        (w) => w.id === walletId
      )
      if (!wallet) throw new Error("Wallet is no longer available.")
      await store.put({ ...wallet, label: requireWalletLabel(label) })
      await refreshAfterCommittedWalletMutation()
    },
    [store, refreshAfterCommittedWalletMutation]
  )

  const portableWallets = useMemo(
    () => wallets.filter((wallet) => wallet.kind === "portable"),
    [wallets]
  )
  const connectedWallets = useMemo(
    () => wallets.filter((wallet) => wallet.kind === "connected"),
    [wallets]
  )

  return {
    wallets: loadedOwner === auth.accountPubkey ? wallets : [],
    portableWallets: loadedOwner === auth.accountPubkey ? portableWallets : [],
    connectedWallets:
      loadedOwner === auth.accountPubkey ? connectedWallets : [],
    runtime: loadedOwner === auth.accountPubkey ? runtime : {},
    nwcSnapshots,
    loading: loading || loadedOwner !== auth.accountPubkey,
    hasPasswordWallets,
    initializationError,
    sparkAvailability: getSparkConfiguration(),
    hasSparkRecovery,
    getSparkRecoveryType,
    renameWallet,
    connectNwc,
    createSpark,
    importSpark,
    unlockSpark,
    revealSparkRecovery,
    lockSpark,
    receiveSparkLightning,
    getSparkLightningAddress,
    getSparkAddress,
    listSparkPayments,
    prepareSparkSend,
    confirmSparkSend,
    hasUnresolvedSparkSend,
    acknowledgeUnresolvedSparkSend,
    discardSparkSendQuote,
    refreshBalance,
    setDefaultPaymentWallet,
    removeWallet,
    retryInitialization,
  }
}

function getNwcRuntimeState(snapshot: NwcSessionSnapshot): WalletRuntimeState {
  if (snapshot.status === "warming") {
    return { status: "connecting", balanceMsats: null, error: null }
  }
  if (snapshot.status === "unreachable" || snapshot.status === "unsupported") {
    return {
      status: "unavailable",
      balanceMsats: snapshot.balance.balanceMsats,
      error:
        snapshot.error ??
        (snapshot.status === "unsupported"
          ? "Connected Wallet cannot pay invoices."
          : "Connected Wallet is unreachable."),
    }
  }
  if (snapshot.status === "error") {
    return {
      status: "error",
      balanceMsats: snapshot.balance.balanceMsats,
      error: snapshot.error ?? "Connected Wallet error.",
    }
  }
  if (snapshot.status === "disconnected") {
    return {
      status: "unavailable",
      balanceMsats: null,
      error: "Connected Wallet is disconnected.",
    }
  }
  return {
    status: "ready",
    balanceMsats: snapshot.balance.balanceMsats,
    error: null,
  }
}

function getSparkWalletNetwork() {
  const configuration = getSparkConfiguration()
  if (configuration.status === "unavailable") {
    throw new Error(configuration.reason)
  }
  return configuration.network
}

function requireSparkManager() {
  const manager = getSparkWalletManager()
  if (!manager) {
    const configuration = getSparkConfiguration()
    throw new Error(
      configuration.status === "unavailable"
        ? configuration.reason
        : "Spark is unavailable."
    )
  }
  return manager
}

function requireWalletLabel(label: string): string {
  const normalized = label.trim()
  if (!normalized) {
    throw new Error("Enter a wallet label.")
  }
  return normalized
}

async function refreshSparkBalance(
  walletId: string,
  manager: NonNullable<ReturnType<typeof getSparkWalletManager>>,
  setRuntime: React.Dispatch<
    React.SetStateAction<Record<string, WalletRuntimeState>>
  >
): Promise<void> {
  try {
    const balanceSats = await manager.getBalance(walletId)
    setRuntime((current) => ({
      ...current,
      [walletId]: {
        status: "ready",
        balanceMsats: balanceSats * 1_000,
        error: null,
      },
    }))
  } catch (error) {
    setRuntime((current) => ({
      ...current,
      [walletId]: {
        status: "error",
        balanceMsats: null,
        error: getErrorMessage(error, "Could not refresh wallet balance."),
      },
    }))
    throw error
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

async function initializeWalletStorage(): Promise<void> {
  if (typeof window === "undefined") {
    return
  }
  await migrateLegacyNwcWallet({
    legacyStorage: window.localStorage,
    registry: getMarketWalletRegistry(),
    credentialStore: getMarketWalletStore(),
    fallbackNetwork: getWalletNetworkFromLightningConfig(
      config.lightningNetwork
    ),
  })
}
