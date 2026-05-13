import { createFileRoute } from "@tanstack/react-router"
import {
  conduitBuildInfo,
  getCommitUrl,
  getConduitNip89AppDefinition,
  getConduitNip89HandlerAddress,
} from "@conduit/core"
import { AppProvenancePanel } from "@conduit/ui"

export const Route = createFileRoute("/about")({
  component: AboutPage,
})

function AboutPage() {
  const app = getConduitNip89AppDefinition("market")

  return (
    <AppProvenancePanel
      appName={app.name}
      appDescription="Browse decentralized storefronts, inspect listings, and send Nostr-native orders from Conduit Market."
      buildInfo={conduitBuildInfo}
      commitUrl={getCommitUrl(conduitBuildInfo)}
      identity={{
        sourceName: app.name,
        handlerAddress: getConduitNip89HandlerAddress("market"),
        handlerPubkey: app.pubkey,
        dTag: app.dTag,
        relayHint: app.relayHint,
        supportedKinds: app.supportedKinds,
        webHandlers: app.web,
      }}
    />
  )
}
