import { describe, expect, it } from "bun:test"

import {
  type AllowedOriginContext,
  handlePostHogProxyRequest,
  isSanitizedTelemetryRoutePath,
  rebuildPostHogIngestPayload as rebuildPostHogIngestPayloadWithContext,
} from "../apps/posthog-proxy/src"
import {
  browserTelemetryEventNames,
  browserTelemetryEventPropertyContracts,
  type BrowserTelemetryEventName,
} from "../packages/core/src/telemetry-contract"
import { sanitizeTelemetryPath } from "../packages/core/src/telemetry"
import { pubkeyToNpub } from "../packages/core/src/utils"

const PROJECT_TOKEN = "phc_workerTestProjectToken0001"
const MARKET_ORIGIN_CONTEXT = {
  app: "market",
  origin: "https://shop.conduit.market",
} as const satisfies AllowedOriginContext
const MERCHANT_ORIGIN_CONTEXT = {
  app: "merchant",
  origin: "https://sell.conduit.market",
} as const satisfies AllowedOriginContext

function makeEvent(
  overrides: Record<string, unknown> = {},
  properties: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    event: "$pageview",
    properties: {
      $process_person_profile: false,
      $pageview_id: "0198f4a0-3333-7abc-8def-0123456789ab",
      $session_id: "0198f4a0-2222-7abc-8def-0123456789ab",
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

const validBrowserEventProperties = {
  app_load_result: { network: "browser", status: "success" },
  client_error_result: {
    action: "window_error",
    event_family: "type_error",
    mode: "unhandled",
    status: "failure",
    surface: "browser",
  },
  signer_connected: { method: "nip07", status: "success" },
  signer_disconnected: { method: "nip46", status: "success" },
  cart_add: {
    action: "add",
    count_bucket: "1",
    product_type: "physical",
    status: "success",
    surface: "cart",
  },
  cart_remove: {
    action: "remove",
    count_bucket: "1",
    product_type: "digital",
    status: "success",
    surface: "cart",
  },
  cart_clear: {
    action: "clear_all",
    count_bucket: "2_3",
    product_type: "mixed",
    status: "success",
    surface: "cart",
  },
  checkout_initiated: {
    count_bucket: "2_3",
    product_type: "physical",
    status: "success",
    surface: "cart",
  },
  checkout_step_result: {
    amount_bucket: "10k_100k_sats",
    count_bucket: "2_3",
    mode: "checkout",
    product_type: "physical",
    rail: "none",
    status: "started",
    step: "shipping",
    surface: "checkout",
  },
  checkout_success: {
    amount_bucket: "10k_100k_sats",
    count_bucket: "2_3",
    mode: "order_first",
    product_type: "physical",
    rail: "lightning",
    status: "order_sent",
    surface: "checkout",
  },
  checkout_result: {
    amount_bucket: "10k_100k_sats",
    count_bucket: "2_3",
    mode: "checkout",
    network: "browser",
    product_type: "physical",
    rail: "nwc",
    status: "success",
    surface: "checkout",
  },
  relay_connect_result: { network: "browser", status: "success" },
  relay_publish_result: { network: "browser", status: "failure" },
  wallet_connect_result: {
    method: "nwc",
    rail: "lightning",
    status: "pay_capable",
  },
  payment_attempt_result: {
    amount_bucket: "1k_10k_sats",
    latency_bucket: "250ms_1s",
    mode: "automatic",
    rail: "wallet",
    status: "success",
  },
  merchant_setup_step_result: {
    app: "merchant",
    status: "blocked",
    step: "payments",
    surface: "merchant_readiness",
  },
  product_publish_result: {
    app: "merchant",
    event_family: "create",
    latency_bucket: "1s_3s",
    status: "success",
  },
  shipping_publish_result: {
    app: "merchant",
    event_family: "publish",
    latency_bucket: "1s_3s",
    status: "failure",
  },
  market_browse_action: {
    action: "storefront_search",
    result_count_bucket: "4_10",
    status: "success",
    surface: "storefront",
  },
  product_detail_action: {
    action: "view_cart",
    product_type: "digital",
    surface: "product_detail",
  },
} satisfies Record<BrowserTelemetryEventName, Record<string, string>>

function makeBrowserTelemetryEvent(
  eventName: BrowserTelemetryEventName,
  properties: Record<string, unknown> = {}
): Record<string, unknown> {
  const app = properties.app ?? validBrowserEventProperties[eventName].app
  return makeEvent(
    { event: eventName },
    {
      event_name: eventName,
      ...(app === "merchant"
        ? { page_url: "https://sell.conduit.market/products/:productId" }
        : {}),
      ...validBrowserEventProperties[eventName],
      ...properties,
    }
  )
}

function encode(payload: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
}

function rebuildPostHogIngestPayload(
  body: ArrayBuffer,
  originContext: AllowedOriginContext = MARKET_ORIGIN_CONTEXT
) {
  return rebuildPostHogIngestPayloadWithContext(body, originContext)
}

function ingestRequest(
  payload: unknown,
  origin = "https://shop.conduit.market"
): Request {
  return new Request("https://e.conduit.market/e/?ip=1&_=123&ver=1.386.6", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
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
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true"
      )
    }
  })

  it("rejects missing, nested, and unrelated origins", async () => {
    for (const origin of [
      null,
      "https://nested.branch.conduit-market-coo.pages.dev",
      "https://shop.conduit.market.evil.example",
      "https://shop.conduit.market/",
      "https://shop.conduit.market/private",
      "https://shop.conduit.market?source=private",
      "https://user:password@shop.conduit.market",
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
        $pageview_id: "0198f4a0-3333-7abc-8def-0123456789ab",
        $session_id: "0198f4a0-2222-7abc-8def-0123456789ab",
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
        makeBrowserTelemetryEvent("checkout_result"),
        makeBrowserTelemetryEvent("app_load_result", {
          app: "merchant",
          page_url: "https://sell.conduit.market/products/:productId",
        }),
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

  it("binds app and page context to the allowed caller origin", async () => {
    let upstreamCalls = 0
    const fetcher = async (): Promise<Response> => {
      upstreamCalls += 1
      return new Response("ok")
    }

    for (const [origin, app] of [
      ["https://shop.conduit.market", "market"],
      ["https://sell.conduit.market", "merchant"],
      ["https://conduit-market-coo.pages.dev", "market"],
      ["https://conduit-merchant-33n.pages.dev", "merchant"],
      ["https://branch.conduit-market-coo.pages.dev", "market"],
      ["https://branch.conduit-merchant-33n.pages.dev", "merchant"],
    ] as const) {
      const callsBefore = upstreamCalls
      const response = await handlePostHogProxyRequest(
        ingestRequest(
          makeBrowserTelemetryEvent("app_load_result", {
            app,
            page_url: `${origin}/products/:productId`,
          }),
          origin
        ),
        fetcher
      )

      expect(response.status).toBe(200)
      expect(upstreamCalls).toBe(callsBefore + 1)
    }

    for (const [event, properties] of [
      ["$pageview", {}],
      ["$pageleave", {}],
      ["$web_vitals", { $web_vitals_LCP_value: 1_200 }],
    ] as const) {
      const callsBefore = upstreamCalls
      const response = await handlePostHogProxyRequest(
        ingestRequest(makeEvent({ event }, properties)),
        fetcher
      )

      expect(response.status).toBe(200)
      expect(upstreamCalls).toBe(callsBefore + 1)
    }

    const callsAfterValidEvents = upstreamCalls

    for (const properties of [
      {
        app: "merchant",
        page_url: "https://sell.conduit.market/products/:productId",
      },
      {
        app: "merchant",
        page_url: "https://shop.conduit.market/products/:productId",
      },
      {
        app: "market",
        page_url: "https://sell.conduit.market/products/:productId",
      },
      {
        page_path: "/cart",
        page_url: "https://shop.conduit.market/products/:productId",
      },
      {
        $current_url: "https://sell.conduit.market/products/:productId",
      },
      { $pathname: "/cart" },
    ]) {
      const response = await handlePostHogProxyRequest(
        ingestRequest(makeBrowserTelemetryEvent("app_load_result", properties)),
        fetcher
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: "dropped" })
    }

    for (const [origin, properties] of [
      [
        "https://shop.conduit.market",
        {
          app: "market",
          page_url: "https://conduit-market-coo.pages.dev/products/:productId",
        },
      ],
      [
        "https://branch-a.conduit-market-coo.pages.dev",
        {
          app: "market",
          page_url:
            "https://branch-b.conduit-market-coo.pages.dev/products/:productId",
        },
      ],
      [
        "https://branch.conduit-market-coo.pages.dev",
        {
          app: "merchant",
          page_url:
            "https://branch.conduit-merchant-33n.pages.dev/products/:productId",
        },
      ],
    ] as const) {
      const response = await handlePostHogProxyRequest(
        ingestRequest(
          makeBrowserTelemetryEvent("app_load_result", properties),
          origin
        ),
        fetcher
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: "dropped" })
    }

    for (const event of [
      makeEvent({ event: "$pageleave" }, { $prev_pageview_pathname: "/cart" }),
      makeBrowserTelemetryEvent("product_publish_result", {
        app: "market",
        page_url: "https://shop.conduit.market/products/:productId",
      }),
      makeBrowserTelemetryEvent("cart_add", {
        app: "merchant",
        page_url: "https://sell.conduit.market/products/:productId",
      }),
    ]) {
      const origin =
        (event.properties as Record<string, unknown>).app === "merchant"
          ? "https://sell.conduit.market"
          : "https://shop.conduit.market"
      const response = await handlePostHogProxyRequest(
        ingestRequest(event, origin),
        fetcher
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: "dropped" })
    }

    expect(upstreamCalls).toBe(callsAfterValidEvents)
  })

  it("requires every custom browser event contract", () => {
    expect(Object.keys(validBrowserEventProperties)).toEqual([
      ...browserTelemetryEventNames,
    ])

    for (const eventName of browserTelemetryEventNames) {
      const originContext =
        validBrowserEventProperties[eventName].app === "merchant"
          ? MERCHANT_ORIGIN_CONTEXT
          : MARKET_ORIGIN_CONTEXT
      const valid = rebuildPostHogIngestPayload(
        encode(makeBrowserTelemetryEvent(eventName)),
        originContext
      )
      expect(valid.ok).toBe(true)
      if (valid.ok) expect(valid.events).toHaveLength(1)

      const requiredProperties = [
        "event_name",
        "app",
        "page_url",
        "page_path",
        ...browserTelemetryEventPropertyContracts[eventName].required,
      ]
      for (const requiredProperty of requiredProperties) {
        const incomplete = makeBrowserTelemetryEvent(eventName)
        delete (incomplete.properties as Record<string, unknown>)[
          requiredProperty
        ]
        const rebuilt = rebuildPostHogIngestPayload(
          encode(incomplete),
          originContext
        )

        expect(rebuilt.ok).toBe(true)
        if (rebuilt.ok) expect(rebuilt.events).toHaveLength(0)
      }
    }

    const unrelatedProperty = rebuildPostHogIngestPayload(
      encode(makeBrowserTelemetryEvent("checkout_result", { action: "add" }))
    )
    expect(unrelatedProperty.ok).toBe(true)
    if (unrelatedProperty.ok) expect(unrelatedProperty.events).toHaveLength(0)
  })

  it("requires app and route context for provider lifecycle events", () => {
    for (const event of ["$pageview", "$pageleave", "$web_vitals"]) {
      const eventProperties =
        event === "$web_vitals" ? { $web_vitals_LCP_value: 1_200 } : {}
      const valid = rebuildPostHogIngestPayload(
        encode(makeEvent({ event }, eventProperties))
      )
      expect(valid.ok).toBe(true)
      if (valid.ok) expect(valid.events).toHaveLength(1)

      for (const requiredProperty of ["app", "page_url", "page_path"]) {
        const incomplete = makeEvent({ event }, eventProperties)
        delete (incomplete.properties as Record<string, unknown>)[
          requiredProperty
        ]
        const rebuilt = rebuildPostHogIngestPayload(encode(incomplete))

        expect(rebuilt.ok).toBe(true)
        if (rebuilt.ok) expect(rebuilt.events).toHaveLength(0)
      }
    }

    for (const [event, missingProperty] of [
      ["$pageview", "$session_id"],
      ["$pageview", "$pageview_id"],
      ["$pageleave", "$session_id"],
      ["$web_vitals", "$session_id"],
    ] as const) {
      const properties =
        event === "$web_vitals" ? { $web_vitals_LCP_value: 1_200 } : {}
      const incomplete = makeEvent({ event }, properties)
      delete (incomplete.properties as Record<string, unknown>)[missingProperty]
      const rebuilt = rebuildPostHogIngestPayload(encode(incomplete))

      expect(rebuilt.ok).toBe(true)
      if (rebuilt.ok) expect(rebuilt.events).toHaveLength(0)
    }

    const metriclessWebVitals = rebuildPostHogIngestPayload(
      encode(makeEvent({ event: "$web_vitals" }))
    )
    expect(metriclessWebVitals.ok).toBe(true)
    if (metriclessWebVitals.ok) {
      expect(metriclessWebVitals.events).toHaveLength(0)
    }
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

  it("rejects identifiers and free text hidden under allowlisted label keys", () => {
    for (const sensitiveValue of [
      "a".repeat(64),
      "0198f4a0-1111-4abc-8def-0123456789ab",
      `npub1${"q".repeat(58)}`,
      `nsec1${"q".repeat(58)}`,
      "5551234567",
      "private_token_1234567890",
    ]) {
      const rebuilt = rebuildPostHogIngestPayload(
        encode(
          makeBrowserTelemetryEvent("checkout_result", {
            status: sensitiveValue,
          })
        )
      )

      expect(rebuilt.ok).toBe(true)
      if (rebuilt.ok) expect(rebuilt.events).toHaveLength(0)
    }

    for (const properties of [
      { status: true },
      { count: "1" },
      { time_bucket: "hour_13" },
      { event_name: "cart_add", status: "success" },
    ]) {
      const rebuilt = rebuildPostHogIngestPayload(
        encode(makeBrowserTelemetryEvent("checkout_result", properties))
      )

      expect(rebuilt.ok).toBe(true)
      if (rebuilt.ok) expect(rebuilt.events).toHaveLength(0)
    }
  })

  it("accepts only canonical ISO event timestamps", () => {
    const canonicalTimestamp = "2026-08-20T17:00:00.000Z"
    const canonical = rebuildPostHogIngestPayload(
      encode(makeEvent({ timestamp: canonicalTimestamp }))
    )

    expect(canonical.ok).toBe(true)
    if (canonical.ok) {
      expect(canonical.events[0]?.timestamp).toBe(canonicalTimestamp)
    }

    for (const timestamp of [
      "2026-08-20T17:00:00Z",
      "Thu, 01 Jan 1970 00:00:00 GMT (secret)",
    ]) {
      const rebuilt = rebuildPostHogIngestPayload(
        encode(makeEvent({ timestamp }))
      )

      expect(rebuilt.ok).toBe(true)
      if (rebuilt.ok) expect(rebuilt.events).toHaveLength(0)
    }
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

    for (const noncanonicalUrl of [
      "https://shop.conduit.market/private-order/../products",
      "https://shop.conduit.market/private-order/%2e%2e/products",
    ]) {
      const dotSegmentLeak = rebuildPostHogIngestPayload(
        encode(
          makeEvent({}, { page_path: "/products", page_url: noncanonicalUrl })
        )
      )

      expect(dotSegmentLeak.ok).toBe(true)
      if (dotSegmentLeak.ok) expect(dotSegmentLeak.events).toHaveLength(0)
    }
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
