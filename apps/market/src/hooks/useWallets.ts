import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  config,
  getWalletDefaultReplacement,
  parseNwcUri,
  type WalletDescriptor,
  type WalletNetwork,
} from "@conduit/core"

import {
  closeBuyerNwcSession,
  getBuyerNwcSession,
  type NwcSessionSnapshot,
} from "../lib/buyer-nwc-session"
import {
  getDefaultSparkAccountNumber,
  getSparkConfiguration,
  getSparkWalletManager,
} from "../lib/spark-sdk"
import type {
  SparkPaymentSummary,
  SparkSendQuote,
  SparkSendRequest,
  SparkSendResult,
} from "../lib/spark-wallet"
import {
  decryptSparkMnemonic,
  encryptSparkMnemonic,
  generateSparkMnemonic,
  isValidSparkAccountNumber,
  isValidSparkMnemonic,
  normalizeSparkMnemonic,
} from "../lib/spark-recovery"
import {
  cleanupSparkWalletState,
  openRegisteredSparkWallet,
} from "../lib/spark-wallet-lifecycle"
import { runWithSparkWalletOperationLock } from "../lib/spark-wallet-lease"
import {
  getNwcWalletRegistrationDetails,
  migrateLegacyNwcWallet,
  reconcileNwcWalletRegistration,
} from "../lib/wallet-migration"
import {
  getMarketWalletRegistry,
  getMarketWalletStore,
  getSparkRecoveryBinding,
  registerSparkWalletAtomically,
  type StoredSparkWalletRecovery,
} from "../lib/wallet-storage"
import { rollbackFailedWalletSetup } from "../lib/wallet-setup-rollback"
import {
  finalizeCommittedWalletMutation,
  LatestWalletReloadCoordinator,
  reconcileWalletSynchronizationError,
  WALLET_STORAGE_INITIALIZATION_ERROR,
  WalletInitializationCoordinator,
} from "../lib/wallet-initialization"
import {
  getRemovedWalletIdsForProvider,
  notifyWalletsChanged,
  subscribeToWalletChanges,
} from "../lib/wallet-change-channel"

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
  defaultPaymentWallet: WalletDescriptor | null
  runtime: Record<string, WalletRuntimeState>
  nwcSnapshots: Record<string, NwcSessionSnapshot>
  loading: boolean
  initializationError: string | null
  sparkAvailability: ReturnType<typeof getSparkConfiguration>
  getSparkRecoveryMethod(walletId: string): Promise<"password" | null>
  connectNwc(uri: string, label?: string): Promise<WalletDescriptor>
  createSpark(
    label: string,
    password: string
  ): Promise<{
    wallet: WalletDescriptor
    mnemonic: string
    accountNumber: number
  }>
  importSpark(input: {
    label: string
    mnemonic: string
    password: string
    accountNumber: number
  }): Promise<WalletDescriptor>
  unlockSpark(walletId: string, password: string): Promise<void>
  revealSparkRecovery(
    walletId: string,
    password: string
  ): Promise<{ mnemonic: string; accountNumber: number }>
  lockSpark(walletId: string): Promise<void>
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
  reload(): Promise<void>
  retryInitialization(): Promise<void>
}

const lockedRuntime = (): WalletRuntimeState => ({
  status: "locked",
  balanceMsats: null,
  error: null,
})

const walletInitialization = new WalletInitializationCoordinator()

