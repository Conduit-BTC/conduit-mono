import { createFileRoute } from "@tanstack/react-router"
import { useAuth, useConduitSession, useRelaySettings } from "@conduit/core"
import { RelaySettingsPanel } from "@conduit/ui"

export const Route = createFileRoute("/network")({
  component: SettingsPage,
})

function SettingsPage() {
  const { pubkey } = useAuth()
  const session = useConduitSession()
  const relaySettings = useRelaySettings(session.relayScope, {
    pubkey,
    bootstrapRelayList: false,
  })

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
