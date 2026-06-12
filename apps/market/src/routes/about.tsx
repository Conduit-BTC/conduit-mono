import { createFileRoute } from "@tanstack/react-router"
import {
  conduitBuildInfo,
  getCommitUrl,
  getConduitNip89AppDefinition,
  getConduitNip89HandlerAddress,
  pubkeyToNpub,
} from "@conduit/core"
import { AboutPagePanel } from "@conduit/ui"

export const Route = createFileRoute("/about")({
  component: AboutPage,
})

function AboutPage() {
  const app = getConduitNip89AppDefinition("market")

  return (
    <AboutPagePanel
      appName={app.name}
      appDescription="Browse decentralized storefronts, inspect listings, and send Nostr-native orders from Conduit Market."
      buildInfo={conduitBuildInfo}
      commitUrl={getCommitUrl(conduitBuildInfo)}
      identity={{
        sourceName: app.name,
        handlerAddress: getConduitNip89HandlerAddress("market"),
        handlerPubkey: app.pubkey,
        handlerNpub: app.pubkey ? pubkeyToNpub(app.pubkey) : null,
        dTag: app.dTag,
        relayHint: app.relayHint,
        supportedKinds: app.supportedKinds,
        webHandlers: app.web,
      }}
    />
  )
}
