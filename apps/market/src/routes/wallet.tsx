import { createFileRoute } from "@tanstack/react-router"
import {
  AlertTriangle,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  Wallet,
  Zap,
} from "lucide-react"
import { useEffect, useState } from "react"
import {
  parseNwcUri,
  pubkeyToNpub,
  SUPPORTED_SHOPPER_DISPLAY_CURRENCIES,
  type NwcDiagnostic,
  type ShopperDisplayCurrency,
} from "@conduit/core"
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  Switch,
} from "@conduit/ui"
import { useShopperPricing } from "../hooks/useShopperPricing"
import { requireAuth } from "../lib/auth"
import {
  useWallet,
  type WalletBalanceState,
  type WalletBudgetState,
  type WalletConnectionStatus,
} from "../hooks/useWallet"
import { formatBalanceFreshness } from "../lib/wallet-readiness"
import { getWalletCapabilityPills } from "../lib/wallet-capabilities"

export const Route = createFileRoute("/wallet")({
  beforeLoad: () => {
    requireAuth()
  },
  component: WalletPage,
})

function WalletStatusPill({ status }: { status: WalletConnectionStatus }) {
  switch (status) {
    case "pay-capable":
      return (
        <StatusPill variant="success">
          <Zap className="h-3 w-3" />
          Zap ready
        </StatusPill>
      )
    case "connected":
      return <StatusPill variant="success">Connected</StatusPill>
    case "connecting":
      return (
        <StatusPill variant="neutral">
          <Loader2 className="h-3 w-3 animate-spin" />
          Connecting...
        </StatusPill>
      )
    case "unsupported":
      return (
        <StatusPill variant="warning">
          <AlertTriangle className="h-3 w-3" />
          Payments unsupported
        </StatusPill>
      )
    case "unreachable":
      return (
        <StatusPill variant="warning">
          <AlertTriangle className="h-3 w-3" />
          Wallet saved
        </StatusPill>
      )
    case "error":
      return <StatusPill variant="error">Connection error</StatusPill>
    case "disconnected":
    default:
      return <StatusPill variant="neutral">Not connected</StatusPill>
  }
}

function WalletDiagnostics({
  diagnostics,
}: {
  diagnostics: readonly NwcDiagnostic[]
}) {
  if (diagnostics.length === 0) return null

  return (
    <div className="mt-4 space-y-3">
      {diagnostics.map((diagnostic) => (
        <div
          key={`${diagnostic.code}:${diagnostic.relayHosts?.join(",") ?? ""}`}
          className={[
            "rounded-2xl border p-4 text-sm leading-6",
            diagnostic.severity === "error"
              ? "border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)]"
              : "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)]",
          ].join(" ")}
        >
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            {diagnostic.title}
          </div>
          <p className="mt-2">{diagnostic.detail}</p>
          {diagnostic.relayHosts && diagnostic.relayHosts.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {diagnostic.relayHosts.map((host) => (
                <span
                  key={host}
                  className="rounded-full border border-current/30 px-2 py-0.5 font-mono text-[0.65rem]"
                >
                  {host}
                </span>
              ))}
            </div>
          )}
          <p className="mt-3 font-medium">{diagnostic.action}</p>
        </div>
      ))}
    </div>
  )
}

function useFreshnessNow(fetchedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!fetchedAt) return

    setNow(Date.now())
    const intervalId = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(intervalId)
  }, [fetchedAt])

  return now
}

function WalletCapabilities({
  info,
}: {
  info: { methods: readonly string[]; notifications?: readonly string[] }
}) {
  const capabilities = getWalletCapabilityPills(info)

  return (
    <div className="flex min-w-0 flex-wrap justify-end gap-1.5">
      {capabilities.map((capability) => (
        <StatusPill
          key={capability.id}
          variant={capability.variant}
          className="font-mono text-[0.65rem]"
        >
          {capability.label}
        </StatusPill>
      ))}
    </div>
  )
}

