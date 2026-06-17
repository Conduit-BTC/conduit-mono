import { createFileRoute } from "@tanstack/react-router"
import {
  useAuth,
  useConduitSession,
  useDmInboxSettings,
  useRelaySettings,
} from "@conduit/core"
import { RelaySettingsPanel } from "@conduit/ui"
import { requireAuth } from "../lib/auth"

export const Route = createFileRoute("/network")({
  beforeLoad: () => {
    requireAuth()
  },
  component: SettingsPage,
})

function SettingsPage() {
  const { pubkey } = useAuth()
  const session = useConduitSession()
  const relaySettings = useRelaySettings(session.relayScope, {
    pubkey,
    bootstrapRelayList: false,
  })
  const dmInboxSettings = useDmInboxSettings({ pubkey })

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <RelaySettingsPanel
          settings={relaySettings.settings}
          scanningUrls={relaySettings.scanningUrls}
          error={relaySettings.error}
          isLoadingPublishedRelayList={
            relaySettings.isLoadingPublishedRelayList
          }
          publishedRelayListUpdatedAt={
            relaySettings.publishedRelayListUpdatedAt
          }
          publishingRelayList={relaySettings.publishingRelayList}
          publishError={relaySettings.publishError}
          dmInboxRelayUrls={dmInboxSettings.relayUrls}
          dmInboxDefaultRelayUrls={dmInboxSettings.defaultRelayUrls}
          dmInboxPublishedAt={dmInboxSettings.publishedAt}
          dmInboxLoading={dmInboxSettings.isLoading}
          publishingDmInbox={dmInboxSettings.isPublishing}
          dmInboxPublishError={dmInboxSettings.publishError}
          onAddRelay={relaySettings.addRelay}
          onRefreshRelay={relaySettings.refreshRelay}
          onRemoveRelay={relaySettings.removeRelay}
          onToggleRead={relaySettings.toggleRelayRead}
          onToggleWrite={relaySettings.toggleRelayWrite}
          onReset={relaySettings.resetRelaySettings}
          onPublishRelayList={
            pubkey ? relaySettings.publishRelayList : undefined
          }
          onPublishDefaultDmInbox={
            pubkey ? dmInboxSettings.publishDefaultInbox : undefined
          }
        />
      </div>
    </div>
  )
}
