import { spawnSync } from "node:child_process"

import { smokeAreaTags, type SmokeArea } from "../../e2e/helpers/smoke-areas"

type PlaywrightJsonSpec = {
  file?: string
  line?: number
  tags?: string[]
  title?: string
}

type PlaywrightJsonSuite = {
  specs?: PlaywrightJsonSpec[]
  suites?: PlaywrightJsonSuite[]
}

export type PlaywrightJsonReport = {
  suites?: PlaywrightJsonSuite[]
}

export type PlaywrightSmokeManifest = {
  schemaVersion: 1
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
    ? `${spec.file}${spec.line ? `:${spec.line}` : ""}`
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
  return normalized.startsWith("e2e/") ? normalized : `e2e/${normalized}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function buildPlaywrightSmokeManifest(
  report: PlaywrightJsonReport,
  selectedAreas: readonly SmokeArea[] = smokeAreas
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

function discoverPlaywrightTests(): PlaywrightJsonReport {
  const result = spawnSync(
    "bunx",
    ["playwright", "test", "--list", "--reporter=json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PLAYWRIGHT_SMOKE_AREA: "all",
      },
    }
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "Playwright test discovery failed."
    )
  }

  try {
    return JSON.parse(result.stdout) as PlaywrightJsonReport
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Playwright returned invalid JSON: ${message}`, {
      cause: error,
    })
  }
}

if (import.meta.main) {
  const selectedAreas = readSelectedAreas()
  const report = discoverPlaywrightTests()
  const counts = validatePlaywrightSmokeAreas(report, selectedAreas)
  const manifest = buildPlaywrightSmokeManifest(report, selectedAreas)
  process.stdout.write(
    `Playwright smoke manifest:\n${JSON.stringify(manifest, null, 2)}\n`
  )
  process.stdout.write(
    `Validated Playwright smoke areas: market=${counts.market}, merchant=${counts.merchant}\n`
  )
}
