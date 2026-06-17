import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

export const allowedTelemetryProperties = new Set([
  "event_name",
  "app",
  "network",
  "status",
  "latency_bucket",
  "count",
  "time_bucket",
])

export const allowedProviderTelemetryEventNames = new Set([
  "$pageview",
  "pageview",
])

export const bannedTelemetryPackages = [
  "@amplitude/analytics-browser",
  "@amplitude/analytics-node",
  "@fullstory/browser",
  "@hotjar/browser",
  "@sentry/browser",
  "@sentry/react",
  "@segment/analytics-next",
  "amplitude-js",
  "clarity-js",
  "fullstory",
  "hotjar",
  "logrocket",
  "mixpanel-browser",
  "rrweb",
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
  "\\b(?:(?:posthog|client)(?:\\.|\\?\\.)capture|(?:window\\.)?plausible(?:\\?\\.)?|trackTelemetry|recordTelemetryEvent)"

const telemetryApiPattern = new RegExp(`${telemetryCallExpression}\\s*\\(`, "g")

const literalTelemetryCallPattern = new RegExp(
  `${telemetryCallExpression}\\s*\\(\\s*["'\`]([a-z0-9_$]+)["'\`]`,
  "g"
)

const forbiddenTelemetryApiPattern =
  /\bposthog\.(?:alias|group|identify|register|setPersonProperties|setPersonPropertiesForFlags)\s*\(/g

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
  const telemetryCalls = [...input.source.matchAll(telemetryApiPattern)]
  const literalTelemetryCalls = [
    ...input.source.matchAll(literalTelemetryCallPattern),
  ]

  if (telemetryCalls.length !== literalTelemetryCalls.length) {
    errors.push(
      `${input.relativePath} includes a telemetry call without a literal allowlisted event name`
    )
  }

  for (const match of literalTelemetryCalls) {
    const eventName = match[1]
    if (
      !input.allowedEventNames.has(eventName) &&
      !allowedProviderTelemetryEventNames.has(eventName)
    ) {
      errors.push(
        `${input.relativePath} uses telemetry event ${eventName} outside docs/analytics/events.md`
      )
    }

    const callWindow = input.source.slice(
      match.index ?? 0,
      (match.index ?? 0) + 800
    )
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

  return errors
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

    for (const packageName of bannedTelemetryPackages) {
      if (dependencies[packageName]) {
        errors.push(
          `${relative(repoRoot, manifestPath)} includes banned telemetry package ${packageName}`
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
