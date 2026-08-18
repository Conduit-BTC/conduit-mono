import { describe, expect, it } from "bun:test"

import { handlePostHogProxyRequest } from "../apps/posthog-proxy/src"

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

  it("rejects non-ingest paths and methods", async () => {
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

    expect(notFound.status).toBe(404)
    expect(methodNotAllowed.status).toBe(405)
  })

  it("forwards only required content headers and never forwards identity headers", async () => {
    let upstreamRequest: Request | null = null
    const response = await handlePostHogProxyRequest(
      new Request("https://e.conduit.market/i/v0/e/?ip=1", {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer secret",
          "cf-connecting-ip": "192.0.2.10",
          "content-type": "text/plain",
          cookie: "session=secret",
          origin: "https://shop.conduit.market",
          "user-agent": "sensitive-browser",
          "x-forwarded-for": "192.0.2.10",
        },
        body: "event-payload",
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
    expect(upstreamRequest?.url).toBe("https://us.i.posthog.com/i/v0/e/?ip=1")
    expect(upstreamRequest?.headers.get("content-type")).toBe("text/plain")
    expect(upstreamRequest?.headers.get("authorization")).toBeNull()
    expect(upstreamRequest?.headers.get("cf-connecting-ip")).toBeNull()
    expect(upstreamRequest?.headers.get("cookie")).toBeNull()
    expect(upstreamRequest?.headers.get("user-agent")).not.toBe(
      "sensitive-browser"
    )
    expect(upstreamRequest?.headers.get("x-forwarded-for")).toBeNull()
    expect(await upstreamRequest?.text()).toBe("event-payload")
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
