import { useCallback, useState } from "react"
import {
  createFileRoute,
  type ShouldBlockFn,
  useBlocker,
} from "@tanstack/react-router"
import { useAccountNetworkSettings } from "@conduit/core"
import { RelaySettingsPanel, UnpublishedRelayChangesDialog } from "@conduit/ui"
import { requireAuth } from "../lib/auth"

export const Route = createFileRoute("/network")({
  beforeLoad: () => {
    requireAuth()
  },
  component: SettingsPage,
})

function SettingsPage() {
  const networkSettings = useAccountNetworkSettings({ telemetryApp: "market" })
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

  return (
    <>
      <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
        <div className="mx-auto max-w-[50rem]">
          <RelaySettingsPanel
            controller={networkSettings}
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
