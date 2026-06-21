import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

export const allowedTelemetryProperties = new Set([
  "event_name",
  "app",
  "page_url",
  "page_path",
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
])

export const allowedProviderTelemetryEventNames = new Set([
  "$pageview",
  "pageview",
])

export const bannedPrivacyPackages = [
  "@amplitude/analytics-browser",
  "@amplitude/analytics-node",
  "@fullstory/browser",
  "@hotjar/browser",
  "@rudderstack/analytics-js",
  "@sentry/browser",
  "@sentry/react",
  "@segment/analytics-next",
  "cookie",
  "cookie-es",
  "amplitude-js",
  "clarity-js",
  "fullstory",
  "ga-gtag",
  "gtag.js",
  "hotjar",
  "js-cookie",
  "logrocket",
  "mixpanel-browser",
  "react-cookie",
  "react-ga",
  "react-ga4",
  "rrweb",
  "rudder-sdk-js",
  "universal-cookie",
  "vue-cookies",
]

export const sensitiveTelemetryPropertyNames = new Set([
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
])

export type TelemetryEventMarker = {
  eventName: string
  properties: string[]
}

export type TelemetryPolicyResult = {
  errors: string[]
  events: TelemetryEventMarker[]
}

const eventMarkerPattern =
  /<!--\s*telemetry-event:\s*([a-z0-9_]+)\s+properties=([a-z0-9_,]+)\s*-->/g

const telemetryCallExpression =
  "\\b(?:(?:posthog|client)(?:\\.|\\?\\.)capture|(?:window\\.)?plausible(?:\\?\\.)?|trackTelemetry|recordTelemetryEvent|recordBrowserTelemetryEvent)"

const telemetryApiPattern = new RegExp(`${telemetryCallExpression}\\s*\\(`, "g")

