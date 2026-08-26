import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AboutPagePanel, type AboutPageContributorSnapshot } from "@conduit/ui"

const buildInfo = {
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  shortCommitSha: "0123456",
  buildTime: "2026-08-26T01:02:03.000Z",
  sourceUrl: "https://github.com/Conduit-BTC/conduit-mono",
  releaseChannel: "production",
}

const identity = {
  sourceName: "Conduit Market",
  handlerAddress:
    "31990:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:conduit-market",
  handlerPubkey:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  handlerNpub: "npub1testhandler",
  dTag: "conduit-market",
  relayHint: "wss://relay.conduit.market",
  supportedKinds: [0, 3, 16, 30402],
}

const availableContributors: AboutPageContributorSnapshot = {
  status: "available",
  methodology: "merged-pr-activity-v1",
  generatedAt: "2026-08-26T01:00:00.000Z",
  sourceRevision: "a".repeat(40),
  contributors: [
    {
      login: "alice",
      mergedPullRequests: 7,
      commits: 42,
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      profileUrl: "https://github.com/alice",
    },
  ],
}

function renderAbout(
  contributors: AboutPageContributorSnapshot = availableContributors,
  releaseChannel = "production"
): string {
  return renderToStaticMarkup(
    <AboutPagePanel
      appName="Conduit Market"
      appDescription="Browse independent storefronts and send encrypted orders directly to merchants."
      buildInfo={{ ...buildInfo, releaseChannel }}
      commitUrl="https://github.com/Conduit-BTC/conduit-mono/commit/0123456789abcdef0123456789abcdef01234567"
      identity={identity}
      contributors={contributors}
      supportUrl="https://github.com/Conduit-BTC/conduit-mono/issues/new"
      networkSettingsHref="/network"
    />
  )
}

describe("AboutPagePanel", () => {
  it("answers visitor questions before disclosing raw technical data", () => {
    const markup = renderAbout()

    expect(markup).toContain("<h1")
    expect(markup).toContain("About Conduit Market")
    expect(markup).toContain("How Conduit works")
    expect(markup).toContain("Multiple relays")
    expect(markup).toContain("Public and private data")
    expect(markup).toContain("You stay in control")
    expect(markup).toContain("Source revision")
    expect(markup).toContain("0123456")
    expect(markup).toContain("Full source revision")
    expect(markup).toContain(buildInfo.commitSha)
    expect(markup).toContain("Nostr app handler metadata")
    expect(markup).toContain("not proof of the deployed build")
    expect(markup).not.toContain("Authenticity verification")
    expect(markup).not.toContain("App instance")
    expect(markup).not.toContain("production build")
  })

  it("retains human identities and explains merged pull request activity", () => {
    const markup = renderAbout()

    expect(markup).toContain("alice")
    expect(markup).toContain("7 merged PRs")
    expect(markup).toContain("42 commits in those PRs")
    expect(markup).toContain("Activity data:")
    expect(markup).toContain("unique, non-merge commits")
    expect(markup).toContain("do not measure the quality")
    expect(markup).toContain("View contributor graph")
  })

  it("shows an explicit state when build-time contributor refresh fails", () => {
    const markup = renderAbout({
      status: "unavailable",
      methodology: "merged-pr-activity-v1",
      generatedAt: null,
      sourceRevision: null,
      contributors: [],
    })

    expect(markup).toContain(
      "Contributor details could not be refreshed for this build."
    )
    expect(markup).not.toContain("42 commits in those PRs")
  })

  it("only shows a release badge for non-production builds", () => {
    expect(renderAbout(availableContributors, "preview")).toContain(
      "preview build"
    )
    expect(renderAbout()).not.toContain("production build")
  })
})
