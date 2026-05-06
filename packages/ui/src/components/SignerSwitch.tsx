import { Check, KeyRound, ShieldCheck } from "lucide-react"
import { useMemo, useState } from "react"
import { Badge } from "./Badge"
import { Button } from "./Button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./Dialog"

export type SignerSwitchStatus =
  | "disconnected"
  | "restoring"
  | "connecting"
  | "connected"
  | "error"

export interface SignerSwitchProps {
  status: SignerSwitchStatus
  pubkeyLabel?: string | null
  pubkeyDetailLabel?: string | null
  error?: string | null
  extensionAvailable: boolean
  connectedDescription: string
  connectDescription: string
  unlockItems: readonly string[]
  connectedUseDescription: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
  onConnect: () => Promise<void> | void
  onDisconnect: () => void
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

function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
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
      <DialogTitle className="mt-4 flex items-center gap-2 text-2xl font-semibold text-[var(--text-primary)] sm:text-[2rem]">
        <span>{title}</span>
      </DialogTitle>
      <DialogDescription className="max-w-md text-[15px] leading-6 text-[var(--text-secondary)]">
        {description}
      </DialogDescription>
    </DialogHeader>
  )
}

export function SignerSwitch({
  status,
  pubkeyLabel,
  pubkeyDetailLabel,
  error,
  extensionAvailable,
  connectedDescription,
  connectDescription,
  unlockItems,
  connectedUseDescription,
  open,
  onOpenChange,
  hideTrigger = false,
  onConnect,
  onDisconnect,
}: SignerSwitchProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [isWorking, setIsWorking] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState(false)
  const mobileSignerUnavailable =
    isMobileBrowser() && !extensionAvailable && status !== "connected"
  const isControlled = typeof open === "boolean"
  const isOpen = isControlled ? open : internalOpen
  const connected = status === "connected" && !!pubkeyLabel
  const authPending = status === "connecting" || status === "restoring"

  function setOpen(nextOpen: boolean): void {
    if (!isControlled) setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  const triggerLabel = useMemo(() => {
    if (authPending) return "Connecting..."
    if (connected) return `Signer: ${pubkeyLabel}`
    return "Connect"
  }, [authPending, connected, pubkeyLabel])

  async function handleConnect(): Promise<void> {
    if (authPending) return
    setIsWorking(true)
    try {
      await onConnect()
      setPendingSwitch(false)
      setOpen(false)
    } catch {
      // Keep the dialog open so the inline error remains visible.
    } finally {
      setIsWorking(false)
    }
  }

  function handleSwitchSigner(): void {
    if (!connected || isWorking) return
    onDisconnect()
    setPendingSwitch(true)
  }

  function handleDisconnect(): void {
    onDisconnect()
    setPendingSwitch(false)
    setOpen(false)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button
            variant={connected ? "muted" : "primary"}
            size="sm"
            type="button"
          >
            {triggerLabel}
          </Button>
        </DialogTrigger>
      )}

      <DialogContent className="max-h-[calc(100dvh-1.5rem)] max-w-xl overflow-y-auto border-[var(--border)] bg-[var(--surface-dialog)] p-0 text-[var(--text-primary)] shadow-[var(--shadow-dialog)]">
        <div className="relative rounded-[inherit] border border-[var(--border)] bg-[var(--surface-dialog)]">
          <div className="relative px-5 py-5 sm:px-6 sm:py-6">
            {connected ? (
              <>
                <SignerHeader
                  title="Signer connected"
                  description={connectedDescription}
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
                        {pubkeyDetailLabel ?? pubkeyLabel}
                      </Badge>
                    </div>
                    <p className="mt-3 text-[15px] leading-6 text-[var(--text-secondary)]">
                      {connectedUseDescription}
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
                    type="button"
                    onClick={handleDisconnect}
                    disabled={isWorking}
                  >
                    Disconnect
                  </Button>
                  <Button
                    type="button"
                    onClick={handleSwitchSigner}
                    disabled={isWorking}
                  >
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
                      : connectDescription
                  }
                />

                <div className="mx-auto mt-6 w-full max-w-md space-y-3">
                  {!mobileSignerUnavailable && (
                    <Button
                      type="button"
                      onClick={() => void handleConnect()}
                      disabled={isWorking || authPending || !extensionAvailable}
                      className="h-12 w-full justify-center gap-2 text-base"
                    >
                      <SignerGlyph />
                      {authPending || isWorking
                        ? "Connecting..."
                        : "Connect signer"}
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
                    <div className="flex items-center gap-2 text-xs uppercase text-[var(--text-muted)]">
                      <ShieldCheck className="h-4 w-4" />
                      What this unlocks
                    </div>
                    <ul className="mt-4 space-y-3 text-[15px] leading-6 text-[var(--text-secondary)]">
                      {unlockItems.map((item) => (
                        <li key={item} className="flex items-center gap-3">
                          <Check className="h-4 w-4" />
                          <span>{item}</span>
                        </li>
                      ))}
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
