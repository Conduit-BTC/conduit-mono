import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

import { smokeAreaTags, type SmokeArea } from "../../e2e/helpers/smoke-areas"

type PlaywrightJsonSpec = {
  file?: string
  line?: number
  ok?: boolean
  tags?: string[]
  tests?: Array<{
    expectedStatus?: string
    results?: PlaywrightJsonResult[]
    status?: string
  }>
  title?: string
}

type PlaywrightJsonResult = {
  duration?: number
  error?: PlaywrightJsonError
  errors?: PlaywrightJsonError[]
  retry?: number
  status?: string
}

type PlaywrightJsonError = {
  location?: {
    column?: number
    file?: string
    line?: number
  }
}

type PlaywrightJsonSuite = {
  specs?: PlaywrightJsonSpec[]
  suites?: PlaywrightJsonSuite[]
}

export type PlaywrightJsonReport = {
  config?: {
    metadata?: Record<string, unknown>
  }
  errors?: unknown[]
  stats?: {
    flaky?: number
    skipped?: number
    unexpected?: number
  }
  suites?: PlaywrightJsonSuite[]
}

export type PlaywrightSmokeEvidenceContext = {
  baseSha: string
  sourceHeadSha: string
  testedSha: string
}

export type PlaywrightSmokeManifest = {
  schemaVersion: 1
  evidence: PlaywrightSmokeEvidenceContext | null
  selectedTags: string[]
  selectedTestCount: number
  tests: Array<{
    file: string
    line: number | null
    name: string
    tags: string[]
  }>
}

const smokeAreas = Object.keys(smokeAreaTags) as SmokeArea[]

function collectSpecs(
  suites: readonly PlaywrightJsonSuite[]
): PlaywrightJsonSpec[] {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []),
    ...collectSpecs(suite.suites ?? []),
  ])
}

function formatSpec(spec: PlaywrightJsonSpec): string {
  const location = spec.file
    ? `${manifestFile(spec.file)}${spec.line ? `:${spec.line}` : ""}`
    : "unknown location"
  return `${location} (${spec.title ?? "untitled test"})`
}

function assignedAreasForSpec(spec: PlaywrightJsonSpec): SmokeArea[] {
  const tags = new Set(
    (spec.tags ?? []).map((tag) => (tag.startsWith("@") ? tag : `@${tag}`))
  )
  return smokeAreas.filter((area) => tags.has(smokeAreaTags[area]))
}

