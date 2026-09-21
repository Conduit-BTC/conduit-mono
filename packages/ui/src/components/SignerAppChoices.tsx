import type { ReactNode } from "react"
import { Button } from "./Button"
import { AMBER_INSTALL_URL, androidSignerConnectUrl } from "./signer-platform"

export type SignerApp = "amber"
const primaryClassName = "h-12 w-full rounded-xl text-base font-semibold"

export function SignerAppChoices({
  nostrConnectUri,
  selectedApp,
  onSelectApp,
  startButton,
}: {
  nostrConnectUri?: string | null
  selectedApp: SignerApp | null
  onSelectApp: (app: SignerApp) => void
  startButton: ReactNode
}) {
  function appButton() {
    const label = selectedApp === "amber" ? "Open Amber again" : "Use Amber"
    if (!nostrConnectUri) {
      return (
        <Button disabled className={primaryClassName}>
          {label}
        </Button>
      )
    }
    return (
      <Button asChild className={primaryClassName}>
        <a
          href={androidSignerConnectUrl("amber", nostrConnectUri)}
          target="_self"
          onClick={() => onSelectApp("amber")}
        >
          {label}
        </a>
      </Button>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-center text-sm leading-6 text-[var(--text-secondary)]">
        Sign in with Amber. Your account keys stay in the app.
      </p>
      {appButton()}
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
      {!nostrConnectUri && startButton}
    </div>
  )
}
