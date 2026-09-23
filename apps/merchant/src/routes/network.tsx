import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  createFileRoute,
  type ShouldBlockFn,
  useBlocker,
  useNavigate,
} from "@tanstack/react-router"
import { useAccountNetworkSettings, useAuth } from "@conduit/core"
import {
  Button,
  RelaySettingsPanel,
  SignerRecoveryNotice,
  UnpublishedRelayChangesDialog,
} from "@conduit/ui"
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
  const {
    accountPubkey,
    authGeneration,
    connect,
    remoteSignerRecovery,
    signerReadiness,
    status,
  } = useAuth()
  const networkSettings = useAccountNetworkSettings({
    telemetryApp: "merchant",
  })
  const navigate = useNavigate()
  const autoReturnStartedRef = useRef(false)
  const [hasProductDraftReturn, setHasProductDraftReturn] = useState(false)
  const [productDraftReturnError, setProductDraftReturnError] = useState<
    string | null
  >(null)
  const [hasUnpublishedRelayChanges, setHasUnpublishedRelayChanges] =
    useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const shouldBlockNavigation = useCallback<ShouldBlockFn>(
    ({ current, next }) =>
      hasUnpublishedRelayChanges && current.routeId !== next.routeId,
    [hasUnpublishedRelayChanges]
  )
  const blocker = useBlocker({
    shouldBlockFn: shouldBlockNavigation,
    enableBeforeUnload: hasUnpublishedRelayChanges,
    disabled: !hasUnpublishedRelayChanges,
    withResolver: true,
  })
  const networkOperationInProgress = !["idle", "complete", "error"].includes(
    networkSettings.operation.phase
  )

  const leaveAndDiscard = useCallback(() => {
    if (blocker.status !== "blocked") return
    blocker.proceed()
  }, [blocker])

  const reconnectSigner = useCallback(async () => {
    setReconnecting(true)
    try {
      await connect({ mode: "restore" })
    } finally {
      setReconnecting(false)
    }
  }, [connect])

  useLayoutEffect(() => {
    autoReturnStartedRef.current = false
    setProductDraftReturnError(null)
    if (!accountPubkey) {
      setHasProductDraftReturn(false)
      return
    }

    const returnIntent = loadProductDraftReturnIntent(accountPubkey)
    const productDraft = loadProductDraft({ merchantPubkey: accountPubkey })
    const canReturn = !!returnIntent.intent && !!productDraft.draft
    if (returnIntent.intent && !productDraft.draft) {
      clearProductDraftReturnIntent(accountPubkey)
    }
    setHasProductDraftReturn(canReturn)
  }, [accountPubkey])

  const returnToProductDraft = useCallback(() => {
    if (!accountPubkey || autoReturnStartedRef.current) return
    if (!requestProductDraftResume(accountPubkey)) {
      setProductDraftReturnError(
        "Automatic return is unavailable. Your local draft has not been published."
      )
      return
    }

    autoReturnStartedRef.current = true
    void navigate({ to: "/products" })
  }, [accountPubkey, navigate])

  useEffect(() => {
    const setupConfirmed =
      networkSettings.view.inbox.state === "declared" &&
      networkSettings.view.inbox.coverage === "complete" &&
      !networkSettings.view.inbox.stale
    if (
      !hasProductDraftReturn ||
      !setupConfirmed ||
      hasUnpublishedRelayChanges ||
      networkOperationInProgress
    ) {
      return
    }

    returnToProductDraft()
  }, [
    hasProductDraftReturn,
    hasUnpublishedRelayChanges,
    networkOperationInProgress,
    networkSettings.view.inbox.coverage,
    networkSettings.view.inbox.stale,
    networkSettings.view.inbox.state,
    returnToProductDraft,
  ])

  return (
    <>
      <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
        <div className="mx-auto max-w-[50rem]">
          {hasProductDraftReturn && (
            <section className="mb-4 rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-glass-inset)]">
              <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                  <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
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
                  className="min-h-11 w-full shrink-0 sm:w-auto"
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
          {remoteSignerRecovery ? (
            <div className="mb-4">
              <SignerRecoveryNotice
                description="Your relay edits are still here. Reconnect, review the current Network evidence, then publish when you are ready."
                reconnecting={reconnecting || status === "restoring"}
                restoreFailed={!!remoteSignerRecovery.restoreError}
                restoreFailureDescription="That saved signer connection could not be restored. Your relay edits remain unpublished on this page."
                onReconnect={reconnectSigner}
              />
            </div>
          ) : null}
          <RelaySettingsPanel
            controller={networkSettings}
            accountPubkey={accountPubkey}
            signerReady={signerReadiness === "ready"}
            signerReviewKey={`${accountPubkey ?? "none"}:${authGeneration}:${signerReadiness}`}
            onUnpublishedRelayChangesChange={setHasUnpublishedRelayChanges}
          />
        </div>
      </div>
      <UnpublishedRelayChangesDialog
        open={blocker.status === "blocked"}
        operationInProgress={networkOperationInProgress}
        onKeepEditing={() => {
          if (blocker.status === "blocked") blocker.reset()
        }}
        onLeave={leaveAndDiscard}
      />
    </>
  )
}
