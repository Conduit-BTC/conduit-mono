import { createFileRoute } from "@tanstack/react-router"
import {
  AlertTriangle,
  ExternalLink,
  Info,
  Loader2,
  Wallet,
  Zap,
} from "lucide-react"
import { useState } from "react"
import { Button, Input, Label, StatusPill } from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import { useWallet, type WalletConnectionStatus } from "../hooks/useWallet"

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
    case "error":
      return <StatusPill variant="error">Connection error</StatusPill>
    case "disconnected":
    default:
      return <StatusPill variant="neutral">Not connected</StatusPill>
  }
}

function WalletPage() {
  const wallet = useWallet()
  const [uriInput, setUriInput] = useState("")
  const [pending, setPending] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)

  async function handleConnect(): Promise<void> {
    const trimmed = uriInput.trim()
    if (!trimmed) {
      setInputError("Paste a nostr+walletconnect:// connection string.")
      return
    }
    if (!trimmed.startsWith("nostr+walletconnect://")) {
      setInputError(
        "The connection string must start with nostr+walletconnect://"
      )
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
    wallet.status === "error"

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
                enable fast checkout. Your wallet connection is private and
                stored only on this device.
              </p>
            </div>

            {/* Privacy notice */}
            <div className="flex gap-3 rounded-[1.75rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--secondary-500)_1%,transparent)] px-5 py-4 shadow-[var(--shadow-glass-inset)] text-sm text-[var(--text-secondary)]">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <p className="leading-6">
                This connection authorizes outgoing Lightning payments from your
                wallet to merchants. It cannot receive payments on your behalf.
              </p>
            </div>

            {/* Connection status section */}
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
                Connection
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
                Conduit uses this connection to authorize Lightning payments
                directly from your wallet at checkout.
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
                  <div
                    className={[
                      "mt-4 rounded-2xl border-t-2 border border-[var(--border)] bg-[var(--surface-elevated)]",
                      wallet.status === "pay-capable"
                        ? "border-t-[var(--success)]"
                        : wallet.status === "error"
                          ? "border-t-[var(--error)]"
                          : wallet.status === "unsupported"
                            ? "border-t-[var(--warning)]"
                            : "border-t-[var(--border)]",
                    ].join(" ")}
                  >
                    <dl className="m-0">
                      <div className="flex items-center justify-between gap-4 px-4 py-3">
                        <dt className="shrink-0 text-xs text-[var(--text-muted)]">
                          Wallet pubkey
                        </dt>
                        <dd className="group/pubkey relative min-w-0 cursor-default font-mono text-xs text-[var(--text-secondary)]">
                          {/* Middle-ellipsis abbreviation - no title attr to avoid double tooltip */}
                          <span>
                            {wallet.connection.walletPubkey.slice(0, 20)}
                            <span className="text-[var(--text-muted)]">
                              ...
                            </span>
                            {wallet.connection.walletPubkey.slice(-20)}
                          </span>
                          {/* Tooltip with full key - rendered outside overflow context */}
                          <span className="pointer-events-none absolute -top-1 right-0 z-50 mb-2 hidden w-max max-w-[min(26rem,calc(100vw-2rem))] -translate-y-full rounded-xl border border-[var(--border)] bg-[var(--surface-dialog)] px-3 py-2 font-mono text-[0.65rem] leading-5 break-all text-[var(--text-secondary)] shadow-[var(--shadow-dialog)] group-hover/pubkey:block">
                            {wallet.connection.walletPubkey}
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
                      {wallet.info?.methods &&
                        wallet.info.methods.length > 0 && (
                          <div className="flex items-start justify-between gap-4 px-4 py-3">
                            <dt className="shrink-0 text-xs text-[var(--text-muted)]">
                              Capabilities
                            </dt>
                            <dd className="flex min-w-0 flex-wrap justify-end gap-1">
                              {wallet.info.methods.map((method) => (
                                <span
                                  key={method}
                                  className={[
                                    "rounded-full border px-2 py-0.5 font-mono text-[0.65rem]",
                                    method === "pay_invoice"
                                      ? "border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]"
                                      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
                                  ].join(" ")}
                                >
                                  {method}
                                </span>
                              ))}
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
                    <code className="font-mono">pay_invoice</code>. Fast
                    checkout will remain unavailable until you connect a
                    payment-capable wallet.
                  </div>
                )}

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
                then paste a new connection string.
              </div>
            )}

            {/* How it works */}
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary-500)]">
                How fast checkout works
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
                Fast checkout lets you pay merchants directly at checkout
                without waiting for a manual invoice.
              </p>

              <div className="mt-3 rounded-[1.75rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary-500)_1%,transparent)] px-5 py-4 shadow-[var(--shadow-glass-inset)]">
                <ol className="space-y-3 text-sm leading-7 text-[var(--text-secondary)]">
                  <li>
                    1. You connect a compatible Lightning wallet using its NWC
                    connection string.
                  </li>
                  <li>
                    2. At checkout, Conduit checks if the merchant has a
                    Lightning address and your wallet supports outgoing
                    payments.
                  </li>
                  <li>
                    3. If eligible, you can pay the merchant directly - your
                    wallet sends the payment and Conduit forwards proof to the
                    merchant.
                  </li>
                  <li>
                    4. If fast checkout is not available, the standard
                    order-first path remains available.
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
