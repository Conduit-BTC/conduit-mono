import type { ReactNode } from "react"
import { AlertTriangle, KeyRound } from "lucide-react"
import { Button } from "./Button"

export interface SignerRecoveryNoticeProps {
  description: ReactNode
  reconnecting: boolean
  restoreFailed?: boolean
  restoreFailureDescription?: ReactNode
  changingSigner?: boolean
  changeSignerError?: string | null
  onReconnect: () => Promise<void> | void
  onUseDifferentSigner?: () => Promise<void> | void
}

/**
 * Presents signer recovery without owning or replaying the interrupted work.
 * The calling workflow remains responsible for a fresh, explicit retry.
 */
export function SignerRecoveryNotice({
  description,
  reconnecting,
  restoreFailed = false,
  restoreFailureDescription,
  changingSigner = false,
  changeSignerError = null,
  onReconnect,
  onUseDifferentSigner,
}: SignerRecoveryNoticeProps) {
  const busy = reconnecting || changingSigner
  return (
    <div
      role={busy ? "status" : "alert"}
      aria-live={busy ? "polite" : "assertive"}
      aria-busy={busy}
      className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-[var(--text-primary)]"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-warning"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {reconnecting
              ? "Reconnecting signer"
              : changingSigner
                ? "Opening signer options"
                : "Signer reconnect needed"}
          </p>
          <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            {description}
          </div>
          {restoreFailed && restoreFailureDescription ? (
            <div className="mt-2 text-sm leading-6 text-error">
              {restoreFailureDescription}
            </div>
          ) : null}
          {changeSignerError ? (
            <p className="mt-2 text-sm leading-6 text-error">
              {changeSignerError}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                void Promise.resolve(onReconnect()).catch(() => undefined)
              }
              disabled={busy}
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              {reconnecting ? "Reconnecting..." : "Reconnect signer"}
            </Button>
            {restoreFailed && onUseDifferentSigner ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  void Promise.resolve(onUseDifferentSigner()).catch(
                    () => undefined
                  )
                }
                disabled={busy}
              >
                {changingSigner
                  ? "Opening signer options..."
                  : "Use a different signer"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
