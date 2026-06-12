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
  const app = getConduitNip89AppDefinition("merchant")

  return (
    <AboutPagePanel
      appName={app.name}
      appDescription="Manage listings, invoices, fulfillment, and buyer conversations from the Conduit Merchant Portal."
      buildInfo={conduitBuildInfo}
      commitUrl={getCommitUrl(conduitBuildInfo)}
      identity={{
        sourceName: app.name,
        handlerAddress: getConduitNip89HandlerAddress("merchant"),
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
