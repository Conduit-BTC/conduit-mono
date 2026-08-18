import { describe, expect, it } from "bun:test"

import {
  handlePostHogProxyRequest,
  isSanitizedTelemetryRoutePath,
  rebuildPostHogIngestPayload,
} from "../apps/posthog-proxy/src"
import { sanitizeTelemetryPath } from "../packages/core/src/telemetry"
import { pubkeyToNpub } from "../packages/core/src/utils"

const PROJECT_TOKEN = "phc_workerTestProjectToken0001"

function makeEvent(
  overrides: Record<string, unknown> = {},
  properties: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    event: "$pageview",
    properties: {
      $process_person_profile: false,
      distinct_id: "conduit-browser-telemetry",
      token: PROJECT_TOKEN,
      app: "market",
      page_path: "/products/:productId",
      page_url: "https://shop.conduit.market/products/:productId",
      ...properties,
    },
    uuid: "0198f4a0-1111-7abc-8def-0123456789ab",
    ...overrides,
  }
}

function encode(payload: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
}

function ingestRequest(payload: unknown): Request {
  return new Request("https://e.conduit.market/e/?ip=1&_=123&ver=1.386.6", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://shop.conduit.market",
    },
    body: JSON.stringify(payload),
  })
}

describe("PostHog reverse proxy", () => {
  it("exposes a content-free health check", async () => {
    const response = await handlePostHogProxyRequest(
      new Request("https://e.conduit.market/health")
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ status: "ok" })
  })

  it("accepts production and single-label preview origins", async () => {
    for (const origin of [
      "https://shop.conduit.market",
      "https://sell.conduit.market",
      "https://branch.conduit-market-coo.pages.dev",
      "https://abc123.conduit-merchant-33n.pages.dev",
    ]) {
      const response = await handlePostHogProxyRequest(
        new Request("https://e.conduit.market/e/", {
          method: "OPTIONS",
          headers: { origin },
        })
      )

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe(origin)
    }
  })

  it("rejects missing, nested, and unrelated origins", async () => {
    for (const origin of [
      null,
      "https://nested.branch.conduit-market-coo.pages.dev",
      "https://shop.conduit.market.evil.example",
    ]) {
      const headers = origin ? { origin } : undefined
      const response = await handlePostHogProxyRequest(
        new Request("https://e.conduit.market/e/", {
          method: "POST",
          headers,
        })
      )

      expect(response.status).toBe(403)
    }
  })

  it("rejects non-ingest paths, methods, and encoded bodies", async () => {
    const notFound = await handlePostHogProxyRequest(
      new Request("https://e.conduit.market/flags", {
        method: "POST",
        headers: { origin: "https://shop.conduit.market" },
      })
    )
    const methodNotAllowed = await handlePostHogProxyRequest(
      new Request("https://e.conduit.market/e/", {
        headers: { origin: "https://shop.conduit.market" },
      })
    )
    const encodedBody = await handlePostHogProxyRequest(
      new Request("https://e.conduit.market/e/", {
        method: "POST",
        headers: {
          "content-encoding": "gzip",
          origin: "https://shop.conduit.market",
        },
        body: "compressed",
      })
    )

    expect(notFound.status).toBe(404)
    expect(methodNotAllowed.status).toBe(405)
    expect(encodedBody.status).toBe(415)
  })

  it("rebuilds the payload, pins the upstream query, and never forwards identity headers", async () => {
    let upstreamRequest: Request | null = null
    const response = await handlePostHogProxyRequest(
      new Request("https://e.conduit.market/i/v0/e/?ip=1&compression=gzip-js", {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer secret",
          "cf-connecting-ip": "192.0.2.10",
          "content-type": "application/json",
          cookie: "session=secret",
          origin: "https://shop.conduit.market",
          "user-agent": "sensitive-browser",
          "x-forwarded-for": "192.0.2.10",
        },
        body: JSON.stringify(makeEvent()),
      }),
      async (request) => {
        upstreamRequest = request
        return new Response("ok", {
          headers: {
            "content-type": "text/plain",
            "set-cookie": "upstream=secret",
          },
        })
      }
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(upstreamRequest).not.toBeNull()
    expect(upstreamRequest?.url).toBe("https://us.i.posthog.com/i/v0/e/?ip=0")
    expect(upstreamRequest?.headers.get("content-type")).toBe(
      "application/json"
    )
    expect(upstreamRequest?.headers.get("authorization")).toBeNull()
    expect(upstreamRequest?.headers.get("cf-connecting-ip")).toBeNull()
    expect(upstreamRequest?.headers.get("cookie")).toBeNull()
    expect(upstreamRequest?.headers.get("user-agent")).not.toBe(
      "sensitive-browser"
    )
    expect(upstreamRequest?.headers.get("x-forwarded-for")).toBeNull()

    const forwarded = await upstreamRequest?.json()
    expect(forwarded).toEqual({
      event: "$pageview",
      properties: {
        $process_person_profile: false,
        distinct_id: "conduit-browser-telemetry",
        token: PROJECT_TOKEN,
        app: "market",
        page_path: "/products/:productId",
        page_url: "https://shop.conduit.market/products/:productId",
      },
      uuid: "0198f4a0-1111-7abc-8def-0123456789ab",
    })
  })

  it("drops disallowed payloads without contacting the provider", async () => {
    let upstreamCalls = 0
    const fetcher = async (): Promise<Response> => {
      upstreamCalls += 1
      return new Response("ok")
    }
    const personMutation = await handlePostHogProxyRequest(
      ingestRequest(makeEvent({ $set: { plan: "pro" } })),
      fetcher
    )
    const unknownProperty = await handlePostHogProxyRequest(
      ingestRequest(makeEvent({}, { shippingAddress: "221B Baker Street" })),
      fetcher
    )
    const unknownEvent = await handlePostHogProxyRequest(
      ingestRequest(makeEvent({ event: "$identify" })),
      fetcher
    )
    const foreignIdentity = await handlePostHogProxyRequest(
      ingestRequest(makeEvent({}, { distinct_id: "real-user-42" })),
      fetcher
    )
    const invalidJson = await handlePostHogProxyRequest(
      new Request("https://e.conduit.market/e/", {
        method: "POST",
        headers: { origin: "https://shop.conduit.market" },
        body: "data=not-json",
      }),
      fetcher
    )

    for (const response of [
      personMutation,
      unknownProperty,
      unknownEvent,
      foreignIdentity,
    ]) {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: "dropped" })
    }
    expect(invalidJson.status).toBe(400)
    expect(upstreamCalls).toBe(0)
  })

  it("forwards only allowlisted events from a mixed batch", async () => {
    let upstreamRequest: Request | null = null
    const response = await handlePostHogProxyRequest(
      ingestRequest([
        makeEvent(),
        makeEvent({ event: "$create_alias" }),
        makeEvent(
          { event: "checkout_result" },
          { status: "success", rail: "nwc" }
        ),
      ]),
      async (request) => {
        upstreamRequest = request
        return new Response("ok")
      }
    )

    expect(response.status).toBe(200)
    const forwarded = (await upstreamRequest?.json()) as Record<
      string,
      unknown
    >[]
    expect(Array.isArray(forwarded)).toBe(true)
    expect(forwarded.map((event) => event.event)).toEqual([
      "$pageview",
      "checkout_result",
    ])
  })

  it("enforces the pinned project token when configured", async () => {
    let upstreamCalls = 0
    const fetcher = async (): Promise<Response> => {
      upstreamCalls += 1
      return new Response("ok")
    }
    const mismatch = await handlePostHogProxyRequest(
      ingestRequest(makeEvent()),
      fetcher,
      { POSTHOG_PROJECT_TOKEN: "phc_anotherProjectToken000042" }
    )

    expect(mismatch.status).toBe(200)
    expect(await mismatch.json()).toEqual({ status: "dropped" })
    expect(upstreamCalls).toBe(0)

    const match = await handlePostHogProxyRequest(
      ingestRequest(makeEvent()),
      fetcher,
      { POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN }
    )
    expect(match.status).toBe(200)
    expect(upstreamCalls).toBe(1)
  })

  it("validates session metric values and rejects raw route leaks", () => {
    const valid = rebuildPostHogIngestPayload(
      encode(
        makeEvent(
          { event: "$pageleave" },
          {
            $session_id: "0198f4a0-2222-7abc-8def-0123456789ab",
            $prev_pageview_pathname: "/products/:productId",
            $prev_pageview_duration: 12,
            $prev_pageview_max_scroll_percentage: 0.8,
          }
        )
      )
    )
    expect(valid.ok).toBe(true)
    if (valid.ok) expect(valid.events).toHaveLength(1)

    const queryLeak = rebuildPostHogIngestPayload(
      encode(
        makeEvent(
          {},
          { page_url: "https://shop.conduit.market/products?query=secret" }
        )
      )
    )
    expect(queryLeak.ok).toBe(true)
    if (queryLeak.ok) expect(queryLeak.events).toHaveLength(0)

    const foreignHost = rebuildPostHogIngestPayload(
      encode(makeEvent({}, { page_url: "https://evil.example/products" }))
    )
    expect(foreignHost.ok).toBe(true)
    if (foreignHost.ok) expect(foreignHost.events).toHaveLength(0)

    const sessionIdV4 = rebuildPostHogIngestPayload(
      encode(
        makeEvent({}, { $session_id: "6f9619ff-8b86-4d11-b42d-00c04fc964ff" })
      )
    )
    expect(sessionIdV4.ok).toBe(true)
    if (sessionIdV4.ok) expect(sessionIdV4.events).toHaveLength(0)
  })

  it("accepts only sanitized route classes for path and URL properties", () => {
    for (const rawPath of [
      "/orders/12345",
      "/products/nostr-mug-blue",
      "/u/npub-or-nip05",
      "/checkout/step-2",
      "/store/not-an-npub",
      "/random/deep/path",
    ]) {
      expect(isSanitizedTelemetryRoutePath(rawPath)).toBe(false)
      expect(
        isSanitizedTelemetryRoutePath(sanitizeTelemetryPath(rawPath))
      ).toBe(true)

      const rawPathEvent = rebuildPostHogIngestPayload(
        encode(makeEvent({}, { page_path: rawPath }))
      )
      expect(rawPathEvent.ok).toBe(true)
      if (rawPathEvent.ok) expect(rawPathEvent.events).toHaveLength(0)

      const rawUrlEvent = rebuildPostHogIngestPayload(
        encode(
          makeEvent(
            {},
            {
              page_path: "/orders",
              page_url: `https://shop.conduit.market${rawPath}`,
            }
          )
        )
      )
      expect(rawUrlEvent.ok).toBe(true)
      if (rawUrlEvent.ok) expect(rawUrlEvent.events).toHaveLength(0)
    }

    const merchantNpub = pubkeyToNpub("f".repeat(64))
    const storefrontPath = sanitizeTelemetryPath(`/store/${merchantNpub}`)
    expect(storefrontPath).toBe(`/store/${merchantNpub}`)
    expect(isSanitizedTelemetryRoutePath(storefrontPath)).toBe(true)
    expect(isSanitizedTelemetryRoutePath("/")).toBe(true)
    expect(isSanitizedTelemetryRoutePath("/:param")).toBe(true)
    expect(isSanitizedTelemetryRoutePath("/wallet/:param")).toBe(true)
    expect(isSanitizedTelemetryRoutePath("/orders/:param")).toBe(false)
  })

  it("rejects oversized declared and streamed payloads", async () => {
    let upstreamCalls = 0
    const fetcher = async (): Promise<Response> => {
      upstreamCalls += 1
      return new Response("ok")
    }
    const declared = await handlePostHogProxyRequest(
      new Request("https://e.conduit.market/e/", {
        method: "POST",
        headers: {
          "content-length": String(1024 * 1024 + 1),
          origin: "https://shop.conduit.market",
        },
        body: "small",
      }),
      fetcher
    )
    const streamed = await handlePostHogProxyRequest(
      new Request("https://e.conduit.market/e/", {
        method: "POST",
        headers: { origin: "https://shop.conduit.market" },
        body: new Uint8Array(1024 * 1024 + 1),
      }),
      fetcher
    )

    expect(declared.status).toBe(413)
    expect(await declared.json()).toEqual({ error: "payload_too_large" })
    expect(streamed.status).toBe(413)
    expect(await streamed.json()).toEqual({ error: "payload_too_large" })
    expect(upstreamCalls).toBe(0)
  })
})
