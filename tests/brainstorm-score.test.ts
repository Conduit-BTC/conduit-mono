import { afterEach, describe, expect, it, mock } from "bun:test"
import {
  fetchBrainstormGlobalScore,
  parseBrainstormGlobalScore,
} from "../apps/market/src/lib/brainstorm-score"

const PUBKEY = "a".repeat(64)
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Brainstorm global score", () => {
  it("converts the live ORE influence scale to Brainstorm's 0–100 display", () => {
    expect(
      parseBrainstormGlobalScore({ pubkey: PUBKEY, rank: 0.934 }, PUBKEY)
    ).toEqual({ pubkey: PUBKEY, score: 93 })
    expect(
      parseBrainstormGlobalScore({ pubkey: PUBKEY, rank: 0 }, PUBKEY)
    ).toEqual({ pubkey: PUBKEY, score: 0 })
  })

  it("rejects a mismatched identity or malformed score", () => {
    expect(() =>
      parseBrainstormGlobalScore({ pubkey: "b".repeat(64), rank: 0.9 }, PUBKEY)
    ).toThrow("invalid global score")
    expect(() =>
      parseBrainstormGlobalScore({ pubkey: PUBKEY, rank: 93 }, PUBKEY)
    ).toThrow("invalid global score")
    expect(() =>
      parseBrainstormGlobalScore({ pubkey: PUBKEY, rank: NaN }, PUBKEY)
    ).toThrow("invalid global score")
  })

  it("requests only the viewed public key without credentials or a referrer", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ pubkey: PUBKEY, rank: 0.734 }), {
          status: 200,
        })
    )
    globalThis.fetch = fetchMock as typeof fetch
    const signal = new AbortController().signal

    expect(await fetchBrainstormGlobalScore(PUBKEY, signal)).toEqual({
      pubkey: PUBKEY,
      score: 73,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.brainstorm.world/stats/pubkey",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey: PUBKEY }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
      }
    )
  })
})