function manifestFile(file?: string): string {
  if (!file) return "unknown"
  const normalized = file.replaceAll("\\", "/")
  const e2eIndex = normalized.lastIndexOf("/e2e/")
  if (e2eIndex >= 0) return normalized.slice(e2eIndex + 1)
  if (normalized.startsWith("e2e/")) return normalized
  return normalized.includes("/") ? "unknown" : `e2e/${normalized}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function firstAttemptDiagnostic(result?: PlaywrightJsonResult): string {
  const reportedStatus = result?.status
  const status =
    reportedStatus === "failed" ||
    reportedStatus === "interrupted" ||
    reportedStatus === "passed" ||
    reportedStatus === "skipped" ||
    reportedStatus === "timedOut"
      ? reportedStatus
      : "unknown"
  const reportedRetry = result?.retry
  const retry =
    typeof reportedRetry === "number" &&
    Number.isInteger(reportedRetry) &&
    reportedRetry >= 0
      ? reportedRetry
      : 0
  const reportedDuration = result?.duration
  const duration =
    typeof reportedDuration === "number" &&
    Number.isFinite(reportedDuration) &&
    reportedDuration >= 0
      ? `${Math.round(reportedDuration)}ms`
      : "unknown"
  const location = result?.error?.location ?? result?.errors?.[0]?.location
  const file = manifestFile(location?.file)
  const errorLocation =
    file !== "unknown"
      ? `${file}${location?.line ? `:${location.line}` : ""}${location?.column ? `:${location.column}` : ""}`
      : "unavailable"

  return `First attempt: retry=${retry} status=${status} duration=${duration} error=${errorLocation}.`
}

export function buildPlaywrightSmokeManifest(
  report: PlaywrightJsonReport,
  selectedAreas: readonly SmokeArea[] = smokeAreas,
  evidence: PlaywrightSmokeEvidenceContext | null = null
): PlaywrightSmokeManifest {
  const selectedAreaSet = new Set(selectedAreas)
  const canonicalSelectedAreas = smokeAreas.filter((area) =>
    selectedAreaSet.has(area)
  )
  const tests: PlaywrightSmokeManifest["tests"] = []

  for (const spec of collectSpecs(report.suites ?? [])) {
    const areas = assignedAreasForSpec(spec).filter((area) =>
      selectedAreaSet.has(area)
    )
    if (areas.length === 0) continue

    // Keep the manifest content-free and stable across runner workspaces.
    tests.push({
      file: manifestFile(spec.file),
      line: spec.line ?? null,
      name: spec.title ?? "untitled test",
      tags: areas.map((area) => smokeAreaTags[area]),
    })
  }

  tests.sort(
    (left, right) =>
      compareText(left.file, right.file) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      compareText(left.name, right.name) ||
      compareText(left.tags.join(","), right.tags.join(","))
  )

  return {
    schemaVersion: 1,
    evidence,
    selectedTags: canonicalSelectedAreas.map((area) => smokeAreaTags[area]),
    selectedTestCount: tests.length,
    tests,
  }
}

export function validatePlaywrightSmokeAreas(
  report: PlaywrightJsonReport,
  selectedAreas: readonly SmokeArea[] = smokeAreas
): Record<SmokeArea, number> {
  const specs = collectSpecs(report.suites ?? [])
  const counts: Record<SmokeArea, number> = { market: 0, merchant: 0 }
  const orphaned: PlaywrightJsonSpec[] = []

  for (const spec of specs) {
    const assignedAreas = assignedAreasForSpec(spec)

    if (assignedAreas.length === 0) {
      orphaned.push(spec)
      continue
    }

    for (const area of assignedAreas) counts[area] += 1
  }

  const errors: string[] = []
  if (specs.length === 0) errors.push("Playwright discovered zero smoke tests.")
  if (orphaned.length > 0) {
    errors.push(
      `Playwright discovered smoke tests without @market or @merchant tags:\n${orphaned
        .map((spec) => `- ${formatSpec(spec)}`)
        .join("\n")}`
    )
  }

  for (const area of selectedAreas) {
    if (counts[area] === 0) {
      errors.push(`The selected ${area} smoke area contains zero tests.`)
    }
  }

  if (errors.length > 0) throw new Error(errors.join("\n"))
  return counts
}

export function validatePlaywrightSmokeExecution(
  report: PlaywrightJsonReport,
  expectedManifest: PlaywrightSmokeManifest,
  selectedAreas: readonly SmokeArea[],
  evidence: PlaywrightSmokeEvidenceContext
): PlaywrightSmokeManifest {
  validatePlaywrightSmokeAreas(report, selectedAreas)
  const executedManifest = buildPlaywrightSmokeManifest(
    report,
    selectedAreas,
    evidence
  )
  const errors: string[] = []

  if (JSON.stringify(executedManifest) !== JSON.stringify(expectedManifest)) {
    errors.push(
      "The executed Playwright smoke set does not match the discovered manifest."
    )
  }

  const reportEvidence = report.config?.metadata?.smokeEvidence
  if (JSON.stringify(reportEvidence) !== JSON.stringify(evidence)) {
    errors.push(
      "The Playwright execution report does not bind the expected source, base, and tested SHAs."
    )
  }

  for (const spec of collectSpecs(report.suites ?? [])) {
    const selected = assignedAreasForSpec(spec).some((area) =>
      selectedAreas.includes(area)
    )
    if (!selected) continue

    const tests = spec.tests ?? []
    if (tests.length === 0) {
      errors.push(
        `Playwright did not execute ${formatSpec(spec)} successfully.`
      )
      continue
    }
    if (spec.ok !== true) {
      errors.push(
        `Playwright did not execute ${formatSpec(spec)} successfully.`
      )
    }

    for (const test of tests) {
      const resultStatuses = (test.results ?? []).map(
        (result) => result.status ?? "unknown"
      )
      if (
        test.expectedStatus !== "passed" ||
        test.status !== "expected" ||
        resultStatuses.length !== 1 ||
        resultStatuses[0] !== "passed"
      ) {
        errors.push(
          `Playwright smoke did not pass cleanly on its first attempt: ${formatSpec(spec)}.\n${firstAttemptDiagnostic(test.results?.[0])}`
        )
      }
    }
  }

  if ((report.errors ?? []).length > 0) {
    errors.push("Playwright reported top-level execution errors.")
  }
  if ((report.stats?.skipped ?? 0) > 0) {
    errors.push("Playwright skipped selected smoke tests.")
  }
  if ((report.stats?.flaky ?? 0) > 0) {
    errors.push("Playwright reported retry-dependent smoke tests as flaky.")
  }
  if ((report.stats?.unexpected ?? 0) > 0) {
    errors.push("Playwright reported unexpected smoke results.")
  }

  if (errors.length > 0) throw new Error(errors.join("\n"))
  return executedManifest
}

function readSelectedAreas(): SmokeArea[] {
  const areaIndex = process.argv.indexOf("--area")
  const requestedArea =
    areaIndex >= 0 ? (process.argv[areaIndex + 1] ?? "") : "all"

  if (requestedArea === "all") return smokeAreas
  if (requestedArea === "market" || requestedArea === "merchant") {
    return [requestedArea]
  }
  throw new Error(
    `Unknown Playwright smoke area '${requestedArea}'. Expected all, market, or merchant.`
  )
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function readEvidenceContext(
  required: boolean
): PlaywrightSmokeEvidenceContext | null {
  const evidence = {
    baseSha: readArgument("--base-sha") ?? "",
    sourceHeadSha: readArgument("--source-head-sha") ?? "",
    testedSha: readArgument("--tested-sha") ?? "",
  }
  const values = Object.values(evidence)

  if (values.every((value) => value === "")) {
    if (required) {
      throw new Error(
        "Execution validation requires source-head, base, and tested SHAs."
      )
    }
    return null
  }
  if (!values.every((value) => /^[0-9a-f]{40}$/.test(value))) {
    throw new Error(
      "Smoke evidence SHAs must all be lowercase 40-character Git object IDs."
    )
  }

  return evidence
}

function readJsonFile<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    throw new Error(`Cannot read ${label}.`)
  }
}

function discoverPlaywrightTests(): PlaywrightJsonReport {
  const result = spawnSync(
    "bunx",
    ["playwright", "test", "--list", "--reporter=json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PLAYWRIGHT_SMOKE_DISCOVERY: "true",
        PLAYWRIGHT_SMOKE_AREA: "all",
      },
    }
  )

  if (result.error || result.status !== 0) {
    throw new Error("Playwright test discovery failed.")
  }

  try {
    return JSON.parse(result.stdout) as PlaywrightJsonReport
  } catch {
    throw new Error("Playwright test discovery returned invalid JSON.")
  }
}

if (import.meta.main) {
  const selectedAreas = readSelectedAreas()
  const executionReportPath = readArgument("--execution-report")
  const expectedManifestPath = readArgument("--expected-manifest")
  const manifestOutputPath = readArgument("--manifest-output")
  const evidence = readEvidenceContext(Boolean(executionReportPath))

  if (executionReportPath || expectedManifestPath) {
    if (!executionReportPath || !expectedManifestPath) {
      throw new Error(
        "Execution validation requires --execution-report and --expected-manifest."
      )
    }

    const executionReport = readJsonFile<PlaywrightJsonReport>(
      executionReportPath,
      "Playwright execution report"
    )
    const expectedManifest = readJsonFile<PlaywrightSmokeManifest>(
      expectedManifestPath,
      "Playwright smoke manifest"
    )
    const manifest = validatePlaywrightSmokeExecution(
      executionReport,
      expectedManifest,
      selectedAreas,
      evidence!
    )
    process.stdout.write(
      `Verified executed Playwright smoke manifest: selected=${manifest.selectedTestCount}\n`
    )
    process.exit(0)
  }

  const report = discoverPlaywrightTests()
  const counts = validatePlaywrightSmokeAreas(report, selectedAreas)
  const manifest = buildPlaywrightSmokeManifest(report, selectedAreas, evidence)
  if (manifestOutputPath) {
    writeFileSync(
      manifestOutputPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        mode: 0o600,
      }
    )
  }
  process.stdout.write(
    `Playwright smoke manifest:\n${JSON.stringify(manifest, null, 2)}\n`
  )
  process.stdout.write(
    `Validated Playwright smoke areas: market=${counts.market}, merchant=${counts.merchant}\n`
  )
}
