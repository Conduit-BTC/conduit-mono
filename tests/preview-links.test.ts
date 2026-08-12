import { describe, expect, it } from "bun:test"
import {
  extractUrlsFromCommentBody,
  resolveProjectUrls,
  waitForProjectRows,
} from "../scripts/ci/preview_links.mjs"

const HEAD_SHA = "75ede52c8cc6120b807b55de0bc81ecef00dfeed"

function cloudflareComment({
  project,
  revision = HEAD_SHA.slice(0, 7),
  branchSuffix,
}: {
  project: "conduit-market" | "conduit-merchant"
  revision?: string
  branchSuffix: string
}) {
  return {
    user: { login: "cloudflare-workers-and-pages[bot]" },
    body: `## Deploying ${project}

<table><tr><td><strong>Latest commit:</strong></td><td>
<code>${revision}</code>
</td></tr>
<tr><td><strong>Preview URL:</strong></td><td>
<a href='https://${revision}.${project}.pages.dev'>commit</a>
</td></tr>
<tr><td><strong>Branch Preview URL:</strong></td><td>
<a href='https://dependabot-${branchSuffix}.${project}.pages.dev'>branch</a>
</td></tr></table>`,
  }
}

const PROJECTS = {
  market: { label: "Market", project: "conduit-market" },
  merchant: { label: "Merchant", project: "conduit-merchant" },
}

describe("preview link resolution", () => {
  it("extracts URLs when Cloudflare places labels and anchors on separate lines", () => {
    const comment = cloudflareComment({
      project: "conduit-market",
      branchSuffix: "market-y7u6",
    })

    expect(extractUrlsFromCommentBody(comment.body)).toEqual({
      commitUrl: "https://75ede52.conduit-market.pages.dev",
      branchUrl: "https://dependabot-market-y7u6.conduit-market.pages.dev",
    })
  })

  it("ignores successful comments for a stale head", () => {
    const comment = cloudflareComment({
      project: "conduit-market",
      revision: "deadbee",
      branchSuffix: "stale",
    })

    expect(
      resolveProjectUrls({
        comments: [comment],
        projectName: "conduit-market",
        headSha: HEAD_SHA,
      })
    ).toEqual({ commitUrl: null, branchUrl: null })
  })

  it("waits for independently delayed Market and Merchant aliases", async () => {
    const market = cloudflareComment({
      project: "conduit-market",
      branchSuffix: "market-y7u6",
    })
    const merchant = cloudflareComment({
      project: "conduit-merchant",
      branchSuffix: "merchant-lknh",
    })
    const snapshots = [[], [market], [market, merchant]]
    let calls = 0

    const result = await waitForProjectRows({
      projects: PROJECTS,
      headSha: HEAD_SHA,
      attempts: snapshots.length,
      intervalMs: 0,
      sleep: async () => {},
      listComments: async () => snapshots[calls++] || snapshots.at(-1)!,
    })

    expect(calls).toBe(3)
    expect(result.rows.map((row) => row.branchUrl)).toEqual([
      "https://dependabot-market-y7u6.conduit-market.pages.dev",
      "https://dependabot-merchant-lknh.conduit-merchant.pages.dev",
    ])
  })

  it("times out without synthesizing an unverified branch URL", async () => {
    await expect(
      waitForProjectRows({
        projects: PROJECTS,
        headSha: HEAD_SHA,
        attempts: 2,
        intervalMs: 0,
        sleep: async () => {},
        listComments: async () => [],
      })
    ).rejects.toThrow("refusing to guess deployment aliases")
  })
})
