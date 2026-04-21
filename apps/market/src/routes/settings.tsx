import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useRelaySettings } from "@conduit/core"
import { RelaySettingsPanel } from "@conduit/ui"

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
})

function SettingsPage() {
  const navigate = useNavigate()
  const { visibleGroups, addRelay, removeRelay, updateRelay, resetToDefaults } =
    useRelaySettings("shopper")

  function handleClose(): void {
    if (window.history.length > 1) {
      window.history.back()
      return
    }

    navigate({ to: "/products" })
  }

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <RelaySettingsPanel
          groups={visibleGroups}
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
