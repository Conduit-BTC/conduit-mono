import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  QrCode,
  ShieldCheck,
} from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { useEffect, useId, useMemo, useRef, useState, type Ref } from "react"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs"
import { Textarea } from "./Textarea"
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
const AMBER_URL = "https://github.com/greenart7c3/Amber"
const CLAVE_URL = "https://github.com/DocNR/clave"
const signerConnectButtonClassName =
  "h-14 w-full justify-center gap-3 rounded-xl bg-[linear-gradient(90deg,var(--primary-500),var(--primary-600))] text-base font-semibold text-[var(--on-primary)] shadow-[0_8px_20px_color-mix(in_srgb,var(--primary-500)_24%,transparent)] hover:brightness-110 focus-visible:ring-primary-400 disabled:brightness-75"
const remoteSignerTabClassName =
  "min-h-11 min-w-0 gap-1 rounded-lg border border-transparent px-1 text-xs whitespace-normal data-[state=active]:border-primary-600 data-[state=active]:bg-primary-500 data-[state=active]:font-semibold data-[state=active]:text-white data-[state=active]:shadow-none data-[state=inactive]:hover:border-[var(--border)] data-[state=inactive]:hover:bg-[color-mix(in_srgb,var(--primary-500)_2%,var(--surface))] sm:text-sm"

export interface SignerEnvironmentInput {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
}

