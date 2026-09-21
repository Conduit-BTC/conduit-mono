import {
  browserTelemetryEventNames,
  browserTelemetryPropertyNames,
  getOfficialProductTelemetryApp,
  hasRequiredBrowserTelemetryEventProperties,
  isAllowedBrowserTelemetryEventProperty,
  isAllowedBrowserTelemetryLabelValue,
} from "@conduit/core/telemetry-contract"
import type { BrowserTelemetryApp } from "@conduit/core/telemetry-contract"
import {
  decodeProductReference,
  encodeProductNaddr,
} from "@conduit/core/protocol/product-reference"

import {
  GMV_DEDUPE_RETENTION_DAYS,
  MAX_ESTIMATED_GMV_SATS,
  type CommerceGmvCutoverResolution,
  type CommerceGmvDailyObservationResult,
} from "./commerce-gmv-contract"
import type { PostHogProxyEnv } from "./env"

export type { PostHogProxyEnv } from "./env"

const POSTHOG_INGEST_ORIGIN = "https://us.i.posthog.com"
const MAX_INGEST_BODY_BYTES = 1024 * 1024
const MAX_GMV_BODY_BYTES = 512
const POSTHOG_ANONYMOUS_DISTINCT_ID = "conduit-browser-telemetry"
const POSTHOG_GMV_DISTINCT_ID = "conduit-commerce-gmv-estimate"
const POSTHOG_PROJECT_TOKEN_PATTERN = /^phc_[A-Za-z0-9]{16,64}$/
const MAX_EVENTS_PER_REQUEST = 100
const GMV_PATH = "/gmv"
const GMV_EVENT_NAME = "commerce_gmv_estimated"
const GMV_EVENT_ID_DOMAIN = "conduit-commerce-gmv-estimate.order.v1"
const GMV_DAILY_ORDER_ID_DOMAIN = "conduit-commerce-gmv-estimate.daily-order.v1"
const GMV_DAILY_EVENT_ID_DOMAIN = "conduit-commerce-gmv-estimate.daily-event.v1"
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const orderIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const utcOrderDatePattern = /^\d{4}-\d{2}-\d{2}$/

function isCanonicalUtcOrderDate(value: string): boolean {
  if (!utcOrderDatePattern.test(value)) return false
  const epochMilliseconds = Date.parse(`${value}T00:00:00.000Z`)
  return (
    Number.isFinite(epochMilliseconds) &&
    new Date(epochMilliseconds).toISOString().slice(0, 10) === value
  )
}

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
const productNaddrPathPattern =
  /^\/products\/naddr1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{74,481}$/
const MAX_SANITIZED_ROUTE_PATH_LENGTH = 512
const MAX_SANITIZED_PAGE_URL_LENGTH = 640

function isCanonicalProductNaddrPath(value: string): boolean {
  if (!productNaddrPathPattern.test(value)) return false

  const naddr = value.slice("/products/".length)
  try {
    const reference = decodeProductReference(naddr)
    return !!reference && encodeProductNaddr(reference.addressId) === naddr
  } catch {
    return false
  }
}

export type PostHogProxyFetcher = (request: Request) => Promise<Response>

export async function handlePostHogProxyRequest(
  request: Request,
  fetcher: PostHogProxyFetcher = (upstreamRequest) => fetch(upstreamRequest),
  env: PostHogProxyEnv = {}
): Promise<Response> {
  const requestUrl = new URL(request.url)

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    const cutover = await resolveCommerceGmvCutover(env)
    if (!cutover.ok) {
      return jsonResponse({ error: "telemetry_unavailable" }, 503)
    }
    return jsonResponse({ status: "ok" }, 200)
  }

  if (requestUrl.pathname === GMV_PATH) {
    if (requestUrl.search) {
      return jsonResponse({ error: "invalid_request_url" }, 400)
    }
    return handleCommerceGmvRequest(request, fetcher, env)
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
      if (!isSanitizedPagePath(propertyValue, eventName)) return null
      rebuilt[key] = propertyValue
      continue
    }
    if (pageUrlPropertyNames.has(key)) {
      if (!isSanitizedPageUrl(propertyValue, eventName)) return null
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
      if (!isSanitizedPagePath(propertyValue, eventName)) return null
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
  if (
    typeof value !== "string" ||
    value.length > MAX_SANITIZED_ROUTE_PATH_LENGTH
  ) {
    return false
  }
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
  if (isCanonicalProductNaddrPath(value)) return true
  if (storeNpubPathPattern.test(value)) return true
  const match = /^\/([a-z]+)(\/:param)?$/.exec(value)
  return match !== null && sanitizedStaticRouteSegments.has(match[1] ?? "")
}

function isSanitizedPagePath(
  value: unknown,
  eventName: string
): value is string {
  return (
    isSanitizedTelemetryRoutePath(value) &&
    (eventName === "$pageview" || !isCanonicalProductNaddrPath(value))
  )
}

