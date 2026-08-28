import { normalizePubkey, pubkeyToNpub } from "./utils"

export type ConduitTelemetryApp = "market" | "merchant"

export {
  browserTelemetryEventPropertyContracts,
  browserTelemetryEventNames,
  browserTelemetryPropertyNames,
  getOfficialProductTelemetryApp,
  hasRequiredBrowserTelemetryEventProperties,
  isAllowedBrowserTelemetryEventApp,
  isAllowedBrowserTelemetryEventProperty,
  isAllowedBrowserTelemetryLabelValue,
  officialProductTelemetryHostnames,
} from "./telemetry-contract"
export type {
  BrowserTelemetryEventName,
  BrowserTelemetryPropertyName,
} from "./telemetry-contract"
import {
  browserTelemetryEventNames,
  browserTelemetryPropertyNames,
  getOfficialProductTelemetryApp,
  hasRequiredBrowserTelemetryEventProperties,
  isAllowedBrowserTelemetryEventApp,
  isAllowedBrowserTelemetryEventProperty,
  isAllowedBrowserTelemetryLabelValue,
} from "./telemetry-contract"
import type {
  BrowserTelemetryEventName,
  BrowserTelemetryPropertyName,
} from "./telemetry-contract"

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
    eventName: PostHogTelemetryEventName | BrowserTelemetryEventName,
    properties: Record<string, PostHogPropertyValue>
  ) => void
}

type PostHogModule = {
  default?: PostHogClient
} & Partial<PostHogClient>

export interface ConduitPostHogConfig {
  api_host: string
  ui_host: "https://us.posthog.com"
  bootstrap: {
    distinctID: "conduit-browser-telemetry"
    isIdentifiedID: false
  }
  autocapture: false
  capture_exceptions: false
  capture_dead_clicks: false
  capture_heatmaps: false
  capture_pageview: false
  capture_pageleave: true
  disable_compression: true
  capture_performance: {
    network_timing: false
    web_vitals: true
    web_vitals_allowed_metrics: ["LCP", "CLS", "FCP", "INP"]
    web_vitals_attribution: false
  }
  rageclick: false
  disable_session_recording: true
  disable_surveys: true
  disable_web_experiments: true
  disable_external_dependency_loading: true
  disable_persistence: false
  persistence: "sessionStorage"
  save_campaign_params: false
  save_referrer: false
  session_idle_timeout_seconds: 1800
  person_profiles: "never"
  advanced_disable_flags: true
  advanced_disable_feature_flags: true
  enable_recording_console_log: false
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
const DEFAULT_POSTHOG_HOST = "https://e.conduit.market"
const DEFAULT_POSTHOG_UI_HOST = "https://us.posthog.com"
const POSTHOG_ANONYMOUS_DISTINCT_ID = "conduit-browser-telemetry"
const postHogTelemetryEventNames = [
  "$pageleave",
  "$pageview",
  "$web_vitals",
] as const
type PostHogTelemetryEventName = (typeof postHogTelemetryEventNames)[number]
type PostHogPropertyValue = string | boolean | number
const postHogTelemetryEventNameSet = new Set<string>(postHogTelemetryEventNames)
const postHogWebVitalValueNames = [
  "$web_vitals_CLS_value",
  "$web_vitals_FCP_value",
  "$web_vitals_INP_value",
  "$web_vitals_LCP_value",
] as const
const postHogPageViewContextNames = [
  "$pageview_id",
  "$prev_pageview_id",
] as const
const postHogPageLeavePercentageNames = [
  "$prev_pageview_last_content_percentage",
  "$prev_pageview_last_scroll_percentage",
  "$prev_pageview_max_content_percentage",
  "$prev_pageview_max_scroll_percentage",
] as const
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
  "credential",
  "derivedKey",
  "fingerprint",
  "invoice",
  "lnurl",
  "message",
  "mnemonic",
  "npub",
  "nwcUri",
  "nwc_uri",
  "orderId",
  "order_id",
  "paymentHash",
  "paymentTarget",
  "preimage",
  "productTitle",
  "pubkey",
  "secret",
  "seed",
  "recoveryPhrase",
  "shippingAddress",
  "signer",
  "title",
  "userAgent",
  "wallet",
  "walletBalance",
  "walletId",
  "wallet_id",
  "balance",
] as const

const browserTelemetryEventNameSet = new Set<string>(browserTelemetryEventNames)
const browserTelemetryPropertyNameSet = new Set<string>(
  browserTelemetryPropertyNames
)

