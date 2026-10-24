import { resolveSparkLightningAddress } from "../wallets/resolve-spark-lightning-address"
import { getAccountStorageRelays } from "../protocol/account-storage-relay-policy"
import {
  lockedWalletRuntime as lockedRuntime,
  reconcileSparkWalletRuntime,
  type WalletRuntimeState,
} from "../wallets/wallet-runtime"
import { closeUnusedSparkWallets } from "../wallets/checkout-spark-router-wallet-retention"
import { accountAddressRequests } from "../wallets/account-address-request"
import type { AddressRequestWorkflow } from "../wallets/address-request-workflow"
import type { ConduitAppId } from "../protocol/nip89"
import type { AccountSignerOperationOptions } from "../protocol/nostr-event-signer"
import { SessionSignerError } from "../protocol/session-signer"
import {
  getPortableWalletSync,
  runAccountWalletSetup,
  listAutomaticSignerSparkWallets,
  DexiePortableWalletStore,
} from "../wallets/portable-wallet-sync"
import {
  notifySparkRecoveryReady,
  type SparkRecoveryReady,
} from "../wallets/spark-recovery-ready"
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
} from "../wallets/wallet-storage"
import {
  assertWalletSignerCurrent,
  isWalletSignerCurrent,
  recoverStoredSparkMnemonic,
  requireWalletSigner,
} from "../wallets/signer-spark-recovery"
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

export type { WalletRuntimeState } from "../wallets/wallet-runtime"

export type WalletSetupPhase =
  "checking" | "creating" | "opening" | "encrypting" | "syncing" | "address"

export type { SparkRecoveryReady } from "../wallets/spark-recovery-ready"

