import { normalizePubkey, pubkeyToNpub } from "./utils"

export type ConduitTelemetryApp = "market" | "merchant"

export const browserTelemetryEventNames = [
  "app_load_result",
  "signer_connected",
  "signer_disconnected",
  "cart_add",
  "cart_remove",
  "cart_clear",
  "checkout_initiated",
  "checkout_step_result",
  "checkout_success",
  "relay_connect_result",
  "relay_publish_result",
  "wallet_connect_result",
  "payment_attempt_result",
  "merchant_setup_step_result",
  "product_publish_result",
  "shipping_publish_result",
  "market_browse_action",
  "product_detail_action",
] as const

export type BrowserTelemetryEventName =
  (typeof browserTelemetryEventNames)[number]

export const browserTelemetryPropertyNames = [
  "event_name",
  "app",
  "network",
  "status",
  "latency_bucket",
  "count",
  "time_bucket",
  "surface",
  "action",
  "step",
  "mode",
  "rail",
  "method",
  "event_family",
  "count_bucket",
  "result_count_bucket",
  "amount_bucket",
  "product_type",
  "page_url",
  "page_path",
] as const

export type BrowserTelemetryPropertyName =
  (typeof browserTelemetryPropertyNames)[number]

export type BrowserTelemetryEventProperties = Partial<
  Record<BrowserTelemetryPropertyName, string | boolean>
>

export interface BrowserTelemetryEnv {
  VITE_ENABLE_TELEMETRY?: string
  VITE_TELEMETRY_ALLOWED_HOSTS?: string
  VITE_PLAUSIBLE_DOMAIN?: string
  VITE_PLAUSIBLE_SRC?: string
  VITE_POSTHOG_KEY?: string
  VITE_POSTHOG_HOST?: string
}

export interface PlausibleTelemetryConfig {
  domain: string | null
  scriptSrc: string
}

export interface PostHogTelemetryConfig {
  key: string
  host: string
}

export interface BrowserTelemetryConfig {
  app: ConduitTelemetryApp
  enabled: boolean
  allowedHosts: string[]
  plausible: PlausibleTelemetryConfig | null
  posthog: PostHogTelemetryConfig | null
}

export interface TelemetryPageViewInput {
  app: ConduitTelemetryApp
  pathname: string
  origin?: string
}

export interface TelemetryEventInput {
  app: ConduitTelemetryApp
  eventName: BrowserTelemetryEventName
  properties?: BrowserTelemetryEventProperties
}

export interface PlausibleFunction {
  (
    eventName: "pageview" | BrowserTelemetryEventName,
    options?: {
      url?: string
      props?: Record<string, string | boolean>
    }
  ): void
  q?: unknown[]
  o?: PlausibleInitOptions
  init?: (options: PlausibleInitOptions) => void
}

export interface PlausibleInitOptions {
  autoCapturePageviews: false
  logging: false
}

export function applyPlausibleInitOptions(
  plausible: PlausibleFunction,
  options: PlausibleInitOptions
): void {
  plausible.o = options
}

interface PostHogClient {
  init: (key: string, config: ConduitPostHogConfig) => void
  capture: (
    eventName: "$pageview" | BrowserTelemetryEventName,
    properties: Record<string, string | boolean>
  ) => void
}

type PostHogModule = {
  default?: PostHogClient
} & Partial<PostHogClient>

export interface ConduitPostHogConfig {
  api_host: string
  autocapture: false
  capture_dead_clicks: false
  capture_pageview: false
  capture_pageleave: false
  rageclick: false
  disable_session_recording: true
  disable_surveys: true
  disable_web_experiments: true
  disable_external_dependency_loading: true
  disable_persistence: true
  persistence: "memory"
  person_profiles: "never"
  advanced_disable_flags: true
  advanced_disable_feature_flags: true
  enable_recording_console_log: false
  enable_heatmaps: false
  mask_all_text: true
  mask_all_element_attributes: true
  property_denylist: string[]
  before_send: (event: PostHogCaptureEvent) => PostHogCaptureEvent | null
}

export interface PostHogCaptureEvent {
  event?: string
  properties?: Record<string, unknown>
  [key: string]: unknown
}

declare global {
  interface Window {
    plausible?: PlausibleFunction
  }
}

const DEFAULT_PLAUSIBLE_SCRIPT_SRC = "https://plausible.io/js/script.js"
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"
const staticTelemetryRouteSegments = new Set([
  "about",
  "cart",
  "checkout",
  "messages",
  "network",
  "orders",
  "payments",
  "products",
  "profile",
  "shipping",
  "wallet",
])

