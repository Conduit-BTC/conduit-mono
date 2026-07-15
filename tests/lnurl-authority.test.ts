import { describe, expect, it, mock } from "bun:test"

import {
  decodeLnurl,
  encodeLnurl,
  fetchLnurlPayMetadata,
  fetchLnurlPayMetadataFromUrl,
} from "../packages/core/src/protocol/lightning"

const PAY_REQUEST_URL = "https://wallet.example/.well-known/lnurlp/alice"
const CALLBACK_URL = "https://wallet.example/lnurlp/callback"
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
      "http://wallet.example/.well-known/lnurlp/alice",
      "https://localhost/.well-known/lnurlp/alice",
      "https://127.0.0.1/.well-known/lnurlp/alice",
      "https://user:password@wallet.example/.well-known/lnurlp/alice",
      "https://wallet.example:8443/.well-known/lnurlp/alice",
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

    const metadata = await fetchLnurlPayMetadata("alice@wallet.example", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 2_500,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(metadata.payRequestUrl).toBe(PAY_REQUEST_URL)
  })
})