function isSanitizedPageUrl(
  value: unknown,
  eventName: string
): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_SANITIZED_PAGE_URL_LENGTH
  ) {
    return false
  }

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
  if (!isSanitizedPagePath(url.pathname, eventName)) return false
  if (value !== `${url.origin}${url.pathname}`) return false

  return getOfficialProductTelemetryApp(url.hostname) !== null
}

async function readBoundedRequestBody(
  request: Request,
  maxBytes = MAX_INGEST_BODY_BYTES
): Promise<ArrayBuffer | null> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
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
    if (totalBytes > maxBytes) {
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

type CommerceGmvEstimate = {
  orderId: string
  orderDate: string
  invoicedAmountSats: number
}

function parseCommerceGmvEstimate(
  body: ArrayBuffer
): CommerceGmvEstimate | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
  } catch {
    return null
  }
  if (!isPlainObject(value)) return null
  const keys = Object.keys(value).sort()
  if (
    keys.length !== 3 ||
    keys[0] !== "invoicedAmountSats" ||
    keys[1] !== "orderDate" ||
    keys[2] !== "orderId" ||
    typeof value.orderId !== "string" ||
    !orderIdPattern.test(value.orderId) ||
    typeof value.orderDate !== "string" ||
    !isCanonicalUtcOrderDate(value.orderDate) ||
    !Number.isSafeInteger(value.invoicedAmountSats) ||
    (value.invoicedAmountSats as number) <= 0 ||
    (value.invoicedAmountSats as number) > MAX_ESTIMATED_GMV_SATS
  ) {
    return null
  }
  return {
    orderId: value.orderId.toLowerCase(),
    orderDate: value.orderDate,
    invoicedAmountSats: value.invoicedAmountSats as number,
  }
}

