import { createFileRoute } from "@tanstack/react-router"
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  ExternalLink,
  History,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Sparkles,
  Unplug,
  WalletCards,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  formatBitcoinBaseUnits,
  getWalletDisplayLabels,
  isAmountlessLightningInvoice,
  SUPPORTED_SHOPPER_DISPLAY_CURRENCIES,
  type ShopperDisplayCurrency,
  type WalletDescriptor,
} from "@conduit/core"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@conduit/ui"

import { useShopperPricing } from "../hooks/useShopperPricing"
import {
  useWallets,
  type UseWalletsReturn,
  type WalletRuntimeState,
} from "../hooks/useWallets"
import type { NwcSessionSnapshot } from "../lib/buyer-nwc-session"
import {
  getPortableWalletFormError,
  type PortableWalletMode,
} from "../lib/portable-wallet-form"
import { formatSparkRecoveryBundleForClipboard } from "../lib/spark-recovery-bundle"
import type {
  SparkPaymentSummary,
  SparkSendQuote,
  SparkSendRequest,
} from "../lib/spark-wallet"
import { getWalletCapabilityPills } from "../lib/wallet-capabilities"
import {
  getWalletNetworkLabel,
  getWalletProviderDescription,
} from "../lib/wallet-provider-label"

export const Route = createFileRoute("/wallet")({
  component: WalletsPage,
})

type SparkRecoveryMethodState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; method: "password" }
  | { status: "missing"; reason: string }

const SPARK_HISTORY_LOAD_TIMEOUT_MS = 15_000

function WalletsPage() {
  const wallets = useWallets()
  const shopperPricing = useShopperPricing()
  const walletsHeadingRef = useRef<HTMLHeadingElement>(null)
  const dialogTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [portableOpen, setPortableOpen] = useState(false)
  const [connectedOpen, setConnectedOpen] = useState(false)
  const [unlockWallet, setUnlockWallet] = useState<WalletDescriptor | null>(
    null
  )
  const [recoveryWallet, setRecoveryWallet] = useState<WalletDescriptor | null>(
    null
  )
  const [removeWallet, setRemoveWallet] = useState<WalletDescriptor | null>(
    null
  )
  const [receiveWallet, setReceiveWallet] = useState<WalletDescriptor | null>(
    null
  )
  const [sendWallet, setSendWallet] = useState<WalletDescriptor | null>(null)
  const [historyWallet, setHistoryWallet] = useState<WalletDescriptor | null>(
    null
  )
  const formatSats = (sats: number) =>
    sats === 0
      ? formatBitcoinBaseUnits(0, shopperPricing.preference.bitcoinUnit)
      : shopperPricing.formatSatsAmount(sats).primary
  const openWalletDialog = (
    setter: React.Dispatch<React.SetStateAction<WalletDescriptor | null>>,
    wallet: WalletDescriptor,
    trigger: HTMLButtonElement
  ) => {
    dialogTriggerRef.current = trigger
    setter(wallet)
  }
  const restoreDialogFocus = () => {
    const trigger = dialogTriggerRef.current
    dialogTriggerRef.current = null
    requestAnimationFrame(() => {
      if (trigger?.isConnected && !trigger.disabled) {
        trigger.focus()
        return
      }
      walletsHeadingRef.current?.focus()
    })
  }

  return (
    <div className="mx-auto max-w-[64rem] py-2 sm:py-6">
      <div className="space-y-6">
        <section className="overflow-hidden rounded-[2.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] shadow-[var(--shadow-dialog)]">
          <div className="border-b border-[var(--border)] bg-[image:radial-gradient(circle_at_top_left,color-mix(in_srgb,var(--secondary-500)_16%,transparent),transparent_42%)] p-5 sm:p-8">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
                  Payments
                </div>
                <h1
                  ref={walletsHeadingRef}
                  tabIndex={-1}
                  className="mt-3 font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl"
                >
                  Wallets
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--text-secondary)]">
                  Keep self-custodial Portable Wallets alongside wallets you
                  connect through NWC. Choose a default, or select an eligible
                  wallet for each payment.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={(event) => {
                    dialogTriggerRef.current = event.currentTarget
                    setConnectedOpen(true)
                  }}
                  disabled={
                    wallets.loading || wallets.initializationError !== null
                  }
                >
                  <Link2 className="h-4 w-4" />
                  Connect wallet
                </Button>
                <Button
                  onClick={(event) => {
                    dialogTriggerRef.current = event.currentTarget
                    setPortableOpen(true)
                  }}
                  disabled={
                    wallets.loading ||
                    wallets.initializationError !== null ||
                    wallets.sparkAvailability.status !== "ready"
                  }
                >
                  <Plus className="h-4 w-4" />
                  Add portable wallet
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-8 p-5 sm:p-8">
            {wallets.initializationError ? (
              <div
                role="alert"
                className="flex flex-col gap-4 rounded-2xl border border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_8%,transparent)] p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium text-[var(--text-primary)]">
                    Wallets are temporarily unavailable
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                    {wallets.initializationError}
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="shrink-0"
                  disabled={wallets.loading}
                  onClick={() => void wallets.retryInitialization()}
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </Button>
              </div>
            ) : wallets.sparkAvailability.status === "unavailable" ? (
              <div
                role="status"
                className="rounded-2xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_9%,transparent)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]"
              >
                <p className="font-medium">
                  Spark Portable Wallets are unavailable
                </p>
                <p className="mt-1">{wallets.sparkAvailability.reason}</p>
              </div>
            ) : null}

            {!wallets.initializationError && (
              <>
                <WalletSection
                  title="Portable"
                  description="Self-custodial wallets whose recovery you control. Spark is currently supported."
                  empty="No Portable Wallets on this device."
                  loading={wallets.loading}
                  wallets={wallets.portableWallets}
                  runtime={wallets.runtime}
                  nwcSnapshots={wallets.nwcSnapshots}
                  providerActionsDisabled={
                    wallets.sparkAvailability.status !== "ready"
                  }
                  formatSats={formatSats}
                  onDefault={wallets.setDefaultPaymentWallet}
                  onRefresh={wallets.refreshBalance}
                  onUnlock={(wallet, trigger) =>
                    openWalletDialog(setUnlockWallet, wallet, trigger)
                  }
                  onRecovery={(wallet, trigger) =>
                    openWalletDialog(setRecoveryWallet, wallet, trigger)
                  }
                  onLock={wallets.lockSpark}
                  onReceive={(wallet, trigger) =>
                    openWalletDialog(setReceiveWallet, wallet, trigger)
                  }
                  onSend={(wallet, trigger) =>
                    openWalletDialog(setSendWallet, wallet, trigger)
                  }
                  onHistory={(wallet, trigger) =>
                    openWalletDialog(setHistoryWallet, wallet, trigger)
                  }
                  onRemove={(wallet, trigger) =>
                    openWalletDialog(setRemoveWallet, wallet, trigger)
                  }
                />

                <WalletSection
                  title="Connected"
                  description="External wallets authorized through Nostr Wallet Connect."
                  empty="No Connected Wallets on this device."
                  loading={wallets.loading}
                  wallets={wallets.connectedWallets}
                  runtime={wallets.runtime}
                  nwcSnapshots={wallets.nwcSnapshots}
                  formatSats={formatSats}
                  onDefault={wallets.setDefaultPaymentWallet}
                  onRefresh={wallets.refreshBalance}
                  onUnlock={(wallet, trigger) =>
                    openWalletDialog(setUnlockWallet, wallet, trigger)
                  }
                  onRecovery={(wallet, trigger) =>
                    openWalletDialog(setRecoveryWallet, wallet, trigger)
                  }
                  onLock={wallets.lockSpark}
                  onReceive={(wallet, trigger) =>
                    openWalletDialog(setReceiveWallet, wallet, trigger)
                  }
                  onSend={(wallet, trigger) =>
                    openWalletDialog(setSendWallet, wallet, trigger)
                  }
                  onHistory={(wallet, trigger) =>
                    openWalletDialog(setHistoryWallet, wallet, trigger)
                  }
                  onRemove={(wallet, trigger) =>
                    openWalletDialog(setRemoveWallet, wallet, trigger)
                  }
                />
              </>
            )}
          </div>
        </section>

        <PriceDisplaySettings />

        <div className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm leading-6 text-[var(--text-secondary)]">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-1 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
            <p>
              Portable Wallet recovery phrases and Connected Wallet
              authorizations are stored by Conduit only on this device. Copying
              a recovery phrase puts it on your system clipboard, where other
              apps or sync services may retain it. Never include wallet secrets
              in support reports, telemetry, screenshots, or public issues.
            </p>
          </div>
          <a
            href="https://docs.spark.money/wallets/identity-key-derivation"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-sm underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
          >
            Spark portability documentation
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      <PortableWalletDialog
        open={portableOpen}
        onOpenChange={(open) => {
          setPortableOpen(open)
          if (!open) restoreDialogFocus()
        }}
        wallets={wallets}
      />
      <ConnectedWalletDialog
        open={connectedOpen}
        onOpenChange={(open) => {
          setConnectedOpen(open)
          if (!open) restoreDialogFocus()
        }}
        wallets={wallets}
      />
      <UnlockWalletDialog
        wallet={unlockWallet}
        onOpenChange={(open) => {
          if (!open) {
            setUnlockWallet(null)
            restoreDialogFocus()
          }
        }}
        wallets={wallets}
      />
      <ReceiveWalletDialog
        wallet={receiveWallet}
        onOpenChange={(open) => {
          if (!open) {
            setReceiveWallet(null)
            restoreDialogFocus()
          }
        }}
        wallets={wallets}
      />
      <SendWalletDialog
        wallet={sendWallet}
        onOpenChange={(open) => {
          if (!open) {
            setSendWallet(null)
            restoreDialogFocus()
          }
        }}
        wallets={wallets}
      />
      <WalletHistoryDialog
        wallet={historyWallet}
        onOpenChange={(open) => {
          if (!open) {
            setHistoryWallet(null)
            restoreDialogFocus()
          }
        }}
        wallets={wallets}
      />
      <RecoveryWalletDialog
        wallet={recoveryWallet}
        onOpenChange={(open) => {
          if (!open) {
            setRecoveryWallet(null)
            restoreDialogFocus()
          }
        }}
        wallets={wallets}
      />
      <RemoveWalletDialog
        wallet={removeWallet}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveWallet(null)
            restoreDialogFocus()
          }
        }}
        wallets={wallets}
      />
    </div>
  )
}

