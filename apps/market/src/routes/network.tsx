import { createFileRoute } from "@tanstack/react-router"
import {
  getInboxRelayCandidates,
  useAuth,
  useConduitSession,
  useInboxDeclaration,
  useMediaServerPreferences,
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
  const { pubkey, signer, method, authGeneration } = useAuth()
  const session = useConduitSession()
  const relaySettings = useRelaySettings(session.relayScope, {
    pubkey,
    bootstrapRelayList: false,
  })
  const inboxDeclaration = useInboxDeclaration(pubkey, {
    enabled: session.relaySettingsReady,
    relayScope: session.relayScope,
  })
  const mediaServerPreferences = useMediaServerPreferences(pubkey, {
    enabled: session.relaySettingsReady,
    signer,
    authMethod: method,
    authGeneration,
    relayScope: session.relayScope,
  })

  return (
    <div className="mx-auto max-w-[54rem] py-2 sm:py-6">
      <div className="mx-auto max-w-[50rem]">
        <RelaySettingsPanel
          settings={relaySettings.settings}
          authEvidenceByUrl={relaySettings.authEvidenceByUrl}
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
          onReset={relaySettings.resetRelaySettings}
          onPublishRelayList={
            pubkey ? relaySettings.publishRelayList : undefined
          }
          privateInbox={
            pubkey
              ? {
                  status: inboxDeclaration.status,
                  stale: inboxDeclaration.stale,
                  distributionRepairable:
                    inboxDeclaration.distributionRepairable,
                  candidateRelays: getInboxRelayCandidates(
                    relaySettings.settings.entries,
                    inboxDeclaration.declaredRelayUrls,
                    inboxDeclaration.retainedRelayUrls
                  ),
                  lookupError: inboxDeclaration.error,
                  publishing: inboxDeclaration.publishing,
                  publishError: inboxDeclaration.publishError,
                  publishSuccess: inboxDeclaration.publishSuccess,
                  publishConfirmationPending:
                    inboxDeclaration.publishConfirmationPending,
                  onPublish: inboxDeclaration.publishDeclaration,
                  onRetryLookup: inboxDeclaration.refetch,
                }
              : undefined
          }
          mediaServers={
            pubkey
              ? {
                  view: mediaServerPreferences.view,
                  onAddServer: mediaServerPreferences.addServer,
                  onRemoveServer: mediaServerPreferences.removeServer,
                  onMoveServer: mediaServerPreferences.moveServer,
                  onPublish: mediaServerPreferences.publish,
                  onRetryPublish: mediaServerPreferences.retryPublish,
                  onRetryLookup: mediaServerPreferences.refetch,
                }
              : undefined
          }
        />
      </div>
    </div>
  )
}
