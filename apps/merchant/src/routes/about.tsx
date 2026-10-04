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
      "Publish and update public storefront listings as signed Nostr events.",
    href: "https://github.com/OpenMarketsFoundation/specification",
  },
  {
    name: "External signers · NIP-07 and NIP-46",
    description:
      "Sign with a browser or remote signer while keeping your durable Nostr account key outside Conduit.",
    href: "https://github.com/nostr-protocol/nips/blob/master/07.md",
  },
  {
    name: "Private orders and messages · NIP-17",
    description:
      "Receive encrypted orders and coordinate with shoppers through Nostr relays.",
    href: "https://github.com/nostr-protocol/nips/blob/master/17.md",
  },
  {
    name: "Lightning payments · NIP-47 and NIP-57 when supported",
    description:
      "Coordinate invoice and proof flows with compatible wallets and zap-capable payment paths.",
    href: "https://github.com/nostr-protocol/nips/blob/master/57.md",
  },
] as const

function getSafeNpub(pubkey: string | null): string | null {
  if (!pubkey) return null
  const npub = pubkeyToNpub(pubkey)
  return npub.startsWith("npub1") ? npub : null
}

function AboutPage() {
  const app = getConduitNip89AppDefinition("merchant")

  return (
    <AboutPagePanel
      appName={app.name}
      logoSrc="/images/logo/merchant-logo-icon.svg"
      appDescription="Publish and manage your storefront, coordinate orders and fulfillment, and communicate privately with shoppers."
      buildInfo={conduitBuildInfo}
      commitUrl={getCommitUrl(conduitBuildInfo)}
      contributors={repositoryContributorSnapshot}
      supportUrl={buildBugReportUrl({ app: "merchant", route: "/about" })}
      protocols={protocols}
      identity={{
        sourceName: app.name,
        handlerAddress: getConduitNip89HandlerAddress("merchant"),
        handlerPubkey: app.pubkey,
        handlerNpub: getSafeNpub(app.pubkey),
        dTag: app.dTag,
        relayHint: app.relayHint,
        supportedKinds: app.supportedKinds,
      }}
    />
  )
}
