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
    ).toBe(93)
    expect(
      parseBrainstormGlobalScore({ pubkey: PUBKEY, rank: 0 }, PUBKEY)
    ).toBe(0)
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

    expect(await fetchBrainstormGlobalScore(PUBKEY, signal)).toBe(73)
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

  it("retries a pending score after Retry-After without changing the request", async () => {
    let calls = 0
    const fetchMock = mock(async () => {
      calls += 1
      if (calls === 1) {
        return new Response(null, {
          status: 202,
          headers: { "Retry-After": "1" },
        })
      }
      return new Response(JSON.stringify({ pubkey: PUBKEY, rank: 0.734 }), {
        status: 200,
      })
    })
    globalThis.fetch = fetchMock as typeof fetch
    const signal = new AbortController().signal
    const started = Date.now()

    expect(await fetchBrainstormGlobalScore(PUBKEY, signal)).toBe(73)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0])
  })

  it("stops a pending retry when the request is cancelled", async () => {
    let firstRequestStarted!: () => void
    const firstRequest = new Promise<void>((resolve) => {
      firstRequestStarted = resolve
    })
    const fetchMock = mock(async () => {
      firstRequestStarted()
      return new Response(null, {
        status: 202,
        headers: { "Retry-After": "30" },
      })
    })
    globalThis.fetch = fetchMock as typeof fetch
    const controller = new AbortController()
    const scorePromise = fetchBrainstormGlobalScore(PUBKEY, controller.signal)

    await firstRequest
    controller.abort()

    await expect(scorePromise).rejects.toMatchObject({ name: "AbortError" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("bounds repeated pending responses", async () => {
    const fetchMock = mock(
      async () =>
        new Response(null, {
          status: 202,
          headers: { "Retry-After": "0" },
        })
    )
    globalThis.fetch = fetchMock as typeof fetch

    await expect(fetchBrainstormGlobalScore(PUBKEY)).rejects.toThrow(
      "still being prepared"
    )
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("does not retry before a delay beyond the wait budget", async () => {
    const fetchMock = mock(
      async () =>
        new Response(null, {
          status: 202,
          headers: { "Retry-After": "31" },
        })
    )
    globalThis.fetch = fetchMock as typeof fetch

    await expect(fetchBrainstormGlobalScore(PUBKEY)).rejects.toThrow(
      "still being prepared"
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
