import { Check, ExternalLink, KeyRound, Puzzle } from "lucide-react"
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
import { LocalKeyImportForm } from "./LocalKeyImportForm"
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
  logoSrc?: string
  status: SignerSwitchStatus
  pubkeyLabel?: string | null
  pubkeyDetailLabel?: string | null
  error?: string | null
  authUrl?: string | null
  signerMethod?: "nip07" | "nip46" | "local" | null
  rememberedMethod?: "nip07" | "nip46" | "local" | null
  localKeyEnabled?: boolean
  onImportLocalKey?: (input: HTMLInputElement) => Promise<void> | void
  onPasteLocalKey?: (
    input: HTMLInputElement,
    signal: AbortSignal
  ) => Promise<boolean>
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
  logoSrc?: string
  title?: string
  description: string
  unlockLabel?: string
  unlockItems: readonly string[]
  error?: string | null
  authUrl?: string | null
  rememberedMethod?: "nip07" | "nip46" | "local" | null
  connectingMethod?: "nip07" | "nip46" | "local" | null
  pendingSwitch?: boolean
  extensionNotice?: string | null
  mobile?: boolean
  platform?: SignerPlatform
  localKeyEnabled?: boolean
  onImportLocalKey?: (input: HTMLInputElement) => Promise<void> | void
  onPasteLocalKey?: (
    input: HTMLInputElement,
    signal: AbortSignal
  ) => Promise<boolean>
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

const NSTART_URL = "https://nstart.me"
export function isMobileSignerEnvironment(
  input?: SignerEnvironmentInput
): boolean {
  return getSignerPlatform(input) !== "desktop"
}

function SignerHeader({
  logoSrc,
  title,
  description,
  titleRef,
}: {
  title: string
  description: string
  titleRef?: Ref<HTMLHeadingElement>
  logoSrc?: string
}) {
  return (
    <DialogHeader className="mx-auto max-w-md items-center text-center">
      <DialogTitle
        ref={titleRef}
        tabIndex={-1}
        className="mt-5 flex flex-wrap items-center justify-center gap-2 text-2xl font-semibold text-balance text-[var(--text-primary)] focus:outline-none"
      >
        {title === "Sign in to Conduit" ? (
          <SignInHeading logoSrc={logoSrc} />
        ) : (
          title
        )}
      </DialogTitle>
      <DialogDescription className="text-sm text-pretty text-[var(--text-secondary)]">
        {description}
      </DialogDescription>
    </DialogHeader>
  )
}

function SignInHeading({
  logoSrc = "/images/logo/logo-full.svg",
}: {
  logoSrc?: string
}) {
  return (
    <>
      <span>Sign in to</span>
      <img
        src={logoSrc}
        alt="Conduit"
        className="h-9 w-auto max-w-36 object-contain"
        draggable="false"
      />
    </>
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
      variant="outline"
      onClick={() => void Promise.resolve(onConnect()).catch(() => undefined)}
      disabled={connectDisabled}
      className="min-h-12 w-full justify-start gap-3 rounded-[var(--radius-md)] px-4 text-sm font-medium"
    >
      <Puzzle className="size-5" aria-hidden="true" />
      {connectPending ? "Connecting..." : "Sign in with Extension"}
    </Button>
  )
}

