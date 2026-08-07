import { createFileRoute } from "@tanstack/react-router"
import {
  getInboxCandidateRelayUrls,
  useAuth,
  useConduitSession,
  useInboxDeclaration,
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
  const inboxDeclaration = useInboxDeclaration(pubkey)

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
          privateInbox={
            pubkey
              ? {
                  status: inboxDeclaration.status,
                  stale: inboxDeclaration.stale,
                  declaredRelayUrls: inboxDeclaration.declaredRelayUrls,
                  candidateRelayUrls: getInboxCandidateRelayUrls(
                    relaySettings.settings.entries
                  ),
                  lookupError: inboxDeclaration.error,
                  publishing: inboxDeclaration.publishing,
                  publishError: inboxDeclaration.publishError,
                  publishSuccess: inboxDeclaration.publishSuccess,
                  onPublish: inboxDeclaration.publishDeclaration,
                  onRetryLookup: inboxDeclaration.refetch,
                }
              : undefined
          }
        />
      </div>
    </div>
  )
}
