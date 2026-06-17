import { createFileRoute } from "@tanstack/react-router"
import {
  getRelayBucketConfigs,
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
  component: NetworkPage,
})

function NetworkPage() {
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
          relayBuckets={getRelayBucketConfigs()}
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
          onReorderCommerceRelay={relaySettings.reorderRelay}
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