export function useWallets(): UseWalletsReturn {
  const registry = getMarketWalletRegistry()
  const store = getMarketWalletStore()
  const [wallets, setWallets] = useState<WalletDescriptor[]>([])
  const walletsRef = useRef<WalletDescriptor[]>([])
  const [reloadCoordinator] = useState(
    () => new LatestWalletReloadCoordinator()
  )
  const [runtime, setRuntime] = useState<Record<string, WalletRuntimeState>>({})
  const [nwcSnapshots, setNwcSnapshots] = useState<
    Record<string, NwcSessionSnapshot>
  >({})
  const [loading, setLoading] = useState(true)
  const [initializationError, setInitializationError] = useState<string | null>(
    null
  )

  const reload = useCallback(async () => {
    await reloadCoordinator.run(
      async () => {
        const nextWallets = await registry.list()
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

        return { nextWallets, openSparkRuntime }
      },
      ({ nextWallets, openSparkRuntime }) => {
        for (const walletId of getRemovedWalletIdsForProvider(
          walletsRef.current,
          nextWallets,
          "nwc"
        )) {
          closeBuyerNwcSession(walletId)
        }
        walletsRef.current = nextWallets
        setWallets(nextWallets)
        const nextNwcWalletIds = new Set(
          nextWallets
            .filter((wallet) => wallet.providerId === "nwc")
            .map((wallet) => wallet.id)
        )
        setNwcSnapshots((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([walletId]) =>
              nextNwcWalletIds.has(walletId)
            )
          )
        )
        setRuntime((current) => {
          const next = { ...current }
          for (const wallet of nextWallets) {
            if (wallet.providerId === "spark") {
              next[wallet.id] =
                openSparkRuntime.get(wallet.id) ?? lockedRuntime()
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
  }, [registry, reloadCoordinator])

  const finalizeWalletMutation = useCallback(async () => {
    const result = await finalizeCommittedWalletMutation({
      notifyChanged: notifyWalletsChanged,
      reload,
    })
    setInitializationError((current) =>
      reconcileWalletSynchronizationError(
        current,
        result === "refresh_failed" ? "failed" : "succeeded"
      )
    )
  }, [reload])

  const retryInitialization = useCallback(async () => {
    setLoading(true)
    setInitializationError(null)
    try {
      await walletInitialization.run(initializeWalletStorage)
      await reload()
    } catch {
      setInitializationError(WALLET_STORAGE_INITIALIZATION_ERROR)
    } finally {
      setLoading(false)
    }
  }, [reload])

  useEffect(() => {
    void retryInitialization()
  }, [retryInitialization])

  useEffect(() => {
    return subscribeToWalletChanges(reload, undefined, {
      onSuccess() {
        setInitializationError((current) =>
          reconcileWalletSynchronizationError(current, "succeeded")
        )
      },
      onError() {
        setInitializationError((current) =>
          reconcileWalletSynchronizationError(current, "failed")
        )
      },
    })
  }, [reload])

  useEffect(() => {
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
  }, [])

  useEffect(() => {
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
          const snapshot = await session.warm()
          if (!active || !snapshot.info) {
            return
          }
          const changed = await reconcileNwcWalletRegistration({
            walletId: wallet.id,
            info: snapshot.info,
            store,
          })
          if (changed) {
            await finalizeWalletMutation()
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
  }, [finalizeWalletMutation, store, wallets])

  const ensureDefault = useCallback(
    async (wallet: WalletDescriptor) => {
      if (!wallet.capabilities.includes("pay_invoice")) {
        return
      }
      const eligible = await registry.listEligible({
        network: wallet.network,
        capability: "pay_invoice",
      })
      if (
        !eligible.some((candidate) =>
          candidate.defaultIntents.includes("pay_invoice")
        )
      ) {
        await registry.setDefault(wallet.id, "pay_invoice")
      }
    },
    [registry]
  )

  const registerSparkWallet = useCallback(
    async (input: {
      walletId: string
      label: string
      network: WalletNetwork
      recovery: StoredSparkWalletRecovery
    }) =>
      registerSparkWalletAtomically({
        store,
        recovery: input.recovery,
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
          getConfiguredWalletNetwork()
        )
        const connectedWallet = await store.transaction(async () => {
          const wallet = await registry.add({
            kind: "connected",
            providerId: "nwc",
            label: label?.trim() || info?.alias?.trim() || "Connected wallet",
            network: registration.network,
            capabilities: registration.capabilities,
          })
          await store.putNwcCredential(wallet.id, uri.trim())
          const saved = await store.getNwcCredential(wallet.id)
          if (saved !== uri.trim()) {
            throw new Error("Connected Wallet credential verification failed.")
          }
          await ensureDefault(wallet)
          return wallet
        })
        const session = getBuyerNwcSession(connectedWallet.id)
        session.setConnection(connection)
        void session.warm()
        await finalizeWalletMutation()
        return connectedWallet
      } finally {
        closeBuyerNwcSession(temporaryWalletId)
      }
    },
    [ensureDefault, finalizeWalletMutation, registry, store]
  )

  const createSpark = useCallback(
    async (label: string, password: string) => {
      const manager = requireSparkManager()
      const network = getSparkWalletNetwork()
      const accountNumber = getDefaultSparkAccountNumber(network)
      const walletId = crypto.randomUUID()
      const mnemonic = generateSparkMnemonic()
      const binding = {
        walletId,
        providerId: "spark" as const,
        network,
        accountNumber,
      }
      const recovery = await encryptSparkMnemonic(mnemonic, password, binding)
      const wallet = await registerSparkWallet({
        walletId,
        label: requireWalletLabel(label),
        network,
        recovery: {
          type: "password",
          walletId,
          providerId: "spark",
          network,
          accountNumber,
          recovery,
        },
      })
      try {
        await manager.openWithMnemonic({
          walletId: wallet.id,
          mnemonic,
          accountNumber,
        })
        await refreshSparkBalance(wallet.id, manager, setRuntime)
        await ensureDefault(wallet)
      } catch (error) {
        const rollback = await rollbackFailedWalletSetup({
          closeWallet: () => manager.close(wallet.id),
          removeRegistration: () => registry.remove(wallet.id),
        })
        if (rollback.status === "kept") {
          await finalizeWalletMutation()
          throw new Error(
            `${getErrorMessage(error, "Portable Wallet setup failed.")} ${rollback.reason}`,
            { cause: error }
          )
        }
        throw error
      }
      await finalizeWalletMutation()
      return {
        wallet,
        mnemonic,
        accountNumber,
      }
    },
    [ensureDefault, finalizeWalletMutation, registerSparkWallet, registry]
  )

  const importSpark = useCallback(
    async (input: {
      label: string
      mnemonic: string
      password: string
      accountNumber: number
    }) => {
      const manager = requireSparkManager()
      const mnemonic = normalizeSparkMnemonic(input.mnemonic)
      if (!isValidSparkMnemonic(mnemonic)) {
        throw new Error("Enter a valid BIP39 recovery phrase.")
      }
      const network = getSparkWalletNetwork()
      const accountNumber = input.accountNumber
      if (!isValidSparkAccountNumber(accountNumber)) {
        throw new Error("Enter a valid Spark account number.")
      }
      const walletId = crypto.randomUUID()
      const binding = {
        walletId,
        providerId: "spark" as const,
        network,
        accountNumber,
      }
      const recovery = await encryptSparkMnemonic(
        mnemonic,
        input.password,
        binding
      )
      const wallet = await registerSparkWallet({
        walletId,
        label: requireWalletLabel(input.label),
        network,
        recovery: {
          type: "password",
          walletId,
          providerId: "spark",
          network,
          accountNumber,
          recovery,
        },
      })
      try {
        await manager.openWithMnemonic({
          walletId: wallet.id,
          mnemonic,
          accountNumber,
        })
        await refreshSparkBalance(wallet.id, manager, setRuntime)
        await ensureDefault(wallet)
      } catch (error) {
        const rollback = await rollbackFailedWalletSetup({
          closeWallet: () => manager.close(wallet.id),
          removeRegistration: () => registry.remove(wallet.id),
        })
        if (rollback.status === "kept") {
          await finalizeWalletMutation()
          throw new Error(
            `${getErrorMessage(error, "Portable Wallet setup failed.")} ${rollback.reason}`,
            { cause: error }
          )
        }
        throw error
      }
      await finalizeWalletMutation()
      return wallet
    },
    [ensureDefault, finalizeWalletMutation, registerSparkWallet, registry]
  )

  const unlockSpark = useCallback(
    async (walletId: string, password: string) => {
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
            return {
              mnemonic: await decryptSparkMnemonic(
                stored.recovery,
                password,
                getSparkRecoveryBinding(registration, stored)
              ),
              accountNumber: stored.accountNumber,
            }
          },
          afterOpen: () => refreshSparkBalance(walletId, manager, setRuntime),
          onValidated: notifyWalletsChanged,
        })
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
    [registry, store]
  )

  const revealSparkRecovery = useCallback(
    async (walletId: string, password: string) => {
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
      return {
        mnemonic: await decryptSparkMnemonic(
          stored.recovery,
          password,
          getSparkRecoveryBinding(wallet, stored)
        ),
        accountNumber: stored.accountNumber,
      }
    },
    [registry, store]
  )

  const getSparkRecoveryMethod = useCallback(
    async (walletId: string) => {
      return (await store.getSparkRecovery(walletId)) ? "password" : null
    },
    [store]
  )

  const lockSpark = useCallback(async (walletId: string) => {
    const manager = getSparkWalletManager()
    await manager?.close(walletId)
    setRuntime((current) => ({
      ...current,
      [walletId]: lockedRuntime(),
    }))
    notifyWalletsChanged()
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
        notifyWalletsChanged()
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
      await finalizeWalletMutation()
    },
    [finalizeWalletMutation, registry]
  )

  const removeWallet = useCallback(
    async (walletId: string, options: { recoveryConfirmed?: boolean } = {}) => {
      const requestedWallet = (await registry.list()).find(
        (candidate) => candidate.id === walletId
      )
      if (!requestedWallet) {
        return
      }

      const removeCurrentRegistration = async (): Promise<boolean> => {
        const wallet = (await registry.list()).find(
          (candidate) => candidate.id === walletId
        )
        if (
          !wallet ||
          wallet.providerId !== requestedWallet.providerId ||
          wallet.createdAt !== requestedWallet.createdAt
        ) {
          if (!wallet && requestedWallet.providerId === "spark") {
            await cleanupSparkWalletState({
              walletId,
              manager: getSparkWalletManager(),
            })
          }
          return false
        }
        if (wallet.kind === "portable" && !options.recoveryConfirmed) {
          throw new Error(
            "Confirm that recovery material is available before removing this Portable Wallet."
          )
        }
        if (wallet.providerId === "spark") {
          await cleanupSparkWalletState({
            walletId: wallet.id,
            manager: getSparkWalletManager(),
          })
        } else if (wallet.providerId === "nwc") {
          closeBuyerNwcSession(wallet.id)
        }
        await store.transaction(async () => {
          await registry.remove(wallet.id)
          const remaining = await registry.listEligible({
            network: wallet.network,
            capability: "pay_invoice",
          })
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
          ? await runWithSparkWalletOperationLock(
              walletId,
              removeCurrentRegistration
            )
          : await removeCurrentRegistration()
      if (removed) {
        await finalizeWalletMutation()
      }
    },
    [finalizeWalletMutation, registry, store]
  )

  const portableWallets = useMemo(
    () => wallets.filter((wallet) => wallet.kind === "portable"),
    [wallets]
  )
  const connectedWallets = useMemo(
    () => wallets.filter((wallet) => wallet.kind === "connected"),
    [wallets]
  )
  const defaultPaymentWallet =
    wallets.find(
      (wallet) =>
        wallet.network === getConfiguredWalletNetwork() &&
        wallet.defaultIntents.includes("pay_invoice")
    ) ?? null

  return {
    wallets,
    portableWallets,
    connectedWallets,
    defaultPaymentWallet,
    runtime,
    nwcSnapshots,
    loading,
    initializationError,
    sparkAvailability: getSparkConfiguration(),
    getSparkRecoveryMethod,
    connectNwc,
    createSpark,
    importSpark,
    unlockSpark,
    revealSparkRecovery,
    lockSpark,
    receiveSparkLightning,
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
    reload,
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

function getConfiguredWalletNetwork(): WalletNetwork {
  return config.lightningNetwork === "mock"
    ? "regtest"
    : config.lightningNetwork
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
    fallbackNetwork: getConfiguredWalletNetwork(),
  })
}
