import { afterEach, describe, expect, it, mock } from "bun:test"
import {
  fetchBrainstormVerification,
  parseBrainstormVerification,
} from "../apps/market/src/lib/brainstorm-verification"

const PUBKEY = "a".repeat(64)
const originalFetch = globalThis.fetch
const response = (verified = false) => ({
  code: 200,
  data: { results: [{ pubkey: PUBKEY, verified }] },
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Brainstorm positive verification", () => {
  it("uses only the provider's positive verification, ignoring scores and flags", () => {
    expect(parseBrainstormVerification(response(true), PUBKEY)).toBe(true)
    expect(parseBrainstormVerification(response(), PUBKEY)).toBe(false)
    for (const flagged of [true, false, "malformed", undefined]) {
      expect(
        parseBrainstormVerification(
          {
            code: 200,
            data: {
              results: [
                {
                  pubkey: PUBKEY,
                  verified: true,
                  flagged,
                  influence: 0,
                  reporters: 1000,
                },
              ],
            },
          },
          PUBKEY
        )
      ).toBe(true)
      expect(
        parseBrainstormVerification(
          {
            code: 200,
            data: {
              results: [
                {
                  pubkey: PUBKEY,
                  verified: false,
                  flagged,
                  influence: 1,
                },
              ],
            },
          },
          PUBKEY
        )
      ).toBe(false)
    }
  })

  it("rejects mismatched, missing, duplicated and malformed verdicts", () => {
    for (const value of [
      null,
      {},
      { ...response(), code: 500 },
      { code: 200, data: { results: [] } },
      {
        code: 200,
        data: {
          results: [response().data.results[0], response().data.results[0]],
        },
      },
      {
        code: 200,
        data: { results: [{ pubkey: "b".repeat(64), verified: true }] },
      },
      { code: 200, data: { results: [{ pubkey: PUBKEY, rank: 0.9 }] } },
      { code: 200, data: { results: [{ pubkey: PUBKEY, verified: "true" }] } },
    ]) {
      expect(() => parseBrainstormVerification(value, PUBKEY)).toThrow(
        "invalid verification"
      )
    }
  })

  it("requests only the viewed public key without credentials or a referrer", async () => {
    const fetchMock = mock(
      async () => new Response(JSON.stringify(response(true)))
    )
    globalThis.fetch = fetchMock as typeof fetch
    expect(await fetchBrainstormVerification(PUBKEY)).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.brainstorm.world/user/trustSignals",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkeys: [PUBKEY] }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
      }
    )
  })

  it("does not request malformed identities or an already cancelled lookup", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify(response())))
    globalThis.fetch = fetchMock as typeof fetch
    await expect(fetchBrainstormVerification("invalid")).rejects.toThrow(
      "hex pubkey"
    )
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchBrainstormVerification(PUBKEY, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  it("forwards cancellation to the bounded request", async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    globalThis.fetch = mock(async (_url, options) => {
      requestSignal = options?.signal as AbortSignal
      return new Response(JSON.stringify(response()))
    }) as typeof fetch
    await fetchBrainstormVerification(PUBKEY, controller.signal)
    controller.abort()
    expect(requestSignal?.aborted).toBe(true)
  })

  it("rejects HTTP failures and unsupported pending responses", async () => {
    for (const status of [202, 404, 500]) {
      globalThis.fetch = mock(
        async () => new Response(null, { status })
      ) as typeof fetch
      await expect(fetchBrainstormVerification(PUBKEY)).rejects.toThrow(
        `failed (${status})`
      )
    }
  })
})
