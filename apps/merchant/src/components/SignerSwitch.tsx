import { Check, KeyRound, ShieldCheck } from "lucide-react"
import { useMemo, useState } from "react"
import { formatPubkey, hasNip07, useAuth } from "@conduit/core"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@conduit/ui"

type SignerSwitchProps = {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
}

function ConduitLogoLockup({ className = "h-10" }: { className?: string }) {
  return (
    <div className="mb-5 flex justify-center">
      <img
        src="/images/logo/logo-full.svg"
        alt="Conduit"
        className={`${className} w-auto select-none object-contain`}
        draggable="false"
      />
    </div>
  )
}

function SignerGlyph({ className = "h-5 w-5" }: { className?: string }) {
  return <KeyRound className={className} />
}

function ShieldIcon() {
  return <ShieldCheck className="h-4 w-4" />
}

function CheckIcon() {
  return <Check className="h-4 w-4" />
}

function SignerHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <DialogHeader className="mx-auto max-w-md items-center text-center">
      <ConduitLogoLockup className="h-11" />
      <div className="flex items-center gap-2 rounded-full border border-secondary-500/25 bg-secondary-500/10 px-3 py-1.5 text-secondary-200">
        <SignerGlyph className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-[0.16em]">
          Signer
        </span>
      </div>
      <DialogTitle className="mt-4 flex items-center gap-2 text-2xl font-semibold tracking-[-0.02em] text-[var(--text-primary)] sm:text-[2rem]">
        <SignerGlyph className="h-5 w-5 shrink-0 text-secondary-300" />
        <span>{title}</span>
      </DialogTitle>
      <DialogDescription className="max-w-md text-[15px] leading-6 text-[var(--text-secondary)]">
        {description}
      </DialogDescription>
    </DialogHeader>
  )
}