type WalletDialogAction = (
  wallet: WalletDescriptor,
  trigger: HTMLButtonElement
) => void

function WalletSection({
  title,
  description,
  empty,
  loading,
  wallets,
  runtime,
  nwcSnapshots,
  providerActionsDisabled = false,
  formatSats,
  onDefault,
  onRefresh,
  onUnlock,
  onRecovery,
  onLock,
  onReceive,
  onSend,
  onHistory,
  onRemove,
}: {
  title: string
  description: string
  empty: string
  loading: boolean
  wallets: WalletDescriptor[]
  runtime: Record<string, WalletRuntimeState>
  nwcSnapshots: Record<string, NwcSessionSnapshot>
  providerActionsDisabled?: boolean
  formatSats: (sats: number) => string
  onDefault: (walletId: string) => Promise<void>
  onRefresh: (walletId: string) => Promise<void>
  onUnlock: WalletDialogAction
  onRecovery: WalletDialogAction
  onLock: (walletId: string) => Promise<void>
  onReceive: WalletDialogAction
  onSend: WalletDialogAction
  onHistory: WalletDialogAction
  onRemove: WalletDialogAction
}) {
  const displayLabels = getWalletDisplayLabels(wallets)
  return (
    <section>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
            {title}
          </h2>
          <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
            {description}
          </p>
        </div>
        <span className="shrink-0 whitespace-nowrap text-xs text-[var(--text-muted)]">
          {loading
            ? "Loading"
            : `${wallets.length} ${
                wallets.length === 1 ? "wallet" : "wallets"
              }`}
        </span>
      </div>

      <div className="mt-3 overflow-hidden rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)]">
        {loading ? (
          <WalletSectionLoading title={title} />
        ) : wallets.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-[var(--text-muted)]">
            {empty}
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {wallets.map((wallet) => (
              <WalletRow
                key={wallet.id}
                wallet={wallet}
                displayLabel={displayLabels.get(wallet.id) ?? wallet.label}
                runtime={runtime[wallet.id] ?? lockedRuntime()}
                nwcSnapshot={nwcSnapshots[wallet.id]}
                providerActionsDisabled={providerActionsDisabled}
                formatSats={formatSats}
                onDefault={onDefault}
                onRefresh={onRefresh}
                onUnlock={onUnlock}
                onRecovery={onRecovery}
                onLock={onLock}
                onReceive={onReceive}
                onSend={onSend}
                onHistory={onHistory}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function WalletSectionLoading({ title }: { title: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${title} Wallets`}
      className="space-y-3 p-5"
    >
      {[0, 1].map((index) => (
        <div key={index} className="flex items-center gap-3" aria-hidden="true">
          <div className="h-11 w-11 shrink-0 rounded-2xl bg-[var(--surface-elevated)]" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-36 max-w-full rounded bg-[var(--surface-elevated)]" />
            <div className="h-3 w-52 max-w-full rounded bg-[var(--surface-elevated)]" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading saved wallets</span>
    </div>
  )
}

function WalletRow({
  wallet,
  displayLabel,
  runtime,
  nwcSnapshot,
  providerActionsDisabled,
  formatSats,
  onDefault,
  onRefresh,
  onUnlock,
  onRecovery,
  onLock,
  onReceive,
  onSend,
  onHistory,
  onRemove,
}: {
  wallet: WalletDescriptor
  displayLabel: string
  runtime: WalletRuntimeState
  nwcSnapshot?: NwcSessionSnapshot
  providerActionsDisabled: boolean
  formatSats: (sats: number) => string
  onDefault: (walletId: string) => Promise<void>
  onRefresh: (walletId: string) => Promise<void>
  onUnlock: WalletDialogAction
  onRecovery: WalletDialogAction
  onLock: (walletId: string) => Promise<void>
  onReceive: WalletDialogAction
  onSend: WalletDialogAction
  onHistory: WalletDialogAction
  onRemove: WalletDialogAction
}) {
  const [pendingAction, setPendingAction] = useState<
    "make-default" | "lock" | "refresh" | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const pending = pendingAction !== null
  const isDefault = wallet.defaultIntents.includes("pay_invoice")
  const balance =
    runtime.balanceMsats === null
      ? "Balance unavailable"
      : formatSats(Math.floor(runtime.balanceMsats / 1_000))
  const capabilityPills =
    wallet.providerId === "nwc"
      ? getWalletCapabilityPills(nwcSnapshot?.info)
      : []
  const sparkActionsDisabled =
    wallet.providerId === "spark" && providerActionsDisabled

  const run = async (
    actionName: Exclude<typeof pendingAction, null>,
    action: () => Promise<void>
  ) => {
    setPendingAction(actionName)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(getErrorMessage(caught, "Wallet action failed."))
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <div className="p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)]">
            {wallet.providerId === "spark" ? (
              <Sparkles className="h-5 w-5 text-[var(--secondary-500)]" />
            ) : wallet.kind === "portable" ? (
              <WalletCards className="h-5 w-5 text-[var(--text-secondary)]" />
            ) : (
              <Link2 className="h-5 w-5 text-[var(--text-secondary)]" />
            )}
          </div>
          <div className="min-w-0">
            <div
              aria-live="polite"
              className="flex flex-wrap items-center gap-2"
            >
              <h3 className="truncate font-medium text-[var(--text-primary)]">
                {displayLabel}
              </h3>
              {isDefault && <StatusPill variant="info">Default</StatusPill>}
              <WalletRuntimePill runtime={runtime} />
            </div>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              {getWalletProviderDescription(wallet)}
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {getWalletNetworkLabel(wallet.network)}
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">{balance}</p>
            {capabilityPills.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {capabilityPills.map((capability) => (
                  <StatusPill key={capability.id} variant={capability.variant}>
                    {capability.label}
                  </StatusPill>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 lg:justify-end">
          {!isDefault && wallet.capabilities.includes("pay_invoice") && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || sparkActionsDisabled}
              aria-busy={pendingAction === "make-default"}
              onClick={() =>
                void run("make-default", () => onDefault(wallet.id))
              }
            >
              {pendingAction === "make-default" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Make default
            </Button>
          )}
          {wallet.providerId === "spark" &&
            (runtime.status === "locked" ||
              runtime.status === "error" ||
              runtime.status === "unavailable") && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || sparkActionsDisabled}
                onClick={(event) => onUnlock(wallet, event.currentTarget)}
              >
                <Lock className="h-3.5 w-3.5" />
                Unlock
              </Button>
            )}
          {wallet.providerId === "spark" && runtime.status === "ready" && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || sparkActionsDisabled}
                onClick={(event) => onReceive(wallet, event.currentTarget)}
              >
                <ArrowDownToLine className="h-3.5 w-3.5" />
                Receive
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || sparkActionsDisabled}
                onClick={(event) => onSend(wallet, event.currentTarget)}
              >
                <ArrowUpFromLine className="h-3.5 w-3.5" />
                Send
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending || sparkActionsDisabled}
                onClick={(event) => onHistory(wallet, event.currentTarget)}
              >
                <History className="h-3.5 w-3.5" />
                History
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending || sparkActionsDisabled}
                aria-busy={pendingAction === "lock"}
                onClick={() => void run("lock", () => onLock(wallet.id))}
              >
                {pendingAction === "lock" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Lock className="h-3.5 w-3.5" />
                )}
                Lock
              </Button>
            </>
          )}
          {wallet.providerId === "spark" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={(event) => onRecovery(wallet, event.currentTarget)}
            >
              <KeyRound className="h-3.5 w-3.5" />
              View recovery
            </Button>
          )}
          {runtime.status !== "connecting" &&
            runtime.status !== "locked" &&
            wallet.capabilities.includes("balance") && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending || sparkActionsDisabled}
                aria-busy={pendingAction === "refresh"}
                aria-label={
                  runtime.status === "ready"
                    ? `Refresh ${displayLabel} balance`
                    : `Retry ${displayLabel}`
                }
                onClick={() => void run("refresh", () => onRefresh(wallet.id))}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${
                    pendingAction === "refresh" ? "animate-spin" : ""
                  }`}
                />
                {runtime.status === "ready" ? "Refresh" : "Retry"}
              </Button>
            )}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={(event) => onRemove(wallet, event.currentTarget)}
          >
            {wallet.kind === "portable" ? (
              "Remove from this device"
            ) : (
              <>
                <Unplug className="h-3.5 w-3.5" />
                Disconnect
              </>
            )}
          </Button>
        </div>
      </div>
      {(error || runtime.error) && (
        <p role="alert" className="mt-3 text-sm text-[var(--text-secondary)]">
          {error ?? runtime.error}
        </p>
      )}
    </div>
  )
}

function WalletRuntimePill({ runtime }: { runtime: WalletRuntimeState }) {
  switch (runtime.status) {
    case "ready":
      return <StatusPill variant="success">Ready</StatusPill>
    case "connecting":
      return (
        <StatusPill variant="neutral">
          <Loader2 className="h-3 w-3 animate-spin" />
          Connecting
        </StatusPill>
      )
    case "locked":
      return <StatusPill variant="neutral">Locked</StatusPill>
    case "unavailable":
      return <StatusPill variant="warning">Unavailable</StatusPill>
    case "error":
      return <StatusPill variant="error">Needs attention</StatusPill>
  }
}

function useSparkRecoveryMethod(
  walletId: string | null,
  getRecoveryMethod: UseWalletsReturn["getSparkRecoveryMethod"]
): SparkRecoveryMethodState {
  const [method, setMethod] = useState<SparkRecoveryMethodState>({
    status: "idle",
  })

  useEffect(() => {
    if (!walletId) {
      setMethod({ status: "idle" })
      return
    }

    let current = true
    setMethod({ status: "checking" })
    void getRecoveryMethod(walletId)
      .then((next) => {
        if (!current) return
        setMethod(
          next
            ? { status: "ready", method: next }
            : {
                status: "missing",
                reason:
                  "No local recovery method was found. Restore this wallet again before using it.",
              }
        )
      })
      .catch(() => {
        if (current) {
          setMethod({
            status: "missing",
            reason:
              "The local recovery method could not be read. Retry or restore this wallet again.",
          })
        }
      })
    return () => {
      current = false
    }
  }, [getRecoveryMethod, walletId])

  return method
}

function PortableWalletDialog({
  open,
  onOpenChange,
  wallets,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  wallets: UseWalletsReturn
}) {
  const [mode, setMode] = useState<PortableWalletMode>("create")
  const [label, setLabel] = useState("")
  const [password, setPassword] = useState("")
  const [mnemonic, setMnemonic] = useState("")
  const [accountNumber, setAccountNumber] = useState("")
  const [pendingAction, setPendingAction] = useState<"password" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [createdMnemonic, setCreatedMnemonic] = useState<string | null>(null)
  const [createdAccountNumber, setCreatedAccountNumber] = useState<
    number | null
  >(null)
  const [createdNetwork, setCreatedNetwork] = useState<
    WalletDescriptor["network"] | null
  >(null)
  const [recoverySaved, setRecoverySaved] = useState(false)
  const [recoveryCopyStatus, setRecoveryCopyStatus] = useState<
    "idle" | "copied"
  >("idle")
  const recoveryHeadingRef = useRef<HTMLHeadingElement>(null)
  const pending = pendingAction !== null
  const sparkNetwork =
    wallets.sparkAvailability.status === "ready"
      ? wallets.sparkAvailability.network
      : null
  const passwordSubmissionError = getPortableWalletFormError({
    mode,
    label,
    password,
    mnemonic,
    accountNumber,
  })
  const reset = () => {
    setMode("create")
    setLabel("")
    setPassword("")
    setMnemonic("")
    setAccountNumber("")
    setPendingAction(null)
    setError(null)
    setCreatedMnemonic(null)
    setCreatedAccountNumber(null)
    setCreatedNetwork(null)
    setRecoverySaved(false)
    setRecoveryCopyStatus("idle")
  }

  const close = () => {
    reset()
    onOpenChange(false)
  }

  const selectMode = (nextMode: PortableWalletMode) => {
    setMode(nextMode)
    setPassword("")
    setMnemonic("")
    setAccountNumber("")
    setError(null)
  }

  useEffect(() => {
    if (open && createdMnemonic) {
      recoveryHeadingRef.current?.focus()
    }
  }, [createdMnemonic, open])

  const submitPassword = async () => {
    if (passwordSubmissionError) {
      setError(passwordSubmissionError)
      return
    }
    setPendingAction("password")
    setError(null)
    try {
      if (mode === "create") {
        const result = await wallets.createSpark(label, password)
        setPassword("")
        setCreatedMnemonic(result.mnemonic)
        setCreatedAccountNumber(result.accountNumber)
        setCreatedNetwork(result.wallet.network)
      } else {
        await wallets.importSpark({
          label,
          mnemonic,
          password,
          accountNumber: Number(accountNumber),
        })
        close()
      }
    } catch (caught) {
      setError(getErrorMessage(caught, "Could not add Spark wallet."))
    } finally {
      setPendingAction(null)
    }
  }

  const copyRecoveryBundle = async () => {
    if (
      !createdMnemonic ||
      createdAccountNumber === null ||
      createdNetwork === null
    ) {
      return
    }
    setError(null)
    setRecoveryCopyStatus("idle")
    try {
      await navigator.clipboard.writeText(
        formatSparkRecoveryBundleForClipboard({
          mnemonic: createdMnemonic,
          accountNumber: createdAccountNumber,
          network: createdNetwork,
        })
      )
      setRecoveryCopyStatus("copied")
    } catch (caught) {
      setError(getErrorMessage(caught, "Could not copy the recovery details."))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || pending) return
        if (!next && createdMnemonic && !recoverySaved) return
        if (!next) close()
      }}
    >
      <DialogContent
        showCloseButton={!pending && !createdMnemonic}
        className="max-h-[90vh] overflow-y-auto"
      >
        {createdMnemonic ? (
          <>
            <DialogHeader>
              <DialogTitle ref={recoveryHeadingRef} tabIndex={-1}>
                Save your Spark recovery details
              </DialogTitle>
              <DialogDescription>
                This recovery phrase, Spark account number, and network are the
                portable backup for this wallet. Conduit cannot recover them for
                you.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-2xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-4">
              <p className="select-all font-mono text-sm leading-7 text-[var(--text-primary)]">
                {createdMnemonic}
              </p>
              <p className="mt-3 text-sm text-[var(--text-secondary)]">
                Spark account number: {createdAccountNumber}
              </p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                Spark network:{" "}
                {createdNetwork
                  ? getWalletNetworkLabel(createdNetwork)
                  : "Unavailable"}
              </p>
            </div>
            <Button variant="outline" onClick={() => void copyRecoveryBundle()}>
              <Copy className="h-4 w-4" />
              Copy recovery details
            </Button>
            <p className="text-sm leading-5 text-[var(--text-muted)]">
              Your clipboard may be readable by other apps or synced between
              devices. Clear it after saving this backup somewhere private.
            </p>
            {recoveryCopyStatus === "copied" && (
              <p role="status" className="text-sm text-[var(--text-secondary)]">
                Copied. Clear your clipboard after saving the backup.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-[var(--text-secondary)]">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] p-3">
              <Label htmlFor="recovery-saved" className="leading-5">
                I saved the recovery phrase, Spark account number, and network
                somewhere private
              </Label>
              <Switch
                id="recovery-saved"
                checked={recoverySaved}
                onCheckedChange={setRecoverySaved}
              />
            </div>
            <DialogFooter>
              <Button disabled={!recoverySaved} onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add a Spark wallet</DialogTitle>
              <DialogDescription>
                Spark is the first Portable Wallet provider. Create a new wallet
                or restore one with its recovery phrase, Spark account number,
                and network.
              </DialogDescription>
            </DialogHeader>

            {sparkNetwork && (
              <div
                role="note"
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3"
              >
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {getWalletNetworkLabel(sparkNetwork)}
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
                  {sparkNetwork === "mainnet"
                    ? "This wallet can hold and send real bitcoin."
                    : "Test funds only. This wallet is separate from Bitcoin Mainnet."}
                </p>
              </div>
            )}

            <form
              className="contents"
              onSubmit={(event) => {
                event.preventDefault()
                void submitPassword()
              }}
            >
              <div
                role="group"
                aria-label="Spark wallet setup mode"
                className="grid grid-cols-2 gap-2 rounded-xl bg-[var(--surface)] p-1"
              >
                <Button
                  type="button"
                  variant={mode === "create" ? "primary" : "ghost"}
                  aria-pressed={mode === "create"}
                  onClick={() => selectMode("create")}
                  disabled={pending}
                >
                  Create new
                </Button>
                <Button
                  type="button"
                  variant={mode === "restore" ? "primary" : "ghost"}
                  aria-pressed={mode === "restore"}
                  onClick={() => selectMode("restore")}
                  disabled={pending}
                >
                  Restore
                </Button>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="portable-label">Wallet label</Label>
                <Input
                  id="portable-label"
                  value={label}
                  onChange={(event) => {
                    setLabel(event.target.value)
                    setError(null)
                  }}
                  placeholder="Personal"
                  autoComplete="off"
                  required
                  disabled={pending}
                  aria-invalid={error === "Enter a wallet label."}
                  aria-describedby={
                    error === "Enter a wallet label."
                      ? "portable-wallet-form-error"
                      : undefined
                  }
                />
              </div>

              {mode === "restore" && (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="portable-mnemonic">Recovery phrase</Label>
                    <Textarea
                      id="portable-mnemonic"
                      value={mnemonic}
                      onChange={(event) => {
                        setMnemonic(event.target.value)
                        setError(null)
                      }}
                      placeholder="Enter the BIP39 recovery phrase"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      required
                      disabled={pending}
                      aria-invalid={error === "Enter the recovery phrase."}
                      aria-describedby={
                        error === "Enter the recovery phrase."
                          ? "portable-wallet-form-error"
                          : undefined
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="portable-account">
                      Spark account number
                    </Label>
                    <Input
                      id="portable-account"
                      type="number"
                      min={0}
                      max={0x7fffffff}
                      step={1}
                      value={accountNumber}
                      onChange={(event) => {
                        setAccountNumber(event.target.value)
                        setError(null)
                      }}
                      disabled={pending}
                      required
                      aria-invalid={
                        error === "Enter a valid Spark account number." ||
                        error ===
                          "Enter the Spark account number from the recovery bundle."
                      }
                      aria-describedby={
                        error === "Enter a valid Spark account number." ||
                        error ===
                          "Enter the Spark account number from the recovery bundle."
                          ? "portable-wallet-form-error portable-account-help"
                          : "portable-account-help"
                      }
                    />
                    <p
                      id="portable-account-help"
                      className="text-xs leading-5 text-[var(--text-muted)]"
                    >
                      {sparkNetwork
                        ? `Enter the account number saved with the source wallet. Conduit-created ${getWalletNetworkLabel(
                            sparkNetwork
                          )} wallets use account ${
                            sparkNetwork === "regtest" ? 0 : 1
                          }.`
                        : "Enter the account number saved with the source wallet."}
                    </p>
                  </div>
                </>
              )}

              <div className="grid gap-2">
                <Label htmlFor="portable-password">Local wallet password</Label>
                <Input
                  id="portable-password"
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    setError(null)
                  }}
                  autoComplete="new-password"
                  placeholder="At least 10 characters"
                  minLength={10}
                  required
                  disabled={pending}
                  aria-invalid={
                    error ===
                    "Use at least 10 characters for the local wallet password."
                  }
                  aria-describedby={
                    error ===
                    "Use at least 10 characters for the local wallet password."
                      ? "portable-wallet-form-error portable-password-help"
                      : "portable-password-help"
                  }
                />
                <p
                  id="portable-password-help"
                  className="text-xs leading-5 text-[var(--text-muted)]"
                >
                  Encrypts the recovery phrase on this device. To restore this
                  Spark wallet, save the phrase, Spark account number, and
                  network. This password only unlocks it on this device.
                </p>
              </div>

              {error && (
                <p
                  id="portable-wallet-form-error"
                  role="alert"
                  className="text-sm text-[var(--text-secondary)]"
                >
                  {error}
                </p>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={close}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  aria-busy={pendingAction === "password"}
                  disabled={pending}
                >
                  {pendingAction === "password" && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  {mode === "create"
                    ? "Create Spark wallet"
                    : "Restore Spark wallet"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ConnectedWalletDialog({
  open,
  onOpenChange,
  wallets,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  wallets: UseWalletsReturn
}) {
  const [label, setLabel] = useState("")
  const [uri, setUri] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setLabel("")
    setUri("")
    setPending(false)
    setError(null)
    onOpenChange(false)
  }

  const submit = async () => {
    setPending(true)
    setError(null)
    try {
      await wallets.connectNwc(uri, label)
      close()
    } catch (caught) {
      setError(getErrorMessage(caught, "Could not connect wallet."))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) close()
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Connect wallet</DialogTitle>
          <DialogDescription>
            Add another external wallet using its private NWC authorization.
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="connected-label">Wallet label</Label>
            <Input
              id="connected-label"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value)
                setError(null)
              }}
              placeholder="Zeus"
              autoComplete="off"
              disabled={pending}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="nwc-uri">NWC connection string</Label>
            <Input
              id="nwc-uri"
              type="password"
              value={uri}
              onChange={(event) => {
                setUri(event.target.value)
                setError(null)
              }}
              placeholder="nostr+walletconnect://..."
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              disabled={pending}
              aria-invalid={!!error}
              aria-describedby={
                error ? "connected-wallet-form-error" : undefined
              }
            />
          </div>
          {error && (
            <p
              id="connected-wallet-form-error"
              role="alert"
              className="text-sm text-[var(--text-secondary)]"
            >
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={close}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function UnlockWalletDialog({
  wallet,
  onOpenChange,
  wallets,
}: {
  wallet: WalletDescriptor | null
  onOpenChange: (open: boolean) => void
  wallets: UseWalletsReturn
}) {
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recoveryMethod = useSparkRecoveryMethod(
    wallet?.id ?? null,
    wallets.getSparkRecoveryMethod
  )

  const close = () => {
    setPassword("")
    setPending(false)
    setError(null)
    onOpenChange(false)
  }

  const submitPassword = async () => {
    if (!wallet) return
    setPending(true)
    setError(null)
    try {
      await wallets.unlockSpark(wallet.id, password)
      close()
    } catch (caught) {
      setError(getErrorMessage(caught, "Could not unlock Portable Wallet."))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={!!wallet}
      onOpenChange={(open) => {
        if (!open && !pending) close()
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Unlock {wallet?.label}</DialogTitle>
          <DialogDescription>
            Enter the local password that encrypts this wallet&apos;s recovery
            phrase on this device.
          </DialogDescription>
        </DialogHeader>
        {recoveryMethod.status === "checking" ||
        recoveryMethod.status === "idle" ? (
          <div
            role="status"
            className="flex items-center gap-2 py-4 text-sm text-[var(--text-muted)]"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking recovery method
          </div>
        ) : recoveryMethod.status === "missing" ? (
          <p
            role="alert"
            className="text-sm leading-6 text-[var(--text-secondary)]"
          >
            {recoveryMethod.reason}
          </p>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="unlock-password">Wallet password</Label>
            <Input
              id="unlock-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              disabled={pending}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-[var(--text-secondary)]">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={pending}>
            Cancel
          </Button>
          {recoveryMethod.status === "ready" && (
            <Button
              onClick={() => void submitPassword()}
              disabled={pending || !password}
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Unlock
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReceiveWalletDialog({
  wallet,
  onOpenChange,
  wallets,
}: {
  wallet: WalletDescriptor | null
  onOpenChange: (open: boolean) => void
  wallets: UseWalletsReturn
}) {
  const [amount, setAmount] = useState("")
  const [request, setRequest] = useState("")
  const [pendingAction, setPendingAction] = useState<
    "lightning" | "spark-address" | null
  >(null)
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle"
  )
  const [requestAnnouncement, setRequestAnnouncement] = useState("")
  const [error, setError] = useState<string | null>(null)
  const pending = pendingAction !== null

  const clearRequest = (announceInvalidation = false) => {
    if (announceInvalidation && request) {
      setRequestAnnouncement(
        "Payment request cleared. Create a new request for the updated amount."
      )
    } else if (!announceInvalidation) {
      setRequestAnnouncement("")
    }
    setRequest("")
    setCopyStatus("idle")
    setError(null)
  }

  const close = () => {
    setAmount("")
    setRequest("")
    setPendingAction(null)
    setCopyStatus("idle")
    setRequestAnnouncement("")
    setError(null)
    onOpenChange(false)
  }

  const createLightningInvoice = async () => {
    if (!wallet) return
    setPendingAction("lightning")
    clearRequest()
    try {
      const amountSats = amount ? Number(amount) : undefined
      if (
        amountSats !== undefined &&
        (!Number.isSafeInteger(amountSats) || amountSats <= 0)
      ) {
        throw new Error("Enter a whole-number amount greater than zero.")
      }
      setRequest(await wallets.receiveSparkLightning(wallet.id, amountSats))
    } catch (caught) {
      setError(getErrorMessage(caught, "Could not create invoice."))
    } finally {
      setPendingAction(null)
    }
  }

  const createSparkAddress = async () => {
    if (!wallet) return
    setPendingAction("spark-address")
    setAmount("")
    clearRequest()
    try {
      setRequest(await wallets.getSparkAddress(wallet.id))
    } catch (caught) {
      setError(getErrorMessage(caught, "Could not read Spark address."))
    } finally {
      setPendingAction(null)
    }
  }

  const copyRequest = async () => {
    setCopyStatus("idle")
    try {
      await navigator.clipboard.writeText(request)
      setCopyStatus("copied")
    } catch {
      setCopyStatus("error")
    }
  }

  return (
    <Dialog
      open={!!wallet}
      onOpenChange={(open) => {
        if (!open && !pending) close()
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Receive to {wallet?.label}</DialogTitle>
          <DialogDescription>
            Lightning is the interoperable default. Direct Spark addresses are
            available as an advanced wallet-to-wallet option.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="receive-amount">Amount in sats (optional)</Label>
          <Input
            id="receive-amount"
            type="number"
            min={1}
            step={1}
            value={amount}
            aria-describedby="receive-amount-help"
            onChange={(event) => {
              setAmount(event.target.value)
              clearRequest(true)
            }}
            disabled={pending}
          />
          <p
            id="receive-amount-help"
            className="text-xs leading-5 text-[var(--text-secondary)]"
          >
            Amount applies to Lightning invoices. Spark addresses are
            amountless.
          </p>
          <p aria-live="polite" className="sr-only">
            {requestAnnouncement}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void createLightningInvoice()}
            disabled={pending}
            aria-busy={pendingAction === "lightning"}
          >
            {pendingAction === "lightning" && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Create Lightning invoice
          </Button>
          <Button
            variant="outline"
            onClick={() => void createSparkAddress()}
            disabled={pending}
            aria-busy={pendingAction === "spark-address"}
          >
            {pendingAction === "spark-address" && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Spark address
          </Button>
        </div>
        {request && (
          <div className="grid gap-2">
            <p role="status" className="sr-only">
              Payment request ready.
            </p>
            <Label htmlFor="receive-request">Payment request</Label>
            <Textarea
              id="receive-request"
              value={request}
              readOnly
              className="font-mono text-xs"
            />
            <Button
              variant="outline"
              onClick={() => void copyRequest()}
              aria-label={
                copyStatus === "copied"
                  ? "Payment request copied"
                  : "Copy payment request"
              }
            >
              {copyStatus === "copied" ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              {copyStatus === "copied" ? "Copied" : "Copy"}
            </Button>
            <p aria-live="polite" className="sr-only">
              {copyStatus === "copied" ? "Payment request copied." : ""}
            </p>
            {copyStatus === "error" && (
              <p role="alert" className="text-sm text-[var(--text-secondary)]">
                Copy was blocked. Copy the request manually.
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-[var(--text-secondary)]">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={pending}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SendWalletDialog({
  wallet,
  onOpenChange,
  wallets,
}: {
  wallet: WalletDescriptor | null
  onOpenChange: (open: boolean) => void
  wallets: UseWalletsReturn
}) {
  const [method, setMethod] = useState<"lightning" | "spark">("lightning")
  const [paymentRequest, setPaymentRequest] = useState("")
  const [amount, setAmount] = useState("")
  const [useMax, setUseMax] = useState(false)
  const [quote, setQuote] = useState<SparkSendQuote | null>(null)
  const [reviewedPaymentRequest, setReviewedPaymentRequest] = useState("")
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<"sent" | "ambiguous" | null>(null)
  const [sentMethod, setSentMethod] = useState<"lightning" | "spark" | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const lightningRequestRef = useRef<HTMLTextAreaElement>(null)
  const sparkRequestRef = useRef<HTMLInputElement>(null)
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null)
  const resultAlertRef = useRef<HTMLParagraphElement>(null)
  const successStatusRef = useRef<HTMLDivElement>(null)
  const hasUnresolvedSparkSend = wallets.hasUnresolvedSparkSend
  const acknowledgeUnresolvedSparkSend = wallets.acknowledgeUnresolvedSparkSend
  const invoiceMetadata =
    method === "lightning" && paymentRequest.trim()
      ? decodeLightningInvoiceMetadata(paymentRequest)
      : null
  const isValidInvoice =
    invoiceMetadata !== null &&
    invoiceMetadata.createdAt !== null &&
    decodeLightningInvoicePaymentHash(paymentRequest) !== null
  const isFixedAmountInvoice =
    invoiceMetadata !== null &&
    isValidInvoice &&
    invoiceMetadata.msats !== null &&
    !isAmountlessLightningInvoice(paymentRequest)
  const isAmountlessInvoice =
    isValidInvoice && isAmountlessLightningInvoice(paymentRequest)
  const hasUnsupportedSubSatAmount =
    isFixedAmountInvoice && invoiceMetadata?.sats === null
  const canPrepare =
    !pending &&
    !!paymentRequest.trim() &&
    !hasUnsupportedSubSatAmount &&
    (method !== "spark" || !!amount.trim()) &&
    (!isAmountlessInvoice || useMax || !!amount.trim())

  useEffect(() => {
    if (!wallet) {
      return
    }
    try {
      if (hasUnresolvedSparkSend(wallet.id)) {
        setOutcome("ambiguous")
        setError(
          "A previous Spark payment is unresolved. Check this wallet's payment history before clearing the safety lock."
        )
        requestAnimationFrame(() => resultAlertRef.current?.focus())
      }
    } catch (caught) {
      setOutcome("ambiguous")
      setError(
        getErrorMessage(
          caught,
          "Spark payment safety state is unavailable. Sending is disabled."
        )
      )
      requestAnimationFrame(() => resultAlertRef.current?.focus())
    }
  }, [hasUnresolvedSparkSend, wallet])

  const close = () => {
    if (wallet && quote && outcome !== "ambiguous") {
      wallets.discardSparkSendQuote(wallet.id, quote.id)
    }
    setMethod("lightning")
    setPaymentRequest("")
    setAmount("")
    setUseMax(false)
    setQuote(null)
    setReviewedPaymentRequest("")
    setPending(false)
    setOutcome(null)
    setSentMethod(null)
    setError(null)
    onOpenChange(false)
  }

  const resetQuote = (returnFocus = false) => {
    if (outcome === "ambiguous") {
      return
    }
    if (wallet && quote) {
      wallets.discardSparkSendQuote(wallet.id, quote.id)
    }
    setQuote(null)
    setReviewedPaymentRequest("")
    setOutcome(null)
    setError(null)
    if (returnFocus) {
      requestAnimationFrame(() => {
        if (method === "lightning") {
          lightningRequestRef.current?.focus()
        } else {
          sparkRequestRef.current?.focus()
        }
      })
    }
  }

  const changeMethod = (value: string) => {
    if (pending || (value !== "lightning" && value !== "spark")) return
    resetQuote()
    setMethod(value)
    setPaymentRequest("")
    setAmount("")
    setUseMax(false)
  }

  const updatePaymentRequest = (value: string) => {
    setPaymentRequest(value)
    resetQuote()
    if (method === "lightning") {
      setUseMax(false)
      setAmount("")
    }
  }

  const prepare = async () => {
    if (!wallet) return
    setPending(true)
    setError(null)
    try {
      const paymentRequestSnapshot = paymentRequest.trim()
      let request: SparkSendRequest
      if (method === "lightning") {
        request = {
          destination: {
            type: "lightning_invoice",
            invoice: paymentRequestSnapshot,
          },
          amount: useMax
            ? { type: "max" }
            : amount.trim()
              ? { type: "exact", amountSats: Number(amount) }
              : { type: "invoice" },
        }
      } else {
        request = {
          destination: {
            type: "spark_address",
            address: paymentRequestSnapshot,
          },
          amount: { type: "exact", amountSats: Number(amount) },
        }
      }
      const nextQuote = await wallets.prepareSparkSend(wallet.id, request)
      setReviewedPaymentRequest(paymentRequestSnapshot)
      setQuote(nextQuote)
      requestAnimationFrame(() => reviewHeadingRef.current?.focus())
    } catch (caught) {
      let nextError = getErrorMessage(
        caught,
        "Could not prepare the Spark payment."
      )
      try {
        if (hasUnresolvedSparkSend(wallet.id)) {
          setOutcome("ambiguous")
        }
      } catch (safetyError) {
        setOutcome("ambiguous")
        nextError = getErrorMessage(
          safetyError,
          "Spark payment safety state is unavailable. Sending is disabled."
        )
      }
      setError(nextError)
      requestAnimationFrame(() => resultAlertRef.current?.focus())
    } finally {
      setPending(false)
    }
  }

  const confirm = async () => {
    if (!wallet || !quote) return
    setPending(true)
    setError(null)
    try {
      const result = await wallets.confirmSparkSend(wallet.id, quote.id)
      if (result.status === "sent") {
        setSentMethod(result.method)
        setOutcome("sent")
        setQuote(null)
        requestAnimationFrame(() => successStatusRef.current?.focus())
        return
      }
      if (result.status === "ambiguous") {
        setOutcome("ambiguous")
      } else {
        setQuote(null)
      }
      setError(result.reason)
      requestAnimationFrame(() => resultAlertRef.current?.focus())
    } catch (caught) {
      setOutcome("ambiguous")
      setError(
        getErrorMessage(
          caught,
          "Spark payment status is unknown. Check history before trying again."
        )
      )
      requestAnimationFrame(() => resultAlertRef.current?.focus())
    } finally {
      setPending(false)
    }
  }

  const acknowledgeUnresolvedPayment = () => {
    if (!wallet) return
    setPending(true)
    setError(null)
    try {
      acknowledgeUnresolvedSparkSend(wallet.id)
      close()
    } catch (caught) {
      setError(
        getErrorMessage(
          caught,
          "Could not clear the Spark payment safety lock."
        )
      )
      requestAnimationFrame(() => resultAlertRef.current?.focus())
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={!!wallet}
      onOpenChange={(open) => {
        if (!open && !pending) close()
      }}
    >
      <DialogContent
        aria-busy={pending}
        showCloseButton={!pending}
        onEscapeKeyDown={(event) => {
          if (pending) {
            event.preventDefault()
          }
        }}
        onPointerDownOutside={(event) => {
          if (pending) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Send from {wallet?.label}</DialogTitle>
          <DialogDescription>
            Pay a Lightning invoice from this Spark Portable Wallet. Direct
            Spark address transfers remain available as an advanced option.
          </DialogDescription>
        </DialogHeader>
        {outcome === "sent" ? (
          <>
            <div
              ref={successStatusRef}
              role="status"
              tabIndex={-1}
              className="rounded-xl border border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] p-4 text-sm text-[var(--text-secondary)] outline-none"
            >
              {sentMethod === "spark"
                ? "Spark transfer sent."
                : "Lightning payment sent."}
            </div>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {outcome !== "ambiguous" &&
              (quote ? (
                <form
                  id="spark-send-confirm-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!pending) void confirm()
                  }}
                  className="rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_7%,transparent)] p-4 text-sm text-[var(--text-secondary)]"
                >
                  <h3
                    ref={reviewHeadingRef}
                    tabIndex={-1}
                    className="font-semibold text-[var(--text-primary)] outline-none"
                  >
                    Review payment
                  </h3>
                  <dl className="mt-3 grid gap-2">
                    <div className="flex items-start justify-between gap-4">
                      <dt>Method</dt>
                      <dd className="text-right font-medium text-[var(--text-primary)]">
                        {quote.method === "lightning"
                          ? "Lightning invoice"
                          : "Direct Spark address"}
                      </dd>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <dt>Send</dt>
                      <dd className="text-right font-medium text-[var(--text-primary)]">
                        {quote.amountSats.toLocaleString()} sats
                      </dd>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <dt>
                        {quote.method === "lightning"
                          ? "Maximum Lightning fee"
                          : "Fee"}
                      </dt>
                      <dd className="text-right font-medium text-[var(--text-primary)]">
                        {quote.feeSats.toLocaleString()} sats
                      </dd>
                    </div>
                    <div className="flex items-start justify-between gap-4 border-t border-[var(--border-subtle)] pt-2">
                      <dt>
                        {quote.method === "lightning"
                          ? "Maximum total"
                          : "Total"}
                      </dt>
                      <dd className="text-right font-semibold text-[var(--text-primary)]">
                        {quote.totalSats.toLocaleString()} sats
                      </dd>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <dt>
                        {quote.method === "lightning"
                          ? "Estimated remaining after maximum fee"
                          : "Estimated remaining"}
                      </dt>
                      <dd className="text-right font-medium text-[var(--text-primary)]">
                        {quote.remainingSats.toLocaleString()} sats
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                      Payment request
                    </p>
                    <code className="mt-1 block max-h-24 overflow-y-auto break-all font-mono text-xs leading-5 text-[var(--text-secondary)]">
                      {reviewedPaymentRequest}
                    </code>
                  </div>
                  {quote.amountMode === "max" && (
                    <p className="mt-3 text-xs leading-5 text-[var(--text-muted)]">
                      Max reserves the approved maximum Lightning fee and sends
                      the rest. If the final fee is lower, some sats will
                      remain.
                    </p>
                  )}
                </form>
              ) : (
                <form
                  id="spark-send-draft-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (canPrepare) void prepare()
                  }}
                  className="space-y-4"
                >
                  <Tabs value={method} onValueChange={changeMethod}>
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="lightning" disabled={pending}>
                        Lightning
                      </TabsTrigger>
                      <TabsTrigger value="spark" disabled={pending}>
                        Spark address
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="lightning" className="space-y-2">
                      <Label htmlFor="spark-send-lightning-invoice">
                        Lightning invoice
                      </Label>
                      <Textarea
                        ref={lightningRequestRef}
                        id="spark-send-lightning-invoice"
                        value={paymentRequest}
                        onChange={(event) =>
                          updatePaymentRequest(event.target.value)
                        }
                        placeholder="lnbc..."
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        disabled={pending}
                        className="min-h-24 font-mono text-xs"
                      />
                      <p className="text-xs leading-5 text-[var(--text-muted)]">
                        Paste a BOLT11 invoice from the wallet receiving the
                        funds.
                      </p>
                    </TabsContent>
                    <TabsContent value="spark" className="space-y-2">
                      <Label htmlFor="spark-send-address">
                        Direct Spark address
                      </Label>
                      <Input
                        ref={sparkRequestRef}
                        id="spark-send-address"
                        value={paymentRequest}
                        onChange={(event) =>
                          updatePaymentRequest(event.target.value)
                        }
                        placeholder="spark1..."
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        disabled={pending}
                        className="font-mono text-xs"
                      />
                      <p className="text-xs leading-5 text-[var(--text-muted)]">
                        Advanced: send directly to another compatible Spark
                        wallet without using Lightning.
                      </p>
                    </TabsContent>
                  </Tabs>
                  <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="spark-send-amount">
                        {method === "lightning" && isFixedAmountInvoice
                          ? "Invoice amount"
                          : "Amount in sats"}
                      </Label>
                      {method === "lightning" && isAmountlessInvoice && (
                        <Button
                          type="button"
                          variant={useMax ? "primary" : "outline"}
                          size="sm"
                          aria-pressed={useMax}
                          onClick={() => {
                            resetQuote()
                            setUseMax((current) => !current)
                            setAmount("")
                          }}
                          disabled={pending}
                        >
                          Max
                        </Button>
                      )}
                    </div>
                    {method === "lightning" && isFixedAmountInvoice ? (
                      <Input
                        id="spark-send-amount"
                        value={
                          invoiceMetadata?.sats === null
                            ? "Unsupported sub-sat amount"
                            : `${invoiceMetadata?.sats.toLocaleString()} sats`
                        }
                        readOnly
                        aria-invalid={hasUnsupportedSubSatAmount}
                        aria-describedby="spark-send-amount-help"
                      />
                    ) : (
                      <Input
                        id="spark-send-amount"
                        type="number"
                        min={1}
                        step={1}
                        value={amount}
                        onChange={(event) => {
                          setAmount(event.target.value)
                          resetQuote()
                        }}
                        aria-describedby="spark-send-amount-help"
                        disabled={
                          pending ||
                          useMax ||
                          (method === "lightning" && !isAmountlessInvoice)
                        }
                        placeholder={
                          method === "lightning"
                            ? paymentRequest.trim()
                              ? "Enter amount"
                              : "Paste invoice first"
                            : undefined
                        }
                      />
                    )}
                    <p
                      id="spark-send-amount-help"
                      className="text-xs leading-5 text-[var(--text-muted)]"
                    >
                      {method === "spark"
                        ? "Direct Spark transfers require an exact amount."
                        : isFixedAmountInvoice
                          ? hasUnsupportedSubSatAmount
                            ? "Sub-sat Lightning invoices are not supported. Request a whole-sat invoice."
                            : "This amount is encoded in the invoice and cannot be changed."
                          : isAmountlessInvoice
                            ? useMax
                              ? "Max reserves the approved maximum Lightning fee and sends the rest. If the final fee is lower, some sats will remain."
                              : "Enter an amount or choose Max for this amountless invoice."
                            : "Paste a valid Lightning invoice to use its amount or enter sats for an amountless invoice."}
                    </p>
                  </div>
                </form>
              ))}
            {error && (
              <p
                ref={resultAlertRef}
                role="alert"
                tabIndex={-1}
                className={
                  outcome === "ambiguous"
                    ? "rounded-xl border border-[color-mix(in_srgb,var(--warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--warning)_6%,transparent)] px-3 py-2 text-sm leading-6 text-[var(--text-secondary)] outline-none"
                    : "text-sm text-[var(--text-secondary)] outline-none"
                }
              >
                {error}
                {outcome === "ambiguous" && (
                  <span className="mt-2 block font-medium text-[var(--text-primary)]">
                    If a matching payment appears in history, do not retry. Only
                    clear the lock after confirming no matching payment exists.
                  </span>
                )}
              </p>
            )}
            <DialogFooter>
              {outcome === "ambiguous" ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={close}
                    disabled={pending}
                    className="w-full whitespace-normal sm:w-auto"
                  >
                    Close and check history
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={acknowledgeUnresolvedPayment}
                    disabled={pending}
                    className="w-full whitespace-normal sm:w-auto"
                  >
                    {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                    {pending ? "Clearing…" : "No matching payment; allow retry"}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={close}
                  disabled={pending}
                >
                  Cancel
                </Button>
              )}
              {quote && outcome !== "ambiguous" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => resetQuote(true)}
                    disabled={pending}
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    form="spark-send-confirm-form"
                    disabled={pending}
                  >
                    {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                    {pending
                      ? "Sending…"
                      : `Send ${quote.amountSats.toLocaleString()} sats`}
                  </Button>
                </>
              ) : outcome !== "ambiguous" ? (
                <Button
                  type="submit"
                  form="spark-send-draft-form"
                  disabled={!canPrepare}
                >
                  {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {pending ? "Preparing…" : "Review payment"}
                </Button>
              ) : null}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function WalletHistoryDialog({
  wallet,
  onOpenChange,
  wallets,
}: {
  wallet: WalletDescriptor | null
  onOpenChange: (open: boolean) => void
  wallets: UseWalletsReturn
}) {
  const [payments, setPayments] = useState<SparkPaymentSummary[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestVersion, setRequestVersion] = useState(0)
  const listSparkPayments = wallets.listSparkPayments

  useEffect(() => {
    if (!wallet) {
      setPayments([])
      setPending(false)
      setError(null)
      return
    }
    let active = true
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    setPayments([])
    setPending(true)
    setError(null)
    const historyRequest = Promise.race([
      listSparkPayments(wallet.id),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              "Payment history took too long to load. Check your connection and try again."
            )
          )
        }, SPARK_HISTORY_LOAD_TIMEOUT_MS)
      }),
    ])
    void historyRequest
      .then((nextPayments) => {
        if (active) setPayments(nextPayments)
      })
      .catch((caught) => {
        if (active) {
          setError(getErrorMessage(caught, "Could not load payment history."))
        }
      })
      .finally(() => {
        if (timeoutId !== null) clearTimeout(timeoutId)
        if (active) setPending(false)
      })
    return () => {
      active = false
      if (timeoutId !== null) clearTimeout(timeoutId)
    }
  }, [listSparkPayments, requestVersion, wallet])

  const close = () => {
    setPayments([])
    setPending(false)
    setError(null)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={!!wallet}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{wallet?.label} history</DialogTitle>
          <DialogDescription>
            Recent activity reported by this Spark wallet.
          </DialogDescription>
        </DialogHeader>
        {pending ? (
          <div
            role="status"
            className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading history
          </div>
        ) : error ? (
          <div className="grid justify-items-start gap-3">
            <p role="alert" className="text-sm text-[var(--text-secondary)]">
              {error}
            </p>
            <Button
              variant="outline"
              onClick={() => setRequestVersion((current) => current + 1)}
            >
              <RefreshCw className="h-4 w-4" />
              Retry history
            </Button>
          </div>
        ) : payments.length === 0 ? (
          <p role="status" className="py-6 text-sm text-[var(--text-muted)]">
            No payment history yet.
          </p>
        ) : (
          <div className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
            {payments.map((payment) => (
              <div
                key={payment.id}
                className="flex items-center justify-between gap-4 p-3"
              >
                <div>
                  <div className="text-sm font-medium capitalize text-[var(--text-primary)]">
                    {payment.paymentType} via {payment.method}
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    {formatSparkTimestamp(payment.timestamp)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    {payment.paymentType === "send" ? "-" : "+"}
                    {payment.amountSats.toLocaleString()} sats
                  </div>
                  <StatusPill
                    variant={
                      payment.status === "completed"
                        ? "success"
                        : payment.status === "pending"
                          ? "warning"
                          : "error"
                    }
                  >
                    {payment.status}
                  </StatusPill>
                </div>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RecoveryWalletDialog({
  wallet,
  onOpenChange,
  wallets,
}: {
  wallet: WalletDescriptor | null
  onOpenChange: (open: boolean) => void
  wallets: UseWalletsReturn
}) {
  const [password, setPassword] = useState("")
  const [mnemonic, setMnemonic] = useState("")
  const [accountNumber, setAccountNumber] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recoveryCopyStatus, setRecoveryCopyStatus] = useState<
    "idle" | "copied"
  >("idle")
  const recoveryMethod = useSparkRecoveryMethod(
    wallet?.id ?? null,
    wallets.getSparkRecoveryMethod
  )

  const close = () => {
    setPassword("")
    setMnemonic("")
    setAccountNumber(null)
    setPending(false)
    setError(null)
    setRecoveryCopyStatus("idle")
    onOpenChange(false)
  }

  const revealPassword = async () => {
    if (!wallet) return
    setPending(true)
    setError(null)
    try {
      const recovery = await wallets.revealSparkRecovery(wallet.id, password)
      setMnemonic(recovery.mnemonic)
      setAccountNumber(recovery.accountNumber)
      setRecoveryCopyStatus("idle")
      setPassword("")
    } catch (caught) {
      setError(getErrorMessage(caught, "Could not show recovery phrase."))
    } finally {
      setPending(false)
    }
  }

  const copyRecoveryBundle = async () => {
    if (!wallet || !mnemonic || accountNumber === null) return
    setError(null)
    setRecoveryCopyStatus("idle")
    try {
      await navigator.clipboard.writeText(
        formatSparkRecoveryBundleForClipboard({
          mnemonic,
          accountNumber,
          network: wallet.network,
        })
      )
      setRecoveryCopyStatus("copied")
    } catch (caught) {
      setError(getErrorMessage(caught, "Could not copy the recovery details."))
    }
  }

  return (
    <Dialog
      open={!!wallet}
      onOpenChange={(open) => {
        if (!open && !pending) close()
      }}
    >
      <DialogContent showCloseButton={!mnemonic && !pending}>
        <DialogHeader>
          <DialogTitle>Recovery for {wallet?.label}</DialogTitle>
          <DialogDescription>
            Keep this BIP39 phrase, Spark account number, and network together
            as the standards-based recovery bundle for this Portable Wallet.
            Keep it private.
          </DialogDescription>
        </DialogHeader>
        {wallet && mnemonic ? (
          <>
            <div className="rounded-2xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-4">
              <p className="select-all font-mono text-sm leading-7 text-[var(--text-primary)]">
                {mnemonic}
              </p>
              <p className="mt-3 text-sm text-[var(--text-secondary)]">
                Spark account number: {accountNumber}
              </p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                Spark network: {getWalletNetworkLabel(wallet.network)}
              </p>
            </div>
            <Button variant="outline" onClick={() => void copyRecoveryBundle()}>
              <Copy className="h-4 w-4" />
              Copy recovery details
            </Button>
            <p className="text-sm leading-5 text-[var(--text-muted)]">
              Your clipboard may be readable by other apps or synced between
              devices. Clear it after saving this backup somewhere private.
            </p>
            {recoveryCopyStatus === "copied" && (
              <p role="status" className="text-sm text-[var(--text-secondary)]">
                Copied. Clear your clipboard after saving the backup.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-[var(--text-secondary)]">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {recoveryMethod.status === "checking" ||
            recoveryMethod.status === "idle" ? (
              <div
                role="status"
                className="flex items-center gap-2 py-4 text-sm text-[var(--text-muted)]"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking recovery method
              </div>
            ) : recoveryMethod.status === "missing" ? (
              <p
                role="alert"
                className="text-sm leading-6 text-[var(--text-secondary)]"
              >
                {recoveryMethod.reason}
              </p>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="recovery-password">Wallet password</Label>
                <Input
                  id="recovery-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  disabled={pending}
                />
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-[var(--text-secondary)]">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={close} disabled={pending}>
                Cancel
              </Button>
              {recoveryMethod.status === "ready" && (
                <Button
                  onClick={() => void revealPassword()}
                  disabled={pending || !password}
                >
                  {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Show recovery phrase
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RemoveWalletDialog({
  wallet,
  onOpenChange,
  wallets,
}: {
  wallet: WalletDescriptor | null
  onOpenChange: (open: boolean) => void
  wallets: UseWalletsReturn
}) {
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setConfirmed(false)
    setPending(false)
    setError(null)
    onOpenChange(false)
  }

  const remove = async () => {
    if (!wallet) return
    setPending(true)
    setError(null)
    try {
      await wallets.removeWallet(wallet.id, {
        recoveryConfirmed: wallet.kind !== "portable" || confirmed,
      })
      close()
    } catch (caught) {
      setError(getErrorMessage(caught, "Could not remove wallet."))
    } finally {
      setPending(false)
    }
  }

  const portable = wallet?.kind === "portable"
  return (
    <AlertDialog
      open={!!wallet}
      onOpenChange={(open) => {
        if (!open && !pending) close()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {portable ? "Remove from this device?" : "Disconnect wallet?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {portable
              ? "This removes the wallet registration and encrypted recovery copy from this browser. It does not delete the Portable Wallet or move its funds."
              : "This removes the private NWC authorization from this browser. The external wallet and its funds are unchanged."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {portable && (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_7%,transparent)] p-3">
            <Label htmlFor="remove-recovery" className="leading-5">
              I have the recovery details required to restore this Portable
              Wallet
            </Label>
            <Switch
              id="remove-recovery"
              checked={confirmed}
              onCheckedChange={setConfirmed}
              disabled={pending}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-[var(--text-secondary)]">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <Button variant="ghost" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void remove()}
            disabled={pending || (portable && !confirmed)}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {portable ? "Remove from this device" : "Disconnect"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function PriceDisplaySettings() {
  const shopperPricing = useShopperPricing()
  return (
    <section className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <WalletCards className="h-4 w-4 text-[var(--text-muted)]" />
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
          Price display
        </h2>
      </div>
      <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
        This changes labels only; listings, invoices, and payments keep their
        original values.
      </p>
      <div className="mt-4 grid gap-5 sm:grid-cols-2 sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="display-currency">Preferred currency</Label>
          <Select
            value={shopperPricing.preference.currency}
            onValueChange={(value) =>
              shopperPricing.setCurrency(value as ShopperDisplayCurrency)
            }
          >
            <SelectTrigger id="display-currency" className="h-11 rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_SHOPPER_DISPLAY_CURRENCIES.map((currency) => (
                <SelectItem key={currency} value={currency}>
                  {currency === "BITCOIN" ? "Bitcoin (₿ base units)" : currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex h-11 items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4">
          <Label
            htmlFor="sats-standard"
            className="cursor-pointer text-sm font-medium"
          >
            Sats the standard
          </Label>
          <Switch
            id="sats-standard"
            checked={shopperPricing.preference.bitcoinUnit === "sats"}
            onCheckedChange={shopperPricing.setSatsStandard}
          />
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-[var(--text-muted)]">
        ₿10,000 equals 10,000 sats. This preference changes labels only; it
        never changes a listing, order, invoice, or payment.
      </p>
    </section>
  )
}

function lockedRuntime(): WalletRuntimeState {
  return { status: "locked", balanceMsats: null, error: null }
}

function formatSparkTimestamp(timestamp: number): string {
  const timestampMs = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
  return new Date(timestampMs).toLocaleString()
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
