import { Check, ExternalLink, KeyRound, ShieldCheck } from "lucide-react"
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react"
import { Button } from "./Button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./Dialog"
import { SignerConnectedContent } from "./SignerConnectedContent"
import { RemoteSignerConnect } from "./RemoteSignerConnect"
import {
  getSignerPlatform,
  type SignerEnvironmentInput,
  type SignerPlatform,
} from "./signer-platform"
import { useSignerPairing } from "./use-signer-pairing"
export type { SignerEnvironmentInput } from "./signer-platform"
import { cn } from "../utils"

export type SignerSwitchStatus =
  "disconnected" | "restoring" | "connecting" | "connected" | "error"

export interface SignerSwitchProps {
  status: SignerSwitchStatus
  pubkeyLabel?: string | null
  pubkeyDetailLabel?: string | null
  error?: string | null
  authUrl?: string | null
  signerMethod?: "nip07" | "nip46" | null
  rememberedMethod?: "nip07" | "nip46" | null
  extensionAvailable: boolean
  connectedDescription: string
  connectDescription: string
  unlockItems: readonly string[]
  connectedUseDescription: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
  nostrConnectUri?: string | null
  onConnectExtension: () => Promise<void> | void
  onConnectNostrConnect: () => Promise<void> | void
  onConnectRemote: (bunkerUri: string) => Promise<void> | void
  onCancelConnect: () => Promise<void> | void
  onReconnect?: () => Promise<void> | void
  onDisconnect: () => Promise<void> | void
}

