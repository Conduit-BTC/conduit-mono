import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs"
import { basename, join, relative } from "node:path"

// Product collection is retired. New analytics require a separately reviewed design.
export const bannedPrivacyPackages = [
  "posthog-js",
  "posthog-node",
  "@plausible-analytics/tracker",
  "plausible-tracker",
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

const retiredSourcePatterns: Array<[RegExp, string]> = [
  [
    /posthog-js|posthog-node|plausible-tracker|@plausible-analytics\/tracker/,
    "retired analytics SDK",
  ],
  [
    /\b(?:recordBrowserTelemetryEvent|recordBrowserTelemetryPageView|reportCommerceGmvEstimate|recordTelemetryEvent|trackTelemetry)\s*\(/,
    "retired telemetry API",
  ],
  [
    /\b(?:posthog|client)(?:\.|\?\.)(?:capture|identify|alias|group|register|setPersonProperties)\s*\(|\b(?:window\.)?plausible(?:\?\.)?\s*\(/,
    "analytics provider call",
  ],
  [
    /(?:VITE_)?(?:ENABLE_TELEMETRY|TELEMETRY_ALLOWED_HOSTS|POSTHOG_|PLAUSIBLE_)|COMMERCE_GMV_TELEMETRY_HMAC_SECRET/,
    "retired analytics configuration",
  ],
  [
    /\b(?:https?:\/\/)?(?:e\.conduit\.market|(?:us|eu)\.i\.posthog\.com|plausible\.io\/js)/,
    "retired analytics endpoint",
  ],
]

const envFileNamePattern = /^\.env(?:\.|$)/

export function checkTelemetryPolicy(repoRoot: string): string[] {
  const errors = checkPackageManifests(repoRoot)
  if (existsSync(join(repoRoot, "apps/posthog-proxy/package.json"))) {
    errors.push("Retired PostHog proxy workspace must not be restored.")
  }
  for (const root of ["apps", "packages"]) {
    for (const path of walkFiles(join(repoRoot, root), (file) =>
      /\.(?:ts|tsx|js|jsx|html|jsonc)$/.test(file)
    )) {
      const source = readFileSync(path, "utf8")
      for (const [pattern, reason] of [
        ...retiredSourcePatterns,
        ...forbiddenCookieSourcePatterns,
      ]) {
        if (pattern.test(source))
          errors.push(`${relative(repoRoot, path)}: ${reason}`)
      }
    }
  }
  for (const path of walkFiles(repoRoot, (file) =>
    envFileNamePattern.test(basename(file))
  )) {
    const source = readFileSync(path, "utf8")
    for (const [pattern, reason] of retiredSourcePatterns) {
      if (pattern.test(source))
        errors.push(`${relative(repoRoot, path)}: ${reason}`)
    }
  }
  return errors
}

if (import.meta.main) {
  const errors = checkTelemetryPolicy(process.cwd())
  if (errors.length) {
    console.error(errors.join("\n"))
    process.exit(1)
  }
  console.log("Telemetry retirement and cookieless policy OK.")
}