function WalletBalanceRow({
  balance,
  onRefresh,
  formatSats,
}: {
  balance: WalletBalanceState
  onRefresh: () => Promise<void>
  formatSats: (sats: number) => string
}) {
  const hasBalance = balance.balanceMsats !== null
  const canRefresh =
    balance.status === "available" || balance.status === "error"
  const now = useFreshnessNow(balance.fetchedAt)
  const freshness = formatBalanceFreshness(balance.fetchedAt, now)
  const value =
    hasBalance && balance.balanceMsats !== null
      ? formatSats(Math.floor(balance.balanceMsats / 1_000))
      : balance.status === "checking"
        ? "Checking..."
        : balance.status === "error"
          ? "Unable to refresh"
          : balance.status === "unavailable"
            ? "Unavailable"
            : "Not checked yet"
  const detail =
    balance.status === "checking" && hasBalance
      ? "Refreshing..."
      : balance.status === "error" && hasBalance
        ? "Refresh failed"
        : balance.status === "error"
          ? "Wallet did not return a balance"
          : balance.status === "unavailable"
            ? "Wallet does not advertise get_balance"
            : freshness

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <dt className="shrink-0 text-xs text-[var(--text-muted)]">
        Connected wallet balance
      </dt>
      <dd className="flex min-w-0 flex-col gap-2 sm:items-end">
        <div className="text-sm font-medium text-[var(--text-primary)]">
          {value}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[0.7rem] text-[var(--text-muted)] sm:justify-end">
          {detail && <span>{detail}</span>}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-2 text-[0.7rem]"
            disabled={!canRefresh || balance.status === "checking"}
            onClick={() => void onRefresh()}
          >
            {balance.status === "checking" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh
          </Button>
        </div>
      </dd>
    </div>
  )
}

function WalletBudgetRow({
  budget,
  formatSats,
}: {
  budget: WalletBudgetState
  formatSats: (sats: number) => string
}) {
  const now = useFreshnessNow(budget.fetchedAt)

  if (budget.status === "unavailable") return null

  const freshness = formatBalanceFreshness(budget.fetchedAt, now)
  const value =
    budget.status === "available" && budget.remainingMsats !== null
      ? formatSats(Math.floor(budget.remainingMsats / 1_000))
      : budget.status === "checking"
        ? "Checking..."
        : budget.status === "error"
          ? "Unable to refresh"
          : "Not checked yet"
  const detail =
    budget.status === "available" && budget.totalMsats !== null
      ? `${formatSats(Math.floor(budget.totalMsats / 1_000))} budget${
          freshness ? ` - ${freshness}` : ""
        }`
      : budget.status === "error"
        ? "Wallet did not return a budget"
        : freshness

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <dt className="shrink-0 text-xs text-[var(--text-muted)]">
        App spending budget
      </dt>
      <dd className="flex min-w-0 flex-col gap-1 sm:items-end">
        <div className="text-sm font-medium text-[var(--text-primary)]">
          {value}
        </div>
        {detail && (
          <div className="text-[0.7rem] text-[var(--text-muted)]">{detail}</div>
        )}
      </dd>
    </div>
  )
}

