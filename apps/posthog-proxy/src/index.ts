import {
  browserTelemetryEventNames,
  browserTelemetryPropertyNames,
  getOfficialProductTelemetryApp,
  hasRequiredBrowserTelemetryEventProperties,
  isAllowedBrowserTelemetryEventProperty,
  isAllowedBrowserTelemetryLabelValue,
} from "@conduit/core/telemetry-contract"
import type { BrowserTelemetryApp } from "@conduit/core/telemetry-contract"

const POSTHOG_INGEST_ORIGIN = "https://us.i.posthog.com"
const MAX_INGEST_BODY_BYTES = 1024 * 1024
const POSTHOG_ANONYMOUS_DISTINCT_ID = "conduit-browser-telemetry"
const POSTHOG_PROJECT_TOKEN_PATTERN = /^phc_[A-Za-z0-9]{16,64}$/
const MAX_EVENTS_PER_REQUEST = 100

const allowedIngestPaths = new Set([
  "/batch",
  "/batch/",
  "/e",
  "/e/",
  "/i/v0/e",
  "/i/v0/e/",
])

export interface AllowedOriginContext {
  app: BrowserTelemetryApp
  origin: string
}

/**
 * Event names the browser sanitizer is allowed to emit: the shared browser
 * telemetry contract plus the PostHog session metric events the proxied
 * client emits directly.
 */
export const workerAllowedEventNames = new Set<string>([
  "$pageleave",
  "$pageview",
  "$web_vitals",
  ...browserTelemetryEventNames,
])

const browserTelemetryEventNameSet = new Set<string>(browserTelemetryEventNames)
const browserTelemetryPropertyNameSet = new Set<string>(
  browserTelemetryPropertyNames
)
const providerLifecycleRequiredPropertyNames = {
  $pageview: ["app", "page_url", "page_path", "$session_id", "$pageview_id"],
  $pageleave: ["app", "page_url", "page_path", "$session_id"],
  $web_vitals: ["app", "page_url", "page_path", "$session_id"],
} as const

/**
 * Short label properties from the documented browser telemetry allowlist:
 * the shared contract minus the page context properties, which carry
 * sanitized route URLs and use dedicated validators below.
 */
export const workerLabelPropertyNames = new Set<string>(
  browserTelemetryPropertyNames.filter(
    (name) => name !== "page_path" && name !== "page_url"
  )
)

const pagePathPropertyNames = new Set(["page_path", "$pathname"])
const pageUrlPropertyNames = new Set(["page_url", "$current_url"])
const sessionUuidPropertyNames = new Set([
  "$session_id",
  "$pageview_id",
  "$prev_pageview_id",
])
const pageLeavePercentagePropertyNames = new Set([
  "$prev_pageview_last_content_percentage",
  "$prev_pageview_last_scroll_percentage",
  "$prev_pageview_max_content_percentage",
  "$prev_pageview_max_scroll_percentage",
])
const webVitalValuePropertyNames = new Set([
  "$web_vitals_CLS_value",
  "$web_vitals_FCP_value",
  "$web_vitals_INP_value",
  "$web_vitals_LCP_value",
])

const allowedTopLevelEventKeys = new Set([
  "event",
  "properties",
  "uuid",
  "timestamp",
  "offset",
])

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const eventUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Route classes `sanitizeTelemetryPath` in `packages/core/src/telemetry.ts`
 * can emit. Sections that sanitize to a dedicated class (`/products`,
 * `/store`, `/u`, `/orders`) are matched explicitly below, so this set holds
 * only the static sections that keep a generic `/:param` suffix class.
 */
const sanitizedStaticRouteSegments = new Set([
  "about",
  "cart",
  "checkout",
  "messages",
  "network",
  "payments",
  "profile",
  "shipping",
  "wallet",
])
const storeNpubPathPattern =
  /^\/store\/npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/

export interface PostHogProxyEnv {
  POSTHOG_PROJECT_TOKEN?: string
}

export type PostHogProxyFetcher = (request: Request) => Promise<Response>

