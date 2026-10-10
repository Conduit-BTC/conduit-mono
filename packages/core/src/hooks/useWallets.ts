import { DexieSparkRecoveryStore } from "../wallets/spark-recovery-store"
import { recoveryReadiness } from "../wallets/spark-recovery-service"
import {
  getAccountSparkRecovery,
  runAccountWalletSetup,
  assertWalletCreationDiscovery,
  restoreAccountSparkWallets,
  backUpAccountSparkWallet,
} from "../wallets/account-spark-recovery"
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
} from "../wallets/buyer-nwc-session"
import {
  getDefaultSparkAccountNumber,
  getSparkConfiguration,
  getSparkWalletManager,
  isSparkWalletManagerInitialized,
} from "../wallets/spark-sdk"
import type {
  SparkPaymentSummary,
  SparkSendQuote,
  SparkSendRequest,
  SparkSendResult,
} from "../wallets/spark-wallet"
import {
  generateSparkMnemonic,
  isValidSparkAccountNumber,
  isValidSparkMnemonic,
  normalizeSparkMnemonic,
} from "../wallets/spark-recovery"
import {
  assertLocalSparkWalletRemovalSafe,
  cleanupSparkWalletState,
  openRegisteredSparkWallet,
  runSparkWalletRemoval,
  type SparkWalletRemovalMode,
} from "../wallets/spark-wallet-lifecycle"
import {
  getNwcWalletRegistrationDetails,
  type NwcWalletRegistration,
  migrateLegacyNwcWallet,
  reconcileNwcWalletRegistration,
} from "../wallets/wallet-migration"
import {
  getMarketWalletRegistry,
  getMarketWalletStore,
  getSparkRecoveryBinding,
  registerNwcWalletAtomically,
  registerSparkWalletAtomically,
  type StoredSparkWalletRecovery,
  serializeStoredSparkWalletRecovery,
} from "../wallets/wallet-storage"
import {
  assertWalletSignerCurrent,
  isWalletSignerCurrent,
  recoverStoredSparkMnemonic,
  requireWalletSigner,
  sealSignerSparkRecovery,
} from "../wallets/signer-spark-recovery"
import { rollbackFailedWalletSetup } from "../wallets/wallet-setup-rollback"
import {
  getRemovedWalletIdsForProvider,
  LatestWalletReloadCoordinator,
  reconcileWalletSynchronizationError,
  WALLET_STORAGE_INITIALIZATION_ERROR,
  WalletDescriptorSubscriptionCoordinator,
  WalletInitializationCoordinator,
} from "../wallets/wallet-initialization"
import {
  notifyWalletChangeFallback,
  subscribeToWalletChangeFallback,
} from "../wallets/wallet-change-fallback"

/**
 * Reuse a recent live NWC probe across sequential route mounts. Explicit
 * connects and payment attempts still perform their own live probes.
 */
const NWC_MOUNT_WARM_MAX_AGE_MS = 30_000
const deliberatelyLockedWallets = new WeakMap<AccountSigner, Set<string>>()
const automaticWalletOpens = new WeakMap<AccountSigner, Set<string>>()
const signerWalletOpens = new WeakMap<
  AccountSigner,
  Map<string, Promise<void>>
