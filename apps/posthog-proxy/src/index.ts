const POSTHOG_INGEST_ORIGIN = "https://us.i.posthog.com"
const MAX_INGEST_BODY_BYTES = 1024 * 1024

const allowedIngestPaths = new Set([
  "/batch",
  "/batch/",
  "/e",
  "/e/",
  "/i/v0/e",
  "/i/v0/e/",
])

const allowedOriginHosts = new Set([
  "conduit-market-coo.pages.dev",
  "conduit-merchant-33n.pages.dev",
  "sell.conduit.market",
  "shop.conduit.market",
])

const allowedPreviewSuffixes = [
  "conduit-market-coo.pages.dev",
  "conduit-merchant-33n.pages.dev",
] as const

const forwardedRequestHeaders = [
  "accept",
  "content-encoding",
  "content-type",
] as const

export type PostHogProxyFetcher = (request: Request) => Promise<Response>

export async function handlePostHogProxyRequest(
  request: Request,
  fetcher: PostHogProxyFetcher = (upstreamRequest) => fetch(upstreamRequest)
): Promise<Response> {
  const requestUrl = new URL(request.url)

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    return jsonResponse({ status: "ok" }, 200)
  }

  if (!allowedIngestPaths.has(requestUrl.pathname)) {
    return jsonResponse({ error: "not_found" }, 404)
  }

  const origin = getAllowedOrigin(request.headers.get("origin"))
  if (!origin) {
    return jsonResponse({ error: "origin_not_allowed" }, 403)
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(origin),
    })
  }

  if (request.method !== "POST") {
    return corsJsonResponse({ error: "method_not_allowed" }, 405, origin)
  }

  const upstreamHeaders = new Headers()
  for (const headerName of forwardedRequestHeaders) {
    const value = request.headers.get(headerName)
    if (value) upstreamHeaders.set(headerName, value)
  }
  upstreamHeaders.set("cache-control", "no-store")

  let requestBody: ArrayBuffer | null
  try {
    requestBody = await readBoundedRequestBody(request)
  } catch {
    return corsJsonResponse({ error: "invalid_request_body" }, 400, origin)
  }
  if (!requestBody) {
    return corsJsonResponse({ error: "payload_too_large" }, 413, origin)
  }

  const upstreamUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    POSTHOG_INGEST_ORIGIN
  )

  try {
    const upstreamResponse = await fetcher(
      new Request(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: requestBody,
        redirect: "manual",
      })
    )

    const responseHeaders = getCorsHeaders(origin)
    const contentType = upstreamResponse.headers.get("content-type")
    if (contentType) responseHeaders.set("content-type", contentType)

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    })
  } catch {
    return corsJsonResponse({ error: "upstream_unavailable" }, 502, origin)
  }
}

async function readBoundedRequestBody(
  request: Request
): Promise<ArrayBuffer | null> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_INGEST_BODY_BYTES
  ) {
    return null
  }
  if (!request.body) return new ArrayBuffer(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_INGEST_BODY_BYTES) {
      await reader.cancel("PostHog ingest body exceeded the byte limit")
      return null
    }
    chunks.push(value)
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}

function getAllowedOrigin(rawOrigin: string | null): string | null {
  if (!rawOrigin) return null

  try {
    const origin = new URL(rawOrigin)
    if (origin.protocol !== "https:" || origin.port) return null

    const hostname = origin.hostname.toLowerCase()
    if (
      !allowedOriginHosts.has(hostname) &&
      !allowedPreviewSuffixes.some((suffix) =>
        isSingleLabelSubdomain(hostname, suffix)
      )
    ) {
      return null
    }

    return origin.origin
  } catch {
    return null
  }
}

function isSingleLabelSubdomain(hostname: string, suffix: string): boolean {
  if (!hostname.endsWith(`.${suffix}`)) return false
  const label = hostname.slice(0, -(suffix.length + 1))
  return !!label && !label.includes(".")
}

function getCorsHeaders(origin: string): Headers {
  return new Headers({
    "access-control-allow-headers": "accept, content-encoding, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": origin,
    "cache-control": "no-store",
    vary: "Origin",
  })
}

function jsonResponse(body: Record<string, string>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  })
}

function corsJsonResponse(
  body: Record<string, string>,
  status: number,
  origin: string
): Response {
  const headers = getCorsHeaders(origin)
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify(body), { status, headers })
}

export default {
  fetch(request: Request): Promise<Response> {
    return handlePostHogProxyRequest(request)
  },
}
