import { useEffect, useRef, useState } from "react"
import { Button } from "./Button"
import { ClaveConnectButton } from "./ClaveConnectButton"
import {
  AMBER_INSTALL_URL,
  CLAVE_APP_STORE_URL,
  androidSignerConnectUrl,
} from "./signer-platform"

export type SignerApp = "clave" | "amber"
const primaryClassName = "h-12 w-full rounded-xl text-base font-semibold"

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
          : app === "clave"
            ? "Connect with Clave"
            : "Use Amber"
    if (!nostrConnectUri) {
      return (
        <Button
          type="button"
          disabled={connectDisabled}
          onClick={() => {
            setManualStart(true)
            void Promise.resolve(onStart()).catch(() => undefined)
          }}
          className={primaryClassName}
        >
          {connectPending ? `Preparing ${appName}…` : label}
        </Button>
      )
    }
    if (app === "clave") {
      return (
        <ClaveConnectButton
          nostrConnectUri={nostrConnectUri}
          label={label}
          onClick={() => onSelectApp(app)}
          className={primaryClassName}
        />
      )
    }
    return (
      <Button asChild className={primaryClassName}>
        <a
          href={androidSignerConnectUrl(nostrConnectUri)}
          target="_self"
          onClick={() => onSelectApp(app)}
        >
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
      <p className="text-center text-sm leading-6 text-[var(--text-secondary)]">
        <a
          className="inline-flex min-h-11 items-center rounded-sm text-primary-400 underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
          href={platform === "ios" ? CLAVE_APP_STORE_URL : AMBER_INSTALL_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {platform === "ios"
            ? "Get Clave on the App Store"
            : "Get Amber on F-Droid"}
        </a>
      </p>
    </div>
  )
}
