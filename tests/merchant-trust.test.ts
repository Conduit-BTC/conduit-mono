import { describe, expect, it } from "bun:test"
import {
  buildMerchantTrustSocialSummary,
  extractFollowPubkeys,
  selectLatestFollowListEvent,
} from "@conduit/core"

const merchantPubkey = "a".repeat(64)
const viewerPubkey = "b".repeat(64)
const mutualPubkey = "c".repeat(64)

describe("NIP-02 merchant trust helpers", () => {
  it("extracts unique p-tag pubkeys and ignores malformed tags", () => {
    expect(
      extractFollowPubkeys([
        ["p", merchantPubkey],
        ["p", merchantPubkey],
        ["p", "not-a-pubkey"],
        ["e", "d".repeat(64)],
      ])
    ).toEqual([merchantPubkey])
  })

  it("selects the latest contact-list event by created_at", () => {
    const latest = selectLatestFollowListEvent([
      { created_at: 10, tags: [["p", merchantPubkey]] },
      { created_at: 25, tags: [["p", viewerPubkey]] },
      { created_at: 15, tags: [["p", mutualPubkey]] },
    ])

    expect(latest?.created_at).toBe(25)
  })

  it("derives bounded merchant social context without follower crawling", () => {
    const summary = buildMerchantTrustSocialSummary({
      merchantPubkey,
      viewerPubkey,
      viewerFollowPubkeys: [merchantPubkey, mutualPubkey],
      merchantFollowPubkeys: [viewerPubkey, mutualPubkey],
    })

    expect(summary).toEqual({
      merchantFollowingCount: 2,
      viewerFollowsMerchant: true,
      merchantFollowsViewer: true,
      mutualFollowCount: 1,
    })
  })
})
