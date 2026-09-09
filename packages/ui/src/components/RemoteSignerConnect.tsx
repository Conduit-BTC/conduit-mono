import { Check, Copy } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { Button } from "./Button"
import { SignerAppChoices, type SignerApp } from "./SignerAppChoices"
import type { SignerPlatform } from "./signer-platform"
import { ManualSignerConnection } from "./ManualSignerConnection"

const primaryClassName = "h-12 w-full rounded-xl text-base font-semibold"
const appNames = { clave: "Clave", amber: "Amber", primal: "Primal" } as const

export function RemoteSignerConnect({
  platform,
  connectPending,
  connectDisabled,
  nostrConnectUri,
  onConnectNostrConnect,
  onConnectBunker,
  onCancelConnect,
  error,
  errorId,
}: {
  platform: SignerPlatform
  error?: string | null
  errorId: string
  connectPending: boolean
  connectDisabled: boolean
  nostrConnectUri?: string | null
  onConnectNostrConnect: () => Promise<void> | void
  onConnectBunker: (bunkerUri: string) => Promise<void> | void
  onCancelConnect: () => void
}) {
  const otherWaysId = useId()
  const hasAppChoices = platform === "ios" || platform === "android"
  const [showOtherWays, setShowOtherWays] = useState(!hasAppChoices)
  const [activeTab, setActiveTab] = useState("qr")
  const [selectedApp, setSelectedApp] = useState<SignerApp | null>(null)
  const [bunkerUri, setBunkerUri] = useState("")
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const connectionUrlRef = useRef<HTMLTextAreaElement>(null)
  const copyResetTimer = useRef<number | null>(null)
  const copyAttempt = useRef(0)

  useEffect(() => {
    copyAttempt.current += 1
    setCopied(false)
    setCopyError(false)
    if (!nostrConnectUri) setSelectedApp(null)
    return () => {
      copyAttempt.current += 1
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    }
  }, [nostrConnectUri])

  function cancel(): void {
    onCancelConnect()
    setSelectedApp(null)
  }

  function changeTab(tab: string): void {
    if (tab !== activeTab && (tab === "bunker" || activeTab === "bunker")) {
      cancel()
    }
    setActiveTab(tab)
  }

  async function submitBunker(): Promise<void> {
    if (!bunkerUri.trim() || connectDisabled) return
    try {
      await onConnectBunker(bunkerUri.trim())
      // Only authenticated state can confirm success; cancellation also resolves.
      // Keep the draft until the sign-in surface unmounts on actual success.
    } catch {
      // Auth state owns the actionable inline error.
    }
  }

  async function copyConnectionUrl(): Promise<void> {
    if (!nostrConnectUri) return
    const attempt = ++copyAttempt.current
    let success = false
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(nostrConnectUri)
        success = true
      }
    } catch {
      // Selection-based copying supports older mobile browsers.
    }
    if (attempt !== copyAttempt.current) return
    if (!success && connectionUrlRef.current) {
      connectionUrlRef.current.focus()
      connectionUrlRef.current.select()
      connectionUrlRef.current.setSelectionRange(0, nostrConnectUri.length)
      try {
        success = document.execCommand("copy")
      } catch {
        success = false
      }
    }
    setCopied(success)
    setCopyError(!success)
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    copyResetTimer.current = window.setTimeout(() => setCopied(false), 1_500)
  }

  const startButton = (
    <Button
      type="button"
      onClick={() =>
        void Promise.resolve(onConnectNostrConnect()).catch(() => undefined)
      }
      disabled={connectDisabled}
      className={primaryClassName}
    >
      {connectPending ? "Preparing connection…" : "Start new connection"}
    </Button>
  )
  const copyButton = (
    <Button
      type="button"
      variant="outline"
      className="h-11 w-full"
      onClick={() => void copyConnectionUrl()}
      aria-label={copied ? "Connection link copied" : "Copy connection link"}
    >
      {copied ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy connection link"}
    </Button>
  )

  return (
    <div className="space-y-3">
      {hasAppChoices && (
        <SignerAppChoices
          platform={platform}
          nostrConnectUri={nostrConnectUri}
          selectedApp={selectedApp}
          onSelectApp={setSelectedApp}
          onChooseAnother={cancel}
          startButton={startButton}
        />
      )}

      {connectPending && (
        <div
          role="status"
          className="rounded-xl border border-primary-500/25 bg-primary-500/10 p-3 text-sm leading-6 text-[var(--text-secondary)]"
        >
          {selectedApp
            ? `Approve in ${appNames[selectedApp]}, then return to Conduit.`
            : nostrConnectUri
              ? hasAppChoices
                ? "Ready. Open your app to approve sign-in."
                : "Scan or copy the connection link, then approve in your app."
              : activeTab === "bunker"
                ? "Approve the connection in your app, then return here."
                : "Preparing your connection…"}
        </div>
      )}

      {selectedApp && nostrConnectUri && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm leading-6 text-[var(--text-secondary)]">
          <p>
            If nothing happened, open {appNames[selectedApp]} again or copy the
            connection link into the app. If you just installed it, finish setup
            there, then return here.
          </p>
          {selectedApp === "primal" && (
            <p>
              Use an account held in Primal. Watch-only accounts and accounts
              using an external signer cannot approve here. For those accounts,
              use the app that holds your keys.
            </p>
          )}
          {copyButton}
        </div>
      )}

      {hasAppChoices && (
        <Button
          type="button"
          variant="ghost"
          className="h-11 w-full"
          aria-expanded={showOtherWays}
          aria-controls={otherWaysId}
          onClick={() => {
            if (showOtherWays && activeTab === "bunker") {
              cancel()
              setActiveTab("qr")
            }
            setShowOtherWays(!showOtherWays)
          }}
        >
          {showOtherWays ? "Hide other ways" : "Other ways to connect"}
        </Button>
      )}

      {showOtherWays && (
        <ManualSignerConnection
          id={otherWaysId}
          activeTab={activeTab}
          onTabChange={changeTab}
          nostrConnectUri={nostrConnectUri}
          connectionUrlRef={connectionUrlRef}
          startButton={startButton}
          copyButton={copyButton}
          bunkerUri={bunkerUri}
          onBunkerChange={setBunkerUri}
          onSubmitBunker={submitBunker}
          connectDisabled={connectDisabled}
          connectPending={connectPending}
          error={error}
          errorId={errorId}
        />
      )}
      {copyError && (
        <p role="alert" className="text-sm leading-6 text-error">
          Copy was blocked. Open Other ways to connect → Copy link to select and
          copy it manually.
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {copied ? "Connection link copied to clipboard." : ""}
      </p>
      {connectPending && (
        <Button
          type="button"
          variant="ghost"
          className="h-11 w-full"
          onClick={cancel}
        >
          Cancel pairing
        </Button>
      )}
    </div>
  )
}