function WalletPage() {
  const wallet = useWallet({ refreshBalance: true })
  const shopperPricing = useShopperPricing()
  const [uriInput, setUriInput] = useState("")
  const [pending, setPending] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)
  const walletNpub = wallet.connection
    ? pubkeyToNpub(wallet.connection.walletPubkey)
    : null
  const formatSats = (sats: number) =>
    shopperPricing.formatSatsAmount(sats).primary

  async function handleConnect(): Promise<void> {
    const trimmed = uriInput.trim()
    if (!trimmed) {
      setInputError("Paste a nostr+walletconnect:// connection string.")
      return
    }
    try {
      parseNwcUri(trimmed)
    } catch {
      setInputError("Paste a valid Nostr Wallet Connect connection string.")
      return
    }
    setInputError(null)
    setPending(true)
    try {
      await wallet.connect(trimmed)
      setUriInput("")
    } finally {
      setPending(false)
    }
  }

  const isConnected =
    wallet.status === "connected" ||
    wallet.status === "pay-capable" ||
    wallet.status === "unsupported" ||
    wallet.status === "unreachable" ||
    wallet.status === "error" ||
    (wallet.status === "connecting" && !!wallet.connection)

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem] space-y-6">
        {/* Outer card - matches RelaySettingsPanel frame */}
        <section className="rounded-[2.25rem] border border-[var(--border)] bg-[color:var(--surface-elevated)] bg-[image:radial-gradient(circle_at_top,color-mix(in_srgb,var(--secondary-500)_14%,transparent),transparent_35%)] p-5 shadow-[var(--shadow-dialog)] sm:p-8">
          <div className="space-y-8">
            {/* Header */}
            <div>
              <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
                Payments
              </div>
              <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
                Wallet
              </h1>
              <p className="mt-4 max-w-xl text-base leading-7 text-[var(--text-secondary)]">
                Connect a Lightning wallet using Nostr Wallet Connect (NWC) to
                zap out when a merchant supports direct Lightning payment. Your
                NWC connection is a wallet authorization secret stored only on
                this device.
              </p>
            </div>

            {/* Privacy notice */}
            <div className="flex gap-3 rounded-[1.75rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--secondary-500)_1%,transparent)] px-5 py-4 shadow-[var(--shadow-glass-inset)] text-sm text-[var(--text-secondary)]">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <p className="leading-6">
                This connection authorizes outgoing Lightning payments from your
                wallet to merchants. It cannot receive payments on your behalf,
                and it should not be shared in support reports or public issues.
              </p>
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
                Price display
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
                Choose how Market presents prices. Merchant quotes, Lightning
                invoices, and payment calculations keep their original values.
              </p>
              <div className="mt-3 rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]">
                <div className="grid gap-5 sm:grid-cols-2 sm:items-end">
                  <div className="grid gap-2">
                    <Label htmlFor="display-currency">Preferred currency</Label>
                    <Select
                      value={shopperPricing.preference.currency}
                      onValueChange={(value) =>
                        shopperPricing.setCurrency(
                          value as ShopperDisplayCurrency
                        )
                      }
                    >
                      <SelectTrigger
                        id="display-currency"
                        className="h-11 rounded-xl"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORTED_SHOPPER_DISPLAY_CURRENCIES.map(
                          (currency) => (
                            <SelectItem key={currency} value={currency}>
                              {currency === "BITCOIN"
                                ? "Bitcoin (₿ base units)"
                                : currency}
                            </SelectItem>
                          )
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex h-11 items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4">
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
                  ₿10,000 equals 10,000 sats. This preference changes labels
                  only; it never changes a listing, order, invoice, or payment.
                </p>
              </div>
            </div>

            {/* Connection status section */}
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
                Connection
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
                Conduit uses this connection to authorize Lightning payments
                directly from your wallet when you zap out.
              </p>

              <div className="mt-3 rounded-[1.75rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)] px-5 py-4 shadow-[var(--shadow-glass-inset)]">
                {/* Status row */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <Wallet className="h-5 w-5 text-[var(--text-secondary)]" />
                    <span className="font-medium text-[var(--text-primary)]">
                      Wallet connection
                    </span>
                  </div>
                  <WalletStatusPill status={wallet.status} />
                </div>

                {/* Connection detail card */}
                {wallet.connection && (
                  <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)]">
                    <dl className="m-0">
                      <div className="flex items-center justify-between gap-4 px-4 py-3">
                        <dt className="shrink-0 text-xs text-[var(--text-muted)]">
                          Wallet pubkey
                        </dt>
                        <dd className="group/pubkey relative min-w-0 cursor-default font-mono text-xs text-[var(--text-secondary)]">
                          {/* Middle-ellipsis abbreviation - no title attr to avoid double tooltip */}
                          <span>
                            {walletNpub?.slice(0, 20)}
                            <span className="text-[var(--text-muted)]">
                              ...
                            </span>
                            {walletNpub?.slice(-20)}
                          </span>
                          {/* Tooltip with full key - rendered outside overflow context */}
                          <span className="pointer-events-none absolute -top-1 right-0 z-50 mb-2 hidden w-max max-w-[min(26rem,calc(100vw-2rem))] -translate-y-full rounded-xl border border-[var(--border)] bg-[var(--surface-dialog)] px-3 py-2 font-mono text-[0.65rem] leading-5 break-all text-[var(--text-secondary)] shadow-[var(--shadow-dialog)] group-hover/pubkey:block">
                            {walletNpub}
                          </span>
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-4 px-4 py-3">
                        <dt className="shrink-0 text-xs text-[var(--text-muted)]">
                          Relay
                        </dt>
                        <dd className="min-w-0 truncate font-mono text-xs text-[var(--text-secondary)]">
                          {wallet.connection.relays[0]}
                          {wallet.connection.relays.length > 1 && (
                            <span className="ml-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[0.65rem] text-[var(--text-muted)]">
                              +{wallet.connection.relays.length - 1}
                            </span>
                          )}
                        </dd>
                      </div>
                      {wallet.info?.alias && (
                        <div className="flex items-center justify-between gap-4 px-4 py-3">
                          <dt className="shrink-0 text-xs text-[var(--text-muted)]">
                            Alias
                          </dt>
                          <dd className="text-xs text-[var(--text-secondary)]">
                            {wallet.info.alias}
                          </dd>
                        </div>
                      )}
                      {wallet.info?.network && (
                        <div className="flex items-center justify-between gap-4 px-4 py-3">
                          <dt className="shrink-0 text-xs text-[var(--text-muted)]">
                            Network
                          </dt>
                          <dd className="text-xs capitalize text-[var(--text-secondary)]">
                            {wallet.info.network}
                          </dd>
                        </div>
                      )}
                      <WalletBalanceRow
                        balance={wallet.balance}
                        onRefresh={wallet.refreshBalance}
                        formatSats={formatSats}
                      />
                      <WalletBudgetRow
                        budget={wallet.budget}
                        formatSats={formatSats}
                      />
                      {wallet.info?.methods &&
                        wallet.info.methods.length > 0 && (
                          <div className="flex items-start justify-between gap-4 px-4 py-3">
                            <dt className="shrink-0 text-xs text-[var(--text-muted)]">
                              Capabilities
                            </dt>
                            <dd>
                              <WalletCapabilities info={wallet.info} />
                            </dd>
                          </div>
                        )}
                    </dl>
                  </div>
                )}

                {/* Error / unsupported banners */}
                {wallet.status === "error" && wallet.error && (
                  <StatusPill
                    variant="error"
                    className="mt-4 w-full justify-start rounded-2xl px-4 py-3 text-sm"
                  >
                    {wallet.error}
                  </StatusPill>
                )}

                {wallet.status === "unsupported" && (
                  <div className="mt-4 rounded-2xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] p-3 text-sm text-[var(--warning)]">
                    Your connected wallet does not advertise support for{" "}
                    <code className="font-mono">pay_invoice</code>. Zap out
                    remains unavailable until you connect a payment-capable
                    wallet.
                  </div>
                )}

                {wallet.status === "unreachable" && (
                  <div className="mt-4 rounded-2xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] p-3 text-sm text-[var(--warning)]">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <span>
                        Wallet saved, but Conduit cannot reach its NWC relay
                        right now. We will keep checking; the order flow can
                        still offer a Lightning invoice fallback.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 border-[var(--warning)] text-[var(--warning)] hover:bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]"
                        onClick={() => void wallet.retry()}
                      >
                        Retry now
                      </Button>
                    </div>
                  </div>
                )}

                <WalletDiagnostics diagnostics={wallet.diagnostics} />

                {/* Disconnect */}
                {isConnected && (
                  <div className="mt-5">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={wallet.disconnect}
                    >
                      Disconnect wallet
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* Connect form */}
            {!isConnected && (
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
                  Connect a wallet
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
                  Paste a{" "}
                  <code className="font-mono text-xs">
                    nostr+walletconnect://
                  </code>{" "}
                  URI from your Lightning wallet app (Alby, Rizful, Zeus, etc.).
                  Conduit keeps it in this browser so your wallet can approve
                  payments.
                </p>

                <div className="mt-3 rounded-[1.5rem] border border-dashed border-[var(--border)] bg-[var(--surface)] p-4">
                  <div className="space-y-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="nwc-uri">Connection string</Label>
                      <Input
                        id="nwc-uri"
                        type="password"
                        value={uriInput}
                        onChange={(e) => {
                          setUriInput(e.target.value)
                          setInputError(null)
                        }}
                        placeholder="nostr+walletconnect://..."
                        aria-invalid={!!inputError}
                        className={
                          inputError
                            ? "border-error/50 focus:border-error focus:ring-error/30"
                            : undefined
                        }
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                      />
                      {inputError && (
                        <p className="text-xs text-[var(--error)]">
                          {inputError}
                        </p>
                      )}
                    </div>

                    <Button
                      className="h-11 w-full rounded-2xl text-sm"
                      onClick={handleConnect}
                      disabled={pending || wallet.status === "connecting"}
                    >
                      {pending || wallet.status === "connecting" ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Connecting...
                        </>
                      ) : (
                        <>
                          <Wallet className="h-4 w-4" />
                          Connect wallet
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Change wallet hint when already connected */}
            {isConnected && (
              <div className="rounded-[1.5rem] border border-dashed border-[var(--border)] bg-[var(--surface)] p-4 text-sm leading-6 text-[var(--text-secondary)]">
                To use a different wallet, disconnect the current one above,
                then paste a new connection string. Disconnecting clears the
                saved NWC secret from this browser.
              </div>
            )}

            {/* How it works */}
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
                How zap out works
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
                Zap out lets you pay merchants directly when payment details are
                available without waiting for a manual invoice.
              </p>

              <div className="mt-3 rounded-[1.75rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)] px-5 py-4 shadow-[var(--shadow-glass-inset)]">
                <ol className="space-y-3 text-sm leading-7 text-[var(--text-secondary)]">
                  <li>
                    1. You connect a compatible Lightning wallet using its NWC
                    connection string.
                  </li>
                  <li>
                    2. During the order flow, Conduit checks if the merchant has
                    a Lightning address and whether your saved wallet is
                    currently reachable.
                  </li>
                  <li>
                    3. Conduit requests a zap invoice, tries your connected
                    wallet first, and forwards payment proof to the merchant
                    when the wallet returns it.
                  </li>
                  <li>
                    4. If the NWC path is unreachable before funds move, the
                    order flow can fall back to a Lightning invoice you can open
                    in another wallet.
                  </li>
                </ol>

                <a
                  href="https://nips.nostr.com/47"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
                >
                  NIP-47 specification
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