export function SignerSwitch({
  open,
  onOpenChange,
  hideTrigger = false,
}: SignerSwitchProps = {}) {
  const { pubkey, status, error, connect, disconnect } = useAuth()
  const [internalOpen, setInternalOpen] = useState(false)
  const [isWorking, setIsWorking] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState(false)
  const extensionAvailable = hasNip07()
  const isProbablyMobileBrowser = useMemo(() => {
    if (typeof navigator === "undefined") return false
    return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
  }, [])
  const mobileSignerUnavailable =
    isProbablyMobileBrowser && !extensionAvailable && status !== "connected"
  const isControlled = typeof open === "boolean"
  const isOpen = isControlled ? open : internalOpen
  const authPending = status === "connecting" || status === "restoring"

  function setOpen(nextOpen: boolean): void {
    if (!isControlled) {
      setInternalOpen(nextOpen)
    }
    onOpenChange?.(nextOpen)
  }

  const triggerLabel = useMemo(() => {
    if (status === "restoring") return "Restoring..."
    if (status === "connecting") return "Connecting..."
    if (status === "connected" && pubkey)
      return `Signer: ${formatPubkey(pubkey)}`
    return "Connect"
  }, [pubkey, status])

  const canSwitch = status === "connected" && !isWorking

  async function handleConnect(): Promise<void> {
    if (authPending) return
    setIsWorking(true)
    try {
      await connect()
      setPendingSwitch(false)
      setOpen(false)
    } catch {
      // keep dialog open so user can see error + retry
    } finally {
      setIsWorking(false)
    }
  }

  function handleSwitchSigner(): void {
    if (!canSwitch) return
    disconnect()
    setPendingSwitch(true)
  }

  function handleDisconnect(): void {
    disconnect()
    setPendingSwitch(false)
    setOpen(false)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button
            variant={status === "connected" ? "muted" : "primary"}
            size="sm"
          >
            {triggerLabel}
          </Button>
        </DialogTrigger>
      )}

      <DialogContent className="max-h-[calc(100vh-1.5rem)] max-w-xl overflow-y-auto border-[var(--border)] bg-[var(--surface-dialog)] p-0 text-[var(--text-primary)] shadow-[var(--shadow-dialog)]">
        <div className="relative rounded-[inherit] border border-[var(--border)] bg-[var(--surface-dialog)]">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--tertiary-500)_16%,transparent),transparent_36%),linear-gradient(180deg,color-mix(in_srgb,var(--foreground)_3%,transparent),transparent_22%)]" />

          <div className="relative px-5 py-5 sm:px-6 sm:py-6">
            {status === "connected" && pubkey ? (
              <>
                <SignerHeader
                  title="Signer connected"
                  description="Your merchant workspace is ready."
                />

                <div className="mx-auto mt-6 max-w-md space-y-4">
                  <div className="rounded-[1.25rem] border border-secondary-500/25 bg-secondary-500/10 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="secondary"
                        className="border-secondary-500/30 bg-secondary-500/12 text-secondary-100"
                      >
                        Connected
                      </Badge>
                      <Badge
                        variant="outline"
                        className="border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)]"
                      >
                        {formatPubkey(pubkey, 12)}
                      </Badge>
                    </div>
                    <p className="mt-3 text-[15px] leading-6 text-[var(--text-secondary)]">
                      This signer will be used for listings, orders, and
                      merchant messages.
                    </p>
                  </div>

                  {pendingSwitch && (
                    <div className="rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-[15px] leading-6 text-[var(--text-secondary)]">
                      Change the active account in your browser extension, then
                      reconnect here.
                    </div>
                  )}

                  {error && (
                    <div className="rounded-[1.25rem] border border-error/30 bg-error/10 p-4 text-[15px] leading-6 text-error">
                      {error}
                    </div>
                  )}
                </div>

                <DialogFooter className="mx-auto mt-6 max-w-md border-t border-[var(--border)] px-0 pt-5">
                  <Button
                    variant="outline"
                    onClick={handleDisconnect}
                    disabled={isWorking}
                  >
                    Disconnect
                  </Button>
                  <Button onClick={handleSwitchSigner} disabled={isWorking}>
                    Switch account
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <SignerHeader
                  title={
                    mobileSignerUnavailable
                      ? "Signer unavailable here"
                      : "Connect a signer"
                  }
                  description={
                    mobileSignerUnavailable
                      ? "This browser does not expose a supported Nostr signer."
                      : "Use your Nostr signer to open the merchant workspace."
                  }
                />

                <div className="mx-auto mt-6 w-full max-w-md space-y-3">
                  {!mobileSignerUnavailable && (
                    <Button
                      onClick={handleConnect}
                      disabled={isWorking || authPending || !extensionAvailable}
                      className="h-12 w-full justify-center gap-2 text-base"
                    >
                      <SignerGlyph />
                      {authPending ? "Connecting..." : "Connect signer"}
                    </Button>
                  )}

                  <div className="rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-[15px] leading-6 text-[var(--text-secondary)]">
                    {mobileSignerUnavailable
                      ? "Try a desktop browser with a signer extension, or a mobile browser that already exposes one."
                      : "Conduit currently supports external signers only."}
                  </div>
                </div>

                <div className="mx-auto mt-4 grid max-w-md gap-4">
                  <div className="rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                      <ShieldIcon />
                      What this unlocks
                    </div>
                    <ul className="mt-4 space-y-3 text-[15px] leading-6 text-[var(--text-secondary)]">
                      <li className="flex items-center gap-3">
                        <CheckIcon />
                        <span>Publish listings tied to your pubkey.</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <CheckIcon />
                        <span>
                          Manage orders and buyer messages in one place.
                        </span>
                      </li>
                    </ul>
                  </div>
                </div>

                {pendingSwitch && (
                  <div className="mx-auto mt-4 max-w-md rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-[15px] leading-6 text-[var(--text-secondary)]">
                    Change the active account in your browser extension, then
                    reconnect here.
                  </div>
                )}

                {error && (
                  <div className="mx-auto mt-4 max-w-md rounded-[1.25rem] border border-error/30 bg-error/10 p-4 text-[15px] leading-6 text-error">
                    {error}
                  </div>
                )}

                {!extensionAvailable && !mobileSignerUnavailable && (
                  <div className="mx-auto mt-4 max-w-md rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-[15px] leading-6 text-[var(--text-secondary)]">
                    No signer extension detected. Install a NIP-07 signer such
                    as Alby or nos2x, then refresh and connect.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