export function NoSignerSetupGuide({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "py-1 text-center text-sm text-pretty text-[var(--text-secondary)]",
        className
      )}
    >
      <span className="block font-medium text-[var(--text-primary)]">
        Need a Secret Key?
      </span>
      Go to{" "}
      <a
        href={NSTART_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-400 underline underline-offset-4"
      >
        nstart.me
      </a>{" "}
      to set up your identity.
    </p>
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
    <div className={cn("border-t border-[var(--border)] pt-4", className)}>
      <div className="text-sm font-medium text-[var(--text-muted)]">
        {label}
      </div>
      <ul className="mt-3 space-y-2 text-sm text-[var(--text-secondary)]">
        {unlockItems.map((item) => (
          <li key={item} className="flex items-start gap-2">
            <Check
              className="mt-0.5 size-4 shrink-0 text-primary-400"
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
  unlockLabel,
  unlockItems,
  error,
  authUrl,
  rememberedMethod,
  connectingMethod,
  pendingSwitch = false,
  extensionNotice,
  mobile,
  platform: requestedPlatform,
  localKeyEnabled,
  onImportLocalKey,
  onPasteLocalKey,
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
    requestedPlatform ?? (mobile === false ? "desktop" : getSignerPlatform())
  const isMobile = mobile ?? platform !== "desktop"
  const localAvailable = !!localKeyEnabled && !!onImportLocalKey
  const reconnectOnly =
    rememberedMethod === "nip46" || rememberedMethod === "local"
  const pairing = useSignerPairing({
    autoPrepare:
      !localAvailable && (platform === "ios" || platform === "android"),
    connectPending,
    connectDisabled,
    rememberedMethod,
    nostrConnectUri,
    error,
    onConnect: onConnectNostrConnect,
    onCancel: onCancelConnect,
  })
  const [extensionAttempted, setExtensionAttempted] = useState(false)
  const browserSignerDisabled =
    connectDisabled && !(connectPending && connectingMethod === "nip46")
  const connectBrowserSigner = () => {
    setExtensionAttempted(true)
    return connectPending && connectingMethod === "nip46"
      ? pairing.cancelAndRun(onConnectExtension)
      : onConnectExtension()
  }
  const browserError =
    connectingMethod === "nip07" ||
    (rememberedMethod === "nip07" && connectingMethod !== "nip46")
  const errorAlert = error ? (
    <div
      id={errorId}
      role="alert"
      className="rounded-[var(--radius-md)] border border-error/30 bg-error/10 p-4 text-[15px] leading-6 text-[var(--error-text)]"
    >
      {error}
    </div>
  ) : null

  return (
    <>
      <div
        className={cn("mx-auto mt-6 w-full max-w-md space-y-3", bodyClassName)}
      >
        {rememberedMethod && onReconnect && (
          <Button
            type="button"
            variant="primary"
            onClick={() =>
              void Promise.resolve(onReconnect()).catch(() => undefined)
            }
            disabled={connectDisabled}
            className="h-12 w-full justify-center gap-2 rounded-[var(--radius-md)]"
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {connectPending && connectingMethod === null
              ? "Reconnecting..."
              : "Reconnect your account"}
          </Button>
        )}

        {(rememberedMethod === "nip46" || rememberedMethod === "local") &&
          onForget && (
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                void Promise.resolve(onForget()).catch(() => undefined)
              }
              disabled={connectDisabled}
              className="h-10 w-full justify-center"
            >
              {rememberedMethod === "local"
                ? "Remove saved local signer"
                : "Forget remote signer"}
            </Button>
          )}

        {localAvailable && onImportLocalKey && (
          <LocalKeyImportForm
            disabled={connectDisabled || connectPending}
            onPaste={onPasteLocalKey}
            onImport={(input) => pairing.run(() => onImportLocalKey(input))}
          />
        )}

        {!reconnectOnly && (!isMobile || rememberedMethod !== "nip07") && (
          <ExtensionConnectButton
            connectPending={connectPending && connectingMethod === "nip07"}
            connectDisabled={browserSignerDisabled}
            onConnect={connectBrowserSigner}
          />
        )}

        {browserError && errorAlert}

        {!reconnectOnly && (
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
        )}

        {!browserError && errorAlert}

        {authUrl && (
          <div className="rounded-[var(--radius-md)] border border-warning/30 bg-warning/10 p-4 text-[15px] leading-6 text-[var(--text-secondary)]">
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

        <NoSignerSetupGuide />
      </div>

      <div className={cn("mx-auto mt-4 grid max-w-md gap-4", bodyClassName)}>
        <SignerUnlockCard label={unlockLabel} unlockItems={unlockItems} />
      </div>

      {pendingSwitch && (
        <div
          className={cn(
            "mx-auto mt-4 max-w-md rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-[15px] leading-6 text-[var(--text-secondary)]",
            bodyClassName
          )}
        >
          Choose another extension account or paste a new remote signer URI,
          then reconnect here.
        </div>
      )}

      {extensionAttempted && extensionNotice && (
        <div
          className={cn(
            "mx-auto mt-4 max-w-md rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-[15px] leading-6 text-[var(--text-secondary)]",
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
  logoSrc,
  title = "Sign in to Conduit",
  description,
  unlockLabel,
  unlockItems,
  error,
  authUrl,
  rememberedMethod,
  connectingMethod,
  pendingSwitch,
  extensionNotice,
  mobile,
  platform,
  localKeyEnabled,
  onImportLocalKey,
  onPasteLocalKey,
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
        "rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-dialog)] text-[var(--text-primary)] shadow-[var(--shadow-dialog)]",
        className
      )}
    >
      <div className="relative px-5 py-5 sm:px-6 sm:py-6">
        <div className="mx-auto max-w-md text-center">
          <h1
            id={titleId}
            className="mt-5 flex flex-wrap items-center justify-center gap-2 text-2xl font-semibold text-balance text-[var(--text-primary)]"
          >
            {title === "Sign in to Conduit" ? (
              <SignInHeading logoSrc={logoSrc} />
            ) : (
              title
            )}
          </h1>
          <p className="mt-2 text-sm text-pretty text-[var(--text-secondary)]">
            {description}
          </p>
        </div>

        <SignerDisconnectedContent
          unlockLabel={unlockLabel}
          unlockItems={unlockItems}
          error={error}
          authUrl={authUrl}
          rememberedMethod={rememberedMethod}
          connectingMethod={connectingMethod}
          pendingSwitch={pendingSwitch}
          extensionNotice={extensionNotice}
          mobile={mobile}
          platform={platform}
          localKeyEnabled={localKeyEnabled}
          onImportLocalKey={onImportLocalKey}
          onPasteLocalKey={onPasteLocalKey}
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
  logoSrc,
  status,
  pubkeyLabel,
  pubkeyDetailLabel,
  error,
  authUrl,
  signerMethod,
  rememberedMethod,
  localKeyEnabled,
  onImportLocalKey,
  onPasteLocalKey,
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
      ? "Open or unlock your browser extension, then try again."
      : null

  function setOpen(nextOpen: boolean): void {
    if (!isControlled) setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  const triggerLabel = useMemo(() => {
    if (authPending) return "Connecting..."
    if (connected) return `Signer: ${pubkeyLabel}`
    return "Sign In"
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
        className="max-h-[calc(100dvh-1.5rem)] max-w-lg touch-pan-y overflow-y-auto overscroll-contain border-[var(--border)] bg-[var(--surface-dialog)] p-0 text-[var(--text-primary)] shadow-[var(--shadow-dialog)] [-webkit-overflow-scrolling:touch]"
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
                  logoSrc={logoSrc}
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
                  logoSrc={logoSrc}
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
                    unlockItems={unlockItems}
                    error={error}
                    authUrl={authUrl}
                    rememberedMethod={rememberedMethod}
                    connectingMethod={
                      status === "restoring" ? null : signerMethod
                    }
                    extensionNotice={extensionNotice}
                    mobile={mobile}
                    localKeyEnabled={localKeyEnabled}
                    onImportLocalKey={onImportLocalKey}
                    onPasteLocalKey={onPasteLocalKey}
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
