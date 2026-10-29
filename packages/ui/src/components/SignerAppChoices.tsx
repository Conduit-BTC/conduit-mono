import { Smartphone } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "./Button"
import { ClaveConnectButton } from "./ClaveConnectButton"
import { AMBER_INSTALL_URL, androidSignerConnectUrl } from "./signer-platform"

export type SignerApp = "clave" | "amber"
const primaryClassName =
  "min-h-12 w-full justify-start gap-3 rounded-[var(--radius-md)] px-4 text-sm font-medium"

export function SignerAppChoices({
  platform,
  nostrConnectUri,
  selectedApp,
  onSelectApp,
  connectPending,
  connectDisabled,
  onStart,
}: {
  platform: "ios" | "android"
  nostrConnectUri?: string | null
  selectedApp: SignerApp | null
  onSelectApp: (app: SignerApp) => void
  connectPending: boolean
  connectDisabled: boolean
  onStart: () => Promise<void> | void
}) {
  const app = platform === "ios" ? "clave" : "amber"
  const appName = app === "clave" ? "Clave" : "Amber"
  const [manualStart, setManualStart] = useState(false)
  const handoffContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (manualStart && nostrConnectUri && !selectedApp) {
      handoffContainerRef.current
        ?.querySelector<HTMLAnchorElement>("a[href]")
        ?.focus()
    }
  }, [manualStart, nostrConnectUri, selectedApp])

  function appButton() {
    const label =
      selectedApp === app
        ? `Open ${appName} again`
        : manualStart && nostrConnectUri
          ? `Open ${appName}`
          : `Sign in with ${appName}`
    if (!nostrConnectUri) {
      return (
        <Button
          type="button"
          variant="outline"
          disabled={connectDisabled}
          onClick={() => {
            setManualStart(true)
            void Promise.resolve(onStart()).catch(() => undefined)
          }}
          className={primaryClassName}
        >
          <Smartphone className="size-5" aria-hidden="true" />
          {connectPending ? `Preparing ${appName}…` : label}
        </Button>
      )
    }
    if (app === "clave") {
      return (
        <ClaveConnectButton
          nostrConnectUri={nostrConnectUri}
          label={label}
          secondary
          onClick={() => onSelectApp(app)}
          className={primaryClassName}
        />
      )
    }
    return (
      <Button asChild variant="outline" className={primaryClassName}>
        <a
          href={androidSignerConnectUrl(nostrConnectUri)}
          target="_self"
          onClick={() => onSelectApp(app)}
        >
          <Smartphone className="size-5" aria-hidden="true" />
          {label}
        </a>
      </Button>
    )
  }

  return (
    <div className="space-y-3">
      <div ref={handoffContainerRef}>{appButton()}</div>
      <p role="status" className="sr-only">
        {nostrConnectUri && !selectedApp
          ? `Ready. Open ${appName} to approve sign-in.`
          : ""}
      </p>
      {platform === "android" && (manualStart || selectedApp) && (
        <p className="text-center text-sm leading-6 text-[var(--text-secondary)]">
          <a
            className="inline-flex min-h-11 items-center rounded-sm text-primary-400 underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
            href={AMBER_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Get Amber on F-Droid
          </a>
        </p>
      )}
    </div>
  )
}