const forbiddenTelemetryApiPattern =
  /\b(?:posthog|client)(?:\.|\?\.)(?:alias|group|identify|register|setPersonProperties|setPersonPropertiesForFlags)\s*\(/g

const unsafeTelemetryConfigPatterns: Array<[RegExp, string]> = [
  [/\bautocapture\s*:\s*true\b/, "autocapture must stay disabled"],
  [
    /\bcapture_pageview\s*:\s*true\b/,
    "PostHog automatic pageviews must stay disabled",
  ],
  [
    /\bcapture_pageleave\s*:\s*true\b/,
    "PostHog pageleave capture must stay disabled",
  ],
  [
    /\bdisable_session_recording\s*:\s*false\b/,
    "PostHog session recording must stay disabled",
  ],
  [/\benable_heatmaps\s*:\s*true\b/, "PostHog heatmaps must stay disabled"],
  [
    /\bdisable_persistence\s*:\s*false\b/,
    "PostHog persistence must stay disabled",
  ],
  [
    /\bperson_profiles\s*:\s*["'`](?!never["'`])/,
    "PostHog person profiles must stay disabled",
  ],
  [
    /\badvanced_disable_flags\s*:\s*false\b/,
    "PostHog flags endpoint must stay disabled",
  ],
]

const forbiddenCookieSourcePatterns: Array<[RegExp, string]> = [
  [
    /\bdocument\s*\.\s*cookie\b/,
    "document.cookie is not allowed in product clients",
  ],
  [/\bcookieStore\s*\./, "Cookie Store API is not allowed in product clients"],
  [
    /\bSet-Cookie\b/i,
    "Set-Cookie headers are not allowed in Conduit-operated app surfaces",
  ],
]

const skippedWalkDirectoryNames = new Set([".git", "dist", "node_modules"])

function walkFiles(
  root: string,
  predicate: (path: string) => boolean
): string[] {
  if (!existsSync(root)) return []

  const files: string[] = []
  for (const entry of readdirSync(root)) {
    if (skippedWalkDirectoryNames.has(entry)) continue

    const path = join(root, entry)
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) continue

    if (stats.isDirectory()) {
      files.push(...walkFiles(path, predicate))
      continue
    }
    if (stats.isFile() && predicate(path)) {
      files.push(path)
    }
  }
  return files
}

export function parseTelemetryEventMarkers(
  markdown: string
): TelemetryEventMarker[] {
  const events: TelemetryEventMarker[] = []
  for (const match of markdown.matchAll(eventMarkerPattern)) {
    events.push({
      eventName: match[1],
      properties: match[2].split(",").map((property) => property.trim()),
    })
  }
  return events
}

export function validateTelemetryEvents(
  events: TelemetryEventMarker[]
): string[] {
  const errors: string[] = []

  if (events.length === 0) {
    errors.push("docs/analytics/events.md must define telemetry-event markers.")
  }

  for (const event of events) {
    if (!/^[a-z0-9_]+$/.test(event.eventName)) {
      errors.push(`Invalid telemetry event name: ${event.eventName}`)
    }

    for (const property of event.properties) {
      if (!allowedTelemetryProperties.has(property)) {
        errors.push(
          `Telemetry event ${event.eventName} uses disallowed property: ${property}`
        )
      }
    }
  }

  return errors
}

export function validateTelemetrySourceUsage(input: {
  source: string
  relativePath: string
  allowedEventNames: Set<string>
}): string[] {
  const errors: string[] = []
  const telemetryCalls = [...input.source.matchAll(telemetryApiPattern)].filter(
    (match) =>
      !isTelemetryFunctionDeclaration({
        source: input.source,
        index: match.index ?? 0,
      }) &&
      !isAllowedTelemetryCoreProviderCall({
        relativePath: input.relativePath,
        source: input.source,
        index: match.index ?? 0,
      })
  )

  for (const match of telemetryCalls) {
    const callWindow = getTelemetryCallWindow(input.source, match.index ?? 0)
    const eventName = getLiteralTelemetryEventName(callWindow)

    if (!eventName) {
      errors.push(
        `${input.relativePath} includes a telemetry call without a literal allowlisted event name`
      )
    } else if (allowedProviderTelemetryEventNames.has(eventName)) {
      errors.push(
        `${input.relativePath} uses provider telemetry event ${eventName} outside the shared telemetry wrapper`
      )
    } else if (!input.allowedEventNames.has(eventName)) {
      errors.push(
        `${input.relativePath} uses telemetry event ${eventName} outside docs/analytics/events.md`
      )
    }

    for (const propertyName of sensitiveTelemetryPropertyNames) {
      const propertyPattern = new RegExp(`\\b${propertyName}\\b\\s*(?=[:,}])`)
      if (propertyPattern.test(callWindow)) {
        errors.push(
          `${input.relativePath} includes sensitive telemetry property ${propertyName}`
        )
      }
    }
  }

  for (const match of input.source.matchAll(forbiddenTelemetryApiPattern)) {
    errors.push(
      `${input.relativePath} uses forbidden PostHog identity/profile API ${match[0]}`
    )
  }

  for (const [pattern, message] of unsafeTelemetryConfigPatterns) {
    if (pattern.test(input.source)) {
      errors.push(
        `${input.relativePath} has unsafe telemetry config: ${message}`
      )
    }
  }

  for (const [pattern, message] of forbiddenCookieSourcePatterns) {
    if (pattern.test(input.source)) {
      errors.push(
        `${input.relativePath} violates cookieless policy: ${message}`
      )
    }
  }

  return errors
}

function getLiteralTelemetryEventName(callWindow: string): string | null {
  if (/\brecordBrowserTelemetryEvent\s*\(/.test(callWindow)) {
    return (
      /\beventName\s*:\s*["'`]([a-z0-9_]+)["'`]/.exec(callWindow)?.[1] ?? null
    )
  }

  return /\(\s*["'`]([a-z0-9_$]+)["'`]/.exec(callWindow)?.[1] ?? null
}

function getTelemetryCallWindow(source: string, index: number): string {
  const openParenIndex = source.indexOf("(", index)
  if (openParenIndex === -1) return source.slice(index, index + 240)

  let depth = 0
  let quote: "'" | '"' | "`" | null = null
  let escaped = false

  for (let i = openParenIndex; i < source.length; i += 1) {
    const char = source[i]

    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) quote = null
      continue
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char
      continue
    }

    if (char === "(") depth += 1
    if (char === ")") {
      depth -= 1
      if (depth === 0) return source.slice(index, i + 1)
    }
  }

  return source.slice(index, index + 240)
}

function isTelemetryFunctionDeclaration(input: {
  source: string
  index: number
}): boolean {
  const prefix = input.source.slice(Math.max(0, input.index - 32), input.index)
  return /\bfunction\s*$/.test(prefix)
}

function isAllowedTelemetryCoreProviderCall(input: {
  relativePath: string
  source: string
  index: number
}): boolean {
  if (input.relativePath !== "packages/core/src/telemetry.ts") return false

  const snippet = input.source.slice(input.index, input.index + 80)
  return (
    snippet.startsWith("window.plausible?.(") ||
    snippet.startsWith("client?.capture(")
  )
}

export function checkTelemetrySourceUsage(
  repoRoot: string,
  events: TelemetryEventMarker[]
): string[] {
  const allowedEventNames = new Set(events.map((event) => event.eventName))
  const sourceRoots = ["apps", "packages"]
  const sourceFiles = sourceRoots.flatMap((root) =>
    walkFiles(join(repoRoot, root), (path) => {
      if (path.includes("/node_modules/") || path.includes("/dist/")) {
        return false
      }
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) {
        return false
      }
      if (path.endsWith("routeTree.gen.ts")) {
        return false
      }
      return /\.(ts|tsx|js|jsx)$/.test(path)
    })
  )

  return sourceFiles.flatMap((sourcePath) =>
    validateTelemetrySourceUsage({
      source: readFileSync(sourcePath, "utf8"),
      relativePath: relative(repoRoot, sourcePath),
      allowedEventNames,
    })
  )
}

export function checkPackageManifests(repoRoot: string): string[] {
  const errors: string[] = []
  const manifests = walkFiles(
    repoRoot,
    (path) =>
      path.endsWith("package.json") &&
      !path.includes("/node_modules/") &&
      !path.includes("/dist/")
  )

  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    }

    for (const packageName of bannedPrivacyPackages) {
      if (dependencies[packageName]) {
        errors.push(
          `${relative(repoRoot, manifestPath)} includes privacy-policy-blocked package ${packageName}`
        )
      }
    }
  }

  return errors
}

export function checkTelemetryPolicy(repoRoot: string): TelemetryPolicyResult {
  const allowlistPath = join(repoRoot, "docs/analytics/events.md")
  const allowlist = readFileSync(allowlistPath, "utf8")
  const events = parseTelemetryEventMarkers(allowlist)
  const errors = [
    ...validateTelemetryEvents(events),
    ...checkTelemetrySourceUsage(repoRoot, events),
    ...checkPackageManifests(repoRoot),
  ]

  return { errors, events }
}

if (import.meta.main) {
  const repoRoot = process.cwd()
  const result = checkTelemetryPolicy(repoRoot)

  if (result.errors.length > 0) {
    console.error(result.errors.join("\n"))
    process.exit(1)
  }

  console.log(
    `Telemetry policy OK: ${result.events.length} event allowlist entries validated.`
  )
}
