import { Check, ExternalLink, KeyRound, ShieldCheck } from "lucide-react"
import { useId, useMemo, useRef, useState, type Ref } from "react"
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
import { cn } from "../utils"

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

export interface SignerConnectPanelProps {
  title?: string
  description: string
  helperText: string
  unlockLabel?: string
  unlockItems: readonly string[]
  error?: string | null
  pendingSwitch?: boolean
  extensionNotice?: string | null
  mobileSignerUnavailable?: boolean
  connectPending?: boolean
  connectDisabled?: boolean
  className?: string
  bodyClassName?: string
  onConnect: () => Promise<void> | void
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
  return <KeyRound className={className} aria-hidden="true" />
}

const NSTART_URL = "https://nstart.me"
const ALBY_URL = "https://getalby.com/"
const NOSTR_GET_STARTED_URL = "https://grownostr.org/get-started"
const signerConnectButtonClassName =
  "h-14 w-full justify-center gap-3 rounded-xl bg-[linear-gradient(90deg,var(--primary-500),var(--primary-600))] text-base font-semibold text-[var(--on-primary)] shadow-[0_18px_38px_color-mix(in_srgb,var(--primary-500)_32%,transparent)] hover:brightness-110 focus-visible:ring-primary-400 disabled:brightness-75"

function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
}

function SignerHeader({
  title,
  description,
  titleRef,
}: {
  title: string
  description: string
  titleRef?: Ref<HTMLHeadingElement>
}) {
  return (
    <DialogHeader className="mx-auto max-w-md items-center text-center">
      <ConduitLogoLockup className="h-11" />
      <DialogTitle
        ref={titleRef}
        tabIndex={-1}
        className="mt-4 flex items-center gap-2 text-2xl font-semibold text-[var(--text-primary)] focus:outline-none sm:text-[2rem]"
      >
        <span>{title}</span>
      </DialogTitle>
      <DialogDescription className="max-w-md text-[15px] leading-6 text-[var(--text-secondary)]">
        {description}
      </DialogDescription>
    </DialogHeader>
  )
}

function SignerConnectButton({
  connectPending,
  connectDisabled,
  onConnect,
}: {
  connectPending: boolean
  connectDisabled: boolean
  onConnect: () => Promise<void> | void
}) {
  return (
    <Button
      type="button"
      onClick={() => void onConnect()}
      disabled={connectDisabled}
      className={signerConnectButtonClassName}
    >
      <SignerGlyph />
      {connectPending ? "Connecting..." : "Connect signer"}
    </Button>
  )
}

export function NoSignerSetupGuide({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-5 text-left sm:p-6",
        className
      )}
    >
      <div className="text-sm font-semibold text-[var(--text-primary)]">
        Need a signer?
      </div>
      <ol className="mt-5 space-y-5 text-[15px] leading-6 text-[var(--text-secondary)]">
        <li className="flex gap-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-primary-500/70 text-sm font-medium text-[var(--text-primary)]">
            1
          </span>
          <span className="pt-1">
            Start at{" "}
            <a
              href={NSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline rounded-sm font-medium text-primary-400 underline underline-offset-4 transition-colors hover:text-primary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-elevated)]"
            >
              nstart.me
            </a>{" "}
            to set up your Nostr identity.
          </span>
        </li>
        <li className="flex gap-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-primary-500/70 text-sm font-medium text-[var(--text-primary)]">
            2
          </span>
          <span className="pt-1">
            Set up the{" "}
            <a
              href={ALBY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline rounded-sm font-medium text-primary-400 underline underline-offset-4 transition-colors hover:text-primary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-elevated)]"
            >
              Alby
            </a>{" "}
            browser extension as your signer and wallet.
          </span>
        </li>
        <li className="flex gap-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-primary-500/70 text-sm font-medium text-[var(--text-primary)]">
            3
          </span>
          <span className="pt-1">Return to Conduit and connect.</span>
        </li>
      </ol>
      <div className="mt-6">
        <Button
          asChild
          variant="outline"
          size="md"
          className="border-primary-500/70 px-5 text-[var(--text-secondary)] hover:border-primary-400 hover:text-[var(--text-primary)]"
        >
          <a
            href={NOSTR_GET_STARTED_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Learn more about getting started with Nostr"
          >
            Learn more
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
      </div>
    </div>
  )
}

