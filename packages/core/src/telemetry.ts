export type ConduitTelemetryApp = "market" | "merchant"

export interface BrowserTelemetryEnv {
  VITE_ENABLE_TELEMETRY?: string
  VITE_PLAUSIBLE_DOMAIN?: string
  VITE_PLAUSIBLE_SRC?: string
  VITE_POSTHOG_KEY?: string
  VITE_POSTHOG_HOST?: string
}

export interface PlausibleTelemetryConfig {
  domain: string
  scriptSrc: string
}

export interface PostHogTelemetryConfig {
  key: string
  host: string
}

export interface BrowserTelemetryConfig {
  app: ConduitTelemetryApp
  enabled: boolean
  plausible: PlausibleTelemetryConfig | null
  posthog: PostHogTelemetryConfig | null
}

export interface TelemetryPageViewInput {
  app: ConduitTelemetryApp
  pathname: string
  origin?: string
}

interface PlausibleFunction {
  (eventName: "pageview", options?: { url?: string }): void
  q?: unknown[]
  init?: (options: { autoCapturePageviews: boolean; logging: boolean }) => void
}

interface PostHogClient {
  init: (key: string, config: ConduitPostHogConfig) => void
  capture: (
    eventName: "$pageview",
    properties: Record<string, string | boolean>
  ) => void
}

type PostHogModule = {
  default?: PostHogClient
} & Partial<PostHogClient>

export interface ConduitPostHogConfig {
  api_host: string
  autocapture: false
  capture_pageview: false
  capture_pageleave: false
  disable_session_recording: true
  disable_surveys: true
  disable_web_experiments: true
  disable_external_dependency_loading: true
  disable_persistence: true
  persistence: "memory"
  person_profiles: "never"
  advanced_disable_feature_flags: true
  enable_recording_console_log: false
  enable_heatmaps: false
  mask_all_text: true
  mask_all_element_attributes: true
  property_denylist: string[]
}

declare global {
  interface Window {
    plausible?: PlausibleFunction
  }
}

const DEFAULT_PLAUSIBLE_SCRIPT_SRC = "https://plausible.io/js/script.js"
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"

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
  const plausibleDomain = clean(env.VITE_PLAUSIBLE_DOMAIN)
  const posthogKey = clean(env.VITE_POSTHOG_KEY)

  return {
    app,
    enabled,
    plausible:
      enabled && plausibleDomain
        ? {
            domain: plausibleDomain,
            scriptSrc:
              clean(env.VITE_PLAUSIBLE_SRC) ?? DEFAULT_PLAUSIBLE_SCRIPT_SRC,
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
  if (section === "store") return "/store/:pubkey"
  if (section === "u") return "/u/:profileRef"
  if (section === "orders") return "/orders"

  if (segments.length === 1) return `/${section}`
  return `/${section}/:param`
}

export function buildTelemetryPageUrl(input: {
  origin: string
  pathname: string
}): string {
  const sanitizedPath = sanitizeTelemetryPath(input.pathname)
  const trimmedOrigin = input.origin.replace(/\/+$/, "")
  return `${trimmedOrigin}${sanitizedPath}`
}

export function getConduitPostHogConfig(
  input: PostHogTelemetryConfig
): ConduitPostHogConfig {
  return {
    api_host: input.host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    disable_persistence: true,
    persistence: "memory",
    person_profiles: "never",
    advanced_disable_feature_flags: true,
    enable_recording_console_log: false,
    enable_heatmaps: false,
    mask_all_text: true,
    mask_all_element_attributes: true,
    property_denylist: [...sensitiveTelemetryPropertyNames],
  }
}

export function recordBrowserTelemetryPageView(
  input: TelemetryPageViewInput
): void {
  if (typeof window === "undefined" || typeof document === "undefined") return

  const config = resolveBrowserTelemetryConfig(input.app)
  if (!config.enabled) return

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
      })
    })
  }
}

function ensurePlausible(config: PlausibleTelemetryConfig): void {
  if (plausibleInitializedFor === config.domain) return

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
      plausible.q = plausible.q ?? []
      plausible.q.push(["init", options])
    })
  window.plausible = plausible
  window.plausible.init?.({ autoCapturePageviews: false, logging: false })

  const alreadyLoaded = document.querySelector<HTMLScriptElement>(
    `script[data-conduit-telemetry="plausible"][data-domain="${config.domain}"]`
  )
  if (!alreadyLoaded) {
    const script = document.createElement("script")
    script.defer = true
    script.src = config.scriptSrc
    script.dataset.domain = config.domain
    script.dataset.conduitTelemetry = "plausible"
    script.addEventListener("load", () => {
      window.plausible?.init?.({ autoCapturePageviews: false, logging: false })
    })
    document.head.appendChild(script)
  }

  plausibleInitializedFor = config.domain
}

async function ensurePostHog(
  config: PostHogTelemetryConfig
): Promise<PostHogClient | null> {
  const key = `${config.host}:${config.key}`
  if (posthogInitializedFor === key) return posthogClientPromise

  posthogInitializedFor = key
  posthogClientPromise = import("posthog-js")
    .then((mod: PostHogModule) => {
      const client = (mod.default ?? mod) as PostHogClient | undefined
      if (!client?.init || !client.capture) return null
      client.init(config.key, getConduitPostHogConfig(config))
      return client
    })
    .catch(() => null)

  return posthogClientPromise
}
