import type { ReactNode } from "react"
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
  startButton,
}: {
  platform: "ios" | "android"
  nostrConnectUri?: string | null
  selectedApp: SignerApp | null
  onSelectApp: (app: SignerApp) => void
  startButton: ReactNode
}) {
  const app = platform === "ios" ? "clave" : "amber"

  function appButton() {
    const label =
      selectedApp === app
        ? `Open ${app === "clave" ? "Clave" : "Amber"} again`
        : app === "clave"
          ? "Connect with Clave"
          : "Use Amber"
    if (!nostrConnectUri) {
      return (
        <Button disabled className={primaryClassName}>
          {label}
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
          href={androidSignerConnectUrl("amber", nostrConnectUri)}
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
      <p className="text-center text-sm leading-6 text-[var(--text-secondary)]">
        {platform === "ios"
          ? "Sign in with Clave. Your account keys stay in the app."
          : "Sign in with Amber. Your account keys stay in the app."}
      </p>
      {appButton()}
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
      {!nostrConnectUri && startButton}
    </div>
  )
}
