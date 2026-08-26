import { createFileRoute } from "@tanstack/react-router"
import { repositoryContributorSnapshot } from "virtual:conduit-repository-contributors"
import {
  buildBugReportUrl,
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

function getSafeNpub(pubkey: string | null): string | null {
  if (!pubkey) return null
  const npub = pubkeyToNpub(pubkey)
  return npub.startsWith("npub1") ? npub : null
}

function AboutPage() {
  const app = getConduitNip89AppDefinition("market")

  return (
    <AboutPagePanel
      appName={app.name}
      appDescription="Browse independent storefronts, compare public signed listings, and send encrypted orders directly to merchants."
      buildInfo={conduitBuildInfo}
      commitUrl={getCommitUrl(conduitBuildInfo)}
      contributors={repositoryContributorSnapshot}
      supportUrl={buildBugReportUrl({ app: "market", route: "/about" })}
      networkSettingsHref="/network"
      identity={{
        sourceName: app.name,
        handlerAddress: getConduitNip89HandlerAddress("market"),
        handlerPubkey: app.pubkey,
        handlerNpub: getSafeNpub(app.pubkey),
        dTag: app.dTag,
        relayHint: app.relayHint,
        supportedKinds: app.supportedKinds,
      }}
    />
  )
}