export const sensitiveTelemetryPropertyNames = [
  "address",
  "content",
  "fingerprint",
  "invoice",
  "lnurl",
  "message",
  "npub",
  "nwcUri",
  "nwc_uri",
  "orderId",
  "order_id",
  "paymentHash",
  "preimage",
  "productTitle",
  "pubkey",
  "secret",
  "shippingAddress",
  "signer",
  "title",
  "userAgent",
  "wallet",
] as const

const browserTelemetryEventNameSet = new Set<string>(browserTelemetryEventNames)
const browserTelemetryPropertyNameSet = new Set<string>(
  browserTelemetryPropertyNames
)

let plausibleInitializedFor: string | null = null
let posthogInitializedFor: string | null = null
let posthogClientPromise: Promise<PostHogClient | null> | null = null

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true"
}

function getTelemetryEnv(): BrowserTelemetryEnv {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    return {
      VITE_ENABLE_TELEMETRY: import.meta.env.VITE_ENABLE_TELEMETRY,
      VITE_TELEMETRY_ALLOWED_HOSTS: import.meta.env
        .VITE_TELEMETRY_ALLOWED_HOSTS,
      VITE_PLAUSIBLE_DOMAIN: import.meta.env.VITE_PLAUSIBLE_DOMAIN,
      VITE_PLAUSIBLE_SRC: import.meta.env.VITE_PLAUSIBLE_SRC,
      VITE_POSTHOG_KEY: import.meta.env.VITE_POSTHOG_KEY,
      VITE_POSTHOG_HOST: import.meta.env.VITE_POSTHOG_HOST,
    }
  }
  return {}
}

export function resolveBrowserTelemetryConfig(
  app: ConduitTelemetryApp,
  env: BrowserTelemetryEnv = getTelemetryEnv()
): BrowserTelemetryConfig {
  const enabled = isEnabled(env.VITE_ENABLE_TELEMETRY)
  const plausibleScriptSrc = clean(env.VITE_PLAUSIBLE_SRC)
  const plausibleDomain = clean(env.VITE_PLAUSIBLE_DOMAIN)
  const posthogKey = clean(env.VITE_POSTHOG_KEY)

  return {
    app,
    enabled,
    allowedHosts: parseAllowedTelemetryHosts(env.VITE_TELEMETRY_ALLOWED_HOSTS),
    plausible:
      enabled && (plausibleDomain || plausibleScriptSrc)
        ? {
            domain: plausibleDomain,
            scriptSrc: plausibleScriptSrc ?? DEFAULT_PLAUSIBLE_SCRIPT_SRC,
          }
        : null,
    posthog:
      enabled && posthogKey
        ? {
            key: posthogKey,
            host: clean(env.VITE_POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST,
          }
        : null,
  }
}

export function sanitizeTelemetryPath(pathname: string): string {
  let parsedPathname: string
  try {
    // Relative paths need an absolute base for URL parsing; `.invalid` is a
    // reserved non-routable TLD and is never emitted to analytics providers.
    parsedPathname = new URL(pathname, "https://conduit.invalid").pathname
  } catch {
    parsedPathname = pathname.split("?")[0]?.split("#")[0] ?? "/"
  }

  const segments = parsedPathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)

  if (segments.length === 0) return "/"

  const [section] = segments
  if (section === "products") {
    return segments.length > 1 ? "/products/:productId" : "/products"
  }
  if (section === "store") return getStoreTelemetryPath(segments[1])
  if (section === "u") return "/u/:profileRef"
  if (section === "orders") return "/orders"

  if (!staticTelemetryRouteSegments.has(section)) return "/:param"
  if (segments.length === 1) return `/${section}`
  return `/${section}/:param`
}

function getStoreTelemetryPath(storeRef: string | undefined): string {
  const pubkey = normalizePubkey(storeRef)
  if (!pubkey) return "/store/:pubkey"
  return `/store/${pubkeyToNpub(pubkey)}`
}

export function buildTelemetryPageUrl(input: {
  origin: string
  pathname: string
}): string {
  const sanitizedPath = sanitizeTelemetryPath(input.pathname)
  const trimmedOrigin = input.origin.replace(/\/+$/, "")
  return `${trimmedOrigin}${sanitizedPath}`
}

export function getTelemetryCountBucket(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0"
  if (count === 1) return "1"
  if (count <= 3) return "2_3"
  if (count <= 10) return "4_10"
  return "11_plus"
}