export async function handlePostHogProxyRequest(
  request: Request,
  fetcher: PostHogProxyFetcher = (upstreamRequest) => fetch(upstreamRequest),
  env: PostHogProxyEnv = {}
): Promise<Response> {
  const requestUrl = new URL(request.url)

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    return jsonResponse({ status: "ok" }, 200)
  }

  if (!allowedIngestPaths.has(requestUrl.pathname)) {
    return jsonResponse({ error: "not_found" }, 404)
  }

  const originContext = getAllowedOriginContext(request.headers.get("origin"))
  if (!originContext) {
    return jsonResponse({ error: "origin_not_allowed" }, 403)
  }
  const { origin } = originContext

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(origin),
    })
  }

  if (request.method !== "POST") {
    return corsJsonResponse({ error: "method_not_allowed" }, 405, origin)
  }

  if (request.headers.get("content-encoding")) {
    return corsJsonResponse({ error: "unsupported_encoding" }, 415, origin)
  }

  let requestBody: ArrayBuffer | null
  try {
    requestBody = await readBoundedRequestBody(request)
  } catch {
    return corsJsonResponse({ error: "invalid_request_body" }, 400, origin)
  }
  if (!requestBody) {
    return corsJsonResponse({ error: "payload_too_large" }, 413, origin)
  }

  const rebuilt = rebuildPostHogIngestPayload(
    requestBody,
    originContext,
    env.POSTHOG_PROJECT_TOKEN
  )
  if (!rebuilt.ok) {
    return corsJsonResponse({ error: rebuilt.error }, 400, origin)
  }
  if (rebuilt.events.length === 0) {
    // Every event failed the allowlist. Per the telemetry contract these are
    // dropped, never repaired or forwarded. Report success so the client does
    // not retry the same disallowed payload.
    return corsJsonResponse({ status: "dropped" }, 200, origin)
  }

  const upstreamUrl = new URL(requestUrl.pathname, POSTHOG_INGEST_ORIGIN)
  upstreamUrl.search = "?ip=0"
  const upstreamHeaders = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json",
  })
  const upstreamBody = JSON.stringify(
    rebuilt.shape === "single" ? rebuilt.events[0] : rebuilt.events
  )

  try {
    const upstreamResponse = await fetcher(
      new Request(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: upstreamBody,
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

interface RebuiltIngestPayload {
  ok: true
  shape: "single" | "batch"
  events: Record<string, unknown>[]
}

interface RejectedIngestPayload {
  ok: false
  error: string
}

/**
 * Parse the supported PostHog browser ingest shapes (one event object or an
 * array of event objects) and rebuild a fresh payload that contains only the
 * documented telemetry allowlist. Events with unknown keys, unknown
 * properties, out-of-range values, or a wrong identity are dropped whole,
 * never repaired.
 */
export function rebuildPostHogIngestPayload(
  body: ArrayBuffer,
  originContext: AllowedOriginContext,
  pinnedToken?: string
): RebuiltIngestPayload | RejectedIngestPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
  } catch {
    return { ok: false, error: "invalid_payload" }
  }

  const shape = Array.isArray(parsed) ? "batch" : "single"
  const candidates = Array.isArray(parsed) ? parsed : [parsed]
  if (candidates.length === 0 || candidates.length > MAX_EVENTS_PER_REQUEST) {
    return { ok: false, error: "invalid_payload" }
  }

  const events: Record<string, unknown>[] = []
  for (const candidate of candidates) {
    const event = rebuildIngestEvent(candidate, pinnedToken, originContext)
    if (event) {
      events.push(event)
    }
  }

  return { ok: true, shape, events }
}

function rebuildIngestEvent(
  value: unknown,
  pinnedToken: string | undefined,
  originContext: AllowedOriginContext
): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null
  for (const key of Object.keys(value)) {
    if (!allowedTopLevelEventKeys.has(key)) return null
  }

  const eventName = value.event
  if (typeof eventName !== "string" || !workerAllowedEventNames.has(eventName))
    return null

  const properties = rebuildIngestEventProperties(
    eventName,
    value.properties,
    pinnedToken,
    originContext
  )
  if (!properties) return null

  const rebuilt: Record<string, unknown> = { event: eventName, properties }

  if (value.uuid !== undefined) {
    if (typeof value.uuid !== "string" || !eventUuidPattern.test(value.uuid)) {
      return null
    }
    rebuilt.uuid = value.uuid
  }
  if (value.timestamp !== undefined) {
    if (!isCanonicalIsoTimestamp(value.timestamp)) return null
    rebuilt.timestamp = value.timestamp
  }
  if (value.offset !== undefined) {
    if (
      typeof value.offset !== "number" ||
      !Number.isFinite(value.offset) ||
      value.offset < 0 ||
      value.offset > 86_400_000
    ) {
      return null
    }
    rebuilt.offset = value.offset
  }

  return rebuilt
}

