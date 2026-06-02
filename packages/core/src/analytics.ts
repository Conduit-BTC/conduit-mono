import { useEffect, useRef } from "react"
import { config } from "./config"

export type ConduitAnalyticsApp = "market" | "merchant" | "store-builder"

export interface AnonymousPageviewInput {
  appId: ConduitAnalyticsApp
  pathname: string
  signerConnected: boolean
  consentGranted?: boolean
}

interface TelemetryRuntimeConfig {
  enabled: boolean
  plausibleScriptUrl: string
  posthogKey: string
  posthogHost: string
}

interface PlausibleInitOptions {
  autoCapturePageviews: boolean
  logging: boolean
}

interface PlausibleEventOptions {
  url?: string
}

type PlausibleFunction = {
  (eventName: "pageview", options?: PlausibleEventOptions): void
  init?: (options?: PlausibleInitOptions) => void
  o?: PlausibleInitOptions
  q?: unknown[][]
}

type PostHogFunctionQueue = unknown[] & {
  [key: string]: unknown
  __SV?: number
  _i?: unknown[][]
  capture?: (eventName: string, properties?: Record<string, unknown>) => void
  init?: (
    token: string,
    config?: Record<string, unknown>,
    name?: string
  ) => void
  opt_out_capturing?: () => void
  reset?: () => void
}

declare global {
  interface Window {
    plausible?: PlausibleFunction
    posthog?: PostHogFunctionQueue
  }
}

const PLAUSIBLE_SCRIPT_ID = "conduit-plausible"
const POSTHOG_SCRIPT_ID = "conduit-posthog"
const DEFAULT_PLAUSIBLE_SCRIPT_URL =
  "https://plausible.io/js/pa-iyjbME2pLQFXhfKQz6W6_.js"
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"
const POSTHOG_PAGEVIEW_EVENT = "$pageview"

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined"
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes"
}

function getTelemetryConfig(): TelemetryRuntimeConfig {
  return {
    enabled: isTruthyEnv(import.meta.env.VITE_ENABLE_TELEMETRY),
    plausibleScriptUrl:
      import.meta.env.VITE_PLAUSIBLE_SCRIPT_URL || DEFAULT_PLAUSIBLE_SCRIPT_URL,
    posthogKey: import.meta.env.VITE_POSTHOG_KEY || "",
    posthogHost: import.meta.env.VITE_POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
  }
}

export function sanitizeAnalyticsPath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || "/"
  const normalized = path.startsWith("/") ? path : `/${path}`
  const segments = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponentSafe(segment))

  if (segments.length === 0) return "/"

  if (segments[0] === "products" && segments.length > 1) {
    return ["", "products", sanitizeProductSegment(segments[1])]
      .concat(segments.slice(2).map(() => ":segment"))
      .join("/")
  }

  if (segments[0] === "orders" && segments.length > 1) {
    return ["", "orders", ":orderId"].join("/")
  }

  if (segments[0] === "store" && segments.length > 1) {
    return ["", "store", ":pubkey"].join("/")
  }

  if (segments[0] === "u" && segments.length > 1) {
    return ["", "u", ":profileRef"].join("/")
  }

  return `/${segments.map(sanitizeUnknownSegment).join("/")}`
}

export function canCaptureAnonymousTelemetry(
  signerConnected: boolean,
  consentGranted = false
): boolean {
  return !signerConnected || consentGranted
}

export function useAnonymousPageviewTelemetry({
  appId,
  pathname,
  signerConnected,
  consentGranted = false,
}: AnonymousPageviewInput): void {
  const lastPageviewRef = useRef<string | null>(null)

  useEffect(() => {
    if (!canCaptureAnonymousTelemetry(signerConnected, consentGranted)) return

    const route = sanitizeAnalyticsPath(pathname)
    const mode = signerConnected ? "connected-consented" : "anonymous"
    const pageviewKey = `${appId}:${route}:${mode}`
    if (lastPageviewRef.current === pageviewKey) return

    lastPageviewRef.current = pageviewKey
    captureAnonymousPageview({ appId, route, mode })
  }, [appId, pathname, signerConnected, consentGranted])
}

function captureAnonymousPageview({
  appId,
  route,
  mode,
}: {
  appId: ConduitAnalyticsApp
  route: string
  mode: "anonymous" | "connected-consented"
}): void {
  if (!isBrowser()) return

  const runtimeConfig = getTelemetryConfig()
  if (!runtimeConfig.enabled) return

  const url = buildAnalyticsUrl(route)
  capturePlausiblePageview(runtimeConfig, url)
  capturePostHogPageview(runtimeConfig, {
    app: appId,
    distinct_id: "anonymous",
    network: config.lightningNetwork,
    route,
    telemetry_mode: mode,
    $current_url: url,
    $pathname: route,
  })
}

function capturePlausiblePageview(
  runtimeConfig: TelemetryRuntimeConfig,
  url: string
): void {
  if (!ensurePlausible(runtimeConfig)) return

  window.plausible?.("pageview", { url })
}

function capturePostHogPageview(
  runtimeConfig: TelemetryRuntimeConfig,
  properties: Record<string, unknown>
): void {
  if (!runtimeConfig.posthogKey) return
  if (!ensurePostHog(runtimeConfig)) return

  window.posthog?.capture?.(POSTHOG_PAGEVIEW_EVENT, properties)
}

