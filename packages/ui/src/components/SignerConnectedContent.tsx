import { ExternalLink } from "lucide-react"
import { Badge } from "./Badge"
import { Button } from "./Button"
import { DialogFooter } from "./Dialog"

export function SignerConnectedContent({
  pubkeyLabel,
  pubkeyDetailLabel,
  signerMethod,
  connectedUseDescription,
  authUrl,
  error,
  isWorking,
  onDisconnect,
  onSwitchSigner,
}: {
  pubkeyLabel?: string | null
  pubkeyDetailLabel?: string | null
  signerMethod?: "nip07" | "nip46" | null
  connectedUseDescription: string
  authUrl?: string | null
  error?: string | null
  isWorking: boolean
  onDisconnect: () => Promise<void>
  onSwitchSigner: () => Promise<void>
}) {
  return (
    <>
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
          onClick={() => void onDisconnect()}
          disabled={isWorking}
        >
          {signerMethod === "nip46" ? "Disconnect remote signer" : "Disconnect"}
        </Button>
        <Button
          type="button"
          onClick={() => void onSwitchSigner()}
          disabled={isWorking}
        >
          Switch account
        </Button>
      </DialogFooter>
    </>
  )
}