function rebuildIngestEventProperties(
  eventName: string,
  value: unknown,
  pinnedToken: string | undefined,
  originContext: AllowedOriginContext
): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null

  const rebuilt: Record<string, unknown> = {
    $process_person_profile: false,
    distinct_id: POSTHOG_ANONYMOUS_DISTINCT_ID,
  }
  const isBrowserTelemetryEvent = browserTelemetryEventNameSet.has(eventName)

  for (const [key, propertyValue] of Object.entries(value)) {
    if (key === "distinct_id") {
      if (propertyValue !== POSTHOG_ANONYMOUS_DISTINCT_ID) return null
      continue
    }
    if (key === "$process_person_profile") {
      if (propertyValue !== false) return null
      continue
    }
    if (key === "token") {
      if (
        typeof propertyValue !== "string" ||
        !POSTHOG_PROJECT_TOKEN_PATTERN.test(propertyValue)
      ) {
        return null
      }
      if (pinnedToken && propertyValue !== pinnedToken) return null
      rebuilt.token = pinnedToken ?? propertyValue
      continue
    }
    if (
      isBrowserTelemetryEvent &&
      browserTelemetryPropertyNameSet.has(key) &&
      !isAllowedBrowserTelemetryEventProperty(eventName, key)
    ) {
      return null
    }
    if (
      !isBrowserTelemetryEvent &&
      workerLabelPropertyNames.has(key) &&
      key !== "app"
    ) {
      return null
    }
    if (workerLabelPropertyNames.has(key)) {
      if (
        typeof propertyValue !== "string" ||
        !isAllowedBrowserTelemetryLabelValue(key, propertyValue, eventName)
      ) {
        return null
      }
      rebuilt[key] = propertyValue
      continue
    }
    if (pagePathPropertyNames.has(key)) {
      if (!isSanitizedPagePath(propertyValue)) return null
      rebuilt[key] = propertyValue
      continue
    }
    if (pageUrlPropertyNames.has(key)) {
      if (!isSanitizedPageUrl(propertyValue)) return null
      rebuilt[key] = propertyValue
      continue
    }
    if (sessionUuidPropertyNames.has(key)) {
      if (
        typeof propertyValue !== "string" ||
        !uuidV7Pattern.test(propertyValue)
      ) {
        return null
      }
      rebuilt[key] = propertyValue
      continue
    }
    if (eventName === "$pageleave" && key === "$prev_pageview_pathname") {
      if (!isSanitizedPagePath(propertyValue)) return null
      rebuilt[key] = propertyValue
      continue
    }
    if (eventName === "$pageleave" && key === "$prev_pageview_duration") {
      if (!isBoundedNumber(propertyValue, 86_400)) return null
      rebuilt[key] = propertyValue
      continue
    }
    if (
      eventName === "$pageleave" &&
      pageLeavePercentagePropertyNames.has(key)
    ) {
      if (!isBoundedNumber(propertyValue, 1)) return null
      rebuilt[key] = propertyValue
      continue
    }
    if (eventName === "$web_vitals" && webVitalValuePropertyNames.has(key)) {
      if (!isBoundedNumber(propertyValue, 900_000)) return null
      rebuilt[key] = propertyValue
      continue
    }
    return null
  }

  if (typeof rebuilt.token !== "string") {
    if (!pinnedToken) return null
    rebuilt.token = pinnedToken
  }

  if (isBrowserTelemetryEvent) {
    if (!hasRequiredBrowserTelemetryEventProperties(eventName, rebuilt)) {
      return null
    }
  } else {
    const requiredProperties = (
      providerLifecycleRequiredPropertyNames as Partial<
        Record<string, readonly string[]>
      >
    )[eventName]
    if (
      !requiredProperties?.every((propertyName) =>
        Object.prototype.hasOwnProperty.call(rebuilt, propertyName)
      )
    ) {
      return null
    }
  }
  if (
    eventName === "$web_vitals" &&
    !Array.from(webVitalValuePropertyNames).some((propertyName) =>
      Object.prototype.hasOwnProperty.call(rebuilt, propertyName)
    )
  ) {
    return null
  }
  if (!hasTrustedPageContext(rebuilt, originContext)) {
    return null
  }

  return rebuilt
}

