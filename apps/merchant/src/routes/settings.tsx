import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useRelaySettings, useRelayStatusMap } from "@conduit/core"
import { RelaySettingsPanel } from "@conduit/ui"

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
})

function SettingsPage() {
  const navigate = useNavigate()
  const { visibleGroups, addRelay, removeRelay, updateRelay, resetToDefaults } =
    useRelaySettings("merchant")
  const statusMap = useRelayStatusMap()

  function handleClose(): void {
    if (window.history.length > 1) {
      window.history.back()
      return
    }

    navigate({ to: "/" })
  }

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <RelaySettingsPanel
          groups={visibleGroups}
          statusMap={statusMap}
          onAddRelay={addRelay}
          onRemoveRelay={removeRelay}
          onUpdateRelay={updateRelay}
          onReset={resetToDefaults}
          onClose={handleClose}
        />
      </div>
    </div>
  )
}