let plausibleInitializedFor: string | null = null
let posthogInitializedFor: string | null = null
let posthogClientPromise: Promise<PostHogClient | null> | null = null
let lastPageViewSignature: string | null = null

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

export function constrainOfficialBrowserTelemetryConfig(
  config: BrowserTelemetryConfig,
  hostname: string
): BrowserTelemetryConfig {
  const officialApp = getOfficialProductTelemetryApp(hostname)
  if (!officialApp) {
    return {
      ...config,
      posthog: null,
    }
  }

  return {
    ...config,
    plausible: null,
    posthog:
      officialApp === config.app && config.posthog
        ? {
            ...config.posthog,
            host: DEFAULT_POSTHOG_HOST,
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
): Record<string, string | boolean> | null {
  if (!isAllowedBrowserTelemetryEventApp(input.eventName, input.app)) {
    return null
  }

  const sanitized: Record<string, string | boolean> = {
    event_name: input.eventName,
    app: input.app,
  }

  for (const [key, value] of Object.entries(input.properties ?? {})) {
    if (
      !browserTelemetryPropertyNameSet.has(key) ||
      key === "event_name" ||
      key === "app" ||
      key === "page_path" ||
      key === "page_url" ||
      !isAllowedBrowserTelemetryEventProperty(input.eventName, key)
    ) {
      return null
    }
    if (typeof value !== "string") return null
    const normalized = sanitizeTelemetryPropertyValue(
      key,
      value,
      input.eventName
    )
    if (!normalized) return null
    sanitized[key] = normalized
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
    ui_host: DEFAULT_POSTHOG_UI_HOST,
    bootstrap: {
      distinctID: POSTHOG_ANONYMOUS_DISTINCT_ID,
      isIdentifiedID: false,
    },
    autocapture: false,
    capture_exceptions: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_pageview: false,
    capture_pageleave: true,
    disable_compression: true,
    capture_performance: {
      network_timing: false,
      web_vitals: true,
      web_vitals_allowed_metrics: ["LCP", "CLS", "FCP", "INP"],
      web_vitals_attribution: false,
    },
    rageclick: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    disable_persistence: false,
    persistence: "sessionStorage",
    save_campaign_params: false,
    save_referrer: false,
    session_idle_timeout_seconds: 1800,
    person_profiles: "never",
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    enable_recording_console_log: false,
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
    (!eventName || !postHogTelemetryEventNameSet.has(eventName)) &&
    (!eventName || !isBrowserTelemetryEventName(eventName))
  ) {
    return null
  }

  const sourceProperties = event.properties ?? {}
  const sanitizedProperties: Record<string, PostHogPropertyValue> =
    getPostHogIngestionProperties(sourceProperties)
  const isBrowserEvent = isBrowserTelemetryEventName(eventName)

  for (const [key, value] of Object.entries(sourceProperties)) {
    if (!browserTelemetryPropertyNameSet.has(key)) continue
    if (
      isBrowserEvent &&
      !isAllowedBrowserTelemetryEventProperty(eventName, key)
    ) {
      return null
    }
    if (
      !isBrowserEvent &&
      key !== "app" &&
      key !== "page_path" &&
      key !== "page_url"
    ) {
      return null
    }

    if (typeof value !== "string") return null

    if (key === "page_url") {
      const pageUrl = sanitizeTelemetryRouteUrl(value)
      if (!pageUrl) return null
      sanitizedProperties[key] = pageUrl
      continue
    }
    if (key === "page_path") {
      sanitizedProperties[key] = sanitizeTelemetryPath(value)
      continue
    }

    const normalized = sanitizeTelemetryPropertyValue(key, value, eventName)
    if (!normalized) return null
    sanitizedProperties[key] = normalized
  }

  addPostHogSessionContext(sanitizedProperties, sourceProperties)
  if (eventName === "$pageleave") {
    addPostHogPageLeaveProperties(sanitizedProperties, sourceProperties)
  }
  if (eventName === "$web_vitals") {
    addPostHogWebVitalProperties(sanitizedProperties, sourceProperties)
  }

  const sourcePageUrl = sanitizeTelemetryRouteUrl(
    getStringProperty(sourceProperties, "$current_url")
  )
  const currentPageUrl =
    typeof sanitizedProperties.page_url === "string"
      ? sanitizedProperties.page_url
      : sourcePageUrl
  const sourcePagePath = getStringProperty(sourceProperties, "$pathname")
  const previousPagePath =
    eventName === "$pageleave" &&
    typeof sanitizedProperties.$prev_pageview_pathname === "string"
      ? sanitizedProperties.$prev_pageview_pathname
      : null
  const pagePath =
    previousPagePath ??
    (typeof sanitizedProperties.page_path === "string"
      ? sanitizedProperties.page_path
      : sourcePagePath
        ? sanitizeTelemetryPath(sourcePagePath)
        : currentPageUrl
          ? sanitizeTelemetryPath(new URL(currentPageUrl).pathname)
          : "/")
  const pageUrl =
    previousPagePath && currentPageUrl
      ? buildTelemetryPageUrl({
          origin: new URL(currentPageUrl).origin,
          pathname: previousPagePath,
        })
      : currentPageUrl

  if (pageUrl) sanitizedProperties.$current_url = pageUrl
  sanitizedProperties.$pathname = pagePath
  sanitizedProperties.page_path = pagePath
  if (pageUrl) sanitizedProperties.page_url = pageUrl

  const inferredApp = getTelemetryAppForPageUrl(pageUrl)
  if (typeof sanitizedProperties.app !== "string" && inferredApp !== null) {
    sanitizedProperties.app = inferredApp
  }
  if (
    isBrowserEvent &&
    !hasRequiredBrowserTelemetryEventProperties(eventName, sanitizedProperties)
  ) {
    return null
  }

  const sanitizedEvent: PostHogCaptureEvent = {
    event: eventName,
    properties: sanitizedProperties,
  }
  if (isTelemetryEventUuid(event.uuid)) sanitizedEvent.uuid = event.uuid
  if (
    event.timestamp instanceof Date &&
    Number.isFinite(event.timestamp.getTime())
  ) {
    sanitizedEvent.timestamp = event.timestamp
  }
  return sanitizedEvent
}

function getPostHogIngestionProperties(
  properties: Record<string, unknown>
): Record<string, PostHogPropertyValue> {
  const sanitized: Record<string, PostHogPropertyValue> = {
    $process_person_profile: false,
    distinct_id: POSTHOG_ANONYMOUS_DISTINCT_ID,
  }
  const token = properties.token
  if (typeof token === "string" && token.trim()) {
    sanitized.token = token
  }

  return sanitized
}

function addPostHogSessionContext(
  sanitized: Record<string, PostHogPropertyValue>,
  source: Record<string, unknown>
): void {
  const sessionId = source.$session_id
  if (isUuidV7(sessionId)) sanitized.$session_id = sessionId

  for (const propertyName of postHogPageViewContextNames) {
    const value = source[propertyName]
    if (isUuidV7(value)) sanitized[propertyName] = value
  }
}

function addPostHogPageLeaveProperties(
  sanitized: Record<string, PostHogPropertyValue>,
  source: Record<string, unknown>
): void {
  const previousPagePath = getStringProperty(source, "$prev_pageview_pathname")
  if (previousPagePath) {
    sanitized.$prev_pageview_pathname = sanitizeTelemetryPath(previousPagePath)
  }

  const duration = source.$prev_pageview_duration
  if (
    typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration >= 0 &&
    duration <= 86_400
  ) {
    sanitized.$prev_pageview_duration = duration
  }

  for (const propertyName of postHogPageLeavePercentageNames) {
    const value = source[propertyName]
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1
    ) {
      sanitized[propertyName] = value
    }
  }
}

function addPostHogWebVitalProperties(
  sanitized: Record<string, PostHogPropertyValue>,
  source: Record<string, unknown>
): void {
  for (const propertyName of postHogWebVitalValueNames) {
    const value = source[propertyName]
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 900_000
    ) {
      sanitized[propertyName] = value
    }
  }
}

