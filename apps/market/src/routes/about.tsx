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

const protocols = [
  {
    name: "Signed product listings · NIP-99 + Open Markets",
    description:
      "Browse public merchant listings with signed provenance and current revision evidence.",
    href: "https://github.com/OpenMarketsFoundation/specification",
  },
  {
    name: "External signers · NIP-07 and NIP-46",
    description:
      "Connect a browser or remote signer while keeping your durable Nostr account key outside Conduit.",
    href: "https://github.com/nostr-protocol/nips/blob/master/07.md",
  },
  {
    name: "Private orders and messages · NIP-17",
    description:
      "Send encrypted orders and conversations directly to merchants through Nostr relays.",
    href: "https://github.com/nostr-protocol/nips/blob/master/17.md",
  },
  {
    name: "Lightning wallets · NIP-47 when connected",
    description:
      "Use a compatible connected wallet for optional Nostr Wallet Connect payment flows.",
    href: "https://github.com/nostr-protocol/nips/blob/master/47.md",
  },
] as const

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
      appDescription="Browse independent merchants, compare public signed listings, and send encrypted orders directly to them."
      buildInfo={conduitBuildInfo}
      commitUrl={getCommitUrl(conduitBuildInfo)}
      contributors={repositoryContributorSnapshot}
      supportUrl={buildBugReportUrl({ app: "market", route: "/about" })}
      protocols={protocols}
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