>()

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
  recoverySyncByWallet: Record<string, "ready" | "pending">
  mainWalletSync: "ready" | "pending" | null
  nwcSnapshots: Record<string, NwcSessionSnapshot>
  loading: boolean
  hasPasswordWallets: boolean
  initializationError: string | null
  recoverySync: "idle" | "checking" | "ready" | "pending" | "blocked"
  retryRecovery(): Promise<void>
  signerUnlockSupported: boolean
  sparkAvailability: ReturnType<typeof getSparkConfiguration>
  hasSparkRecovery(walletId: string): Promise<boolean>
  getSparkRecoveryType(
    walletId: string
  ): Promise<"password" | "signer" | "signer-with-password-fallback" | null>
  renameWallet(walletId: string, label: string): Promise<void>
  connectNwc(
    uri: string,
    label?: string,
    options?: {
      shouldContinue?: () => boolean
      onRegistered?: (registration: NwcWalletRegistration) => void
    }
  ): Promise<WalletDescriptor>
  createSpark(label?: string): Promise<{
    wallet: WalletDescriptor
    mnemonic: string
    accountNumber: number
    recovered?: boolean
    publicDefaultAllowed?: boolean
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
    register?: boolean,
    username?: string
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
  setReceivingWallet(walletId: string): Promise<void>
  setMainWallet(walletId: string): Promise<void>
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
  useLayoutEffect(() => {
    enabledRef.current = enabled
  }, [enabled])
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
  const [recoverySyncByWallet, setRecoverySyncByWallet] = useState<
    UseWalletsReturn["recoverySyncByWallet"]
  >({})
  const [mainWalletSync, setMainWalletSync] =
    useState<UseWalletsReturn["mainWalletSync"]>(null)
  const [nwcSnapshots, setNwcSnapshots] = useState<
    Record<string, NwcSessionSnapshot>
  >({})
  const [hasPasswordWallets, setHasPasswordWallets] = useState(false)
  const [recoverySync, setRecoverySync] =
    useState<UseWalletsReturn["recoverySync"]>("idle")
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
          const journal = ownerPubkey
            ? await new DexieSparkRecoveryStore().load(ownerPubkey)
            : null
          const signer = getAccountSigner()
          const configuration = getSparkConfiguration()
          const primaryEventId =
            signer?.pubkey === ownerPubkey && configuration.status === "ready"
              ? getAccountSparkRecovery(
                  signer
                ).getVerifiedPrimaryPointerEventId(configuration.network)
              : undefined
          const primary = journal?.records.find(
            (r) => r.event.id === primaryEventId
          )
          const sync: UseWalletsReturn["recoverySyncByWallet"] = {}
          const mainEventId =
            signer?.pubkey === ownerPubkey && configuration.status === "ready"
              ? getAccountSparkRecovery(signer).getVerifiedMainChoiceEventId(
                  configuration.network
                )
              : undefined
          const main = journal?.records.find(
            (record) => record.event.id === mainEventId
          )
          for (const wallet of nextWallets.filter(
            (w) => w.providerId === "spark"
          )) {
            const backup = journal?.records.find((r) =>
              r.event.tags.some(
                (t) =>
                  t[0] === "d" &&
                  t[1] === `conduit:spark:wallet:v1:${wallet.id}`
              )
            )
            sync[wallet.id] =
              backup &&
              primary &&
              recoveryReadiness(backup).ready &&
              recoveryReadiness(primary).ready
                ? "ready"
                : "pending"
          }
          return {
            nextWallets,
            openSparkRuntime,
            hasPasswordWallets,
            ownerPubkey,
            sync,
            mainSync: main
              ? recoveryReadiness(main).ready
                ? ("ready" as const)
                : ("pending" as const)
              : null,
          }
        },
        ({
          nextWallets,
          openSparkRuntime,
          hasPasswordWallets,
          ownerPubkey,
          sync,
          mainSync,
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
          setRecoverySyncByWallet(sync)
          setMainWalletSync(mainSync)
          const nextNwcWalletIds = nextWallets
            .filter((wallet) => wallet.providerId === "nwc")
            .map((wallet) => wallet.id)
          const nextNwcSnapshots = getBuyerNwcSessionSnapshots(nextNwcWalletIds)
          setNwcSnapshots(nextNwcSnapshots)
          setRuntime((current) => {
            const next = { ...current }
            for (const wallet of nextWallets) {
              if (wallet.providerId === "spark") {
                const signer = getAccountSigner()
                next[wallet.id] =
                  openSparkRuntime.get(wallet.id) ??
                  (signer && signerWalletOpens.get(signer)?.has(wallet.id)
                    ? { status: "connecting", balanceMsats: null, error: null }
                    : current[wallet.id]?.status === "error"
                      ? current[wallet.id]
                      : lockedRuntime())
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
  }, [enabled, auth.accountPubkey, retryInitialization])

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
    const runtimeUpdates = new Map<string, number>()
    const unsubscribe = manager.subscribe((walletId) => {
      if (!active) {
        return
      }
      const owner = ownerRef.current
      const revision = (runtimeUpdates.get(walletId) ?? 0) + 1
      runtimeUpdates.set(walletId, revision)
      void refreshSparkBalance(walletId, manager, (update) => {
        if (
          active &&
          runtimeUpdates.get(walletId) === revision &&
          ownerRef.current === owner &&
          walletsRef.current.some((wallet) => wallet.id === walletId)
        )
          setRuntime(update)
      }).catch(() => undefined)
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
    const owner = ownerRef.current
    const signer = getAccountSigner()
    const current = () =>
      active && ownerRef.current === owner && getAccountSigner() === signer

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
            ownerPubkey: owner,
            info: snapshot.info,
            store,
            shouldContinue: current,
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
    async (
      uri: string,
      label?: string,
      options?: {
        shouldContinue?: () => boolean
        onRegistered?: (registration: NwcWalletRegistration) => void
      }
    ) => {
      const signer = getAccountSigner()
      const shouldContinue = () =>
        getAccountSigner() === signer && options?.shouldContinue?.() !== false
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
        const result = await registerNwcWalletAtomically({
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
          shouldContinue,
        })
        options?.onRegistered?.(result)
        const connectedWallet = result.wallet
        if (!shouldContinue()) throw new Error("Wallet sign-in changed.")
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
      walletId?: string
      restored?: boolean
    }) => {
      const manager = requireSparkManager()
      const network = getSparkWalletNetwork()
      const walletId = input.walletId ?? crypto.randomUUID()
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
        if (!input.restored) await ensureDefault(wallet)
      } catch (error) {
        if (input.restored || wallet.id !== walletId) throw error
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
      // Recover receiving behavior first. Registration waits for the name choice;
      // address failure cannot roll back a usable wallet.
      try {
        await manager.getLightningAddress(wallet.id)
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

  const synchronizeRecovery = useCallback(
    async (signer: AccountSigner, publishExisting = false) => {
      assertWalletSignerCurrent(signer)
      setRecoverySync("checking")
      const service = getAccountSparkRecovery(signer)
      const network = getSparkWalletNetwork()
      const discovery = await service.discover(false, network)
      const restored = await restoreAccountSparkWallets(
        signer,
        discovery,
        network
      )
      assertWalletSignerCurrent(signer)
      const visible = await store.listVisible(signer.pubkey)
      const selected =
        discovery.main ??
        (!visible.some((w) => w.defaultIntents.includes("pay_invoice"))
          ? discovery.primary
          : undefined)
      if (
        selected?.walletId &&
        discovery.state === "recoverable" &&
        !discovery.invalidCount &&
        visible.some(
          (w) =>
            w.id === selected.walletId && w.network === getSparkWalletNetwork()
        )
      ) {
        await registry.setDefault(selected.walletId, "pay_invoice")
        assertWalletSignerCurrent(signer)
        if (discovery.main)
          await registry.setDefault(selected.walletId, "receive")
        assertWalletSignerCurrent(signer)
      }
      await refreshAfterCommittedWalletMutation()
      let pending = false
      const journal = await new DexieSparkRecoveryStore().load(signer.pubkey)
      const primaryRecord = journal.records.find(
        (record) => record.event.id === discovery.primaryPointerEventId
      )
      for (const wallet of await store.listVisible(signer.pubkey)) {
        if (wallet.providerId !== "spark" || wallet.network !== network)
          continue
        const credential = await store.getSparkRecovery(wallet.id)
        if (credential?.type !== "signer") {
          pending ||= credential?.type === "password"
          continue
        }
        const known = discovery.candidates.some(
          (candidate) => candidate.walletId === wallet.id
        )
        if (!publishExisting) {
          const record = journal.records.find((record) =>
            record.event.tags.some(
              (tag) =>
                tag[0] === "d" &&
                tag[1] === `conduit:spark:wallet:v1:${wallet.id}`
            )
          )
          pending ||=
            !known ||
            !record ||
            !recoveryReadiness(record).ready ||
            !primaryRecord ||
            !recoveryReadiness(primaryRecord).ready
          continue
        }
        if (!known && discovery.coverage !== "complete") {
          pending = true
          continue
        }
        const recovered = await recoverStoredSparkMnemonic(
          credential,
          getSparkRecoveryBinding(wallet, credential)
        )
        const ready = await backUpAccountSparkWallet(signer, wallet.id, {
          mnemonic: recovered.mnemonic,
          network: wallet.network,
          accountNumber: credential.accountNumber,
        })
        pending ||= !ready
      }
      const mainEventId = service.getVerifiedMainChoiceEventId(
        getSparkWalletNetwork()
      )
      const mainRecord = journal.records.find(
        (record) => record.event.id === mainEventId
      )
      if (mainRecord && publishExisting)
        await service.deliver(mainRecord.event.id)
      assertWalletSignerCurrent(signer)
      await refreshAfterCommittedWalletMutation()
      setRecoverySync(
        discovery.state === "conflict" ||
          discovery.state === "unresolved" ||
          discovery.candidates.some(
            (candidate) => candidate.source === "addy" && !candidate.resolved
          ) ||
          discovery.invalidCount ||
          discovery.unresolvedObserved
          ? "blocked"
          : pending || discovery.coverage !== "complete"
            ? "pending"
            : "ready"
      )
      return { discovery, restored }
    },
    [store, registry, refreshAfterCommittedWalletMutation]
  )

  // This explicit action authorizes encrypted relay backup of existing wallets.
  const retryRecovery = useCallback(async () => {
    const signer = requireWalletSigner()
    try {
      await runAccountWalletSetup(signer, () =>
        synchronizeRecovery(signer, true)
      )
    } catch (error) {
      if (isWalletSignerCurrent(signer)) setRecoverySync("blocked")
      throw error
    }
  }, [synchronizeRecovery])

  const createSpark = useCallback(
    async (label = "") => {
      requireSparkManager()
      const signer = requireWalletSigner()
      return runAccountWalletSetup(signer, async () => {
        const { discovery, restored } = await synchronizeRecovery(signer)
        if (restored.length) {
          const bundle = restored[0]
          const wallet = await setupSparkWallet({
            ...bundle,
            label,
            restored: true,
          })
          return {
            wallet,
            mnemonic: bundle.mnemonic,
            accountNumber: bundle.accountNumber,
            recovered: true,
          }
        }
        assertWalletCreationDiscovery(discovery)
        const network = getSparkWalletNetwork()
        const accountNumber = getDefaultSparkAccountNumber(network)
        const mnemonic = generateSparkMnemonic()
        const wallet = await setupSparkWallet({
          label,
          mnemonic,
          accountNumber,
        })
        try {
          const ready = await backUpAccountSparkWallet(
            signer,
            wallet.id,
            { mnemonic, network, accountNumber },
            {
              rootBackupEventId:
                discovery.lineageRootEventId ?? discovery.primary?.eventId,
            }
          )
          if (isWalletSignerCurrent(signer))
            setRecoverySync(ready ? "ready" : "pending")
        } catch {
          assertWalletSignerCurrent(signer)
          setRecoverySync("pending")
        }
        await refreshAfterCommittedWalletMutation()
        let publicDefaultAllowed = false
        try {
          const afterSetup = await getAccountSparkRecovery(signer).discover(
            false,
            network
          )
          publicDefaultAllowed =
            afterSetup.coverage === "complete" &&
            afterSetup.state !== "conflict" &&
            !afterSetup.invalidCount &&
            !afterSetup.unresolvedObserved
          if (!publicDefaultAllowed) setRecoverySync("blocked")
        } catch {
          assertWalletSignerCurrent(signer)
          setRecoverySync("pending")
        }
        return { wallet, mnemonic, accountNumber, publicDefaultAllowed }
      })
    },
    [setupSparkWallet, synchronizeRecovery, refreshAfterCommittedWalletMutation]
  )

  const importSpark = useCallback(
    async (input: {
      label: string
      mnemonic: string
      accountNumber: number
    }) => {
      if (
        !isValidSparkMnemonic(input.mnemonic) ||
        !isValidSparkAccountNumber(input.accountNumber)
      )
        throw new Error("Check the recovery phrase and account number.")
      requireSparkManager()
      const signer = requireWalletSigner()
      return runAccountWalletSetup(signer, async () => {
        const { discovery } = await synchronizeRecovery(signer)
        const network = getSparkWalletNetwork()
        const resolvedAddyEventIds: string[] = []
        for (const candidate of discovery.candidates) {
          if (candidate.source !== "addy" || candidate.resolved) continue
          const bundle = await getAccountSparkRecovery(signer).restore(
            candidate,
            {
              network,
              accountNumber: input.accountNumber,
            }
          )
          if (bundle.mnemonic === normalizeSparkMnemonic(input.mnemonic))
            resolvedAddyEventIds.push(candidate.eventId)
        }
        assertWalletCreationDiscovery(discovery, resolvedAddyEventIds)
        let walletId: string | undefined
        for (const candidate of discovery.candidates) {
          if (candidate.source !== "conduit_v1") continue
          const bundle =
            await getAccountSparkRecovery(signer).restore(candidate)
          if (
            "walletId" in bundle &&
            bundle.network === network &&
            bundle.accountNumber === input.accountNumber &&
            bundle.mnemonic === normalizeSparkMnemonic(input.mnemonic)
          )
            walletId = bundle.walletId
        }
        const wallet = await setupSparkWallet({
          ...input,
          mnemonic: normalizeSparkMnemonic(input.mnemonic),
          walletId,
          restored: !!walletId,
        })
        assertWalletSignerCurrent(signer)
        await new DexieSparkRecoveryStore().setDeviceRemoved(
          signer.pubkey,
          wallet.id,
          false
        )
        try {
          const ready = await backUpAccountSparkWallet(
            signer,
            wallet.id,
            {
              mnemonic: normalizeSparkMnemonic(input.mnemonic),
              network,
              accountNumber: input.accountNumber,
            },
            {
              rootBackupEventId:
                discovery.lineageRootEventId ?? discovery.primary?.eventId,
            }
          )
          if (isWalletSignerCurrent(signer))
            setRecoverySync(ready ? "ready" : "pending")
        } catch {
          assertWalletSignerCurrent(signer)
          setRecoverySync("pending")
        }
        await refreshAfterCommittedWalletMutation()
        return wallet
      })
    },
    [setupSparkWallet, synchronizeRecovery, refreshAfterCommittedWalletMutation]
  )

  useEffect(() => {
    setRecoverySync("idle")
    const signer = getAccountSigner()
    if (
      !enabled ||
      auth.signerReadiness !== "ready" ||
      !signer?.capabilities.nip44 ||
      getSparkConfiguration().status !== "ready"
    )
      return
    // Sign-in discovers and restores; it never publishes device-only secrets.
    void runAccountWalletSetup(signer, () => synchronizeRecovery(signer)).catch(
      () => {
        if (isWalletSignerCurrent(signer)) setRecoverySync("blocked")
      }
    )
  }, [
    enabled,
    auth.accountPubkey,
    auth.authGeneration,
    auth.signerReadiness,
    synchronizeRecovery,
  ])

  const unlockSpark = useCallback(
    async (
      walletId: string,
      password = "",
      migrate = false,
      options: { priority?: "foreground" | "background" } = {}
    ) => {
      const manager = requireSparkManager()
      const signer = !password && !migrate ? getAccountSigner() : undefined
      const previous = signer && signerWalletOpens.get(signer)?.get(walletId)
      if (signer && previous) {
        try {
          await previous
          assertWalletSignerCurrent(signer)
          await refreshSparkBalance(walletId, manager, setRuntime)
        } catch (error) {
          if (isWalletSignerCurrent(signer))
            setRuntime((current) => ({
              ...current,
              [walletId]: {
                status: "error",
                balanceMsats: null,
                error: getErrorMessage(
                  error,
                  "Could not unlock Portable Wallet."
                ),
              },
            }))
          throw error
        }
        return
      }
      if (signer && manager.isOpen(walletId)) {
        const stored = await store.getSparkRecovery(walletId)
        assertWalletSignerCurrent(signer)
        if (stored?.type === "signer" && stored.ownerPubkey === signer.pubkey) {
          await refreshSparkBalance(walletId, manager, setRuntime)
          return
        }
      }
      const open = async () => {
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
                password,
                { priority: options.priority ?? "foreground" }
              )
              const mnemonic = recovered.mnemonic
              const signer =
                recovered.signer ??
                (migrate ? requireWalletSigner() : undefined)
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
          if (migrate) {
            setRecoverySync("pending")
            await refreshAfterCommittedWalletMutation()
          }
          if (signer && isWalletSignerCurrent(signer))
            deliberatelyLockedWallets.get(signer)?.delete(walletId)
        } catch (error) {
          if (!signer || isWalletSignerCurrent(signer))
            setRuntime((current) => ({
              ...current,
              [walletId]: {
                status: "error",
                balanceMsats: null,
                error: getErrorMessage(
                  error,
                  "Could not unlock Portable Wallet."
                ),
              },
            }))
          throw error
        }
      }
      const attempt = open()
      if (!signer) return attempt
      const openings =
        signerWalletOpens.get(signer) ?? new Map<string, Promise<void>>()
      openings.set(walletId, attempt)
      signerWalletOpens.set(signer, openings)
      try {
        await attempt
      } finally {
        if (openings.get(walletId) === attempt) openings.delete(walletId)
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
    async (walletId: string, register = false, username?: string) => {
      return requireSparkManager().getLightningAddress(
        walletId,
        register,
        username
      )
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
      const requestedWallet = (await store.listVisible(ownerRef.current)).find(
        (candidate) => candidate.id === walletId
      )
      if (!requestedWallet) {
        return
      }

      const recovery =
        requestedWallet.providerId === "spark"
          ? await store.getSparkRecovery(walletId)
          : null
      const signer = recovery?.type === "signer" ? requireWalletSigner() : null
      if (
        signer &&
        recovery?.type === "signer" &&
        signer.pubkey !== recovery.ownerPubkey
      )
        throw new Error("Wallet sign-in changed.")

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
          if (signer) {
            assertWalletSignerCurrent(signer)
            await new DexieSparkRecoveryStore().setDeviceRemoved(
              signer.pubkey,
              wallet.id,
              true
            )
          }
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
          if (signer) assertWalletSignerCurrent(signer)
        })
        return true
      }

      const remove = () =>
        requestedWallet.providerId === "spark"
          ? runSparkWalletRemoval({
              walletId,
              remove: removeCurrentRegistration,
            })
          : removeCurrentRegistration()
      const removed = signer
        ? await runAccountWalletSetup(signer, remove)
        : await remove()
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
      if (
        !active ||
        !enabled ||
        !getSparkWalletManager() ||
        !signer?.capabilities.nip44 ||
        auth.signerReadiness !== "ready"
      )
        return
      const candidates = walletsRef.current.filter(
        (wallet) =>
          wallet.providerId === "spark" &&
          wallet.network === getSparkWalletNetwork() &&
          !getSparkWalletManager()?.isOpen(wallet.id) &&
          !deliberatelyLockedWallets.get(signer)?.has(wallet.id)
      )
      for (const wallet of candidates) {
        if (!active || !isWalletSignerCurrent(signer)) return
        const stored = await store.getSparkRecovery(wallet.id)
        if (!active || !isWalletSignerCurrent(signer)) return
        if (stored?.type === "signer" && stored.ownerPubkey === signer.pubkey) {
          const attempted =
            automaticWalletOpens.get(signer) ?? new Set<string>()
          if (
            attempted.has(wallet.id) &&
            !signerWalletOpens.get(signer)?.has(wallet.id)
          )
            continue
          attempted.add(wallet.id)
          automaticWalletOpens.set(signer, attempted)
          void unlockSpark(wallet.id, "", false, {
            priority: "background",
          }).catch(() => {
            /* The wallet error and Open action allow a deliberate retry. */
          })
        }
      }
    })().catch(() => {
      /* The normal reload reports storage failures. */
    })
    return () => {
      active = false
    }
  }, [
    enabled,
    auth.accountPubkey,
    auth.authGeneration,
    auth.signerReadiness,
    wallets,
    store,
    unlockSpark,
  ])

  const setReceivingWallet = useCallback(
    async (walletId: string) => {
      const owner = ownerRef.current
      if (
        !owner ||
        !(await store.listVisible(owner)).some(
          (wallet) =>
            wallet.id === walletId && wallet.capabilities.includes("receive")
        )
      )
        throw new Error("Choose an available receiving wallet.")
      if (ownerRef.current !== owner)
        throw new Error("Your Nostr sign-in changed.")
      await registry.setDefault(walletId, "receive")
      await refreshAfterCommittedWalletMutation()
    },
    [registry, store, refreshAfterCommittedWalletMutation]
  )

  const setMainWallet = useCallback(
    async (walletId: string) => {
      const signer = requireWalletSigner()
      await runAccountWalletSetup(signer, async () => {
        const service = getAccountSparkRecovery(signer)
        const discovery = await service.discover(false, getSparkWalletNetwork())
        if (
          discovery.state === "conflict" ||
          discovery.invalidCount ||
          discovery.unresolvedObserved
        )
          throw new Error(
            "Resolve wallet recovery before changing your main wallet."
          )
        const candidate = discovery.candidates.find(
          (c) => c.walletId === walletId
        )
        const wallet = (await store.listVisible(signer.pubkey)).find(
          (w) => w.id === walletId
        )
        if (
          !candidate ||
          !wallet ||
          wallet.providerId !== "spark" ||
          wallet.network !== getSparkWalletNetwork()
        )
          throw new Error(
            "Sync this wallet's recovery before making it your main wallet."
          )
        // Sign outside storage, then activate the relay choice and both local
        // intents together. Failed writes leave nothing for recovery to retry.
        const eventId = await service.prepareMain(candidate, (retain) =>
          store.transaction(async () => {
            assertWalletSignerCurrent(signer)
            await registry.setDefault(walletId, "pay_invoice")
            assertWalletSignerCurrent(signer)
            await registry.setDefault(walletId, "receive")
            assertWalletSignerCurrent(signer)
            await retain()
            assertWalletSignerCurrent(signer)
          })
        )
        assertWalletSignerCurrent(signer)
        const result = await service.deliver(eventId)
        assertWalletSignerCurrent(signer)
        setMainWalletSync(result.ready ? "ready" : "pending")
        await refreshAfterCommittedWalletMutation()
      })
    },
    [registry, store, refreshAfterCommittedWalletMutation]
  )

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
      await store.rename(walletId, requireWalletLabel(label))
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
    recoverySync,
    recoverySyncByWallet,
    mainWalletSync,
    retryRecovery,
    signerUnlockSupported: getAccountSigner()?.capabilities.nip44 === true,
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
    setReceivingWallet,
    setMainWallet,
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
  const locked = () =>
    setRuntime((current) => ({
      ...current,
      [walletId]: { status: "locked", balanceMsats: null, error: null },
    }))
  if (!manager.isOpen(walletId)) {
    locked()
    return
  }
  try {
    const balanceSats = await manager.getBalance(walletId)
    if (!manager.isOpen(walletId)) {
      locked()
      return
    }
    setRuntime((current) => ({
      ...current,
      [walletId]: {
        status: "ready",
        balanceMsats: balanceSats * 1_000,
        error: null,
      },
    }))
  } catch (error) {
    if (!manager.isOpen(walletId)) {
      locked()
      return
    }
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
