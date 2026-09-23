import { useCallback, useState } from "react"
import {
  createFileRoute,
  type ShouldBlockFn,
  useBlocker,
} from "@tanstack/react-router"
import { useAccountNetworkSettings, useAuth } from "@conduit/core"
import {
  RelaySettingsPanel,
  SignerRecoveryNotice,
  UnpublishedRelayChangesDialog,
} from "@conduit/ui"
import { requireAuth } from "../lib/auth"

export const Route = createFileRoute("/network")({
  beforeLoad: () => {
    requireAuth()
  },
  component: SettingsPage,
})

function SettingsPage() {
  const {
    accountPubkey,
    authGeneration,
    connect,
    remoteSignerRecovery,
    signerReadiness,
    status,
  } = useAuth()
  const networkSettings = useAccountNetworkSettings({ telemetryApp: "market" })
  const [reconnecting, setReconnecting] = useState(false)
  const [hasUnpublishedRelayChanges, setHasUnpublishedRelayChanges] =
    useState(false)
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

  return (
    <>
      <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
        <div className="mx-auto max-w-[50rem]">
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
