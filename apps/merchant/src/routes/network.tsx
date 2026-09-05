import { useCallback, useEffect, useRef, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useAccountNetworkSettings, useAuth } from "@conduit/core"
import { Button, RelaySettingsPanel } from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import { loadProductDraft } from "../lib/productDraft"
import {
  clearProductDraftReturnIntent,
  loadProductDraftReturnIntent,
  requestProductDraftResume,
} from "../lib/productDraftReturn"

export const Route = createFileRoute("/network")({
  beforeLoad: () => {
    requireAuth()
  },
  component: NetworkPage,
})

function NetworkPage() {
  const { pubkey } = useAuth()
  const networkSettings = useAccountNetworkSettings()
  const navigate = useNavigate()
  const autoReturnStartedRef = useRef(false)
  const [hasProductDraftReturn, setHasProductDraftReturn] = useState(false)
  const [productDraftReturnError, setProductDraftReturnError] = useState<
    string | null
  >(null)

  useEffect(() => {
    autoReturnStartedRef.current = false
    setProductDraftReturnError(null)
    if (!pubkey) {
      setHasProductDraftReturn(false)
      return
    }

    const returnIntent = loadProductDraftReturnIntent(pubkey)
    const productDraft = loadProductDraft({ merchantPubkey: pubkey })
    const canReturn = !!returnIntent.intent && !!productDraft.draft
    if (returnIntent.intent && !productDraft.draft) {
      clearProductDraftReturnIntent(pubkey)
    }
    setHasProductDraftReturn(canReturn)
  }, [pubkey])

  const returnToProductDraft = useCallback(() => {
    if (!pubkey || autoReturnStartedRef.current) return
    if (!requestProductDraftResume(pubkey)) {
      setProductDraftReturnError(
        "Automatic return is unavailable. Your local draft has not been published."
      )
      return
    }

    autoReturnStartedRef.current = true
    void navigate({ to: "/products" })
  }, [navigate, pubkey])

  useEffect(() => {
    const setupConfirmed =
      (networkSettings.view.inbox.state === "declared" &&
        networkSettings.view.inbox.coverage === "complete" &&
        !networkSettings.view.inbox.stale) ||
      networkSettings.view.pendingCheckpoints.some(
        (checkpoint) =>
          checkpoint.kind === 10050 && checkpoint.state === "confirmed"
      )
    if (!hasProductDraftReturn || !setupConfirmed) return

    returnToProductDraft()
  }, [
    hasProductDraftReturn,
    networkSettings.view.inbox.coverage,
    networkSettings.view.inbox.stale,
    networkSettings.view.inbox.state,
    networkSettings.view.pendingCheckpoints,
    returnToProductDraft,
  ])

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        {hasProductDraftReturn && (
          <section className="mb-4 rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-glass-inset)]">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                  Your product draft is safe
                </h2>
                <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
                  It is saved only in this browser on this device and is not a
                  public listing. You can return at any time if setup is
                  cancelled or cannot be completed.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full shrink-0 sm:w-auto"
                onClick={returnToProductDraft}
              >
                Return to product draft
              </Button>
            </div>
            {productDraftReturnError && (
              <p role="alert" className="mt-3 text-sm text-error">
                {productDraftReturnError}
              </p>
            )}
          </section>
        )}
        <RelaySettingsPanel controller={networkSettings} />
      </div>
    </div>
  )
}
