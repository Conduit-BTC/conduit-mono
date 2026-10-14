import { describe, expect, it, mock } from "bun:test"

import {
  decodeLnurl,
  encodeLnurl,
  fetchLnurlPayMetadata,
  fetchLnurlPayMetadataFromUrl,
  LnurlMetadataTransportUnavailableError,
} from "../packages/core/src/protocol/lightning"

const PAY_REQUEST_URL = "https://wallet.conduit.market/.well-known/lnurlp/alice"
const CALLBACK_URL = "https://wallet.conduit.market/lnurlp/callback"
const PROVIDER_PUBKEY = "a".repeat(64)

function metadataResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      tag: "payRequest",
      callback: CALLBACK_URL,
      minSendable: 1_000,
      maxSendable: 1_000_000,
      metadata: "[]",
      allowsNostr: true,
      nostrPubkey: PROVIDER_PUBKEY,
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
}

describe("LNURL encoding and authority metadata", () => {
  it.each([408, 429, 500, 503, 599])(
    "classifies same-destination HTTP %s metadata availability without reading its body",
    async (status) => {
      const response = new Response(null, { status })
      const read = mock(async () => {
        throw new Error("Response body must not be read")
      })
      Object.defineProperty(response, "text", { value: read })
      const error = await fetchLnurlPayMetadataFromUrl(PAY_REQUEST_URL, {
        fetchImpl: mock(async () => response) as unknown as typeof fetch,
      }).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(LnurlMetadataTransportUnavailableError)
      expect(error).toMatchObject({ reason: "server" })
      expect(read).toHaveBeenCalledTimes(0)
    }
  )

  it("classifies only its own metadata fetch timeout", async () => {
    const error = await fetchLnurlPayMetadataFromUrl(PAY_REQUEST_URL, {
      timeoutMs: 5,
      fetchImpl: mock(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init!.signal!
            const watchdog = setTimeout(
              () =>
                reject(new Error("Synthetic metadata timeout did not abort")),
              250
            )
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(watchdog)
                reject(signal.reason)
              },
              { once: true }
            )
          })
      ) as typeof fetch,
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(LnurlMetadataTransportUnavailableError)
    expect(error).toMatchObject({ reason: "timeout" })
  })

  it("preserves only its exact timeout while reading an unfinished metadata body", async () => {
    const error = await fetchLnurlPayMetadataFromUrl(PAY_REQUEST_URL, {
      timeoutMs: 5,
      fetchImpl: mock((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init!.signal!
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const watchdog = setTimeout(
              () =>
                controller.error(
                  new Error("Synthetic body timeout did not abort")
                ),
              250
            )
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(watchdog)
                controller.error(signal.reason)
              },
              { once: true }
            )
          },
        })
        return Promise.resolve(new Response(body, { status: 200 }))
      }) as typeof fetch,
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(LnurlMetadataTransportUnavailableError)
    expect(error).toMatchObject({ reason: "timeout" })
  })

  it("does not classify unknown fetch errors or malformed and redirected responses as availability", async () => {
    const unexpectedFetch = await fetchLnurlPayMetadataFromUrl(
      PAY_REQUEST_URL,
      {
        fetchImpl: mock(async () => {
          throw new Error("Synthetic adapter defect")
        }) as unknown as typeof fetch,
      }
    ).catch((error: unknown) => error)
    expect(unexpectedFetch).toBeInstanceOf(Error)
    expect(unexpectedFetch).not.toBeInstanceOf(
      LnurlMetadataTransportUnavailableError
    )
    const responses = [
      new Response(null, { status: 302 }),
      new Response(null, { status: 404 }),
      new Response("{", { status: 200 }),
      metadataResponse({ tag: "withdrawRequest" }),
      metadataResponse({ minSendable: 0 }),
      metadataResponse({ callback: "https://127.0.0.1/callback" }),
      new Response("{}", {
        status: 200,
        headers: { "content-length": "65537" },
      }),
    ]
    for (const response of responses) {
      const error = await fetchLnurlPayMetadataFromUrl(PAY_REQUEST_URL, {
        fetchImpl: mock(async () => response) as unknown as typeof fetch,
      }).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(LnurlMetadataTransportUnavailableError)
    }
  })

  it("does not classify a body-read TypeError as a metadata fetch failure", async () => {
    const response = new Response(null, { status: 200 })
    Object.defineProperty(response, "text", {
      value: async () => {
        throw new TypeError("Synthetic body-read failure")
      },
    })
    const error = await fetchLnurlPayMetadataFromUrl(PAY_REQUEST_URL, {
      fetchImpl: mock(async () => response) as unknown as typeof fetch,
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(LnurlMetadataTransportUnavailableError)
  })

  it("keeps unavailable metadata at an unexpected destination terminal", async () => {
    const response = new Response(null, { status: 503 })
    Object.defineProperty(response, "url", {
      value: "https://other.conduit.market/metadata",
    })
    const error = await fetchLnurlPayMetadataFromUrl(PAY_REQUEST_URL, {
      fetchImpl: mock(async () => response) as unknown as typeof fetch,
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(LnurlMetadataTransportUnavailableError)
  })

  it("round-trips a checksummed LNURL with the required separator", () => {
    const encoded = encodeLnurl(PAY_REQUEST_URL)

    expect(encoded.startsWith("lnurl1")).toBe(true)
    expect(decodeLnurl(encoded)).toBe(PAY_REQUEST_URL)
    expect(decodeLnurl(encoded.toUpperCase())).toBe(PAY_REQUEST_URL)
  })

  it("rejects malformed, mixed-case, and non-URL LNURL values", () => {
    const encoded = encodeLnurl(PAY_REQUEST_URL)
    const tampered = `${encoded.slice(0, -1)}${encoded.endsWith("q") ? "p" : "q"}`
    const mixedCase = `L${encoded.slice(1)}`

    expect(decodeLnurl(encoded.replace("lnurl1", "lnurl"))).toBeNull()
    expect(decodeLnurl(tampered)).toBeNull()
    expect(decodeLnurl(mixedCase)).toBeNull()
    expect(decodeLnurl(encodeLnurl("javascript:alert(1)"))).toBeNull()
  })

  it("fetches validated metadata only from a safe public HTTPS URL", async () => {
    const fetchImpl = mock(async () => metadataResponse())

    const metadata = await fetchLnurlPayMetadataFromUrl(PAY_REQUEST_URL, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 2_500,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(metadata).toMatchObject({
      payRequestUrl: PAY_REQUEST_URL,
      callback: CALLBACK_URL,
      allowsNostr: true,
      nostrPubkey: PROVIDER_PUBKEY,
    })
    expect(decodeLnurl(metadata.lnurl)).toBe(PAY_REQUEST_URL)
  })

  it("rejects unsafe request and callback URLs", async () => {
    const fetchImpl = mock(async () => metadataResponse())
    const options = { fetchImpl: fetchImpl as unknown as typeof fetch }

    for (const unsafeUrl of [
      "http://wallet.conduit.market/.well-known/lnurlp/alice",
      "https://localhost/.well-known/lnurlp/alice",
      "https://127.0.0.1/.well-known/lnurlp/alice",
      "https://user:password@wallet.conduit.market/.well-known/lnurlp/alice",
      "https://wallet.conduit.market:8443/.well-known/lnurlp/alice",
    ]) {
      await expect(
        fetchLnurlPayMetadataFromUrl(unsafeUrl, options)
      ).rejects.toThrow(/Unsafe LNURL-pay request URL/)
    }
    expect(fetchImpl).toHaveBeenCalledTimes(0)

    await expect(
      fetchLnurlPayMetadataFromUrl(PAY_REQUEST_URL, {
        fetchImpl: mock(async () =>
          metadataResponse({ callback: "https://127.0.0.1/callback" })
        ) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/unsafe callback/)
  })

  it("does not follow an LNURL metadata redirect", async () => {
    const fetchImpl = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual")
        return new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/private" },
        })
      }
    )

    await expect(
      fetchLnurlPayMetadataFromUrl(PAY_REQUEST_URL, {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toThrow(/LNURL endpoint returned 302/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("rejects oversized metadata before or after reading the response body", async () => {
    const declaredOversized = new Response("{}", {
      status: 200,
      headers: { "content-length": String(64 * 1_024 + 1) },
    })
    const actualOversized = new Response(
      JSON.stringify({ padding: "x".repeat(64 * 1_024) }),
      { status: 200 }
    )

    for (const response of [declaredOversized, actualOversized]) {
      await expect(
        fetchLnurlPayMetadataFromUrl(PAY_REQUEST_URL, {
          fetchImpl: mock(async () => response) as unknown as typeof fetch,
        })
      ).rejects.toThrow(/response is too large/)
    }
  })

  it("passes bounded fetch options through lud16 resolution", async () => {
    const fetchImpl = mock(async () => metadataResponse())

    const metadata = await fetchLnurlPayMetadata(
      "alice@wallet.conduit.market",
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 2_500,
      }
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(metadata.payRequestUrl).toBe(PAY_REQUEST_URL)
  })
})
