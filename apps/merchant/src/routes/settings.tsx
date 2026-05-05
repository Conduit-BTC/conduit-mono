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
    pubkey ? `merchant:${pubkey}` : "merchant",
    { pubkey }
  )

  return (
    <div className="mx-auto max-w-5xl">
      <RelaySettingsPanel
        settings={relaySettings.settings}
        scanningUrls={relaySettings.scanningUrls}
        error={relaySettings.error}
        isLoadingPublishedRelayList={relaySettings.isLoadingPublishedRelayList}
        publishedRelayListUpdatedAt={relaySettings.publishedRelayListUpdatedAt}
        publishingRelayList={relaySettings.publishingRelayList}
        publishError={relaySettings.publishError}
        onAddRelay={relaySettings.addRelay}
        onRefreshRelay={relaySettings.refreshRelay}
        onRemoveRelay={relaySettings.removeRelay}
        onToggleRead={relaySettings.toggleRelayRead}
        onToggleWrite={relaySettings.toggleRelayWrite}
        onReset={relaySettings.resetRelaySettings}
        onPublishRelayList={pubkey ? relaySettings.publishRelayList : undefined}
      />
    </div>
  )
}
