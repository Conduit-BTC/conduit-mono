import { AlertTriangle, KeyRound } from "lucide-react"
import { Button } from "@conduit/ui"

interface ProductSignerRecoveryNoticeProps {
  draftStorageAvailable: boolean
  reconnecting: boolean
  restoreFailed: boolean
  changingSigner: boolean
  changeSignerError: string | null
  onReconnect: () => Promise<void>
  onUseDifferentSigner: () => Promise<void>
}

export function ProductSignerRecoveryNotice({
  draftStorageAvailable,
  reconnecting,
  restoreFailed,
  changingSigner,
  changeSignerError,
  onReconnect,
  onUseDifferentSigner,
}: ProductSignerRecoveryNoticeProps) {
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
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            {draftStorageAvailable
              ? "Your signing connection stopped responding. Reconnect your signer to continue. Your draft is saved on this device."
              : "Your signing connection stopped responding. Reconnect your signer to continue. Keep this page open because this draft could not be saved on this device."}
          </p>
          {restoreFailed && (
            <p className="mt-2 text-sm leading-6 text-error">
              {draftStorageAvailable
                ? "That saved connection could not be restored. Try again, or use a different signer. Your draft will close and remain saved for this account."
                : "That saved connection could not be restored. Reconnect this account to continue. This draft is not saved on this device, so another signer cannot be opened safely."}
            </p>
          )}
          {changeSignerError && (
            <p className="mt-2 text-sm leading-6 text-error">
              {changeSignerError}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void onReconnect().catch(() => undefined)}
              disabled={busy}
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              {reconnecting ? "Reconnecting..." : "Reconnect signer"}
            </Button>
            {restoreFailed && draftStorageAvailable && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  void onUseDifferentSigner().catch(() => undefined)
                }
                disabled={busy}
              >
                {changingSigner
                  ? "Opening signer options..."
                  : "Use a different signer"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