export function getTelemetryAmountBucket(
  sats: number | null | undefined
): string {
  if (!Number.isFinite(sats ?? NaN) || !sats || sats <= 0) return "unknown"
  if (sats < 1_000) return "lt_1k_sats"
  if (sats < 10_000) return "1k_10k_sats"
  if (sats < 100_000) return "10k_100k_sats"
  if (sats < 1_000_000) return "100k_1m_sats"
  return "1m_plus_sats"
}

export function isBrowserTelemetryEventName(
  eventName: string
): eventName is BrowserTelemetryEventName {
  return browserTelemetryEventNameSet.has(eventName)
}

export function sanitizeTelemetryEventProperties(
  input: TelemetryEventInput
): Record<string, string | boolean> {
  const sanitized: Record<string, string | boolean> = {
    event_name: input.eventName,
    app: input.app,
  }

  for (const [key, value] of Object.entries(input.properties ?? {})) {
    if (
      !browserTelemetryPropertyNameSet.has(key) ||
      key === "event_name" ||
      key === "app"
    ) {
      continue
    }
    if (typeof value === "boolean") {
      sanitized[key] = value
      continue
    }
    const normalized = sanitizeTelemetryPropertyValue(value)
    if (normalized) sanitized[key] = normalized
  }

  return sanitized
}

export function buildTelemetryEventPageContext(input: {
  origin: string
  pathname: string
}): Record<"page_url" | "page_path", string> {
  return {
    page_path: sanitizeTelemetryPath(input.pathname),
    page_url: buildTelemetryPageUrl(input),
  }
}

export function getConduitPostHogConfig(
  input: PostHogTelemetryConfig
): ConduitPostHogConfig {
  return {
    api_host: input.host,
    autocapture: false,
    capture_dead_clicks: false,
    capture_pageview: false,
    capture_pageleave: false,
    rageclick: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    disable_persistence: true,
    persistence: "memory",
    person_profiles: "never",
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    enable_recording_console_log: false,
    enable_heatmaps: false,
    mask_all_text: true,
    mask_all_element_attributes: true,
    property_denylist: [...sensitiveTelemetryPropertyNames],
    before_send: sanitizePostHogCaptureEvent,
  }
}

export function sanitizePostHogCaptureEvent(
  event: PostHogCaptureEvent
): PostHogCaptureEvent | null {
  const eventName = typeof event.event === "string" ? event.event : null
  if (
    eventName !== "$pageview" &&
    (!eventName || !isBrowserTelemetryEventName(eventName))
  ) {
    return null
  }

  const sourceProperties = event.properties ?? {}
  const sanitizedProperties: Record<string, string | boolean> = {}

  for (const [key, value] of Object.entries(sourceProperties)) {
    if (!browserTelemetryPropertyNameSet.has(key)) continue

    if (typeof value === "boolean") {
      sanitizedProperties[key] = value
      continue
    }
    if (typeof value !== "string") continue

    if (key === "page_url") {
      const pageUrl = sanitizeTelemetryRouteUrl(value)
      if (pageUrl) sanitizedProperties[key] = pageUrl
      continue
    }
    if (key === "page_path") {
      sanitizedProperties[key] = sanitizeTelemetryPath(value)
      continue
    }

    const normalized = sanitizeTelemetryPropertyValue(value)
    if (normalized) sanitizedProperties[key] = normalized
  }

  const pageUrl =
    typeof sanitizedProperties.page_url === "string"
      ? sanitizedProperties.page_url
      : sanitizeTelemetryRouteUrl(
          getStringProperty(sourceProperties, "$current_url")
        )
  const pagePath =
    typeof sanitizedProperties.page_path === "string"
      ? sanitizedProperties.page_path
      : sanitizeTelemetryPath(
          getStringProperty(sourceProperties, "$pathname") ?? "/"
        )

  if (pageUrl) sanitizedProperties.$current_url = pageUrl
  sanitizedProperties.$pathname = pagePath

  return {
    ...event,
    properties: sanitizedProperties,
  }
}

export function recordBrowserTelemetryEvent(input: TelemetryEventInput): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  if (!isBrowserTelemetryEventName(input.eventName)) return

  const config = resolveBrowserTelemetryConfig(input.app)
  if (!config.enabled) return
  if (!isTelemetryAllowedForCurrentHost(config)) return
  if (isGlobalPrivacyControlEnabled()) return

  const properties = {
    ...sanitizeTelemetryEventProperties(input),
    ...buildTelemetryEventPageContext({
      origin: window.location.origin,
      pathname: window.location.pathname,
    }),
  }

  if (config.plausible) {
    ensurePlausible(config.plausible)
    window.plausible?.(input.eventName, {
      url: properties.page_url as string,
      props: properties,
    })
  }

  if (config.posthog) {
    void ensurePostHog(config.posthog).then((client) => {
      client?.capture(input.eventName, {
        ...properties,
        $current_url: properties.page_url,
        $pathname: properties.page_path,
      })
    })
  }
}

