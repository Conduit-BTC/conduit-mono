import { createHash } from "node:crypto"
import { type Page } from "@playwright/test"

export interface InterceptedBlossomState {
  putCount: number
  peakInFlight: number
  originalBodyObserved: boolean
  metadataSentinelObserved: boolean
  resourceRequestCount: number
  redirectTargetRequests: number
  requestHashes: string[]
  resourceUrls: string[]
}

export interface InterceptBlossomOptions {
  abortFirstOnce?: boolean
  failSecondOnce?: boolean
  rejectFirstStatus?: number
  originalHashes?: ReadonlySet<string>
  metadataSentinel?: string
  resourcePathPrefix?: string
  resourceRedirectUrl?: string
  resourceRedirectProxyUrl?: string
}

export async function interceptBlossom(
  page: Page,
  serverUrl: string,
  options: InterceptBlossomOptions = {}
): Promise<InterceptedBlossomState> {
  const state: InterceptedBlossomState = {
    putCount: 0,
    peakInFlight: 0,
    originalBodyObserved: false,
    metadataSentinelObserved: false,
    resourceRequestCount: 0,
    redirectTargetRequests: 0,
    requestHashes: [],
    resourceUrls: [],
  }
  const resources = new Map<string, { body: Buffer; type: string }>()
  const resourcePathPrefix = options.resourcePathPrefix
    ?.replace(/^\/+|\/+$/gu, "")
    .trim()
  const resourceRoot = resourcePathPrefix
    ? `https://cdn.conduit.market/${resourcePathPrefix}`
    : "https://cdn.conduit.market"
  let inFlight = 0

  await page.addInitScript((targetServer) => {
    const browserWindow = window as unknown as {
      __conduitPreparedUploadBodies?: Record<string, number[]>
    }
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (
        url.startsWith(`${targetServer}/`) &&
        init?.method === "PUT" &&
        init.body instanceof Blob
      ) {
        const hash = new Headers(init.headers).get("x-sha-256")
        if (hash) {
          const bytes = new Uint8Array(await init.body.arrayBuffer())
          browserWindow.__conduitPreparedUploadBodies ??= {}
          browserWindow.__conduitPreparedUploadBodies[hash] = Array.from(bytes)
        }
      }
      return originalFetch(input, init)
    }
  }, serverUrl)

  if (options.resourceRedirectUrl) {
    await page.route(options.resourceRedirectUrl, async (route) => {
      state.redirectTargetRequests += 1
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        headers: { "access-control-allow-origin": "*" },
        body: Buffer.from([1, 2, 3, 4]),
      })
    })
  }

  await page.route(`${serverUrl}/**`, async (route) => {
    const request = route.request()
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "PUT, OPTIONS",
          "access-control-allow-headers":
            "authorization, content-type, x-sha-256",
        },
      })
      return
    }
    if (request.method() !== "PUT") {
      await route.fulfill({ status: 405 })
      return
    }
    state.putCount += 1
    const requestedHash = request.headers()["x-sha-256"]
    if (requestedHash) state.requestHashes.push(requestedHash)
    inFlight += 1
    state.peakInFlight = Math.max(state.peakInFlight, inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 40))
      if (options.rejectFirstStatus && state.putCount === 1) {
        await route.fulfill({
          status: options.rejectFirstStatus,
          headers: { "access-control-allow-origin": "*" },
        })
        return
      }
      if (options.abortFirstOnce && state.putCount === 1) {
        await route.abort("timedout")
        return
      }
      if (options.failSecondOnce && state.putCount === 2) {
        await route.fulfill({
          status: 429,
          headers: { "access-control-allow-origin": "*" },
        })
        return
      }
      let body = request.postDataBuffer()
      if (!body) {
        const expectedHash = request.headers()["x-sha-256"]
        const captured = expectedHash
          ? await page.evaluate((hash) => {
              const browserWindow = window as unknown as {
                __conduitPreparedUploadBodies?: Record<string, number[]>
              }
              return browserWindow.__conduitPreparedUploadBodies?.[hash]
            }, expectedHash)
          : undefined
        if (captured) body = Buffer.from(captured)
      }
      if (!body) throw new Error("Expected prepared upload bytes")
      const hash = createHash("sha256").update(body).digest("hex")
      if (options.originalHashes?.has(hash)) state.originalBodyObserved = true
      if (
        options.metadataSentinel &&
        body.includes(Buffer.from(options.metadataSentinel, "utf8"))
      ) {
        state.metadataSentinelObserved = true
      }
      const type = request.headers()["content-type"] ?? "image/png"
      const resourceUrl = `${resourceRoot}/${hash}.png`
      resources.set(resourceUrl, { body, type })
      state.resourceUrls.push(resourceUrl)
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          url: resourceUrl,
          sha256: hash,
          size: body.byteLength,
          type,
          uploaded: Math.floor(Date.now() / 1_000),
        }),
      })
    } finally {
      inFlight -= 1
    }
  })

  await page.route(`${resourceRoot}/**`, async (route) => {
    const resource = resources.get(route.request().url())
    if (!resource) {
      await route.fulfill({ status: 404 })
      return
    }
    state.resourceRequestCount += 1
    if (options.resourceRedirectUrl) {
      if (!options.resourceRedirectProxyUrl) {
        throw new Error("Redirect interception requires a proxy URL")
      }
      const sourceUrl = new URL(route.request().url())
      const proxyUrl = new URL(
        `${sourceUrl.pathname}${sourceUrl.search}`,
        options.resourceRedirectProxyUrl
      )
      await route.continue({
        url: proxyUrl.href,
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: resource.type,
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(resource.body.byteLength),
      },
      body: resource.body,
    })
  })
  return state
}
