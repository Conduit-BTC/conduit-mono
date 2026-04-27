import { createFileRoute } from "@tanstack/react-router"
import { useAuth, useRelaySettings } from "@conduit/core"
import { RelaySettingsPanel } from "@conduit/ui"
import { requireAuth } from "../lib/auth"

export const Route = createFileRoute("/settings")({
  beforeLoad: () => {
    requireAuth()
  },
  component: SettingsPage,
})

function SettingsPage() {
  const { pubkey } = useAuth()
  const relaySettings = useRelaySettings(
    pubkey ? `merchant:${pubkey}` : "merchant"
  )

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <RelaySettingsPanel
          settings={relaySettings.settings}
          scanningUrls={relaySettings.scanningUrls}
          error={relaySettings.error}
          onAddRelay={relaySettings.addRelay}
          onRefreshRelay={relaySettings.refreshRelay}
          onRemoveRelay={relaySettings.removeRelay}
          onToggleRead={relaySettings.toggleRelayRead}
          onToggleWrite={relaySettings.toggleRelayWrite}
          onReorderCommerceRelay={relaySettings.reorderRelay}
          onReset={relaySettings.resetRelaySettings}
        />
      </div>
    </div>
  )
}
