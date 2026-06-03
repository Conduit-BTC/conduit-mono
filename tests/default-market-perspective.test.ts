import { describe, expect, it } from "bun:test"
import {
  DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS,
  DEFAULT_MARKET_PERSPECTIVE_MIN_REFRESH_FOLLOWS,
  getDefaultMarketPerspectiveRefreshThreshold,
  resolveSafeDefaultMarketPerspectiveFollowRefresh,
  storeDefaultMarketPerspectiveFollowPubkeys,
} from "../apps/market/src/lib/defaultMarketPerspective"

describe("default Market perspective follow-list safety", () => {
  it("rejects empty and tiny refreshed follow lists", () => {
    expect(
      resolveSafeDefaultMarketPerspectiveFollowRefresh(
        [],
        [...DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS]
      )
    ).toBeNull()
    expect(
      resolveSafeDefaultMarketPerspectiveFollowRefresh(
        DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 2),
        DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS
      )
    ).toBeNull()
  })

  it("accepts plausibly complete external curation updates", () => {
    const threshold = getDefaultMarketPerspectiveRefreshThreshold(
      DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS
    )
    const refreshed = DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(
      0,
      threshold
    )

    expect(threshold).toBeGreaterThanOrEqual(
      DEFAULT_MARKET_PERSPECTIVE_MIN_REFRESH_FOLLOWS
    )
    expect(
      resolveSafeDefaultMarketPerspectiveFollowRefresh(
        refreshed,
        DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS
      )
    ).toEqual(refreshed)
  })

  it("normalizes and dedupes safe refreshes before storing", () => {
    const threshold = getDefaultMarketPerspectiveRefreshThreshold(
      DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS
    )
    const refreshed = DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(
      0,
      threshold
    )
    const noisyRefresh = [
      refreshed[0]?.toUpperCase() ?? "",
      "not-a-pubkey",
      ...refreshed,
    ]

    expect(
      storeDefaultMarketPerspectiveFollowPubkeys(noisyRefresh, 1, {
        previousPubkeys: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS,
      })
    ).toEqual(refreshed)
  })
})
