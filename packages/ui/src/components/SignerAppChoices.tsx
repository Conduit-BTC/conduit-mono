import type { ReactNode } from "react"
import { Button } from "./Button"
import { ClaveConnectButton } from "./ClaveConnectButton"
import {
  AMBER_INSTALL_URL,
  CLAVE_APP_STORE_URL,
  PRIMAL_INSTALL_URL,
  androidSignerConnectUrl,
  type AndroidSigner,
} from "./signer-platform"

export type SignerApp = "clave" | AndroidSigner
const appNames = { clave: "Clave", amber: "Amber", primal: "Primal" } as const
const primaryClassName = "h-12 w-full rounded-xl text-base font-semibold"

export function SignerAppChoices({
  platform,
  nostrConnectUri,
  selectedApp,
  onSelectApp,
  onChooseAnother,
  startButton,
}: {
  platform: "ios" | "android"
  nostrConnectUri?: string | null
  selectedApp: SignerApp | null
  onSelectApp: (app: SignerApp) => void
  onChooseAnother: () => void
  startButton: ReactNode
}) {
  function appButton(app: SignerApp) {
    const label =
      selectedApp === app
        ? `Open ${appNames[app]} again`
        : app === "clave"
          ? "Connect with Clave"
          : `Use ${appNames[app]}`
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
          href={androidSignerConnectUrl(app, nostrConnectUri)}
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
          : "Choose the app you use for your Nostr account."}
      </p>
      {selectedApp ? (
        <>
          {appButton(selectedApp)}
          {platform === "android" && (
            <Button
              type="button"
              variant="ghost"
              className="h-11 w-full"
              onClick={onChooseAnother}
            >
              Choose another app
            </Button>
          )}
        </>
      ) : platform === "ios" ? (
        appButton("clave")
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {appButton("amber")}
          {appButton("primal")}
        </div>
      )}
      <p className="text-center text-sm leading-6 text-[var(--text-secondary)]">
        {platform === "ios" ? (
          <a
            className="inline-flex min-h-11 items-center rounded-sm text-primary-400 underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
            href={CLAVE_APP_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Get Clave on the App Store
          </a>
        ) : (
          <span className="flex flex-wrap justify-center gap-x-4">
            <a
              className="inline-flex min-h-11 items-center rounded-sm text-primary-400 underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
              href={AMBER_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Get Amber on F-Droid
            </a>
            <a
              className="inline-flex min-h-11 items-center rounded-sm text-primary-400 underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
              href={PRIMAL_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Get Primal on Google Play
            </a>
          </span>
        )}
      </p>
      {!nostrConnectUri && startButton}
    </div>
  )
}