export interface SignerConnectPanelProps {
  title?: string
  description: string
  helperText: string
  unlockLabel?: string
  unlockItems: readonly string[]
  error?: string | null
  authUrl?: string | null
  rememberedMethod?: "nip07" | "nip46" | null
  connectingMethod?: "nip07" | "nip46" | null
  pendingSwitch?: boolean
  extensionNotice?: string | null
  mobile?: boolean
  platform?: SignerPlatform
  /** Offer the Clave Universal Link handoff; defaults to iOS detection. */
  ios?: boolean
  extensionAvailable: boolean
  connectPending?: boolean
  connectDisabled?: boolean
  className?: string
  bodyClassName?: string
  nostrConnectUri?: string | null
  onConnectExtension: () => Promise<void> | void
  onConnectNostrConnect: () => Promise<void> | void
  onConnectRemote: (bunkerUri: string) => Promise<void> | void
  onCancelConnect: () => Promise<void> | void
  onReconnect?: () => Promise<void> | void
  onForget?: () => Promise<void> | void
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
  "h-14 w-full justify-center gap-3 rounded-xl bg-[linear-gradient(90deg,var(--primary-500),var(--primary-600))] text-base font-semibold text-[var(--on-primary)] shadow-[0_8px_20px_color-mix(in_srgb,var(--primary-500)_24%,transparent)] hover:brightness-110 focus-visible:ring-primary-400 disabled:brightness-75"
export function isMobileSignerEnvironment(
  input?: SignerEnvironmentInput
): boolean {
  return getSignerPlatform(input) !== "desktop"
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

function ExtensionConnectButton({
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
      onClick={() => void Promise.resolve(onConnect()).catch(() => undefined)}
      disabled={connectDisabled}
      className={signerConnectButtonClassName}
    >
      <SignerGlyph />
      {connectPending ? "Connecting..." : "Connect Extension (NIP-07)"}
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
  authUrl,
  rememberedMethod,
  connectingMethod,
  pendingSwitch = false,
  extensionNotice,
  mobile,
  ios,
  platform: requestedPlatform,
  extensionAvailable,
  connectPending = false,
  connectDisabled = false,
  bodyClassName,
  nostrConnectUri,
  onConnectExtension,
  onConnectNostrConnect,
  onConnectRemote,
  onCancelConnect,
  onReconnect,
  onForget,
}: Omit<SignerConnectPanelProps, "title" | "description" | "className">) {
  const errorId = useId()
  const platform =
    requestedPlatform ??
    (ios ? "ios" : mobile === false ? "desktop" : getSignerPlatform())
  const isMobile = mobile ?? platform !== "desktop"
  const pairing = useSignerPairing({
    autoPrepare: platform === "ios" || platform === "android",
    connectPending,
    connectDisabled,
    rememberedMethod,
    nostrConnectUri,
    error,
    onConnect: onConnectNostrConnect,
    onCancel: onCancelConnect,
  })

  return (
    <>
      <div
        className={cn("mx-auto mt-6 w-full max-w-md space-y-3", bodyClassName)}
      >
        {rememberedMethod &&
          onReconnect &&
          (!isMobile || rememberedMethod === "nip46") && (
            <Button
              type="button"
              variant="primary"
              onClick={() =>
                void Promise.resolve(onReconnect()).catch(() => undefined)
              }
              disabled={connectDisabled}
              className="h-12 w-full justify-center gap-2 rounded-xl"
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              {connectPending ? "Reconnecting..." : "Reconnect your account"}
            </Button>
          )}

        {rememberedMethod === "nip46" && onForget && (
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              void Promise.resolve(onForget()).catch(() => undefined)
            }
            disabled={connectDisabled}
            className="h-10 w-full justify-center"
          >
            Forget remote signer
          </Button>
        )}

        {!isMobile && (
          <ExtensionConnectButton
            connectPending={connectPending && connectingMethod === "nip07"}
            connectDisabled={connectDisabled || !extensionAvailable}
            onConnect={onConnectExtension}
          />
        )}

        <RemoteSignerConnect
          connectPending={connectPending && connectingMethod === "nip46"}
          connectDisabled={connectDisabled}
          platform={platform}
          error={error}
          errorId={errorId}
          nostrConnectUri={nostrConnectUri}
          onConnectNostrConnect={pairing.start}
          onConnectBunker={(uri) => pairing.run(() => onConnectRemote(uri))}
          onCancelConnect={pairing.cancel}
        />

        {error && (
          <div
            id={errorId}
            role="alert"
            className="rounded-[1.25rem] border border-error/30 bg-error/10 p-4 text-[15px] leading-6 text-error"
          >
            {error}
          </div>
        )}

        {authUrl && (
          <div className="rounded-[1.25rem] border border-warning/30 bg-warning/10 p-4 text-[15px] leading-6 text-[var(--text-secondary)]">
            Your remote signer needs approval. Open the authorization page, then
            return here.
            <Button asChild variant="outline" size="sm" className="mt-3 w-full">
              <a href={authUrl} target="_blank" rel="noopener noreferrer">
                Open signer approval
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
          </div>
        )}

        {!isMobile && (
          <p className="px-4 pt-2 text-center text-[15px] leading-6 text-[var(--text-secondary)]">
            {helperText}
          </p>
        )}

        <p className="px-4 text-center text-sm leading-5 text-[var(--text-muted)]">
          Your account keys stay in your signer app. Conduit cannot recover
          them.
        </p>
        <p className="px-4 text-center text-xs leading-5 text-[var(--text-muted)]">
          This device remembers an encrypted connection you can revoke in your
          signer.
        </p>

        {!isMobile && <NoSignerSetupGuide />}
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
          Choose another extension account or paste a new remote signer URI,
          then reconnect here.
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
  title = "Sign in to Conduit",
  description,
  helperText,
  unlockLabel,
  unlockItems,
  error,
  authUrl,
  rememberedMethod,
  connectingMethod,
  pendingSwitch,
  extensionNotice,
  mobile,
  ios,
  platform,
  extensionAvailable,
  connectPending,
  connectDisabled,
  className,
  bodyClassName,
  nostrConnectUri,
  onConnectExtension,
  onConnectNostrConnect,
  onConnectRemote,
  onCancelConnect,
  onReconnect,
  onForget,
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
          authUrl={authUrl}
          rememberedMethod={rememberedMethod}
          connectingMethod={connectingMethod}
          pendingSwitch={pendingSwitch}
          extensionNotice={extensionNotice}
          mobile={mobile}
          ios={ios}
          platform={platform}
          extensionAvailable={extensionAvailable}
          connectPending={connectPending}
          connectDisabled={connectDisabled}
          bodyClassName={bodyClassName}
          nostrConnectUri={nostrConnectUri}
          onConnectExtension={onConnectExtension}
          onConnectNostrConnect={onConnectNostrConnect}
          onConnectRemote={onConnectRemote}
          onCancelConnect={onCancelConnect}
          onReconnect={onReconnect}
          onForget={onForget}
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
  authUrl,
  signerMethod,
  rememberedMethod,
  extensionAvailable,
  connectedDescription,
  connectDescription,
  unlockItems,
  connectedUseDescription,
  open,
  onOpenChange,
  hideTrigger = false,
  nostrConnectUri,
  onConnectExtension,
  onConnectNostrConnect,
  onConnectRemote,
  onCancelConnect,
  onReconnect,
  onDisconnect,
}: SignerSwitchProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [isWorking, setIsWorking] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const mobile = isMobileSignerEnvironment()
  const isControlled = typeof open === "boolean"
  const isOpen = isControlled ? open : internalOpen
  const connected = status === "connected" && !!pubkeyLabel
  const authPending = status === "connecting" || status === "restoring"
  const extensionNotice =
    !extensionAvailable && !mobile
      ? "No complete NIP-07 signer detected yet. Install or unlock a signer such as Alby or nos2x, then try Connect signer again."
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

  const finishSignIn = useEffectEvent(() => setOpen(false))
  const wasConnected = useRef(connected)
  useEffect(() => {
    const becameConnected = connected && !wasConnected.current
    wasConnected.current = connected
    if (becameConnected) finishSignIn()
  }, [connected])

  async function handleSwitchSigner(): Promise<void> {
    if (!connected || isWorking) return
    setIsWorking(true)
    try {
      await onDisconnect()
    } catch {
      // Keep the current signer view open so its cleanup error stays visible.
    } finally {
      setIsWorking(false)
    }
  }

  async function handleDisconnect(): Promise<void> {
    if (isWorking) return
    setIsWorking(true)
    try {
      await onDisconnect()
      setOpen(false)
    } catch {
      // Keep the dialog open so the inline cleanup error remains visible.
    } finally {
      setIsWorking(false)
    }
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
        className="max-h-[calc(100dvh-1.5rem)] max-w-xl touch-pan-y overflow-y-auto overscroll-contain border-[var(--border)] bg-[var(--surface-dialog)] p-0 text-[var(--text-primary)] shadow-[var(--shadow-dialog)] [-webkit-overflow-scrolling:touch]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus({ preventScroll: true })
        }}
      >
        <div className="relative rounded-[inherit]">
          <div className="relative px-5 py-5 sm:px-6 sm:py-6">
            {connected ? (
              <>
                <SignerHeader
                  title="Signer connected"
                  description={connectedDescription}
                  titleRef={titleRef}
                />

                <SignerConnectedContent
                  pubkeyLabel={pubkeyLabel}
                  pubkeyDetailLabel={pubkeyDetailLabel}
                  signerMethod={signerMethod}
                  connectedUseDescription={connectedUseDescription}
                  authUrl={authUrl}
                  error={error}
                  isWorking={isWorking}
                  onDisconnect={handleDisconnect}
                  onSwitchSigner={handleSwitchSigner}
                />
              </>
            ) : (
              <>
                <SignerHeader
                  title="Sign in to Conduit"
                  description={connectDescription}
                  titleRef={titleRef}
                />

                {isWorking && (
                  <p
                    role="status"
                    className="mt-6 text-center text-sm text-[var(--text-secondary)]"
                  >
                    Finishing sign-out…
                  </p>
                )}
                {isOpen && !isWorking && (
                  <SignerDisconnectedContent
                    helperText="Choose a browser extension or remote signer."
                    unlockItems={unlockItems}
                    error={error}
                    authUrl={authUrl}
                    rememberedMethod={rememberedMethod}
                    connectingMethod={
                      status === "restoring" ? null : signerMethod
                    }
                    extensionNotice={extensionNotice}
                    mobile={mobile}
                    extensionAvailable={extensionAvailable}
                    connectPending={authPending || isWorking}
                    connectDisabled={isWorking || authPending}
                    nostrConnectUri={nostrConnectUri}
                    onConnectExtension={onConnectExtension}
                    onConnectNostrConnect={onConnectNostrConnect}
                    onConnectRemote={onConnectRemote}
                    onCancelConnect={onCancelConnect}
                    onReconnect={onReconnect}
                    onForget={onDisconnect}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
