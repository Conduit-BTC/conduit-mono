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

function SignerGlyph({ className = "h-5 w-5" }: { className?: string }) {
  return <KeyRound className={className} />
}

function ShieldIcon() {
  return <ShieldCheck className="h-4 w-4" />
}

function CheckIcon() {
  return <Check className="h-4 w-4" />
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

  function setOpen(nextOpen: boolean): void {
    if (!isControlled) {
      setInternalOpen(nextOpen)
    }
    onOpenChange?.(nextOpen)
  }

  const triggerLabel = useMemo(() => {
    if (status === "connecting") return "Connecting..."
    if (status === "connected" && pubkey) return `Signer: ${formatPubkey(pubkey)}`
    return "Connect"
  }, [pubkey, status])

  const canSwitch = status === "connected" && !isWorking

  async function handleConnect(): Promise<void> {
    if (status === "connecting") return
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
    // NIP-07 extensions typically won't re-prompt on reconnect; best effort is to
    // disconnect and let the user change the active account in the extension.
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
          <Button variant={status === "connected" ? "muted" : "primary"} size="sm">
            {triggerLabel}
          </Button>
        </DialogTrigger>
      )}

      <DialogContent className="max-h-[calc(100vh-1.5rem)] max-w-xl overflow-y-auto border-white/15 bg-[#090314] p-0 text-[var(--text-primary)] shadow-[0_28px_80px_rgba(0,0,0,0.6)]">
        <div className="relative rounded-[inherit] border border-white/8 bg-[#090314]">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,86,164,0.16),transparent_36%),linear-gradient(180deg,rgba(255,255,255,0.03),transparent_22%)]" />

          <div className="relative px-5 py-5 sm:px-6 sm:py-6">
            {status === "connected" && pubkey ? (
              <>
                <DialogHeader className="mx-auto max-w-md items-center text-center">
                  <Badge className="border-secondary-500/30 bg-secondary-500/12 text-secondary-200">
                    Identity connected
                  </Badge>
                  <DialogTitle className="mt-2 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
                    Your signer is ready
                  </DialogTitle>
                  <DialogDescription className="max-w-md text-sm leading-7 text-[var(--text-secondary)] sm:text-base">
                    Checkout, order follow-up, and account-linked actions are now available.
                  </DialogDescription>
                </DialogHeader>

                <div className="mx-auto mt-6 max-w-md space-y-4">
                  <div className="rounded-[1.25rem] border border-secondary-500/25 bg-secondary-500/10 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="secondary"
                        className="border-secondary-500/30 bg-secondary-500/12 text-secondary-100"
                      >
                        Connected
                      </Badge>
                      <Badge variant="outline" className="border-white/12 bg-white/5 text-[var(--text-primary)]">
                        {formatPubkey(pubkey, 12)}
                      </Badge>
                    </div>
                    <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                      This signer will be used for checkout, orders, and merchant messages.
                    </p>
                  </div>

                  {pendingSwitch && (
                    <div className="rounded-[1.25rem] border border-white/10 bg-white/5 p-4 text-sm leading-7 text-[var(--text-secondary)]">
                      Change the active account in your browser extension, then reconnect here.
                    </div>
                  )}

                  {error && (
                    <div className="rounded-[1.25rem] border border-error/30 bg-error/10 p-4 text-sm leading-7 text-error">
                      {error}
                    </div>
                  )}
                </div>

                <DialogFooter className="mx-auto mt-6 max-w-md border-t border-white/8 px-0 pt-5">
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
                <DialogHeader className="mx-auto max-w-md items-center text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-secondary-500/30 bg-secondary-500/10 text-secondary-300">
                    <SignerGlyph className="h-6 w-6" />
                  </div>
                  <DialogTitle className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
                    {mobileSignerUnavailable ? "Signer unavailable here" : "Signer needed"}
                  </DialogTitle>
                  <DialogDescription className="max-w-md text-sm leading-7 text-[var(--text-secondary)] sm:text-base">
                    {mobileSignerUnavailable
                      ? "This mobile browser does not expose a Nostr signer for checkout yet."
                      : "Connect a Nostr signer to continue with checkout, orders, and merchant follow-up."}
                  </DialogDescription>
                </DialogHeader>

                <div className="mx-auto mt-6 w-full max-w-md space-y-3">
                  {!mobileSignerUnavailable && (
                    <Button
                      onClick={handleConnect}
                      disabled={isWorking || status === "connecting" || !extensionAvailable}
                      className="h-12 w-full justify-center gap-2 text-base"
                    >
                      <SignerGlyph />
                      {status === "connecting" ? "Connecting..." : "Connect signer"}
                    </Button>
                  )}

                  <div className="rounded-[1.25rem] border border-white/10 bg-white/5 p-4 text-sm leading-7 text-[var(--text-secondary)]">
                    {mobileSignerUnavailable
                      ? "Conduit currently uses external signers only. On most phones, we do not switch into a signer app and back automatically yet. Use a desktop browser with a signer extension, or a mobile browser that already exposes a supported signer."
                      : "Conduit currently uses external signers only. If you do not have one yet, add a Nostr signer extension to your browser, then return here to connect. Support for more signer flows will expand soon."}
                  </div>
                </div>

                <div className="mx-auto mt-4 grid max-w-md gap-4">
                  <div className="rounded-[1.25rem] border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                      <ShieldIcon />
                      Why connect
                    </div>
                    <ul className="mt-4 space-y-3 text-sm leading-7 text-[var(--text-secondary)]">
                      <li className="flex items-center gap-3">
                        <CheckIcon />
                        <span>Send orders and keep them tied to your pubkey.</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <CheckIcon />
                        <span>Receive merchant replies and payment details in your inbox.</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <CheckIcon />
                        <span>Review order status later without creating a separate account.</span>
                      </li>
                    </ul>
                  </div>
                </div>

                {pendingSwitch && (
                  <div className="mx-auto mt-4 max-w-md rounded-[1.25rem] border border-white/10 bg-white/5 p-4 text-sm leading-7 text-[var(--text-secondary)]">
                    Change the active account in your browser extension, then reconnect here.
                  </div>
                )}

                {error && (
                  <div className="mx-auto mt-4 max-w-md rounded-[1.25rem] border border-error/30 bg-error/10 p-4 text-sm leading-7 text-error">
                    {error}
                  </div>
                )}

                {!extensionAvailable && !mobileSignerUnavailable && (
                  <div className="mx-auto mt-4 max-w-md rounded-[1.25rem] border border-white/10 bg-white/5 p-4 text-sm leading-7 text-[var(--text-secondary)]">
                    No signer extension detected. Install a NIP-07 compatible extension such as
                    Alby or nos2x, then refresh and connect. Support for more signer flows will
                    expand soon.
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