function isUuidV7(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  )
}

function isTelemetryEventUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  )
}

function getTelemetryAppForPageUrl(
  pageUrl: string | null
): ConduitTelemetryApp | null {
  if (!pageUrl) return null

  try {
    return getOfficialProductTelemetryApp(new URL(pageUrl).hostname)
  } catch {
    return null
  }
}

export function recordBrowserTelemetryEvent(input: TelemetryEventInput): void {
  try {
    recordBrowserTelemetryEventUnsafe(input)
  } catch {
    // Telemetry is best-effort and must never change the user-visible flow.
  }
}

function recordBrowserTelemetryEventUnsafe(input: TelemetryEventInput): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  if (!isBrowserTelemetryEventName(input.eventName)) return

  const config = constrainOfficialBrowserTelemetryConfig(
    resolveBrowserTelemetryConfig(input.app),
    window.location.hostname
  )
  if (!config.enabled) return
  if (!isTelemetryAllowedForCurrentHost(config)) return
  if (isGlobalPrivacyControlEnabled()) return

  const sanitizedProperties = sanitizeTelemetryEventProperties(input)
  if (!sanitizedProperties) return

  const properties = {
    ...sanitizedProperties,
    ...buildTelemetryEventPageContext({
      origin: window.location.origin,
      pathname: window.location.pathname,
    }),
  }
  if (
    !hasRequiredBrowserTelemetryEventProperties(input.eventName, properties)
  ) {
    return
  }

  if (config.plausible) {
    ensurePlausible(config.plausible)
    window.plausible?.(input.eventName, {
      url: properties.page_url as string,
      props: properties,
    })
  }

  if (config.posthog) {
    void ensurePostHog(config.posthog)
      .then((client) => {
        client?.capture(input.eventName, {
          ...properties,
          $current_url: properties.page_url,
          $pathname: properties.page_path,
          $process_person_profile: false,
          distinct_id: POSTHOG_ANONYMOUS_DISTINCT_ID,
        })
      })
      .catch(() => undefined)
  }
}