export function SignerUnlockCard({
  label = "What this unlocks",
  unlockItems,
  className,
}: {
  label?: string
  unlockItems: readonly string[]
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-5 sm:p-6",
        className
      )}
    >
      <div className="flex items-center gap-2 text-xs uppercase text-[var(--text-muted)]">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        {label}
      </div>
      <ul className="mt-5 space-y-4 text-[15px] leading-6 text-[var(--text-secondary)]">
        {unlockItems.map((item) => (
          <li key={item} className="flex items-start gap-4">
            <Check
              className="mt-0.5 h-5 w-5 shrink-0 text-primary-400"
              aria-hidden="true"
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SignerDisconnectedContent({
  helperText,
  unlockLabel,
  unlockItems,
  error,
  pendingSwitch = false,
  extensionNotice,
  mobileSignerUnavailable = false,
  connectPending = false,
  connectDisabled = false,
  bodyClassName,
  onConnect,
}: Omit<SignerConnectPanelProps, "title" | "description" | "className">) {
  return (
    <>
      <div
        className={cn("mx-auto mt-6 w-full max-w-md space-y-3", bodyClassName)}
      >
        {!mobileSignerUnavailable && (
          <SignerConnectButton
            connectPending={connectPending}
            connectDisabled={connectDisabled}
            onConnect={onConnect}
          />
        )}

        <p className="px-4 pt-2 text-center text-[15px] italic leading-6 text-[var(--text-secondary)]">
          {helperText}
        </p>

        <NoSignerSetupGuide />
      </div>

      <div className={cn("mx-auto mt-4 grid max-w-md gap-4", bodyClassName)}>
        <SignerUnlockCard label={unlockLabel} unlockItems={unlockItems} />
      </div>

      {pendingSwitch && (
        <div
          className={cn(
            "mx-auto mt-4 max-w-md rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-[15px] leading-6 text-[var(--text-secondary)]",
            bodyClassName
          )}
        >
          Change the active account in your browser extension, then reconnect
          here.
        </div>
      )}

      {error && (
        <div
          className={cn(
            "mx-auto mt-4 max-w-md rounded-[1.25rem] border border-error/30 bg-error/10 p-4 text-[15px] leading-6 text-error",
            bodyClassName
          )}
        >
          {error}
        </div>
      )}

      {extensionNotice && (
        <div
          className={cn(
            "mx-auto mt-4 max-w-md rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-[15px] leading-6 text-[var(--text-secondary)]",
            bodyClassName
          )}
        >
          {extensionNotice}
        </div>
      )}
    </>
  )
}

export function SignerConnectPanel({
  title = "Connect a signer",
  description,
  helperText,
  unlockLabel,
  unlockItems,
  error,
  pendingSwitch,
  extensionNotice,
  mobileSignerUnavailable,
  connectPending,
  connectDisabled,
  className,
  bodyClassName,
  onConnect,
}: SignerConnectPanelProps) {
  const titleId = useId()

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface-dialog)] text-[var(--text-primary)] shadow-[var(--shadow-dialog)]",
        className
      )}
    >
      <div className="relative px-5 py-5 sm:px-6 sm:py-6">
        <div className="mx-auto max-w-md text-center">
          <ConduitLogoLockup className="h-11" />
          <h1
            id={titleId}
            className="mt-4 text-2xl font-semibold text-balance text-[var(--text-primary)] sm:text-[2rem]"
          >
            {title}
          </h1>
          <p className="mt-2 text-[15px] leading-6 text-pretty text-[var(--text-secondary)]">
            {description}
          </p>
        </div>

        <SignerDisconnectedContent
          helperText={helperText}
          unlockLabel={unlockLabel}
          unlockItems={unlockItems}
          error={error}
          pendingSwitch={pendingSwitch}
          extensionNotice={extensionNotice}
          mobileSignerUnavailable={mobileSignerUnavailable}
          connectPending={connectPending}
          connectDisabled={connectDisabled}
          bodyClassName={bodyClassName}
          onConnect={onConnect}
        />
      </div>
    </section>
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
  const titleRef = useRef<HTMLHeadingElement>(null)
  const mobileSignerUnavailable =
    isMobileBrowser() && !extensionAvailable && status !== "connected"
  const isControlled = typeof open === "boolean"
  const isOpen = isControlled ? open : internalOpen
  const connected = status === "connected" && !!pubkeyLabel
  const authPending = status === "connecting" || status === "restoring"
  const signerHelperText = mobileSignerUnavailable
    ? "Try a desktop browser with a signer extension, or a mobile browser that already exposes one."
    : "Conduit currently supports external signers only."
  const extensionNotice =
    !extensionAvailable && !mobileSignerUnavailable
      ? "No signer extension detected. Install a NIP-07 signer such as Alby or nos2x, then refresh and connect."
      : null

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

      <DialogContent
        className="max-h-[calc(100dvh-1.5rem)] max-w-xl overflow-y-auto border-[var(--border)] bg-[var(--surface-dialog)] p-0 text-[var(--text-primary)] shadow-[var(--shadow-dialog)]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus({ preventScroll: true })
        }}
      >
        <div className="relative rounded-[inherit] border border-[var(--border)] bg-[var(--surface-dialog)]">
          <div className="relative px-5 py-5 sm:px-6 sm:py-6">
            {connected ? (
              <>
                <SignerHeader
                  title="Signer connected"
                  description={connectedDescription}
                  titleRef={titleRef}
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
                  titleRef={titleRef}
                />

                <SignerDisconnectedContent
                  helperText={signerHelperText}
                  unlockItems={unlockItems}
                  error={error}
                  pendingSwitch={pendingSwitch}
                  extensionNotice={extensionNotice}
                  mobileSignerUnavailable={mobileSignerUnavailable}
                  connectPending={authPending || isWorking}
                  connectDisabled={isWorking || authPending}
                  onConnect={handleConnect}
                />
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