export function recordBrowserTelemetryPageView(
  input: TelemetryPageViewInput
): void {
  if (typeof window === "undefined" || typeof document === "undefined") return

  const config = resolveBrowserTelemetryConfig(input.app)
  if (!config.enabled) return
  if (!isTelemetryAllowedForCurrentHost(config)) return
  if (isGlobalPrivacyControlEnabled()) return

  const pageUrl = buildTelemetryPageUrl({
    origin: input.origin ?? window.location.origin,
    pathname: input.pathname,
  })
  const sanitizedPath = sanitizeTelemetryPath(input.pathname)

  if (config.plausible) {
    ensurePlausible(config.plausible)
    window.plausible?.("pageview", { url: pageUrl })
  }

  if (config.posthog) {
    void ensurePostHog(config.posthog).then((client) => {
      client?.capture("$pageview", {
        $current_url: pageUrl,
        $pathname: sanitizedPath,
        app: input.app,
        page_path: sanitizedPath,
        page_url: pageUrl,
      })
    })
  }
}

function getStringProperty(
  properties: Record<string, unknown>,
  key: string
): string | null {
  const value = properties[key]
  return typeof value === "string" && value.trim() ? value : null
}

function sanitizeTelemetryRouteUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return buildTelemetryPageUrl({
      origin: url.origin,
      pathname: url.pathname,
    })
  } catch {
    return null
  }
}

function sanitizeTelemetryPropertyValue(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (normalized.length > 64) return null
  if (/^https?:\/\//.test(normalized) || normalized.includes("://")) return null
  if (/^[0-9a-f]{64}$/i.test(normalized)) return null
  if (/^(naddr|nevent|note|nprofile|npub|nsec)1/i.test(normalized)) return null
  if (!/^[a-z0-9_:-]+$/.test(normalized)) return null
  return normalized
}

function parseAllowedTelemetryHosts(raw: string | undefined): string[] {
  return (
    raw
      ?.split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean) ?? []
  )
}

function isTelemetryAllowedForCurrentHost(
  config: BrowserTelemetryConfig
): boolean {
  if (config.allowedHosts.length === 0) return true
  return config.allowedHosts.includes(window.location.hostname.toLowerCase())
}

function isGlobalPrivacyControlEnabled(): boolean {
  if (typeof navigator === "undefined") return false
  return (
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl === true
  )
}

function ensurePlausible(config: PlausibleTelemetryConfig): void {
  const configKey = config.domain ?? config.scriptSrc
  if (plausibleInitializedFor === configKey) return

  const existing = window.plausible
  const plausible: PlausibleFunction =
    existing ??
    (((...args: Parameters<PlausibleFunction>) => {
      plausible.q = plausible.q ?? []
      plausible.q.push(args)
    }) as PlausibleFunction)

  plausible.init =
    plausible.init ??
    ((options) => {
      applyPlausibleInitOptions(plausible, options)
    })
  window.plausible = plausible
  window.plausible.init?.({ autoCapturePageviews: false, logging: false })

  const alreadyLoaded = document.querySelector<HTMLScriptElement>(
    `script[data-conduit-telemetry="plausible"][data-config-key="${configKey}"]`
  )
  if (!alreadyLoaded) {
    const script = document.createElement("script")
    script.async = true
    script.src = config.scriptSrc
    if (config.domain) script.dataset.domain = config.domain
    script.dataset.configKey = configKey
    script.dataset.conduitTelemetry = "plausible"
    script.addEventListener("load", () => {
      window.plausible?.init?.({ autoCapturePageviews: false, logging: false })
    })
    document.head.appendChild(script)
  }

  plausibleInitializedFor = configKey
}

async function ensurePostHog(
  config: PostHogTelemetryConfig
): Promise<PostHogClient | null> {
  const key = `${config.host}:${config.key}`
  if (posthogInitializedFor === key && posthogClientPromise) {
    return posthogClientPromise
  }

  posthogInitializedFor = key
  posthogClientPromise = import("posthog-js")
    .then((mod) => {
      const postHogModule = mod as unknown as PostHogModule
      const client = (postHogModule.default ?? postHogModule) as
        | PostHogClient
        | undefined
      if (!client?.init || !client.capture) return null
      client.init(config.key, getConduitPostHogConfig(config))
      return client
    })
    .catch(() => null)

  return posthogClientPromise
}