export interface SparkRecoveryReadyOptions {
  onRecoveryReady?(recovery: SparkRecoveryReady): void
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
  initializationError: string | null
  recoverySync: "idle" | "checking" | "ready" | "pending" | "blocked"
  recoverySyncReason?: "signer" | "storage"
  retryRecovery(): Promise<void>
  signerUnlockSupported: boolean
  sparkAvailability: ReturnType<typeof getSparkConfiguration>
  hasSparkRecovery(walletId: string): Promise<boolean>
  getSparkRecoveryType(walletId: string): Promise<"signer" | null>
  renameWallet(walletId: string, label: string): Promise<void>
  connectNwc(
    uri: string,
    label?: string,
    options?: {
      shouldContinue?: () => boolean
      onRegistered?: (registration: NwcWalletRegistration) => void
    }
  ): Promise<WalletDescriptor>
  completeSparkCreation(walletId: string): Promise<void>
  createSpark(
    label?: string,
    options?: SparkRecoveryReadyOptions & {
      onProgress?(phase: WalletSetupPhase): void
    }
  ): Promise<{
    wallet: WalletDescriptor
    mnemonic: string
    accountNumber: number
    recovered?: boolean
    publicDefaultAllowed?: boolean
  }>
  importSpark(
    input: {
      label: string
      mnemonic: string
      accountNumber: number
    },
    options?: SparkRecoveryReadyOptions
  ): Promise<WalletDescriptor>
  unlockSpark(
    walletId: string,
    options?: AccountSignerOperationOptions
  ): Promise<void>
  revealSparkRecovery(
    walletId: string
  ): Promise<{ mnemonic: string; accountNumber: number }>
  lockSpark(walletId: string): Promise<void>
  getSparkLightningAddress(
    walletId: string,
    register?: boolean,
    username?: string,
    domain?: "breez.tips" | "conduit.cash",
    options?: AccountSignerOperationOptions
  ): Promise<import("@conduit/core").BreezAddressState>
  requestAddressName?: AddressRequestWorkflow
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

const walletInitialization = new WalletInitializationCoordinator()

export function useWallets(
  options: { enabled?: boolean; appId?: ConduitAppId } = {}
): UseWalletsReturn {
  const auth = useAuth()
  const ownerRef = useRef(auth.accountPubkey)
  useLayoutEffect(() => {
    ownerRef.current = auth.accountPubkey
  }, [auth.accountPubkey])
  const appId = options.appId ?? "market"
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
  const [recoverySync, setRecoverySync] =
    useState<UseWalletsReturn["recoverySync"]>("idle")
  const [recoverySyncReason, setRecoverySyncReason] = useState<
    "signer" | "storage"
  >()
  const [recoverySyncAttempt, setRecoverySyncAttempt] = useState<{
    signer: AccountSigner
    authGeneration: typeof auth.authGeneration
  } | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [initializationError, setInitializationError] = useState<string | null>(
    null
  )
  const [walletSubscriptionEpoch, setWalletSubscriptionEpoch] = useState(0)
  const initializationAttemptRef = useRef(0)
  const balanceRefreshes = useRef(new Map<string, Promise<void>>())

  const reload = useCallback(
    async (shouldApply: () => boolean = () => true) => {
      await reloadCoordinator.run(
        async (isCurrent) => {
          const ownerPubkey = ownerRef.current
          const nextWallets = await store.listVisible(ownerPubkey)
          const sparkManager = getSparkWalletManager()
          const openSparkRuntime = new Map<
            string,
            { state: WalletRuntimeState; isCurrent: () => boolean }
          >()

          if (sparkManager) {
            // A superseded list can predate a newly registered/open wallet.
            // Never let that old snapshot close the newer native session.
            const canCloseUnusedWallets = () =>
              isCurrent() &&
              enabledRef.current &&
              shouldApply() &&
              ownerRef.current === ownerPubkey
            if (canCloseUnusedWallets())
              await closeUnusedSparkWallets(
                sparkManager,
                nextWallets
                  .filter((wallet) => wallet.providerId === "spark")
                  .map((wallet) => wallet.id),
                { shouldContinue: canCloseUnusedWallets }
              )
            await Promise.all(
              nextWallets.map(async (wallet) => {
                if (
                  wallet.providerId !== "spark" ||
                  !sparkManager.isOpen(wallet.id)
                ) {
                  return
                }
                const isCurrent = sparkManager.captureSession(wallet.id)
                try {
                  const balanceSats = await sparkManager.getBalance(wallet.id)
                  openSparkRuntime.set(wallet.id, {
                    isCurrent,
                    state: {
                      status: "ready",
                      balanceMsats: balanceSats * 1_000,
                      error: null,
                    },
                  })
                } catch (error) {
                  openSparkRuntime.set(wallet.id, {
                    isCurrent,
                    state: {
                      status: "error",
                      errorSource: "balance",
                      balanceMsats: null,
                      error: getErrorMessage(
                        error,
                        "Could not refresh wallet balance."
                      ),
                    },
                  })
                }
              })
            )
          }

          const account = ownerPubkey
            ? await new DexiePortableWalletStore().load(ownerPubkey)
            : null
          const sync: UseWalletsReturn["recoverySyncByWallet"] = {}
          for (const wallet of nextWallets.filter(
            (w) => w.providerId === "spark"
          )) {
            sync[wallet.id] = getAccountStorageRelays().every((target) =>
              account?.wallets[wallet.id]?.observed.includes(target.url)
            )
              ? "ready"
              : "pending"
          }
          return {
            nextWallets,
            openSparkRuntime,
            ownerPubkey,
            sync,
          }
        },
        ({ nextWallets, openSparkRuntime, ownerPubkey, sync }) => {
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
          setRecoverySyncByWallet(sync)
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
                // Recovery metadata reads can outlive a manager open/close.
                // Apply the snapshot only while its wallet is still open, and
                // retain a newer open state when the snapshot predates it.
                const snapshot = openSparkRuntime.get(wallet.id)
                next[wallet.id] = reconcileSparkWalletRuntime({
                  nativeOpen:
                    getSparkWalletManager()?.isOpen(wallet.id) ?? false,
                  opening:
                    !!signer && !!signerWalletOpens.get(signer)?.has(wallet.id),
                  sampled: snapshot?.isCurrent() ? snapshot.state : undefined,
                  current: current[wallet.id],
                })
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
    const generation = auth.authGeneration
    const current = () =>
      active &&
      enabledRef.current &&
      ownerRef.current === owner &&
      getAccountSigner() === signer &&
      auth.isAuthGenerationCurrent(generation)

    for (const wallet of wallets) {
      if (wallet.providerId !== "nwc") {
        continue
      }
      const session = getBuyerNwcSession(wallet.id)
      const unsubscribe = session.subscribe((snapshot) => {
        if (current()) {
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
          if (!current() || !uri) {
            return
          }
          session.setConnection(parseNwcUri(uri))
          const snapshot = await session.ensureWarm(NWC_MOUNT_WARM_MAX_AGE_MS)
          if (!current() || !snapshot.info) {
            return
          }
          const changed = await reconcileNwcWalletRegistration({
            walletId: wallet.id,
            ownerPubkey: owner,
            info: snapshot.info,
            store,
            shouldContinue: current,
          })
          if (current()) await session.refreshBalance()
          if (changed && current()) {
            await refreshAfterCommittedWalletMutation()
          }
        })
        .catch(() => {
          if (current()) {
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
  }, [
    enabled,
    refreshAfterCommittedWalletMutation,
    store,
    wallets,
    auth.authGeneration,
    auth.isAuthGenerationCurrent,
  ])

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

  const synchronizeRecovery = useCallback(
    async (
      signer: AccountSigner,
      options: AccountSignerOperationOptions = { priority: "background" }
    ) => {
      const service = getPortableWalletSync(signer)
      await service.sync(options)
      assertWalletSignerCurrent(signer)
      setRecoverySync(service.snapshot.status)
      setRecoverySyncReason(service.snapshot.blockedReason)
      await refreshAfterCommittedWalletMutation()
    },
    [refreshAfterCommittedWalletMutation]
  )

  const retryRecovery = useCallback(async () => {
    const signer = requireWalletSigner()
    await synchronizeRecovery(signer, { priority: "foreground" })
  }, [synchronizeRecovery])

  const importSpark = useCallback(
    async (
      input: { label: string; mnemonic: string; accountNumber: number },
      options?: SparkRecoveryReadyOptions
    ) => {
      if (
        !isValidSparkMnemonic(input.mnemonic) ||
        !isValidSparkAccountNumber(input.accountNumber)
      )
        throw new Error("Check the recovery phrase and account number.")
      const signer = requireWalletSigner()
      const manager = requireSparkManager()
      return runAccountWalletSetup(signer, async () => {
        const service = getPortableWalletSync(signer)
        const record = await service.import(
          {
            mnemonic: normalizeSparkMnemonic(input.mnemonic),
            accountNumber: input.accountNumber,
            network: getSparkWalletNetwork(),
          },
          input.label,
          { priority: "foreground" }
        )
        await manager.openWithMnemonic({
          walletId: record.walletId,
          mnemonic: record.mnemonic,
          accountNumber: record.accountNumber,
          shouldContinue: () => isWalletSignerCurrent(signer),
          subscribeRevocation: (listener) =>
            subscribeToAccountSignerChanges(() => {
              if (!isWalletSignerCurrent(signer)) listener()
            }),
        })
        assertWalletSignerCurrent(signer)
        const wallet = (await store.listVisible(signer.pubkey)).find(
          (w) => w.id === record.walletId
        )!
        await refreshSparkBalance(wallet.id, manager, setRuntime)
        await notifySparkRecoveryReady({
          wallet,
          mnemonic: record.mnemonic,
          accountNumber: record.accountNumber,
          recovered: true,
          ownerPubkey: signer.pubkey,
          getStoredRecovery: (id) => store.getSparkRecovery(id),
          isNativeOpen: (id) => manager.isOpen(id),
          assertAuthority: () => assertWalletSignerCurrent(signer),
          onRecoveryReady: options?.onRecoveryReady,
        })
        // Only the native provider can establish the receiving address. A cached record is not payment authorization.
        try {
          const address = await manager.getLightningAddress(wallet.id)
          if (address.status === "registered")
            await service.update(
              wallet.id,
              { lightningAddress: address.address },
              { priority: "foreground" }
            )
        } catch {
          assertWalletSignerCurrent(signer)
        }
        await refreshAfterCommittedWalletMutation()
        void synchronizeRecovery(signer).catch(() => {
          if (isWalletSignerCurrent(signer)) setRecoverySync("blocked")
        })
        return wallet
      })
    },
    [store, refreshAfterCommittedWalletMutation, synchronizeRecovery]
  )

  const createSpark = useCallback(
    async (
      label = "",
      options?: SparkRecoveryReadyOptions & {
        onProgress?(phase: WalletSetupPhase): void
      }
    ) => {
      const signer = requireWalletSigner()
      return runAccountWalletSetup(signer, async () => {
        const service = getPortableWalletSync(signer)
        const account = await new DexiePortableWalletStore().load(signer.pubkey)
        const pending = []
        for (const id of Object.keys(account.wallets)) {
          const record = await service.get(id, { priority: "foreground" })
          if (
            record.setupPending &&
            record.lifecycle === "active" &&
            record.network === getSparkWalletNetwork()
          )
            pending.push(record)
        }
        if (pending.length > 1)
          throw new Error(
            "Finish saving your existing wallet recovery details first."
          )
        options?.onProgress?.("creating")
        const accountNumber =
          pending[0]?.accountNumber ??
          getDefaultSparkAccountNumber(getSparkWalletNetwork())
        const mnemonic = pending[0]?.mnemonic ?? generateSparkMnemonic()
        const record =
          pending[0] ??
          (await service.import(
            { mnemonic, accountNumber, network: getSparkWalletNetwork() },
            label,
            { priority: "foreground" },
            true
          ))
        const manager = requireSparkManager()
        options?.onProgress?.("opening")
        await manager.openWithMnemonic({
          walletId: record.walletId,
          mnemonic,
          accountNumber,
          shouldContinue: () => isWalletSignerCurrent(signer),
          subscribeRevocation: (listener) =>
            subscribeToAccountSignerChanges(() => {
              if (!isWalletSignerCurrent(signer)) listener()
            }),
        })
        assertWalletSignerCurrent(signer)
        const wallet = (await store.listVisible(signer.pubkey)).find(
          (w) => w.id === record.walletId
        )!
        await notifySparkRecoveryReady({
          wallet,
          mnemonic,
          accountNumber,
          recovered: false,
          ownerPubkey: signer.pubkey,
          getStoredRecovery: (id) => store.getSparkRecovery(id),
          isNativeOpen: (id) => manager.isOpen(id),
          assertAuthority: () => assertWalletSignerCurrent(signer),
          onRecoveryReady: options?.onRecoveryReady,
        })
        await refreshAfterCommittedWalletMutation()
        void synchronizeRecovery(signer).catch(() => {
          if (isWalletSignerCurrent(signer)) setRecoverySync("blocked")
        })
        return { wallet, mnemonic, accountNumber, publicDefaultAllowed: false }
      })
    },
    [store, refreshAfterCommittedWalletMutation, synchronizeRecovery]
  )

  useEffect(() => {
    setRecoverySync("idle")
    setRecoverySyncReason(undefined)
    setRecoverySyncAttempt(null)
    const signer = getAccountSigner()
    if (
      !enabled ||
      auth.signerReadiness !== "ready" ||
      !signer?.capabilities.nip44 ||
      getSparkConfiguration().status !== "ready"
    )
      return
    const service = getPortableWalletSync(signer)
    const observe = () => {
      if (!isWalletSignerCurrent(signer)) return
      setRecoverySync(service.snapshot.status)
      setRecoverySyncReason(service.snapshot.blockedReason)
      if (
        service.snapshot.status !== "idle" &&
        service.snapshot.status !== "checking"
      ) {
        setRecoverySyncAttempt({ signer, authGeneration: auth.authGeneration })
      }
    }
    observe()
    const unsubscribe = service.subscribe(observe)
    const disconnect = service.connect()
    return () => {
      unsubscribe()
      disconnect()
    }
  }, [enabled, auth.accountPubkey, auth.authGeneration, auth.signerReadiness])

  const unlockSpark = useCallback(
    async (
      walletId: string,
      options: { priority?: "foreground" | "background" } = {}
    ) => {
      const manager = requireSparkManager()
      const signer = getAccountSigner()
      let ownsOpenSession: (() => boolean) | undefined
      const canReportOpenError = () =>
        !manager.isOpen(walletId) || ownsOpenSession?.() === true
      const reportOpenFailure = (error: unknown) => {
        if (signer && !isWalletSignerCurrent(signer)) return
        if (
          signer &&
          options.priority === "background" &&
          error instanceof SessionSignerError &&
          error.code === "background_paused" &&
          manager.isOpen(walletId)
        ) {
          // An older background refusal must not overwrite a foreground
          // restore's newer state, including a genuine balance error.
          // The refused attempt still rejects without resuming consent.
          return
        }
        if (!canReportOpenError()) return
        setRuntime((current) =>
          canReportOpenError() && (!signer || isWalletSignerCurrent(signer))
            ? {
                ...current,
                [walletId]: {
                  status: "error",
                  errorSource: "opening",
                  balanceMsats: null,
                  error: getErrorMessage(
                    error,
                    "Could not unlock Portable Wallet."
                  ),
                },
              }
            : current
        )
      }
      let previous = signer && signerWalletOpens.get(signer)?.get(walletId)
      while (signer && previous) {
        const joined = previous
        try {
          await joined
          assertWalletSignerCurrent(signer)
          if (manager.isOpen(walletId) || options.priority === "background") {
            await refreshSparkBalance(walletId, manager, setRuntime)
            return
          }
          // Lock can finish while a shared open is still validating. An
          // explicit reopen must start again, or join a newer caller's open.
          previous = signerWalletOpens.get(signer)?.get(walletId)
          if (previous === joined) break
        } catch (error) {
          if (
            options.priority !== "background" &&
            error instanceof SessionSignerError &&
            error.code === "background_paused" &&
            isWalletSignerCurrent(signer)
          ) {
            // Foreground consent cannot be satisfied by a paused background
            // attempt. Join a newer open if one replaced it; otherwise start
            // this caller's explicitly authorized open below.
            previous = signerWalletOpens.get(signer)?.get(walletId)
            if (previous === joined) previous = undefined
            continue
          }
          reportOpenFailure(error)
          throw error
        }
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
            manager: {
              openWithMnemonic: async (input) => {
                await manager.openWithMnemonic(input)
                ownsOpenSession = manager.captureSession(walletId)
              },
              close: (id) => manager.close(id),
            },
            expectedNetwork: getSparkWalletNetwork(),
            listWallets: () =>
              signer ? store.listVisible(signer.pubkey) : registry.list(),
            resolveOpenInput: async (registration) => {
              const stored = await store.getSparkRecovery(walletId)
              if (!stored) {
                throw new Error("Portable Wallet recovery data is unavailable.")
              }
              const binding = getSparkRecoveryBinding(registration, stored)
              const recovered = await recoverStoredSparkMnemonic(
                stored,
                binding,
                { priority: options.priority ?? "foreground" }
              )
              const mnemonic = recovered.mnemonic
              const signer = recovered.signer
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
          if (signer && isWalletSignerCurrent(signer))
            deliberatelyLockedWallets.get(signer)?.delete(walletId)
        } catch (error) {
          reportOpenFailure(error)
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
    [registry, store]
  )

  const revealSparkRecovery = useCallback(
    async (walletId: string) => {
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
        getSparkRecoveryBinding(wallet, stored)
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
    async (
      walletId: string,
      register = false,
      username?: string,
      domain?: "breez.tips" | "conduit.cash",
      options: AccountSignerOperationOptions = { priority: "background" }
    ) => {
      const signer = getAccountSigner()
      return resolveSparkLightningAddress({
        manager: requireSparkManager(),
        walletId,
        register,
        username,
        domain,
        assertCurrent: () => {
          if (getAccountSigner() !== signer)
            throw new Error("Your Nostr sign-in changed.")
          if (signer) assertWalletSignerCurrent(signer)
        },
        onRegistered: (address) => {
          if (!signer) return
          const service = getPortableWalletSync(signer)
          service.rememberLightningAddress(walletId, address)
          // Address metadata does not change wallet descriptors or balances.
          // A reload here would retrigger the runtime-driven address lookup.
          void service.sync(options).catch(() => {
            if (isWalletSignerCurrent(signer)) setRecoverySync("blocked")
          })
        },
      })
    },
    []
  )

  const addressRequestSigner = getAccountSigner()
  const requestAddressName = useMemo(() => {
    const signer = addressRequestSigner
    return signer && auth.signerReadiness === "ready"
      ? accountAddressRequests(signer, appId)
      : undefined
  }, [appId, addressRequestSigner, auth.signerReadiness])

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
    (walletId: string): Promise<void> => {
      const owner = ownerRef.current
      const generation = auth.authGeneration
      const signer = getAccountSigner()
      const key = `${owner}:${generation}:${walletId}`
      const existing = balanceRefreshes.current.get(key)
      if (existing) return existing
      const wallet = walletsRef.current.find(
        (candidate) => candidate.id === walletId
      )
      if (!wallet) {
        return Promise.reject(new Error("Wallet not found."))
      }
      const current = () =>
        enabledRef.current &&
        ownerRef.current === owner &&
        auth.isAuthGenerationCurrent(generation) &&
        getAccountSigner() === signer &&
        walletsRef.current.some((candidate) => candidate.id === walletId)
      const operation = (async () => {
        if (!current()) return
        if (wallet.providerId === "spark") {
          const manager = requireSparkManager()
          await refreshSparkBalance(walletId, manager, (update) => {
            if (current()) setRuntime(update)
          })
        } else if (wallet.providerId === "nwc") {
          const session = getBuyerNwcSession(walletId)
          await session.ensureWarm(NWC_MOUNT_WARM_MAX_AGE_MS)
          if (current()) await session.refreshBalance()
        }
      })().finally(() => balanceRefreshes.current.delete(key))
      balanceRefreshes.current.set(key, operation)
      return operation
    },
    [auth.authGeneration, auth.isAuthGenerationCurrent]
  )

  const setDefaultPaymentWallet = useCallback(
    async (walletId: string) => {
      const owner = ownerRef.current
      const signer = getAccountSigner()
      if (ownerRef.current !== owner) throw new Error("Wallet sign-in changed.")
      if (getAccountSigner() !== signer)
        throw new Error("Wallet sign-in changed.")
      const selected = (await store.listVisible(owner)).find(
        (w) => w.id === walletId
      )
      if (selected?.providerId === "spark" && signer) {
        await getPortableWalletSync(signer).update(
          walletId,
          { paySelectedAt: Date.now() },
          { priority: "foreground" }
        )
        void synchronizeRecovery(signer).catch(() => {
          if (isWalletSignerCurrent(signer)) setRecoverySync("blocked")
        })
      } else await registry.setDefault(walletId, "pay_invoice")
      await refreshAfterCommittedWalletMutation()
    },
    [refreshAfterCommittedWalletMutation, registry, store, synchronizeRecovery]
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
        const remainingBefore = (
          await store.listVisible(ownerRef.current)
        ).filter(
          (candidate) =>
            candidate.id !== wallet.id && candidate.network === wallet.network
        )
        const replacement = getWalletDefaultReplacement(remainingBefore, {
          network: wallet.network,
          intent: "pay_invoice",
        })
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
        }
        if (signer && wallet.providerId === "spark") {
          assertWalletSignerCurrent(signer)
          const service = getPortableWalletSync(signer)
          await service.update(
            wallet.id,
            { lifecycle: "removed" },
            { priority: "foreground" }
          )
          await service.sync({ priority: "foreground" })
          assertWalletSignerCurrent(signer)
        }
        if (wallet.providerId === "nwc") {
          closeBuyerNwcSession(wallet.id)
        }
        await store.transaction(async () => {
          if (signer) {
            assertWalletSignerCurrent(signer)
          }
          await registry.remove(wallet.id)
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
        auth.signerReadiness !== "ready" ||
        recoverySyncAttempt?.signer !== signer ||
        recoverySyncAttempt.authGeneration !== auth.authGeneration
      )
        return
      const candidates = await listAutomaticSignerSparkWallets({
        signer,
        network: getSparkWalletNetwork(),
        recoverySync,
        store,
        deliberatelyLockedIds: deliberatelyLockedWallets.get(signer),
      })
      for (const wallet of candidates) {
        if (!active || !isWalletSignerCurrent(signer)) return
        if (
          (await store.listVisible(signer.pubkey)).some(
            (visible) => visible.id === wallet.id
          )
        ) {
          if (getSparkWalletManager()?.isOpen(wallet.id)) continue
          const attempted =
            automaticWalletOpens.get(signer) ?? new Set<string>()
          if (
            attempted.has(wallet.id) &&
            !signerWalletOpens.get(signer)?.has(wallet.id)
          )
            continue
          attempted.add(wallet.id)
          automaticWalletOpens.set(signer, attempted)
          void unlockSpark(wallet.id, {
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
    recoverySync,
    recoverySyncAttempt,
    wallets,
    store,
    unlockSpark,
  ])

  const setReceivingWallet = useCallback(
    async (walletId: string) => {
      const owner = ownerRef.current
      const signer = getAccountSigner()
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
      if (getAccountSigner() !== signer)
        throw new Error("Your Nostr sign-in changed.")
      const selected = (await store.listVisible(owner)).find(
        (w) => w.id === walletId
      )
      if (selected?.providerId === "spark" && signer) {
        await getPortableWalletSync(signer).update(
          walletId,
          { receiveSelectedAt: Date.now() },
          { priority: "foreground" }
        )
        void synchronizeRecovery(signer).catch(() => {
          if (isWalletSignerCurrent(signer)) setRecoverySync("blocked")
        })
      } else await registry.setDefault(walletId, "receive")
      await refreshAfterCommittedWalletMutation()
    },
    [registry, store, refreshAfterCommittedWalletMutation, synchronizeRecovery]
  )

  const setMainWallet = useCallback(
    async (walletId: string) => {
      const signer = requireWalletSigner()
      const service = getPortableWalletSync(signer)
      await service.update(
        walletId,
        { paySelectedAt: Date.now(), receiveSelectedAt: Date.now() },
        { priority: "foreground" }
      )
      setMainWalletSync("pending")
      await synchronizeRecovery(signer, { priority: "foreground" })
      setMainWalletSync(
        service.snapshot.status === "ready" ? "ready" : "pending"
      )
    },
    [synchronizeRecovery]
  )

  const getSparkRecoveryType = useCallback(
    async (walletId: string) => {
      const recovery = await store.getSparkRecovery(walletId)
      return recovery?.type ?? null
    },
    [store]
  )
  const renameWallet = useCallback(
    async (walletId: string, label: string) => {
      const name = requireWalletLabel(label)
      const wallet = (await store.listVisible(ownerRef.current)).find(
        (w) => w.id === walletId
      )
      if (!wallet) throw new Error("Wallet is unavailable.")
      if (wallet.providerId === "spark") {
        const signer = requireWalletSigner()
        await getPortableWalletSync(signer).update(
          walletId,
          { name },
          { priority: "foreground" }
        )
        void synchronizeRecovery(signer).catch(() => {
          if (isWalletSignerCurrent(signer)) setRecoverySync("blocked")
        })
      } else await store.rename(walletId, name)
      await refreshAfterCommittedWalletMutation()
    },
    [store, synchronizeRecovery, refreshAfterCommittedWalletMutation]
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
    initializationError,
    recoverySync,
    recoverySyncByWallet,
    recoverySyncReason,
    mainWalletSync,
    retryRecovery,
    signerUnlockSupported: getAccountSigner()?.capabilities.nip44 === true,
    sparkAvailability: getSparkConfiguration(),
    hasSparkRecovery,
    getSparkRecoveryType,
    renameWallet,
    connectNwc,
    completeSparkCreation: async (walletId) => {
      const signer = requireWalletSigner()
      await getPortableWalletSync(signer).update(
        walletId,
        { setupPending: false },
        { priority: "foreground" }
      )
      await synchronizeRecovery(signer, { priority: "foreground" })
    },
    createSpark,
    importSpark,
    unlockSpark,
    revealSparkRecovery,
    lockSpark,
    receiveSparkLightning,
    getSparkLightningAddress,
    requestAddressName,
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

/** Automatic balance reads belong to the visible Wallets route, not every consumer. */
export function useWalletBalanceUpdates(wallets: UseWalletsReturn): void {
  const controller = useRef(wallets)
  useLayoutEffect(() => {
    controller.current = wallets
  }, [wallets])
  const balanceWalletIds = wallets.wallets
    .filter(
      (wallet) =>
        wallet.providerId === "nwc" ||
        (wallet.providerId === "spark" &&
          getSparkWalletManager()?.isOpen(wallet.id))
    )
    .map((wallet) => wallet.id)
    .join(",")
  const refreshBalance = wallets.refreshBalance
  const attemptedAt = useMemo(() => new Map<string, number>(), [refreshBalance])
  useEffect(() => {
    if (typeof document === "undefined") return
    const ids = balanceWalletIds ? balanceWalletIds.split(",") : []
    if (ids.length === 0) return
    const update = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return
      const visibleWallets = new Map(
        controller.current.wallets.map((wallet) => [wallet.id, wallet])
      )
      for (const id of ids) {
        const wallet = visibleWallets.get(id)
        if (
          !wallet ||
          (wallet.providerId === "spark" &&
            !getSparkWalletManager()?.isOpen(id))
        )
          continue
        if (Date.now() - (attemptedAt.get(id) ?? 0) < 5_000) continue
        attemptedAt.set(id, Date.now())
        void refreshBalance(id).catch(() => {
          // Provider/runtime state carries the error; no sensitive diagnostics.
        })
      }
    }
    update()
    const interval = window.setInterval(update, 30_000)
    window.addEventListener("focus", update)
    window.addEventListener("online", update)
    document.addEventListener("visibilitychange", update)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", update)
      window.removeEventListener("online", update)
      document.removeEventListener("visibilitychange", update)
    }
  }, [balanceWalletIds, refreshBalance, attemptedAt])
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
  if (normalized.length > 80)
    throw new Error("Use at most 80 characters for the wallet name.")
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
    setRuntime((current) =>
      manager.isOpen(walletId)
        ? current
        : {
            ...current,
            [walletId]: { status: "locked", balanceMsats: null, error: null },
          }
    )
  if (!manager.isOpen(walletId)) {
    locked()
    return
  }
  const isCurrent = manager.captureSession(walletId)
  try {
    const balanceSats = await manager.getBalance(walletId)
    if (!isCurrent()) return
    setRuntime((current) =>
      isCurrent()
        ? {
            ...current,
            [walletId]: {
              status: "ready",
              balanceMsats: balanceSats * 1_000,
              error: null,
            },
          }
        : current
    )
  } catch (error) {
    if (!manager.isOpen(walletId)) {
      locked()
      return
    }
    // A superseded read cannot fail a newer open operation either.
    if (!isCurrent()) return
    setRuntime((current) =>
      isCurrent()
        ? {
            ...current,
            [walletId]: {
              status: "error",
              errorSource: "balance",
              balanceMsats: null,
              error: getErrorMessage(
                error,
                "Could not refresh wallet balance."
              ),
            },
          }
        : current
    )
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