export function recordBrowserTelemetryPageView(
  input: TelemetryPageViewInput
): void {
  try {
    recordBrowserTelemetryPageViewUnsafe(input)
  } catch {
    // Telemetry is best-effort and must never change the user-visible flow.
  }
}

function recordBrowserTelemetryPageViewUnsafe(
  input: TelemetryPageViewInput
): void {
  if (typeof window === "undefined" || typeof document === "undefined") return

  const config = constrainOfficialBrowserTelemetryConfig(
    resolveBrowserTelemetryConfig(input.app),
    window.location.hostname
  )
  if (!config.enabled) return
  if (!isTelemetryAllowedForCurrentHost(config)) return
  if (isGlobalPrivacyControlEnabled()) return

  const pageUrl = buildTelemetryPageUrl({
    origin: input.origin ?? window.location.origin,
    pathname: input.pathname,
  })
  const sanitizedPath = sanitizeTelemetryPath(input.pathname)
  // Keep the raw route only in memory for exact duplicate suppression. Using
  // the sanitized provider URL here would collapse distinct dynamic routes
  // such as `/products/a` and `/products/b` into one pageview.
  const pageViewSignature = `${input.app}:${input.origin ?? window.location.origin}:${input.pathname}`
  if (lastPageViewSignature === pageViewSignature) return
  lastPageViewSignature = pageViewSignature

  if (config.plausible) {
    ensurePlausible(config.plausible)
    window.plausible?.("pageview", { url: pageUrl })
  }

  if (config.posthog) {
    void ensurePostHog(config.posthog)
      .then((client) => {
        client?.capture("$pageview", {
          $current_url: pageUrl,
          $pathname: sanitizedPath,
          $process_person_profile: false,
          app: input.app,
          distinct_id: POSTHOG_ANONYMOUS_DISTINCT_ID,
          page_path: sanitizedPath,
          page_url: pageUrl,
        })
      })
      .catch(() => undefined)
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

function sanitizeTelemetryPropertyValue(
  propertyName: string,
  value: string,
  eventName?: string
): string | null {
  const normalized = value.trim().toLowerCase()
  return isAllowedBrowserTelemetryLabelValue(
    propertyName,
    normalized,
    eventName
  )
    ? normalized
    : null
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
  if (config.allowedHosts.length === 0) return false
  const hostname = window.location.hostname.toLowerCase()
  return config.allowedHosts.some((pattern) =>
    isTelemetryHostnameMatch(hostname, pattern)
  )
}

function isTelemetryHostnameMatch(hostname: string, pattern: string): boolean {
  if (!pattern.startsWith("*.")) return hostname === pattern

  const suffix = pattern.slice(2)
  if (!suffix || suffix.includes("*")) return false
  if (!hostname.endsWith(`.${suffix}`)) return false

  const prefix = hostname.slice(0, -(suffix.length + 1))
  return !!prefix && !prefix.includes(".")
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
  posthogClientPromise = Promise.all([
    import("posthog-js"),
    // PostHog publishes this side-effect extension without a declaration file.
    // @ts-expect-error The runtime module is part of the installed posthog-js package.
    import("posthog-js/dist/web-vitals"),
  ])
    .then(([mod]) => {
      const postHogModule = mod as unknown as PostHogModule
      const client = (postHogModule.default ?? postHogModule) as
        PostHogClient | undefined
      if (!client?.init || !client.capture) return null
      client.init(config.key, getConduitPostHogConfig(config))
      return client
    })
    .catch(() => null)

  return posthogClientPromise
}
