import { ExternalLink, X } from "lucide-react"
import { Button } from "./Button"

export interface SignerAuthUrlNoticeProps {
  authUrl: string
  onDismiss: () => void
}

export function SignerAuthUrlNotice({
  authUrl,
  onDismiss,
}: SignerAuthUrlNoticeProps) {
  return (
    <aside
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-[70] mx-auto max-w-lg rounded-[1.25rem] border border-warning/35 bg-[var(--surface-dialog)] p-4 text-[var(--text-primary)] shadow-[var(--shadow-dialog)] sm:bottom-6"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Signer approval required</div>
          <p className="mt-1 text-sm leading-5 text-[var(--text-secondary)]">
            Approve the pending request in your remote signer, then return to
            Conduit.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          aria-label="Dismiss signer approval notice"
          title="Dismiss"
          className="-mr-2 -mt-2 h-8 w-8 shrink-0"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <Button asChild variant="outline" size="sm" className="mt-3 w-full">
        <a href={authUrl} target="_blank" rel="noopener noreferrer">
          Open signer approval
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
      </Button>
    </aside>
  )
}