export function isMobileSignerEnvironment(
  input?: SignerEnvironmentInput
): boolean {
  const environment =
    input ??
    (typeof navigator === "undefined"
      ? { userAgent: "" }
      : {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          maxTouchPoints: navigator.maxTouchPoints,
        })
  return (
    /android|iphone|ipad|ipod|mobile/i.test(environment.userAgent) ||
    (environment.platform === "MacIntel" &&
      (environment.maxTouchPoints ?? 0) > 1)
  )
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

function RemoteSignerConnect({
  connectPending,
  connectDisabled,
  nostrConnectUri,
  onConnectNostrConnect,
  onConnectBunker,
  onCancelConnect,
}: {
  connectPending: boolean
  connectDisabled: boolean
  nostrConnectUri?: string | null
  onConnectNostrConnect: () => Promise<void> | void
  onConnectBunker: (bunkerUri: string) => Promise<void> | void
  onCancelConnect: () => Promise<void> | void
}) {
  const [bunkerUri, setBunkerUri] = useState("")
  const [activeTab, setActiveTab] = useState("qr")
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const connectionUrlRef = useRef<HTMLTextAreaElement>(null)
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setCopied(false)
    setCopyError(false)
    if (copyResetTimer.current) {
      clearTimeout(copyResetTimer.current)
      copyResetTimer.current = null
    }
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    }
  }, [nostrConnectUri])

  async function submitBunker(): Promise<void> {
    const uri = bunkerUri.trim()
    if (!uri || connectDisabled) return
    try {
      await onConnectBunker(uri)
      setBunkerUri("")
    } catch {
      // Auth state owns the actionable inline error.
    }
  }

  async function copyConnectionUrl(): Promise<void> {
    if (!nostrConnectUri) return
    let copySucceeded = false
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(nostrConnectUri)
        copySucceeded = true
      }
    } catch {
      // Fall back to selection-based copying for older mobile browsers.
    }
    if (!copySucceeded && connectionUrlRef.current) {
      connectionUrlRef.current.focus()
      connectionUrlRef.current.select()
      connectionUrlRef.current.setSelectionRange(0, nostrConnectUri.length)
      try {
        copySucceeded = document.execCommand("copy")
      } catch {
        copySucceeded = false
      }
    }
    setCopied(copySucceeded)
    setCopyError(!copySucceeded)
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    copyResetTimer.current = window.setTimeout(() => setCopied(false), 1_500)
  }

  const waitingForScan =
    !!nostrConnectUri || activeTab === "qr" || activeTab === "url"

  return (
    <div className="space-y-3 rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
      <div className="flex items-start gap-3">
        <Link2
          className="mt-0.5 h-5 w-5 shrink-0 text-primary-400"
          aria-hidden="true"
        />
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">
            Connect Signer (NIP-46)
          </div>
          <p className="mt-1 text-sm leading-5 text-[var(--text-secondary)]">
            Pair by QR code, connection URL, or a bunker URL from your remote
            signer.
          </p>
        </div>
      </div>
      {connectPending && (
        <div className="space-y-2">
          <div
            role="status"
            className="rounded-xl border border-primary-500/25 bg-primary-500/10 p-3 text-sm leading-5 text-[var(--text-secondary)]"
          >
            {waitingForScan
              ? "Waiting for your remote signer to scan the QR code or open the connection URL."
              : "Waiting for approval from your remote signer. Approve the bunker connection, then return here."}
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() =>
              void Promise.resolve(onCancelConnect()).catch(() => undefined)
            }
          >
            Cancel pairing
          </Button>
        </div>
      )}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList
          className="grid h-auto w-full grid-cols-3 rounded-xl p-1"
          aria-label="Remote signer connection method"
        >
          <TabsTrigger value="qr" className={remoteSignerTabClassName}>
            <QrCode className="h-4 w-4 shrink-0" aria-hidden="true" />
            QR code
          </TabsTrigger>
          <TabsTrigger
            value="url"
            className={`${remoteSignerTabClassName} leading-tight`}
          >
            <Link2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            Connection URL
          </TabsTrigger>
          <TabsTrigger value="bunker" className={remoteSignerTabClassName}>
            <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
            Bunker URL
          </TabsTrigger>
        </TabsList>

        <TabsContent value="qr" className="min-w-0">
          {nostrConnectUri ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <div
                role="img"
                aria-label="Nostr Connect connection QR code"
                className="rounded-lg bg-white p-3"
              >
                <QRCodeSVG
                  value={nostrConnectUri}
                  size={200}
                  level="M"
                  className="h-auto w-[min(200px,65vw)] max-w-full"
                />
              </div>
              <p className="text-sm leading-5 text-[var(--text-secondary)]">
                Scan with your remote signer to connect.
              </p>
            </div>
          ) : (
            <NostrConnectStartButton
              connectDisabled={connectDisabled}
              connectPending={connectPending}
              onConnect={onConnectNostrConnect}
            />
          )}
        </TabsContent>

        <TabsContent value="url" className="min-w-0">
          {nostrConnectUri ? (
            <div className="space-y-3">
              <Textarea
                ref={connectionUrlRef}
                value={nostrConnectUri}
                readOnly
                aria-label="Nostr Connect connection URL"
                spellCheck={false}
                className="min-h-24 resize-none break-all font-mono text-xs"
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <Button asChild className="w-full">
                  <a href={nostrConnectUri}>
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    Open in signer
                  </a>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void copyConnectionUrl()}
                  aria-label={
                    copied ? "Connection URL copied" : "Copy connection URL"
                  }
                  className="w-full"
                >
                  {copied ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  )}
                  {copied ? "Copied" : "Copy connection URL"}
                </Button>
              </div>
              <p aria-live="polite" className="sr-only">
                {copied ? "Connection URL copied to clipboard." : ""}
              </p>
              {copyError && (
                <p role="alert" className="text-sm leading-5 text-error">
                  Copy was blocked. Select the URL above and copy it manually.
                </p>
              )}
            </div>
          ) : (
            <NostrConnectStartButton
              connectDisabled={connectDisabled}
              connectPending={connectPending}
              onConnect={onConnectNostrConnect}
            />
          )}
        </TabsContent>

        <TabsContent value="bunker" className="min-w-0 space-y-3">
          <Textarea
            value={bunkerUri}
            onChange={(event) => setBunkerUri(event.target.value)}
            placeholder="bunker://..."
            aria-label="Remote signer bunker URL"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={connectDisabled}
            className="min-h-20 resize-none break-all font-mono text-xs"
          />
          <Button
            type="button"
            onClick={() => void submitBunker()}
            disabled={connectDisabled || !bunkerUri.trim()}
            className={signerConnectButtonClassName}
          >
            <Link2 className="h-5 w-5" aria-hidden="true" />
            {connectPending ? "Connecting..." : "Connect Signer (NIP-46)"}
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function NostrConnectStartButton({
  connectDisabled,
  connectPending,
  onConnect,
}: {
  connectDisabled: boolean
  connectPending: boolean
  onConnect: () => Promise<void> | void
}) {
  return (
    <div className="space-y-3 text-center">
      <p className="text-sm leading-5 text-[var(--text-secondary)]">
        Create a temporary connection to pair with your remote signer.
      </p>
      <Button
        type="button"
        onClick={() => void Promise.resolve(onConnect()).catch(() => undefined)}
        disabled={connectDisabled}
        className={signerConnectButtonClassName}
      >
        <QrCode className="h-5 w-5" aria-hidden="true" />
        {connectPending ? "Starting connection..." : "Create connection"}
      </Button>
    </div>
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

function RemoteSignerSetupGuide() {
  return (
    <div className="rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-5 text-left">
      <div className="text-sm font-semibold text-[var(--text-primary)]">
        Need a remote signer?
      </div>
      <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
        Create a bunker connection in a compatible signer such as Amber or
        Clave, then paste it in the Bunker URL tab.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={AMBER_URL} target="_blank" rel="noopener noreferrer">
            Amber
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={CLAVE_URL} target="_blank" rel="noopener noreferrer">
            Clave
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
  mobile = false,
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
  return (
    <>
      <div
        className={cn("mx-auto mt-6 w-full max-w-md space-y-3", bodyClassName)}
      >
        {rememberedMethod &&
          onReconnect &&
          (!mobile || rememberedMethod === "nip46") && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void Promise.resolve(onReconnect()).catch(() => undefined)
              }
              disabled={connectDisabled}
              className="h-12 w-full justify-center gap-2 rounded-xl"
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              {connectPending
                ? "Reconnecting..."
                : `Reconnect ${rememberedMethod === "nip46" ? "NIP-46 signer" : "extension"}`}
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

        {!mobile && (
          <ExtensionConnectButton
            connectPending={connectPending && connectingMethod === "nip07"}
            connectDisabled={connectDisabled || !extensionAvailable}
            onConnect={onConnectExtension}
          />
        )}

        <RemoteSignerConnect
          connectPending={connectPending && connectingMethod === "nip46"}
          connectDisabled={connectDisabled}
          nostrConnectUri={nostrConnectUri}
          onConnectNostrConnect={onConnectNostrConnect}
          onConnectBunker={onConnectRemote}
          onCancelConnect={onCancelConnect}
        />

        {error && (
          <div
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

        <p className="px-4 pt-2 text-center text-[15px] italic leading-6 text-[var(--text-secondary)]">
          {helperText}
        </p>

        <p className="px-4 text-center text-sm leading-5 text-[var(--text-muted)]">
          Conduit never stores or recovers your keys.
        </p>
        <p className="px-4 text-center text-xs leading-5 text-[var(--text-muted)]">
          Remote reconnect stores an encrypted, revocable NIP-46 connection key
          on this device. Your identity key stays in your signer.
        </p>

        {mobile ? <RemoteSignerSetupGuide /> : <NoSignerSetupGuide />}
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
  title = "Connect a signer",
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
  const [pendingSwitch, setPendingSwitch] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const mobile = isMobileSignerEnvironment()
  const isControlled = typeof open === "boolean"
  const isOpen = isControlled ? open : internalOpen
  const connected = status === "connected" && !!pubkeyLabel
  const authPending = status === "connecting" || status === "restoring"
  const signerHelperText = mobile
    ? "Connect a remote signer to continue securely on mobile."
    : "Choose a browser extension or remote signer."
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

  async function handleConnectExtension(): Promise<void> {
    if (authPending) return
    setIsWorking(true)
    try {
      await onConnectExtension()
      setPendingSwitch(false)
      setOpen(false)
    } catch {
      // Keep the dialog open so the inline error remains visible.
    } finally {
      setIsWorking(false)
    }
  }

  async function handleConnectRemote(bunkerUri: string): Promise<void> {
    if (authPending) return
    setIsWorking(true)
    try {
      await onConnectRemote(bunkerUri)
      setPendingSwitch(false)
      setOpen(false)
    } catch {
      // Keep the dialog open so the inline error remains visible.
    } finally {
      setIsWorking(false)
    }
  }

  async function handleConnectNostrConnect(): Promise<void> {
    if (authPending) return
    setIsWorking(true)
    try {
      await onConnectNostrConnect()
      setPendingSwitch(false)
      setOpen(false)
    } catch {
      // Keep the dialog open so the inline error remains visible.
    } finally {
      setIsWorking(false)
    }
  }

  async function handleSwitchSigner(): Promise<void> {
    if (!connected || isWorking) return
    setIsWorking(true)
    try {
      await onDisconnect()
      setPendingSwitch(true)
    } finally {
      setIsWorking(false)
    }
  }

  async function handleDisconnect(): Promise<void> {
    if (isWorking) return
    setIsWorking(true)
    try {
      await onDisconnect()
      setPendingSwitch(false)
      setOpen(false)
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
                      <Badge variant="outline">
                        {signerMethod === "nip46" ? "NIP-46" : "NIP-07"}
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

                  {authUrl && (
                    <div className="rounded-[1.25rem] border border-warning/30 bg-warning/10 p-4 text-[15px] leading-6 text-[var(--text-secondary)]">
                      Your remote signer needs approval. Open the authorization
                      page, then return here.
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="mt-3 w-full"
                      >
                        <a
                          href={authUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open signer approval
                          <ExternalLink
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                        </a>
                      </Button>
                    </div>
                  )}

                  {pendingSwitch && (
                    <div className="rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-[15px] leading-6 text-[var(--text-secondary)]">
                      Choose another extension account or paste a new remote
                      signer URI, then reconnect here.
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
                    onClick={() => void handleDisconnect()}
                    disabled={isWorking}
                  >
                    {signerMethod === "nip46"
                      ? "Disconnect remote signer"
                      : "Disconnect"}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleSwitchSigner()}
                    disabled={isWorking}
                  >
                    Switch account
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <SignerHeader
                  title="Connect a signer"
                  description={connectDescription}
                  titleRef={titleRef}
                />

                <SignerDisconnectedContent
                  helperText={signerHelperText}
                  unlockItems={unlockItems}
                  error={error}
                  authUrl={authUrl}
                  rememberedMethod={rememberedMethod}
                  connectingMethod={signerMethod}
                  pendingSwitch={pendingSwitch}
                  extensionNotice={extensionNotice}
                  mobile={mobile}
                  extensionAvailable={extensionAvailable}
                  connectPending={authPending || isWorking}
                  connectDisabled={isWorking || authPending}
                  nostrConnectUri={nostrConnectUri}
                  onConnectExtension={handleConnectExtension}
                  onConnectNostrConnect={handleConnectNostrConnect}
                  onConnectRemote={handleConnectRemote}
                  onCancelConnect={onCancelConnect}
                  onReconnect={onReconnect}
                  onForget={onDisconnect}
                />
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