function hasTrustedPageContext(
  properties: Record<string, unknown>,
  originContext: AllowedOriginContext
): boolean {
  if (properties.app !== originContext.app) return false

  const pageUrl = properties.page_url
  const pagePath = properties.page_path
  if (typeof pageUrl !== "string" || typeof pagePath !== "string") return false

  const parsedPageUrl = new URL(pageUrl)
  if (
    parsedPageUrl.origin !== originContext.origin ||
    parsedPageUrl.pathname !== pagePath
  ) {
    return false
  }

  if (
    properties.$current_url !== undefined &&
    properties.$current_url !== pageUrl
  ) {
    return false
  }
  if (properties.$pathname !== undefined && properties.$pathname !== pagePath) {
    return false
  }
  if (
    properties.$prev_pageview_pathname !== undefined &&
    properties.$prev_pageview_pathname !== pagePath
  ) {
    return false
  }

  return true
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBoundedNumber(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
  )
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false
  const epochMilliseconds = Date.parse(value)
  return (
    Number.isFinite(epochMilliseconds) &&
    new Date(epochMilliseconds).toISOString() === value
  )
}

/**
 * Accept only the closed set of sanitized route classes the browser
 * sanitizer emits. Raw high-cardinality routes such as `/orders/12345`
 * must stay redacted and are rejected whole.
 */
export function isSanitizedTelemetryRoutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false
  if (
    value === "/" ||
    value === "/:param" ||
    value === "/products" ||
    value === "/products/:productId" ||
    value === "/store/:pubkey" ||
    value === "/u/:profileRef" ||
    value === "/orders"
  ) {
    return true
  }
  if (storeNpubPathPattern.test(value)) return true
  const match = /^\/([a-z]+)(\/:param)?$/.exec(value)
  return match !== null && sanitizedStaticRouteSegments.has(match[1] ?? "")
}

function isSanitizedPagePath(value: unknown): value is string {
  return isSanitizedTelemetryRoutePath(value)
}

function isSanitizedPageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "https:" || url.port || url.search || url.hash) {
    return false
  }
  if (url.username || url.password) return false
  if (!isSanitizedTelemetryRoutePath(url.pathname)) return false
  if (value !== `${url.origin}${url.pathname}`) return false

  return getOfficialProductTelemetryApp(url.hostname) !== null
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

function getAllowedOriginContext(
  rawOrigin: string | null
): AllowedOriginContext | null {
  if (!rawOrigin) return null

  try {
    const origin = new URL(rawOrigin)
    if (
      origin.protocol !== "https:" ||
      origin.port ||
      origin.username ||
      origin.password ||
      rawOrigin !== origin.origin
    ) {
      return null
    }

    const app = getOfficialProductTelemetryApp(origin.hostname)
    if (!app) return null

    return { app, origin: origin.origin }
  } catch {
    return null
  }
}

function getCorsHeaders(origin: string): Headers {
  return new Headers({
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "accept, content-type",
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
  fetch(request: Request, env: PostHogProxyEnv = {}): Promise<Response> {
    return handlePostHogProxyRequest(request, undefined, env)
  },
}