function ensurePlausible(runtimeConfig: TelemetryRuntimeConfig): boolean {
  if (!isBrowser()) return false

  window.plausible =
    window.plausible ||
    function plausibleShim(eventName, options) {
      const plausible = window.plausible
      if (!plausible) return
      plausible.q = plausible.q || []
      plausible.q.push([eventName, options])
    }

  if (!window.plausible.o) {
    window.plausible.init =
      window.plausible.init ||
      function initPlausible(options) {
        const plausible = window.plausible
        if (!plausible) return
        plausible.o = options
      }

    window.plausible.init({
      autoCapturePageviews: false,
      logging: false,
    })
  }

  if (!document.getElementById(PLAUSIBLE_SCRIPT_ID)) {
    const script = document.createElement("script")
    script.id = PLAUSIBLE_SCRIPT_ID
    script.async = true
    script.src = runtimeConfig.plausibleScriptUrl
    document.head.appendChild(script)
  }

  return true
}

function ensurePostHog(runtimeConfig: TelemetryRuntimeConfig): boolean {
  if (!isBrowser()) return false

  installPostHogSnippet()

  if (!document.getElementById(POSTHOG_SCRIPT_ID)) {
    const script = document.querySelector<HTMLScriptElement>(
      `script[src="${getPostHogAssetUrl(runtimeConfig.posthogHost)}"]`
    )
    if (script) {
      script.id = POSTHOG_SCRIPT_ID
    }
  }

  const posthog = window.posthog
  if (!posthog?.init || posthog._i?.length) return !!posthog?.capture

  posthog.init(runtimeConfig.posthogKey, {
    api_host: runtimeConfig.posthogHost,
    autocapture: false,
    bootstrap: {
      distinctID: "anonymous",
      isIdentifiedID: false,
    },
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    cross_subdomain_cookie: false,
    defaults: "2026-01-30",
    disable_persistence: true,
    disable_session_recording: true,
    disable_surveys: true,
    enable_heatmaps: false,
    enable_recording_console_log: false,
    mask_all_element_attributes: true,
    mask_all_text: true,
    opt_out_persistence_by_default: true,
    person_profiles: "identified_only",
    persistence: "memory",
    property_denylist: [
      "pubkey",
      "npub",
      "nsec",
      "invoice",
      "payment_request",
      "bolt11",
      "address",
      "email",
      "phone",
      "order_id",
      "product_id",
      "merchant_pubkey",
      "buyer_pubkey",
      "message",
    ],
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    before_send: scrubPostHogEvent,
  })

  return true
}

function installPostHogSnippet(): void {
  if (!isBrowser()) return
  if (window.posthog?.__SV) return

  const posthog = (window.posthog = window.posthog || createPostHogQueue())
  posthog._i = []

  posthog.init = function initPostHog(
    token: string,
    config: Record<string, unknown> = {},
    name?: string
  ) {
    const target = name
      ? ((posthog[name] = createPostHogQueue()) as PostHogFunctionQueue)
      : posthog
    target.people = target.people || []
    target.toString = function toString() {
      return name ? `posthog.${name}` : "posthog"
    }

    for (const method of getPostHogMethods()) {
      definePostHogQueueMethod(target, method)
    }

    posthog._i?.push([token, config || {}, name || "posthog"])

    const script = document.createElement("script")
    script.type = "text/javascript"
    script.crossOrigin = "anonymous"
    script.async = true
    script.id = POSTHOG_SCRIPT_ID
    script.src = getPostHogAssetUrl(
      String(config.api_host || DEFAULT_POSTHOG_HOST)
    )
    document.head.appendChild(script)
  }

  posthog.__SV = 1
}

function getPostHogMethods(): string[] {
  return [
    "capture",
    "captureException",
    "clear_opt_in_out_capturing",
    "createPersonProfile",
    "debug",
    "get_distinct_id",
    "has_opted_in_capturing",
    "has_opted_out_capturing",
    "identify",
    "init",
    "opt_in_capturing",
    "opt_out_capturing",
    "reset",
    "set_config",
  ]
}

function definePostHogQueueMethod(
  target: PostHogFunctionQueue,
  method: string
): void {
  target[method] = function queuePostHogMethod(...args: unknown[]) {
    target.push([method, ...args])
  }
}

function scrubPostHogEvent(event: unknown): unknown {
  if (!isRecord(event)) return event
  if (event.event !== POSTHOG_PAGEVIEW_EVENT) return null
  if (!isRecord(event.properties)) return event

  const properties = pickAllowedProperties(event.properties, [
    "$current_url",
    "$pathname",
    "app",
    "distinct_id",
    "network",
    "route",
    "telemetry_mode",
  ])
  properties.distinct_id = "anonymous"
  event.properties = properties
  return event
}

function createPostHogQueue(): PostHogFunctionQueue {
  return [] as unknown as PostHogFunctionQueue
}

function pickAllowedProperties(
  properties: Record<string, unknown>,
  allowedKeys: string[]
): Record<string, unknown> {
  const allowed = new Set(allowedKeys)
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.has(key)) continue
    if (typeof value === "string" || typeof value === "boolean") {
      result[key] = value
    }
  }

  return result
}

function getPostHogAssetUrl(apiHost: string): string {
  return `${apiHost.replace(".i.posthog.com", "-assets.i.posthog.com")}/static/array.js`
}

function buildAnalyticsUrl(route: string): string {
  const origin = window.location.origin || "https://conduit.market"
  return `${origin}${route}`
}

function sanitizeProductSegment(segment: string): string {
  return segment === "new" ? "new" : ":productId"
}

function sanitizeUnknownSegment(segment: string): string {
  if (
    segment.length >= 16 ||
    /^[a-f0-9]{12,}$/i.test(segment) ||
    /^(npub|nprofile|note|nevent|naddr|nsec)1/i.test(segment)
  ) {
    return ":id"
  }

  return segment
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
