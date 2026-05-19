import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
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

function walkFiles(
  root: string,
  predicate: (path: string) => boolean
): string[] {
  if (!existsSync(root)) return []

  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stats = statSync(path)
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
