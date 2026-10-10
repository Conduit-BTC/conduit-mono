import { walletAddressStatus } from "./wallet-address-status"
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  type AuthContextValue,
  type BreezAddressState,
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  getWalletDisplayLabels,
  isAmountlessLightningInvoice,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  StatusPill,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "../index"

import type { WalletAddressSuggestion } from "@conduit/core/hooks/useWalletAddress"
import { SparkLightningAddress } from "./SparkLightningAddress"
import { SparkRecoveryBundleDetails } from "./SparkRecoveryBundleDetails"
import {
  type UseWalletsReturn,
  type WalletRuntimeState,
} from "@conduit/core/hooks/useWallets"
import type { NwcSessionSnapshot } from "@conduit/core/wallets/buyer-nwc-session"
import {
  resolvePortableWalletAccountNumber,
  type PortableWalletMode,
} from "@conduit/core/wallets/portable-wallet-form"
import { MAX_SPARK_ACCOUNT_NUMBER } from "@conduit/core/wallets/spark-recovery"
import type { SparkRecoveryBundle } from "@conduit/core/wallets/spark-recovery-bundle"
import { getDefaultSparkAccountNumber } from "@conduit/core/wallets/portable-wallet-form"
import type {
  SparkPaymentSummary,
  SparkSendQuote,
  SparkSendRequest,
} from "@conduit/core/wallets/spark-wallet"
import { getWalletProviderDescription } from "@conduit/core/wallets/wallet-provider-label"

type SparkRecoveryState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; method: "signer" | "password"; legacyPassword?: boolean }
  | { status: "missing"; reason: string }

const SPARK_HISTORY_LOAD_TIMEOUT_MS = 15_000