function bytesToUuid(bytes: Uint8Array): string {
  const value = bytes.slice(0, 16)
  value[6] = (value[6]! & 0x0f) | 0x50
  value[8] = (value[8]! & 0x3f) | 0x80
  const hex = Array.from(value, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function getOpaqueCommerceUuid(
  value: string,
  secret: string,
  domain: string
): Promise<string | null> {
  if (secret.trim().length < 32) return null
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${domain}:${value}`)
  )
  return bytesToUuid(new Uint8Array(digest))
}

export type CommerceGmvDeliveryMode =
  "daily" | "expired" | "invalid" | "legacy" | "unavailable"

export function getCommerceGmvDeliveryMode(
  orderDate: string,
  cutoverDate: string | undefined,
  now = Date.now()
): CommerceGmvDeliveryMode {
  const orderDayStart = Date.parse(`${orderDate}T00:00:00.000Z`)
  const today = new Date(now).toISOString().slice(0, 10)
  const todayStart = Date.parse(`${today}T00:00:00.000Z`)
  if (!Number.isFinite(orderDayStart) || orderDayStart > todayStart) {
    return "invalid"
  }

  const normalizedCutoverDate = cutoverDate?.trim() ?? ""
  if (!normalizedCutoverDate) return "legacy"
  if (!isCanonicalUtcOrderDate(normalizedCutoverDate)) {
    return "unavailable"
  }

  const ageDays = Math.floor(
    (todayStart - orderDayStart) / MILLISECONDS_PER_DAY
  )
  if (ageDays > GMV_DEDUPE_RETENTION_DAYS) return "expired"
  return orderDate >= normalizedCutoverDate ? "daily" : "legacy"
}

type ResolvedCommerceGmvCutover =
  { ok: true; cutoverDate: string | undefined } | { ok: false }

async function resolveCommerceGmvCutover(
  env: PostHogProxyEnv
): Promise<ResolvedCommerceGmvCutover> {
  const configuredCutoverDate =
    env.COMMERCE_GMV_DAILY_CUTOVER_DATE?.trim() ?? ""
  if (
    configuredCutoverDate &&
    !isCanonicalUtcOrderDate(configuredCutoverDate)
  ) {
    return { ok: false }
  }

  const fence = env.GMV_CUTOVER_FENCE
  if (!fence) return { ok: false }

  let resolution: CommerceGmvCutoverResolution
  try {
    resolution = await fence
      .getByName("commerce-gmv-cutover")
      .resolve(configuredCutoverDate || null)
  } catch {
    return { ok: false }
  }

  if (resolution.status === "invalid" || resolution.status === "mismatch") {
    return { ok: false }
  }
  return {
    ok: true,
    cutoverDate:
      resolution.status === "active" ? resolution.cutoverDate : undefined,
  }
}

async function handleCommerceGmvRequest(
  request: Request,
  fetcher: PostHogProxyFetcher,
  env: PostHogProxyEnv
): Promise<Response> {
  const originContext = getAllowedOriginContext(request.headers.get("origin"))
  if (!originContext) return jsonResponse({ error: "origin_not_allowed" }, 403)
  const { origin } = originContext

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) })
  }
  if (request.method !== "POST") {
    return corsJsonResponse({ error: "method_not_allowed" }, 405, origin)
  }
  if (request.headers.get("content-encoding")) {
    return corsJsonResponse({ error: "unsupported_encoding" }, 415, origin)
  }
  if (!env.GMV_GLOBAL_RATE_LIMITER || !env.GMV_ORDER_RATE_LIMITER) {
    return corsJsonResponse({ error: "telemetry_unavailable" }, 503, origin)
  }

  let body: ArrayBuffer | null
  try {
    body = await readBoundedRequestBody(request, MAX_GMV_BODY_BYTES)
  } catch {
    return corsJsonResponse({ error: "invalid_request_body" }, 400, origin)
  }
  if (!body) {
    return corsJsonResponse({ error: "payload_too_large" }, 413, origin)
  }
  const estimate = parseCommerceGmvEstimate(body)
  if (!estimate) {
    return corsJsonResponse({ error: "invalid_payload" }, 400, origin)
  }

  const cutover = await resolveCommerceGmvCutover(env)
  if (!cutover.ok) {
    return corsJsonResponse({ error: "telemetry_unavailable" }, 503, origin)
  }

  const deliveryMode = getCommerceGmvDeliveryMode(
    estimate.orderDate,
    cutover.cutoverDate
  )
  if (deliveryMode === "invalid") {
    return corsJsonResponse({ error: "invalid_payload" }, 400, origin)
  }
  if (deliveryMode === "unavailable") {
    return corsJsonResponse({ error: "telemetry_unavailable" }, 503, origin)
  }
  if (deliveryMode === "expired") {
    return corsJsonResponse({ status: "expired" }, 200, origin)
  }

  const projectToken = env.POSTHOG_PROJECT_TOKEN?.trim() ?? ""
  const hmacSecret = env.COMMERCE_GMV_TELEMETRY_HMAC_SECRET?.trim() ?? ""
  if (
    !POSTHOG_PROJECT_TOKEN_PATTERN.test(projectToken) ||
    hmacSecret.length < 32
  ) {
    return corsJsonResponse({ error: "telemetry_unavailable" }, 503, origin)
  }

  const opaqueOrderUuid = await getOpaqueCommerceUuid(
    deliveryMode === "daily"
      ? `${estimate.orderDate}:${estimate.orderId}`
      : estimate.orderId,
    hmacSecret,
    deliveryMode === "daily" ? GMV_DAILY_ORDER_ID_DOMAIN : GMV_EVENT_ID_DOMAIN
  )
  if (!opaqueOrderUuid) {
    return corsJsonResponse({ error: "telemetry_unavailable" }, 503, origin)
  }
  const [globalLimit, orderLimit] = await Promise.all([
    env.GMV_GLOBAL_RATE_LIMITER.limit({ key: "commerce-gmv" }),
    env.GMV_ORDER_RATE_LIMITER.limit({ key: opaqueOrderUuid }),
  ])
  if (!globalLimit.success || !orderLimit.success) {
    return corsJsonResponse({ error: "rate_limited" }, 429, origin)
  }

  if (deliveryMode === "daily") {
    const dailyAggregate = env.GMV_DAILY_AGGREGATE
    if (!dailyAggregate) {
      return corsJsonResponse({ error: "telemetry_unavailable" }, 503, origin)
    }
    const dailyEventUuid = await getOpaqueCommerceUuid(
      estimate.orderDate,
      hmacSecret,
      GMV_DAILY_EVENT_ID_DOMAIN
    )
    if (!dailyEventUuid) {
      return corsJsonResponse({ error: "telemetry_unavailable" }, 503, origin)
    }

    let result: CommerceGmvDailyObservationResult
    try {
      result = await dailyAggregate
        .getByName(`commerce-gmv:${estimate.orderDate}`)
        .observe({
          orderDay: estimate.orderDate,
          opaqueOrderKey: opaqueOrderUuid,
          dailyEventUuid,
          estimatedGmvSats: estimate.invoicedAmountSats,
        })
    } catch {
      return corsJsonResponse({ error: "telemetry_unavailable" }, 503, origin)
    }
    return corsJsonResponse({ status: result.status }, 202, origin)
  }

  const timestamp = `${estimate.orderDate}T00:00:00.000Z`
  const upstreamBody = JSON.stringify({
    api_key: projectToken,
    event: GMV_EVENT_NAME,
    distinct_id: POSTHOG_GMV_DISTINCT_ID,
    uuid: opaqueOrderUuid,
    timestamp,
    properties: {
      $process_person_profile: false,
      estimated_gmv_sats: estimate.invoicedAmountSats,
    },
  })

  try {
    const upstreamResponse = await fetcher(
      new Request(`${POSTHOG_INGEST_ORIGIN}/i/v0/e/?ip=0`, {
        method: "POST",
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
        body: upstreamBody,
        redirect: "manual",
      })
    )
    const headers = getCorsHeaders(origin)
    const contentType = upstreamResponse.headers.get("content-type")
    if (contentType) headers.set("content-type", contentType)
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    })
  } catch {
    return corsJsonResponse({ error: "upstream_unavailable" }, 502, origin)
  }
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
} satisfies ExportedHandler<PostHogProxyEnv>