export function Wallets({
  auth,
  wallets,
  renderAddressEditor,
  formatSats,
  footer,
}: {
  auth: AuthContextValue
  wallets: UseWalletsReturn
  renderAddressEditor(
    suggestion: WalletAddressSuggestion | null,
    onDismiss: () => void
  ): React.ReactNode
  formatSats(sats: number): string
  footer?: React.ReactNode
}) {
  const [setupMode, setSetupMode] = useState<PortableWalletMode>("create")
  const [suggestion, setSuggestion] = useState<WalletAddressSuggestion | null>(
    null
  )
  const [renameWallet, setRenameWallet] = useState<WalletDescriptor | null>(
    null
  )
  const walletsHeadingRef = useRef<HTMLHeadingElement>(null)
  const dialogTriggerRef = useRef<HTMLButtonElement | null>(null)
  const signerReady =
    auth.signerReadiness === "ready" && wallets.signerUnlockSupported
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
  useLayoutEffect(() => {
    setSuggestion(null)
    setPortableOpen(false)
    setUnlockWallet(null)
    setRecoveryWallet(null)
    setReceiveWallet(null)
    setSendWallet(null)
    setHistoryWallet(null)
    setRemoveWallet(null)
    setRenameWallet(null)
  }, [auth.accountPubkey, auth.authGeneration])
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
                <h1
                  ref={walletsHeadingRef}
                  tabIndex={-1}
                  className="mt-3 font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl"
                >
                  Wallets
                </h1>
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
                <p className="font-medium">My wallets are unavailable</p>
                <p className="mt-1">{wallets.sparkAvailability.reason}</p>
              </div>
            ) : null}

            {!wallets.initializationError && (
              <>
                <WalletSection
                  title="My wallets"
                  description={
                    signerReady
                      ? `Self-custodial. Opens with your Nostr sign-in. No separate wallet password. Encrypted recovery syncs through relays between apps.${wallets.hasPasswordWallets ? " Older wallets need their existing password until migrated." : ""}`
                      : "Self-custodial. Connect a Nostr signer with NIP-44 encryption to create or import a wallet."
                  }
                  empty="Create or import your first wallet."
                  actions={
                    <div className="grid gap-2">
                      {wallets.sparkAvailability.status === "ready" &&
                        wallets.sparkAvailability.network === "mainnet" && (
                          <p className="text-sm text-[var(--text-secondary)]">
                            Mainnet uses real bitcoin. Save your recovery
                            details before receiving funds.
                          </p>
                        )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={
                            wallets.loading ||
                            wallets.sparkAvailability.status !== "ready" ||
                            !signerReady
                          }
                          onClick={(event) => {
                            dialogTriggerRef.current = event.currentTarget
                            setSetupMode("create")
                            setPortableOpen(true)
                          }}
                        >
                          <Plus className="size-4" />
                          Create wallet
                        </Button>
                        <Button
                          variant="outline"
                          disabled={
                            wallets.loading ||
                            wallets.sparkAvailability.status !== "ready" ||
                            !signerReady
                          }
                          onClick={(event) => {
                            dialogTriggerRef.current = event.currentTarget
                            setSetupMode("restore")
                            setPortableOpen(true)
                          }}
                        >
                          Import wallet
                        </Button>
                      </div>
                    </div>
                  }
                  addressResolver={wallets.getSparkLightningAddress}
                  onRename={(wallet, trigger) =>
                    openWalletDialog(setRenameWallet, wallet, trigger)
                  }
                  loading={wallets.loading}
                  wallets={wallets.portableWallets}
                  runtime={wallets.runtime}
                  nwcSnapshots={wallets.nwcSnapshots}
                  providerActionsDisabled={
                    wallets.sparkAvailability.status !== "ready"
                  }
                  formatSats={formatSats}
                  onDefault={wallets.setDefaultPaymentWallet}
                  onReceiving={wallets.setReceivingWallet}
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
                  title="External wallets"
                  actions={
                    <Button
                      variant="outline"
                      disabled={wallets.loading}
                      onClick={(event) => {
                        dialogTriggerRef.current = event.currentTarget
                        setConnectedOpen(true)
                      }}
                    >
                      <Link2 className="size-4" />
                      Connect wallet
                    </Button>
                  }
                  onRename={(wallet, trigger) =>
                    openWalletDialog(setRenameWallet, wallet, trigger)
                  }
                  description="External wallets authorized through Nostr Wallet Connect."
                  empty="No external wallets connected."
                  loading={wallets.loading}
                  wallets={wallets.connectedWallets}
                  runtime={wallets.runtime}
                  nwcSnapshots={wallets.nwcSnapshots}
                  formatSats={formatSats}
                  onDefault={wallets.setDefaultPaymentWallet}
                  onReceiving={wallets.setReceivingWallet}
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

        <RecoverySyncNotice wallets={wallets} />
        {renderAddressEditor(suggestion, () => setSuggestion(null))}
        {footer}

        <div className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm leading-6 text-[var(--text-secondary)]">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-1 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
            <p>
              New wallet recovery is encrypted to your Nostr identity and saved
              on recovery relays. Save your phrase, account number and network
              to recover elsewhere. Your Nostr signer can see the recovery
              details when encrypting or opening the wallet. External wallet
              authorizations are stored on this device. Copying a recovery
              phrase puts it on your system clipboard, where other apps or sync
              services may retain it. Never include wallet secrets in support
              reports, telemetry, screenshots, or public issues.
            </p>
          </div>
          <a
            href="https://docs.spark.money/wallets/identity-key-derivation"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-sm underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
          >
            About wallet recovery
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      <PortableWalletDialog
        auth={auth}
        key={`${auth.accountPubkey}:${auth.authGeneration}:${setupMode}`}
        open={portableOpen}
        onOpenChange={(open) => {
          setPortableOpen(open)
          if (!open) restoreDialogFocus()
        }}
        wallets={wallets}
        mode={setupMode}
        onSaved={setSuggestion}
      />
      <RenameWalletDialog
        key={`${auth.accountPubkey}:${auth.authGeneration}:${renameWallet?.id ?? "closed"}`}
        wallet={renameWallet}
        wallets={wallets}
        onOpenChange={(open) => {
          if (!open) {
            setRenameWallet(null)
            restoreDialogFocus()
          }
        }}
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
        signerReady={signerReady}
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
        key={`${auth.accountPubkey}:${auth.authGeneration}`}
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

function RecoverySyncNotice({ wallets }: { wallets: UseWalletsReturn }) {
  return (
    <>
      {wallets.recoverySync !== "idle" && wallets.recoverySync !== "ready" && (
        <section
          role="status"
          className="grid gap-3 rounded-2xl border border-[var(--border)] p-5"
        >
          <p>
            {wallets.recoverySync === "checking"
              ? "Checking encrypted wallet recovery…"
              : wallets.recoverySync === "blocked"
                ? "Wallet recovery is incomplete or conflicting. Existing wallets remain usable. Retry before setting up another wallet."
                : "Recovery sync is pending. Save your recovery details before switching apps."}
          </p>
          {wallets.hasPasswordWallets && (
            <p className="text-sm">
              Older wallets stay on this device until you open them and choose
              Nostr sign-in.
            </p>
          )}
          <p className="text-sm text-[var(--text-secondary)]">
            Sync encrypts your wallet recovery to your Nostr identity and saves
            it on recovery relays, so you can open the same wallet in Market and
            Merchant.
          </p>
          <Button
            variant="outline"
            disabled={wallets.recoverySync === "checking"}
            onClick={() => void wallets.retryRecovery().catch(() => undefined)}
          >
            Sync wallet recovery
          </Button>
        </section>
      )}
    </>
  )
}

function WalletSection({
  title,
  description,
  empty,
  loading,
  wallets,
  runtime,
  nwcSnapshots,
  providerActionsDisabled = false,
  actions,
  addressResolver,
  onRename,
  formatSats,
  onDefault,
  onReceiving,
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
  actions?: React.ReactNode
  addressResolver?: UseWalletsReturn["getSparkLightningAddress"]
  onRename: WalletDialogAction
  formatSats: (sats: number) => string
  onDefault: (walletId: string) => Promise<void>
  onReceiving: (walletId: string) => Promise<void>
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
          <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
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

      <div className="mt-3">{actions}</div>
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
                addressResolver={addressResolver}
                onRename={onRename}
                onDefault={onDefault}
                onReceiving={onReceiving}
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
  onReceiving,
  onRefresh,
  onUnlock,
  onRecovery,
  onLock,
  onReceive,
  onSend,
  onHistory,
  onRemove,
  onRename,
  addressResolver,
}: {
  wallet: WalletDescriptor
  displayLabel: string
  runtime: WalletRuntimeState
  nwcSnapshot?: NwcSessionSnapshot
  providerActionsDisabled: boolean
  formatSats: (sats: number) => string
  onDefault: (walletId: string) => Promise<void>
  onReceiving: (walletId: string) => Promise<void>
  onRefresh: (walletId: string) => Promise<void>
  onUnlock: WalletDialogAction
  onRecovery: WalletDialogAction
  onLock: (walletId: string) => Promise<void>
  onReceive: WalletDialogAction
  onSend: WalletDialogAction
  onHistory: WalletDialogAction
  onRemove: WalletDialogAction
  onRename: WalletDialogAction
  addressResolver?: UseWalletsReturn["getSparkLightningAddress"]
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const isSpark = wallet.providerId === "spark"
  const ready = runtime.status === "ready" && !providerActionsDisabled
  const isDefault = wallet.defaultIntents.includes("pay_invoice")
  const run = async (action: () => Promise<void>) => {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(getErrorMessage(caught, "Wallet action failed."))
    } finally {
      setPending(false)
    }
  }
  const dialog = (action: WalletDialogAction) => {
    if (menuTrigger.current) action(wallet, menuTrigger.current)
  }
  return (
    <div className="grid gap-3 p-4 sm:p-5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium">{displayLabel}</h3>
            {isDefault && (
              <StatusPill variant="info">Default spending</StatusPill>
            )}
            <WalletRuntimePill runtime={runtime} />
          </div>
          <p className="mt-1 text-sm tabular-nums">
            {runtime.balanceMsats === null
              ? "Balance unavailable"
              : formatSats(Math.floor(runtime.balanceMsats / 1000))}
          </p>
          {!isSpark && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {getWalletProviderDescription(wallet)}
            </p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={menuTrigger}
              size="icon"
              variant="ghost"
              aria-label={`Manage ${displayLabel}`}
              disabled={pending}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => dialog(onRename)}>
              Rename
            </DropdownMenuItem>
            {!isDefault && wallet.capabilities.includes("pay_invoice") && (
              <DropdownMenuItem
                onSelect={() => void run(() => onDefault(wallet.id))}
              >
                Use for spending
              </DropdownMenuItem>
            )}
            {wallet.capabilities.includes("receive") &&
              !wallet.defaultIntents.includes("receive") && (
                <DropdownMenuItem
                  onSelect={() => void run(() => onReceiving(wallet.id))}
                >
                  Use for new invoices
                </DropdownMenuItem>
              )}
            {isSpark && (
              <DropdownMenuItem onSelect={() => dialog(onRecovery)}>
                Recovery details
              </DropdownMenuItem>
            )}
            {isSpark && ready && (
              <DropdownMenuItem onSelect={() => dialog(onHistory)}>
                History
              </DropdownMenuItem>
            )}
            {ready && (
              <DropdownMenuItem
                onSelect={() => void run(() => onRefresh(wallet.id))}
              >
                Refresh balance
              </DropdownMenuItem>
            )}
            {isSpark && ready && (
              <DropdownMenuItem
                onSelect={() => void run(() => onLock(wallet.id))}
              >
                Lock
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => dialog(onRemove)}>
              {isSpark ? "Remove from this device" : "Disconnect"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {isSpark && addressResolver && (
        <WalletReceivingAddress
          walletId={wallet.id}
          runtime={runtime}
          onPendingChange={setPending}
          ready={ready}
          resolve={addressResolver}
        />
      )}
      {!isSpark && (
        <p className="text-sm text-[var(--text-secondary)]">
          {nwcSnapshot?.info?.lud16
            ? `Receiving address: ${nwcSnapshot.info.lud16}. `
            : ""}
          Choose this wallet at checkout.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {isSpark && !ready ? (
          <Button
            size="sm"
            variant="outline"
            disabled={
              pending ||
              providerActionsDisabled ||
              runtime.status === "connecting"
            }
            onClick={(event) => onUnlock(wallet, event.currentTarget)}
          >
            Open wallet
          </Button>
        ) : (
          <>
            {isSpark && (
              <Button
                size="sm"
                variant="outline"
                disabled={!ready || pending}
                onClick={(event) => onReceive(wallet, event.currentTarget)}
              >
                <ArrowDownToLine className="size-4" />
                Receive
              </Button>
            )}
            {isSpark && (
              <Button
                size="sm"
                variant="outline"
                disabled={!ready || pending}
                onClick={(event) => onSend(wallet, event.currentTarget)}
              >
                <ArrowUpFromLine className="size-4" />
                Send
              </Button>
            )}
          </>
        )}
      </div>
      {(error || runtime.error) && (
        <p role="alert" className="text-sm">
          {error ?? runtime.error}
        </p>
      )}
    </div>
  )
}

function WalletReceivingAddress({
  walletId,
  onPendingChange,
  runtime,
  ready,
  resolve,
}: {
  walletId: string
  runtime: WalletRuntimeState
  onPendingChange(pending: boolean): void
  ready: boolean
  resolve: UseWalletsReturn["getSparkLightningAddress"]
}) {
  const [state, setState] = useState<BreezAddressState | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!ready) return
    let active = true
    void resolve(walletId)
      .then((value) => {
        if (active) setState(value)
      })
      .catch(() => {
        if (active)
          setState({ status: "unavailable", reason: "provider_unavailable" })
      })
    return () => {
      active = false
    }
  }, [ready, resolve, walletId, runtime])
  const retry = async () => {
    setPending(true)
    onPendingChange(true)
    try {
      setState(await resolve(walletId, true))
    } catch {
      setState({ status: "unavailable", reason: "provider_unavailable" })
    } finally {
      setPending(false)
      onPendingChange(false)
    }
  }
  const canRetry =
    ready &&
    state !== null &&
    state.status !== "registered" &&
    !(
      state.status === "unavailable" &&
      [
        "unconfigured",
        "unsupported_network",
        "invalid_configuration",
        "locked",
      ].includes(state.reason)
    )
  return (
    <div className="grid gap-1 text-sm">
      <p className="break-all text-[var(--text-secondary)]">
        Receiving address:{" "}
        {state?.status === "registered"
          ? state.address
          : ready
            ? walletAddressStatus(state)
            : "Open wallet to check"}
      </p>
      {canRetry && (
        <>
          <p className="text-xs text-[var(--text-muted)]">
            Address setup is pending. You can still receive an invoice.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            disabled={pending}
            onClick={() => void retry()}
          >
            {pending ? "Checking…" : "Retry address setup"}
          </Button>
        </>
      )}
      {state?.status === "registered" && state.publicLookup !== "verified" && (
        <p className="text-xs">
          Receiving availability needs verification. Open Receive to retry.
        </p>
      )}
    </div>
  )
}

function RenameWalletDialog({
  wallet,
  wallets,
  onOpenChange,
}: {
  wallet: WalletDescriptor | null
  wallets: UseWalletsReturn
  onOpenChange(open: boolean): void
}) {
  const [name, setName] = useState(wallet?.label ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  return (
    <Dialog open={!!wallet} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename wallet</DialogTitle>
        </DialogHeader>
        <Label htmlFor="wallet-name">Wallet name</Label>
        <Input
          id="wallet-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
        />
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={pending || !name.trim()}
            onClick={async () => {
              if (!wallet) return
              setPending(true)
              try {
                await wallets.renameWallet(wallet.id, name)
                onOpenChange(false)
              } catch (caught) {
                setError(getErrorMessage(caught, "Could not rename wallet."))
              } finally {
                setPending(false)
              }
            }}
          >
            Save name
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function useSparkRecoveryState(
  walletId: string | null,
  hasRecovery: UseWalletsReturn["getSparkRecoveryType"]
): SparkRecoveryState {
  const [state, setState] = useState<SparkRecoveryState>({
    status: "idle",
  })

  useEffect(() => {
    if (!walletId) {
      setState({ status: "idle" })
      return
    }

    let current = true
    setState({ status: "checking" })
    void hasRecovery(walletId)
      .then((available) => {
        if (!current) return
        setState(
          available
            ? {
                status: "ready",
                method:
                  available === "signer-with-password-fallback"
                    ? "signer"
                    : available,
                legacyPassword: available === "signer-with-password-fallback",
              }
            : {
                status: "missing",
                reason:
                  "No local recovery method was found. Restore this wallet again before using it.",
              }
        )
      })
      .catch(() => {
        if (current) {
          setState({
            status: "missing",
            reason:
              "The local recovery method could not be read. Retry or restore this wallet again.",
          })
        }
      })
    return () => {
      current = false
    }
  }, [hasRecovery, walletId])

  return state
}

function PortableWalletDialog({
  auth,
  open,
  onOpenChange,
  wallets,
  mode,
  onSaved,
}: {
  auth: AuthContextValue
  open: boolean
  onOpenChange(open: boolean): void
  wallets: UseWalletsReturn
  mode: PortableWalletMode
  onSaved(suggestion: WalletAddressSuggestion): void
}) {
  const { authGeneration, isAuthGenerationCurrent } = auth
  const network =
    wallets.sparkAvailability.status === "ready"
      ? wallets.sparkAvailability.network
      : null
  const defaultAccount = network ? getDefaultSparkAccountNumber(network) : 1
  const [mnemonic, setMnemonic] = useState("")
  const [accountNumber, setAccountNumber] = useState(String(defaultAccount))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<SparkRecoveryBundle | null>(null)
  const [saved, setSaved] = useState(false)
  const [address, setAddress] = useState<BreezAddressState | null>(null)
  const [recoveredFromRelay, setRecoveredFromRelay] = useState(false)
  const [firstWallet, setFirstWallet] = useState(false)
  const started = useRef(false)
  const runScope = useRef(0)
  const close = () => {
    runScope.current++
    started.current = false
    setMnemonic("")
    setAccountNumber(String(defaultAccount))
    setRecovery(null)
    setAddress(null)
    setSaved(false)
    setError(null)
    onOpenChange(false)
  }
  const submit = useCallback(async () => {
    const scope = ++runScope.current
    const generation = authGeneration
    const current = () =>
      runScope.current === scope && isAuthGenerationCurrent(generation)
    setPending(true)
    setError(null)
    try {
      const first = wallets.portableWallets.length === 0
      let wallet: WalletDescriptor
      let bundle: SparkRecoveryBundle
      if (mode === "create") {
        const result = await wallets.createSpark()
        if (current())
          setRecoveredFromRelay(
            result.recovered === true || result.publicDefaultAllowed === false
          )
        wallet = result.wallet
        bundle = {
          mnemonic: result.mnemonic,
          accountNumber: result.accountNumber,
          network: wallet.network,
        }
      } else {
        const number = resolvePortableWalletAccountNumber(
          accountNumber,
          defaultAccount
        )
        wallet = await wallets.importSpark({
          label: "",
          mnemonic,
          accountNumber: number,
        })
        const revealed = await wallets.revealSparkRecovery(wallet.id)
        bundle = { ...revealed, network: wallet.network }
      }
      if (!current()) return
      setFirstWallet(first)
      setMnemonic("")
      setRecovery(bundle)
      const value = await wallets.getSparkLightningAddress(wallet.id)
      if (current()) setAddress(value)
    } catch (caught) {
      if (current())
        setError(getErrorMessage(caught, "Could not set up wallet."))
    } finally {
      setPending(false)
    }
  }, [
    authGeneration,
    isAuthGenerationCurrent,
    wallets,
    mode,
    mnemonic,
    accountNumber,
    defaultAccount,
  ])
  useEffect(() => {
    if (!open) return
    if (mode === "create" && !started.current) {
      started.current = true
      void submit()
    }
  }, [open, mode, submit])
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending && (!recovery || saved)) close()
      }}
    >
      <DialogContent
        showCloseButton={!pending && !recovery}
        className="max-h-[90dvh]"
      >
        <DialogHeader>
          <DialogTitle>
            {recovery
              ? "Save your recovery details"
              : mode === "create"
                ? "Creating your wallet"
                : "Import wallet"}
          </DialogTitle>
          <DialogDescription>
            {recovery
              ? "Keep the recovery phrase, actual Spark account number and network together somewhere private. They restore this wallet on another device."
              : "Your Nostr signer opens this wallet. No separate wallet password."}
          </DialogDescription>
        </DialogHeader>
        {recovery ? (
          <>
            <SparkRecoveryBundleDetails {...recovery} />
            {address?.status === "registered" ? (
              <p className="break-all text-sm">
                Receiving address: {address.address}.{" "}
                {mode === "restore" || recoveredFromRelay
                  ? "Payments to an existing address continue reaching this recovered wallet. Your public profile address stays unchanged unless you choose to change it in Wallets."
                  : firstWallet
                    ? "If your profile has no receiving address, this becomes its public default after you save these recovery details. An existing profile address stays unchanged until you choose to replace it in Wallets."
                    : "Your public profile receiving address stays unchanged."}
              </p>
            ) : (
              <p className="text-sm">
                Address setup is pending. Your wallet is usable; retry from its
                card.
              </p>
            )}
            <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] p-3">
              <Label htmlFor="recovery-saved">
                I saved the phrase, Spark account number and network somewhere
                private
              </Label>
              <Switch
                id="recovery-saved"
                checked={saved}
                onCheckedChange={setSaved}
              />
            </div>
            <DialogFooter>
              <Button
                disabled={!saved || pending}
                onClick={() => {
                  if (address?.status === "registered")
                    onSaved({
                      address: address.address,
                      ownerPubkey: auth.accountPubkey!,
                      authGeneration: auth.authGeneration,
                      firstWallet,
                      imported: mode === "restore" || recoveredFromRelay,
                    })
                  close()
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : mode === "restore" ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <p className="text-sm">
              Recovery is encrypted to your Nostr identity and saved on recovery
              relays to open this wallet in either app.
            </p>
            <div className="grid gap-2">
              <Label htmlFor="portable-mnemonic">Recovery phrase</Label>
              <Textarea
                id="portable-mnemonic"
                value={mnemonic}
                onChange={(event) => setMnemonic(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                required
                disabled={pending}
              />
            </div>
            <details className="rounded-xl border border-[var(--border)] p-3">
              <summary className="cursor-pointer text-sm">
                Advanced settings
              </summary>
              <div className="mt-3 grid gap-2">
                <Label htmlFor="portable-account">Spark account number</Label>
                <Input
                  id="portable-account"
                  type="number"
                  min={0}
                  max={MAX_SPARK_ACCOUNT_NUMBER}
                  step={1}
                  value={accountNumber}
                  onChange={(event) => setAccountNumber(event.target.value)}
                  disabled={pending}
                />
                <p className="text-xs">
                  Default: {defaultAccount}. Use the number saved with the
                  source wallet.
                </p>
              </div>
            </details>
            {error && (
              <p role="alert" className="text-sm">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={close}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !mnemonic.trim()}>
                {pending ? "Importing…" : "Import wallet"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <p role="status" className="text-sm">
              {pending
                ? "Confirm the encryption request in your Nostr signer…"
                : (error ?? "Preparing wallet…")}
            </p>
            {error && (
              <DialogFooter>
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button onClick={() => void submit()}>Retry creation</Button>
              </DialogFooter>
            )}
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

function WalletRecoveryMethodFields({
  state,
  password,
  onPassword,
  pending,
  useLegacyPassword,
  onLegacyPassword,
  passwordId,
  signerMessage,
  children,
}: {
  state: SparkRecoveryState
  password: string
  onPassword(value: string): void
  pending: boolean
  useLegacyPassword: boolean
  onLegacyPassword(value: boolean): void
  passwordId: string
  signerMessage: string
  children?: React.ReactNode
}) {
  if (state.status === "checking" || state.status === "idle")
    return (
      <div
        role="status"
        className="flex items-center gap-2 py-4 text-sm text-[var(--text-muted)]"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking recovery method
      </div>
    )
  if (state.status === "missing")
    return (
      <p
        role="alert"
        className="text-sm leading-6 text-[var(--text-secondary)]"
      >
        {state.reason}
      </p>
    )
  return (
    <>
      {state.method === "signer" && !useLegacyPassword ? (
        <p className="text-sm">{signerMessage}</p>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor={passwordId}>Wallet password</Label>
          <Input
            id={passwordId}
            type="password"
            value={password}
            onChange={(event) => onPassword(event.target.value)}
            autoComplete="current-password"
            disabled={pending}
          />
          {children}
        </div>
      )}
      {state.legacyPassword && (
        <div className="flex items-center gap-3">
          <Switch
            id={`${passwordId}-legacy`}
            checked={useLegacyPassword}
            onCheckedChange={onLegacyPassword}
            disabled={pending}
          />
          <Label htmlFor={`${passwordId}-legacy`}>
            Use the previous wallet password
          </Label>
        </div>
      )}
    </>
  )
}

function UnlockWalletDialog({
  signerReady,
  wallet,
  onOpenChange,
  wallets,
}: {
  signerReady: boolean
  wallet: WalletDescriptor | null
  onOpenChange: (open: boolean) => void
  wallets: UseWalletsReturn
}) {
  const [migrate, setMigrate] = useState(false)
  const [useLegacyPassword, setUseLegacyPassword] = useState(false)
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recoveryState = useSparkRecoveryState(
    wallet?.id ?? null,
    wallets.getSparkRecoveryType
  )

  const close = () => {
    setPassword("")
    setUseLegacyPassword(false)
    setPending(false)
    setError(null)
    onOpenChange(false)
  }

  const submitPassword = async () => {
    if (!wallet) return
    setPending(true)
    setError(null)
    try {
      await wallets.unlockSpark(wallet.id, password, migrate)
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
            {recoveryState.status === "ready" &&
            recoveryState.method === "signer"
              ? "Confirm the request in your Nostr signer. No wallet password is needed."
              : "Enter the existing wallet password. You can switch this wallet to Nostr sign-in after verifying recovery."}
          </DialogDescription>
        </DialogHeader>
        <WalletRecoveryMethodFields
          state={recoveryState}
          password={password}
          onPassword={setPassword}
          pending={pending}
          useLegacyPassword={useLegacyPassword}
          onLegacyPassword={(value) => {
            setUseLegacyPassword(value)
            setPassword("")
          }}
          passwordId="unlock-password"
          signerMessage="Opens with this wallet’s Nostr sign-in."
        >
          {recoveryState.status === "ready" &&
            recoveryState.method === "password" &&
            signerReady && (
              <div className="flex items-center gap-3">
                <Switch
                  id="migrate-wallet"
                  checked={migrate}
                  onCheckedChange={setMigrate}
                  disabled={pending}
                />
                <Label htmlFor="migrate-wallet">
                  Use Nostr sign-in from now on. Keep the existing encrypted
                  recovery copy.
                </Label>
              </div>
            )}
        </WalletRecoveryMethodFields>
        {error && (
          <p role="alert" className="text-sm text-[var(--text-secondary)]">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={pending}>
            Cancel
          </Button>
          {recoveryState.status === "ready" && (
            <Button
              onClick={() => void submitPassword()}
              disabled={
                pending ||
                ((recoveryState.method === "password" || useLegacyPassword) &&
                  !password)
              }
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              {recoveryState.method === "signer"
                ? "Open with Nostr"
                : migrate
                  ? "Open and use Nostr sign-in"
                  : "Unlock"}
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
  const [addressPending, setAddressPending] = useState(false)
  const [request, setRequest] = useState("")
  const [pendingAction, setPendingAction] = useState<
    "lightning" | "spark-address" | null
  >(null)
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle"
  )
  const [requestAnnouncement, setRequestAnnouncement] = useState("")
  const [error, setError] = useState<string | null>(null)
  const pending = pendingAction !== null || addressPending

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
        <SparkLightningAddress
          key={wallet?.id ?? "closed"}
          walletId={wallet?.id ?? null}
          resolve={wallets.getSparkLightningAddress}
          disabled={pendingAction !== null}
          onPendingChange={setAddressPending}
        />
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
      <DialogContent className="max-h-[85vh]">
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
  const [useLegacyPassword, setUseLegacyPassword] = useState(false)
  const [password, setPassword] = useState("")
  const [recovery, setRecovery] = useState<SparkRecoveryBundle | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recoveryHeadingRef = useRef<HTMLHeadingElement>(null)
  const recoveryState = useSparkRecoveryState(
    wallet?.id ?? null,
    wallets.getSparkRecoveryType
  )

  const close = () => {
    setPassword("")
    setRecovery(null)
    setPending(false)
    setError(null)
    onOpenChange(false)
  }

  useEffect(() => {
    if (recovery) {
      recoveryHeadingRef.current?.focus()
    }
  }, [recovery])

  const revealPassword = async () => {
    if (!wallet) return
    setPending(true)
    setError(null)
    try {
      const revealed = await wallets.revealSparkRecovery(wallet.id, password)
      setRecovery({ ...revealed, network: wallet.network })
      setPassword("")
    } catch (caught) {
      setError(getErrorMessage(caught, "Could not show recovery phrase."))
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
      <DialogContent showCloseButton={!recovery && !pending}>
        <DialogHeader>
          <DialogTitle ref={recoveryHeadingRef} tabIndex={-1}>
            Recovery for {wallet?.label}
          </DialogTitle>
          <DialogDescription>
            Keep this BIP39 phrase, Spark account number, and network together
            as the standards-based recovery bundle for this Portable Wallet.
            Keep it private.
          </DialogDescription>
        </DialogHeader>
        {wallet && recovery ? (
          <>
            <SparkRecoveryBundleDetails {...recovery} />
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <WalletRecoveryMethodFields
              state={recoveryState}
              password={password}
              onPassword={setPassword}
              pending={pending}
              useLegacyPassword={useLegacyPassword}
              onLegacyPassword={(value) => {
                setUseLegacyPassword(value)
                setPassword("")
              }}
              passwordId="recovery-password"
              signerMessage="Confirm the recovery request in your Nostr signer."
            />
            {error && (
              <p role="alert" className="text-sm text-[var(--text-secondary)]">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={close} disabled={pending}>
                Cancel
              </Button>
              {recoveryState.status === "ready" && (
                <Button
                  onClick={() => void revealPassword()}
                  disabled={
                    pending ||
                    ((recoveryState.method === "password" ||
                      useLegacyPassword) &&
                      !password)
                  }
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
